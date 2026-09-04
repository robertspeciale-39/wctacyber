// labs.test.js — every lab in the manifest is loaded, its own solution is
// driven through the real CLI, and every task must end up done. A lab that
// cannot be completed by its own answer key is a broken lab.
//
// The solution is also proof that every command in the answer key is a
// command this CLI actually accepts: anything the parser rejects shows up
// here as a failure rather than as a student staring at a caret.
//
//   node cli/tests/labs.test.js

import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { createHarness } from './assert.js';
import { loadLab, recordCommand } from '../engine/lab.js';
import { execute } from '../engine/ios.js';
import { executePc, setStatic, setDhcp } from '../engine/pcsh.js';
import { getDevice } from '../engine/net.js';
import { CHECK_TYPES } from '../engine/grader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));

const manifest = readJson(join(ROOT, 'cli-labs.json'));
const topologies = readJson(join(ROOT, 'labs', 'topologies.json'));

const t = createHarness('labs');
const { ok, eq, section } = t;

/* ------------------------------------------------------ manifest sanity --- */
section('manifest');

const files = readdirSync(join(ROOT, 'labs')).filter(f => f.endsWith('.json') && f !== 'topologies.json');
eq('manifest lists every lab file', manifest.labs.length, files.length);

for (const entry of manifest.labs) {
  ok(`${entry.slug}: file exists`, files.includes(entry.slug + '.json'));
}

/* -------------------------------------------------------- the lab driver --- */

/** Panel actions a solution can request, standing in for the UI dialogs. */
function panelAction(run, deviceId, token) {
  const dev = getDevice(run.net, deviceId);
  let m;
  if (token === '__dhcp__') { setDhcp(run.net, dev); return true; }
  if ((m = token.match(/^__setgw:(.+)__$/))) {
    setStatic(run.net, dev, {
      ip: dev.ifaces[0].ip, mask: dev.ifaces[0].mask, gateway: m[1], dns: dev.host.dnsServer
    });
    return true;
  }
  if ((m = token.match(/^__setmask:(.+)__$/))) {
    setStatic(run.net, dev, {
      ip: dev.ifaces[0].ip, mask: m[1], gateway: dev.host.gateway, dns: dev.host.dnsServer
    });
    return true;
  }
  if ((m = token.match(/^__static:([\d.]+)\/(\d+)\/([\d.]+)__$/))) {
    // Full static addressing, standing in for the IP Configuration dialog.
    const bits = +m[2];
    const mask = [24, 16, 8, 0].map(sh => ((bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0) >>> sh) & 255).join('.');
    setStatic(run.net, dev, { ip: m[1], mask, gateway: m[3], dns: dev.host.dnsServer });
    return true;
  }
  if ((m = token.match(/^__setdns:(.+)__$/))) {
    setStatic(run.net, dev, {
      ip: dev.ifaces[0].ip, mask: dev.ifaces[0].mask, gateway: dev.host.gateway, dns: m[1]
    });
    return true;
  }
  return false;
}

function driveSolution(run) {
  const rejected = [];
  for (const step of run.lab.solution || []) {
    if (step.answers) { Object.assign(run.ctx.answers, step.answers); continue; }
    const session = run.sessions[step.device];
    if (!session) throw new Error(`solution names unknown device ${step.device}`);
    for (const cmd of step.cmds) {
      if (typeof cmd === 'string' && cmd.startsWith('__')) {
        if (!panelAction(run, step.device, cmd)) throw new Error(`unknown panel action ${cmd}`);
        continue;
      }
      // A line ending in `?` is context help, not a command: the UI records it
      // as help and never executes it.
      if (/\?\s*$/.test(cmd)) {
        recordCommand(run.ctx, step.device, { raw: cmd, help: true });
        continue;
      }
      // A blank line, or a line answering a prompt the device is waiting on,
      // is not a command and is not expected to produce one.
      const wasPending = !!session.pending || String(cmd).trim() === '';
      const res = session.kind === 'pc' ? executePc(session, cmd) : execute(session, cmd);
      // Exactly what the UI does: record the canonical form of a command that
      // really ran, and nothing at all for one that did not.
      if (res.canonical) recordCommand(run.ctx, step.device, { raw: cmd, canonical: res.canonical });
      const bad = (res.lines || []).some(l =>
        /Invalid input|Incomplete command|Ambiguous command|Unrecognized command/.test(l));
      if (bad || (!res.canonical && !wasPending)) rejected.push(`${step.device}: ${cmd}`);
      // The UI regrades after every command, and latching objectives depend on
      // that. Drive it the same way.
      run.grade();
    }
  }
  return rejected;
}

