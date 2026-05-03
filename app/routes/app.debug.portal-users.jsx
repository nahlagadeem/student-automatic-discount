import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  try {
    const portalUserCount = await prisma.portalUser.count();
    const recentUsers = await prisma.portalUser.findMany({
      take: 10,
      orderBy: { id: "desc" },
      select: {
        id: true,
        email: true,
        schoolEmail: true,
        institute: true,
        role: true,
        createdAt: true,
      },
    });

    return {
      ok: true,
      portalUserCount,
      recentUsers,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown database error",
    };
  }
};

export default function DebugPortalUsersPage() {
  const data = useLoaderData();

  return (
    <s-page heading="Portal User Debug">
      <s-section heading="Shared database check">
        <s-paragraph>
          This page verifies whether the app can read registration users from the shared database.
        </s-paragraph>
      </s-section>

      <s-section heading="Result">
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <pre style={{ margin: 0 }}>
            <code>{JSON.stringify(data, null, 2)}</code>
          </pre>
        </s-box>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
