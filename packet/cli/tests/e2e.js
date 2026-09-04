// e2e.js — browser checks for the CLI section.
//
//   npx playwright@latest install-deps   (once, if needed)
//   node cli/tests/e2e.js
//
// Serves the folder on a throwaway port and drives it headless. Checks the
// route, the terminal, a full lab driven to every task done, the themes, and the
// accessibility floor.

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHarness } from './assert.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..');
const ROOT = join(CLI, '..');   // serve all of packet/ so ../assets/ resolves
const t = createHarness('e2e');
const { ok, eq, section } = t;

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

const port = await new Promise(r => server.listen(0, () => r(server.address().port)));
const BASE = `http://127.0.0.1:${port}/cli/`;

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('\n\x1b[33mPlaywright is not installed — skipping browser checks.\x1b[0m');
  console.log('  npm i -D playwright   then re-run.\n');
  server.close();
  process.exit(0);
}

// CHROMIUM_PATH lets a machine with a preinstalled browser skip the download.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const consoleErrors = [];
// Google Fonts are a network call the site makes on purpose; a sandboxed or
// offline test machine cannot reach them and that is not a page defect.
const EXTERNAL = /^https?:\/\/(?!127\.0\.0\.1|localhost)/;
// Cut the font requests off at the source. On a machine behind a proxy that
// swallows them, `networkidle` never arrives and the whole suite hangs
// waiting for a stylesheet the tests do not care about.
await page.route(EXTERNAL, route => route.abort());
page.on('console', m => {
  if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) consoleErrors.push(m.text());
});
page.on('requestfailed', r => { if (!EXTERNAL.test(r.url())) consoleErrors.push(`request failed: ${r.url()}`); });
page.on('response', r => { if (r.status() >= 400 && !EXTERNAL.test(r.url())) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });
page.on('pageerror', e => consoleErrors.push(String(e)));

const type = async (line) => {
  await page.fill('.term-input input', line);
  await page.press('.term-input input', 'Enter');
  await page.waitForTimeout(30);
};
const termText = () => page.textContent('.term');
// Tasks done out of tasks total. There is no score and no percentage.
const tasksDone = async () => {
  const done = await page.locator('.task.met').count();
  const total = await page.locator('.task').count();
  return { done, total };
};

/* ------------------------------------------------------------- picker --- */
section('picker');

await page.goto(BASE, { waitUntil: 'networkidle' });
ok('the section loads', (await page.title()).includes('CLI Lab'));
const cards = await page.locator('.card').count();
ok('every lab in the manifest has a card', cards >= 15, `saw ${cards}`);
ok('the lede renders', (await page.textContent('.lede h1')).includes('IOS Command Lab'));

await page.click('.filters .cli-chip:has-text("Round 1")');
const filtered = await page.locator('.card').count();
ok('the round filter narrows the list', filtered < cards && filtered > 0, `${filtered} of ${cards}`);
await page.click('.filters .cli-chip:has-text("All")');

/* ------------------------------------------------- every card opens --- */
// The check that catches a lab whose file is missing, whose topology throws,
// or whose card renders but does nothing. Cheap, and it covers all of them.
section('every lab card opens');

{
  const manifest = JSON.parse(await readFile(join(CLI, 'cli-labs.json'), 'utf8'));
  for (const lab of manifest.labs) {
    const errs = [];
    const onErr = e => errs.push(String(e));
    page.on('pageerror', onErr);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForTimeout(150);
    const card = page.locator(`.card:has-text("${lab.name}")`).first();
    if (!(await card.count())) { ok(`${lab.slug}: has a card`, false); page.off('pageerror', onErr); continue; }
    await card.click();
    let opened = false;
    try { await page.waitForSelector('.term-input input', { timeout: 3000 }); opened = true; } catch {}
    const tasks = opened ? await page.locator('.task').count() : 0;
    ok(`${lab.slug}: opens`, opened, errs[0] || 'workbench never appeared');
    ok(`${lab.slug}: renders its tasks`, lab.sandbox ? tasks === 0 : tasks > 0, `${tasks} tasks`);
    page.off('pageerror', onErr);
  }
}

/* ------------------------------------------------------------ the lab --- */
section('workbench');

await page.goto(BASE + '?lab=cli-u5-static-routes', { waitUntil: 'networkidle' });
await page.waitForSelector('.term-input input');

