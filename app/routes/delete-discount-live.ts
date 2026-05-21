import {
  deleteShopifyDiscountCode,
  deleteStudentDiscountRow,
  ensureStudentDiscountTable,
  errorMessage,
  findDiscountNodeIdByCode,
  findStudentDiscount,
  json,
  normalizeShopDomain,
  resolveAdminClient,
} from "../student-discount.server";
import { authenticate } from "../shopify.server";

function readShop(requestUrl: URL) {
  return normalizeShopDomain(requestUrl.searchParams.get("shop"));
}

function readCustomerId(requestUrl: URL, formData: FormData | null) {
  return String(
    requestUrl.searchParams.get("customerId") ||
      requestUrl.searchParams.get("logged_in_customer_id") ||
      formData?.get("customerId") ||
      formData?.get("logged_in_customer_id") ||
      "",
  ).trim();
}

function readCode(requestUrl: URL, formData: FormData | null) {
  return String(requestUrl.searchParams.get("code") || formData?.get("code") || "").trim();
}

function readDiscountNodeId(requestUrl: URL, formData: FormData | null) {
  return String(
    requestUrl.searchParams.get("discountNodeId") ||
      requestUrl.searchParams.get("shopifyDiscountId") ||
      formData?.get("discountNodeId") ||
      formData?.get("shopifyDiscountId") ||
      "",
  ).trim();
}

async function handle(request: Request) {
  console.log("[delete-discount-live] HIT", new Date().toISOString(), request.method, request.url);

  const url = new URL(request.url);
  let formData: FormData | null = null;

  if (request.method !== "GET") {
    try {
      formData = await request.formData();
    } catch {
      formData = null;
    }
  }

  const requestedShop = readShop(url);
  const liveShop = normalizeShopDomain(
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.LIVE_SHOP_DOMAIN,
  );
  const shop = requestedShop || liveShop;
  const customerId = readCustomerId(url, formData);
  const code = readCode(url, formData);
  const providedDiscountNodeId = readDiscountNodeId(url, formData);

  try {
    await authenticate.public.appProxy(request);
  } catch (error) {
    console.warn("[delete-discount-live] appProxy signature invalid, continuing as direct request:", errorMessage(error));
  }

  if (!shop) {
    return json({ ok: false, error: "Missing shop parameter." }, { status: 400 });
  }

  let admin;
  try {
    ({ admin } = await resolveAdminClient(shop));
  } catch (error) {
    return json(
      {
        ok: false,
        error: "Unable to access Shopify Admin for discount deletion.",
        detail: errorMessage(error),
      },
      { status: 401 },
    );
  }

  await ensureStudentDiscountTable();

  const localRow = customerId ? await findStudentDiscount(shop, customerId) : null;
  const localDiscountNodeId =
    providedDiscountNodeId ||
    String(localRow?.shopifyDiscountId || localRow?.discountNodeId || "").trim() ||
    (code ? await findDiscountNodeIdByCode(admin, code) : "");

  if (!localRow && !localDiscountNodeId) {
    return json({ ok: false, error: "Discount record not found." }, { status: 404 });
  }

  try {
    if (localDiscountNodeId) {
      const result = await deleteShopifyDiscountCode(admin, localDiscountNodeId);
      console.log("[delete-discount-live] Shopify delete response:", {
        shop,
        customerId: customerId || null,
        code: code || null,
        localDiscountNodeId,
        result,
      });
    } else {
      console.warn("[delete-discount-live] Shopify discount id missing; deleting local row only", {
        shop,
        customerId: customerId || null,
        code: code || null,
      });
    }
  } catch (error) {
    const message = errorMessage(error);
    if (!/not found|invalid id|does not exist/i.test(message)) {
      console.error("[delete-discount-live] Shopify delete failed:", message);
      return json(
        {
          ok: false,
          error: "Failed to delete Shopify discount.",
          detail: message,
          userErrors: (error && typeof error === "object" && "userErrors" in error ? (error as { userErrors?: unknown[] }).userErrors : []) ?? [],
        },
        { status: 502 },
      );
    }

    console.warn("[delete-discount-live] Shopify discount already missing; cleaning local record only:", {
      shop,
      customerId: customerId || null,
      code: code || null,
      detail: message,
    });
  }

  await deleteStudentDiscountRow({
    shop,
    customerId: customerId || undefined,
    code: code || undefined,
    discountNodeId: localDiscountNodeId || undefined,
    shopifyDiscountId: localDiscountNodeId || undefined,
  });

  return json({
    ok: true,
    deleted: true,
    shop,
    customerId: customerId || null,
    code: code || null,
    discountNodeId: localDiscountNodeId || null,
  });
}

export async function loader({ request }: { request: Request }) {
  return handle(request);
}

export async function action({ request }: { request: Request }) {
  return handle(request);
}
