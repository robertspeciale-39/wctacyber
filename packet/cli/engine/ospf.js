// ospf.js — single-area OSPFv2, computed from state.
//
// Scope is what the Cisco Networking Challenge actually asks for: turn OSPF
// on, advertise the right networks with the right wildcard mask in the right
// area, watch the neighbours come up, and read the routes that appear. No
// LSA types, no DR/BDR timers, no multi-area summarisation.
//
// Everything is derived on demand from the running configuration, so a
// student who fixes a wildcard mask sees the route appear on the next
// `show ip route` — the same feedback loop the real protocol gives, minus
// the wait.

import {
  ipToInt, intToIp, maskToCidr, cidrToMask, networkOf, sameNetwork, isIpv4
} from './addr.js';
import { getDevice, getIface, ifaceUp, segmentEndpoints, canRoute, physicalOf } from './net.js';

export const OSPF_AD = 110;

/** IOS default: cost = reference bandwidth (100 Mbps) / interface bandwidth. */
export function ospfCost(dev, iface) {
  const refMbps = dev.ospf?.refBw ?? 100;
  const mbps = (iface.speed || 100) / (iface.serial ? 1000 : 1);
  return Math.max(1, Math.round(refMbps / mbps));
}

/** `network 192.168.10.0 0.0.0.255 area 0` — does it cover this address? */
export function wildcardMatches(ip, network, wildcard) {
  if (!isIpv4(ip) || !isIpv4(network) || !isIpv4(wildcard)) return false;
  const mask = ~ipToInt(wildcard) >>> 0;
  return ((ipToInt(ip) & mask) >>> 0) === ((ipToInt(network) & mask) >>> 0);
}

/** Interfaces this router has actually put into OSPF, with their area. */
export function ospfInterfaces(net, dev) {
  if (!dev.ospf || !canRoute(dev)) return [];
  const out = [];
  for (const iface of dev.ifaces) {
    if (!iface.ip || !iface.mask) continue;
    const stmt = dev.ospf.networks.find(n => wildcardMatches(iface.ip, n.network, n.wildcard));
    if (!stmt) continue;
    out.push({
      iface,
      area: stmt.area,
      cost: ospfCost(dev, iface),
      passive: isPassive(dev, iface),
      up: ifaceUp(net, dev, iface)
    });
  }
  return out;
}

function isPassive(dev, iface) {
  const list = dev.ospf.passive || [];
  return dev.ospf.passiveDefault ? !list.includes(iface.name) : list.includes(iface.name);
}

/** The router ID: configured, else highest loopback, else highest interface. */
export function routerId(net, dev) {
  if (dev.ospf?.routerId) return dev.ospf.routerId;
  const loops = dev.ifaces.filter(i => /^Loopback/i.test(i.name) && i.ip);
  const pool = (loops.length ? loops : dev.ifaces.filter(i => i.ip));
  if (!pool.length) return '0.0.0.0';
  return pool.reduce((best, i) => ipToInt(i.ip) > ipToInt(best.ip) ? i : best).ip;
}

/**
 * Adjacencies. Two routers are neighbours when a working layer 2 path joins
 * two OSPF interfaces in the same subnet and the same area, and neither of
 * them has been made passive. A wrong area or a passive interface is the
 * classic "why is my neighbour not coming up" fault, so both are modelled.
 */
export function ospfNeighbors(net, dev) {
  const out = [];
  for (const local of ospfInterfaces(net, dev)) {
    if (!local.up || local.passive) continue;
    for (const ep of segmentEndpoints(net, dev, local.iface.name)) {
      const peer = ep.dev;
      if (peer.id === dev.id || !peer.ospf || !canRoute(peer)) continue;
      if (!ep.iface.ip || !sameNetwork(local.iface.ip, ep.iface.ip, local.iface.mask)) continue;
      const remote = ospfInterfaces(net, peer).find(x => x.iface.name === ep.iface.name);
      if (!remote || !remote.up || remote.passive) continue;
      if (remote.area !== local.area) continue;
      if (out.some(n => n.dev.id === peer.id && n.localIf === local.iface.name)) continue;
      out.push({
        dev: peer,
        routerId: routerId(net, peer),
        ip: ep.iface.ip,
        localIf: local.iface.name,
        remoteIf: ep.iface.name,
        area: local.area,
        cost: local.cost,
        state: 'FULL'
      });
    }
  }
  return out;
}

