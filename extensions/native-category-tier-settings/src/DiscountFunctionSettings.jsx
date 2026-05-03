import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useMemo, useState} from "preact/hooks";

const DEFAULTS = {
  ipadPercentage: 8,
  macPercentage: 13,
  accessoriesPercentage: 5,
  iphonePercentage: 0,
  appleWatchPercentage: 0,
  tvHomePercentage: 0,
  airpodsPercentage: 0,
};

export default async () => {
  render(<App />, document.body);
};

function App() {
  const {i18n, applyMetafieldChange, data} = shopify;
  const initialValues = useMemo(
    () =>
      parseConfig(
        data?.metafields?.find(
          (metafield) => metafield.key === "function-configuration",
        )?.value,
      ),
    [data?.metafields],
  );

  const [values, setValues] = useState(initialValues);

  const onChange = (field, rawValue) => {
    setValues((previous) => ({
      ...previous,
      [field]: clampPercentage(rawValue, previous[field]),
    }));
  };

  const onSubmit = async () => {
    await applyMetafieldChange({
      type: "updateMetafield",
      namespace: "$app:category-tier-discount-native",
      key: "function-configuration",
      valueType: "json",
      value: JSON.stringify(values),
    });
  };

  return (
    <s-function-settings
      onSubmit={(event) => event.waitUntil?.(onSubmit())}
      onReset={() => setValues(initialValues)}
    >
      <s-heading>{i18n.translate("title")}</s-heading>
      <s-stack gap="base">
        <s-stack direction="inline" gap="base">
          <s-number-field
            label={i18n.translate("labels.ipad")}
            name="ipadPercentage"
            value={String(values.ipadPercentage)}
            defaultValue={String(initialValues.ipadPercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) => onChange("ipadPercentage", event.currentTarget.value)}
          />
          <s-number-field
            label={i18n.translate("labels.mac")}
            name="macPercentage"
            value={String(values.macPercentage)}
            defaultValue={String(initialValues.macPercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) => onChange("macPercentage", event.currentTarget.value)}
          />
          <s-number-field
            label={i18n.translate("labels.accessories")}
            name="accessoriesPercentage"
            value={String(values.accessoriesPercentage)}
            defaultValue={String(initialValues.accessoriesPercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) =>
              onChange("accessoriesPercentage", event.currentTarget.value)
            }
          />
        </s-stack>
        <s-stack direction="inline" gap="base">
          <s-number-field
            label={i18n.translate("labels.iphone")}
            name="iphonePercentage"
            value={String(values.iphonePercentage)}
            defaultValue={String(initialValues.iphonePercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) => onChange("iphonePercentage", event.currentTarget.value)}
          />
          <s-number-field
            label={i18n.translate("labels.appleWatch")}
            name="appleWatchPercentage"
            value={String(values.appleWatchPercentage)}
            defaultValue={String(initialValues.appleWatchPercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) =>
              onChange("appleWatchPercentage", event.currentTarget.value)
            }
          />
          <s-number-field
            label={i18n.translate("labels.tvHome")}
            name="tvHomePercentage"
            value={String(values.tvHomePercentage)}
            defaultValue={String(initialValues.tvHomePercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) => onChange("tvHomePercentage", event.currentTarget.value)}
          />
        </s-stack>
        <s-stack direction="inline" gap="base">
          <s-number-field
            label={i18n.translate("labels.airpods")}
            name="airpodsPercentage"
            value={String(values.airpodsPercentage)}
            defaultValue={String(initialValues.airpodsPercentage)}
            min={0}
            max={100}
            suffix="%"
            onChange={(event) => onChange("airpodsPercentage", event.currentTarget.value)}
          />
        </s-stack>
      </s-stack>
    </s-function-settings>
  );
}

function parseConfig(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return {
      ipadPercentage: clampPercentage(parsed.ipadPercentage, DEFAULTS.ipadPercentage),
      macPercentage: clampPercentage(parsed.macPercentage, DEFAULTS.macPercentage),
      accessoriesPercentage: clampPercentage(
        parsed.accessoriesPercentage,
        DEFAULTS.accessoriesPercentage,
      ),
      iphonePercentage: clampPercentage(parsed.iphonePercentage, DEFAULTS.iphonePercentage),
      appleWatchPercentage: clampPercentage(
        parsed.appleWatchPercentage,
        DEFAULTS.appleWatchPercentage,
      ),
      tvHomePercentage: clampPercentage(parsed.tvHomePercentage, DEFAULTS.tvHomePercentage),
      airpodsPercentage: clampPercentage(parsed.airpodsPercentage, DEFAULTS.airpodsPercentage),
    };
  } catch {
    return DEFAULTS;
  }
}

function clampPercentage(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 0) return 0;
  if (parsed > 100) return 100;
  return parsed;
}
