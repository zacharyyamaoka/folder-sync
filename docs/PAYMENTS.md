# Payments (Stripe, test mode only)

An app can sell storage plans. With `FEATURE_PAYMENTS = "on"` in its wrangler env block, a person's **plan sets their storage
quota** (PEP 0003 §3.11): Free is `QUOTA_BYTES` / `QUOTA_OBJECTS`, a paid plan is its own ceiling. `QUOTA_BY_OWNER` stays the
operator's override and wins over a plan, field by field. Off (the default), nothing here exists: no routes, no plan section, no
Stripe call, and a subscription row in the database changes nobody's quota.

**Test mode only.** The Worker refuses any key that is not `sk_test_…` / `rk_test_…`, as if no key were set. Moving to live money
is a code change on purpose, not a mispasted secret. Nothing in this repo creates or holds a real key, and the tests use a local
fixture (`accounts/test/stripe-fixture.ts`): Stripe's documented shapes, webhooks signed with the official SDK's own test helper.
To run the Worker against `stripe-mock` instead, set `STRIPE_API_URL = "http://127.0.0.1:12111"`.

## What you paste: two secrets per app

| Secret | Where it comes from | Looks like |
|---|---|---|
| `STRIPE_SECRET_KEY` | Stripe dashboard, **test mode**, Developers, API keys, *Secret key* | `sk_test_…` |
| `STRIPE_WEBHOOK_SECRET` | the webhook endpoint below, *Signing secret* | `whsec_…` |

Both go in with `python3 accounts/scripts/set-secrets.py --env <app>`: when the app's wrangler env has `FEATURE_PAYMENTS = "on"`
the page gains a Stripe section (numbered steps, a copy button for every value to type, two paste boxes), the same style as the
Google and Cloudflare sections. With payments off the section is not shown. Nothing else is secret: plans and their Stripe price
lookup keys are plain config.

## What to make in Stripe (test mode), once per app

1. **Products** (Product catalog, Add product): one per paid plan, a monthly recurring price, and under *Additional options* the
   **Lookup key**. The defaults the Worker sells when `PLANS` is unset:

   | Plan | Quota | Lookup key |
   |---|---|---|
   | Free | `QUOTA_BYTES` (1 GiB), `QUOTA_OBJECTS` (100 000) | none: no subscription |
   | Plus | 10 GiB, 250 000 files | `folder-sync-plus` |
   | Pro | 100 GiB, 1 000 000 files | `folder-sync-pro` |

   To sell something else set `PLANS` (a JSON var) in the app's block; ids are lower case, a plan with neither `lookupKey` nor
   `priceId` is left out, and a malformed value falls back to the defaults:
   `PLANS = '{"plus":{"title":"Plus","bytes":10737418240,"objects":250000,"lookupKey":"folder-sync-plus"}}'`.
   Price the plans against `docs/PRICES.md` (objective O3: at most $0.50 per person-month at 10 GB, so Plus is a few dollars).
   A quota check lists the person's root, one subrequest per 1000 files, so a plan's `objects` above about 45 000 needs the
   Workers Paid plan's subrequest limit (the note beside `QUOTA_OBJECTS` in `wrangler.toml`).
2. **Webhook endpoint** (Developers, Webhooks, Add endpoint): URL `<PUBLIC_URL>/fs/api/auth/stripe/webhook` (the Worker's own
   host, e.g. `https://folder-sync-accounts-<app>.<subdomain>.workers.dev/fs/api/auth/stripe/webhook`), events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`. Its signing secret is `STRIPE_WEBHOOK_SECRET`.

## How a plan becomes a quota

- `POST /fs/v1/billing/checkout {plan}` (or the account page's Upgrade button) asks Better Auth's Stripe plugin for a hosted
  checkout and sends the browser there. The customer is made at that moment, not at sign-up.
- Stripe tells the Worker the subscription is active (`/fs/api/auth/stripe/webhook`, signature checked); the plugin writes its
  `subscription` row (migration 0011). A page, a redirect back from Stripe or a request body never sets a plan.
- Every quota read (`quotaFor`) takes the person's active or trialing plan, the best one if they hold several, else Free. A
  canceled, unpaid, past-due or paused subscription is Free again. A person who has bought sees Manage billing (Stripe's portal).
- `GET /fs/v1/billing` answers `{ plan, plans, subscription, configured }` (the plan with where its figures come from:
  `free`, `subscription` or `operator`).

## Switching it on for an app

1. `FEATURE_PAYMENTS = "on"` in the app's `[env.<app>]` vars; optionally `PLANS`.
2. `python3 accounts/scripts/set-secrets.py --env <app>`, follow the Stripe section.
3. Apply migrations (`0011_billing.sql` adds the `subscription` table and `user.stripeCustomerId`), deploy. Zach's call, as always.
