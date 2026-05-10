import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useMemo} from 'preact/hooks';

export default async () => {
  const customerId = shopify.data?.selected?.[0]?.id || "";
  const result = customerId ? await getCustomerPortalProfile(customerId) : {customerId, profile: null, errors: []};
  render(<Extension {...result} />, document.body);
}

async function getCustomerPortalProfile(customerId) {
  const result = await shopify.query(
    `#graphql
      query CustomerPortalProfile($id: ID!) {
        customer(id: $id) {
          id
          metafields(identifiers: [
            {namespace: "$app", key: "portal_full_name"},
            {namespace: "$app", key: "portal_institute_name"},
            {namespace: "$app", key: "portal_email_domain"},
            {namespace: "$app", key: "portal_role"},
            {namespace: "$app", key: "portal_phone_number"}
          ]) {
            key
            value
          }
        }
      }
    `,
    {variables: {id: customerId}},
  );

  const metafields = Array.isArray(result?.data?.customer?.metafields)
    ? result.data.customer.metafields
    : [];

  const valueFor = (key) =>
    String(
      metafields.find((metafield) => String(metafield?.key || "").trim() === key)?.value || "",
    ).trim();

  return {
    customerId,
    errors: Array.isArray(result?.errors) ? result.errors : [],
    profile: {
      fullName: valueFor("portal_full_name"),
      instituteName: valueFor("portal_institute_name"),
      emailDomain: valueFor("portal_email_domain"),
      role: valueFor("portal_role"),
      phoneNumber: valueFor("portal_phone_number"),
    },
  };
}

function Extension({customerId, profile, errors}) {
  const {i18n} = shopify;
  const fields = useMemo(
    () => [
      {label: i18n.translate("fullName"), value: String(profile?.fullName || "").trim()},
      {label: i18n.translate("institute"), value: String(profile?.instituteName || "").trim()},
      {label: i18n.translate("domain"), value: String(profile?.emailDomain || "").trim()},
      {label: i18n.translate("role"), value: String(profile?.role || "").trim()},
      {label: i18n.translate("phone"), value: String(profile?.phoneNumber || "").trim()},
    ],
    [i18n, profile],
  );

  const hasData = fields.some((field) => field.value);
  const errorMessage = Array.isArray(errors)
    ? errors.map((error) => String(error?.message || "").trim()).filter(Boolean).join("; ")
    : "";

  return (
    <s-admin-block heading={i18n.translate("blockHeading")}>
      <s-stack direction="block" gap="base">
        {errorMessage ? (
          <s-banner tone="critical">
            <s-text>{i18n.translate("loadError", {message: errorMessage})}</s-text>
          </s-banner>
        ) : null}
        {hasData ? (
          fields.map((field) => (
            <s-box key={field.label} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="tight">
                <s-text type="strong">{field.label}</s-text>
                <s-text>{field.value || i18n.translate("notAvailable")}</s-text>
              </s-stack>
            </s-box>
          ))
        ) : (
          <s-stack direction="block" gap="tight">
            <s-text type="strong">{i18n.translate("emptyHeading")}</s-text>
            <s-text>{i18n.translate("emptyBody", {customerId})}</s-text>
          </s-stack>
        )}
      </s-stack>
    </s-admin-block>
  );
}
