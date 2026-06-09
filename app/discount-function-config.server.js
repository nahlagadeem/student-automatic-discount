import prisma from "./db.server";
import { INSTITUTES, getInstituteByLabel } from "./institutes";
import { linkPortalUserToCustomer } from "./portal-user-links.server";
import { setCustomerPortalProfileMetafields } from "./customer-profile-metafields.server";

const DISCOUNT_TITLE = "Discounted price";
const DISCOUNT_FUNCTION_TITLE = "Discounted price";
const CONFIG_NAMESPACE = "$app:category-tier-discount-native";
const CONFIG_KEY = "function-configuration";
const DISCOUNT_API_TYPE = "discount";
const CUSTOMER_IDENTITY_NAMESPACE = "$app:student-discount";
const CUSTOMER_INSTITUTE_KEY = "institute_key";
const SHARED_CONFIG_NAMESPACE = "student-discount-shared";
const SHARED_AUTOMATIC_CONFIG_KEY = "automatic-configuration";
export const LIMITED_TIME_PRODUCT_OFFER = {
  key: "macbook-neo-256gb-limited-offer",
  productId: "gid://shopify/Product/9213557440730",
  productHandle: "iphone-17e",
  storageOptionValue: "256GB NO Touch ID",
  variantIds: [
    "gid://shopify/ProductVariant/47725809139930",
    "gid://shopify/ProductVariant/47725818282202",
    "gid://shopify/ProductVariant/47725818314970",
    "gid://shopify/ProductVariant/47725818347738",
  ],
  discountAmount: 409,
  targetPrice: 2390,
  label: "Limited time offer",
  startDateTime: "2026-06-09T00:00:00",
  endDateTime: "2026-08-10T00:00:00",
};

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

export function buildFunctionConfiguration(rules, options = {}) {
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
    eligibleInstituteKeys: INSTITUTES.map((institute) => institute.key),
    limitedTimeOffers: Array.isArray(options.limitedTimeOffers) ? options.limitedTimeOffers : [],
    ipadPercentage: highestPercentageFor("ipad"),
    macPercentage: highestPercentageFor("mac"),
    accessoriesPercentage: highestPercentageFor("accessories"),
    iphonePercentage: highestPercentageFor("iphone"),
    appleWatchPercentage: highestPercentageFor("apple-watch"),
    tvHomePercentage: highestPercentageFor("tv-home"),
    airpodsPercentage: highestPercentageFor("airpods"),
  };
}