/**
 * Routes this router learns. Dijkstra across the adjacency graph, then every
 * OSPF-enabled subnet on every reachable router, at the cost of getting there
 * plus the cost of the far interface.
 */
export function ospfRoutes(net, dev) {
  if (!dev.ospf || !canRoute(dev)) return [];

  // --- shortest paths to every other OSPF router ---
  const dist = new Map([[dev.id, 0]]);
  const via = new Map();            // devId -> {nextHop, exitIf}
  const settled = new Set();

  while (true) {
    let cur = null, best = Infinity;
    for (const [id, d] of dist) {
      if (settled.has(id) || d >= best) continue;
      cur = id; best = d;
    }
    if (cur == null) break;
    settled.add(cur);

    const router = getDevice(net, cur);
    for (const nb of ospfNeighbors(net, router)) {
      const cost = best + nb.cost;
      if (dist.has(nb.dev.id) && dist.get(nb.dev.id) <= cost) continue;
      dist.set(nb.dev.id, cost);
      via.set(nb.dev.id, cur === dev.id
        ? { nextHop: nb.ip, exitIf: nb.localIf }
        : via.get(cur));
    }
  }

  // --- every advertised subnet on every router we can reach ---
  const rows = [];
  const seen = new Map();
  for (const [id, d] of dist) {
    if (id === dev.id) continue;
    const router = getDevice(net, id);
    const path = via.get(id);
    if (!path) continue;
    for (const entry of ospfInterfaces(net, router)) {
      if (!entry.up) continue;
      const prefix = networkOf(entry.iface.ip, entry.iface.mask);
      const key = `${prefix}/${entry.iface.mask}`;
      const metric = d + entry.cost;
      // A subnet we are on ourselves is connected, and connected always wins.
      if (ospfInterfaces(net, dev).some(x =>
        x.up && networkOf(x.iface.ip, x.iface.mask) === prefix)) continue;
      const prev = seen.get(key);
      if (prev && prev.metric <= metric) continue;
      const row = {
        code: 'O', prefix, mask: entry.iface.mask, cidr: maskToCidr(entry.iface.mask),
        nextHop: path.nextHop, exitIf: path.exitIf, ad: OSPF_AD, metric
      };
      seen.set(key, row);
    }
  }
  rows.push(...seen.values());

  // --- a default route injected by a neighbour running `default-information originate` ---
  for (const [id, d] of dist) {
    if (id === dev.id) continue;
    const router = getDevice(net, id);
    if (!router.ospf?.defaultOriginate) continue;
    const hasDefault = router.staticRoutes.some(r => !r.ipv6 && r.prefix === '0.0.0.0');
    if (!hasDefault && !router.ospf.defaultAlways) continue;
    const path = via.get(id);
    if (!path) continue;
    if (rows.some(r => r.prefix === '0.0.0.0')) continue;
    rows.push({
      code: 'O*E2', prefix: '0.0.0.0', mask: '0.0.0.0', cidr: 0,
      nextHop: path.nextHop, exitIf: path.exitIf, ad: OSPF_AD, metric: 1
    });
  }

  return rows;
}

/** Fresh, empty OSPF process — what `router ospf <pid>` creates. */
export function newOspfProcess(pid) {
  return {
    pid: +pid, routerId: null, networks: [], passive: [], passiveDefault: false,
    refBw: 100, defaultOriginate: false, defaultAlways: false
  };
}
