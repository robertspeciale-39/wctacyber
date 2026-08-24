/* End-to-end checks. Dev only.
 *
 *   npx playwright install chromium   (already present in this environment)
 *   python3 -m http.server 8899 &
 *   node tools/e2e.js http://localhost:8899
 *
 * The important one is ROUND SCOPE: for each round, the set of modules the hub
 * shows as in-scope must equal cisco-module-map.md section 2. Everything about
 * this site is derived from that table, so it gets an assertion rather than a
 * glance.
 */
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://localhost:8899';

const EXPECTED = {
  practice: [1, 2],
  r1: [1, 2, 3, 4, 5, 6, 7],
  r2: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21, 22],
  state: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 21, 22],
  semis: Array.from({ length: 23 }, (_, i) => i + 1),
  all: Array.from({ length: 23 }, (_, i) => i + 1)
};

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  ok    ' + name); };
const no = (name, detail) => { fail++; console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : '')); };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // Google Fonts is unreachable in CI sandboxes and makes networkidle crawl.
  await ctx.route('**://fonts.googleapis.com/**', r => r.abort());
  await ctx.route('**://fonts.gstatic.com/**', r => r.abort());
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_CONNECTION_RESET|ERR_FAILED|404/.test(m.text())) errors.push(m.text()); });

  // ── 1. round scope ──────────────────────────────────────────────────
  console.log('\nROUND SCOPE');
  await page.goto(BASE + '/', { waitUntil: 'load' });
  for (const [id, want] of Object.entries(EXPECTED)) {
    await page.click(`.round-btn[data-round="${id}"]`);
    await page.waitForTimeout(120);
    const got = await page.$$eval('.mod-card:not(.out) .mod-n', els =>
      els.map(e => parseInt(e.textContent.replace(/\D/g, ''), 10)).sort((a, b) => a - b));
    const same = JSON.stringify(got) === JSON.stringify(want);
    same ? ok(`${id}: ${got.length} modules in scope`)
         : no(`${id} scope drift`, `got  ${got.join(',')}\n          want ${want.join(',')}`);
  }

  // in-scope count must match the grid note
  await page.click('.round-btn[data-round="r2"]');
  await page.waitForTimeout(120);
  const note = await page.textContent('#grid-note');
  /13 of 23/.test(note) ? ok('grid note agrees with scope') : no('grid note', note);

  // ── 2. round choice persists across pages ───────────────────────────
  console.log('\nPERSISTENCE');
  await page.goto(BASE + '/videos/', { waitUntil: 'load' });
  await page.waitForTimeout(200);
  const active = await page.getAttribute('.round-btn.active', 'data-round');
  active === 'r2' ? ok('round survives navigation') : no('round persistence', 'got ' + active);

  // theme persists and is the shared cs_theme key the drill apps use
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.click('.theme-btn[data-theme="tokyo"]');
  await page.waitForTimeout(120);
  await page.goto(BASE + '/module/?m=7', { waitUntil: 'load' });
  await page.waitForTimeout(250);
  const cls = await page.getAttribute('body', 'class');
  const key = await page.evaluate(() => localStorage.getItem('cs_theme'));
  (cls.includes('tokyo') && key === 'tokyo')
    ? ok('theme persists under the shared cs_theme key')
    : no('theme persistence', `body="${cls}" cs_theme=${key}`);
  await page.evaluate(() => localStorage.setItem('cs_theme', 'matrix'));

  // ── 3. profiles and progress isolation ──────────────────────────────
  console.log('\nPROFILES');
  await page.evaluate(() => {
    PT.addProfile('Alpha');
    PT.toggle(7, 'read'); PT.toggle(7, 'watch');
    PT.addProfile('Bravo');
    PT.toggle(7, 'lab');
  });
  const iso = await page.evaluate(() => {
    const ps = PT.profiles();
    const a = ps.find(p => p.handle === 'Alpha'), b = ps.find(p => p.handle === 'Bravo');
    return { a: PT.progressOf(a.id).m7 || {}, b: PT.progressOf(b.id).m7 || {}, n: ps.length };
  });
  (iso.n === 2 && iso.a.read && iso.a.watch && !iso.a.lab && iso.b.lab && !iso.b.read)
    ? ok('two profiles, no progress bleed')
    : no('profile isolation', JSON.stringify(iso));

  // readiness maths
  const rd = await page.evaluate(async () => {
    const d = await PT.data();
    return PT.readiness(d, 'r1');   // 7 modules x 6 steps = 42
  });
  (rd.total === 42 && rd.done === 1 && rd.pct === 2)
    ? ok('readiness ring maths (1 of 42 = 2%)')
    : no('readiness maths', JSON.stringify(rd));

  // export / import round-trip
  const rt = await page.evaluate(() => {
    const code = PT.exportProfile();
    const back = PT.decodeProfile(code);
    return back && back.h === 'Bravo' && back.p.m7 && back.p.m7.lab === true;
  });
  rt ? ok('stats code round-trips') : no('export/import round-trip');

  // toggling a step re-renders the checkbox
  await page.goto(BASE + '/module/?m=7', { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.click('.check[data-step="read"]');
  await page.waitForTimeout(200);
  const pressed = await page.getAttribute('.check[data-step="read"]', 'aria-pressed');
  pressed === 'true' ? ok('progress checkbox toggles and reflects state') : no('checkbox toggle', 'aria-pressed=' + pressed);

  // ── 4. every module page loads ──────────────────────────────────────
  console.log('\nROUTES');
  let bad = [];
  for (let n = 1; n <= 23; n++) {
    await page.goto(`${BASE}/module/?m=${n}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.spine-block', { timeout: 5000 }).catch(() => {});
    const t = await page.title();
    const spine = await page.$$eval('.spine-block', e => e.length);
    if (!t.startsWith('Module ' + n + ' ') || spine !== 6) bad.push(`m=${n} (title="${t}" blocks=${spine})`);
  }
  bad.length ? no('all 23 module pages render', bad.join(', ')) : ok('all 23 module pages render with a 6-block spine');

  bad = [];
  for (const u of ['u1','u2','u3','u4','u5','u6','u7','u8']) {
    await page.goto(`${BASE}/unit/?u=${u}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(90);
    if (!(await page.title()).startsWith(u.toUpperCase())) bad.push(u);
  }
  bad.length ? no('all 8 unit pages render', bad.join(', ')) : ok('all 8 unit pages render');

  for (const p of ['/videos/', '/scoreboard/', '/resources/', '/coach/', '/404.html',
                   '/sheets/cs-osi-encapsulation.html', '/sheets/cs-device-and-media.html',
                   '/sheets/cs-round-playbook.html']) {
    const r = await page.goto(BASE + p, { waitUntil: 'load' });
    r && r.status() === 200 ? ok('200 ' + p) : no('route ' + p, r ? String(r.status()) : 'no response');
  }

  // bad module id degrades gracefully instead of blowing up
  await page.goto(BASE + '/module/?m=99', { waitUntil: 'load' });
  await page.waitForTimeout(200);
  (await page.textContent('#page')).includes('No such module')
    ? ok('unknown module id shows a helpful message') : no('unknown module id');

  // ── 5. accessibility floor ──────────────────────────────────────────
  console.log('\nACCESSIBILITY');
  await page.goto(BASE + '/module/?m=7', { waitUntil: 'load' });
  await page.waitForTimeout(300);

  const small = await page.$$eval('button, a[href], input, [role="button"]', els =>
    els.filter(e => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (e.closest('.theme-switcher')) return false;      // 32px by design, grouped pill
      if (e.closest('.prose')) return false;               // inline text links
      return Math.min(r.width, r.height) < 44;
    }).map(e => (e.className || e.tagName) + ' ' + Math.round(e.getBoundingClientRect().height) + 'px'));
  small.length ? no('touch targets >= 44px', small.slice(0, 6).join(' | ')) : ok('touch targets >= 44px');

  const headings = await page.$$eval('h1,h2,h3,h4,h5,h6', els => els.map(e => +e.tagName[1]));
  let skip = null, prev = 0;
  headings.forEach(h => { if (prev && h > prev + 1) skip = skip || `${prev} -> ${h}`; prev = h; });
  skip ? no('no skipped heading levels', skip) : ok('heading levels sequential');

  const noAria = await page.$$eval('.check, .round-btn, .theme-btn',
    els => els.filter(e => !e.hasAttribute('aria-pressed')).length);
  noAria === 0 ? ok('every toggle carries aria-pressed') : no('aria-pressed missing on ' + noAria + ' toggles');

  const noAlt = await page.$$eval('img', els => els.filter(e => !e.alt).length);
  noAlt === 0 ? ok('images have alt text') : no(noAlt + ' images missing alt');

  const svgNoLabel = await page.$$eval('svg[role="img"]', els => els.filter(e => !e.getAttribute('aria-label')).length);
  svgNoLabel === 0 ? ok('diagrams have aria-labels') : no(svgNoLabel + ' svg diagrams unlabelled');

  // ── 6. responsive ───────────────────────────────────────────────────
  console.log('\nRESPONSIVE');
  for (const w of [380, 820, 1920]) {
    const p2 = await ctx.newPage();
    await p2.setViewportSize({ width: w, height: 900 });
    await p2.goto(BASE + '/module/?m=7', { waitUntil: 'load' });
    await p2.waitForTimeout(400);
    const overflow = await p2.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    overflow <= 1 ? ok(`no horizontal scroll at ${w}px`) : no(`horizontal scroll at ${w}px`, overflow + 'px over');
    await p2.close();
  }

  // ── 7. no raw hex outside theme blocks ──────────────────────────────
  console.log('\nDESIGN SYSTEM');
  const css = await (await ctx.request.get(BASE + '/assets/cs-shell.css')).text();
  const part2 = css.slice(css.indexOf('PART 2'));
  const rawHex = (part2.match(/#[0-9a-fA-F]{3,8}\b/g) || [])
    .filter(h => !/#fff|#000|#999|#333|#ccc/i.test(h));   // print block only
  rawHex.length ? no('raw hex in packet components', rawHex.join(' ')) : ok('no raw hex outside theme blocks and print');

  if (errors.length) { no('no console/page errors', errors.slice(0, 5).join(' | ')); }
  else ok('no console or page errors');

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