async function buildLimitedTimeProductOffers(admin) {
  const offer = LIMITED_TIME_PRODUCT_OFFER;
  if (Array.isArray(offer.variantIds) && offer.variantIds.length) {
    return [
      {
        key: offer.key,
        productId: offer.productId,
        productHandle: offer.productHandle,
        variantIds: offer.variantIds,
        discountAmount: offer.discountAmount,
        targetPrice: offer.targetPrice,
        label: offer.label,
        startDateTime: offer.startDateTime,
        endDateTime: offer.endDateTime,
      },
    ];
  }

  const data = await runAdminGraphql(
    admin,
    `#graphql
      query GetLimitedTimeOfferProduct($id: ID!) {
        product(id: $id) {
          handle
          variants(first: 100) {
            nodes {
              id
              selectedOptions {
                name
                value
              }
            }
          }
        }
      }
    `,
    {
      id: offer.productId,
    },
  );

  const variantIds = (data?.product?.variants?.nodes ?? [])
    .filter((variant) =>
      (variant?.selectedOptions ?? []).some(
        (option) => String(option?.value || "").trim() === offer.storageOptionValue,
      ),
    )
    .map((variant) => String(variant?.id || "").trim())
    .filter(Boolean);

  if (!variantIds.length) {
    throw new Error(
      `No ${offer.storageOptionValue} variants were found for ${offer.productId}.`,
    );
  }

  return [
    {
      key: offer.key,
      productId: offer.productId,
      productHandle: String(data?.product?.handle || "").trim(),
      variantIds,
      discountAmount: offer.discountAmount,
      targetPrice: offer.targetPrice,
      label: offer.label,
      startDateTime: offer.startDateTime,
      endDateTime: offer.endDateTime,
    },
  ];
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
    ...(payload?.data?.discountCodeAppUpdate?.userErrors ?? []),
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

function automaticDiscountInput(functionId, configValue) {
  const sharedConfigValue = JSON.stringify({
    ...JSON.parse(configValue),
    functionId,
  });

  return {
    title: DISCOUNT_TITLE,
    functionId,
    discountClasses: ["PRODUCT"],
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: true,
      shippingDiscounts: false,
    },
    metafields: [
      {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        type: "json",
        value: configValue,
      },
      {
        namespace: SHARED_CONFIG_NAMESPACE,
        key: SHARED_AUTOMATIC_CONFIG_KEY,
        type: "json",
        value: sharedConfigValue,
      },
    ],
  };
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
        ...automaticDiscountInput(functionId, configValue),
        startsAt: new Date().toISOString(),
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

async function updateAutomaticDiscount(admin, discountNodeId, functionId, configValue) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation UpdateAutomaticDiscount($id: ID!, $automaticAppDiscount: DiscountAutomaticAppInput!) {
        discountAutomaticAppUpdate(id: $id, automaticAppDiscount: $automaticAppDiscount) {
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
      id: discountNodeId,
      automaticAppDiscount: automaticDiscountInput(functionId, configValue),
    },
  );

  const payload = data?.discountAutomaticAppUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join("; "));
  }

  const updatedDiscountNodeId = payload?.automaticAppDiscount?.discountId || discountNodeId;
  if (!updatedDiscountNodeId) {
    throw new Error("Shopify did not return a discount id for the automatic discount update.");
  }

  return updatedDiscountNodeId;
}

