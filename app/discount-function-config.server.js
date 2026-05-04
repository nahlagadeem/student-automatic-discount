import prisma from "./db.server";

const DISCOUNT_TITLE = "Combined Student Discount";
const DISCOUNT_FUNCTION_TITLE = "Combined Student Discount";
const CONFIG_NAMESPACE = "$app:category-tier-discount-native";
const CONFIG_KEY = "function-configuration";

export async function ensureAutomaticDiscountConfigTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AutomaticDiscountConfig" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "discountNodeId" TEXT,
      "functionId" TEXT,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticDiscountConfig_shop_key"
    ON "AutomaticDiscountConfig"("shop")
  `);
}

export function buildFunctionConfiguration(rules) {
  return {
    version: 2,
    rules: rules
      .filter((rule) => rule.isActive !== false && Number(rule.percentage) > 0)
      .map((rule) => ({
        instituteKey: rule.instituteKey,
        instituteLabel: rule.instituteLabel,
        emailDomain: String(rule.emailDomain || "").trim().toLowerCase(),
        categoryKey: rule.categoryKey,
        categoryLabel: rule.categoryLabel,
        percentage: Number(rule.percentage),
      })),
  };
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

async function getDiscountFunctionId(admin) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query GetAppDiscountTypes {
        appDiscountTypes(first: 50) {
          nodes {
            title
            functionId
            discountClasses
          }
        }
      }
    `,
  );

  const nodes = data?.appDiscountTypes?.nodes ?? [];
  const match = nodes.find(
    (node) =>
      node?.title === DISCOUNT_FUNCTION_TITLE &&
      Array.isArray(node.discountClasses) &&
      node.discountClasses.includes("PRODUCT"),
  );

  if (!match?.functionId) {
    throw new Error(`Unable to locate Shopify discount function "${DISCOUNT_FUNCTION_TITLE}".`);
  }

  return match.functionId;
}

async function createAutomaticDiscount(admin, functionId, configValue) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation CreateAutomaticDiscount($automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppCreate(automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
            discountId
            title
            appDiscountType {
              functionId
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      automaticAppDiscount: {
        title: DISCOUNT_TITLE,
        functionId,
        discountClasses: ["PRODUCT"],
        startsAt: new Date().toISOString(),
        metafields: [
          {
            namespace: CONFIG_NAMESPACE,
            key: CONFIG_KEY,
            type: "json",
            value: configValue,
          },
        ],
      },
    },
  );

  const payload = data?.discountAutomaticAppCreate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join("; "));
  }

  const discountNodeId = payload?.automaticAppDiscount?.discountId;
  if (!discountNodeId) {
    throw new Error("Shopify did not return a discount id for the automatic discount.");
  }

  return discountNodeId;
}

async function updateAutomaticDiscount(admin, discountNodeId, configValue) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation UpdateAutomaticDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
          automaticAppDiscount {
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
      id: discountNodeId,
      automaticAppDiscount: {
        title: DISCOUNT_TITLE,
        metafields: [
          {
            namespace: CONFIG_NAMESPACE,
            key: CONFIG_KEY,
            type: "json",
            value: configValue,
          },
        ],
      },
    },
  );

  const payload = data?.discountAutomaticAppUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join("; "));
  }

  return payload?.automaticAppDiscount?.discountId ?? discountNodeId;
}

export async function syncAutomaticDiscountRules({ admin, shop, rules }) {
  await ensureAutomaticDiscountConfigTable();

  const config = buildFunctionConfiguration(rules);
  const configValue = JSON.stringify(config);
  const existingConfig = await prisma.automaticDiscountConfig.findUnique({
    where: { shop },
  });

  const functionId = existingConfig?.functionId || (await getDiscountFunctionId(admin));
  let discountNodeId = existingConfig?.discountNodeId || "";

  try {
    discountNodeId = discountNodeId
      ? await updateAutomaticDiscount(admin, discountNodeId, configValue)
      : await createAutomaticDiscount(admin, functionId, configValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!discountNodeId || !/not found|invalid id/i.test(message)) {
      throw error;
    }

    discountNodeId = await createAutomaticDiscount(admin, functionId, configValue);
  }

  await prisma.automaticDiscountConfig.upsert({
    where: { shop },
    update: { discountNodeId, functionId },
    create: { shop, discountNodeId, functionId },
  });

  return {
    discountNodeId,
    functionId,
    ruleCount: config.rules.length,
  };
}
