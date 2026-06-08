import {
  createShopifyCodeDiscount,
  deleteShopifyDiscountCode,
  deleteStudentDiscountRow,
  ensureStudentDiscountTable,
  errorMessage,
  findDiscountNodeIdByCode,
  findStudentDiscount,
  isStudentCodeAppDiscount,
  json,
  normalizeShopDomain,
  resolveAdminClient,
  upsertStudentDiscount,
} from "../student-discount.server";
import { buildCustomerGid } from "../portal-user-links.server";
import { authenticate } from "../shopify.server";

function buildCustomerId(url: URL) {
  return String(url.searchParams.get("customerId") || url.searchParams.get("logged_in_customer_id") || "").trim();
}

async function handle(request: Request) {
  console.log("[create-discount-live] HIT", new Date().toISOString(), request.method, request.url);

  const url = new URL(request.url);
  const liveShop = normalizeShopDomain((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LIVE_SHOP_DOMAIN);
  const requestedShop = normalizeShopDomain(url.searchParams.get("shop"));
  const shop = requestedShop || liveShop;
  const customerId = buildCustomerId(url);
  let proxyVerified = false;

  try {
    await authenticate.public.appProxy(request);
    proxyVerified = true;
  } catch (e) {
    console.warn("[create-discount-live] appProxy signature invalid, continuing as direct request:", errorMessage(e));
  }

  if (!shop) {
    return json({ ok: false, error: "Missing shop parameter." }, { status: 400 });
  }

  let admin;
  let via = "offline_session";
  try {
    ({ admin, via } = await resolveAdminClient(shop));
  } catch (e) {
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
      { status: 401 },
    );
  }

  await ensureStudentDiscountTable();

  if (!customerId) {
    return json(
      {
        ok: false,
        error: "Missing customer id for discount eligibility. The discount can no longer be created for all customers.",
      },
      { status: 400 },
    );
  }

  const existing = await findStudentDiscount(shop, customerId);
  if (existing) {
    const storedCode = String(existing.code || "").trim();
    const storedDiscountNodeId = String(existing.shopifyDiscountId || existing.discountNodeId || "").trim();
    const liveDiscountNodeId = storedCode ? await findDiscountNodeIdByCode(admin, storedCode) : "";

    if (liveDiscountNodeId) {
      const isCompatibleCode = await isStudentCodeAppDiscount(admin, liveDiscountNodeId);
      if (!isCompatibleCode) {
        console.warn("[create-discount-live] replacing legacy basic discount code with app discount code", {
          shop,
          customerId,
          code: storedCode,
          discountNodeId: liveDiscountNodeId,
        });

        await deleteShopifyDiscountCode(admin, liveDiscountNodeId);
        const recreated = await createShopifyCodeDiscount(admin, storedCode, [buildCustomerGid(customerId)]);
        await upsertStudentDiscount({
          shop,
          customerId,
          code: recreated.code,
          discountNodeId: recreated.discountNodeId,
        });

        return json({
          ok: true,
          migrated: true,
          code: recreated.code,
          discountNodeId: recreated.discountNodeId,
          customerId,
          via,
          proxyVerified,
        });
      }

      if (liveDiscountNodeId !== storedDiscountNodeId) {
        await upsertStudentDiscount({
          shop,
          customerId,
          code: storedCode,
          discountNodeId: liveDiscountNodeId,
        });
      }

      return json({
        ok: true,
        reused: true,
        code: storedCode,
        discountNodeId: liveDiscountNodeId || storedDiscountNodeId,
        customerId,
        via,
        proxyVerified,
      });
    }

    console.warn("[create-discount-live] stale local discount row found; Shopify code was already deleted manually", {
      shop,
      customerId,
      code: storedCode,
      discountNodeId: storedDiscountNodeId || null,
    });

    await deleteStudentDiscountRow({
      shop,
      customerId,
    });
  }

  const code = `STUDENT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

  try {
    const customerGid = buildCustomerGid(customerId);
    const created = await createShopifyCodeDiscount(admin, code, [customerGid]);

    await upsertStudentDiscount({
      shop,
      customerId,
      code: created.code,
      discountNodeId: created.discountNodeId,
    });

    return json({
      ok: true,
      code: created.code,
      discountNodeId: created.discountNodeId,
      customerId: customerId || null,
      via,
      proxyVerified,
    });
  } catch (e) {
    console.error("[create-discount-live] graphql exception:", e);
    const errorInfo = e as { status?: unknown; body?: unknown; userErrors?: unknown[] };
    const status = Number(errorInfo?.status);
    const body = errorInfo?.body ?? null;
    const userErrors = errorInfo?.userErrors ?? [];

    return json(
      {
        ok: false,
        error: "Failed to create discount code.",
        detail: errorMessage(e),
        body,
        userErrors,
      },
      { status: Number.isFinite(status) && status >= 400 ? status : 502 },
    );
  }
}

export async function loader({ request }: { request: Request }) {
  return handle(request);
}

export async function action({ request }: { request: Request }) {
  return handle(request);
}
