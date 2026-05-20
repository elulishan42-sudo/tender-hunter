# Tender Hunter

Daily Ethiopian government tender aggregator. Scrapes [2Merkato](https://tender.2merkato.com) and the [EGP portal](https://production.egp.gov.et), filters by procurement category, pushes each tender to [TenderFlow](https://tender-flow-v2.vercel.app) via its ingest API, and sends a compact digest to a Telegram chat.

Runs unattended on GitHub Actions — **2Merkato in the morning and EGP in the afternoon**, on independent schedules.

## How it works

```
.github/workflows/
  tender-hunter-merkato.yml  →  cron 03:00 UTC  (06:00 Addis)
  tender-hunter-egp.yml      →  cron 11:00 UTC  (14:00 Addis)

Each workflow invokes tender-scraper.js with SOURCE=merkato or SOURCE=egp.
The script then runs:

  scrape   →   filter + dedup (per-source cache + fingerprint)
              ↓
              TenderFlow ingest API + Telegram digest
```

The two runs are independent: separate cache files, separate Telegram digests, separate API quota windows. Either failing doesn't affect the other.

## Sources

| Source   | Access          | How                                                                                                                            |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 2Merkato | Login required  | Playwright walks the unfiltered tender feed; parallel listing pagination + parallel detail fetch (4 listing + 5 detail workers) |
| EGP      | Public JSON API | Paginated GET `/po-gw/cms-v2/api/sourcing/get-grouped-sourcing` — fetches every open bid                                       |

### Categories

Both sources share the same `CATEGORY_KEYWORDS` dict in [tender-scraper.js](.opencode/scripts/tender-scraper.js). We keyword-match `title + description` into TenderFlow's category enum; tenders that match nothing fall through as `General` rather than being dropped — **recall over precision**. Expanding the keyword dict improves classification accuracy but never affects whether a tender is captured.

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

Two independent workflows, each with its own cron and `workflow_dispatch` trigger:

- [.github/workflows/tender-hunter-merkato.yml](.github/workflows/tender-hunter-merkato.yml) — `SOURCE=merkato`, runs 03:00 UTC
- [.github/workflows/tender-hunter-egp.yml](.github/workflows/tender-hunter-egp.yml) — `SOURCE=egp`, runs 11:00 UTC

Per-source caches at `.opencode/data/tender-cache-merkato.json` and `tender-cache-egp.json` (both gitignored).

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
| Improve category classification           | `CATEGORY_KEYWORDS` in [tender-scraper.js](.opencode/scripts/tender-scraper.js) (lowercase, partial matches OK) |
| 2Merkato max tenders per run              | `MAX_TOTAL` in `scrapeMerkato()` (default 1000)                      |
| 2Merkato pagination depth                 | `MAX_PAGES` in `scrapeMerkato()` (default 80)                        |
| 2Merkato listing concurrency              | `LISTING_CONCURRENCY` in `scrapeMerkato()` (default 4)               |
| 2Merkato detail concurrency               | `DETAIL_CONCURRENCY` in `scrapeMerkato()` (default 5)                |
| EGP pagination cap                        | `MAX_PAGES` in `scrapeEgp()` (default 50, ~5000 bids)                |
| Cache retention                           | `slice(-5000)` in the `saveCache` call inside `main()`               |
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
