import { useLoaderData } from "react-router";
import prisma from "../db.server";
import { ensureAutomaticDiscountRuleTable } from "../automatic-discount-rules.server";
import {
  ensureAutomaticDiscountConfigTable,
  syncAutomaticDiscountRules,
  syncPortalUsersToCustomerTags,
  syncErrorMessage,
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

    const syncResult = await syncAutomaticDiscountRules({
      admin,
      shop: session.shop,
      rules,
      forceRebuild: true,
    });
    const portalSyncResult = await syncPortalUsersToCustomerTags({
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

export default function RebuildNeoOffer() {
  const data = useLoaderData();

  return (
    <s-page heading="Rebuild Neo Offer">
      <s-section heading={data.ok ? "Rebuild complete" : "Rebuild failed"}>
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
            <code>{JSON.stringify(data, null, 2)}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}
