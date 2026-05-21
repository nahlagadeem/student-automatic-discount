import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv() {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(thisDir, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const { default: prisma } = await import("../app/db.server.js");
const { resolveAdminClient, normalizeShopDomain, errorMessage } = await import("../app/student-discount.server.js");

const DISCOUNT_TITLE = "Discounted price";

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
        query: `method:automatic title:"${DISCOUNT_TITLE}"`,
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

const shopsFromRules = await prisma.automaticDiscountRule.findMany({
  distinct: ["shop"],
  select: { shop: true },
});

const shopsFromConfig = await prisma.automaticDiscountConfig.findMany({
  distinct: ["shop"],
  select: { shop: true },
});

const shopsFromSessions = await prisma.session.findMany({
  distinct: ["shop"],
  select: { shop: true },
  where: { shop: { not: "" } },
});

const shops = Array.from(
  new Set([
    normalizeShopDomain(process.env.LIVE_SHOP_DOMAIN),
    ...shopsFromRules.map((row) => normalizeShopDomain(row.shop)),
    ...shopsFromConfig.map((row) => normalizeShopDomain(row.shop)),
    ...shopsFromSessions.map((row) => normalizeShopDomain(row.shop)),
  ].filter(Boolean)),
);

if (!shops.length) {
  console.log("No shops found to purge.");
  process.exit(0);
}

const summary = [];

for (const shop of shops) {
  console.log(`Purging automatic discounts for ${shop}...`);
  let admin;

  try {
    ({ admin } = await resolveAdminClient(shop));
  } catch (error) {
    summary.push({ shop, ok: false, detail: errorMessage(error) });
    console.warn(`Skipping ${shop}: ${errorMessage(error)}`);
    continue;
  }

  const nodeIds = await fetchAutomaticDiscountNodeIds(admin);
  const deleted = [];
  for (const nodeId of nodeIds) {
    try {
      await deleteAutomaticDiscount(admin, nodeId);
      deleted.push(nodeId);
      console.log(`Deleted Shopify automatic discount ${nodeId}`);
    } catch (error) {
      const message = errorMessage(error);
      if (/not found|invalid id|does not exist/i.test(message)) {
        console.warn(`Shopify automatic discount already missing for ${nodeId}`);
        continue;
      }
      throw error;
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

console.log(JSON.stringify({ ok: true, summary }, null, 2));
