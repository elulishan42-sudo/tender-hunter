# Support multiple Telegram recipients for the digest

## Context
- Currently the bot delivers to exactly **one** chat: `sendToTelegram` (tender-scraper.js:1011-1029)
  sends to a single `config.telegram.userId`, and the workflow's failure-notify step
  (tender-hunter.yml) targets the single `TELEGRAM_USER_ID` secret.
- Goal: a second user (who already started `@TenderHunt32bot`) should also receive digests.
- Decision (user): new user receives **going-forward only** — no historical backfill. The shared
  dedup cache already prevents re-sending tenders to user 1, so broadcasting the same `filtered`
  list to all IDs gives both users every *new* tender with no duplicates. Minimal change.
- The actual chat IDs stay in the `TELEGRAM_USER_ID` secret (and optionally the gitignored
  `tender-config.json`); **no ID is hardcoded in code**.

## Approach
Treat `TELEGRAM_USER_ID` as a **comma/whitespace-separated list** of chat IDs. Broadcast every
Telegram message (digest chunks + failure alert) to all of them. Parse defensively so a single
ID still works (backward compatible). The list of IDs in this secret is the **allowlist** — only
those chats ever receive a message.

## Access control (only the two authorized users)
Requirement: only you and the new friend may receive digests — not anyone else who starts
`@TenderHunt32bot`.

Verified by code inspection: the bot is a **one-way notifier**. `sendToTelegram` only ever
messages the chat IDs parsed from `TELEGRAM_USER_ID`; there is **no inbound handling** (no
`getUpdates`/webhook/`bot.on('message')`/command processing anywhere in the script — grep found
none). A stranger who starts the bot receives nothing, because nothing sends to them. Therefore
the `TELEGRAM_USER_ID` secret *is* the allowlist and the access-control requirement is already
satisfied by construction.

Implementation must preserve this invariant:
- Never introduce code that derives a chat_id from an inbound Telegram message and sends a digest
  to it. All outbound chat_ids come solely from `TELEGRAM_USER_ID`.
- Keep `TELEGRAM_USER_ID` set to exactly the two authorized IDs: `<your existing ID>,5058164773`.
  (The new friend's ID is `5058164773`; your own ID stays as the current secret value — do not
  drop it.) This value lives only in the GitHub secret, never in code.
- The stale "Handle Telegram commands for dynamic control" claim was already removed from the
  agent doc, so future maintainers aren't tempted to add an open inbound handler.

## Changes — `tender-scraper.js`

1. Add a parser (near config helpers):
```js
// Accepts "id1, id2", "id1 id2", ["id1","id2"], etc. → trimmed, deduped array.
function parseUserIds(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map(s => String(s).trim()).filter(Boolean))];
  if (!raw) return [];
  return [...new Set(String(raw).split(/[\s,;]+/).map(s => s.trim()).filter(Boolean))];
}
```

2. `config` shape (line ~100): `telegram: { botToken: '', userIds: [] }` (rename `userId` → `userIds`).

3. `loadConfig()` env branch (line 125): replace
   `config.telegram.userId = process.env.TELEGRAM_USER_ID || '';`
   with `config.telegram.userIds = parseUserIds(process.env.TELEGRAM_USER_ID);`
   In the config-file branch, after `deepMerge`, normalize so either `userId` (string/list) or
   `userIds` (array) populates `config.telegram.userIds`:
```js
config.telegram = config.telegram || {};
config.telegram.userIds = parseUserIds(config.telegram.userIds && config.telegram.userIds.length
  ? config.telegram.userIds : config.telegram.userId);
```

4. `sendToTelegram()` (line 1011): broadcast to the list:
```js
async function sendToTelegram(message) {
  if (!config.telegram.botToken || !config.telegram.userIds.length) {
    console.log('Telegram not configured');
    console.log(message.substring(0, 500));
    return false;
  }
  let any = false;
  for (const chatId of config.telegram.userIds) {
    try {
      const res = await fetchWithRetry(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' })
      });
      const result = await res.json();
      if (result.ok) { console.log(`✅ Sent to Telegram (chat ${chatId})`); any = true; }
      else console.error(`Telegram error (chat ${chatId}):`, result.description);
    } catch (e) { console.error(`Fetch error (chat ${chatId}):`, e.message); }
  }
  return any;
}
```
   `sendChunks` already calls `sendToTelegram(chunk)`, so all chunks broadcast to all users unchanged.

## Changes — `.github/workflows/tender-hunter.yml` (failure-notify step)
The current `curl` passes the raw secret as a single `chat_id`, which breaks for a comma list.
Loop over the IDs instead (keep the token in an env var, not the URL):
```yaml
      - name: Notify on failure
        if: failure()
        env:
          TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          IDS: ${{ secrets.TELEGRAM_USER_ID }}
        run: |
          IFS=',' read -ra ARR <<< "$IDS"
          for id in "${ARR[@]}"; do
            curl -s -X POST "https://api.telegram.org/bot$TOKEN/sendMessage" \
              -H "Content-Type: application/json" \
              -d "{\"chat_id\":\"$id\",\"text\":\"⚠️ Tender Hunter run failed at $(date -u). Check the Actions log.\",\"parse_mode\":\"Markdown\"}"
          done
```

## Changes — docs / example
- `.opencode/data/tender-config.json.example`: note `telegram.userId` may be a single ID or a
  comma-separated list (or `telegram.userIds: ["id1","id2"]`).
- `.opencode/agents/tender-hunter.md`: note `TELEGRAM_USER_ID` can hold multiple comma-separated IDs.

## Validation
1. Parse check (local, no secrets needed): `node -e "..."` or a quick run with
   `TELEGRAM_USER_ID="id1, id2 ,id3"` and `FORCE_DIGEST=true` → logs confirm broadcast to 3 chats
   (or "not configured" if token absent, which still proves parsing).
2. Real: update the repo `TELEGRAM_USER_ID` secret to `<your existing ID>,5058164773`
   (comma-separated; keep your own ID, append the new friend's `5058164773`). Run the workflow via
   `workflow_dispatch`. Both users confirm they received the digest (new tenders only).
3. Access-control check: confirm a third, unauthorized chat that starts the bot receives nothing.
   This is guaranteed structurally (no inbound handler, outbound is gated to the secret list), but
   can be spot-checked by starting the bot from another account and observing no message arrives.
4. Failure path: the bash loop is POSIX-shell safe; optionally sanity-check by temporarily pointing
   `TOKEN` at a dummy to confirm it iterates without syntax errors (expect 401 per chat).

## Risks / notes
- If a listed chat hasn't started the bot, that one gets a 403 while others still receive the
  message (sent independently). The new user already started the bot, so this is fine.
- No historical backfill (per decision): the second user only gets tenders from the next run onward.
- IDs remain secrets — nothing is committed to the repo.
- Granting access to anyone else later = adding their ID to `TELEGRAM_USER_ID`. There is no other
  code path that can message a chat, so the secret is the single control point.
