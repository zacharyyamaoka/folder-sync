# Cost

What folder-sync costs against what people pay for the services it stands in for. The provider prices and the cost model are in [PRICES.md](PRICES.md) and
[KPI.md](KPI.md) (O3); this page is the comparison.

## Against Dropbox, Google Drive and Obsidian Sync

Zach: "for cost per GB month please benchmark it vs dropbox, googledrive, obsidian sync costs." Retail list prices in USD, read from each vendor's own pricing page on
2026-11-04. The machine-readable copy is `bench/cost/competitors.json` (schema `bench/cost/competitors.schema.json`); `node --test bench/cost/competitors.test.mjs`
validates it and recomputes the last two columns.

- **$/GB-month** = the plan's monthly price ÷ its included storage: what a GB costs a person who fills the plan.
- **A person with 10 GB pays** = the price of the vendor's cheapest plan that holds 10 GB, at the same billing cadence. It is the whole plan's price, **not pro-rated** to
  10 GB: a person cannot buy 10 GB of Dropbox, only 2 TB.

| Plan | Billing | $/month | Storage | $/GB-month | A person with 10 GB pays | Version history | Source |
|---|---|---|---|---|---|---|---|
| Dropbox Plus | yearly ($119.88) | $9.99 | 2 TB | $0.0050 | **$9.99** | 30 days | [dropbox.com/plans](https://www.dropbox.com/plans) |
| Dropbox Plus | monthly | $11.99 | 2 TB | $0.0060 | **$11.99** | 30 days | same |
| Dropbox Standard (1 person; replaces Essentials/Professional) | yearly | $15 | 3 TB | $0.0050 | $9.99 (Plus) | 180 days | same; [help.dropbox.com/plans/standard-plan](https://help.dropbox.com/plans/standard-plan) |
| Dropbox Standard | monthly | $18 | 3 TB | $0.0060 | $11.99 (Plus) | 180 days | same |
| Google Drive, free account | | $0 | 15 GB, shared with Gmail and Photos | $0 | **$0** while mail and photos use < 5 GB | 30 days or 100 versions | [one.google.com/about/plans](https://one.google.com/about/plans); [Drive version history](https://support.google.com/drive/answer/2409045) |
| Google One Basic | yearly ($19.99) | $1.67 | 100 GB | $0.0167 | $0 (free tier), else **$1.67** | 30 days or 100 versions | [one.google.com/about/plans](https://one.google.com/about/plans) |
| Google One Basic | monthly | $1.99 | 100 GB | $0.0199 | $0, else **$1.99** | same | same |
| Google One 2 TB | yearly ($99.99) | $8.33 | 2 TB | $0.0042 | $0, else $1.67 (Basic) | same | same |
| Google One 2 TB | monthly | $9.99 | 2 TB | $0.0050 | $0, else $1.99 (Basic) | same | same |
| Obsidian Sync Standard | yearly | $4 | 1 GB | $4.00 | $8 (Plus) | 1 month | [obsidian.md/sync](https://obsidian.md/sync) |
| Obsidian Sync Standard | monthly | $5 | 1 GB | $5.00 | $10 (Plus) | 1 month | same |
| Obsidian Sync Plus | yearly | $8 | 10 GB | $0.80 | **$8** | 12 months | same; [plans help](https://obsidian.md/help/sync/plans) |
| Obsidian Sync Plus | monthly | $10 | 10 GB | $1.00 | **$10** | 12 months | same |
| *Context:* iCloud+ 50 GB | monthly | $0.99 | 50 GB | $0.0198 | **$0.99** | deleted files 30 days | [support.apple.com/108047](https://support.apple.com/en-us/108047) |
| *Context:* iCloud+ 200 GB | monthly | $2.99 | 200 GB | $0.0150 | $0.99 (50 GB) | same | same |
| *Context:* Microsoft 365 Basic (OneDrive) | yearly ($19.99) | $1.67 | 100 GB | $0.0167 | **$1.67** | file recovery 30 days | [microsoft.com OneDrive plans](https://www.microsoft.com/en-us/microsoft-365/onedrive/onedrive-plans-and-pricing) |
| *Context:* Microsoft 365 Basic (OneDrive) | monthly | $1.99 | 100 GB | $0.0199 | $1.99 | same | same |

How the prices were read, stated rather than smoothed over:
- **Dropbox and Google render Canadian dollars from this machine.** The CA$ figures were read directly (Dropbox Plus CA$12.99 yearly / CA$15.99 monthly; Google One
  100 GB CA$2.79 / CA$27.99 a year, 2 TB CA$13.99 / CA$139.99 a year). The USD figures are the same vendor pages as a US search index serves them, cross-checked against
  Dropbox's own community answer ($9.99 is the per-month price of the yearly plan) and against the CA$ prices (every Google tier is 1.40× its USD price).
- **Dropbox Essentials and Professional are no longer on the plans page.** Standard is now "For 1 person or more", 3 TB, 180-day history: the plan a solo professional
  buys. Older listings put Essentials at $16.58 yearly / $19.99 monthly for 3 TB.
- **Google's 2 TB tier is named differently by country.** In the US, Google AI Plus became 400 GB at $4.99 in June 2026; the storage-only 2 TB tier is $9.99 / $99.99.
  Canada's page sells 2 TB as "Google AI Plus (2 TB)".
- **Microsoft** renders prices client-side; the USD figures are the page as a US search index serves it.
- **Obsidian** and **Apple** publish USD directly (Apple's table is per country, published 2026-09-16).
- **Free tiers** count when they hold 10 GB on their own: only Google's 15 GB does, and only while Gmail and Photos leave 10 GB of it. Dropbox Basic (2 GB), iCloud
  (5 GB) and OneDrive (5 GB) do not.
- **Obsidian counts version history and attachments inside the 10 GB**, so 10 GB of live files with any history does not fit Plus; extra storage up to 100 GB exists
  but its price is not on the page.

### Two framings, because the numbers are not the same kind

**1. What it costs us to serve a 10 GB person** (O3: the provider bill, not a price). The reference profile of [PRICES.md](PRICES.md) (10 GB live, 3 machines,
1000 changes a day, H = 1.51; `node bench/cost/cost.mjs table`):

| folder-sync on | Per person-month | Per live GB-month | Raw storage list price |
|---|---|---|---|
| Cloudflare R2 | $1.69 | $0.165 | $0.015 / GB-month |
| Backblaze B2 | $0.22 | $0.0175 | $0.00695 / GB-month |

plus a share of the $5 Workers Paid fee per deployment.

**2. What a person pays them for 10 GB** (retail): $0 on Google's free tier if it has room, $0.99 on iCloud, $1.67-1.99 on Google One or OneDrive, $8-10 on
Obsidian Sync Plus, $9.99-11.99 on Dropbox Plus.

Read side by side:
- **Per person, folder-sync's cost to serve is already far under the sync products Zach named**: $1.69 on R2 is about a fifth of Obsidian Sync Plus or Dropbox Plus.
  It is **not** under the bundled-storage floor: iCloud at $0.99 and Google One at $1.67 sell the 10 GB person a whole plan for less than R2 costs us to serve them,
  and Google gives it away when the free 15 GB has room.
- **Per GB, retail bulk storage is cheaper than our raw storage** for anyone who fills the plan: Google One 2 TB yearly is $0.0042 a GB-month and Dropbox Plus
  $0.0050, under R2's $0.015 list price and under B2's per-live-GB cost of $0.0175 once history and requests are in. Those vendors are betting on unused space. The
  per-GB number only flatters folder-sync against Obsidian Sync ($0.80-1.00 a GB).
- **The products differ.** Dropbox and Obsidian bundle a client, support, sharing and (Obsidian) end-to-end encryption; folder-sync's number is a provider bill with no
  margin, support or payment fees in it. Version history differs too: 30 days (Dropbox Plus, Google, iCloud, OneDrive), 180 days (Dropbox Standard), 12 months
  (Obsidian Plus); folder-sync keeps 30 days.

### What this says about O3's ≤ $0.50 target (Zach's call)

The target is a cost to serve, so the right yardstick is the price folder-sync could charge, not the price competitors' storage costs them. If folder-sync is meant to
sell against Obsidian Sync and Dropbox ($8-12 for 10 GB), $0.50 is far stricter than it needs to be: even R2's $1.69 leaves most of an $8 price as margin. If it is
meant to sit at the bundled-storage price point (iCloud $0.99, Google One / OneDrive $1.67-1.99, or free on Google), $0.50 is about the right ceiling: it is half the
cheapest consumer plan, which is what leaves room for payment fees and support at a $1-2 price, and today only B2 ($0.22) meets it because R2 bills the requests.
Recommendation: keep $0.50, because the people Zach wants to reach already have 15 GB free from Google, and say in KPI.md that it is set against the $0.99-1.99
bundled-storage floor rather than against Obsidian Sync or Dropbox.
