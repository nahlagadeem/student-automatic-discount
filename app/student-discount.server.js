import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

export function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function normalizeShopDomain(input) {
  if (!input) return "";
  const trimmed = String(input).trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const withProtocol = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).hostname.trim().toLowerCase();
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0].trim().toLowerCase();
  }
}

function parseGraphqlPayload(payloadText) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

function summarizeGraphqlPayload(payloadText) {
  const payload = parseGraphqlPayload(payloadText);
  const messages = [];

  if (Array.isArray(payload?.errors)) {
    for (const error of payload.errors) {
      const message = String(error?.message || "").trim();
      if (message) messages.push(message);
    }
  }

  if (messages.length) {
    return messages.slice(0, 5).join("; ");
  }

  const compact = String(payloadText || "").replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

export async function runAdminGraphql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const payloadText = await response.text();
  const payload = parseGraphqlPayload(payloadText);

  if (!response.ok) {
    throw new Error(`Admin API HTTP ${response.status}: ${summarizeGraphqlPayload(payloadText)}`);
  }

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload?.data ?? null;
}

export async function ensureStudentDiscountTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "StudentDiscount" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "customerId" TEXT NOT NULL,
      "code" TEXT NOT NULL,
      "discountNodeId" TEXT,
      "shopifyDiscountId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "StudentDiscount"
    ADD COLUMN IF NOT EXISTS "shopifyDiscountId" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "StudentDiscount_shop_customerId_key"
    ON "StudentDiscount"("shop", "customerId")
  `);
}

export async function resolveAdminClient(shop) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { admin, via: "offline_session" };
  } catch (error) {
    const offlineSession = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    const accessToken = String(offlineSession?.accessToken || "").trim();

    if (!accessToken) {
      throw new Error(
        `No offline session for ${shop}. Open the app in Shopify Admin and reinstall if needed. ${errorMessage(error)}`,
      );
    }

    return {
      via: "session_token",
      admin: {
        graphql: async (query, opts = {}) =>
          fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({ query, variables: opts.variables ?? {} }),
          }),
      },
    };
  }
}

export async function findStudentDiscount(shop, customerId) {
  if (!shop || !customerId) return null;
  return prisma.studentDiscount.findUnique({
    where: {
      shop_customerId: {
        shop,
        customerId,
      },
    },
  });
}

export async function upsertStudentDiscount({
  shop,
  customerId,
  code,
  discountNodeId,
}) {
  if (!shop || !customerId || !code) return null;

  return prisma.studentDiscount.upsert({
    where: {
      shop_customerId: {
        shop,
        customerId,
      },
    },
    update: {
      code,
      discountNodeId,
      shopifyDiscountId: discountNodeId,
    },
    create: {
      shop,
      customerId,
      code,
      discountNodeId,
      shopifyDiscountId: discountNodeId,
    },
  });
}

export async function deleteStudentDiscountRow({
  shop,
  customerId,
  code,
  discountNodeId,
  shopifyDiscountId,
}) {
  return prisma.studentDiscount.deleteMany({
    where: {
      ...(shop ? { shop } : {}),
      ...(customerId ? { customerId } : {}),
      ...(code ? { code } : {}),
      ...(discountNodeId ? { discountNodeId } : {}),
      ...(shopifyDiscountId ? { shopifyDiscountId } : {}),
    },
  });
}

export async function findDiscountNodeIdByCode(admin, code) {
  const normalizedCode = String(code || "").trim();
  if (!normalizedCode) return "";

  const data = await runAdminGraphql(
    admin,
    `#graphql
      query FindDiscountNodeByCode($query: String!) {
        discountNodes(first: 10, query: $query) {
          nodes {
            id
          }
        }
      }
    `,
    {
      query: `code:${normalizedCode}`,
    },
  );

  const nodeId = String(data?.discountNodes?.nodes?.[0]?.id || "").trim();
  return nodeId;
}

export async function createShopifyCodeDiscount(admin, code) {
  const result = await admin.graphql(
    `
      mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
        discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
          codeDiscountNode { id }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        basicCodeDiscount: {
          title: `Institute Discount ${code}`,
          code,
          startsAt: new Date().toISOString(),
          customerSelection: { all: true },
          customerGets: {
            value: { percentage: 0.5 },
            items: { all: true },
          },
          usageLimit: 1,
        },
      },
    },
  );

  const bodyText = await result.text();
  let body = null;
  try {
    const parsed = JSON.parse(bodyText);
    body = typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    body = null;
  }

  if (!result.ok) {
    const status = result.status >= 400 && result.status < 500 ? result.status : 502;
    const error = new Error(`Admin API HTTP error ${result.status}`);
    error.status = status;
    error.body = body ?? bodyText;
    throw error;
  }

  const userErrors = body?.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (userErrors.length) {
    const error = new Error(userErrors.map((entry) => String(entry?.message || "").trim()).filter(Boolean).join("; "));
    error.userErrors = userErrors;
    throw error;
  }

  const discountNodeId = String(body?.data?.discountCodeBasicCreate?.codeDiscountNode?.id || "").trim();
  if (!discountNodeId) {
    throw new Error("Shopify did not return a discount id for the code discount.");
  }

  return { code, discountNodeId, body };
}

export async function deleteShopifyDiscountCode(admin, discountNodeId) {
  if (!discountNodeId) return { deletedCodeDiscountId: "", userErrors: [] };

  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation DeleteCodeDiscount($id: ID!) {
        discountCodeDelete(id: $id) {
          deletedCodeDiscountId
          userErrors {
            field
            code
            message
          }
        }
      }
    `,
    {
      id: discountNodeId,
    },
  );

  const payload = data?.discountCodeDelete ?? {};
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    const error = new Error(userErrors.map((entry) => String(entry?.message || "").trim()).filter(Boolean).join("; "));
    error.userErrors = userErrors;
    throw error;
  }

  return payload;
}
