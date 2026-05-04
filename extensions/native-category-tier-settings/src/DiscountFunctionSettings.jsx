import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useMemo} from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

function App() {
  const {i18n, data} = shopify;
  const config = useMemo(
    () =>
      parseConfig(
        data?.metafields?.find(
          (metafield) => metafield.key === "function-configuration",
        )?.value,
      ),
    [data?.metafields],
  );

  return (
    <s-function-settings>
      <s-heading>{i18n.translate("title")}</s-heading>
      <s-stack gap="base">
        <s-paragraph>{i18n.translate("managedInApp")}</s-paragraph>
        {config.rules.length ? (
          config.rules.map((rule) => (
            <s-box key={`${rule.instituteKey}-${rule.categoryKey}`} padding="base" borderWidth="base" borderRadius="base">
              <s-paragraph>
                {rule.instituteLabel} | {rule.categoryLabel} | {rule.percentage}% | {rule.emailDomain}
              </s-paragraph>
            </s-box>
          ))
        ) : (
          <s-paragraph>{i18n.translate("emptyState")}</s-paragraph>
        )}
      </s-stack>
    </s-function-settings>
  );
}

function parseConfig(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    };
  } catch {
    return {rules: []};
  }
}
