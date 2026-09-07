const { test } = require('node:test');
const assert = require('node:assert/strict');
const scraper = require('../scripts/tender-scraper');

const NOW = new Date('2026-06-10T09:00:00Z');
const DAY = 86400000;
const at = days => new Date(+NOW + days * DAY).toISOString();
const emptyCache = () => ({ tenders: [], lastRun: null });
const bid = (id, changes = {}) => ({
  id, sourceApplication: 'tendering', submissionDeadline: at(10),
  procurementCategory: 'Goods', lotName: 'Laboratory reagents',
  lotDescription: 'Supply of reagents', lotReferenceNo: 'REF/001',
  procuringEntity: 'Test Buyer', marketPlace: 'International',
  invitationDate: at(-1), ...changes,
});

// All network calls are mocked. Tests cannot send messages or write to TenderFlow.
async function withPages(t, pages, run) {
  const RealDate = Date;
  t.mock.method(global, 'Date', class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [+NOW])); }
    static now() { return +NOW; }
  });
  const urls = [];
  t.mock.method(global, 'fetch', async (url, options) => {
    urls.push(url);
    assert.equal(options.headers.Accept, 'application/json');
    assert.ok(pages.length, 'unexpected network request');
    const page = pages.shift();
    if (page.maintenance) return new Response('<html>Maintenance</html>', {
      headers: { 'content-type': 'text/html' },
    });
    return new Response(JSON.stringify({ items: [{ result: page }] }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  await run(urls);
}

test('deadline window is strictly 2–30 days and within the current year', () => {
  for (const [days, status] of [[1, 'too-soon'], [2, 'too-soon'], [3, 'in-window'], [29, 'in-window'], [30, 'too-far']]) {
    assert.equal(scraper.deadlineWindowStatus(at(days), NOW), status);
    assert.equal(scraper.isDeadlineInWindow(at(days), NOW), status === 'in-window');
  }
  assert.equal(scraper.deadlineWindowStatus('invalid', NOW), 'invalid');
  assert.equal(scraper.deadlineWindowStatus('2027-01-05', new Date('2026-12-20')), 'wrong-year');
});

test('keyword categories, exclusions, and recipient parsing are preserved', () => {
  assert.equal(scraper.matchCategory('LABORATORY reagents'), 'Lab & Chemicals');
  assert.equal(scraper.matchCategory('Desktop computers'), 'Electronics & IT');
  assert.equal(scraper.matchCategory('Office furniture'), null);
  assert.equal(scraper.isExcluded('Construction of a school'), true);
  assert.equal(scraper.isExcluded('Financial services'), true);
  assert.equal(scraper.isExcluded('Supply of cleaning products'), false);
  assert.deepEqual(scraper.parseUserIds('123, 456;123\n789'), ['123', '456', '789']);
});

test('EGP maps goods, excludes non-bids/services, and defers distant deadlines', async t => {
  await withPages(t, [[
    bid('accepted'),
    bid('general', { lotName: 'Office furniture', lotDescription: '', marketPlace: 'National' }),
    bid('proforma', { sourceApplication: 'purchasing' }),
    bid('services', { procurementCategory: 'Services' }),
    bid('works', { procurementCategory: 'Works' }),
    bid('consultancy', { procurementCategory: 'Consultancy' }),
    bid('excluded-text', { lotName: 'Construction materials' }),
    bid('soon', { submissionDeadline: at(2) }),
    bid('future', { submissionDeadline: at(35) }),
  ], []], async urls => {
    const result = await scraper.scrapeEgp(emptyCache());
    assert.equal(result.tenders.length, 2);
    const mapped = result.tenders[0];
    assert.equal(mapped.tenderId, 'egp-accepted');
    assert.equal(mapped.sourcePortal, 'egp');
    assert.equal(mapped.category, 'Lab & Chemicals');
    assert.equal(mapped.tenderType, 'import');
    assert.equal(mapped.tenderNumber, 'REF/001');
    assert.equal(mapped.publishingEntity, 'Test Buyer');
    assert.equal(mapped.deadline, at(10));
    assert.equal(mapped.url, 'https://production.egp.gov.et/egp/bids/all/tendering/accepted/open');
    assert.equal(result.tenders[1].category, 'General');
    assert.equal(result.tenders[1].tenderType, 'local');
    assert.ok(!result.processedIds.includes('egp-future'));
    assert.ok(result.processedIds.includes('egp-proforma'));
    assert.ok(result.processedIds.includes('egp-soon'));
    assert.equal(new URL(urls[1]).searchParams.get('skip'), '9');
    assert.equal(new URL(urls[0]).searchParams.get('orderBy'), 'invitationDate desc');
  });
});

test('incremental pagination stops on a fully cached page', async t => {
  await withPages(t, [[bid('cached')]], async urls => {
    const result = await scraper.scrapeEgp({ tenders: [{ tenderId: 'egp-cached', fingerprint: 'known' }] });
    assert.equal(urls.length, 1);
    assert.equal(result.tenders.length, 0);
  });
});

test('legacy null-fingerprint entries are reconsidered; permanent skips stay cached', async t => {
  await withPages(t, [[bid('legacy'), bid('permanent')], []], async () => {
    const result = await scraper.scrapeEgp({ tenders: [
      { tenderId: 'egp-legacy', fingerprint: null },
      { tenderId: 'egp-permanent', fingerprint: null, skipReason: 'permanent' },
    ] });
    assert.deepEqual(result.tenders.map(x => x.tenderId), ['egp-legacy']);
  });
});

test('HTML maintenance responses are explicitly detected', async t => {
  await withPages(t, [{ maintenance: true }], async () => {
    const result = await scraper.scrapeEgp(emptyCache());
    assert.equal(result.maintenanceDetected, true);
    assert.deepEqual(result.tenders, []);
  });
});

test('fingerprint dedup ignores case and time within the same deadline date', () => {
  const tender = { tenderId: 'egp-1', title: 'Equipment', publishingEntity: 'Buyer', deadline: at(10) };
  const duplicate = { ...tender, tenderId: 'egp-2', title: 'EQUIPMENT', deadline: at(10).replace('09:00', '15:00') };
  const fingerprint = scraper.computeFingerprint(tender);
  assert.equal(scraper.computeFingerprint(duplicate), fingerprint);
  assert.deepEqual(scraper.filterTenders([duplicate], { tenders: [{ ...tender, fingerprint }] }), []);
});

test('digests retain EGP references and chunk at ten tenders', () => {
  const tenders = Array.from({ length: 11 }, (_, i) => ({
    title: `Equipment ${i}`, url: `https://example.test/${i}`,
    sourcePortal: 'egp', tenderNumber: `REF-${i}`, publishingEntity: 'Buyer',
  }));
  const chunks = scraper.formatDigest(tenders, 'EGP');
  assert.equal(chunks.length, 2);
  assert.match(chunks[0], /EGP DIGEST/);
  assert.match(chunks[0], /Ref: REF-0/);
  assert.match(chunks[1], /continued 2\/2/);
  assert.match(scraper.formatDigest([], 'EGP')[0], /No new tenders/);
});
