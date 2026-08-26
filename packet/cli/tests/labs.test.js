// labs.test.js — every lab in the manifest is loaded, its own solution is
// driven through the real CLI, and the grader must reach 100%. A lab that
// cannot be completed by its own answer key is a broken lab.
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
  if ((m = token.match(/^__setdns:(.+)__$/))) {
    setStatic(run.net, dev, {
      ip: dev.ifaces[0].ip, mask: dev.ifaces[0].mask, gateway: dev.host.gateway, dns: m[1]
    });
    return true;
  }
  return false;
}

function driveSolution(run) {
  for (const step of run.lab.solution || []) {
    if (step.answers) { Object.assign(run.ctx.answers, step.answers); continue; }
    const session = run.sessions[step.device];
    if (!session) throw new Error(`solution names unknown device ${step.device}`);
    for (const cmd of step.cmds) {
      if (typeof cmd === 'string' && cmd.startsWith('__')) {
        if (!panelAction(run, step.device, cmd)) throw new Error(`unknown panel action ${cmd}`);
        continue;
      }
      recordCommand(run.ctx, step.device, cmd);
      // A line ending in `?` is context help, not a command: the UI records it
      // in the transcript but never executes it.
      if (/\?\s*$/.test(cmd)) continue;
      if (session.kind === 'pc') executePc(session, cmd);
      else execute(session, cmd);
      // The UI regrades after every command, and latching objectives depend on
      // that. Drive it the same way.
      run.grade();
    }
  }
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
  ok('starts below 100%', before.percent < 100, `started at ${before.percent}%`);

  try {
    driveSolution(run);
  } catch (e) {
    ok('solution runs without error', false, e.message);
    continue;
  }

  const after = run.grade();
  const missed = after.tasks.filter(x => !x.met).map(x => x.id);
  eq('the solution reaches 100%', after.percent, 100);
  if (missed.length) ok(`unmet after solution: ${missed.join(', ')}`, false);
}

/* --------------------------------------------- a wrong answer stays wrong --- */
section('the grader is not a rubber stamp');

{
  const lab = readJson(join(ROOT, 'labs', 'cli-u5-static-routes.json'));
  const run = loadLab(lab, topologies);
  // Only one of the two routes: the classic half-fix.
  const r1 = run.sessions.R1;
  ['enable', 'configure terminal', 'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end']
    .forEach(c => { recordCommand(run.ctx, 'R1', c); execute(r1, c); });
  const g = run.grade();
  ok('the R1 route objective is met', g.tasks.find(x => x.id === 'r1-route').met);
  ok('the R2 route objective is not', !g.tasks.find(x => x.id === 'r2-route').met);
  ok('end-to-end connectivity is not', !g.tasks.find(x => x.id === 'end-to-end').met);
  ok('and the score is not 100', g.percent < 100);
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
