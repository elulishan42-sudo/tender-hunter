#!/usr/bin/env node
/**
 * Tender Hunter - Scrapes 2Merkato.com with category filters and sends to:
 * 1. TenderFlow API (for dashboard)
 * 2. Telegram (for daily digest)
 */

const { chromium } = require('playwright');
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
  /\bservices?\b/i,
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

let config = {
  telegram: { botToken: '', userId: '' },
  merkato: { email: '', password: '' },
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

function loadConfig() {
  // Check environment variables first (for GitHub Actions)
  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
    config.telegram.userId = process.env.TELEGRAM_USER_ID || '';
    config.merkato.email = process.env.MERKATO_EMAIL || '';
    config.merkato.password = process.env.MERKATO_PASSWORD || '';
    return DEFAULT_FILTERS;
  }

  // Fall back to config file
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      config = deepMerge(config, loaded);
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

// Block resources we don't need for text scraping — big walltime win on every navigation
async function blockResources(page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'font' || type === 'media') {
      return route.abort();
    }
    route.continue();
  });
}

async function login(page) {
  if (!config.merkato.email || !config.merkato.password) {
    console.log('No login credentials');
    return false;
  }

  try {
    console.log('Logging in...');
    await page.goto('https://tender.2merkato.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#emailOrMobile', { timeout: 10000 });

    await page.fill('#emailOrMobile', config.merkato.email);
    await page.fill('input[type="password"]', config.merkato.password);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/tenders**', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);

    if (!page.url().includes('/login')) {
      console.log('✅ Logged in');
      return true;
    }
    return false;
  } catch (e) {
    console.log('Login error:', e.message);
    return false;
  }
}

