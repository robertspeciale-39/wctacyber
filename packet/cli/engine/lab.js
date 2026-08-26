// lab.js — resolve a lab file into a live network plus a runnable session set.
//
// A lab either carries its own `topology` or names one from topologies.json
// and layers `config` and `faults` on top. Deep-merging the config means a
// lab can change one interface without restating the whole network.

import { buildTopology } from './topology.js';
import { createSession } from './ios.js';
import { createPcSession } from './pcsh.js';
import { evaluate } from './grader.js';

/** Merge b into a, recursing through plain objects. Arrays replace. */
function deepMerge(a, b) {
  if (b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) {
    out[k] = (typeof v === 'object' && v !== null && !Array.isArray(v))
      ? deepMerge(out[k], v) : v;
  }
  return out;
}

function resolveBase(name, topologies, seen = new Set()) {
  if (seen.has(name)) throw new Error(`topology cycle at ${name}`);
  seen.add(name);
  const t = topologies[name];
  if (!t) throw new Error(`unknown topologyRef: ${name}`);
  if (!t.extends) return JSON.parse(JSON.stringify(t));
  const parent = resolveBase(t.extends, topologies, seen);
  return {
    devices: [...(parent.devices || []), ...(t.devices || [])],
    links: [...(parent.links || []), ...(t.links || [])],
    config: deepMerge(parent.config || {}, t.config || {})
  };
}

/** Turn a lab definition + the topology library into a topology spec. */
export function resolveTopology(lab, topologies) {
  const base = lab.topologyRef
    ? resolveBase(lab.topologyRef, topologies)
    : JSON.parse(JSON.stringify(lab.topology || { devices: [], links: [], config: {} }));

  if (lab.topologyRef && lab.topology) {
    base.devices = [...base.devices, ...(lab.topology.devices || [])];
    base.links = [...base.links, ...(lab.topology.links || [])];
  }
  const spec = {
    devices: base.devices,
    links: base.links,
    config: deepMerge(base.config || {}, lab.config || {}),
    faults: lab.faults || []
  };
  // `clearConfig` wipes a device back to factory before the lab's own config —
  // the "build it yourself" labs use this.
  for (const id of lab.clearConfig || []) delete spec.config[id];
  return spec;
}

/**
 * Instantiate a lab. Returns everything the UI and the tests need.
 *   { lab, net, sessions: {DEVID: session}, ctx, grade() }
 */
export function loadLab(lab, topologies) {
  const spec = resolveTopology(lab, topologies);
  const net = buildTopology(spec);

  const ctx = { net, transcript: [], answers: {} };
  const sessions = {};
  for (const dev of net.devices) {
    sessions[dev.id] = dev.host
      ? createPcSession(net, dev.id)
      : createSession(net, dev.id);
  }

  return {
    lab, net, spec, sessions, ctx,
    grade: () => evaluate(ctx, lab.tasks || [])
  };
}

/** Record a command for the objectives that care that a diagnostic was run. */
export function recordCommand(ctx, deviceId, line) {
  if (!line || !line.trim()) return;
  ctx.transcript.push({ device: deviceId, line: line.trim(), at: Date.now() });
  if (ctx.transcript.length > 500) ctx.transcript.shift();
}
