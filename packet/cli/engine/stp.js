// stp.js — per-VLAN spanning tree.
//
// Enough of PVST+ to teach the thing students are actually asked about: who
// wins the root election, why, which port each switch keeps, and which port
// gets blocked so the redundant link does not become a broadcast storm.
//
// Computed from state on demand rather than converged over time. A student
// changes a priority and the topology re-elects immediately, which is the
// right trade for a lab — the exam question is "who is root and why", not
// "how long did 802.1D take to get there".

import { getDevice, getIface, peerOf, portIsTrunk, trunkAllows, vlansOnPort } from './net.js';
import { macToInt } from './addr.js';

/** IEEE cost by link speed. The numbers students are expected to recognise. */
export function pathCost(speed) {
  if (speed >= 10000) return 2;
  if (speed >= 1000) return 4;
  if (speed >= 100) return 19;
  return 100;
}

/** The switch's own MAC — the tiebreaker in every election. */
export function bridgeMac(dev) {
  const port = dev.ifaces.find(i => !i.svi && !i.parent);
  return port ? port.mac : '000000000000';
}

/** Priority actually in force for a VLAN: what was configured, or 32768. */
export function bridgePriority(dev, vlan) {
  const p = dev.stp?.priority?.[vlan];
  return p == null ? 32768 : p;
}

/**
 * The bridge ID, as a comparable number: priority + the VLAN's system ID
 * extension, then the MAC. This is why `priority 24576` on VLAN 10 shows up
 * as 24586 in `show spanning-tree`.
 */
export function bridgeId(dev, vlan) {
  return { prio: bridgePriority(dev, vlan) + vlan, mac: bridgeMac(dev) };
}

export function bridgeIdText(dev, vlan) {
  const id = bridgeId(dev, vlan);
  return `${id.prio}`;
}

function idLess(a, b) {
  if (a.prio !== b.prio) return a.prio < b.prio;
  return macToInt(a.mac) < macToInt(b.mac);
}

/** Switches that have this VLAN and could take part in its tree. */
function switchesIn(net, vlan) {
  return net.devices.filter(d =>
    d.kind === 'switch' && (!d.vlans.length || d.vlans.some(v => v.id === vlan)));
}

/** Switch-to-switch links carrying this VLAN, both ends up and cabled. */
function stpLinks(net, vlan) {
  const out = [];
  for (const link of net.links) {
    if (!link.ok) continue;
    const a = getDevice(net, link.a.dev), b = getDevice(net, link.b.dev);
    if (!a || !b || a.kind !== 'switch' || b.kind !== 'switch') continue;
    const ai = getIface(a, link.a.iface), bi = getIface(b, link.b.iface);
    if (!ai || !bi || ai.shutdown || bi.shutdown) continue;
    if (!carries(net, a, ai, vlan) || !carries(net, b, bi, vlan)) continue;
    out.push({ a, ai, b, bi, cost: pathCost(Math.min(ai.speed, bi.speed)) });
  }
  return out;
}

function carries(net, dev, iface, vlan) {
  if (iface.svi || iface.parent) return false;
  return portIsTrunk(net, dev, iface)
    ? trunkAllows(iface, vlan)
    : iface.vlan === vlan;
}

function portCost(dev, iface, vlan) {
  return dev.stp?.cost?.[iface.name] ?? iface.stpCost ?? pathCost(iface.speed);
}

/**
 * Resolve the tree for one VLAN.
 * Returns Map "<devId>:<ifName>" -> { role, state, cost, rootCost, isRoot }
 * where role is 'root' | 'designated' | 'alternate' and state is
 * 'forwarding' | 'blocking'.
 *
 * Anything not in the map is not part of a spanning tree — an access port to
 * a PC, a router port, a port that is down — and the forwarding code treats
 * a missing entry as "forward", so a network with no redundancy behaves
 * exactly as it did before spanning tree existed here.
 */
export function stpState(net, vlan = 1) {
  const cacheKey = `v${vlan}`;
  const rev = net.stpRev || 0;
  net._stp = net._stp || { rev: -1, byVlan: new Map() };
  if (net._stp.rev === rev && net._stp.byVlan.has(cacheKey)) return net._stp.byVlan.get(cacheKey);
  if (net._stp.rev !== rev) { net._stp = { rev, byVlan: new Map() }; }

  const result = compute(net, vlan);
  net._stp.byVlan.set(cacheKey, result);
  return result;
}

/** Anything that changes the tree calls this. Cheaper than watching state. */
export function stpDirty(net) {
  net.stpRev = (net.stpRev || 0) + 1;
}

