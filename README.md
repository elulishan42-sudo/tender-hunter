# Tender Hunter

Near-real-time Ethiopian government tender aggregator. Scrapes [2Merkato](https://tender.2merkato.com) and the [EGP portal](https://production.egp.gov.et) on a **30-minute cron**, ships only newly-posted tenders to [TenderFlow](https://tender-flow-v2.vercel.app), and sends a compact Telegram digest **only when something new is found** (no silent pings).

## How it works

```
.github/workflows/tender-hunter.yml   →  cron */30 * * * *  (every 30 minutes)
        │
        ▼
  Restore cross-run cache (actions/cache)
        │
        ▼
  tender-scraper.js
        │
        ▼
  ┌───── 2Merkato ─────┐         ┌────── EGP ──────┐
  │ login + walk feed  │  then   │ paginate JSON   │
  │ page-by-page until │  ────►  │ page-by-page    │
  │ "caught up"        │         │ until "caught   │
  └────────────────────┘         │ up"             │
        │                        └─────────────────┘
        ▼
  filter + fingerprint dedup
        │
        ▼
  Skip if nothing new ─── otherwise ─► TenderFlow + Telegram
        │
        ▼
  Save cache (actions/cache)
```

Both sources run sequentially in one job. **Each scraper walks listings newest-first and stops the moment a page contributes zero uncached tenderIds** — meaning everything beyond is older and we've already seen it. Warm-cache runs finish in seconds.

## Sources

| Source   | Access          | How                                                                                                       |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| 2Merkato | Login required  | Playwright walks the unfiltered tender feed sequentially; 10 parallel detail-fetch workers                |
| EGP      | Public JSON API | Paginated GET `/po-gw/cms-v2/api/sourcing/get-grouped-sourcing?orderBy=invitationDate desc` — no browser  |

Both walk newest-first and use the **early-termination rule**: as soon as a page yields zero uncached tenderIds, the source is "caught up" and we stop paginating.

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

Single workflow on a 30-minute cron — [.github/workflows/tender-hunter.yml](.github/workflows/tender-hunter.yml). Also triggerable manually via **workflow_dispatch**.

Cache files (`tender-cache-merkato.json` and `tender-cache-egp.json`) are gitignored locally and persisted across runs via `actions/cache@v4`. Cold-start (first run after deploy / cache eviction) is one-time pain; every run after is incremental.

### Cost

At every 30 min, 1 combined run = 48 runs/day = ~1440 GitHub Actions minutes/month. **Within the 2000-min/month free tier for private repos.**

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
| Exclude additional keywords               | `EXCLUDE_PATTERNS` (word-boundary regex)                             |
| Deadline window                           | `isDeadlineInWindow()` — currently `(now+2d, now+30d)` and current year |
| 2Merkato cold-start safety caps           | `MAX_TOTAL` / `MAX_PAGES` in `scrapeMerkato()`                       |
| 2Merkato detail concurrency               | `DETAIL_CONCURRENCY` in `scrapeMerkato()` (default 10)               |
| EGP cold-start safety cap                 | `MAX_PAGES` in `scrapeEgp()` (default 50)                            |
| Cache retention per source                | `slice(-5000)` in `runSource()`                                      |
| Scrape interval                           | Cron expression in [tender-hunter.yml](.github/workflows/tender-hunter.yml) (default `*/30 * * * *`) |

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
