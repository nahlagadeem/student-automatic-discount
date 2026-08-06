import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ensureBundleVisibilityRuleTable,
  listSavedBundleVisibilityRules,
  setBundleVisibilityRule,
} from "../bundle-visibility-rules.server";
import { INSTITUTES } from "../institutes";
import { authenticate } from "../shopify.server";
import { runAdminGraphql } from "../student-discount.server";

const ALL_BUNDLES_COLLECTION_ID = "gid://shopify/Collection/458566009050";
const FALLBACK_BUNDLE = {
  productId: "",
  handle: "primary-years-bundle",
  title: "Primary Years Bundle",
};

async function fetchBundleProducts(admin) {
  try {
    const data = await runAdminGraphql(
      admin,
      `#graphql
        query BundleProducts($id: ID!) {
          collection(id: $id) {
            products(first: 250, sortKey: TITLE) {
              nodes {
                id
                title
                handle
              }
            }
          }
        }
      `,
      { id: ALL_BUNDLES_COLLECTION_ID },
    );

    const products = (data?.collection?.products?.nodes ?? [])
      .map((product) => ({
        productId: String(product?.id || "").trim(),
        handle: String(product?.handle || "").trim().toLowerCase(),
        title: String(product?.title || "").trim(),
      }))
      .filter((product) => product.handle && product.title);

    return products.length ? products : [FALLBACK_BUNDLE];
  } catch (error) {
    console.warn("[bundle-visibility] failed to fetch bundle products:", error);
    return [FALLBACK_BUNDLE];
  }
}

function summarizeActionResult(data) {
  if (!data) return "";

  const lines = [];
  lines.push(`ok: ${Boolean(data.ok)}`);
  if (data.error) lines.push(`error: ${data.error}`);
  if (data.bundleVisibilityRule) {
    lines.push(
      `bundle visibility: ${data.bundleVisibilityRule.bundleTitle} | ${
        data.bundleVisibilityRule.instituteLabel
      } | ${data.bundleVisibilityRule.isEnabled ? "enabled" : "disabled"}`,
    );
  }

  return lines.join("\n");
}

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  await ensureBundleVisibilityRuleTable();

  return {
    bundles: await fetchBundleProducts(admin),
    savedRules: await listSavedBundleVisibilityRules(session.shop),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureBundleVisibilityRuleTable();

  const formData = await request.formData();
  const bundleProductId = String(formData.get("bundleProductId") || "").trim();
  const bundleHandle = String(formData.get("bundleHandle") || "").trim().toLowerCase();
  const bundleTitle = String(formData.get("bundleTitle") || "").trim();
  const instituteKey = String(formData.get("instituteKey") || "").trim();
  const isEnabled = String(formData.get("isEnabled") || "").trim() === "true";

  try {
    const bundleVisibilityRule = await setBundleVisibilityRule({
      shop: session.shop,
      bundleProductId,
      bundleHandle,
      bundleTitle,
      instituteKey,
      isEnabled,
    });

    return { ok: true, bundleVisibilityRule };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

export default function BundleVisibility() {
  const { bundles, savedRules } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const [selectedBundleHandle, setSelectedBundleHandle] = useState(bundles?.[0]?.handle || "");
  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const actionSummary = useMemo(() => summarizeActionResult(fetcher.data), [fetcher.data]);
  const selectedBundle = useMemo(
    () => (bundles ?? []).find((bundle) => bundle.handle === selectedBundleHandle) || null,
    [bundles, selectedBundleHandle],
  );
  const rulesForSelectedBundle = useMemo(() => {
    const overridesByInstituteKey = new Map(
      (savedRules ?? [])
        .filter((rule) => String(rule.bundleHandle || "").trim() === selectedBundleHandle)
        .map((rule) => [String(rule.instituteKey || "").trim(), Boolean(rule.isEnabled)]),
    );

    return INSTITUTES.map((institute) => ({
      ...institute,
      isEnabled: overridesByInstituteKey.has(institute.key)
        ? overridesByInstituteKey.get(institute.key)
        : false,
      isDefault: !overridesByInstituteKey.has(institute.key),
    }));
  }, [savedRules, selectedBundleHandle]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Bundle visibility updated");
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error);
    }
  }, [fetcher.data, shopify]);

  const setBundleVisibility = (rule, isEnabled) => {
    if (!selectedBundle) {
      shopify.toast.show("Please choose a bundle.");
      return;
    }

    const form = new FormData();
    form.set("bundleProductId", selectedBundle.productId || "");
    form.set("bundleHandle", selectedBundle.handle);
    form.set("bundleTitle", selectedBundle.title);
    form.set("instituteKey", rule.key);
    form.set("isEnabled", String(isEnabled));
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page heading="Bundle Visibility">
      <s-section heading="Choose bundle">
        <s-stack gap="base">
          <s-paragraph>
            Select a product from the All Bundles collection, then enable or disable institute access for that bundle.
          </s-paragraph>
          <label>
            <div style={{ marginBottom: "0.35rem", fontWeight: 600 }}>Bundle</div>
            <select
              value={selectedBundleHandle}
              onChange={(event) => setSelectedBundleHandle(String(event.currentTarget.value || ""))}
              style={{
                width: "100%",
                minHeight: "44px",
                borderRadius: "12px",
                border: "1px solid #8a8a8a",
                padding: "0 12px",
                background: "#fff",
              }}
            >
              {(bundles ?? []).map((bundle) => (
                <option key={bundle.handle} value={bundle.handle}>
                  {bundle.title}
                </option>
              ))}
            </select>
          </label>
        </s-stack>
      </s-section>

      <s-section heading="Institution access">
        <s-paragraph>
          {selectedBundle
            ? `${selectedBundle.title} is visible only to institutes explicitly enabled here. Customers without a known institute remain blocked.`
            : "Choose a bundle to manage institute access."}
        </s-paragraph>
        <s-stack gap="base">
          {rulesForSelectedBundle.map((rule) => (
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
                    disabled={rule.isEnabled || !selectedBundle}
                    onClick={() => setBundleVisibility(rule, true)}
                    {...(isSubmitting ? { loading: true } : {})}
                  >
                    Enable
                  </s-button>
                  <s-button
                    tone="critical"
                    disabled={!rule.isEnabled || !selectedBundle}
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
