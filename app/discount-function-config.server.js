import prisma from "./db.server";
import { getInstituteByLabel } from "./institutes";

const DISCOUNT_TITLE = "Combined Institute Discount";
const DISCOUNT_FUNCTION_TITLE = "Combined Institute Discount";
const CONFIG_NAMESPACE = "$app:category-tier-discount-native";
const CONFIG_KEY = "function-configuration";
const DISCOUNT_API_TYPE = "discount";
const CUSTOMER_IDENTITY_NAMESPACE = "$app:student-discount";
const CUSTOMER_INSTITUTE_KEY = "institute_key";

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
  const activeRules = rules
    .filter((rule) => rule.isActive !== false && Number(rule.percentage) > 0)
    .map((rule) => ({
      instituteKey: rule.instituteKey,
      instituteLabel: rule.instituteLabel,
      emailDomain: String(rule.emailDomain || "").trim().toLowerCase(),
      categoryKey: rule.categoryKey,
      categoryLabel: rule.categoryLabel,
      percentage: Number(rule.percentage),
    }));

  const highestPercentageFor = (categoryKey) =>
    activeRules
      .filter((rule) => rule.categoryKey === categoryKey)
      .reduce((max, rule) => Math.max(max, rule.percentage), 0);

  return {
    version: 2,
    rules: activeRules,
    ipadPercentage: highestPercentageFor("ipad"),
    macPercentage: highestPercentageFor("mac"),
    accessoriesPercentage: highestPercentageFor("accessories"),
    iphonePercentage: highestPercentageFor("iphone"),
    appleWatchPercentage: highestPercentageFor("apple-watch"),
    tvHomePercentage: highestPercentageFor("tv-home"),
    airpodsPercentage: highestPercentageFor("airpods"),
  };
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

  const userErrors = [
    ...(payload?.data?.discountAutomaticAppCreate?.userErrors ?? []),
    ...(payload?.data?.discountAutomaticAppUpdate?.userErrors ?? []),
    ...(payload?.data?.metafieldsSet?.userErrors ?? []),
  ];

  for (const error of userErrors) {
    const message = String(error?.message || "").trim();
    if (message) messages.push(message);
  }

  if (messages.length) {
    return messages.slice(0, 5).join("; ");
  }

  const compact = String(payloadText || "").replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

async function runAdminGraphql(admin, query, variables) {
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

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
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
    (node) =>
      normalizeFunctionTitle(node?.title) === normalizeFunctionTitle(DISCOUNT_FUNCTION_TITLE) &&
      String(node?.apiType || "").trim().toLowerCase() === DISCOUNT_API_TYPE,
  );

  if (exactMatch?.id) {
    return exactMatch.id;
  }

  if (discountNodes.length === 1 && discountNodes[0]?.id) {
    return discountNodes[0].id;
  }

  const fuzzyMatch = discountNodes.find((node) =>
    /student|institute/.test(normalizeFunctionTitle(node?.title)),
  );
  if (fuzzyMatch?.id) {
    return fuzzyMatch.id;
  }

  const availableTitles = discountNodes
    .map((node) => String(node?.title || "").trim())
    .filter(Boolean)
    .join(", ");
  throw new Error(
    `Unable to locate Shopify discount function "${DISCOUNT_FUNCTION_TITLE}". Available discount functions: ${availableTitles || "none"}.`,
  );
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

async function findCustomerIdsByEmail(admin, email) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return [];

  const data = await runAdminGraphql(
    admin,
    `#graphql
      query FindCustomerIdsByEmail($query: String!) {
        customers(first: 10, query: $query) {
          nodes {
            id
          }
        }
      }
    `,
    {
      query: `email:${normalizedEmail}`,
    },
  );

  return (data?.customers?.nodes ?? [])
    .map((customer) => String(customer?.id || "").trim())
    .filter(Boolean);
}

async function setCustomerInstituteMetafield(admin, customerId, instituteKey) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation SetCustomerInstituteMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            key
            namespace
            value
          }
          userErrors {
            message
          }
        }
      }
    `,
    {
      metafields: [
        {
          ownerId: customerId,
          namespace: CUSTOMER_IDENTITY_NAMESPACE,
          key: CUSTOMER_INSTITUTE_KEY,
          type: "single_line_text_field",
          value: String(instituteKey || "").trim(),
        },
      ],
    },
  );

  const userErrors = data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error) => error.message).join("; "));
  }
}

export async function syncPortalUsersToCustomerTags({ admin, rules }) {
  const activeInstituteLabels = Array.from(
    new Set(
      rules
        .filter((rule) => rule.isActive !== false && Number(rule.percentage) > 0)
        .map((rule) => String(rule.instituteLabel || "").trim())
        .filter(Boolean),
    ),
  );

  if (!activeInstituteLabels.length) {
    return { syncedCustomerCount: 0, syncedUserCount: 0 };
  }

  const portalUsers = await prisma.portalUser.findMany({
    where: {
      institute: { in: activeInstituteLabels },
    },
    select: {
      id: true,
      email: true,
      schoolEmail: true,
      institute: true,
    },
  });

  const customerAssignments = new Map();

  for (const user of portalUsers) {
    const institute = getInstituteByLabel(user.institute);
    if (!institute?.key) continue;

    const emails = Array.from(
      new Set([normalizeEmail(user.email), normalizeEmail(user.schoolEmail)].filter(Boolean)),
    );

    for (const email of emails) {
      const customerIds = await findCustomerIdsByEmail(admin, email);
      for (const customerId of customerIds) {
        customerAssignments.set(customerId, institute.key);
      }
    }
  }

  for (const [customerId, instituteKey] of customerAssignments.entries()) {
    await setCustomerInstituteMetafield(admin, customerId, instituteKey);
  }

  return {
    syncedCustomerCount: customerAssignments.size,
    syncedUserCount: portalUsers.length,
  };
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
    if (!discountNodeId || !/not found|invalid id|does not exist/i.test(message)) {
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

export function syncErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/function not found/i.test(message)) {
    return "Shopify discount function is not registered on the shop yet. Deploy the Shopify app again, then retry.";
  }
  if (/unable to locate shopify discount function/i.test(message)) {
    return "Shopify discount function was not found for this app on the shop yet. Deploy the Shopify app again, then retry.";
  }
  return message;
}