async function getTenderDetails(page, tenderUrl) {
  try {
    await page.goto(tenderUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait until Vue has actually rendered substantive content. 2s is enough for
    // most pages; the ones that don't make it are likely broken anyway and we
    // proceed with whatever's loaded — the catch hides the timeout.
    await page.waitForFunction(() => document.body.innerText.length > 500, { timeout: 2000 }).catch(() => {});

    const details = await page.evaluate(() => {
      const text = document.body.innerText;

      // Extract tender number
      let tenderNumber = '';
      const refPatterns = [
        /Reference\s*#?[:\s]*([A-Z0-9\/\-]+)/i,
        /Tender\s*#?[:\s]*([A-Z0-9\/\-]+)/i,
        /Bid\s*#?[:\s]*([A-Z0-9\/\-]+)/i,
        /No\.?\s*([A-Z0-9\/\-]+)/,
      ];
      for (const pattern of refPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          tenderNumber = match[1].trim();
          break;
        }
      }

      // Extract organization name
      let publishingEntity = '';
      const orgPatterns = [
        /(?:By|Organization|Company|Agency|Entity)[:\s]*([A-Za-z0-9\s&',\.]+?)(?:\n|$)/i,
        /(?:Procuring|Buyer)[:\s]*([A-Za-z0-9\s&',\.]+?)(?:\n|$)/i,
      ];
      for (const pattern of orgPatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          publishingEntity = match[1].trim().substring(0, 100);
          break;
        }
      }

      // Extract deadline
      let deadline = '';
      const deadlinePatterns = [
        /Bid\s*closing[:\s]*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:?\d{0,2}\s*(?:AM|PM)?)/i,
        /Closing\s*date[:\s]*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
        /Deadline[:\s]*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
      ];
      for (const pattern of deadlinePatterns) {
        const match = text.match(pattern);
        if (match && match[1]) {
          const dateStr = match[1].trim();
          try {
            const date = new Date(dateStr);
            if (!isNaN(date) && date > new Date()) {
              deadline = date.toISOString();
            }
          } catch (e) {}
          if (!deadline) deadline = dateStr;
          break;
        }
      }

      // Extract description snippet
      let notes = '';
      const descMatch = text.match(/Description[:\s]*(.{0,200})/i);
      if (descMatch && descMatch[1]) {
        notes = descMatch[1].trim().substring(0, 200);
      }

      // Check for import keywords using word boundaries to avoid false positives
      const importPatterns = [
        /\binternational competitive bidding\b/i,
        /\bICB\b/,
        /\bimport(?:ed|ing|s)?\b/i,
        /\bforeign supplier/i,
        /\binternational supplier/i,
        /\bletter of credit\b/i,
        /\bL\/C\b/,
        /\bCIF\b/,
        /\bFOB\b/,
      ];
      const isImport = importPatterns.some(p => p.test(text));

      return { tenderNumber, publishingEntity, deadline, notes, tenderType: isImport ? 'import' : 'local' };
    });

    return details;
  } catch (e) {
    console.log('Error getting tender details:', e.message);
    return {};
  }
}

// Collect all card data from a listing page BEFORE navigating away
async function scrapeListingPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Wait for the actual tender cards to render instead of a fixed 5s
  await page.waitForSelector('a[href*="/tenders/"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(500);

  return page.evaluate(() => {
    // Listings can have multiple <a> tags per tender (title link, "view"
    // button, sometimes a wrapper around the whole card). The whole-card
    // wrapper gives a textContent that mashes metadata + title together
    // like "Bid closing date:Jun 09, 2026...Procurement of X". To avoid
    // picking that garbage, we collect ALL links per tenderId and then
    // pick the best title via a small heuristic.
    const linksByTender = new Map();
    document.querySelectorAll('a[href*="/tenders/"]').forEach(a => {
      const href = a.href;
      const match = href.match(/\/tenders\/([a-z0-9]+)(?:[/?#]|$)/);
      if (!match) return;
      const tenderId = match[1];
      // Skip non-tender paths like /tenders/popular or /tenders/recent
      if (tenderId.length < 10) return;

      if (!linksByTender.has(tenderId)) {
        const card = a.closest('[class*="card"], [class*="item"], article, [class*="bg-white"]') || a.parentElement;
        linksByTender.set(tenderId, {
          card,
          cardText: card ? card.textContent : '',
          links: [],
        });
      }
      linksByTender.get(tenderId).links.push({
        url: href,
        text: (a.textContent || '').trim(),
      });
    });

    // A "title-shaped" string isn't too short, isn't too long, and doesn't
    // start with a known metadata prefix (the wrapper-link symptom).
    const METADATA_PREFIX = /^(Bid\s*(closing|opening)|Closing\s*date|Opening\s*date|Published\b|FREE\b|Buy Now|View Detail|\d+\s*days?\s*left)/i;
    const isTitleShaped = (text) =>
      text.length >= 10 && text.length <= 300 && !METADATA_PREFIX.test(text);

    function pickTitle(card, links) {
      // 1) Prefer a heading element inside the card
      if (card) {
        for (const sel of ['h1', 'h2', 'h3', 'h4', 'h5', '[class*="title"]', '[class*="subject"]']) {
          const el = card.querySelector(sel);
          if (el) {
            const t = el.textContent.trim();
            if (isTitleShaped(t)) return t;
          }
        }
      }
      // 2) Among link texts, pick the shortest that's title-shaped (longer ones
      //    are usually wrapper links that concatenate metadata)
      const goodLinks = links.filter(l => isTitleShaped(l.text));
      if (goodLinks.length > 0) {
        return goodLinks.reduce((a, b) => a.text.length <= b.text.length ? a : b).text;
      }
      // 3) Last resort: take the longest available text, trimmed
      const longest = links.reduce((a, b) => a.text.length >= b.text.length ? a : b, { text: '' });
      return longest.text || 'Untitled';
    }

    function pickUrl(links) {
      // The link whose text matches our chosen title is ideal, but for simplicity
      // we use the first link's url — they all point at the same tenderId anyway.
      return links[0] ? links[0].url : '';
    }

    const results = [];
    for (const [tenderId, { card, cardText, links }] of linksByTender) {
      const title = pickTitle(card, links);
      // (the actual link href is ignored — we use a canonical URL below)
      void pickUrl(links);

      const closeMatch = cardText.match(/Bid closing date[:\s]*([A-Za-z]{3}\s+\d+,\s+\d{4})/i);
      const bidClosingDate = closeMatch ? closeMatch[1].trim() : '';

      const daysMatch = cardText.match(/(\d+)\s*days?\s*left/i);
      const daysLeft = daysMatch ? parseInt(daysMatch[1]) : null;

      const isFree = cardText.includes('FREE') || !cardText.includes('Buy Now');

      // Canonical URL — always points exactly at the tender detail page,
      // independent of whatever the listing card linked to.
      const canonicalUrl = `https://tender.2merkato.com/tenders/${tenderId}`;
      results.push({ tenderId, url: canonicalUrl, title, bidClosingDate, daysLeft, isFree });
    }

    return results;
  });
}

// Build a tender object from a listing card + (optionally) detail-page output.
// Used by both the success and detail-fetch-failed paths so we never silently
// drop a card just because the detail page broke.
function buildMerkatoTender(card, details) {
  details = details || {};
  let isoDeadline = details.deadline || '';
  if (!isoDeadline && card.bidClosingDate) {
    try {
      const date = new Date(card.bidClosingDate);
      if (!isNaN(date)) isoDeadline = date.toISOString();
    } catch (e) {}
  }
  // Last-ditch fallback: if both detail- and listing-card date parsers failed
  // but the listing card *did* surface a "N days left" count, synthesize a
  // deadline from now + N. The pre-filter already validated card.daysLeft was
  // in window, so this keeps the tender from being dropped post-detail just
  // because the page format shifted out from under our regex.
  if (!isoDeadline && card.daysLeft != null && card.daysLeft > 0) {
    const synth = new Date();
    synth.setDate(synth.getDate() + card.daysLeft);
    isoDeadline = synth.toISOString();
  }

  // Bucket via keyword on title + notes (description). Falls through to 'General'.
  const text = `${card.title || ''} ${details.notes || ''}`;
  const category = matchCategory(text) || 'General';

  return {
    tenderId: card.tenderId,
    url: card.url,
    title: card.title,
    tenderNumber: details.tenderNumber || '',
    publishingEntity: details.publishingEntity || 'Unknown',
    deadline: isoDeadline,
    daysLeft: card.daysLeft,
    isFree: card.isFree,
    category,
    sourceCategory: '',
    tenderType: details.tenderType || 'local',
    notes: details.notes || '',
    sourcePortal: '2merkato',
  };
}

async function scrapeMerkato(cache) {
  // Incremental scrape: 2Merkato's listing is sorted newest-first, so we walk
  // sequentially from page 1 and stop as soon as a page contributes ZERO new
  // (uncached) tenderIds — meaning everything beyond is older and we've caught
  // up since the last run. Steady-state runs touch 1 page; cold start (empty
  // cache) walks up to MAX_PAGES once, then never again.
  const MAX_PAGES = 15;             // safety cap; incremental runs stop way earlier
  const MAX_TOTAL = 100;            // cold-start cap — captures most-recent N. Real-time use
                                    // case: new posts arrive every 30 min, not bulk backfill.
                                    // Each subsequent run picks up new posts within the cache window.
  const DETAIL_CONCURRENCY = 10;
  const cachedIds = new Set((cache?.tenders || []).map(t => t.tenderId));

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const tenders = [];

  try {
    const loginPage = await browser.newPage();
    await blockResources(loginPage);
    const loggedIn = await login(loginPage);
    await loginPage.close();

    if (!loggedIn) {
      console.log('Failed to login, skipping 2Merkato');
      return { tenders: [], processedIds: [] };
    }

    console.log(`Scraping 2Merkato (incremental; ${cachedIds.size} cached IDs)...`);

    const listingPage = await browser.newPage();
    await blockResources(listingPage);
    const detailPages = [];
    for (let i = 0; i < DETAIL_CONCURRENCY; i++) {
      const p = await browser.newPage();
      await blockResources(p);
      detailPages.push(p);
    }

    const now = new Date();

    // Phase 1: sequential listing pagination with early termination
    const candidates = [];                          // cards that survived pre-filters and need detail-fetch
    const seenIds = new Set();
    let droppedExcluded = 0, droppedOutOfWindow = 0, alreadyCached = 0;
    let stoppedReason = `hit MAX_PAGES (${MAX_PAGES})`;

    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (candidates.length >= MAX_TOTAL) { stoppedReason = `MAX_TOTAL (${MAX_TOTAL})`; break; }

      const url = `https://tender.2merkato.com/tenders?page=${pageNum}`;
      const cards = await scrapeListingPage(listingPage, url);

      if (cards.length === 0) { stoppedReason = 'empty page'; break; }

      let newOnPage = 0;
      for (const c of cards) {
        if (seenIds.has(c.tenderId)) continue;
        seenIds.add(c.tenderId);

        if (cachedIds.has(c.tenderId)) { alreadyCached++; continue; }
        newOnPage++; // counts ALL uncached cards (even ones we'll drop) so the early-termination signal isn't masked by keyword/window filters

        if (isExcluded(c.title)) { droppedExcluded++; continue; }
        if (c.daysLeft != null && (c.daysLeft <= 2 || c.daysLeft >= 30)) { droppedOutOfWindow++; continue; }

        candidates.push(c);
      }

      console.log(`  Listing page ${pageNum}: ${cards.length} cards, ${newOnPage} uncached, ${candidates.length} candidates so far`);

      // If a page yields zero uncached tenderIds, every subsequent page (older posts) is cached too.
      if (newOnPage === 0) { stoppedReason = 'caught up'; break; }
    }

    console.log(`  Listing done — ${stoppedReason}. Pre-filter dropped ${droppedExcluded} excluded, ${droppedOutOfWindow} out-of-window by daysLeft; ${alreadyCached} cards already cached.`);

    if (candidates.length === 0) {
      console.log('  No new tenders to fetch details for');
      await Promise.all([listingPage, ...detailPages].map(p => p.close().catch(() => {})));
      return { tenders: [], processedIds: [] };
    }

    console.log(`  Fetching details for ${candidates.length} new candidates (concurrency ${DETAIL_CONCURRENCY})`);

    // Phase 2: parallel detail fetches via worker pool. Failed details still
    // produce a tender with listing-only data — never silently lose one.
    let detailCursor = 0;
    let droppedPostDetail = 0;
    const processedIds = [];   // every candidate we detail-fetched, so the caller can cache them
    const fetchDetail = async (page) => {
      while (detailCursor < candidates.length) {
        const i = detailCursor++;
        const card = candidates[i];
        processedIds.push(card.tenderId);
        let t;
        try {
          const details = await getTenderDetails(page, card.url);
          t = buildMerkatoTender(card, details);
        } catch (e) {
          console.log(`  Detail fetch failed for ${card.tenderId}: ${e.message}`);
          t = buildMerkatoTender(card, null);
        }
        // If no deadline could be extracted at any layer (detail regex, listing
        // bidClosingDate, daysLeft synthesis), default to 14 days out so the
        // tender still flows. Better to show it with an estimated deadline than
        // silently drop a truly-new tender because of a parse mismatch.
        const parsed = t.deadline ? new Date(t.deadline) : null;
        if (!parsed || isNaN(parsed)) {
          t.deadline = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
          t.deadlineEstimated = true;
        }
        if (isDeadlineInWindow(t.deadline, now)) {
          tenders.push(t);
        } else {
          droppedPostDetail++;
        }
        await page.waitForTimeout(150);
      }
    };

    await Promise.all(detailPages.map(p => fetchDetail(p)));

    const droppedSuffix = droppedPostDetail > 0 ? ` (dropped ${droppedPostDetail} out-of-window after detail)` : '';
    console.log(`  2Merkato: got ${tenders.length} tenders${droppedSuffix}`);

    await Promise.all([listingPage, ...detailPages].map(p => p.close().catch(() => {})));

    return { tenders, processedIds };
  } finally {
    await browser.close();
  }
}

async function scrapeEgp(cache) {
  // Incremental scrape: orderBy=invitationDate desc means newest bids come first,
  // so once a page yields zero uncached tenderIds we've caught up — every page
  // beyond is older and already in cache.
  const TOP = 100;
  const MAX_PAGES = 50; // cold-start safety cap (~5000 bids)
  const cachedIds = new Set((cache?.tenders || []).map(t => t.tenderId));

  console.log(`Fetching EGP listings (incremental; ${cachedIds.size} cached IDs)...`);

  const now = new Date();
  const tenders = [];
  let droppedOutOfWindow = 0, droppedExcluded = 0, mappedToGeneral = 0, alreadyCached = 0;
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

        if (!isDeadlineInWindow(bid.submissionDeadline, now)) { droppedOutOfWindow++; continue; }
        if (EXCLUDED_PROCUREMENT_CATEGORIES.has(bid.procurementCategory)) { droppedExcluded++; continue; }
        const text = `${bid.lotName || ''} ${bid.lotDescription || ''}`;
        if (isExcluded(text)) { droppedExcluded++; continue; }

        const matched = matchCategory(text);
        const category = matched || 'General';
        if (!matched) mappedToGeneral++;

        const deadline = new Date(bid.submissionDeadline);
        const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
        const sourceApp = (bid.sourceApplication || 'purchasing').toLowerCase();
        // Purchasing bids load via /purchasing-quotation-invitations/api/get-quotation-invitation,
        // which is public and accepts bid.sourceId (NOT bid.id — that returns 204 No Content).
        // Tendering / Auctioning / Prequalification all require auth, so we link to the
        // listing page where users can search by the tender_number we already include.
        const urlId = bid.sourceId || bid.id;
        const refForHash = (bid.lotReferenceNo || bid.procurementReferenceNo || bid.id).trim();
        // encodeURIComponent leaves parens unescaped, which breaks Telegram
        // markdown link syntax [title](url). Force-escape them.
        const hashRef = encodeURIComponent(refForHash).replace(/\(/g, '%28').replace(/\)/g, '%29');
        const sourceLink = sourceApp === 'purchasing'
          ? `https://production.egp.gov.et/egp/bids/all/${sourceApp}/${urlId}/open`
          // Non-Purchasing detail pages require auth and hang for most users.
          // Land on the listing page with the reference as a hash fragment so
          // each tender has a UNIQUE source_link (avoids TenderFlow's
          // duplicate_source_link rejection) and the user can search by the
          // reference visible in the digest.
          : `https://production.egp.gov.et/egp/bids/all#${hashRef}`;

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
        });
      }
    }

    console.log(`  EGP page ${pages + 1}: ${pageBids} bids, ${newOnPage} uncached, ${tenders.length} accepted so far`);

    if (pageBids === 0) { stoppedReason = 'empty page'; break; }
    if (newOnPage === 0) { stoppedReason = 'caught up'; break; }

    skip += pageBids;
  }

  console.log(`  EGP done — ${stoppedReason}. ${tenders.length} accepted (${mappedToGeneral} as General; dropped ${droppedExcluded} excluded, ${droppedOutOfWindow} out-of-window; ${alreadyCached} already cached).`);
  // EGP has no detail-fetch step, so there's no "processed but dropped" set to cache.
  return { tenders, processedIds: [] };
}

