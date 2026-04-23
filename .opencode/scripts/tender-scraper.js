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
const CACHE_FILE = path.join(__dirname, '../data/tender-cache.json');

// TenderFlow API — user is identified by the Bearer token, no separate user_id needed
const TENDERFLOW_API = 'https://tender-flow-v2.vercel.app/api/agent/ingest-tenders';
const TENDERFLOW_API_KEY = process.env.TENDERFLOW_API_KEY || '';

const DEFAULT_FILTERS = { freshness: 'new', cost: 'all', deadline: 'any', status: 'open' };

// 2Merkato category IDs
// (Lab Equipment & Chemicals share one ID on 2Merkato)
const CATEGORY_IDS = {
  'Laboratory Equipment & Chemicals': '61bbe243cfb36d443e895a20',
  'Educational Equipments': '61bbe243cfb36d443e895a60',
  'Agricultural Equipments': '61bbe243cfb36d443e895a54',
  'Veterinary Equipments': '61bbe243cfb36d443e895a70',
  'Medical Equipments': '61bbe243cfb36d443e895a19',
};

// Map to TenderFlow categories
const CATEGORY_MAP = {
  'Laboratory Equipment & Chemicals': 'Lab & Chemicals',
  'Educational Equipments': 'Education & Stationery',
  'Agricultural Equipments': 'Vet & Agri',
  'Veterinary Equipments': 'Vet & Agri',
  'Medical Equipments': 'Medical',
};

// EGP (production.egp.gov.et) — their taxonomy is Goods/Works/Services/Consultancy,
// which doesn't map to TenderFlow's category enum. Keyword-match against lot text
// into the same 4 target categories we already pull from 2Merkato. Unmatched bids
// are dropped so we stay on-target and within the 200/day API budget.
const EGP_API = 'https://production.egp.gov.et/po-gw/cms-v2/api/sourcing/get-grouped-sourcing';
const EGP_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const EGP_CATEGORY_KEYWORDS = {
  'Lab & Chemicals':        ['laborator', 'chemical', 'reagent', 'scientific', 'microscope', 'analyzer', 'spectro'],
  'Medical':                ['medical', 'medicine', 'hospital', 'pharmaceutic', 'surgical', 'clinic', 'dental', 'drug', 'health'],
  'Vet & Agri':             ['agricultur', 'veterinary', 'livestock', 'seed', 'fertilizer', 'irrigation', 'farm', 'animal', 'crop', 'tractor'],
  'Education & Stationery': ['school', 'educational', 'university', 'textbook', 'stationery', 'classroom', 'teach'],
};

function matchEgpCategory(text) {
  const lower = (text || '').toLowerCase();
  for (const [category, keywords] of Object.entries(EGP_CATEGORY_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return category;
  }
  return null;
}

let config = {
  telegram: { botToken: '', userId: '' },
  merkato: { email: '', password: '' },
  categories: Object.keys(CATEGORY_IDS)
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
      if (!config.categories || config.categories.length === 0) {
        config.categories = Object.keys(CATEGORY_IDS);
      }
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

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {}
  return { tenders: [], lastRun: null };
}

function saveCache(cache) {
  cache.lastRun = new Date().toISOString();
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
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
    // Wait until Vue has actually rendered substantive content instead of a fixed 3s
    await page.waitForFunction(() => document.body.innerText.length > 500, { timeout: 5000 }).catch(() => {});

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
    const results = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/tenders/"]');

    links.forEach(a => {
      const href = a.href;
      const match = href.match(/\/tenders\/([a-z0-9]+)$/);
      if (!match) return;
      const tenderId = match[1];
      if (seen.has(tenderId)) return;

      const text = a.textContent || '';
      if (text.length <= 30) return;

      seen.add(tenderId);

      const card = a.closest('[class*="card"], [class*="item"], article, [class*="bg-white"]') || a.parentElement;
      const cardText = card ? card.textContent : '';

      const title = text.trim().substring(0, 100);

      const closeMatch = cardText.match(/Bid closing date[:\s]*([A-Za-z]{3}\s+\d+,\s+\d{4})/i);
      const bidClosingDate = closeMatch ? closeMatch[1].trim() : '';

      const daysMatch = cardText.match(/(\d+)\s*days?\s*left/i);
      const daysLeft = daysMatch ? parseInt(daysMatch[1]) : null;

      const isFree = cardText.includes('FREE') || !cardText.includes('Buy Now');

      results.push({ tenderId, url: href, title, bidClosingDate, daysLeft, isFree });
    });

    return results;
  });
}

