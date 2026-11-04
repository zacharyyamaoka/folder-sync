# Giving an app its own accounts

One deployment per app. Each app gets its own Worker, D1 database (users, sessions, folder rows), `BETTER_AUTH_SECRET`
and Durable Object namespaces, plus its own root in the shared `folder-sync` bucket (`ROOT_PREFIX`, keys
`<ROOT_PREFIX>users/<id>/…`). A Better Auth id is only unique inside its own D1, so the prefix is what keeps two apps'
ids from ever meeting. The top-level block of `accounts/wrangler.toml` is vibetracks.dev's (no prefix, keys `users/<id>/`);
every other app is one `[env.<app>]` block at the end of that file. `[env.robotparts]` is the worked example: copy it.

`<app>` below is a short lowercase name, e.g. `robotparts`. Run from the repo root.

1. Add the block: copy `[env.robotparts]` and its sub-tables, rename `<app>` everywhere, set `name =
   "folder-sync-accounts-<app>"`, `PUBLIC_URL` to `https://folder-sync-accounts-<app>.<workers subdomain>.workers.dev`
   and `ROOT_PREFIX = "apps/<app>/"` (empty or ending in a slash, at most four segments). Add the app to
   `accounts/apps.json` (name, `origins`, `project`). The block's `vars` also carry the app's four switches (below).
2. Create its D1 and put the printed id in the block's `database_id`:
   ```bash
   npx --prefix accounts wrangler d1 create folder-sync-accounts-<app>
   ```
3. Apply the migrations:
   ```bash
   npx --prefix accounts wrangler d1 migrations apply DB --remote --env <app> --config accounts/wrangler.toml
   ```
4. Deploy, then set a fresh signing secret (generated and piped, never shown):
   ```bash
   npx --prefix accounts wrangler deploy --env <app> --config accounts/wrangler.toml
   openssl rand -base64 48 | tr -d '\n' | npx --prefix accounts wrangler secret put BETTER_AUTH_SECRET --env <app> --config accounts/wrangler.toml
   ```
5. Set the operator secrets, one `wrangler secret put <NAME> --env <app> --config accounts/wrangler.toml` each:
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `R2_PARENT_ACCESS_KEY_ID`, `R2_PARENT_SECRET_ACCESS_KEY`,
   `SIGN_UP_EMAILS` (who may create an account; `*` is anyone), and `RESEND_API_KEY` for emailed sign-in codes (optional).
   `python3 accounts/scripts/set-secrets.py --env <app>` walks through the Google and Cloudflare ones with screenshots and copy
   buttons, plus Stripe's when payments are on (below).
   Until the storage and Google secrets are set, credentials and Google sign-in answer 503.
6. Point the app's `/fs/*` at it: in the app's Worker, change the service binding to
   `{ "binding": "FOLDER_SYNC", "service": "folder-sync-accounts-<app>" }` and redeploy the app.
7. Google console, the one OAuth client: add `https://<app domain>/fs/api/auth/callback/google` as an authorized redirect
   URI (the callback is on the app's own domain, not the Worker's). An app whose domain is already listed needs nothing.

## The four switches

Each app turns the parts of the account product it wants on or off with a var in its own `[env.<app>]` block (`accounts/src/features.ts`).
A copy of `[env.robotparts]` already carries the defaults for a new app:

| Var | Turns on | A new app |
|---|---|---|
| `FEATURE_STORAGE` | online file storage: the web host (browser writes and deletes of a folder's files) and the Files page | `"on"` |
| `FEATURE_SYNC` | local file sync: `folder-sync login` (the device flow), a machine's scoped storage keys and its deletes | `"on"` |
| `FEATURE_PAYMENTS` | plans that set the storage quota, bought through Stripe in test mode (`docs/PAYMENTS.md`) | `"off"` |
| `FEATURE_BYO` | bring your own tokens: a person attaches their own S3-compatible bucket and their machines sync to it | `"off"` |

Off hides the switch's UI on the account page and refuses its routes (`404 feature_off`, Better Auth's `device/*` and
`stripe/*` paths included). A var left unset keeps the default above, so an app that never set them is unchanged. Values are
`"on"` / `"off"`; anything else counts as off.

- **Payments on:** also `PLANS` if the defaults (Plus 10 GiB, Pro 100 GiB) are not what you sell, then the Stripe section of
  `python3 accounts/scripts/set-secrets.py --env <app>` (`STRIPE_SECRET_KEY` test mode, `STRIPE_WEBHOOK_SECRET`): see
  `docs/PAYMENTS.md`.
- **Bring-your-own on:** one more secret, `BYO_ENCRYPTION_KEY` (32 random bytes, base64), which `set-secrets.py` makes and sets
  for you without showing it. It seals each person's bucket keys; changing it later makes every attached bucket's keys unreadable.
  Without it the page says the feature is not available yet and nothing is stored.
- Switching a feature on after the first deploy needs migrations `0011` (payments) and `0012` (bring your own) applied, as in
  step 3 above; they are in every deployment's migration set.

A new deployment starts with no accounts: people sign in again (their Google `sub` is the same, their user id is new) and
their folders start empty under the new root. Nothing is migrated automatically.