function filterTenders(tenders, filters, cache) {
  const cachedIds = new Set(cache.tenders.map(t => t.tenderId));
  const cachedFingerprints = new Set(cache.tenders.map(t => t.fingerprint).filter(Boolean));

  return tenders.filter(t => {
    if (filters.freshness === 'new') {
      if (cachedIds.has(t.tenderId)) return false;
      const fp = computeFingerprint(t);
      if (fp && cachedFingerprints.has(fp)) return false;
    }
    if (filters.cost === 'free' && !t.isFree) return false;
    // daysLeft is null when unknown — don't filter out tenders with unknown deadlines
    if (filters.status === 'open' && t.daysLeft !== null && t.daysLeft <= 0) return false;
    if (filters.deadline === '7days' && t.daysLeft !== null && t.daysLeft > 7) return false;
    if (filters.deadline === '14days' && t.daysLeft !== null && t.daysLeft > 14) return false;
    if (filters.deadline === '30days' && t.daysLeft !== null && t.daysLeft > 30) return false;
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
        source_portal: t.sourcePortal || '2merkato',
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

const CATEGORY_EMOJI = {
  'Lab & Chemicals': '🔬',
  'Education & Stationery': '📚',
  'Vet & Agri': '🌾',
  'Medical': '🏥',
  'Electronics & IT': '💻',
  'Car & Auto': '🚗',
  'Cleaning & Janitorial': '🧹',
  'Food & Institutional': '🍽',
  'General': '📋',
  'Other': '📋',
};

function formatDigest(tenders, sourceLabel) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const header = sourceLabel ? `📋 ${sourceLabel.toUpperCase()} DIGEST — ${today}` : `📋 TENDER DIGEST — ${today}`;

  if (tenders.length === 0) {
    return `${header}
━━━━━━━━━━━━━━━━━━━━

No new tenders found today.

━━━━━━━━━━━━━━━━━━━━
✅ Sent to TenderFlow`;
  }

  // Sort by soonest deadline first; tenders without valid future deadlines go last.
  const now = new Date();
  const nowMs = now.getTime();
  const sortable = tenders.map(t => {
    const ms = t.deadline ? new Date(t.deadline).getTime() : NaN;
    return { t, ms, valid: !isNaN(ms) && ms >= nowMs };
  });
  sortable.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    return a.ms - b.ms;
  });

  // Pack tenders dynamically — keep their titles FULL (no per-tender truncation)
  // and stop adding once we'd push the message past Telegram's 4096-char limit.
  // Reserve ~200 chars of headroom for header, separators, and the footer.
  const TELEGRAM_LIMIT = 4096;
  const FOOTER_RESERVE = 200;

  // Group ALL sorted tenders by category; we'll iterate in sorted order so the
  // per-category sub-arrays stay soonest-deadline-first.
  const byCategory = {};
  for (const s of sortable) {
    if (!byCategory[s.t.category]) byCategory[s.t.category] = [];
    byCategory[s.t.category].push(s.t);
  }

  const categoryCount = Object.keys(byCategory).length;

  let msg = `${header}\n`;
  msg += `${tenders.length} new tender${tenders.length === 1 ? '' : 's'}`;
  msg += ` · ${categoryCount} categor${categoryCount === 1 ? 'y' : 'ies'}`;
  msg += `\n━━━━━━━━━━━━━━━━━━━━`;

  let included = 0;
  let stopped = false;
  for (const [cat, catTenders] of Object.entries(byCategory)) {
    if (stopped) break;
    const emoji = CATEGORY_EMOJI[cat] || '📋';
    const catHeader = `\n\n${emoji} *${cat}* (${catTenders.length})`;
    if (msg.length + catHeader.length + FOOTER_RESERVE > TELEGRAM_LIMIT) { stopped = true; break; }
    msg += catHeader;

    for (const t of catTenders) {
      // Full title — escape markdown specials, no length truncation.
      const title = escapeTelegramMarkdown(t.title || 'Untitled');
      let block = `\n\n▸ [${title}](${t.url})`;
      if (t.publishingEntity && t.publishingEntity !== 'Unknown') {
        block += `\n  ${escapeTelegramMarkdown(t.publishingEntity)}`;
      }
      if (msg.length + block.length + FOOTER_RESERVE > TELEGRAM_LIMIT) { stopped = true; break; }
      msg += block;
      included++;
    }
  }

  const overflow = tenders.length - included;
  msg += `\n\n━━━━━━━━━━━━━━━━━━━━`;
  if (overflow > 0) {
    msg += `\n+${overflow} more in dashboard`;
  }
  msg += `\n✅ Sent to TenderFlow`;
  return msg;
}

