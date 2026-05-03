import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
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

const INSTITUTE_OPTIONS = buildInstituteOptions();

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureAutomaticDiscountRuleTable();

  const rules = await prisma.automaticDiscountRule.findMany({
    where: { shop: session.shop },
    orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
  });

  return {
    shop: session.shop,
    instituteOptions: INSTITUTE_OPTIONS,
    categories: PRODUCT_CATEGORIES,
    rules,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureAutomaticDiscountRuleTable();

  const formData = await request.formData();
  const intent = String(formData.get("intent") || "save").trim();

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

    return { ok: true, deleted: true };
  }

  const instituteKey = String(formData.get("instituteKey") || "").trim();
  const categoryKey = String(formData.get("categoryKey") || "").trim();
  const percentage = clampPercentage(formData.get("percentage"));

  const institute = getInstituteByKey(instituteKey);
  const category = getCategoryByKey(categoryKey);

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

  return {
    ok: true,
    savedRule,
  };
};

export default function Index() {
  const { instituteOptions, categories, rules } = useLoaderData();
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
      shopify.toast.show(fetcher.data.deleted ? "Rule deleted" : "Rule saved");
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

  const submitRule = () => {
    const form = new FormData();
    form.set("intent", "save");
    if (editingRuleId) form.set("ruleId", editingRuleId);
    form.set("instituteKey", instituteKey);
    form.set("categoryKey", categoryKey);
    form.set("percentage", percentage);
    fetcher.submit(form, { method: "POST" });
  };

  const deleteRule = (ruleId) => {
    const form = new FormData();
    form.set("intent", "delete");
    form.set("ruleId", String(ruleId));
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
    <s-page heading="Automatic Student Discount Rules">
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

      {fetcher.data ? (
        <s-section heading="Last action result">
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <pre style={{ margin: 0 }}>
              <code>{JSON.stringify(fetcher.data, null, 2)}</code>
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
