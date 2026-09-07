# IDE agent handoff: standalone EGP scraper

## Goal

Publish the already-extracted EGP scraper as a new **private** GitHub repository named `elulishan42-sudo/tender-hunter-egp`. It must run independently of Tender Hunter. The original EGP and 2Merkato workflows have not been changed.

## Work to reuse

Everything needed for the new repository is in `standalone/egp/`, including hidden files:

- `.github/workflows/tender-hunter-egp.yml`
- `.gitignore`
- `scripts/tender-scraper.js`
- `test/scraper.test.js`
- `package.json`
- `data/tender-config.json.example`
- `README.md`

Copy the **contents** of `standalone/egp/` into the destination repository root, not the directory itself. Include hidden files. Do not copy the parent project's history, credentials, API contract, caches, or unrelated OpenCode/2Merkato files.

## Checks already completed

- `npm test` in `standalone/egp/`: 8 tests passed, using mocked HTTP and no real deliveries.
- `node --check scripts/tender-scraper.js`: passed.
- 13 retained EGP/shared scraping, delivery, and cache functions were compared to upstream and matched exactly.
- No npm dependencies are required; use Node.js 20 or newer.

Run these checks again after copying. Inspect the workflow in the destination repository and perform a real manual Actions run only after configuring secrets. No live end-to-end scrape/delivery has been verified in Arena.

## Publishing tasks for the IDE agent

1. Confirm the active GitHub account and that `elulishan42-sudo/tender-hunter-egp` does not already contain unrelated work. Do not overwrite an existing repository.
2. Create the new private repository if absent. Arena's GitHub integration could not create it (`Resource not accessible by integration`). Your IDE's GitHub connection may have the needed access.
3. Copy only the standalone project contents into a separate local directory and publish them. Do not remove or modify the original checkout. Ensure the EGP workflow is on the destination's default branch so schedule/manual dispatch are available.
4. Ask the owner to configure the secrets below directly through GitHub Settings or an interactive local secret-management command. Do not ask them to paste credentials into agent chat.
5. Verify a manual workflow run and Telegram delivery. TenderFlow delivery should remain disabled unless the owner explicitly requests otherwise.
6. Report the new repository URL and Actions result. Ask the owner before disabling the original EGP workflow; leave 2Merkato alone.

## Secrets cannot be exported from GitHub

The EGP workflow references:

- `TELEGRAM_BOT_TOKEN_EGP`
- `TELEGRAM_USER_ID_EGP`
- `TENDERFLOW_API_KEY`

GitHub repository secret values are write-only. Even broader API permissions cannot retrieve them. The owner must supply them from their original secure storage directly to the new repository, or grant the destination access to equivalent organization secrets where available. Do not extract values by printing them in Actions logs, committing them, or uploading secret artifacts. No 2Merkato credentials are needed. `GITHUB_TOKEN` is automatically provided for each Actions run and is not copied.

A plaintext credential exists in the original project's API contract. It was deliberately excluded from this extraction; do not copy/reuse it. Recommend rotation through the service owner.

## Important behavior and cutover caveats

- **TenderFlow sending is disabled in the original and remains disabled here.** The API client and secret wiring are retained. The endpoint in the code differs from the old API contract; this extraction preserves the code's endpoint.
- Existing filtering, scheduling, and delivery/error semantics are preserved, including pre-existing limitations documented in the standalone README.
- Actions caches are repository-scoped. The destination starts empty and may resend all eligible tenders on its first run. Do not commit cache data. Coordinate a secure cache migration separately if needed.
- Both repositories running the EGP workflow can send duplicate Telegram digests. Disable the original EGP workflow only after the replacement is verified and the owner approves.

## Fetching the Arena work into an IDE

From an existing local clone of `elulishan42-sudo/tender-hunter`, first ensure local changes are saved, then:

```sh
git fetch origin arena/01a07d53-tender-hunter
git switch --track origin/arena/01a07d53-tender-hunter
```

If that local branch already exists, use `git switch arena/01a07d53-tender-hunter` instead. Inspect the branch before incorporating changes; do not discard local work. Read this file and `standalone/egp/README.md`, then follow the publishing tasks above.

If using the downloadable archive instead, it includes this handoff and `standalone/egp/`; extract it into a fresh directory and follow the same steps. The archive intentionally contains no credentials or Git history.
