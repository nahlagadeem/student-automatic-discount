import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
import {
  ensureBundleVisibilityRuleTable,
  listBundleVisibilityRules,
  setBundleVisibilityRule,
} from "../bundle-visibility-rules.server";
import {
  ensureAutomaticDiscountConfigTable,
  syncPortalUsersToCustomerTags,
  syncErrorMessage,
  syncAutomaticDiscountRules,
} from "../discount-function-config.server";
import {
  buildInstituteOptions,
  getCategoryByKey,
  getInstituteByKey,
  PRODUCT_CATEGORIES,
} from "../institutes";
import { authenticate } from "../shopify.server";

function clampPercentage(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return Math.round(parsed);
}

function summarizeActionResult(data) {
  if (!data) return "";

  const lines = [];
  lines.push(`ok: ${Boolean(data.ok)}`);

  if (data.error) lines.push(`error: ${data.error}`);
  if (data.warning) lines.push(`warning: ${data.warning}`);
  if (data.deleted) lines.push("action: rule deleted");
  if (data.bundleVisibilityRule) {
    lines.push(
      `bundle visibility: ${data.bundleVisibilityRule.instituteLabel} | ${
        data.bundleVisibilityRule.isEnabled ? "enabled" : "disabled"
      }`
    );
  }
  if (data.savedRule) {
    lines.push(
      `saved: ${data.savedRule.instituteLabel} | ${data.savedRule.categoryLabel} | ${data.savedRule.percentage}%`
    );
  }
  if (data.syncResult) {
    lines.push(
      `discount sync: ${data.syncResult.ruleCount || 0} rules, node ${data.syncResult.discountNodeId || "n/a"}`
    );
  }
  if (data.portalSyncResult) {
    lines.push(
      `portal sync: ${data.portalSyncResult.syncedUserCount || 0} users, ${data.portalSyncResult.syncedCustomerCount || 0} customers`
    );
  }

  return lines.join("\n");
}

const INSTITUTE_OPTIONS = buildInstituteOptions();

async function runGraphql(admin, query, variables = {}) {
  const response = await admin.graphql(query, { variables });
  const json = await response.json();
  return { response, json };
}

async function fetchCollections(admin) {
  const query = `#graphql
    query Collections($cursor: String) {
      collections(first: 250, after: $cursor, sortKey: TITLE) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          title
          handle
        }
      }
    }
  `;

  const collections = [];
  let cursor = null;

  do {
    const result = await runGraphql(admin, query, { cursor });
    if (!result.response.ok || result.json?.errors?.length) break;

    const connection = result.json?.data?.collections;
    collections.push(
      ...(connection?.nodes ?? []).map((collection) => ({
        key: String(collection?.id || "").trim(),
        label: String(collection?.title || "").trim(),
        handle: String(collection?.handle || "").trim(),
        collectionId: String(collection?.id || "").trim(),
      })),
    );
    cursor = connection?.pageInfo?.hasNextPage ? connection.pageInfo.endCursor : null;
  } while (cursor);

  return collections.filter((collection) => collection.key && collection.label);
}

function getSubmittedCategory(categoryKey, categoryLabel) {
  const legacyCategory = getCategoryByKey(categoryKey);
  if (legacyCategory) return legacyCategory;

  const normalizedKey = String(categoryKey || "").trim();
  const normalizedLabel = String(categoryLabel || "").trim();
  if (normalizedKey.startsWith("gid://shopify/Collection/") && normalizedLabel) {
    return {
      key: normalizedKey,
      label: normalizedLabel,
      collectionId: normalizedKey,
    };
  }

  return null;
}

