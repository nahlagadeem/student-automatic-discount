import { getInstituteByEmail, getInstituteByLabel } from "./institutes";

export const CUSTOMER_PROFILE_NAMESPACE = "student_portal";
export const CUSTOMER_PROFILE_KEYS = {
  fullName: "portal_full_name",
  instituteName: "portal_institute_name",
  emailDomain: "portal_email_domain",
  role: "portal_role",
  phoneNumber: "portal_phone_number",
};

function parseGraphqlPayload(payloadText) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

function summarizeGraphqlPayload(payloadText) {
  const payload = parseGraphqlPayload(payloadText);
  const messages = Array.isArray(payload?.errors)
    ? payload.errors
        .map((error) => String(error?.message || "").trim())
        .filter(Boolean)
    : [];

  if (messages.length) {
    return messages.slice(0, 5).join("; ");
  }

  const compact = String(payloadText || "").replace(/\s+/g, " ").trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}...` : compact;
}

export function buildPortalRoleLabel(portalUser) {
  const role = String(portalUser?.role || "").trim();
  const roleOther = String(portalUser?.roleOther || "").trim();

  if (!roleOther) return role;
  if (!role || role.toLowerCase() === "other") return roleOther;
  return `${role}: ${roleOther}`;
}

export function normalizePortalCustomerProfile(portalUser) {
  const institute =
    getInstituteByLabel(portalUser?.institute || "") ||
    getInstituteByEmail(portalUser?.schoolEmail || "") ||
    getInstituteByEmail(portalUser?.email || "");

  return {
    fullName: String(portalUser?.fullName || "").trim(),
    instituteName: String(portalUser?.institute || "").trim(),
    emailDomain: String(institute?.domain || "").trim(),
    role: buildPortalRoleLabel(portalUser),
    phoneNumber: String(portalUser?.phoneSa || "").trim(),
  };
}

export function buildCustomerPortalProfileMetafields(customerId, portalUser) {
  const profile = normalizePortalCustomerProfile(portalUser);

  return [
    {
      ownerId: customerId,
      namespace: CUSTOMER_PROFILE_NAMESPACE,
      key: CUSTOMER_PROFILE_KEYS.fullName,
      type: "single_line_text_field",
      value: profile.fullName,
    },
    {
      ownerId: customerId,
      namespace: CUSTOMER_PROFILE_NAMESPACE,
      key: CUSTOMER_PROFILE_KEYS.instituteName,
      type: "single_line_text_field",
      value: profile.instituteName,
    },
    {
      ownerId: customerId,
      namespace: CUSTOMER_PROFILE_NAMESPACE,
      key: CUSTOMER_PROFILE_KEYS.emailDomain,
      type: "single_line_text_field",
      value: profile.emailDomain,
    },
    {
      ownerId: customerId,
      namespace: CUSTOMER_PROFILE_NAMESPACE,
      key: CUSTOMER_PROFILE_KEYS.role,
      type: "single_line_text_field",
      value: profile.role,
    },
    {
      ownerId: customerId,
      namespace: CUSTOMER_PROFILE_NAMESPACE,
      key: CUSTOMER_PROFILE_KEYS.phoneNumber,
      type: "single_line_text_field",
      value: profile.phoneNumber,
    },
  ].filter((metafield) => String(metafield?.value || "").trim());
}

export async function setCustomerPortalProfileMetafields(admin, customerId, portalUser) {
  const metafields = buildCustomerPortalProfileMetafields(customerId, portalUser);
  if (!metafields.length) {
    return normalizePortalCustomerProfile(portalUser);
  }

  const response = await admin.graphql(
    `#graphql
      mutation SetCustomerPortalProfileMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors {
            message
          }
        }
      }
    `,
    {
      variables: {
        metafields,
      },
    },
  );

  const payloadText = await response.text();
  const payload = parseGraphqlPayload(payloadText);

  if (!response.ok) {
    throw new Error(`Admin API HTTP ${response.status}: ${summarizeGraphqlPayload(payloadText)}`);
  }

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  const userErrors = payload?.data?.metafieldsSet?.userErrors ?? [];
  if (userErrors.length) {
    throw new Error(userErrors.map((error) => error.message).join("; "));
  }

  return normalizePortalCustomerProfile(portalUser);
}