async function findCodeDiscountNodeIds(admin) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query FindCodeDiscountNodes($query: String!) {
        discountNodes(first: 100, query: $query) {
          nodes {
            id
            metafield(namespace: "$app:category-tier-discount-native", key: "function-configuration") {
              value
            }
            discount {
              __typename
              ... on DiscountCodeApp {
                title
                codes(first: 5) {
                  nodes {
                    code
                  }
                }
                appDiscountType {
                  functionId
                }
              }
            }
          }
        }
      }
    `,
    {
      query: "method:code",
    },
  );

  return (data?.discountNodes?.nodes ?? [])
    .filter((node) => String(node?.discount?.__typename || "").trim() === "DiscountCodeApp")
    .map((node) => ({
      id: String(node?.id || "").trim(),
      functionId: String(node?.discount?.appDiscountType?.functionId || "").trim(),
      title: String(node?.discount?.title || "").trim(),
      codes: (node?.discount?.codes?.nodes ?? [])
        .map((codeNode) => String(codeNode?.code || "").trim())
        .filter(Boolean),
      configValue: String(node?.metafield?.value || "").trim(),
    }))
    .filter((node) => node.id);
}

function buildCodeDiscountExclusionConfig(configValue, automaticConfig) {
  let parsedConfig = {};
  try {
    parsedConfig = JSON.parse(String(configValue || "{}"));
  } catch {
    parsedConfig = {};
  }

  if (parsedConfig?.mode === "student-code") {
    return {
      ...parsedConfig,
      version: 4,
      automaticConfig,
    };
  }

  if (parsedConfig?.mode === "code-with-automatic-exclusions") {
    return {
      ...parsedConfig,
      version: 4,
      automaticConfig,
    };
  }

  return {
    version: 4,
    mode: "code-with-automatic-exclusions",
    codeConfig: parsedConfig,
    automaticConfig,
  };
}

async function updateCodeDiscountCombination(admin, discountNode, automaticConfig) {
  const metafields = [
    {
      namespace: SHARED_CONFIG_NAMESPACE,
      key: SHARED_AUTOMATIC_CONFIG_KEY,
      type: "json",
      value: JSON.stringify(automaticConfig),
    },
  ];

  metafields.push({
    namespace: CONFIG_NAMESPACE,
    key: CONFIG_KEY,
    type: "json",
    value: JSON.stringify(buildCodeDiscountExclusionConfig(discountNode.configValue, automaticConfig)),
  });

  const data = await runAdminGraphql(
    admin,
    `#graphql
      mutation UpdateCodeDiscountCombination($id: ID!, $codeAppDiscount: DiscountCodeAppInput!) {
        discountCodeAppUpdate(id: $id, codeAppDiscount: $codeAppDiscount) {
          codeAppDiscount {
            discountId
            title
          }
          userErrors {
            field
            message
          }
        }
      }
    `,
    {
      id: discountNode.id,
      codeAppDiscount: {
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: true,
          shippingDiscounts: false,
        },
        metafields,
      },
    },
  );

  const payload = data?.discountCodeAppUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join("; "));
  }

  return {
    id: payload?.codeAppDiscount?.discountId || discountNode.id,
    title: discountNode.title,
    codes: discountNode.codes,
    functionId: discountNode.functionId,
  };
}

async function syncCodeDiscountCombinations(admin, functionId, automaticConfig) {
  const automaticConfigWithFunctionId = {
    ...automaticConfig,
    functionId,
  };
  const codeDiscountNodes = await findCodeDiscountNodeIds(admin);
  const ownedCodeDiscountNodes = codeDiscountNodes;
  const updatedCodeDiscounts = [];
  const skippedCodeDiscounts = [];

  for (const node of ownedCodeDiscountNodes) {
    try {
      updatedCodeDiscounts.push(await updateCodeDiscountCombination(admin, node, automaticConfigWithFunctionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|invalid id|does not exist/i.test(message)) {
        throw error;
      }
      skippedCodeDiscounts.push({
        id: node.id,
        title: node.title,
        codes: node.codes,
        error: message,
      });
    }
  }

  return {
    codeDiscountCount: codeDiscountNodes.length,
    skippedForeignCodeDiscountCount: codeDiscountNodes.length - ownedCodeDiscountNodes.length,
    skippedMissingCodeDiscountCount: skippedCodeDiscounts.length,
    updatedCodeDiscountNodeIds: updatedCodeDiscounts.map((discount) => discount.id),
    updatedCodeDiscounts,
    skippedCodeDiscounts,
  };
}

async function deleteAutomaticDiscount(admin, discountNodeId) {
  if (!discountNodeId) return;

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
    throw new Error(userErrors.map((error) => error.message).join("; "));
  }
}

async function findAutomaticDiscountNodeIds(admin, functionId) {
  const normalizedFunctionId = String(functionId || "").trim();
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query FindAutomaticDiscountNodes($query: String!) {
        discountNodes(first: 100, query: $query) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountAutomaticApp {
                title
                appDiscountType {
                  functionId
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

  return (data?.discountNodes?.nodes ?? [])
    .filter((node) => String(node?.discount?.__typename || "").trim() === "DiscountAutomaticApp")
    .filter((node) => {
      const nodeFunctionId = String(node?.discount?.appDiscountType?.functionId || "").trim();
      const nodeTitle = String(node?.discount?.title || "").trim();
      if (normalizedFunctionId && nodeFunctionId === normalizedFunctionId) return true;
      return normalizeFunctionTitle(nodeTitle) === normalizeFunctionTitle(DISCOUNT_TITLE);
    })
    .map((node) => String(node?.id || "").trim())
    .filter(Boolean);
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

export async function syncPortalUsersToCustomerTags({ admin, shop, rules }) {
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
        fullName: true,
        email: true,
        schoolEmail: true,
        institute: true,
        role: true,
        roleOther: true,
        phoneSa: true,
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
        customerAssignments.set(customerId, { instituteKey: institute.key, portalUser: user });
        await linkPortalUserToCustomer({
          shop,
          portalUserId: user.id,
          customerGid: customerId,
        });
      }
    }
  }

  for (const [customerId, assignment] of customerAssignments.entries()) {
    const { instituteKey, portalUser } = assignment;
    await setCustomerInstituteMetafield(admin, customerId, instituteKey);
    await setCustomerPortalProfileMetafields(admin, customerId, portalUser);
  }

  return {
    syncedCustomerCount: customerAssignments.size,
    syncedUserCount: portalUsers.length,
  };
}

export async function syncAutomaticDiscountRules({ admin, shop, rules }) {
  await ensureAutomaticDiscountConfigTable();

  const limitedTimeOffers = await buildLimitedTimeProductOffers(admin);
  const config = buildFunctionConfiguration(rules, { limitedTimeOffers });
  const configValue = JSON.stringify(config);
  const existingConfig = await prisma.automaticDiscountConfig.findUnique({
    where: { shop },
  });

  const functionId = await getDiscountFunctionId(admin);
  let discountNodeId = existingConfig?.discountNodeId || "";
  const fallbackDiscountNodeIds = await findAutomaticDiscountNodeIds(admin, functionId);
  const liveDiscountNodeIds = fallbackDiscountNodeIds
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const discountNodeIdsToDelete = new Set(
    [...liveDiscountNodeIds].map((value) => String(value || "").trim()).filter(Boolean),
  );

  if (!config.rules.length && !config.limitedTimeOffers.length) {
    for (const nodeId of discountNodeIdsToDelete) {
      try {
        await deleteAutomaticDiscount(admin, nodeId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|invalid id|does not exist/i.test(message)) {
          throw error;
        }
      }
    }

    await prisma.automaticDiscountConfig.deleteMany({
      where: { shop },
    });

    return {
      discountNodeId: "",
      functionId,
      ruleCount: 0,
    };
  }

  try {
    const existingDiscountNodeIds = Array.from(discountNodeIdsToDelete);
    const nodeIdToUpdate = existingDiscountNodeIds[0] || "";
    const extraNodeIdsToDelete = existingDiscountNodeIds.slice(1);

    for (const nodeId of extraNodeIdsToDelete) {
      try {
        await deleteAutomaticDiscount(admin, nodeId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/not found|invalid id|does not exist/i.test(message)) {
          throw error;
        }
      }
    }

    discountNodeId = nodeIdToUpdate
      ? await updateAutomaticDiscount(admin, nodeIdToUpdate, functionId, configValue)
      : await createAutomaticDiscount(admin, functionId, configValue);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!discountNodeId || !/not found|invalid id|does not exist|has already been taken/i.test(message)) {
      throw error;
    }

    discountNodeId = await createAutomaticDiscount(admin, functionId, configValue);
  }

  await prisma.automaticDiscountConfig.upsert({
    where: { shop },
    update: { discountNodeId, functionId },
    create: { shop, discountNodeId, functionId },
  });

  let codeSyncResult = {};
  try {
    codeSyncResult = await syncCodeDiscountCombinations(admin, functionId, config);
  } catch (error) {
    codeSyncResult = {
      codeSyncWarning: syncErrorMessage(error),
    };
  }

  return {
    discountNodeId,
    functionId,
    ruleCount: config.rules.length,
    ...codeSyncResult,
  };
}

export function syncErrorMessage(error) {
  if (error instanceof Response) {
    return `HTTP response ${error.status} ${error.statusText || ""}`.trim();
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/function not found/i.test(message)) {
    return "Shopify discount function is not registered on the shop yet. Deploy the Shopify app again, then retry.";
  }
  if (/unable to locate shopify discount function/i.test(message)) {
    return "Shopify discount function was not found for this app on the shop yet. Deploy the Shopify app again, then retry.";
  }
  return message;
}