function mergeCategoriesForExistingRules(collections, rules) {
  if (!collections.length) return PRODUCT_CATEGORIES;

  const collectionKeys = new Set(collections.map((collection) => collection.key));
  const legacyCategoriesByKey = new Map(PRODUCT_CATEGORIES.map((category) => [category.key, category]));
  const legacyCategoriesInUse = rules
    .map((rule) => legacyCategoriesByKey.get(String(rule.categoryKey || "").trim()))
    .filter((category) => category && !collectionKeys.has(category.key));

  return [...collections, ...legacyCategoriesInUse];
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  await ensureAutomaticDiscountRuleTable();
  await ensureAutomaticDiscountConfigTable();
  await ensureBundleVisibilityRuleTable();

  const rules = await prisma.automaticDiscountRule.findMany({
    where: { shop: session.shop },
    orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
  });

  const collections = await fetchCollections(admin);
  const bundleVisibilityRules = await listBundleVisibilityRules(session.shop);

  return {
    shop: session.shop,
    instituteOptions: INSTITUTE_OPTIONS,
    categories: mergeCategoriesForExistingRules(collections, rules),
    rules,
    bundleVisibilityRules,
  };
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  await ensureAutomaticDiscountRuleTable();
  await ensureAutomaticDiscountConfigTable();
  await ensureBundleVisibilityRuleTable();

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save").trim();

  if (intent === "bundle-visibility") {
    const instituteKey = String(formData.get("instituteKey") || "").trim();
    const isEnabled = String(formData.get("isEnabled") || "").trim() === "true";

    try {
      const bundleVisibilityRule = await setBundleVisibilityRule({
        shop: session.shop,
        instituteKey,
        isEnabled,
      });

      return { ok: true, bundleVisibilityRule };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  if (intent === "delete") {
    const ruleId = Number(formData.get("ruleId"));
    if (!Number.isFinite(ruleId)) {
      return { ok: false, error: "Invalid rule id." };
    }

    await prisma.automaticDiscountRule.deleteMany({
      where: {
        id: ruleId,
        shop: session.shop,
      },
    });

    const rules = await prisma.automaticDiscountRule.findMany({
      where: { shop: session.shop },
      orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
    });
    try {
      const portalSyncResult = await syncPortalUsersToCustomerTags({ admin, shop: session.shop, rules });
      const syncResult = await syncAutomaticDiscountRules({ admin, shop: session.shop, rules });
      return { ok: true, deleted: true, syncResult, portalSyncResult };
    } catch (error) {
      return {
        ok: true,
        deleted: true,
        warning: `Rule deleted locally, but Shopify discount sync failed: ${syncErrorMessage(error)}`,
      };
    }
  }

  const instituteKey = String(formData.get("instituteKey") || "").trim();
  const categoryKey = String(formData.get("categoryKey") || "").trim();
  const categoryLabel = String(formData.get("categoryLabel") || "").trim();
  const percentage = clampPercentage(formData.get("percentage"));

  const institute = getInstituteByKey(instituteKey);
  const category = getSubmittedCategory(categoryKey, categoryLabel);

  if (!institute) {
    return { ok: false, error: "Please choose an institute." };
  }

  if (!category) {
    return { ok: false, error: "Please choose a category." };
  }

  const savedRule = await prisma.automaticDiscountRule.upsert({
    where: {
      shop_instituteKey_categoryKey: {
        shop: session.shop,
        instituteKey,
        categoryKey,
      },
    },
    update: {
      instituteLabel: institute.label,
      emailDomain: institute.domain,
      categoryLabel: category.label,
      percentage,
      isActive: true,
    },
    create: {
      shop: session.shop,
      instituteKey,
      instituteLabel: institute.label,
      emailDomain: institute.domain,
      categoryKey,
      categoryLabel: category.label,
      percentage,
      isActive: true,
    },
  });

  const rules = await prisma.automaticDiscountRule.findMany({
    where: { shop: session.shop },
    orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
  });
  try {
    const portalSyncResult = await syncPortalUsersToCustomerTags({ admin, shop: session.shop, rules });
    const syncResult = await syncAutomaticDiscountRules({ admin, shop: session.shop, rules });

    return {
      ok: true,
      savedRule,
      syncResult,
      portalSyncResult,
    };
  } catch (error) {
    return {
      ok: true,
      savedRule,
      warning: `Rule saved locally, but Shopify discount sync failed: ${syncErrorMessage(error)}`,
    };
  }
};

export default function Index() {
  const { instituteOptions, categories, rules, bundleVisibilityRules } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const [editingRuleId, setEditingRuleId] = useState("");
  const [instituteKey, setInstituteKey] = useState("");
  const [categoryKey, setCategoryKey] = useState("");
  const [percentage, setPercentage] = useState("0");

  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show(
        fetcher.data.warning || (fetcher.data.deleted ? "Rule deleted" : "Rule saved")
      );
      if (!fetcher.data.deleted) {
        setEditingRuleId("");
        setInstituteKey("");
        setCategoryKey("");
        setPercentage("0");
      }
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error);
    }
  }, [fetcher.data, shopify]);

  const selectedInstitute = useMemo(() => getInstituteByKey(instituteKey), [instituteKey]);
  const selectedCategory = useMemo(
    () => categories.find((category) => category.key === categoryKey) || null,
    [categories, categoryKey],
  );
  const actionSummary = useMemo(() => summarizeActionResult(fetcher.data), [fetcher.data]);

  const submitRule = () => {
    const form = new FormData();
    form.set("intent", "save");
    if (editingRuleId) form.set("ruleId", editingRuleId);
    form.set("instituteKey", instituteKey);
    form.set("categoryKey", categoryKey);
    form.set("categoryLabel", selectedCategory?.label || "");
    form.set("percentage", percentage);
    fetcher.submit(form, { method: "POST" });
  };

  const deleteRule = (ruleId) => {
    const form = new FormData();
    form.set("intent", "delete");
    form.set("ruleId", String(ruleId));
    fetcher.submit(form, { method: "POST" });
  };

  const setBundleVisibility = (rule, isEnabled) => {
    const form = new FormData();
    form.set("intent", "bundle-visibility");
    form.set("instituteKey", rule.key);
    form.set("isEnabled", String(isEnabled));
    fetcher.submit(form, { method: "POST" });
  };

  const editRule = (rule) => {
    setEditingRuleId(String(rule.id));
    setInstituteKey(rule.instituteKey);
    setCategoryKey(rule.categoryKey);
    setPercentage(String(rule.percentage));
  };

  const cancelEdit = () => {
    setEditingRuleId("");
    setInstituteKey("");
    setCategoryKey("");
    setPercentage("0");
  };

  const isEditing = Boolean(editingRuleId);

  return (
    <s-page heading="Automatic Institute Discount Rules">
      <s-section heading="Create or update a rule">
        <s-paragraph>
          Choose an institute, choose a category, and set the automatic discount percentage.
        </s-paragraph>

        <s-stack gap="base">
          <label>
            <div style={{ marginBottom: "0.35rem", fontWeight: 600 }}>Institute</div>
            <select
              value={instituteKey}
              onChange={(event) => setInstituteKey(String(event.currentTarget.value || ""))}
              style={{
                width: "100%",
                minHeight: "44px",
                borderRadius: "12px",
                border: "1px solid #8a8a8a",
                padding: "0 12px",
                background: "#fff",
              }}
            >
              <option value="">Choose institute</option>
              {Object.entries(instituteOptions).map(([segment, institutes]) => (
                <optgroup key={segment} label={segment}>
                  {institutes.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>

          {selectedInstitute ? (
            <s-paragraph>School email domain: {selectedInstitute.domain}</s-paragraph>
          ) : null}

          <label>
            <div style={{ marginBottom: "0.35rem", fontWeight: 600 }}>Category</div>
            <select
              value={categoryKey}
              onChange={(event) => setCategoryKey(String(event.currentTarget.value || ""))}
              style={{
                width: "100%",
                minHeight: "44px",
                borderRadius: "12px",
                border: "1px solid #8a8a8a",
                padding: "0 12px",
                background: "#fff",
              }}
            >
              <option value="">Choose category</option>
              {categories.map((category) => (
                <option key={category.key} value={category.key}>
                  {category.label}
                </option>
              ))}
            </select>
          </label>

          <s-number-field
            label="Discount percentage"
            min={0}
            max={100}
            suffix="%"
            value={percentage}
            onChange={(event) => setPercentage(String(clampPercentage(event.currentTarget.value)))}
          />

          <s-stack direction="inline" gap="base">
            <s-button onClick={submitRule} {...(isSubmitting ? { loading: true } : {})}>
              {isEditing ? "Update rule" : "Save rule"}
            </s-button>
            {isEditing ? <s-button variant="secondary" onClick={cancelEdit}>Cancel</s-button> : null}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Saved rules">
        {rules.length === 0 ? (
          <s-paragraph>No automatic discount rules saved yet.</s-paragraph>
        ) : (
          <s-stack gap="base">
            {rules.map((rule) => (
              <s-box
                key={rule.id}
                padding="base"
                borderWidth="base"
                borderRadius="base"
                background="subdued"
              >
                <s-stack gap="tight">
                  <s-heading>{rule.instituteLabel}</s-heading>
                  <s-paragraph>
                    {rule.categoryLabel} | {rule.percentage}% | {rule.emailDomain}
                  </s-paragraph>
                  <s-stack direction="inline" gap="base">
                    <s-button onClick={() => editRule(rule)}>Edit</s-button>
                    <s-button tone="critical" onClick={() => deleteRule(rule.id)}>
                      Delete
                    </s-button>
                  </s-stack>
                </s-stack>
              </s-box>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Bundle Visibility">
        <s-paragraph>
          Bundle pages are visible to enabled institutes by default. Customers without a known institute remain blocked.
        </s-paragraph>
        <s-stack gap="base">
          {(bundleVisibilityRules ?? []).map((rule) => (
            <s-box
              key={rule.key}
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <s-stack gap="tight">
                <s-heading>{rule.label}</s-heading>
                <s-paragraph>
                  {rule.domain} | {rule.isEnabled ? "Enabled" : "Disabled"}
                  {rule.isDefault ? " | default" : ""}
                </s-paragraph>
                <s-stack direction="inline" gap="base">
                  <s-button
                    disabled={rule.isEnabled}
                    onClick={() => setBundleVisibility(rule, true)}
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Enable
                  </s-button>
                  <s-button
                    tone="critical"
                    disabled={!rule.isEnabled}
                    onClick={() => setBundleVisibility(rule, false)}
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Disable
                  </s-button>
                </s-stack>
              </s-stack>
            </s-box>
          ))}
        </s-stack>
      </s-section>

      {fetcher.data ? (
        <s-section heading="Last action result">
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <pre style={{ margin: 0 }}>
              <code>{actionSummary}</code>
            </pre>
          </s-box>
        </s-section>
      ) : null}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
