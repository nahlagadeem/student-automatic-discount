# AI Shared Context (Shopify + Render)

## Project Overview
- Project name: `student-automatic-discount`
- Repo path: `C:\Windows\System32\student-automatic-discount`
- Git remote: `https://github.com/nahlagadeem/student-automatic-discount.git`
- Primary branch: `main`
- Live store: `7shdka-4d.myshopify.com`
- Live app URL: `https://student-automatic-discount.onrender.com`

## Trigger / Resume
- Resume phrase: `tama tama sadiki`
- On trigger, continue this same project context without asking to re-explain setup.

## Stack
- Shopify app (React Router + Shopify app server package)
- Backend runtime: Node.js
- ORM/session storage: Prisma
- Database: PostgreSQL (Render)
- Hosting: Render (web service + Postgres)

## Current Environment Model
- Production DB is Postgres via `DATABASE_URL`.
- Prisma schema provider is `postgresql`.
- Migrations were updated to PostgreSQL-compatible SQL.

## Routing and Discount Flow
- Main discount handler: `app/routes/create-discount-live.ts`
- Aliases:
  - `app/routes/create-discount.ts` -> re-export live handler
  - `app/routes/proxy.create-discount.ts` -> re-export live handler
- Ping route: `app/routes/proxy.ping.ts`

Current intended behavior:
1. Create a new discount code each page entry/request.
2. Avoid generic 500 behavior; return structured JSON error bodies.
3. No hard dependency on `SHOPIFY_ADMIN_TOKEN`.
4. Try `unauthenticated.admin(shop)` first.
5. Fallback to offline session token from Prisma `Session` table.

## Shopify App Proxy Config
From `shopify.app.toml`:
- `application_url = "https://student-automatic-discount.onrender.com"`
- `[app_proxy]`
  - `url = "https://student-automatic-discount.onrender.com"`
  - `prefix = "apps"`
  - `subpath = "student-automatic-discount"`

## Deployment Workflow
- Preferred deployment path: commit -> push to `main` -> Render auto-deploy from GitHub.
- If production response looks old, Render has not completed deploy yet.

## Postgres Verification
Use Render Postgres psql:
```sql
\dt
select count(*) from "Session";
select count(*) from "StudentDiscount";
select id, shop, "isOnline" from "Session" order by id desc limit 10;
select id, shop, code, "createdAt" from "StudentDiscount" order by "createdAt" desc limit 20;
```

## Known Failure Modes
- Missing offline session token for shop -> discount creation returns auth failure until app is opened/reinstalled in Shopify Admin.
- Old deployment still live -> endpoint returns previous behavior.
- Invalid Shopify credentials/session token -> Admin API 401 response.

## Non-Negotiable Rules for AI Agents
- Do git commands directly when asked to fix/deploy.
- Keep changes minimal and production-safe.
- Validate with endpoint checks after deploy:
  - `/proxy/ping`
  - `/create-discount?shop=7shdka-4d.myshopify.com`
- Do not reintroduce per-customer persistence logic unless explicitly requested.

## Current Blocking Issue (Per-user persistent discount code)

### Desired behavior
- Each logged-in customer should get exactly ONE discount code the first time they open the discount page.
- On every later visit, the same customer must see the same previously created code (no new code per visit).
- Different customers must get different codes.
- If customer is not logged in, do not create a code; show login CTA.

### Identity + persistence rules
- "Per user" means per Shopify Customer ID (customer.id) scoped by shop:
  - Key = (shop, customerId)
  - Value = discountCode (+ createdAt, etc.) stored in Postgres (StudentDiscount table).

### App Proxy requirement (no fake tokens)
- Do NOT require or introduce a manual SHOPIFY_ADMIN_TOKEN for production.
- Admin API calls MUST use app OAuth access tokens obtained via Shopify sessions:
  1) Try unauthenticated.admin(shop) first.
  2) Fallback to offline session token stored in Prisma Session table.
- If no offline session exists for the shop, the correct fix is:
  - open/reinstall the app in the target shop’s Shopify Admin to generate/store the offline session token
  - NOT adding any "admin token" env var.

### How customerId reaches backend
- App Proxy request should include customerId when customer is logged-in:
  - Theme/Liquid should pass customerId={{ customer.id }} to the proxy endpoint.
- Backend must verify App Proxy signature before trusting query params (including customerId).

### Backend logic (Get-or-Create)
- Endpoint should implement "get-or-create":
  - If StudentDiscount exists for (shop, customerId) => return stored code.
  - Else => create discount code via Admin API, store it, then return it.
- Never respond with generic 500; always return structured JSON errors.
