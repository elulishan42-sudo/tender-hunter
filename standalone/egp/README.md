# Tender Hunter — EGP (Bid)

Standalone Ethiopian EGP bid scraper extracted from `elulishan42-sudo/tender-hunter` (source commit `789a8b7c90a6efa3faedc7742516772f0017b703`). No runtime dependency on that repository, 2Merkato, Playwright, OpenCode, or external npm packages.

## What is preserved

- Public EGP JSON API, newest-first incremental pagination (100 bids/page, 50-page safety cap).
- `sourceApplication: tendering` only; purchasing/proforma excluded.
- Deadlines strictly more than 2 and less than 30 days away, in the current calendar year.
- Exclusion of Services, Consultancy, Works and the original title/description exclusion patterns.
- Original keyword categories, General fallback, international/local classification, and public bid detail URLs.
- Fingerprint deduplication, permanent-skip caching, deferred distant deadlines, 10,000-entry cache cap.
- Telegram digests in chunks of 10, recipient list support, manual-run empty digests, and one-time maintenance alerts.
- Schedule at minutes 7 and 37 of hours 03–17 UTC daily (06–20 Addis Ababa), cancellation of overlapping runs, and workflow failure notification.
- TenderFlow client and API-key wiring. **TenderFlow delivery remains DISABLED, matching the original scraper.** No dashboard ingestion occurs unless the disabled block in `runSource` is explicitly changed.

The scraper's existing endpoint is `https://tender-flow-v2.vercel.app/api/agent/ingest-tenders`; it is intentionally preserved rather than replaced with the different URL in the old API contract.

## GitHub setup

Publish **the contents of this directory as the new repository root**, including `.github/` and `.gitignore`. Do not publish the parent Tender Hunter project or its credential-containing API contract.

The destination repository must have this workflow on its **default branch** for scheduled runs and manual dispatch. Enable GitHub Actions in repository settings if necessary.

In **Settings → Secrets and variables → Actions**, create repository secrets:

| Secret | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN_EGP` | Existing EGP Telegram bot token |
| `TELEGRAM_USER_ID_EGP` | Existing EGP recipient chat IDs; comma-separated for both digest and failure alert |
| `TENDERFLOW_API_KEY` | Retained for parity; unused while TenderFlow delivery is disabled |

GitHub secrets are write-only: neither the API nor `gh secret list` returns their values. Retrieve values from your original secure storage and enter them directly in GitHub, not in chat or source files. Alternatively, use `gh secret set SECRET_NAME --repo elulishan42-sudo/tender-hunter-egp` interactively on your own machine. Existing organization secrets can instead be granted access to the new repository where applicable. The Actions-provided `GITHUB_TOKEN` is generated automatically and must not be copied. No 2Merkato credentials are needed.

A credential appeared in the original API contract. Do not reuse it without verifying and rotating it through the service owner; it has deliberately not been included here.

### Cutover

1. Publish the standalone repository and configure its secrets.
2. Run **Tender Hunter — EGP (Bid)** manually under Actions and verify its Telegram digest.
3. Disable only the original EGP workflow when ready; leave 2Merkato enabled. Running both EGP workflows concurrently can send duplicate Telegram notifications.
4. GitHub Actions caches are repository-scoped and do not transfer automatically. The new repository starts with an empty cache and can resend all currently eligible tenders on its first run. If that is undesirable, securely transfer the original `tender-cache-egp.json` cache before enabling the new schedule; do not commit it.

## Local use

Requires Node.js 20 or newer. No dependency installation is required.

```sh
npm test
# Set TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID in your shell securely, then:
npm start
```

Local environment names are `TELEGRAM_BOT_TOKEN` and `TELEGRAM_USER_ID`; the workflow maps the `_EGP` secret names to them. Optional: `FORCE_DIGEST=true` to send a digest even if nothing is new, and `TENDERFLOW_API_KEY` for the retained disabled client. `RUN_SOURCE` is unnecessary: this project always runs EGP only.

Alternatively, copy `data/tender-config.json.example` to `data/tender-config.json` and fill in Telegram settings locally. That file, caches, and `.env` files are ignored by Git. Environment files are not loaded automatically.

## Tests and extraction scope

`npm test` uses Node's built-in test runner with mocked HTTP responses. It verifies filtering, bid mapping, pagination, legacy caches, maintenance detection, fingerprints, recipients, and digest formatting without contacting EGP, Telegram, or TenderFlow.

The EGP and shared delivery functions are retained from upstream; 2Merkato browser/login/scraping functions, its credentials, and its npm dependencies are removed. The entry point is import-safe for tests, and the workflow checks for missing Telegram configuration before scraping. The original delivery/error semantics otherwise remain unchanged: for example, some EGP HTTP failures are logged and can still complete successfully, and delivery failures can still be cached. This extraction does not claim to fix those pre-existing behaviors.
