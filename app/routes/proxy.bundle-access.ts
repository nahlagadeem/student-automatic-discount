import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  errorMessage,
  json,
  normalizeShopDomain,
  resolveAdminClient,
  runAdminGraphql,
} from "../student-discount.server";
import { getInstituteByEmail, getInstituteByKey, getInstituteByLabel } from "../institutes";
import { buildCustomerGid, buildLegacyCustomerId, linkPortalUserToCustomer } from "../portal-user-links.server";
import { setCustomerPortalProfileMetafields } from "../customer-profile-metafields.server";

type GraphqlClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const BISR_COLLECTION_HANDLES = new Set(["bundle", "all-bundles"]);
const BISR_PRODUCT_HANDLES = new Set(["primary-years-bundle"]);

function normalizeEmail(input: string | null | undefined) {
  return String(input || "").trim().toLowerCase();
}

function buildCustomerId(url: URL) {
  return String(url.searchParams.get("logged_in_customer_id") || url.searchParams.get("customerId") || "").trim();
}

async function fetchCustomerIdentity(admin: GraphqlClient, customerId: string) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query GetCustomerInstitute($id: ID!) {
        customer(id: $id) {
          id
          email
          instituteKey: metafield(namespace: "$app:student-discount", key: "institute_key") {
            value
          }
          portalInstituteName: metafield(namespace: "$app", key: "portal_institute_name") {
            value
          }
          portalEmailDomain: metafield(namespace: "$app", key: "portal_email_domain") {
            value
          }
        }
      }
    `,
    { id: customerId },
  );

  return data?.customer || null;
}

async function findPortalUserForCustomer(shop: string, customerGid: string, email: string) {
  const customerId = buildLegacyCustomerId(customerGid);

  const linkedUser = await prisma.portalUserCustomerLink.findFirst({
    where: {
      shop,
      OR: [
        ...(customerId ? [{ customerId }] : []),
        ...(customerGid ? [{ customerGid }] : []),
      ],
    },
    select: {
      portalUser: {
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
      },
    },
  });

  if (linkedUser?.portalUser?.id) {
    return linkedUser.portalUser;
  }

  if (!email) return null;

  return prisma.portalUser.findFirst({
    where: {
      OR: [{ email }, { schoolEmail: email }],
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
}

function resolvePortalUserInstitute(portalUser: {
  institute?: string | null;
  schoolEmail?: string | null;
  email?: string | null;
}) {
  const instituteKey =
    getInstituteByLabel(portalUser?.institute || "")?.key ||
    getInstituteByEmail(portalUser?.schoolEmail || "")?.key ||
    getInstituteByEmail(portalUser?.email || "")?.key ||
    "";

  return {
    instituteKey,
    institute: getInstituteByKey(instituteKey),
  };
}

async function getCustomerBundleAccessProfile(admin: GraphqlClient, shop: string, customerGid: string) {
  const linkedPortalUser = await findPortalUserForCustomer(shop, customerGid, "");
  if (linkedPortalUser?.id) {
    const { instituteKey, institute } = resolvePortalUserInstitute(linkedPortalUser);
    return { customer: null, portalUser: linkedPortalUser, instituteKey, institute };
  }

  const customer = await fetchCustomerIdentity(admin, customerGid);
  const email = normalizeEmail(customer?.email);
  if (!customer?.id || !email) {
    return { customer, portalUser: null, instituteKey: "", institute: null };
  }

  const portalUser = await findPortalUserForCustomer(shop, customer.id, email);
  if (!portalUser?.id) {
    const profileDomain = String(customer?.portalEmailDomain?.value || "").trim();
    const institute =
      getInstituteByKey(customer?.instituteKey?.value || "") ||
      getInstituteByLabel(customer?.portalInstituteName?.value || "") ||
      getInstituteByEmail(profileDomain ? `student${profileDomain}` : "");

    return {
      customer,
      portalUser: null,
      instituteKey: institute?.key || "",
      institute: institute || null,
    };
  }

  const { instituteKey, institute } = resolvePortalUserInstitute(portalUser);

  if (!instituteKey || !institute) {
    return { customer, portalUser, instituteKey: "", institute: null };
  }

  try {
    await linkPortalUserToCustomer({
      shop,
      portalUserId: portalUser.id,
      customerId: customer.id,
      customerGid: customer.id,
    });
  } catch (linkError) {
    console.warn("[bundle-access] failed to link portal user to customer:", errorMessage(linkError));
  }

  try {
    const response = await admin.graphql(
      `#graphql
        mutation SetCustomerInstituteMetafield($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors {
              message
            }
          }
        }
      `,
      {
        variables: {
          metafields: [
            {
              ownerId: customer.id,
              namespace: "$app:student-discount",
              key: "institute_key",
              type: "single_line_text_field",
              value: instituteKey,
            },
          ],
        },
      },
    );

    const payload = await response.json();
    const userErrors = payload?.data?.metafieldsSet?.userErrors ?? [];
    if (userErrors.length) {
      throw new Error(userErrors.map((entry: { message?: string }) => String(entry?.message || "").trim()).filter(Boolean).join("; "));
    }
  } catch (metafieldError) {
    console.warn("[bundle-access] failed to persist customer institute metafield:", errorMessage(metafieldError));
  }

  try {
    await setCustomerPortalProfileMetafields(admin, customer.id, portalUser);
  } catch (profileError) {
    console.warn("[bundle-access] failed to persist customer profile metafields:", errorMessage(profileError));
  }

  return { customer, portalUser, instituteKey, institute };
}

function isProtectedCollection(collectionHandle: string) {
  return BISR_COLLECTION_HANDLES.has(String(collectionHandle || "").trim().toLowerCase());
}

function isProtectedProduct(productHandle: string) {
  return BISR_PRODUCT_HANDLES.has(String(productHandle || "").trim().toLowerCase());
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop"));
  const collectionHandle = String(
    url.searchParams.get("collection_handle") || url.searchParams.get("collectionHandle") || "",
  )
    .trim()
    .toLowerCase();
  const productHandle = String(
    url.searchParams.get("product_handle") || url.searchParams.get("productHandle") || "",
  )
    .trim()
    .toLowerCase();
  const customerId = buildCustomerId(url);

  try {
    await authenticate.public.appProxy(request);
  } catch (error) {
    return json(
      {
        ok: false,
        allowed: false,
        error: "Invalid proxy signature.",
        detail: errorMessage(error),
      },
      { status: 401 },
    );
  }

  if (!shop) {
    return json({ ok: false, allowed: false, error: "Missing shop parameter." }, { status: 400 });
  }

  if (!isProtectedCollection(collectionHandle) && !isProtectedProduct(productHandle)) {
    return json({
      ok: true,
      allowed: true,
      protected: false,
      collectionHandle,
      productHandle,
      customerId: customerId || null,
    });
  }

  return json({
    ok: true,
    allowed: true,
    protected: true,
    reason: "public_bundle_access_enabled",
    collectionHandle,
    productHandle,
    customerId: customerId || null,
  });

  if (!customerId) {
    return json({
      ok: true,
      allowed: false,
      protected: true,
      reason: "no_customer",
      collectionHandle,
      productHandle,
      customerId: null,
    });
  }

  const customerGid = buildCustomerGid(customerId);
  const linkedPortalUser = await findPortalUserForCustomer(shop, customerGid, "");
  if (linkedPortalUser?.id) {
    const { instituteKey, institute } = resolvePortalUserInstitute(linkedPortalUser);
    const allowed = Boolean(institute);

    return json({
      ok: true,
      allowed,
      protected: true,
      reason: allowed ? "allowed" : "no_institute",
      collectionHandle,
      productHandle,
      customerId,
      instituteKey: instituteKey || null,
      instituteLabel: institute?.label || null,
    });
  }

  let admin;
  try {
    ({ admin } = await resolveAdminClient(shop));
  } catch (error) {
    return json(
      {
        ok: false,
        allowed: false,
        error: "Unable to access Shopify Admin for bundle access checks.",
        detail: errorMessage(error),
      },
      { status: 401 },
    );
  }

  try {
    const { portalUser, instituteKey, institute } = await getCustomerBundleAccessProfile(
      admin,
      shop,
      customerGid,
    );
    const allowed = Boolean(institute);

    return json({
      ok: true,
      allowed,
      protected: true,
      reason: allowed ? "allowed" : portalUser?.id ? "no_institute" : "profile_not_found",
      collectionHandle,
      productHandle,
      customerId,
      instituteKey: instituteKey || null,
      instituteLabel: institute?.label || null,
    });
  } catch (error) {
    return json(
      {
        ok: false,
        allowed: false,
        error: "Failed to evaluate bundle access.",
        detail: errorMessage(error),
        collectionHandle,
        productHandle,
        customerId,
      },
      { status: 500 },
    );
  }
}

export async function loader({ request }: { request: Request }) {
  return handle(request);
}

export async function action({ request }: { request: Request }) {
  return handle(request);
}
