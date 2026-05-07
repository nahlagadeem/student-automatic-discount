import prisma from "./db.server";

function normalizeShop(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeCustomerGid(value) {
  const gid = String(value || "").trim();
  return gid.startsWith("gid://shopify/Customer/") ? gid : "";
}

function normalizeLegacyCustomerId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return raw;

  const gid = normalizeCustomerGid(raw);
  if (!gid) return "";

  const parts = gid.split("/");
  const legacyId = parts[parts.length - 1] || "";
  return /^\d+$/.test(legacyId) ? legacyId : "";
}

export function buildCustomerGid(value) {
  const gid = normalizeCustomerGid(value);
  if (gid) return gid;

  const legacyId = normalizeLegacyCustomerId(value);
  return legacyId ? `gid://shopify/Customer/${legacyId}` : "";
}

export function buildLegacyCustomerId(value) {
  return normalizeLegacyCustomerId(value);
}

export async function linkPortalUserToCustomer({ shop, portalUserId, customerId, customerGid }) {
  const normalizedShop = normalizeShop(shop);
  const normalizedCustomerId = buildLegacyCustomerId(customerId || customerGid);
  const normalizedCustomerGid = buildCustomerGid(customerGid || customerId);

  if (!normalizedShop || !portalUserId || (!normalizedCustomerId && !normalizedCustomerGid)) {
    return null;
  }

  const where = normalizedCustomerId
    ? {
        shop_customerId: {
          shop: normalizedShop,
          customerId: normalizedCustomerId,
        },
      }
    : {
        shop_customerGid: {
          shop: normalizedShop,
          customerGid: normalizedCustomerGid,
        },
      };

  return prisma.portalUserCustomerLink.upsert({
    where,
    update: {
      portalUserId,
      customerId: normalizedCustomerId,
      customerGid: normalizedCustomerGid || null,
    },
    create: {
      shop: normalizedShop,
      portalUserId,
      customerId: normalizedCustomerId,
      customerGid: normalizedCustomerGid || null,
    },
  });
}
