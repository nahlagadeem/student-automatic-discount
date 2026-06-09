import prisma from "../db.server";
import { errorMessage, normalizeShopDomain, resolveAdminClient } from "../student-discount.server";

const DISCOUNT_TITLE = "Discounted price";

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function parseGraphqlPayload(payloadText) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

async function runAdminGraphql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const payloadText = await response.text();
  const payload = parseGraphqlPayload(payloadText);

  if (!response.ok) {
    throw new Error(`Admin API HTTP ${response.status}: ${payloadText}`);
  }

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload?.data ?? null;
}

async function fetchAutomaticDiscountNodeIds(admin) {
  const ids = [];
  let after = null;
  let safety = 0;

  while (safety < 20) {
    safety += 1;
    const data = await runAdminGraphql(
      admin,
      `#graphql
        query FindAutomaticDiscountNodes($query: String!, $after: String) {
          discountNodes(first: 100, after: $after, query: $query) {
            nodes {
              id
              discount {
                __typename
                ... on DiscountAutomaticApp {
                  title
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      `,
      {
        query: "method:automatic",
        after,
      },
    );

    const connection = data?.discountNodes;
    for (const node of connection?.nodes ?? []) {
      if (String(node?.discount?.__typename || "").trim() !== "DiscountAutomaticApp") continue;
      if (String(node?.discount?.title || "").trim() !== DISCOUNT_TITLE) continue;
      const id = String(node?.id || "").trim();
      if (id) ids.push(id);
    }

    if (!connection?.pageInfo?.hasNextPage) break;
    after = String(connection?.pageInfo?.endCursor || "").trim();
    if (!after) break;
  }

  return Array.from(new Set(ids));
}

async function deleteAutomaticDiscount(admin, discountNodeId) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation DeleteAutomaticDiscount($id: ID!) {
        discountAutomaticDelete(id: $id) {
          deletedAutomaticDiscountId
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: discountNodeId,
    },
  );

  const payload = data?.discountAutomaticDelete;
  const userErrors = payload?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error) => String(error?.message || "").trim()).filter(Boolean).join("; "));
  }

  return payload;
}

export async function action({ request }) {
  const url = new URL(request.url);
  const requestedShop = normalizeShopDomain(url.searchParams.get("shop"));
  const confirm = String(url.searchParams.get("confirm") || "").trim().toLowerCase();

  if (confirm !== "purge") {
    return json(
      {
        ok: false,
        error: "Missing confirm=purge.",
      },
      { status: 400 },
    );
  }

  const shopsFromRules = await prisma.automaticDiscountRule.findMany({
    select: { shop: true },
  });

  const shopsFromConfig = await prisma.automaticDiscountConfig.findMany({
    select: { shop: true },
  });

  const shopsFromSessions = await prisma.session.findMany({
    select: { shop: true },
    where: { shop: { not: "" } },
  });

  const shops = Array.from(
    new Set(
      [requestedShop, ...shopsFromRules.map((row) => normalizeShopDomain(row.shop)), ...shopsFromConfig.map((row) => normalizeShopDomain(row.shop)), ...shopsFromSessions.map((row) => normalizeShopDomain(row.shop))]
        .filter(Boolean),
    ),
  );

  if (!shops.length) {
    return json({ ok: true, summary: [], note: "No shops found." });
  }

  const summary = [];

  for (const shop of shops) {
    let admin;
    try {
      ({ admin } = await resolveAdminClient(shop));
    } catch (error) {
      summary.push({ shop, ok: false, detail: errorMessage(error) });
      continue;
    }

    const nodeIds = await fetchAutomaticDiscountNodeIds(admin);
    const deleted = [];

    for (const nodeId of nodeIds) {
      try {
        await deleteAutomaticDiscount(admin, nodeId);
        deleted.push(nodeId);
      } catch (error) {
        const message = errorMessage(error);
        if (!/not found|invalid id|does not exist/i.test(message)) {
          throw error;
        }
      }
    }

    await prisma.automaticDiscountRule.deleteMany({ where: { shop } });
    await prisma.automaticDiscountConfig.deleteMany({ where: { shop } });

    summary.push({
      shop,
      ok: true,
      found: nodeIds.length,
      deleted: deleted.length,
      localRulesCleared: true,
      localConfigCleared: true,
    });
  }

  return json({ ok: true, summary });
}

export async function loader() {
  return json(
    {
      ok: false,
      error: "Use POST with confirm=purge.",
    },
    { status: 405 },
  );
}
