# Prices

List prices behind the cost KPIs (`bench/cost/prices.json` is the machine-readable copy; `bench/cost/model.mjs` turns measured request counts into dollars). Every price
below carries its source in the JSON (URL, the quoted text, `date_accessed` 2026-11-04); primary vendor pricing pages only. Pay-as-you-go list price, no free tier, no
commitment discount.

## Storage providers (what the engine's bucket could sit on)

| Provider | Storage $/GB-month | Class A $/M | Class B $/M | Egress $/GB | Minimum | Source (all accessed 2026-11-04) |
|---|---|---|---|---|---|---|
| Cloudflare R2 (Standard) | $0.015 | $4.5 | $0.36 | free | none | <https://developers.cloudflare.com/r2/pricing/> |
| AWS S3 Standard (us-east-1) | $0.023 | $5 | $0.4 | unknown | none | <https://aws.amazon.com/s3/pricing/> |
| Google Cloud Storage Standard (single region) | $0.02 | $5 | $0.4 | unknown | none | <https://cloud.google.com/storage/pricing>, <https://cloud.google.com/storage/pricing-examples>, <https://cloud.google.com/vpc/network-pricing> |
| Backblaze B2 | $0.00695 | $0 | $0 | $0.01 after 3x stored | none | <https://www.backblaze.com/cloud-storage/pricing> |
| Wasabi (Pay as You Go) | $0.00799 | $0 | $0 | free | $7.99/month | <https://wasabi.com/pricing> |

Gaps, stated rather than guessed:
- **S3 and GCS egress** are left `null`: the per-GB internet rate was not readable from the fetched page text (AWS: only "the first 100GB per month" is free; GCS: tiered by
  destination). The model reports those two providers as a **lower bound** (`labels.lower_bound: true`). At the reference profile egress is 3.1 GB a month, so the miss is
  cents; at a heavy-reading profile it is not.
- **S3 request and storage rates** were read from AWS's price-list JSON for us-west-2 and confirmed for us-east-1 through AWS documentation text; the figures are identical.
- **GCS** prices came from Google's pricing and pricing-examples pages as returned by search (the pricing page body did not render in the fetch tool).
- **Wasabi** bills a 1 TB minimum ($7.99) per account and keeps a deleted object for 90 days; both punish a history store that prunes daily, and neither shows in the per-GB rate.
- **B2** gives egress free up to 3x the stored data, then $0.01 per GB, and charges nothing for class A, B or C calls.

## The Cloudflare side (the accounts Worker, whatever the bucket)

| | Price | Source |
|---|---|---|
| Workers Paid | $5 a month per account (one deployment), 10 M requests included, then $0.30 per million | <https://developers.cloudflare.com/workers/platform/pricing/> |
| Durable Objects | 1 M requests included, then $0.15 per million; incoming WebSocket messages billed 20:1, outgoing free; SQLite rows written $1.00 per million, stored data $0.20 per GB-month | <https://developers.cloudflare.com/durable-objects/platform/pricing/> |
| D1 | rows read $0.001 per million, rows written $1.00 per million, storage $0.75 per GB-month (first 25 B read, 50 M written, 5 GB stored included) | <https://developers.cloudflare.com/d1/platform/pricing/> |

The model charges Worker and Durable Object requests at the overage rate from the first request (per-person at scale, no free allowance) and keeps the $5 apart.

## Measured counters (local stack, code `18aabfc`, 2026-11-04)

| | per idle machine-hour | per change, writer | per change, each other machine |
|---|---|---|---|
| R2 class A (writes, lists) | 39.0 | 2.91 | 0.91 |
| R2 class B (reads) | 72.0 | 9.83 | 4.50 |
| Worker requests | 12.0 | 3.06 | 0.14 |

Idle CPU 0.089 % of a core per machine over 600 s. Source: `~/.local/state/folder-sync-kpi/cost_counters.json`, written by `bench/kpi/ops.mjs`. Durable Object messages are
assumed (1 per change), not measured. The idle window counts only 13 class A and 24 class B requests, so the idle rates carry a few requests of noise either way.

## What a person costs a month: the reference profile

10 GB live, 3 machines, 1000 changes a day, 50 KB a change, **H = 1.51** (the `ci-history-v1` test workload). `node bench/cost/cost.mjs table` regenerates it.

| Provider | Storage | Requests | Egress | Provider total | Workers + DO requests | **Per person-month** | Per live GB-month |
|---|---|---|---|---|---|---|---|
| Cloudflare R2 (Standard) | $0.377 | $1.277 | $0.0000 | $1.653 | $0.0410 | **$1.694** | $0.165 |
| AWS S3 Standard (us-east-1) | $0.578 | $1.418 | >= $0.0000 (price unknown) | $1.996 | $0.0410 | **$2.037** | $0.200 |
| Google Cloud Storage Standard (single region) | $0.502 | $1.418 | >= $0.0000 (price unknown) | $1.921 | $0.0410 | **$1.962** | $0.192 |
| Backblaze B2 | $0.175 | $0.0000 | $0.0000 | $0.175 | $0.0410 | **$0.216** | $0.0175 |
| Wasabi (Pay as You Go) | $0.201 | $0.0000 | $0.0000 | $7.990 (minimum charge) | $0.0410 | **$8.031** | $0.799 |

Sensitivity (R2, same counters): H = 1.0 gives $1.62, H = 0.25 gives $1.50. B2 gives $0.18 and $0.13. The requests, not the history, are what puts R2 over $0.50.
The target of $0.50 a person-month is met only by a provider that does not charge for requests (B2; Wasabi, but its 1 TB minimum makes one person cost $8.03).

## The same person elsewhere

| Service | List price (USD) | What it includes | Source |
|---|---|---|---|
| Obsidian Sync Standard | $4 a month billed annually, $5 monthly | 1 GB, 1 vault, 1 month of version history, 5 MB files | <https://obsidian.md/sync>, <https://obsidian.md/pricing> |
| Obsidian Sync Plus | $8 a month billed annually, $10 monthly | 10 GB, 10 vaults, 12 months of version history, 200 MB files | <https://obsidian.md/sync> |
| Dropbox Plus | $9.99 a month (the page does not say whether yearly or monthly; the copy fetched from here showed CA$12.99) | 2 TB, 30 days to restore deleted files | <https://www.dropbox.com/individual> |
| folder-sync on R2 (this model) | $1.69 variable + a share of $5 | the bucket is the user's; 30 days of history | this document |
| folder-sync on B2 (this model) | $0.22 variable + a share of $5 | same | this document |

For 10 GB the like-for-like list prices are Obsidian Sync Plus at $8-10 and Dropbox Plus at $9.99; folder-sync's variable cost is below both on R2 and far below on B2. The fixed $5 Workers fee has to be shared on top, so the $0.50 target needs a provider with free requests. These are
list prices of different products (Dropbox and Obsidian bundle a client, support and end-to-end encryption that folder-sync does not claim).
