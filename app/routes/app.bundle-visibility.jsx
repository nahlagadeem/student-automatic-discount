import { useEffect, useMemo } from "react";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  ensureBundleVisibilityRuleTable,
  listBundleVisibilityRules,
  setBundleVisibilityRule,
} from "../bundle-visibility-rules.server";
import { authenticate } from "../shopify.server";

function summarizeActionResult(data) {
  if (!data) return "";

  const lines = [];
  lines.push(`ok: ${Boolean(data.ok)}`);
  if (data.error) lines.push(`error: ${data.error}`);
  if (data.bundleVisibilityRule) {
    lines.push(
      `bundle visibility: ${data.bundleVisibilityRule.instituteLabel} | ${
        data.bundleVisibilityRule.isEnabled ? "enabled" : "disabled"
      }`,
    );
  }

  return lines.join("\n");
}

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureBundleVisibilityRuleTable();

  return {
    bundleVisibilityRules: await listBundleVisibilityRules(session.shop),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  await ensureBundleVisibilityRuleTable();

  const formData = await request.formData();
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
};

export default function BundleVisibility() {
  const { bundleVisibilityRules } = useLoaderData();
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const isSubmitting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";
  const actionSummary = useMemo(() => summarizeActionResult(fetcher.data), [fetcher.data]);

  useEffect(() => {
    if (!fetcher.data) return;
    if (fetcher.data.ok) {
      shopify.toast.show("Bundle visibility updated");
    } else if (fetcher.data.error) {
      shopify.toast.show(fetcher.data.error);
    }
  }, [fetcher.data, shopify]);

  const setBundleVisibility = (rule, isEnabled) => {
    const form = new FormData();
    form.set("instituteKey", rule.key);
    form.set("isEnabled", String(isEnabled));
    fetcher.submit(form, { method: "POST" });
  };

  return (
    <s-page heading="Bundle Visibility">
      <s-section heading="Institution access">
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
