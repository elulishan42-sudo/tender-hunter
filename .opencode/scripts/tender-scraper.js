#!/usr/bin/env node
/**
 * Tender Hunter - Scrapes 2Merkato.com with category filters and sends daily digest to Telegram
 * Without visible browser - runs headlessly
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../data/tender-config.json');
const CACHE_FILE = path.join(__dirname, '../data/tender-cache.json');

const DEFAULT_FILTERS = { freshness: 'new', cost: 'all', deadline: 'any', status: 'open' };

// Your target categories mapped to 2Merkato category IDs
const CATEGORY_IDS = {
  'Laboratory Equipment': '61bbe243cfb36d443e895a20',
  'Laboratory Chemicals': '61bbe243cfb36d443e895a20',
  'Educational Equipments': '61bbe243cfb36d443e895a60',
  'Agricultural Equipments': '61bbe243cfb36d443e895a54',
  'Veterinary Equipments': '61bbe243cfb36d443e895a70',
  'Medical Equipments': '61bbe243cfb36d443e895a19',
};

let config = {
  telegram: { botToken: '', userId: '' },
  merkato: { email: '', password: '' },
  categories: Object.keys(CATEGORY_IDS)
};

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
      // Preserve default categories if not in config
      config = { ...config, ...loaded };
      if (!config.categories || config.categories.length === 0) {
        config.categories = Object.keys(CATEGORY_IDS);
      }
      return config.filters || DEFAULT_FILTERS;
    }
  } catch (e) { console.error('Config error:', e.message); }
  return DEFAULT_FILTERS;
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
    await page.waitForTimeout(2000);
    
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

async function scrapeCategory(browser, categoryId, categoryName) {
  const page = await browser.newPage();
  const tenders = [];
  
  try {
    const url = `https://tender.2merkato.com/tenders?categories=${categoryId}&page=1`;
    console.log(`Scraping ${categoryName}...`);
    
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    
    const data = await page.evaluate((cat) => {
      const results = [];
      const links = document.querySelectorAll('a[href*="/tenders/"]');
      
      links.forEach(a => {
        const href = a.href;
        const match = href.match(/\/tenders\/([a-z0-9]+)$/);
        if (!match) return;
        
        const id = match[1];
        const text = a.textContent || '';
        if (text.length < 30) return;
        
        const card = a.closest('[class*="card"], [class*="item"], article, [class*="bg-white"]') || a.parentElement;
        const cardText = card ? card.textContent : text;
        
        const title = text.trim().substring(0, 80);
        
        const closeMatch = cardText.match(/Bid closing date[:\s]*([A-Za-z]{3}\s+\d+,\s+\d{4})/i);
        const bidClosingDate = closeMatch ? closeMatch[1].trim() : 'TBD';
        
        const daysMatch = cardText.match(/(\d+)\s*days?\s*left/i);
        const daysLeft = daysMatch ? parseInt(daysMatch[1]) : 999;
        
        const isFree = cardText.includes('FREE') || !cardText.includes('Buy Now');
        
        results.push({
          id: id + '-' + cat,
          tenderId: id,
          url: href,
          title,
          bidClosingDate,
          daysLeft,
          isFree,
          category: cat
        });
      });
      
      return [...new Map(results.map(r => [r.id, r])).values()];
    }, categoryName);
    
    tenders.push(...data);
    
  } catch (e) {
    console.log(`Error scraping ${categoryName}:`, e.message);
  } finally {
    await page.close();
  }
  
  return tenders;
}

async function scrapeTenders() {
  const browser = await chromium.launch({ 
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  
  const allTenders = [];
  
  try {
    // Login first
    await login(await browser.newPage());
    
    // Scrape each category
    for (const [catName, catId] of Object.entries(CATEGORY_IDS)) {
      const tenders = await scrapeCategory(browser, catId, catName);
      allTenders.push(...tenders);
      console.log(`  Found ${tenders.length} in ${catName}`);
    }
    
    console.log(`Total tenders found: ${allTenders.length}`);
    
  } finally {
    await browser.close();
  }
  
  return allTenders;
}

function filterTenders(tenders, filters, cache) {
  const cachedIds = new Set(cache.tenders.map(t => t.tenderId));
  
  return tenders.filter(t => {
    if (filters.freshness === 'new' && cachedIds.has(t.tenderId)) return false;
    if (filters.cost === 'free' && !t.isFree) return false;
    if (filters.status === 'open' && t.daysLeft <= 0) return false;
    if (filters.deadline === '7days' && t.daysLeft > 7) return false;
    if (filters.deadline === '14days' && t.daysLeft > 14) return false;
    if (filters.deadline === '30days' && t.daysLeft > 30) return false;
    return true;
  });
}

function formatDigest(tenders, filters) {
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  
  if (tenders.length === 0) {
    return `📋 TENDER DIGEST\n━━━━━━━━━━━━━━━━━\n📅 ${today}\n\n✅ No new tenders matching filters.\n\n⚙️ /settings to change`;
  }
  
  // Group by category
  const byCategory = {};
  tenders.forEach(t => {
    if (!byCategory[t.category]) byCategory[t.category] = [];
    byCategory[t.category].push(t);
  });
  
  // Limit total tenders (Telegram 4096 char limit)
  const MAX_TENDERS = 15;
  const displayTenders = tenders.slice(0, MAX_TENDERS);
  const overflow = tenders.length - MAX_TENDERS;
  
  let msg = `📋 TENDER DIGEST\n━━━━━━━━━━━━━━━━━\n📅 ${today} | ${tenders.length} tender(s)\n🏷️ ${config.categories.slice(0, 3).join(', ')}${config.categories.length > 3 ? '...' : ''}\n\n`;
  
  // Show first few tenders from each category
  let count = 0;
  for (const [cat, catTenders] of Object.entries(byCategory)) {
    if (count >= MAX_TENDERS) break;
    msg += `📁 *${cat}:*\n`;
    for (const t of catTenders.slice(0, 3)) {
      if (++count > MAX_TENDERS) break;
      const days = t.daysLeft < 999 ? `${t.daysLeft}d` : 'Open';
      const free = t.isFree ? '🆓' : '💰';
      msg += `${free} ${t.title.substring(0, 60)}\n   🔗 ${t.url}\n\n`;
    }
    msg += '\n';
  }
  
  if (overflow > 0) {
    msg += `⚠️ +${overflow} more tenders (visit tender.2merkato.com)\n`;
  }
  
  msg += `━━━━━━━━━━━━━━━━━\n/settings /run`;
  return msg;
}

async function sendToTelegram(message) {
  if (!config.telegram.botToken || !config.telegram.userId) {
    console.log('Telegram not configured');
    console.log(message.substring(0, 500));
    return false;
  }
  
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
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
  console.log('Categories:', config.categories.join(', '));
  console.log('Filters:', JSON.stringify(filters));
  
  const allTenders = await scrapeTenders();
  console.log(`Scraped: ${allTenders.length}`);
  
  const filtered = filterTenders(allTenders, filters, cache);
  console.log(`Filtered: ${filtered.length}`);
  
  const msg = formatDigest(filtered, filters);
  const sent = await sendToTelegram(msg);
  
  if (sent) {
    saveCache({ 
      tenders: [...cache.tenders, ...filtered].slice(-100), 
      lastRun: new Date().toISOString() 
    });
  }
  
  return sent;
}

main().then(s => process.exit(s ? 0 : 1)).catch(e => { console.error(e); process.exit(1); });
