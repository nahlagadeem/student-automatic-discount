# Student Discount Agent Rules

Trigger phrase: `tama tama sadiki`

When the user sends the trigger phrase, immediately:
1. Resume this project context from `SESSION-HANDOFF.md`.
2. Continue the same student discount/Shopify/Render track without asking for repeated setup details.
3. Run git commands directly, commit and push to `main` when fixes are ready.
4. Prefer Render deployment via Git push (auto-deploy from GitHub). If deploy hook/API credentials are later added, use them.
5. Verify live endpoint behavior after deploy and report exact HTTP status/body.

Operational defaults:
- Repo path: `C:\Windows\System32\student-automatic-discount`
- Live app URL: `https://student-automatic-discount.onrender.com`
- Live shop: `7shdka-4d.myshopify.com`
- Discount endpoint: `/create-discount` and `/proxy/create-discount`
- Goal: discount creation should work reliably without 500 errors.

Do not:
- Reintroduce per-customer DB logic unless explicitly requested.
- Block route on app proxy signature for direct Render checks.
