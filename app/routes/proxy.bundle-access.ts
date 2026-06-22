import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  errorMessage,
  json,
  normalizeShopDomain,
  resolveAdminClient,
  runAdminGraphql,
} from "../student-discount.server";
import { getInstituteByEmail, getInstituteByLabel } from "../institutes";
import { buildCustomerGid, linkPortalUserToCustomer } from "../portal-user-links.server";
import { setCustomerPortalProfileMetafields } from "../customer-profile-metafields.server";

type GraphqlClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

const BISR_COLLECTION_HANDLES = new Set(["bundle", "all-bundles"]);
const BISR_PRODUCT_HANDLES = new Set(["primary-years-bundle"]);
const BISR_INSTITUTE_KEY = "bisr";

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
          metafield(namespace: "$app:student-discount", key: "institute_key") {
            value
          }
        }
      }
    `,
    { id: customerId },
  );

  return data?.customer || null;
}

async function getCustomerInstituteKey(admin: GraphqlClient, shop: string, customerGid: string) {
  const customer = await fetchCustomerIdentity(admin, customerGid);
  const existingKey = String(customer?.metafield?.value || "").trim();
  if (existingKey) return existingKey;

  const email = normalizeEmail(customer?.email);
  if (!email) return "";

  const portalUser = await prisma.portalUser.findFirst({
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

  const instituteKey =
    getInstituteByLabel(portalUser?.institute || "")?.key ||
    getInstituteByEmail(portalUser?.schoolEmail || "")?.key ||
    getInstituteByEmail(portalUser?.email || "")?.key ||
    getInstituteByEmail(email)?.key ||
    "";

  if (!instituteKey || !customer?.id) {
    return "";
  }

  if (portalUser?.id) {
    try {
      await linkPortalUserToCustomer({
        shop,
        portalUserId: portalUser.id,
        customerGid: customer.id,
      });
    } catch (linkError) {
      console.warn("[bundle-access] failed to link portal user to customer:", errorMessage(linkError));
    }
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

  if (portalUser?.id) {
    try {
      await setCustomerPortalProfileMetafields(admin, customer.id, portalUser);
    } catch (profileError) {
      console.warn("[bundle-access] failed to persist customer profile metafields:", errorMessage(profileError));
    }
  }

  return instituteKey;
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

  if (!customerId) {
    return json({
      ok: true,
      allowed: false,
      protected: true,
      reason: "no_customer",
      collectionHandle,
      productHandle,
      customerId: null,
      requiredInstituteKey: BISR_INSTITUTE_KEY,
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
    const instituteKey = await getCustomerInstituteKey(admin, shop, buildCustomerGid(customerId));
    const allowed = instituteKey === BISR_INSTITUTE_KEY;

    return json({
      ok: true,
      allowed,
      protected: true,
      reason: allowed ? "allowed" : "not_allowed",
      collectionHandle,
      productHandle,
      customerId,
      instituteKey: instituteKey || null,
      requiredInstituteKey: BISR_INSTITUTE_KEY,
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
        requiredInstituteKey: BISR_INSTITUTE_KEY,
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
