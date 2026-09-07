# Fix EGP purchasing ("bid") Telegram links opening the list instead of detail

## Context
- Symptom: clicking an EGP link in the Telegram digest for a **purchasing bid** opens
  `https://production.egp.gov.et/egp/bids/all` (the list) instead of the bid detail page.
- For purchasing bids `sourceApplication === "Purchasing"`, so the code builds
  `https://production.egp.gov.et/egp/bids/all/purchasing/<bid.sourceId>/open`
  (tender-scraper.js, ~lines 736-747). That route does not resolve → the Angular SPA
  falls back to the list.
- Working reference supplied by user — a **tendering** link with the identical shape:
  `https://production.egp.gov.et/egp/bids/all/tendering/1e46a38b-6c31-40d2-9370-4c279241384d/open`
  → the route shape `/egp/bids/all/<module>/<id>/open` is correct; the only discrepancy is the id.
- Root cause: the code passes `bid.sourceId`, a carry-over from the **data API** note
  ("the purchasing API accepts sourceId, not id"). The front-end `/open` detail route keys
  on `bid.id`, not `sourceId`. With `sourceId` the SPA can't find the bid and redirects to the list.
- Confirmed via EGP API sample: a purchasing bid exposes both `id`
  (`16fb3e07-6d5e-420b-8428-46d59fa9bac6`) and `sourceId` (`86650abe-...`); current code uses the latter.

## Decision
- Use `bid.id` (internal id) in the purchasing detail URL. Keep `module = sourceApplication.toLowerCase()`
  and the `/open` suffix. The `/open` route is public (proven by the tendering link).
- Scope: **purchasing only** (user: "only for bid, not proforma"). Non-purchasing links
  (tendering/auctioning/prequalification) keep their current `#hashRef` list link — unchanged
  (see open question below).

## Change — `tender-scraper.js` (EGP URL building, ~lines 736-747)
Replace:
```js
        // Purchasing bids load via /purchasing-quotation-invitations/api/get-quotation-invitation,
        // which is public and accepts bid.sourceId (NOT bid.id — that returns 204 No Content).
        // Tendering / Auctioning / Prequalification all require auth, so we link to the
        // listing page where users can search by the tender_number we already include.
        const urlId = bid.sourceId || bid.id;
```
With:
```js
        // The data API uses sourceId, but the front-end /open detail route keys on the
        // internal bid.id. Passing sourceId made the SPA fall back to the list page, so we
        // use bid.id here. Tendering / Auctioning / Prequalification require auth, so they
        // still link to the listing page (with the reference as a hash) below.
        const urlId = bid.id || bid.sourceId;
```
No change needed to the `sourceLink` ternary itself — it already uses `urlId`.

## Validation
1. Empirical (implementation agent, in CI where Playwright + Chromium are already installed):
   - Pull a real purchasing bid from `https://production.egp.gov.et/po-gw/cms-v2/api/sourcing/get-grouped-sourcing`
     (has both `id` and `sourceId`).
   - Headless-load the candidate URL with `bid.id`; assert it renders the bid detail
     (contains the lot name / "Submission Deadline" / not the listing grid) and does NOT
     redirect to `/egp/bids/all`.
   - If `bid.id` still fails, fall back to testing `bid.sourceId` and the
     `purchasing-quotation-invitations` module variant; pick the one that renders detail.
2. End-to-end: trigger the workflow manually (`workflow_dispatch`); in Telegram click an
   EGP purchasing link and confirm it opens the bid detail page.

## Risks / open questions
- Assumption: "proforma" = non-purchasing EGP entries, left as list links. The supplied
  tendering link proves non-purchasing `/open` detail routes are also public, so if the user
  wants ALL EGP types to open detail, extend the same `bid.id` treatment to the non-purchasing
  branch — but that is out of scope unless requested.
- EGP can change routing again later; a future periodic link-check would catch regressions.
