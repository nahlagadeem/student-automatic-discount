import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  let authenticated = true;
  try {
    await authenticate.admin(request);
  } catch {
    authenticated = false;
  }

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", authenticated };
};

export default function App() {
  const { apiKey, authenticated } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      {authenticated ? (
        <s-app-nav>
          <s-link href="/app">Home</s-link>
          <s-link href="/app/bundle-visibility">Bundle visibility</s-link>
          <s-link href="/app/sync-discounts">Sync discounts</s-link>
          <s-link href="/app/rebuild-neo-offer">Rebuild Neo offer</s-link>
          <s-link href="/app/additional">Additional page</s-link>
          <s-link href="/app/debug/portal-users">Portal user debug</s-link>
        </s-app-nav>
      ) : null}
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
