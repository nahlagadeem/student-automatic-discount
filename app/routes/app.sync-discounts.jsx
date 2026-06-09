import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
import {
  ensureAutomaticDiscountConfigTable,
  syncAutomaticDiscountRules,
  syncErrorMessage,
  syncPortalUsersToCustomerTags,
} from "../discount-function-config.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  try {
    await ensureAutomaticDiscountRuleTable();
    await ensureAutomaticDiscountConfigTable();

    const rules = await prisma.automaticDiscountRule.findMany({
      where: { shop: session.shop },
      orderBy: [{ instituteLabel: "asc" }, { categoryLabel: "asc" }],
    });

    const portalSyncResult = await syncPortalUsersToCustomerTags({
      admin,
      shop: session.shop,
      rules,
    });
    const syncResult = await syncAutomaticDiscountRules({
      admin,
      shop: session.shop,
      rules,
    });

    return {
      ok: true,
      shop: session.shop,
      syncResult,
      portalSyncResult,
    };
  } catch (error) {
    return {
      ok: false,
      shop: session.shop,
      error: syncErrorMessage(error),
    };
  }
};

export default function SyncDiscounts() {
  const data = useLoaderData();

  return (
    <s-page heading="Discount Sync">
      <s-section heading={data.ok ? "Sync complete" : "Sync failed"}>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            <code>{JSON.stringify(data, null, 2)}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}
