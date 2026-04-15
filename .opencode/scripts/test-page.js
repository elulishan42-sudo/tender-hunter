const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ 
    headless: true,
    executablePath: '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  
  console.log('Loading page...');
  await page.goto('https://tender.2merkato.com/tenders', { waitUntil: 'domcontentloaded', timeout: 60000 });
  
  // Wait for Vue to render
  console.log('Waiting for Vue...');
  await page.waitForTimeout(5000);
  
  // Try to get rendered content
  const content = await page.content();
  console.log('Content length:', content.length);
  
  // Look for tender links
  const links = await page.evaluate(() => {
    const els = document.querySelectorAll('a[href*="/tenders/"]');
    return Array.from(els)
      .filter(e => e.href.includes('tender.2merkato.com/tenders/') && e.textContent.length > 10)
      .map(e => ({ href: e.href, text: e.textContent.substring(0, 80) }))
      .slice(0, 15);
  });
  
  console.log('Tender links found:', links.length);
  links.forEach(l => console.log('-', l.text.substring(0, 60)));
  
  await browser.close();
  console.log('Done');
})();