async function sendToTelegram(message) {
  if (!config.telegram.botToken || !config.telegram.userId) {
    console.log('Telegram not configured');
    console.log(message.substring(0, 500));
    return false;
  }

  try {
    const res = await fetchWithRetry(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: config.telegram.userId, text: message, parse_mode: 'Markdown' })
    });
    const result = await res.json();
    if (result.ok) { console.log('✅ Sent to Telegram!'); return true; }
    console.error('Telegram error:', result.description);
  } catch (e) { console.error('Fetch error:', e.message); }
  return false;
}

// Combined run: both sources sequentially in one workflow invocation. Each
// source has its own cache file (separate dedup state); both rely on the
// incremental scrape + early-termination path so warm-cache runs finish in seconds.
const SOURCES = [
  { key: 'merkato', label: '2Merkato', scrape: scrapeMerkato },
  { key: 'egp',     label: 'EGP',      scrape: scrapeEgp },
];

async function runSource({ key, label, scrape }, filters) {
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

  // Build the set of tenderIds we should add to cache as "skip-only" — those we
  // detail-fetched (or otherwise paid the cost on) but did not push as tenders.
  // Caching them prevents the same dead-ends from re-running every 30 min.
  const tenderIdSet = new Set(tenders.map(t => t.tenderId));
  const skipOnlyIds = processedIds.filter(id => !tenderIdSet.has(id));
  const skipOnlyEntries = skipOnlyIds.map(id => ({ tenderId: id, fingerprint: null }));

  const persistCache = (extras) => {
    saveCache(key, {
      tenders: [...cache.tenders, ...skipOnlyEntries, ...extras].slice(-5000),
      lastRun: new Date().toISOString(),
    });
  };

  if (tenders.length === 0) {
    // Still save the skip-only entries so we don't re-fetch the same dropped candidates.
    if (skipOnlyEntries.length > 0) persistCache([]);
    console.log(`${label}: nothing new to process${skipOnlyEntries.length ? ` (cached ${skipOnlyEntries.length} skip-only IDs)` : ''}`);
    return { ok: true, sent: 0 };
  }

  const filtered = filterTenders(tenders, filters, cache);
  console.log(`${label}: ${filtered.length} new after fingerprint filter`);

  if (filtered.length === 0) {
    // Tenders all matched a known fingerprint. Cache them so we don't re-fetch.
    const skipFp = tenders.map(t => ({ tenderId: t.tenderId, fingerprint: computeFingerprint(t) }));
    persistCache(skipFp);
    return { ok: true, sent: 0 };
  }

  console.log(`${label}: sending to TenderFlow...`);
  const tfResult = await sendToTenderFlow(filtered);

  const msg = formatDigest(filtered, label);
  const sent = await sendToTelegram(msg);

  if (!tfResult.success && !sent) {
    console.error(`${label}: both TenderFlow and Telegram delivery failed`);
  }

  const filteredWithFingerprint = filtered.map(t => ({ ...t, fingerprint: computeFingerprint(t) }));
  persistCache(filteredWithFingerprint);

  return { ok: true, sent: filtered.length };
}

async function main() {
  console.log(`=== Tender Hunter — combined run @ ${new Date().toISOString()} ===`);
  const filters = loadConfig();

  let anyOk = false;
  let totalSent = 0;
  for (const source of SOURCES) {
    const result = await runSource(source, filters);
    if (result.ok) {
      anyOk = true;
      totalSent += result.sent || 0;
    }
  }

  console.log(`\n=== Run complete: ${totalSent} new tender(s) sent across all sources ===`);
  return anyOk;
}

main().then(s => process.exit(s ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
