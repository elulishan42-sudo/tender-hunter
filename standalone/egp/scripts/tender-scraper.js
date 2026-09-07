#!/usr/bin/env node
/**
 * Standalone Tender Hunter — EGP bids.
 * Telegram digests; TenderFlow client retained but delivery disabled, as upstream.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '../data/tender-config.json');
// Caches are per-source — the two scraper workflows run on different schedules
// and shouldn't clobber each other's cache file mid-run.
const cacheFile = (source) => path.join(__dirname, `../data/tender-cache-${source}.json`);

// TenderFlow API — user is identified by the Bearer token, no separate user_id needed
const TENDERFLOW_API = 'https://tender-flow-v2.vercel.app/api/agent/ingest-tenders';
const TENDERFLOW_API_KEY = process.env.TENDERFLOW_API_KEY || '';

const DEFAULT_FILTERS = { freshness: 'new', cost: 'all', deadline: 'any', status: 'open' };

const EGP_API = 'https://production.egp.gov.et/po-gw/cms-v2/api/sourcing/get-grouped-sourcing';
const EGP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Both sources use the same keyword bucket — neither EGP's broad Goods/Works/Services
// taxonomy nor 2Merkato's per-category-ID approach maps cleanly to TenderFlow's
// category enum. We tag based on title + description; tenders that match nothing
// fall through as 'General' rather than being dropped. Order matters — first match wins.
const CATEGORY_KEYWORDS = {
  'Lab & Chemicals':        ['laborator', 'chemical', 'reagent', 'scientific', 'microscope', 'spectro', 'analyzer'],
  'Vet & Agri':             ['agricultur', 'veterinary', 'livestock', 'seed', 'fertilizer', 'irrigation', 'farm', 'crop', 'tractor'],
  'Medical':                ['medical', 'medicine', 'hospital', 'pharmaceutic', 'surgical', 'clinic', 'dental', 'health', 'nursing', 'patient', 'pharmacy', 'syringe', 'ppe'],
  'Electronics & IT':       ['computer', 'laptop', 'desktop', 'server', 'software', 'network', 'router', 'printer', 'ict', 'tablet'],
  'Education & Stationery': ['school', 'educational', 'university', 'textbook', 'stationery', 'classroom', 'teach', 'student'],
  'Car & Auto':             ['vehicle', 'spare part', 'tyre', 'tire', 'truck', 'automobile', 'minibus', 'pickup'],
  'Cleaning & Janitorial':  ['cleaning', 'janitorial', 'sanitation', 'hygiene', 'detergent', 'disinfect'],
  'Food & Institutional':   ['catering', 'kitchen', 'flour', 'grain', 'meal', 'foodstuff'],
};

function matchCategory(text) {
  const lower = (text || '').toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return null;
}

// User-excluded categories — applied to both sources. EGP also has a structured
// procurementCategory field we can use; 2Merkato we have to keyword-match on title.
// Word-boundary regex so "buildings" doesn't match "build", etc.
const EXCLUDED_PROCUREMENT_CATEGORIES = new Set(['Services', 'Consultancy', 'Works']);
const EXCLUDE_PATTERNS = [
  /\bconsultanc(y|ies)\b/i,
  /\bconsultan(t|ts)\b/i,
  /\bconsulting\b/i,
  /\bconstruction\b/i,
  /\brenovation\b/i,
  /\brehabilitation\b/i,
  /\bcivil works?\b/i,
  // Bare /\bservices?\b/ was too aggressive — it killed every Merkato card
  // mentioning the word (cleaning services, office services, etc.) even
  // when they were product procurements. Narrow to phrases that clearly
  // mean a service contract.
  /\bprovision\s+of\s+(?:\w+\s+){0,1}services?\b/i,
  /\bservice\s+(contract|provision|agreement)\b/i,
  /\b(audit|training|advisory|legal|financial|maintenance)\s+services?\b/i,
  /\boutsourc(ing|ed)\b/i,
];

function isExcluded(text) {
  return EXCLUDE_PATTERNS.some(p => p.test(text || ''));
}

// Deadline window: tenders must close in (now + 2d, now + 30d) AND within
// the current calendar year. Applied to both sources so they stay consistent.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function isDeadlineInWindow(deadlineLike, now) {
  if (!deadlineLike) return false;
  const d = deadlineLike instanceof Date ? deadlineLike : new Date(deadlineLike);
  if (isNaN(d)) return false;
  const days = (d - now) / ONE_DAY_MS;
  if (days <= 2 || days >= 30) return false;
  if (d.getFullYear() !== now.getFullYear()) return false;
  return true;
}

function deadlineWindowStatus(deadlineLike, now) {
  if (!deadlineLike) return 'invalid';
  const d = deadlineLike instanceof Date ? deadlineLike : new Date(deadlineLike);
  if (isNaN(d)) return 'invalid';
  if (d.getFullYear() !== now.getFullYear()) return 'wrong-year';
  const days = (d - now) / ONE_DAY_MS;
  if (days <= 2) return 'too-soon';
  if (days >= 30) return 'too-far';
  return 'in-window';
}

let config = {
  telegram: { botToken: '', userIds: [] },
};

// Deep merge that preserves nested objects instead of overwriting them
function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) &&
      target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

// Accepts id1, id2 / id1 id2 / [id1,id2] -> trimmed, deduped array.
function parseUserIds(raw) {
  if (Array.isArray(raw)) return [...new Set(raw.map(x => String(x).trim()).filter(Boolean))];
  if (!raw) return [];
  return [...new Set(String(raw).split(/[\s,;]+/).map(x => x.trim()).filter(Boolean))];
}

function loadConfig() {
  // Check environment variables first (for GitHub Actions)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.telegram.userIds = parseUserIds(process.env.TELEGRAM_USER_ID);
    return DEFAULT_FILTERS;
  }

  // Fall back to config file
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = deepMerge(config, loaded);
      config.telegram = config.telegram || {};
      config.telegram.userIds = parseUserIds(config.telegram.userIds && config.telegram.userIds.length
        ? config.telegram.userIds : config.telegram.userId);
      return config.filters || DEFAULT_FILTERS;
    }
  } catch (e) { console.error('Config error:', e.message); }
  return DEFAULT_FILTERS;
}

// Mirrors TenderFlow's server-side dedup algorithm (AGENT_API_CONTRACT.md §Deduplication):
// sha256(lowercase(tender_name) + lowercase(publishing_entity) + deadline_date).
// If TenderFlow changes its algorithm, update this to match — otherwise dedup will drift
// and we'll waste API quota on tenders the server would have skipped anyway.
function computeFingerprint(tender) {
  const name = (tender.title || '').toLowerCase();
  const entity = (tender.publishingEntity || '').toLowerCase();
  if (!tender.deadline) return null;
  const d = new Date(tender.deadline);
  if (isNaN(d)) return null;
  const dateStr = d.toISOString().split('T')[0];
  return crypto.createHash('sha256').update(name + entity + dateStr).digest('hex');
}

function loadCache(source) {
  const file = cacheFile(source);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {}
  return { tenders: [], lastRun: null };
}

function saveCache(source, cache) {
  const file = cacheFile(source);
  cache.lastRun = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cache, null, 2));
}

function isCacheHitEntry(entry) {
  // Older caches stored every skip-only ID as { fingerprint: null }, including
  // future tenders that should later become eligible. Ignore those legacy
  // unmarked skips once; new permanent skips are explicitly marked below.
  return !!entry.fingerprint || entry.skipReason === 'permanent';
}

async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, options);
    } catch (e) {
      if (i === retries) throw e;
      console.log(`  Retry ${i + 1}/${retries} after error: ${e.message}`);
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

async function scrapeEgp(cache) {
  // Incremental scrape: orderBy=invitationDate desc means newest bids come first,
  // so once a page yields zero uncached tenderIds we've caught up — every page
  // beyond is older and already in cache.
  const TOP = 100;
  const MAX_PAGES = 50; // cold-start safety cap (~5000 bids)
  const cachedIds = new Set((cache?.tenders || []).filter(isCacheHitEntry).map(t => t.tenderId));

  console.log(`Fetching EGP listings (incremental; ${cachedIds.size} cached IDs)...`);

  const now = new Date();
  const tenders = [];
  const processedIds = [];   // accepted or permanently dropped bids that are safe to cache
  let droppedOutOfWindow = 0, droppedNonTendering = 0, deferredTooFar = 0, droppedExcluded = 0, mappedToGeneral = 0, alreadyCached = 0;
  let maintenanceDetected = false;
  let pages = 0, skip = 0;
  let stoppedReason = `MAX_PAGES (${MAX_PAGES})`;

  for (; pages < MAX_PAGES; pages++) {
    const url = `${EGP_API}?type=all&skip=${skip}&top=${TOP}&locale=en&orderBy=invitationDate%20desc`;
    let data;
    try {
      const res = await fetchWithRetry(url, {
        headers: { 'User-Agent': EGP_USER_AGENT, 'Accept': 'application/json' },
      });
        if (!res.ok) {
          console.log(`  EGP page ${pages + 1} failed: HTTP ${res.status}`);
          stoppedReason = `HTTP ${res.status}`;
          break;
        }
        // eGP returns its "system under maintenance" page as HTTP 200 with a
        // non-JSON body (text/html). Detect that explicitly so runSource can
        // fire a single one-time alert instead of producing silent runs.
        const contentType = res.headers.get('content-type') || '';
        if (contentType && !contentType.includes('application/json')) {
          console.log(`  EGP page ${pages + 1}: non-JSON response (${contentType}) — likely maintenance`);
          maintenanceDetected = true;
          stoppedReason = 'eGP maintenance';
          break;
        }
        data = await res.json();
    } catch (e) {
      console.log(`  EGP page ${pages + 1} error: ${e.message}`);
      stoppedReason = 'fetch error';
      break;
    }

    let pageBids = 0;
    let newOnPage = 0;

    for (const item of data.items || []) {
      for (const bid of item.result || []) {
        pageBids++;
        const tid = `egp-${bid.id}`;

        if (cachedIds.has(tid)) { alreadyCached++; continue; }
        newOnPage++; // counts ALL uncached bids (even ones we'll drop) so early-termination signal isn't masked

        const sourceApp = (bid.sourceApplication || '').toLowerCase();
        if (sourceApp !== 'tendering') { droppedNonTendering++; processedIds.push(tid); continue; }

        const deadlineStatus = deadlineWindowStatus(bid.submissionDeadline, now);
        if (deadlineStatus !== 'in-window') {
          if (deadlineStatus === 'too-far') {
            // Keep future tenders out of cache so they can enter the 30-day
            // window later and still be notified.
            deferredTooFar++;
          } else {
            droppedOutOfWindow++;
            processedIds.push(tid);
          }
          continue;
        }
        if (EXCLUDED_PROCUREMENT_CATEGORIES.has(bid.procurementCategory)) { droppedExcluded++; processedIds.push(tid); continue; }
        const text = `${bid.lotName || ''} ${bid.lotDescription || ''}`;
        if (isExcluded(text)) { droppedExcluded++; processedIds.push(tid); continue; }

        const matched = matchCategory(text);
        const category = matched || 'General';
        if (!matched) mappedToGeneral++;

        const deadline = new Date(bid.submissionDeadline);
        const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
        // Tender ("bid") detail pages are public — link straight to the bid
        // detail page using the internal bid.id. This mirrors the purchasing
        // ("proforma") route shape (/<module>/<id>/open); the purchasing fix
        // established that the front-end /open route keys on id, not sourceId.
        const sourceLink = `https://production.egp.gov.et/egp/bids/all/tendering/${bid.id}/open`;

        tenders.push({
          tenderId: tid,
          url: sourceLink,
          title: (bid.lotName || bid.lotDescription || 'Untitled').substring(0, 200).trim(),
          tenderNumber: (bid.lotReferenceNo || bid.procurementReferenceNo || '').trim(),
          publishingEntity: (bid.procuringEntity || 'Unknown').trim(),
          deadline: deadline.toISOString(),
          daysLeft,
          isFree: true,
          category,
          sourceCategory: bid.procurementCategory || '',
          tenderType: bid.marketPlace === 'International' ? 'import' : 'local',
          notes: (bid.lotDescription || '').substring(0, 200).trim(),
          sourcePortal: 'egp',
          postedAt: bid.invitationDate || bid.timestamp || null,
        });
        processedIds.push(tid);
      }
    }

    console.log(`  EGP page ${pages + 1}: ${pageBids} bids, ${newOnPage} uncached, ${tenders.length} accepted so far`);

    if (pageBids === 0) { stoppedReason = 'empty page'; break; }
    if (newOnPage === 0) { stoppedReason = 'caught up'; break; }

    skip += pageBids;
  }

  console.log(`  EGP done — ${stoppedReason}. ${tenders.length} accepted (${mappedToGeneral} as General; dropped ${droppedNonTendering} non-tendering, ${droppedExcluded} excluded, ${droppedOutOfWindow} permanent out-of-window; deferred ${deferredTooFar} too-far; ${alreadyCached} already cached; ${processedIds.length} processed this run).`);
  // processedIds excludes too-far future bids. Those should be reconsidered as
  // their deadlines approach; permanent drops are cached so EGP doesn't scan the
  // same dead ends every run.
  return { tenders, processedIds, maintenanceDetected };
}

function filterTenders(tenders, cache) {
  // Single job left: drop tenders we've already sent (by tenderId or by
  // matching fingerprint — same name+entity+deadline_date posted on a
  // different portal or under a re-issued ID). Window/cost/status filters
  // are handled upstream in the scrapers, so this stays minimal.
  const cachedIds = new Set(cache.tenders.filter(isCacheHitEntry).map(t => t.tenderId));
  const cachedFingerprints = new Set(cache.tenders.map(t => t.fingerprint).filter(Boolean));

  return tenders.filter(t => {
    if (cachedIds.has(t.tenderId)) return false;
    const fp = computeFingerprint(t);
    if (fp && cachedFingerprints.has(fp)) return false;
    return true;
  });
}

async function sendToTenderFlow(tenders) {
  if (!TENDERFLOW_API_KEY) {
    console.log('TenderFlow API key not configured');
    return { success: false, created: 0, skipped: 0 };
  }

  // Filter out tenders with past deadlines before sending
  const now = new Date();
  const validTenders = tenders.filter(t => {
    if (!t.deadline) return true; // will get default 30 days
    try {
      const deadline = new Date(t.deadline);
      return !isNaN(deadline) && deadline > now;
    } catch (e) {
      return true;
    }
  });

  console.log(`  Filtered out ${tenders.length - validTenders.length} tenders with past deadlines`);

  if (validTenders.length === 0) {
    console.log('No valid new tenders to send to TenderFlow');
    return { success: true, created: 0, skipped: 0 };
  }

  // Sort by soonest deadline first so the most urgent tenders land in TenderFlow
  // even if we hit the 200/day rate limit partway through the batches.
  validTenders.sort((a, b) => {
    const da = new Date(a.deadline || 0).getTime();
    const db = new Date(b.deadline || 0).getTime();
    return da - db;
  });

  // Batch into groups of 50
  const batches = [];
  for (let i = 0; i < validTenders.length; i += 50) {
    batches.push(validTenders.slice(i, i + 50));
  }

  let totalCreated = 0;
  let totalSkipped = 0;

  for (const batch of batches) {
    const payload = {
      tenders: batch.map(t => ({
        tender_name: t.title,
        publishing_entity: t.publishingEntity || 'Unknown',
        deadline: t.deadline || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        tender_number: t.tenderNumber || undefined,
        source_link: t.url,
        source_portal: t.sourcePortal || 'egp',
        category: t.category,
        tender_type: t.tenderType,
        bid_type: 'Open',
        currency: 'ETB',
        notes: t.notes || undefined,
      }))
    };

    try {
      const res = await fetchWithRetry(TENDERFLOW_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${TENDERFLOW_API_KEY}`,
        },
        body: JSON.stringify(payload)
      });

      // Handle non-JSON responses (HTML error pages, 404s, etc.)
      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        const text = await res.text();
        console.log(`  TenderFlow error: HTTP ${res.status} — returned non-JSON (${contentType || 'no content-type'})`);
        console.log(`  Response preview: ${text.substring(0, 200)}`);
        continue;
      }

      if (res.status === 401) {
        console.error('  TenderFlow: 401 Unauthorized — API key is wrong or missing. Aborting.');
        return { success: false, created: totalCreated, skipped: totalSkipped };
      }

      if (res.status === 429) {
        console.log('  TenderFlow: 429 Rate limited — daily limit reached. Stopping.');
        break;
      }

      const result = await res.json();

      if (res.status === 400) {
        console.log(`  TenderFlow: 400 Bad request — ${result.error || JSON.stringify(result)}`);
        continue;
      }

      if (result.created !== undefined) {
        totalCreated += result.created || 0;
        totalSkipped += result.skipped || 0;
        console.log(`  TenderFlow: ${result.created} created, ${result.skipped} skipped`);

        if (result.results) {
          result.results.forEach(r => {
            if (r.status === 'skipped') {
              console.log(`    - ${r.tender_name}: ${r.reason}`);
            }
          });
        }
      } else if (result.error) {
        console.log(`  TenderFlow error: ${result.error}`);
      }
    } catch (e) {
      console.log(`  TenderFlow fetch error: ${e.message}`);
    }

    // Rate limit between batches
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`TenderFlow: ${totalCreated} created, ${totalSkipped} skipped`);
  return { success: true, created: totalCreated, skipped: totalSkipped };
}

// Escape characters that break Telegram Markdown parsing
function escapeTelegramMarkdown(text) {
  return text.replace(/([*_`\[\]])/g, '\\$1');
}

// Turn an absolute timestamp into a short relative phrase. Returns null if
// the timestamp is missing/unparseable, or older than ~1 year (not useful).
function formatPostedAgo(isoTimestamp, now) {
  if (!isoTimestamp) return null;
  const t = new Date(isoTimestamp);
  if (isNaN(t)) return null;
  const ms = now - t;
  if (ms < 0) return null;
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(ms / 86_400_000);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return null;
}

// Days until a deadline, computed at call time. Returns null if unparseable.
function daysUntilClose(deadlineLike, now) {
  if (!deadlineLike) return null;
  const d = new Date(deadlineLike);
  if (isNaN(d)) return null;
  return Math.ceil((d - now) / (1000 * 60 * 60 * 24));
}

function formatDigest(tenders, sourceLabel) {
  const MAX_PER_MESSAGE = 10;
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const baseHeader = sourceLabel ? `📋 ${sourceLabel.toUpperCase()} DIGEST — ${today}` : `📋 TENDER DIGEST — ${today}`;

  if (tenders.length === 0) {
    return [`${baseHeader}
━━━━━━━━━━━━━━━━━━━━

No new tenders found today.

━━━━━━━━━━━━━━━━━━━━
✅ Sent to Telegram`];
  }

  const now = new Date();
  const sortable = tenders.map(t => {
    const ms = t.postedAt ? new Date(t.postedAt).getTime() : NaN;
    return { t, ms, valid: !isNaN(ms) };
  });
  sortable.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    return b.ms - a.ms;
  });

  const chunks = [];
  for (let i = 0; i < sortable.length; i += MAX_PER_MESSAGE) {
    const slice = sortable.slice(i, i + MAX_PER_MESSAGE);
    const chunkIndex = Math.floor(i / MAX_PER_MESSAGE) + 1;
    const totalChunks = Math.ceil(sortable.length / MAX_PER_MESSAGE);
    const header = totalChunks > 1
      ? `${baseHeader}${chunkIndex > 1 ? ` (continued ${chunkIndex}/${totalChunks})` : ''}`
      : baseHeader;

    let msg = `${header}\n`;
    msg += `${sortable.length} new tender${sortable.length === 1 ? '' : 's'}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━`;

    for (const { t } of slice) {
      const title = escapeTelegramMarkdown(t.title || 'Untitled');
      let block = `\n\n▸ [${title}](${t.url})`;
      if (t.publishingEntity && t.publishingEntity !== 'Unknown') {
        block += `\n  ${escapeTelegramMarkdown(t.publishingEntity)}`;
      }

      // Deadline line. days-until is computed at send time (more accurate
      // than the daysLeft frozen at scrape time). Labels: Closes today /
      // Closes tomorrow / Closes in N days / Deadline passed / Closes: —.
      const days = daysUntilClose(t.deadline, now);
      const dateLabel = t.deadline
        ? new Date(t.deadline).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : null;
      const closeLabel =
        days == null ? 'Closes: —'
          : days < 0 ? 'Deadline passed'
          : days === 0 ? 'Closes today'
          : days === 1 ? 'Closes tomorrow'
          : `Closes in ${days} days`;
      const closePart = dateLabel ? `${closeLabel} (${dateLabel})` : closeLabel;
      block += `\n  ${closePart}`;

      const ago = formatPostedAgo(t.postedAt, now);
      if (ago) {
        block += `\n  Posted ${ago}`;
      }

        // EGP links now go straight to the detail page, but showing the lot
        // reference is still handy for cross-referencing or quoting.
        if (t.sourcePortal === 'egp' && t.tenderNumber) {
        block += `\n  Ref: ${escapeTelegramMarkdown(t.tenderNumber)}`;
      }

      msg += block;
    }

    msg += `\n\n━━━━━━━━━━━━━━━━━━━━\n✅ Sent to Telegram`;
    chunks.push(msg);
  }

  return chunks;
}

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
      if (result.ok) { console.log(`Sent to Telegram (chat ${chatId})`); any = true; }
      else console.error(`Telegram error (chat ${chatId}):`, result.description);
    } catch (e) { console.error(`Fetch error (chat ${chatId}):`, e.message); }
  }
  return any;
}

// Send an array of message chunks, returning true if at least one was delivered.
async function sendChunks(chunks) {
  let any = false;
  for (const chunk of chunks) {
    any = (await sendToTelegram(chunk)) || any;
  }
  return any;
}

// This standalone project runs EGP only.
const SOURCES = [{ key: 'egp', label: 'EGP', scrape: scrapeEgp }];

async function runSource({ key, label, scrape }) {
  console.log(`\n--- ${label} ---`);
  const cache = loadCache(key);

  let result;
  try {
    result = await scrape(cache);
  } catch (e) {
    console.error(`${label} scrape failed: ${e.message}`);
    return { ok: false };
  }

  const tenders = result.tenders || [];
  const processedIds = result.processedIds || [];
  const maintenanceDetected = result.maintenanceDetected === true;

  // --- eGP maintenance handling ---
  // When eGP returns its maintenance page (HTTP 200, non-JSON content-type),
  // scrapeEgp sets maintenanceDetected. Send a single Telegram alert per
  // outage (tracked via the cache's maintenanceAlerted flag) so the user
  // knows the EGP digest is paused, then stay silent until the outage ends.
  if (maintenanceDetected) {
    if (!cache.maintenanceAlerted) {
      await sendToTelegram(
        `⚠️ eGP portal is under maintenance. The Tender Hunter (EGP bid) digest is paused and will resume automatically when the portal is back.`
      );
      console.log(`${label}: eGP maintenance detected — sent one-time alert`);
    } else {
      console.log(`${label}: eGP still under maintenance (alert already sent)`);
    }
    cache.maintenanceAlerted = true;
    saveCache(key, {
      tenders: cache.tenders,
      lastRun: new Date().toISOString(),
      maintenanceAlerted: cache.maintenanceAlerted || undefined,
    });
    return { ok: true, sent: 0 };
  }
  // Outage ended — clear the flag and persist so a future outage re-alerts.
  if (cache.maintenanceAlerted) {
    cache.maintenanceAlerted = false;
    saveCache(key, {
      tenders: cache.tenders,
      lastRun: new Date().toISOString(),
      maintenanceAlerted: cache.maintenanceAlerted || undefined,
    });
    console.log(`${label}: eGP is back — cleared maintenance flag`);
  }

  // Build the set of tenderIds we should add to cache as "skip-only" — those we
  // detail-fetched (or otherwise paid the cost on) but did not push as tenders.
  // Caching them prevents the same dead-ends from re-running every 30 min.
  const tenderIdSet = new Set(tenders.map(t => t.tenderId));
  const skipOnlyIds = processedIds.filter(id => !tenderIdSet.has(id));
  const skipOnlyEntries = skipOnlyIds.map(id => ({ tenderId: id, fingerprint: null, skipReason: 'permanent' }));

  const persistCache = (extras) => {
    saveCache(key, {
      // 10k cap: EGP alone runs ~650 entries + skip-only; raising the cap
      // means cards don't roll out of cache so fast that they re-appear as
      // "new" days later. ~1 MB per source — still trivial.
      tenders: [...cache.tenders, ...skipOnlyEntries, ...extras].slice(-10000),
      lastRun: new Date().toISOString(),
      maintenanceAlerted: cache.maintenanceAlerted || undefined,
    });
  };

  // On a manual run (FORCE_DIGEST), always emit a digest — even when there's
  // nothing new — so a quiet day is distinguishable from a broken run.
  const forceDigest = !!process.env.FORCE_DIGEST;

  if (tenders.length === 0) {
    // Still save the skip-only entries so we don't re-fetch the same dropped candidates.
    if (skipOnlyEntries.length > 0) persistCache([]);
    console.log(`${label}: nothing new to process${skipOnlyEntries.length ? ` (cached ${skipOnlyEntries.length} skip-only IDs)` : ''}`);
    if (forceDigest) await sendChunks(formatDigest([], label));
    return { ok: true, sent: 0 };
  }

  const filtered = filterTenders(tenders, cache);
  console.log(`${label}: ${filtered.length} new after fingerprint filter`);

  if (filtered.length === 0) {
    // Tenders all matched a known fingerprint. Cache them so we don't re-fetch.
    const skipFp = tenders.map(t => ({ tenderId: t.tenderId, fingerprint: computeFingerprint(t) }));
    persistCache(skipFp);
    if (forceDigest) await sendChunks(formatDigest([], label));
    return { ok: true, sent: 0 };
  }

  // TenderFlow DISABLED
  // To re-enable: replace the two lines below with:
  //   console.log(`${label}: sending to TenderFlow...`);
  //   const tfResult = await sendToTenderFlow(filtered);
  const tfResult = { success: true, created: 0, skipped: 0 };
  console.log(`${label}: TenderFlow send disabled — skipping`);

  const sent = await sendChunks(formatDigest(filtered, label));

  if (!tfResult.success && !sent) {
    console.error(`${label}: both TenderFlow and Telegram delivery failed`);
  }

  const filteredWithFingerprint = filtered.map(t => ({ ...t, fingerprint: computeFingerprint(t) }));
  persistCache(filteredWithFingerprint);

  return { ok: true, sent: filtered.length };
}

async function main() {
  console.log(`=== Tender Hunter run @ ${new Date().toISOString()} ===`);
  loadConfig();

  const sources = SOURCES;
  console.log(`Sources: ${sources.map(s => s.label).join(', ')}`);

  let anyOk = false;
  let totalSent = 0;
  for (const source of sources) {
    const result = await runSource(source);
    if (result.ok) {
      anyOk = true;
      totalSent += result.sent || 0;
    }
  }

  console.log(`\n=== Run complete: ${totalSent} new tender(s) sent ===`);
  return anyOk;
}

if (require.main === module) {
  main().then(s => process.exit(s ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = {
  scrapeEgp, matchCategory, isExcluded, isDeadlineInWindow, deadlineWindowStatus,
  computeFingerprint, isCacheHitEntry, filterTenders, formatDigest, parseUserIds,
  sendToTenderFlow, runSource, main,
};