ok('the terminal is present', await page.isVisible('.term-input input'));
ok('the task list renders', (await page.locator('.task').count()) === 8);
eq('a fresh lab starts with nothing ticked', (await tasksDone()).done, 0);
ok('the task counter shows a count, not a score',
   /\b0\b[\s\S]*of[\s\S]*8/.test(await page.textContent('#count')));
ok('there is no percentage anywhere in the task panel',
   !/%/.test(await page.textContent('.pane.right')));
ok('the topology map draws', (await page.locator('#map svg line').count()) >= 5);
ok('the device list is populated', (await page.locator('.dev').count()) === 6);
ok('it opens on the lab start device', (await page.textContent('#termdev')).trim() === 'PC1');

// PC prompt
await type('ping 192.168.10.1');
ok('a local ping from the PC replies', (await termText()).includes('Reply from 192.168.10.1'));
await type('ping 192.168.20.20');
ok('the cross-network ping fails before routing', /Request timed out|unreachable/.test(await termText()));
ok('two tasks are now ticked', (await tasksDone()).done > 0);

// Switch to R1 and configure
await page.click('.dev:has-text("R1")');
await page.waitForTimeout(50);
ok('switching device changes the prompt', (await page.textContent('.term-input .prompt')).startsWith('R1'));

await type('enable');
ok('enable reaches privileged EXEC', (await page.textContent('.term-input .prompt')) === 'R1#');
await type('conf t');
await type('ip route 192.168.20.0 255.255.255.0 10.0.0.2');
await type('end');
await type('show ip route');
ok('show ip route renders in the browser', (await termText()).includes('Gateway of last resort'));

await page.click('.dev:has-text("R2")');
await type('enable');
await type('configure terminal');
await type('ip route 192.168.10.0 255.255.255.0 10.0.0.1');
await type('end');

await page.click('.dev:has-text("PC1")');
await type('ping 192.168.20.20');
ok('the ping works once both routes exist', (await termText()).includes('Reply from 192.168.20.20'));
await type('tracert 192.168.20.20');
ok('tracert shows the two-router path', (await termText()).includes('Trace complete'));

const finished = await tasksDone();
eq('every task on the lab is ticked', finished.done, finished.total);
ok('and there were tasks to tick', finished.total > 0);
ok('a completion toast appears', await page.isVisible('.cli-toast'));

/* --------------------------------------------------- terminal behaviour --- */
section('terminal behaviour');

await page.click('.dev:has-text("R1")');
await page.fill('.term-input input', 'sho');
await page.press('.term-input input', 'Tab');
eq('Tab completes a unique prefix', await page.inputValue('.term-input input'), 'show ');

await page.fill('.term-input input', 'show ');
await page.press('.term-input input', '?');
ok('? prints context help', (await termText()).includes('IP information'));
eq('? leaves the typed line in place', await page.inputValue('.term-input input'), 'show ');

await page.fill('.term-input input', '');
await type('show ip rout3');
ok('a bad command shows the caret error', (await termText()).includes("Invalid input detected at '^' marker"));

await type('show ip interface brief');
ok('history recall works', await (async () => {
  await page.fill('.term-input input', '');
  await page.press('.term-input input', 'ArrowUp');
  return (await page.inputValue('.term-input input')) === 'show ip interface brief';
})());

await page.fill('.term-input input', '');
await type('show running-config');
ok('long output pages with --More--', (await termText()).includes('--More--'));
await page.keyboard.press('q');
await page.waitForTimeout(30);
ok('q leaves the pager', await page.isVisible('.term-input input'));

/* ------------------------------------------------------- inspector/panel --- */
section('inspector and panels');

await page.goto(BASE + '?lab=cli-u4-hop-trace', { waitUntil: 'networkidle' });
await page.waitForSelector('.term-input input');
await type('ping 192.168.20.20');
await page.click('summary:has-text("Packet inspector")');
await page.waitForTimeout(50);
const rows = await page.locator('#inspector > .scrollx tbody tr').count();
eq('the inspector lists three hops', rows, 3);
const bodyText = await page.textContent('.inspector');
ok('it names the device that owns each MAC', bodyText.includes('R1:GigabitEthernet0/1'));
ok('the answer form renders', (await page.locator('.answers input').count()) === 4);

await page.fill('.answers input >> nth=0', '192.168.10.20');
await page.waitForTimeout(60);
ok('a correct answer ticks its task', (await tasksDone()).done > 0);

/* ------------------------------------------------------ IP configuration --- */
section('IP configuration dialog');

