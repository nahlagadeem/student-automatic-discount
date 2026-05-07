import { authenticate } from "../shopify.server";
import db from "../db.server";
import { buildCustomerGid, buildLegacyCustomerId } from "../portal-user-links.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  const customerId = buildLegacyCustomerId(payload?.id);
  const customerGid = buildCustomerGid(payload?.admin_graphql_api_id || payload?.id);

  if (!customerId && !customerGid) {
    return new Response();
  }

  await db.studentDiscount.deleteMany({
    where: {
      shop,
      ...(customerId ? { customerId } : { customerId: "__unmatched__" }),
    },
  });

  const customerLink = await db.portalUserCustomerLink.findFirst({
    where: {
      shop,
      OR: [
        ...(customerId ? [{ customerId }] : []),
        ...(customerGid ? [{ customerGid }] : []),
      ],
    },
    select: {
      id: true,
      portalUserId: true,
    },
  });

  if (!customerLink) {
    return new Response();
  }

  await db.portalUserCustomerLink.delete({
    where: { id: customerLink.id },
  });

  const remainingLinks = await db.portalUserCustomerLink.count({
    where: { portalUserId: customerLink.portalUserId },
  });

  if (remainingLinks === 0) {
    await db.portalUser.delete({
      where: { id: customerLink.portalUserId },
    });
  }

  return new Response();
};