async function scrapeCategory(browser, categoryId, categoryName) {
  const page = await browser.newPage();
  await blockResources(page);
  const tenders = [];
  const maxTendersPerCategory = 20;

  try {
    console.log(`Scraping ${categoryName}...`);

    // Scrape up to 2 pages
    for (let pageNum = 1; pageNum <= 2; pageNum++) {
      if (tenders.length >= maxTendersPerCategory) break;

      const url = `https://tender.2merkato.com/tenders?categories=${categoryId}&page=${pageNum}`;

      // Collect all card data from the listing page FIRST (fixes navigation bug)
      const cards = await scrapeListingPage(page, url);

      if (cards.length === 0) {
        if (pageNum === 1) console.log('  No tenders found on listing page');
        break;
      }

      console.log(`  Page ${pageNum}: ${cards.length} tenders, fetching details...`);

      const remaining = maxTendersPerCategory - tenders.length;
      for (const card of cards.slice(0, remaining)) {
        // Navigate to detail page — card data was already captured above
        const details = await getTenderDetails(page, card.url);

        // Parse deadline to ISO format
        let isoDeadline = details.deadline || '';
        if (!isoDeadline && card.bidClosingDate) {
          try {
            const date = new Date(card.bidClosingDate);
            if (!isNaN(date)) {
              isoDeadline = date.toISOString();
            }
          } catch (e) {}
        }

        tenders.push({
          tenderId: card.tenderId,
          url: card.url,
          title: card.title,
          tenderNumber: details.tenderNumber || '',
          publishingEntity: details.publishingEntity || 'Unknown',
          deadline: isoDeadline,
          daysLeft: card.daysLeft,
          isFree: card.isFree,
          category: CATEGORY_MAP[categoryName] || 'General',
          sourceCategory: categoryName,
          tenderType: details.tenderType || 'local',
          notes: details.notes || '',
          sourcePortal: '2merkato',
        });

        // Rate limit between detail page requests
        await page.waitForTimeout(200);
      }
    }

    console.log(`  Got ${tenders.length} with full details`);

  } catch (e) {
    console.log(`Error scraping ${categoryName}:`, e.message);
  } finally {
    await page.close();
  }

  return tenders;
}

