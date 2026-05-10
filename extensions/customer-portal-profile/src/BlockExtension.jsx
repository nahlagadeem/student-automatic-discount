import "@shopify/ui-extensions/preact";
import {render} from "preact";
import {useEffect, useMemo, useRef, useState} from "preact/hooks";

const POLL_INTERVAL_MS = 500;

function getSelectedCustomerId() {
  return String(shopify.data?.selected?.[0]?.id || "").trim();
}

function emptyProfile() {
  return {
    fullName: "",
    instituteName: "",
    emailDomain: "",
    role: "",
    phoneNumber: "",
  };
}

render(<Extension />, document.body);

async function getCustomerPortalProfile(customerId) {
  const result = await shopify.query(
    `#graphql
      query CustomerPortalProfile($id: ID!) {
        customer(id: $id) {
          id
          fullName: metafield(namespace: "$app", key: "portal_full_name") {
            value
          }
          instituteName: metafield(namespace: "$app", key: "portal_institute_name") {
            value
          }
          emailDomain: metafield(namespace: "$app", key: "portal_email_domain") {
            value
          }
          role: metafield(namespace: "$app", key: "portal_role") {
            value
          }
          phoneNumber: metafield(namespace: "$app", key: "portal_phone_number") {
            value
          }
        }
      }
    `,
    {variables: {id: customerId}},
  );

  const customer = result?.data?.customer || null;
  const valueFor = (fieldName) => String(customer?.[fieldName]?.value || "").trim();

  return {
    errors: Array.isArray(result?.errors) ? result.errors : [],
    profile: {
      fullName: valueFor("fullName"),
      instituteName: valueFor("instituteName"),
      emailDomain: valueFor("emailDomain"),
      role: valueFor("role"),
      phoneNumber: valueFor("phoneNumber"),
    },
  };
}

function Extension() {
  const {i18n} = shopify;
  const requestIdRef = useRef(0);
  const [customerId, setCustomerId] = useState(getSelectedCustomerId);
  const [profile, setProfile] = useState(emptyProfile);
  const [errors, setErrors] = useState([]);
  const [isLoading, setIsLoading] = useState(Boolean(customerId));

  useEffect(() => {
    const intervalId = setInterval(() => {
      const nextCustomerId = getSelectedCustomerId();
      setCustomerId((currentCustomerId) =>
        currentCustomerId === nextCustomerId ? currentCustomerId : nextCustomerId,
      );
    }, POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const currentRequestId = requestIdRef.current + 1;
    requestIdRef.current = currentRequestId;

    if (!customerId) {
      setProfile(emptyProfile());
      setErrors([]);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setErrors([]);

    getCustomerPortalProfile(customerId)
      .then((result) => {
        if (requestIdRef.current !== currentRequestId) return;
        setProfile(result.profile || emptyProfile());
        setErrors(Array.isArray(result.errors) ? result.errors : []);
      })
      .catch((error) => {
        if (requestIdRef.current !== currentRequestId) return;
        setProfile(emptyProfile());
        setErrors([{message: error instanceof Error ? error.message : String(error)}]);
      })
      .finally(() => {
        if (requestIdRef.current !== currentRequestId) return;
        setIsLoading(false);
      });
  }, [customerId]);

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
        {isLoading ? (
          <s-text>{i18n.translate("loading")}</s-text>
        ) : null}
        {errorMessage ? (
          <s-banner tone="critical">
            <s-text>{i18n.translate("loadError", {message: errorMessage})}</s-text>
          </s-banner>
        ) : null}
        {!isLoading && !errorMessage && hasData ? (
          fields.map((field) => (
            <s-box key={field.label} padding="base" borderWidth="base" borderRadius="base">
              <s-stack direction="block" gap="tight">
                <s-text type="strong">{field.label}</s-text>
                <s-text>{field.value || i18n.translate("notAvailable")}</s-text>
              </s-stack>
            </s-box>
          ))
        ) : null}
        {!isLoading && !errorMessage && !hasData ? (
          <s-stack direction="block" gap="tight">
            <s-text type="strong">{i18n.translate("emptyHeading")}</s-text>
            <s-text>{i18n.translate("emptyBody", {customerId})}</s-text>
          </s-stack>
        ) : null}
      </s-stack>
    </s-admin-block>
  );
}
