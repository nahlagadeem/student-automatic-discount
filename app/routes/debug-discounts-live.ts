import { errorMessage, normalizeShopDomain, resolveAdminClient } from "../student-discount.server";

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(init.headers ?? {}),
    },
  });
}

function parseGraphqlPayload(payloadText: string) {
  try {
    return JSON.parse(payloadText);
  } catch {
    return null;
  }
}

async function runAdminGraphql(admin: { graphql: Function }, query: string, variables?: Record<string, unknown>) {
  const response = await admin.graphql(query, { variables });
  const payloadText = await response.text();
  const payload = parseGraphqlPayload(payloadText);

  if (!response.ok) {
    throw new Error(`Admin API HTTP ${response.status}: ${payloadText}`);
  }

  if (payload?.errors?.length) {
    throw new Error(payload.errors.map((error: { message?: string }) => error.message).join("; "));
  }

  return payload?.data ?? null;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const shop = normalizeShopDomain(url.searchParams.get("shop")) || "7shdka-4d.myshopify.com";

  try {
    const { admin } = await resolveAdminClient(shop);
    const data = await runAdminGraphql(
      admin,
      `#graphql
        query DebugDiscounts($query: String!) {
          discountNodes(first: 50, query: $query) {
            nodes {
              id
              metafield(namespace: "$app:category-tier-discount-native", key: "function-configuration") {
                value
              }
              discount {
                __typename
                ... on DiscountAutomaticApp {
                  title
                  status
                  startsAt
                  endsAt
                  combinesWith {
                    productDiscounts
                    orderDiscounts
                    shippingDiscounts
                  }
                  appDiscountType {
                    functionId
                  }
                }
                ... on DiscountCodeApp {
                  title
                  status
                  combinesWith {
                    productDiscounts
                    orderDiscounts
                    shippingDiscounts
                  }
                  appDiscountType {
                    functionId
                  }
                  codes(first: 5) {
                    nodes {
                      code
                    }
                  }
                }
              }
            }
          }
        }
      `,
      {
        query: "method:automatic OR method:code",
      },
    );

    return json({ ok: true, shop, data });
  } catch (error: unknown) {
    return json({ ok: false, shop, error: errorMessage(error) }, { status: 500 });
  }
}
