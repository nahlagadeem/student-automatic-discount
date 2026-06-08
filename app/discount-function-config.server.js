import prisma from "./db.server";
import { getInstituteByLabel } from "./institutes";
import { buildCustomerGid, linkPortalUserToCustomer } from "./portal-user-links.server";
import { setCustomerPortalProfileMetafields } from "./customer-profile-metafields.server";

const DISCOUNT_TITLE = "Discounted price";
const DISCOUNT_FUNCTION_TITLE = "Discounted price";
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

function automaticDiscountInput(functionId, configValue, customerIds) {
  return {
    title: DISCOUNT_TITLE,
    functionId,
    discountClasses: ["PRODUCT"],
    combinesWith: {
      orderDiscounts: false,
      productDiscounts: true,
      shippingDiscounts: false,
    },
    context: {
      customers: {
        add: customerIds,
      },
    },
    metafields: [
      {
        namespace: CONFIG_NAMESPACE,
        key: CONFIG_KEY,
        type: "json",
        value: configValue,
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

async function createAutomaticDiscount(admin, functionId, configValue, eligibleCustomerIds = []) {
  const customerIds = Array.from(
    new Set(eligibleCustomerIds.map((value) => buildCustomerGid(value)).filter(Boolean)),
  );

  if (!customerIds.length) {
    throw new Error("No eligible customer IDs were provided for the automatic discount.");
  }

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
        ...automaticDiscountInput(functionId, configValue, customerIds),
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

async function updateAutomaticDiscount(admin, discountNodeId, functionId, configValue, eligibleCustomerIds = []) {
  const customerIds = Array.from(
    new Set(eligibleCustomerIds.map((value) => buildCustomerGid(value)).filter(Boolean)),
  );

  if (!customerIds.length) {
    throw new Error("No eligible customer IDs were provided for the automatic discount.");
  }

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
      automaticAppDiscount: automaticDiscountInput(functionId, configValue, customerIds),
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

async function findCodeDiscountNodeIds(admin, functionId) {
  const normalizedFunctionId = String(functionId || "").trim();
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query FindCodeDiscountNodes($query: String!) {
        discountNodes(first: 100, query: $query) {
          nodes {
            id
            discount {
              __typename
              ... on DiscountCodeApp {
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
      query: "method:code",
    },
  );

  return (data?.discountNodes?.nodes ?? [])
    .filter((node) => String(node?.discount?.__typename || "").trim() === "DiscountCodeApp")
    .filter((node) => {
      const nodeFunctionId = String(node?.discount?.appDiscountType?.functionId || "").trim();
      return normalizedFunctionId && nodeFunctionId === normalizedFunctionId;
    })
    .map((node) => String(node?.id || "").trim())
    .filter(Boolean);
}

async function updateCodeDiscountCombination(admin, discountNodeId) {
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
      id: discountNodeId,
      codeAppDiscount: {
        combinesWith: {
          orderDiscounts: false,
          productDiscounts: true,
          shippingDiscounts: false,
        },
      },
    },
  );

  const payload = data?.discountCodeAppUpdate;
  if (payload?.userErrors?.length) {
    throw new Error(payload.userErrors.map((error) => error.message).join("; "));
  }

  return payload?.codeAppDiscount?.discountId || discountNodeId;
}

async function syncCodeDiscountCombinations(admin, functionId) {
  const codeDiscountNodeIds = await findCodeDiscountNodeIds(admin, functionId);
  const updatedCodeDiscountNodeIds = [];

  for (const nodeId of codeDiscountNodeIds) {
    updatedCodeDiscountNodeIds.push(await updateCodeDiscountCombination(admin, nodeId));
  }

  return {
    codeDiscountCount: codeDiscountNodeIds.length,
    updatedCodeDiscountNodeIds,
  };
}

async function findEligibleCustomerIdsForRules(shop, rules) {
  const normalizedShop = String(shop || "").trim().toLowerCase();
  const activeInstituteLabels = Array.from(
    new Set(
      rules
        .filter((rule) => rule.isActive !== false && Number(rule.percentage) > 0)
        .map((rule) => String(rule.instituteLabel || "").trim())
        .filter(Boolean),
    ),
  );

  if (!normalizedShop || !activeInstituteLabels.length) {
    return [];
  }

  const links = await prisma.portalUserCustomerLink.findMany({
    where: {
      shop: normalizedShop,
      portalUser: {
        institute: { in: activeInstituteLabels },
      },
    },
    select: {
      customerId: true,
      customerGid: true,
    },
  });

  return Array.from(
    new Set(
      links
        .flatMap((link) => [link.customerGid, link.customerId])
        .map((value) => buildCustomerGid(value))
        .filter(Boolean),
    ),
  );
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
      query: `method:automatic title:"${DISCOUNT_TITLE}"`,
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

  const config = buildFunctionConfiguration(rules);
  const configValue = JSON.stringify(config);
  const existingConfig = await prisma.automaticDiscountConfig.findUnique({
    where: { shop },
  });

  const functionId = existingConfig?.functionId || (await getDiscountFunctionId(admin));
  let discountNodeId = existingConfig?.discountNodeId || "";
  const fallbackDiscountNodeIds = await findAutomaticDiscountNodeIds(admin, functionId);
  const discountNodeIdsToDelete = new Set(
    [discountNodeId, ...fallbackDiscountNodeIds].map((value) => String(value || "").trim()).filter(Boolean),
  );
  const eligibleCustomerIds = await findEligibleCustomerIdsForRules(shop, rules);

  if (!config.rules.length) {
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

  if (!eligibleCustomerIds.length) {
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

    await prisma.automaticDiscountConfig.upsert({
      where: { shop },
      update: { discountNodeId: "", functionId },
      create: { shop, discountNodeId: "", functionId },
    });

    throw new Error(
      "No eligible customers are linked to the active institutes yet. Sync portal users first, then retry.",
    );
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
      ? await updateAutomaticDiscount(admin, nodeIdToUpdate, functionId, configValue, eligibleCustomerIds)
      : await createAutomaticDiscount(admin, functionId, configValue, eligibleCustomerIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!discountNodeId || !/not found|invalid id|does not exist|has already been taken/i.test(message)) {
      throw error;
    }

    discountNodeId = await createAutomaticDiscount(admin, functionId, configValue, eligibleCustomerIds);
  }

  await prisma.automaticDiscountConfig.upsert({
    where: { shop },
    update: { discountNodeId, functionId },
    create: { shop, discountNodeId, functionId },
  });

  const codeSyncResult = await syncCodeDiscountCombinations(admin, functionId);

  return {
    discountNodeId,
    functionId,
    ruleCount: config.rules.length,
    ...codeSyncResult,
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
