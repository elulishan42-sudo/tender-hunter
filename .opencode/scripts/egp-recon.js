#!/usr/bin/env node
/**
 * EGP Reconnaissance
 *
 * Captures network activity + rendered DOM from production.egp.gov.et so we
 * can decide between (a) hitting the backing JSON API directly or (b) DOM
 * scraping. Run once, share the output back, then we pick an approach.
 *
 * Usage: node .opencode/scripts/egp-recon.js
 * Output:
 *   .data/egp-recon.json      — structured report of every non-static request
 *   .data/egp-listing.html    — fully-rendered listing HTML
 *   .data/egp-detail.html     — fully-rendered detail HTML
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../..');
const DATA_DIR = path.join(REPO_ROOT, '.data');
const REPORT_FILE = path.join(DATA_DIR, 'egp-recon.json');
const LISTING_HTML = path.join(DATA_DIR, 'egp-listing.html');
const DETAIL_HTML = path.join(DATA_DIR, 'egp-detail.html');

const LISTING_URL = 'https://production.egp.gov.et/egp/bids/all';
const DETAIL_URL = 'https://production.egp.gov.et/egp/bids/all/purchasing/f5935a86-2b1c-4f0e-8586-89b7f40a3a06/open';

// nginx on this host rejects curl-default UA; Playwright's default works but
// be explicit so we can reproduce with fetch() later if we find an API.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const MAX_BODY = 4000;

function truncate(s, n = MAX_BODY) {
  if (s == null) return s;
  return s.length > n ? s.slice(0, n) + `… [truncated ${s.length - n} chars]` : s;
}

async function capturePage(browser, label, url) {
  const context = await browser.newContext({ userAgent: UA });
  const page = await context.newPage();

  const requests = [];
  const inflight = new Map();

  page.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'font', 'stylesheet', 'media'].includes(type)) return;
    inflight.set(req, {
      url: req.url(),
      method: req.method(),
      resourceType: type,
      postData: truncate(req.postData() || null, 2000),
      requestHeaders: req.headers(),
      startedAt: Date.now(),
    });
  });

  page.on('response', async (res) => {
    const entry = inflight.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    entry.responseHeaders = res.headers();
    entry.durationMs = Date.now() - entry.startedAt;

    const ct = (res.headers()['content-type'] || '').toLowerCase();
    if (ct.includes('json') || ct.includes('text/plain')) {
      try {
        const body = await res.text();
        entry.responseBody = truncate(body);
        entry.responseBodyLength = body.length;
      } catch (e) {
        entry.responseBodyError = e.message;
      }
    } else {
      entry.responseBodyContentType = ct;
    }
    requests.push(entry);
  });

  page.on('requestfailed', (req) => {
    const entry = inflight.get(req);
    if (!entry) return;
    entry.failure = req.failure() && req.failure().errorText;
    requests.push(entry);
  });

  console.log(`\n=== ${label}: ${url} ===`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // Angular hydration + initial XHRs. Don't block on networkidle alone — some
  // gov portals keep a long-poll open and never settle.
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {
    console.log('  (networkidle timeout — capturing what we have)');
  });
  await page.waitForTimeout(3000);

  const html = await page.content();
  const title = await page.title();
  const visibleTextLength = await page.evaluate(() => document.body.innerText.length).catch(() => 0);

  await context.close();
  return { label, url, title, htmlLength: html.length, visibleTextLength, requests, html };
}

function isApiish(r) {
  const ct = (r.responseHeaders && r.responseHeaders['content-type']) || '';
  if (ct.toLowerCase().includes('json')) return true;
  if (r.resourceType === 'xhr' || r.resourceType === 'fetch') return true;
  return false;
}

(async () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const listing = await capturePage(browser, 'LISTING', LISTING_URL);
    fs.writeFileSync(LISTING_HTML, listing.html);

    const detail = await capturePage(browser, 'DETAIL', DETAIL_URL);
    fs.writeFileSync(DETAIL_HTML, detail.html);

    const report = {
      capturedAt: new Date().toISOString(),
      userAgent: UA,
      listing: { ...listing, html: `(saved to ${path.relative(REPO_ROOT, LISTING_HTML)})` },
      detail: { ...detail, html: `(saved to ${path.relative(REPO_ROOT, DETAIL_HTML)})` },
    };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

    const summarize = (cap) => {
      console.log(`\n--- ${cap.label} summary ---`);
      console.log(`  Title: ${cap.title}`);
      console.log(`  HTML length: ${cap.htmlLength}  |  visible text: ${cap.visibleTextLength}`);
      console.log(`  Requests captured: ${cap.requests.length}`);
      const apiCalls = cap.requests.filter(isApiish);
      console.log(`  API-ish calls: ${apiCalls.length}`);
      apiCalls.slice(0, 30).forEach(r => {
        const u = r.url.length > 120 ? r.url.slice(0, 117) + '...' : r.url;
        console.log(`    ${r.method.padEnd(5)} ${String(r.status || '-').padEnd(3)} ${u}`);
      });
    };
    summarize(listing);
    summarize(detail);

    console.log(`\n✅ Report:      ${path.relative(REPO_ROOT, REPORT_FILE)}`);
    console.log(`   Listing DOM: ${path.relative(REPO_ROOT, LISTING_HTML)}`);
    console.log(`   Detail DOM:  ${path.relative(REPO_ROOT, DETAIL_HTML)}`);
  } finally {
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
