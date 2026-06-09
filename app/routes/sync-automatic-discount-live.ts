import prisma from "../db.server";
import {
  ensureAutomaticDiscountConfigTable,
  syncAutomaticDiscountRules,
  syncErrorMessage,
  syncPortalUsersToCustomerTags,
} from "../discount-function-config.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
import { resolveAdminClient } from "../student-discount.server";

const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};

const env =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

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
    const withProtocol =
      trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`;
    return new URL(withProtocol).hostname.trim().toLowerCase();
  } catch {
    return trimmed.replace(/^https?:\/\//, "").split("/")[0].trim().toLowerCase();
  }
}

async function handle(request: Request) {
  const url = new URL(request.url);
  const liveShop = normalizeShopDomain(env.LIVE_SHOP_DOMAIN);
  const requestedShop = normalizeShopDomain(url.searchParams.get("shop"));
  const shop = requestedShop || liveShop;

  if (!shop) {
    return json({ ok: false, error: "Missing shop parameter." }, { status: 400 });
  }

  try {
    await ensureAutomaticDiscountRuleTable();
    await ensureAutomaticDiscountConfigTable();

    const rules = await prisma.automaticDiscountRule.findMany({
      where: { shop },
      orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
    });

    const { admin } = await resolveAdminClient(shop);
    const portalSyncResult = await syncPortalUsersToCustomerTags({ admin, shop, rules });
    const syncResult = await syncAutomaticDiscountRules({ admin, shop, rules });

    return json({ ok: true, shop, syncResult, portalSyncResult });
  } catch (error) {
    return json(
      {
        ok: false,
        shop,
        error: syncErrorMessage(error),
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