async function scrapeEgp() {
  // Pull the newest bids across all sectors, then keyword-filter into our 4 target
  // categories. `top=100` is a sensible default — enough to catch daily inflow
  // (at ~571 total open bids, newest 100 spans a few days) without over-fetching.
  const url = `${EGP_API}?type=all&skip=0&top=100&locale=en&orderBy=invitationDate%20desc`;
  console.log('Fetching EGP listings...');

  let data;
  try {
    const res = await fetchWithRetry(url, {
      headers: { 'User-Agent': EGP_USER_AGENT, 'Accept': 'application/json' },
    });
    if (!res.ok) {
      console.log(`  EGP fetch failed: HTTP ${res.status}`);
      return [];
    }
    data = await res.json();
  } catch (e) {
    console.log(`  EGP fetch error: ${e.message}`);
    return [];
  }

  const now = new Date();
  const MAX_FUTURE_MS = 2 * 365 * 24 * 60 * 60 * 1000; // skip obvious data-entry typos (e.g. year 2125)
  const tenders = [];
  let droppedPastDeadline = 0;
  let droppedFarFuture = 0;
  let droppedOffCategory = 0;

  for (const item of data.items || []) {
    for (const bid of item.result || []) {
      if (!bid.submissionDeadline) { droppedPastDeadline++; continue; }
      const deadline = new Date(bid.submissionDeadline);
      if (isNaN(deadline) || deadline <= now) { droppedPastDeadline++; continue; }
      if (deadline - now > MAX_FUTURE_MS) { droppedFarFuture++; continue; }

      const text = `${bid.lotName || ''} ${bid.lotDescription || ''}`;
      const category = matchEgpCategory(text);
      if (!category) { droppedOffCategory++; continue; }

      const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
      const sourceApp = (bid.sourceApplication || 'purchasing').toLowerCase();

      tenders.push({
        tenderId: `egp-${bid.id}`,
        url: `https://production.egp.gov.et/egp/bids/all/${sourceApp}/${bid.id}/open`,
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

  console.log(`  EGP: ${tenders.length} matched (dropped: ${droppedOffCategory} off-category, ${droppedPastDeadline} past, ${droppedFarFuture} far-future) out of ${data.total ?? '?'} total`);
  return tenders;
}

async function scrapeTenders() {
  // Let Playwright use its own managed Chromium — no hardcoded executablePath
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const allTenders = [];
  const seenIds = new Set();

  try {
    // Login on a dedicated page, then close it (cookies persist in the browser context)
    const loginPage = await browser.newPage();
    await blockResources(loginPage);
    const loggedIn = await login(loginPage);
    await loginPage.close();

    if (!loggedIn) {
      console.log('Failed to login, exiting');
      return [];
    }

    // Scrape all categories in parallel — they share the browser context (and login cookies)
    const categoryResults = await Promise.all(
      Object.entries(CATEGORY_IDS).map(([catName, catId]) =>
        scrapeCategory(browser, catId, catName).catch(e => {
          console.log(`Category ${catName} failed: ${e.message}`);
          return [];
        })
      )
    );

    // Deduplicate across categories within a single run
    for (const tenders of categoryResults) {
      for (const t of tenders) {
        if (!seenIds.has(t.tenderId)) {
          seenIds.add(t.tenderId);
          allTenders.push(t);
        }
      }
    }

    console.log(`Total unique tenders scraped: ${allTenders.length}`);

  } finally {
    await browser.close();
  }

  return allTenders;
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

function formatDigest(tenders) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  if (tenders.length === 0) {
    return `📋 TENDER DIGEST — ${today}
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

  // Cap at 15 to stay comfortably under Telegram's 4096-char message limit
  // given the richer per-tender block.
  const MAX_TENDERS = 15;
  const visible = sortable.slice(0, MAX_TENDERS).map(s => s.t);
  const overflow = tenders.length - visible.length;

  // Group visible tenders by category (sort is stable, so within-category order
  // is still soonest-deadline-first).
  const byCategory = {};
  visible.forEach(t => {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  });

  const categoryCount = Object.keys(byCategory).length;

  let msg = `📋 TENDER DIGEST — ${today}\n`;
  msg += `${tenders.length} new tender${tenders.length === 1 ? '' : 's'}`;
  msg += ` · ${categoryCount} categor${categoryCount === 1 ? 'y' : 'ies'}`;
  msg += `\n━━━━━━━━━━━━━━━━━━━━`;

  for (const [cat, catTenders] of Object.entries(byCategory)) {
    const emoji = CATEGORY_EMOJI[cat] || '📋';
    msg += `\n\n${emoji} *${cat}* (${catTenders.length})`;

    for (const t of catTenders) {
      const rawTitle = (t.title || 'Untitled').substring(0, 80);
      const title = escapeTelegramMarkdown(rawTitle) + ((t.title || '').length > 80 ? '…' : '');
      msg += `\n\n▸ [${title}](${t.url})`;

      if (t.publishingEntity && t.publishingEntity !== 'Unknown') {
        msg += `\n  ${escapeTelegramMarkdown(t.publishingEntity.substring(0, 50))}`;
      }

      if (t.deadline) {
        const deadline = new Date(t.deadline);
        if (!isNaN(deadline)) {
          const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
          const dateStr = deadline.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          let label;
          if (daysLeft < 0) label = `closed ${Math.abs(daysLeft)}d ago`;
          else if (daysLeft === 0) label = 'closes today';
          else if (daysLeft === 1) label = 'closes tomorrow';
          else label = `${daysLeft} days left`;
          msg += `\n  📅 ${label} · ${dateStr}`;
        }
      }

      const typeLabel = t.tenderType === 'import' ? '🌐 Import' : '🏠 Local';
      const portal = t.sourcePortal || '2merkato';
      msg += `\n  🏷 ${typeLabel} · ${portal}`;
    }
  }

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

async function main() {
  console.log('=== Tender Hunter ===');
  const filters = loadConfig();
  const cache = loadCache();

  console.log('Scraping 2Merkato + EGP in parallel...');
  const [merkatoTenders, egpTenders] = await Promise.all([
    scrapeTenders().catch(e => {
      console.error(`2Merkato failed: ${e.message}`);
      return [];
    }),
    scrapeEgp().catch(e => {
      console.error(`EGP failed: ${e.message}`);
      return [];
    }),
  ]);

  const allTenders = [...merkatoTenders, ...egpTenders];
  console.log(`Total scraped: 2Merkato=${merkatoTenders.length} + EGP=${egpTenders.length} = ${allTenders.length}`);

  if (allTenders.length === 0) {
    console.error('Both sources returned 0 tenders — possible auth or site issue');
    return false;
  }

  const filtered = filterTenders(allTenders, filters, cache);
  console.log(`New tenders: ${filtered.length}`);

  // Send to TenderFlow first
  console.log('\nSending to TenderFlow...');
  const tfResult = await sendToTenderFlow(filtered);

  // Format and send Telegram digest
  const msg = formatDigest(filtered);
  const sent = await sendToTelegram(msg);

  if (!tfResult.success && !sent) {
    console.error('Both TenderFlow and Telegram delivery failed');
    return false;
  }

  // Update cache — attach fingerprints so future runs dedup even if 2Merkato changes the URL/ID
  const filteredWithFingerprint = filtered.map(t => ({ ...t, fingerprint: computeFingerprint(t) }));
  saveCache({
    tenders: [...cache.tenders, ...filteredWithFingerprint].slice(-2000),
    lastRun: new Date().toISOString()
  });

  return true;
}

main().then(s => process.exit(s ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
