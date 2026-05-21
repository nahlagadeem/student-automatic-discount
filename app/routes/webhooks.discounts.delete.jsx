import { authenticate } from "../shopify.server";
import db from "../db.server";
import { ensureAutomaticDiscountConfigTable, syncAutomaticDiscountRules } from "../discount-function-config.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
import { unauthenticated } from "../shopify.server";

async function resolveAdmin(shop) {
  try {
    const { admin } = await unauthenticated.admin(shop);
    return admin;
  } catch {
    return null;
  }
}

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await ensureAutomaticDiscountRuleTable();
  await ensureAutomaticDiscountConfigTable();

  await db.automaticDiscountConfig.deleteMany({
    where: { shop },
  });

  const admin = await resolveAdmin(shop);
  if (admin) {
    const rules = await db.automaticDiscountRule.findMany({
      where: { shop },
      orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
    });

    try {
      await syncAutomaticDiscountRules({ admin, shop, rules });
    } catch (error) {
      console.warn("[webhooks.discounts.delete] resync failed:", error instanceof Error ? error.message : String(error));
    }
  }

  return new Response();
};
