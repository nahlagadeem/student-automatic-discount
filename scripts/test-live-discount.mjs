import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function loadDotEnv() {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(thisDir, "..", ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const shop = (process.env.LIVE_SHOP_DOMAIN || "").trim();
const token = (process.env.SHOPIFY_ADMIN_TOKEN || process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN || "").trim();
const liveAppUrl = (process.env.LIVE_APP_URL || "https://student-automatic-discount.onrender.com").trim().replace(/\/$/, "");

if (!shop) {
  console.error("Missing LIVE_SHOP_DOMAIN in environment.");
  process.exit(1);
}

async function testViaAdminToken() {
  if (!token) return { ok: false, reason: "missing-token" };

  const code = `STUDENT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const query = `
    mutation discountCodeBasicCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
      discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
        codeDiscountNode { id }
        userErrors { field message }
      }
    }
  `;

  const variables = {
    basicCodeDiscount: {
      title: `Student Discount ${code}`,
      code,
      startsAt: new Date().toISOString(),
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: 0.1 },
        items: { all: true },
      },
      usageLimit: 1,
    },
  };

  const endpoint = `https://${shop}/admin/api/2026-01/graphql.json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) return { ok: false, reason: "admin-http", status: response.status, body };

  const userErrors = body?.data?.discountCodeBasicCreate?.userErrors ?? [];
  if (userErrors.length > 0) return { ok: false, reason: "admin-user-errors", userErrors };

  const id = body?.data?.discountCodeBasicCreate?.codeDiscountNode?.id;
  return { ok: true, via: "admin-token", shop, code, id };
}

async function testViaLiveRoute() {
  const url = `${liveAppUrl}/create-discount?shop=${encodeURIComponent(shop)}`;
  const response = await fetch(url);
  const body = await response.json().catch(() => null);

  if (!response.ok) return { ok: false, reason: "live-route-http", status: response.status, body };
  if (!body?.ok) return { ok: false, reason: "live-route-failed", body };

  return { ok: true, via: "live-route", shop, code: body?.code, detail: body };
}

const adminResult = await testViaAdminToken();
if (adminResult.ok) {
  console.log(JSON.stringify(adminResult, null, 2));
  process.exit(0);
}

if (adminResult.reason === "admin-http" && adminResult.status === 401) {
  const liveResult = await testViaLiveRoute();
  if (liveResult.ok) {
    console.log(JSON.stringify({ ok: true, fallbackUsed: true, adminResult, liveResult }, null, 2));
    process.exit(0);
  }
  console.error("Admin token is unauthorized and live route fallback failed:", { adminResult, liveResult });
  process.exit(2);
}

if (adminResult.reason === "missing-token") {
  const liveResult = await testViaLiveRoute();
  if (liveResult.ok) {
    console.log(JSON.stringify({ ok: true, fallbackUsed: true, liveResult }, null, 2));
    process.exit(0);
  }
  console.error("Missing admin token and live route fallback failed:", liveResult);
  process.exit(1);
}

console.error("Live discount test failed:", adminResult);
process.exit(3);
