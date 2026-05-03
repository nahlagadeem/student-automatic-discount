import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

type GraphqlClient = {
  graphql: (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) },
  });
}

function normalizeShopDomain(input: string | null | undefined): string {
  if (!input) return "";
  const trimmed = String(input).trim().toLowerCase();
  if (!trimmed) return "";
  try {
    const withProtocol = trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).hostname.trim().toLowerCase();
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0].trim().toLowerCase();
  }
}

async function handle(request: Request) {
  console.log("[create-discount-live] HIT", new Date().toISOString(), request.method, request.url);

  const url = new URL(request.url);
  const liveShop = normalizeShopDomain(env.LIVE_SHOP_DOMAIN);
  const requestedShop = normalizeShopDomain(url.searchParams.get("shop"));
  const shop = requestedShop || liveShop;
  let proxyVerified = false;
  try {
    await authenticate.public.appProxy(request);
    proxyVerified = true;
  } catch (e: unknown) {
    console.warn("[create-discount-live] appProxy signature invalid, continuing as direct request:", errorMessage(e));
  }

  if (!shop) {
    return json({ ok: false, error: "Missing shop parameter." }, { status: 400 });
  }

  let admin: GraphqlClient;
  let via: "offline_session" | "session_token" = "offline_session";
  try {
    ({ admin } = await unauthenticated.admin(shop));
  } catch (e: unknown) {
    const offlineSession = await prisma.session.findFirst({
      where: { shop, isOnline: false },
    });
    const sessionAccessToken = (offlineSession?.accessToken || "").trim();

    if (sessionAccessToken) {
      via = "session_token";
      admin = {
        graphql: async (query: string, opts: { variables?: Record<string, unknown> } = {}) =>
          fetch(`https://${shop}/admin/api/2026-01/graphql.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": sessionAccessToken,
            },
            body: JSON.stringify({ query, variables: opts?.variables ?? {} }),
          }),
      };
    } else {
      console.error("[create-discount-live] no usable offline session token", {
        shop,
        liveShop,
        detail: errorMessage(e),
      });
      return json(
        {
          ok: false,
          error: "No offline session for this shop. Open the app once in Shopify Admin and reinstall if needed, then retry.",
        },
        { status: 401 }
      );
    }
  }

  const code = `STUDENT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  try {
    const result = await admin.graphql(
      `
        mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
            codeDiscountNode { id }
            userErrors { field message }
          }
        }
      `,
      {
        variables: {
          basicCodeDiscount: {
            title: `Student Discount ${code}`,
            code,
            startsAt: new Date().toISOString(),
            customerSelection: { all: true },
            customerGets: {
              value: { percentage: 0.5 },
              items: { all: true },
            },
            usageLimit: 1,
          },
        },
      }
    );

    const bodyText = await result.text();
    let body: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    } catch {
      body = null;
    }

    if (!result.ok) {
      const status = result.status >= 400 && result.status < 500 ? result.status : 502;
      return json({ ok: false, error: "Admin API HTTP error", status: result.status, body: body ?? bodyText }, { status });
    }

    const userErrors =
      (body as { data?: { discountCodeBasicCreate?: { userErrors?: unknown[] } } } | null)?.data
        ?.discountCodeBasicCreate?.userErrors ?? [];
    if (userErrors.length) {
      return json({ ok: false, userErrors }, { status: 400 });
    }

    return json({ ok: true, code, via, proxyVerified });
  } catch (e: unknown) {
    console.error("[create-discount-live] graphql exception:", e);
    return json({ ok: false, error: "Failed to create discount code.", detail: errorMessage(e) }, { status: 502 });
  }
}

export async function loader({ request }: { request: Request }) {
  return handle(request);
}

export async function action({ request }: { request: Request }) {
  return handle(request);
}