function compute(net, vlan) {
  const states = new Map();
  const switches = switchesIn(net, vlan);
  if (switches.length < 2) return states;

  const links = stpLinks(net, vlan);
  if (!links.length) return states;

  // --- 1. elect the root ---
  let root = switches[0];
  for (const sw of switches) if (idLess(bridgeId(sw, vlan), bridgeId(root, vlan))) root = sw;

  // --- 2. cheapest path from every switch to the root ---
  const cost = new Map(switches.map(s => [s.id, Infinity]));
  cost.set(root.id, 0);
  for (let pass = 0; pass < switches.length; pass++) {
    let changed = false;
    for (const l of links) {
      const ca = cost.get(l.a.id), cb = cost.get(l.b.id);
      if (ca + portCost(l.b, l.bi, vlan) < cb) { cost.set(l.b.id, ca + portCost(l.b, l.bi, vlan)); changed = true; }
      if (cb + portCost(l.a, l.ai, vlan) < ca) { cost.set(l.a.id, cb + portCost(l.a, l.ai, vlan)); changed = true; }
    }
    if (!changed) break;
  }

  // --- 3. root port on every non-root switch ---
  const rootPort = new Map();
  for (const sw of switches) {
    if (sw.id === root.id) continue;
    let best = null;
    for (const l of links) {
      const near = l.a.id === sw.id ? l : (l.b.id === sw.id ? { a: l.b, ai: l.bi, b: l.a, bi: l.ai, cost: l.cost } : null);
      if (!near) continue;
      const viaCost = cost.get(near.b.id) + portCost(sw, near.ai, vlan);
      if (viaCost !== cost.get(sw.id)) continue;
      const cand = { iface: near.ai, peer: near.b, peerIf: near.bi, cost: viaCost };
      if (!best ||
          idLess(bridgeId(cand.peer, vlan), bridgeId(best.peer, vlan)) ||
          (cand.peer.id === best.peer.id && portRank(cand.peerIf) < portRank(best.peerIf))) {
        best = cand;
      }
    }
    if (best) {
      rootPort.set(sw.id, best.iface.name);
      states.set(`${sw.id}:${best.iface.name}`, {
        role: 'root', state: 'forwarding', cost: portCost(sw, best.iface, vlan),
        rootCost: cost.get(sw.id)
      });
    }
  }

  // --- 4. one designated port per link; everything else blocks ---
  for (const l of links) {
    const aKey = `${l.a.id}:${l.ai.name}`, bKey = `${l.b.id}:${l.bi.name}`;
    const aIsRootPort = rootPort.get(l.a.id) === l.ai.name;
    const bIsRootPort = rootPort.get(l.b.id) === l.bi.name;

    // A root port's partner is always designated.
    if (aIsRootPort || bIsRootPort) {
      const dev = aIsRootPort ? l.b : l.a;
      const iface = aIsRootPort ? l.bi : l.ai;
      const key = aIsRootPort ? bKey : aKey;
      if (!states.has(key)) {
        states.set(key, { role: 'designated', state: 'forwarding',
                          cost: portCost(dev, iface, vlan), rootCost: cost.get(dev.id) });
      }
      continue;
    }

    // Otherwise the lower root cost wins the segment, bridge ID breaks the tie.
    const ca = cost.get(l.a.id), cb = cost.get(l.b.id);
    const aWins = ca !== cb ? ca < cb : idLess(bridgeId(l.a, vlan), bridgeId(l.b, vlan));
    const win = aWins ? { dev: l.a, iface: l.ai, key: aKey } : { dev: l.b, iface: l.bi, key: bKey };
    const lose = aWins ? { dev: l.b, iface: l.bi, key: bKey } : { dev: l.a, iface: l.ai, key: aKey };

    if (!states.has(win.key)) {
      states.set(win.key, { role: 'designated', state: 'forwarding',
                            cost: portCost(win.dev, win.iface, vlan), rootCost: cost.get(win.dev.id) });
    }
    if (!states.has(lose.key)) {
      states.set(lose.key, { role: 'alternate', state: 'blocking',
                             cost: portCost(lose.dev, lose.iface, vlan), rootCost: cost.get(lose.dev.id) });
    }
  }

  // Edge ports — anything facing a PC or a router — are designated and
  // forwarding. They are in the map so `show spanning-tree` can list them.
  for (const sw of switches) {
    for (const port of sw.ifaces) {
      if (port.svi || port.parent || port.shutdown) continue;
      if (!carries(net, sw, port, vlan)) continue;
      const key = `${sw.id}:${port.name}`;
      if (states.has(key)) continue;
      const p = peerOf(net, sw.id, port.name);
      if (!p || !p.link.ok || p.iface.shutdown) continue;
      states.set(key, { role: 'designated', state: 'forwarding', edge: true,
                        cost: portCost(sw, port, vlan), rootCost: cost.get(sw.id) });
    }
  }

  states.rootId = root.id;
  states.rootCostOf = id => cost.get(id) ?? 0;
  states.vlan = vlan;
  return states;
}

/** Port number ordering, for the last tiebreak. Fa0/2 sorts before Fa0/10. */
function portRank(iface) {
  const nums = (iface.name.match(/\d+/g) || []).map(Number);
  return nums.reduce((a, n) => a * 100 + n, 0) * 1000 + (iface.stpPortPriority ?? 128);
}

/** Who is root for this VLAN, from any switch's point of view. */
export function rootBridge(net, vlan = 1) {
  const states = stpState(net, vlan);
  if (states.rootId) return getDevice(net, states.rootId);
  // A lone switch with no redundant links is its own root.
  const switches = switchesIn(net, vlan);
  if (!switches.length) return null;
  let root = switches[0];
  for (const sw of switches) if (idLess(bridgeId(sw, vlan), bridgeId(root, vlan))) root = sw;
  return root;
}

/** The role/state of one port, with sensible answers when there is no tree. */
export function portState(net, dev, iface, vlan = 1) {
  const s = stpState(net, vlan).get(`${dev.id}:${iface.name}`);
  if (s) return s;
  return { role: 'designated', state: 'forwarding', edge: true,
           cost: portCost(dev, iface, vlan), rootCost: 0 };
}

/** VLANs this switch runs a spanning tree for. */
export function stpVlans(net, dev) {
  const ids = new Set();
  for (const port of dev.ifaces) {
    if (port.svi || port.parent) continue;
    for (const v of vlansOnPort(net, dev, port)) ids.add(v);
  }
  if (!ids.size) ids.add(1);
  return [...ids].sort((a, b) => a - b);
}
