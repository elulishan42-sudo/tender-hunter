# Tender Hunter

Daily Ethiopian government tender aggregator. Scrapes [2Merkato](https://tender.2merkato.com) and the [EGP portal](https://production.egp.gov.et), filters by procurement category, pushes each tender to [TenderFlow](https://tender-flow-v2.vercel.app) via its ingest API, and sends a compact digest to a Telegram chat.

Runs unattended on GitHub Actions every morning.

## How it works

```
GitHub Actions cron (06:00 UTC / 09:00 Addis)
         |
         v
tender-scraper.js
   |                        |
   v  (in parallel)         v
2Merkato                  EGP
(Playwright login + cat.  (public JSON API,
scrape, ~40s)             single fetch, ~2s)
   |                        |
   +-----------+------------+
               |
               v
      filter  +  dedup
   (cache + SHA-256 fingerprint)
               |
        +------+------+
        |             |
        v             v
   TenderFlow       Telegram
   ingest API       digest
```

Both scrapers run under `Promise.all`. Either failing is caught and logged; we only abort the run if both return zero.

## Sources

| Source   | Access          | How                                                                                 |
| -------- | --------------- | ----------------------------------------------------------------------------------- |
| 2Merkato | Login required  | Playwright renders the Vue SPA, iterates 5 category IDs, visits each detail page    |
| EGP      | Public JSON API | Single GET `/po-gw/cms-v2/api/sourcing/get-grouped-sourcing?top=100` — no browser   |

### Categories

2Merkato's own taxonomy maps cleanly to TenderFlow's enum (see `CATEGORY_MAP` in [tender-scraper.js](.opencode/scripts/tender-scraper.js)).

EGP classifies bids only as `Goods / Works / Services`, which is too broad. We keyword-match on `lotName + lotDescription` into four buckets: `Lab & Chemicals`, `Medical`, `Vet & Agri`, `Education & Stationery`. Anything unmatched is dropped. The keyword dict (`EGP_CATEGORY_KEYWORDS`) is the single tuning knob.

## Deduplication

Three layers, cheapest first:

1. **Within a run** — `tenderId` set across pages and categories.
2. **Across runs** — local cache (last 2000 entries, ~40 days at 50/run) keyed by both `tenderId` and a SHA-256 fingerprint of `lowercase(name) + lowercase(entity) + deadline_date`.
3. **Server-side** — TenderFlow recomputes the same fingerprint and skips matches server-side. The client-side fingerprint saves API quota when it catches; if our algorithm ever drifts from TenderFlow's, the worst case is wasted calls (never dropped bids).

The fingerprint is what catches the same bid posted on both 2Merkato and EGP under different IDs.

## Filters (per-tender)

| Filter     | Values                        | Default |
| ---------- | ----------------------------- | ------- |
| freshness  | `new`, `all`                  | `new`   |
| cost       | `free`, `all`                 | `all`   |
| deadline   | `any`, `7days`, `14days`, `30days` | `any`   |
| status     | `open`, `all`                 | `open`  |

Configured in [.opencode/data/tender-config.json](.opencode/data/tender-config.json.example).

## Deployment

Scheduled via [.github/workflows/tender-hunter.yml](.github/workflows/tender-hunter.yml). Also triggerable manually via **workflow_dispatch**.

### Secrets (Repo Settings → Secrets → Actions)

| Secret                 | Used for                                           |
| ---------------------- | -------------------------------------------------- |
| `MERKATO_EMAIL`        | 2Merkato login                                     |
| `MERKATO_PASSWORD`     | 2Merkato login                                     |
| `TELEGRAM_BOT_TOKEN`   | Digest delivery                                    |
| `TELEGRAM_USER_ID`     | Digest recipient                                   |
| `TENDERFLOW_API_KEY`   | Bearer token for `POST /api/agent/ingest-tenders`  |

EGP needs no secrets — public API.

## Rate limits

- **TenderFlow**: 200 tenders/day, 50 per request, 100 KB per body.
- **EGP API**: no documented limit; we make one call per run.
- **2Merkato**: deliberate pacing — 200 ms between detail pages, 5 categories in parallel.

## Running locally

```bash
cp .opencode/data/tender-config.json.example .opencode/data/tender-config.json
# fill in Telegram + 2Merkato creds in the copy

cd .opencode && npm install && npx playwright install chromium
cd ..

TENDERFLOW_API_KEY=... node .opencode/scripts/tender-scraper.js
```

Environment variables take precedence over the config file, matching the CI flow.

## Tuning

| Want to...                                | Edit                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Add EGP keywords                          | `EGP_CATEGORY_KEYWORDS` in [tender-scraper.js](.opencode/scripts/tender-scraper.js) (lowercase, partial matches OK) |
| Change 2Merkato target categories         | `CATEGORY_IDS` + `CATEGORY_MAP`                                      |
| Tenders per 2Merkato category per run     | `maxTendersPerCategory` in `scrapeCategory()` (default 10)           |
| How many EGP bids to consider per run     | `top=100` in `scrapeEgp()`'s URL                                     |
| Cache retention                           | `slice(-2000)` in the `saveCache` call inside `main()`               |
| Daily run time                            | Cron expression in [tender-hunter.yml](.github/workflows/tender-hunter.yml) |

## File map

```
.github/workflows/
  tender-hunter.yml       daily cron + manual dispatch

.opencode/
  agents/tender-hunter.md OpenCode agent definition
  scripts/tender-scraper.js the worker
  data/
    tender-config.json    gitignored — real credentials
    tender-config.json.example  template
    tender-cache.json     gitignored — dedup cache (auto-managed)

AGENT_API_CONTRACT (2).md TenderFlow ingest contract — keep this in sync
                          with the server's fingerprint algorithm or
                          cross-source dedup will drift.

README.md                 this file
```

## Related docs

- [AGENT_API_CONTRACT (2).md](AGENT_API_CONTRACT%20(2).md) — TenderFlow's side of the wire (fields, categories, fingerprint, rate limits).
- [.opencode/agents/tender-hunter.md](.opencode/agents/tender-hunter.md) — OpenCode agent definition (selectors, credentials note, known fixes).