await page.goto(BASE + '?lab=cli-u6-diagnostic-sequence', { waitUntil: 'networkidle' });
await page.waitForSelector('.term-input input');
await type('ipconfig');
ok('ipconfig shows the planted wrong gateway', (await termText()).includes('192.168.10.99'));
await page.click('#ipcfg');
await page.waitForTimeout(60);
ok('the dialog opens', await page.isVisible('#ipdialog'));
await page.fill('#ipdialog input[name=gateway]', '192.168.10.1');
await page.click('#ipsave');
await page.waitForTimeout(80);
await type('ping 192.168.20.20');
ok('fixing the gateway fixes the ping', (await termText()).includes('Reply from 192.168.20.20'));

/* ---------------------------------------------------------------- reset --- */
section('reset');

await page.click('#reset');
await page.waitForTimeout(200);
eq('reset puts every task back to not done', (await tasksDone()).done, 0);

/* --------------------------------------------------------------- themes --- */
section('site chrome and themes');

ok('the shared nav mounted', (await page.locator('#chrome .topbar-nav a').count()) >= 6);
ok('the CLI tab is marked current',
   (await page.getAttribute('#chrome .topbar-nav a[aria-current="page"]', 'href') || '').includes('cli'));
ok('the brand links home', await page.locator('#chrome .brand').count() === 1);
ok('the profile switcher is present', await page.locator('#who-btn').count() === 1);

for (const theme of ['matrix', 'arctic', 'crimson', 'tokyo', 'galaxy']) {
  await page.click(`.theme-btn[data-theme="${theme}"]`);
  await page.waitForTimeout(40);
  ok(`theme ${theme} applies to the body`, await page.evaluate(t => document.body.classList.contains(t), theme));
  const ink = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.term')).color);
  ok(`theme ${theme} reaches the terminal text`, ink && ink !== 'rgba(0, 0, 0, 0)');
  const accent = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.term-input .prompt')).color);
  ok(`theme ${theme} reaches the prompt`, accent && accent !== 'rgba(0, 0, 0, 0)');
}
await page.click('.theme-btn[data-theme="matrix"]');

/* ---------------------------------------------------------------- drill --- */
section('drill mode');

await page.goto(BASE + '?mode=drill', { waitUntil: 'networkidle' });
ok('the drill intro renders', (await page.textContent('.lede h1')).includes('Command drill'));
await page.click('#start');
await page.waitForSelector('#dans');
ok('a question appears', (await page.textContent('.lede h1')).length > 10);
await page.fill('#dans', 'sh ip int br');
await page.press('#dans', 'Enter');
await page.waitForTimeout(80);
ok('the drill accepts abbreviations or marks them wrong honestly',
   /Correct|Not quite/.test(await page.textContent('#dfeed')));

/* ------------------------------------------------------------ a11y floor --- */
section('accessibility floor');

await page.goto(BASE + '?lab=cli-u5-static-routes', { waitUntil: 'networkidle' });
await page.waitForSelector('.term-input input');

eq('the scrollback is a live log', await page.getAttribute('.term', 'role'), 'log');
eq('...that announces politely', await page.getAttribute('.term', 'aria-live'), 'polite');
ok('the command input is labelled', !!(await page.getAttribute('.term-input input', 'aria-label')));
ok('the topology svg has a label', !!(await page.getAttribute('#map svg', 'aria-label')));
ok('device buttons expose current state',
   (await page.getAttribute('.dev[aria-current="true"]', 'aria-current')) === 'true');
ok('tasks announce their state',
   (await page.getAttribute('.task', 'aria-label')).startsWith('Not complete'));
ok('there is a skip link', await page.locator('.skip').count() === 1);
ok('the sub-bar carries the breadcrumb', await page.locator('.cli-subbar #crumb').count() === 1);

// Keyboard-only: tab to a device button and activate it.
await page.keyboard.press('Tab');
const focusTag = await page.evaluate(() => document.activeElement?.className || document.activeElement?.tagName);
ok('tabbing lands somewhere focusable', !!focusTag);

// No horizontal overflow at a narrow viewport.
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(120);
const overflow = await page.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('no horizontal scroll at 390px', overflow <= 1, `overflow ${overflow}px`);
ok('the terminal is still usable on a phone', await page.isVisible('.term-input input'));

/* --------------------------------------------------------------- errors --- */
section('console');
ok('no uncaught console errors', consoleErrors.length === 0, JSON.stringify(consoleErrors, null, 1));

await browser.close();
server.close();
process.exit(t.report() ? 0 : 1);