/* ----------------------------------------------------------- every lab --- */

for (const entry of manifest.labs) {
  section(entry.slug);
  const lab = readJson(join(ROOT, 'labs', entry.slug + '.json'));

  eq('slug matches the manifest', lab.slug, entry.slug);
  eq('unit matches the manifest', lab.unit, entry.unit);
  ok('has a brief', typeof lab.brief === 'string' && lab.brief.length > 40);
  ok('names a starting device', !!lab.startDevice);

  // Every check type used must exist, or the grader would throw at runtime.
  for (const task of lab.tasks || []) {
    const checks = task.checks || (task.check ? [task.check] : []);
    ok(`${task.id}: has at least one check`, checks.length > 0);
    for (const c of checks) ok(`${task.id}: check type "${c.type}" is real`, CHECK_TYPES.includes(c.type));
    ok(`${task.id}: has text`, typeof task.text === 'string' && task.text.length > 10);
  }

  let run;
  try {
    run = loadLab(lab, topologies);
  } catch (e) {
    ok('topology builds', false, e.message);
    continue;
  }
  ok('topology builds', true);
  ok('start device exists', !!getDevice(run.net, lab.startDevice));

  if (lab.sandbox) {
    eq('a sandbox has no tasks', (lab.tasks || []).length, 0);
    continue;
  }

  const before = run.grade();
  ok('starts with tasks left to do', !before.complete,
     `started with ${before.done}/${before.tasks.length} already done`);

  let rejected;
  try {
    rejected = driveSolution(run);
  } catch (e) {
    ok('solution runs without error', false, e.message);
    continue;
  }
  ok('every command in the answer key is accepted', rejected.length === 0, rejected.join(' | '));

  const after = run.grade();
  const missed = after.tasks.filter(x => !x.met).map(x => x.id);
  ok('the solution completes every task', after.complete,
     `${after.done}/${after.tasks.length} done`);
  if (missed.length) ok(`unmet after solution: ${missed.join(', ')}`, false);
}

/* --------------------------------------------- a wrong answer stays wrong --- */
section('the grader is not a rubber stamp');

{
  const lab = readJson(join(ROOT, 'labs', 'cli-u5-static-routes.json'));
  const run = loadLab(lab, topologies);
  // Only one of the two routes: the classic half-fix.
  const r1 = run.sessions.R1;
  ['enable', 'configure terminal', 'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end',
   'show ip route']
    .forEach(c => {
      const res = execute(r1, c);
      if (res.canonical) recordCommand(run.ctx, 'R1', { raw: c, canonical: res.canonical });
    });
  const g = run.grade();
  ok('the R1 route objective is met', g.tasks.find(x => x.id === 'r1-route').met);
  ok('the R2 route objective is not', !g.tasks.find(x => x.id === 'r2-route').met);
  ok('end-to-end connectivity is not', !g.tasks.find(x => x.id === 'end-to-end').met);
  ok('and the lab is not complete', !g.complete);
}

/* ------------------------------- half a command is not a finished command --- */
section('a partial command does not tick a task');

{
  const lab = readJson(join(ROOT, 'labs', 'cli-u5-static-routes.json'));
  const run = loadLab(lab, topologies);
  const r1 = run.sessions.R1;
  // `show ip rout` is not a command. It has a unique expansion, so IOS runs
  // it and it counts. `show ipp route` is a typo: it never runs, so it must
  // never count, however much of the right command it happens to contain.
  for (const c of ['enable', 'show ipp route']) {
    const res = execute(r1, c);
    if (res.canonical) recordCommand(run.ctx, 'R1', { raw: c, canonical: res.canonical });
  }
  ok('a rejected command ticks nothing',
     !run.grade().tasks.find(x => x.id === 'r1-route-check' || x.id === 'r1-route')?.met);

  const res = execute(r1, 'sh ip rou');
  recordCommand(run.ctx, 'R1', { raw: 'sh ip rou', canonical: res.canonical });
  eq('a legal abbreviation is recorded in full', res.canonical, 'show ip route');
}

{
  const lab = readJson(join(ROOT, 'labs', 'cli-u3-interfaces.json'));
  const run = loadLab(lab, topologies);
  const s = run.sessions.R1;
  // Address the interface but forget `no shutdown` — the trap the lab is about.
  ['enable', 'conf t', 'int g0/0', 'ip address 192.168.10.1 255.255.255.0']
    .forEach(c => execute(s, c));
  const g = run.grade();
  ok('an addressed but shut interface does not count', !g.tasks.find(x => x.id === 'g00').met);
}

process.exit(t.report() ? 0 : 1);
