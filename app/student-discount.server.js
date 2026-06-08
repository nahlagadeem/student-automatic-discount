import prisma from "./db.server";
import { unauthenticated } from "./shopify.server";
import { buildCustomerGid } from "./portal-user-links.server";

const DISCOUNT_FUNCTION_TITLE = "Discounted price";
const DISCOUNT_API_TYPE = "discount";
const CONFIG_NAMESPACE = "$app:category-tier-discount-native";
const CONFIG_KEY = "function-configuration";

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

function normalizeFunctionTitle(value) {
  return String(value || "").trim().toLowerCase();
}

async function getDiscountFunctionId(admin) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query GetShopifyFunctions {
        shopifyFunctions(first: 50) {
          nodes {
            id
            title
            apiType
          }
        }
      }
    `,
  );

  const nodes = data?.shopifyFunctions?.nodes ?? [];
  const discountNodes = nodes.filter(
    (node) => String(node?.apiType || "").trim().toLowerCase() === DISCOUNT_API_TYPE,
  );

  const exactMatch = discountNodes.find(
    (node) => normalizeFunctionTitle(node?.title) === normalizeFunctionTitle(DISCOUNT_FUNCTION_TITLE),
  );
  if (exactMatch?.id) return exactMatch.id;

  if (discountNodes.length === 1 && discountNodes[0]?.id) {
    return discountNodes[0].id;
  }

  const fuzzyMatch = discountNodes.find((node) =>
    /student|institute|category|discounted price/.test(normalizeFunctionTitle(node?.title)),
  );
  if (fuzzyMatch?.id) return fuzzyMatch.id;

  const availableTitles = discountNodes
    .map((node) => String(node?.title || "").trim())
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `Unable to locate Shopify discount function "${DISCOUNT_FUNCTION_TITLE}". Available discount functions: ${availableTitles || "none"}.`,
  );
}

async function fetchAutomaticDiscountFunctionConfig(admin, functionId) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query FindAutomaticDiscountConfig($query: String!) {
        discountNodes(first: 100, query: $query) {
          nodes {
            discount {
              __typename
              ... on DiscountAutomaticApp {
                appDiscountType {
                  functionId
                }
                metafield(namespace: "$app:category-tier-discount-native", key: "function-configuration") {
                  value
                }
              }
            }
          }
        }
      }
    `,
    {
      query: "method:automatic",
    },
  );

  const normalizedFunctionId = String(functionId || "").trim();
  const node = (data?.discountNodes?.nodes ?? []).find((entry) => {
    const discount = entry?.discount;
    return (
      discount?.__typename === "DiscountAutomaticApp" &&
      String(discount?.appDiscountType?.functionId || "").trim() === normalizedFunctionId &&
      String(discount?.metafield?.value || "").trim()
    );
  });

  const rawValue = String(node?.discount?.metafield?.value || "").trim();
  if (!rawValue) return null;

  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
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

export async function isStudentCodeAppDiscount(admin, discountNodeId) {
  const normalizedDiscountNodeId = String(discountNodeId || "").trim();
  if (!normalizedDiscountNodeId) return false;

  const data = await runAdminGraphql(
    admin,
    `#graphql
      query CheckStudentCodeAppDiscount($id: ID!) {
        node(id: $id) {
          __typename
          ... on DiscountCodeNode {
            codeDiscount {
              __typename
              ... on DiscountCodeApp {
                metafield(namespace: "$app:category-tier-discount-native", key: "function-configuration") {
                  value
                }
              }
            }
          }
        }
      }
    `,
    {
      id: normalizedDiscountNodeId,
    },
  );

  const discount = data?.node?.codeDiscount;
  if (discount?.__typename !== "DiscountCodeApp") return false;

  try {
    const config = JSON.parse(String(discount?.metafield?.value || "{}"));
    return config?.mode === "student-code";
  } catch {
    return false;
  }
}

export async function createShopifyCodeDiscount(admin, code, customerIds = []) {
  const eligibleCustomerIds = Array.from(
    new Set(customerIds.map((value) => buildCustomerGid(value)).filter(Boolean)),
  );

  if (!eligibleCustomerIds.length) {
    throw new Error("No eligible customer IDs were provided for the discount.");
  }

  const functionId = await getDiscountFunctionId(admin);
  const automaticConfig = await fetchAutomaticDiscountFunctionConfig(admin, functionId);
  const functionConfig = {
    version: 3,
    mode: "student-code",
    codePercentage: 50,
    automaticConfig,
  };

  const result = await admin.graphql(
    `#graphql
      mutation discountCodeAppCreate($codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppCreate(codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount {
            discountId
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      variables: {
        codeAppDiscount: {
          title: `Institute Discount ${code}`,
          code,
          functionId,
          discountClasses: ["PRODUCT"],
          combinesWith: {
            orderDiscounts: false,
            productDiscounts: true,
            shippingDiscounts: false,
          },
          startsAt: new Date().toISOString(),
          context: {
            customers: {
              add: eligibleCustomerIds,
            },
          },
          appliesOncePerCustomer: true,
          usageLimit: 1,
          metafields: [
            {
              namespace: CONFIG_NAMESPACE,
              key: CONFIG_KEY,
              type: "json",
              value: JSON.stringify(functionConfig),
            },
          ],
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

  const userErrors = body?.data?.discountCodeAppCreate?.userErrors ?? [];
  if (userErrors.length) {
    const error = new Error(userErrors.map((entry) => String(entry?.message || "").trim()).filter(Boolean).join("; "));
    error.userErrors = userErrors;
    throw error;
  }

  const discountNodeId = String(body?.data?.discountCodeAppCreate?.codeAppDiscount?.discountId || "").trim();
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
