import prisma from "../db.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
import { CATEGORY_COLLECTION_IDS } from "../institutes";
import { authenticate, unauthenticated } from "../shopify.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

type GraphqlClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

type ProductNode = {
  handle?: string | null;
  title?: string | null;
  collections?: {
    nodes?: { id?: string | null }[];
  } | null;
};

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function normalizeShopDomain(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = String(input).trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const withProtocol =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`;
    return new URL(withProtocol).hostname.trim().toLowerCase();
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0].trim().toLowerCase();
  }
}

function normalizeHandle(input: string): string {
  return String(input || "").trim().toLowerCase();
}

function parseGraphqlPayload(payloadText: string) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

async function runAdminGraphql(admin: GraphqlClient, query: string, variables?: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const payloadText = await response.text();
  const payload = parseGraphqlPayload(payloadText);

  if (!response.ok) {
    throw new Error(`Admin API HTTP ${response.status}: ${payloadText}`);
  }

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error: { message?: string }) => error.message).join("; "));
  }

  return payload?.data ?? null;
}

async function resolveAdminClient(shop: string): Promise<{ admin: GraphqlClient; via: string }> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    return { admin, via: "offline_session" };
  } catch (error: unknown) {
    const offlineSession = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    const accessToken = String(offlineSession?.accessToken || "").trim();

    if (!accessToken) {
      throw new Error(
        `No offline session for ${shop}. Open the app in Shopify Admin and reinstall if needed. ${errorMessage(error)}`,
      );
    }

    return {
      via: "session_token",
      admin: {
        graphql: async (query: string, opts: { variables?: Record<string, unknown> } = {}) =>
          fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": accessToken,
            },
            body: JSON.stringify({ query, variables: opts.variables ?? {} }),
          }),
      },
    };
  }
}

async function getCustomerInstituteKey(admin: GraphqlClient, customerId: string) {
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query GetCustomerInstitute($id: ID!) {
        customer(id: $id) {
          id
          metafield(namespace: "$app:student-discount", key: "institute_key") {
            value
          }
        }
      }
    `,
    { id: customerId },
  );

  return String(data?.customer?.metafield?.value || "").trim();
}

function buildCustomerGid(rawCustomerId: string | null) {
  const value = String(rawCustomerId || "").trim();
  if (!value) return "";
  if (value.startsWith("gid://")) return value;
  if (!/^\d+$/.test(value)) return "";
  return `gid://shopify/Customer/${value}`;
}

async function getProductCollectionMap(admin: GraphqlClient, handles: string[]) {
  const normalizedHandles = Array.from(new Set(handles.map(normalizeHandle).filter(Boolean))).slice(0, 40);
  if (!normalizedHandles.length) {
    return new Map<string, Set<string>>();
  }

  const query = normalizedHandles.map((handle) => `handle:${JSON.stringify(handle)}`).join(" OR ");
  const data = await runAdminGraphql(
    admin,
    `#graphql
      query GetProductsForStudentPricing($query: String!) {
        products(first: 40, query: $query) {
          nodes {
            handle
            title
            collections(first: 25) {
              nodes {
                id
              }
            }
          }
        }
      }
    `,
    { query },
  );

  const map = new Map<string, Set<string>>();
  for (const product of (data?.products?.nodes ?? []) as ProductNode[]) {
    const handle = normalizeHandle(String(product?.handle || ""));
    if (!handle) continue;
    const collections = new Set(
      (product?.collections?.nodes ?? [])
        .map((collection) => String(collection?.id || "").trim())
        .filter(Boolean),
    );
    map.set(handle, collections);
  }

  return map;
}

function getMatchingCategoryPercentage(
  productCollectionIds: Set<string>,
  rules: { categoryKey: string; percentage: number }[],
) {
  let maxPercentage = 0;

  for (const rule of rules) {
    const collectionId = CATEGORY_COLLECTION_IDS[rule.categoryKey as keyof typeof CATEGORY_COLLECTION_IDS];
    if (!collectionId) continue;
    if (productCollectionIds.has(collectionId)) {
      maxPercentage = Math.max(maxPercentage, Number(rule.percentage) || 0);
    }
  }

  return maxPercentage;
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const liveShop = normalizeShopDomain(env.LIVE_SHOP_DOMAIN);
  const requestedShop = normalizeShopDomain(url.searchParams.get("shop"));
  const shop = requestedShop || liveShop;

  let proxyVerified = false;
  try {
    await authenticate.public.appProxy(request);
    proxyVerified = true;
  } catch (error: unknown) {
    console.warn("[student-pricing-live] appProxy signature invalid, continuing as direct request:", errorMessage(error));
  }

  if (!shop) {
    return json({ ok: false, error: "Missing shop parameter." }, { status: 400 });
  }

  await ensureAutomaticDiscountRuleTable();

  const handles = String(url.searchParams.get("handles") || "")
    .split(",")
    .map(normalizeHandle)
    .filter(Boolean);

  if (!handles.length) {
    return json({ ok: true, byHandle: {}, eligible: false, reason: "no_handles", proxyVerified });
  }

  const customerGid = buildCustomerGid(url.searchParams.get("logged_in_customer_id"));
  if (!customerGid) {
    return json({ ok: true, byHandle: {}, eligible: false, reason: "no_customer", proxyVerified });
  }

  let admin: GraphqlClient;
  let via = "offline_session";
  try {
    ({ admin, via } = await resolveAdminClient(shop));
  } catch (error: unknown) {
    return json(
      {
        ok: false,
        error: "Unable to access Shopify Admin for storefront pricing.",
        detail: errorMessage(error),
      },
      { status: 401 },
    );
  }

  try {
    const instituteKey = await getCustomerInstituteKey(admin, customerGid);
    if (!instituteKey) {
      return json({
        ok: true,
        byHandle: {},
        eligible: false,
        reason: "no_institute",
        proxyVerified,
        via,
      });
    }

    const rules = await prisma.automaticDiscountRule.findMany({
      where: {
        shop,
        instituteKey,
        isActive: true,
        percentage: { gt: 0 },
      },
      select: {
        categoryKey: true,
        percentage: true,
      },
    });

    if (!rules.length) {
      return json({
        ok: true,
        byHandle: {},
        eligible: false,
        reason: "no_rules",
        instituteKey,
        proxyVerified,
        via,
      });
    }

    const collectionsByHandle = await getProductCollectionMap(admin, handles);
    const byHandle = Object.fromEntries(
      handles.map((handle) => {
        const percentage = getMatchingCategoryPercentage(
          collectionsByHandle.get(handle) ?? new Set<string>(),
          rules,
        );

        return [
          handle,
          {
            percentage,
            eligible: percentage > 0,
          },
        ];
      }),
    );

    return json({
      ok: true,
      instituteKey,
      eligible: Object.values(byHandle).some((entry) => Boolean((entry as { eligible?: boolean }).eligible)),
      byHandle,
      proxyVerified,
      via,
    });
  } catch (error: unknown) {
    return json(
      {
        ok: false,
        error: "Failed to calculate storefront student pricing.",
        detail: errorMessage(error),
      },
      { status: 502 },
    );
  }
}

export async function loader({ request }: { request: Request }) {
  return handle(request);
}
