// net.js — the network. Devices, links, and a forwarding simulation that
// actually computes reachability from state, so a wrong mask really does
// break ping.
//
// Nothing here knows about the CLI or the DOM. The shells drive this; the
// grader reads it; the inspector renders the traces it produces.

import {
  isIpv4, ipToInt, intToIp, maskToCidr, cidrToMask, networkOf, broadcastOf,
  sameNetwork, inPrefix, isLoopback, makeMac, formatMac, BROADCAST_MAC,
  expandIpv6, compressIpv6, sameIpv6Prefix, ipv6Type
} from './addr.js';
import { ospfRoutes } from './ospf.js';
import { stpState } from './stp.js';

/* ------------------------------------------------------------ profiles --- */
// Interface sets per device model. Labs pick a model; the CLI accepts the
// abbreviations Packet Tracer accepts for it.

export const MODELS = {
  'router-1941': {
    kind: 'router', label: 'Cisco 1941',
    ifaces: [
      { name: 'GigabitEthernet0/0', speed: 1000 },
      { name: 'GigabitEthernet0/1', speed: 1000 },
      { name: 'Serial0/0/0', speed: 1544, serial: true },
      { name: 'Serial0/0/1', speed: 1544, serial: true }
    ]
  },
  'router-4331': {
    kind: 'router', label: 'Cisco 4331',
    ifaces: [
      { name: 'GigabitEthernet0/0/0', speed: 1000 },
      { name: 'GigabitEthernet0/0/1', speed: 1000 },
      { name: 'GigabitEthernet0/0/2', speed: 1000 }
    ]
  },
  'switch-2960': {
    kind: 'switch', label: 'Cisco 2960',
    ifaces: [
      ...Array.from({ length: 24 }, (_, i) => ({ name: `FastEthernet0/${i + 1}`, speed: 100, switchport: true })),
      { name: 'GigabitEthernet0/1', speed: 1000, switchport: true },
      { name: 'GigabitEthernet0/2', speed: 1000, switchport: true }
    ],
    svi: 'Vlan1'
  },
  // Layer 3 switch. Same 24+2 port layout as the 2960, but it can turn on
  // `ip routing`, carry an SVI per VLAN and take `no switchport` on a port.
  'switch-3560': {
    kind: 'switch', label: 'Cisco 3560', layer3: true,
    ifaces: [
      ...Array.from({ length: 24 }, (_, i) => ({ name: `FastEthernet0/${i + 1}`, speed: 100, switchport: true })),
      { name: 'GigabitEthernet0/1', speed: 1000, switchport: true },
      { name: 'GigabitEthernet0/2', speed: 1000, switchport: true }
    ],
    svi: 'Vlan1'
  },
  'pc': {
    kind: 'pc', label: 'PC',
    ifaces: [{ name: 'FastEthernet0', speed: 100, host: true }]
  },
  'server': {
    kind: 'server', label: 'Server',
    ifaces: [{ name: 'FastEthernet0', speed: 100, host: true }]
  }
};

/* -------------------------------------------------------------- device --- */

let deviceCounter = 0;

function makeIface(spec, devIndex, ifIndex) {
  return {
    name: spec.name,
    speed: spec.speed,
    serial: !!spec.serial,
    switchport: !!spec.switchport,
    host: !!spec.host,
    mac: makeMac(devIndex, ifIndex),
    ip: null,
    mask: null,
    ipv6: [],            // [{addr, prefixLen, linkLocal}]
    // Router interfaces come up administratively down — the classic `no shutdown`
    // trap. Switch access ports and host NICs do not.
    shutdown: !spec.host && !spec.switchport,
    description: null,
    // --- switching ---
    // `swMode` is what the student configured; whether the port actually
    // trunks also depends on the far end, the way DTP works.
    swMode: spec.switchport ? 'dynamic-auto' : null,
    vlan: spec.switchport ? 1 : null,      // access VLAN
    trunkNative: spec.switchport ? 1 : null,
    trunkAllowed: null,                    // null = all VLANs
    portSecurity: null,                    // {max, violation, sticky, learned[]}
    // --- spanning tree ---
    portfast: false,
    bpduguard: false,
    stpCost: null,                         // explicit `spanning-tree cost`
    stpPortPriority: 128,
    // --- subinterface (router-on-a-stick) ---
    parent: null,
    encapVlan: null,
    encapNative: false,
    duplex: 'auto'
  };
}

export function createDevice({ id, model, hostname, x = 0, y = 0 }) {
  const profile = MODELS[model];
  if (!profile) throw new Error(`unknown model: ${model}`);
  const devIndex = deviceCounter++;
  const dev = {
    id,
    model,
    kind: profile.kind,
    label: profile.label,
    hostname: hostname || id,
    x, y,
    layer3Capable: profile.kind === 'router' || !!profile.layer3,
    ifaces: profile.ifaces.map((s, i) => makeIface(s, devIndex, i)),
    // L2
    vlans: profile.kind === 'switch' ? [{ id: 1, name: 'default' }] : [],
    stp: { mode: 'pvst', priority: {}, cost: {} },   // priority/cost keyed by VLAN
    // L3
    staticRoutes: [],       // {prefix, mask, nextHop|null, exitIf|null, ipv6:false}
    // A router routes because it is a router. A layer 3 switch routes only
    // once somebody types `ip routing`, which is the whole lesson.
    ipRouting: profile.kind === 'router',
    ospf: null,             // {pid, routerId, networks[], passive[], passiveDefault}
    ipv6Routing: false,
    arp: [],                // {ip, mac, iface, age, type}
    macTable: [],           // {vlan, mac, port, type, age}
    // services
    dhcpPools: [],          // {name, network, mask, defaultRouter, dnsServer, domain}
    dhcpExcluded: [],       // {start, end}
    dhcpBindings: [],       // {ip, mac, client, pool}
    dns: { enabled: false, records: [] },   // [{name, ip}]
    http: { enabled: false },
    // host config
    host: profile.kind === 'pc' || profile.kind === 'server'
      ? { dhcp: false, gateway: null, dnsServer: null }
      : null,
    // device baseline (X1)
    enableSecret: null,
    enablePassword: null,
    passwordEncryption: false,
    bannerMotd: null,
    lines: { console: { password: null, login: false }, vty: { password: null, login: false } },
    domainLookup: true,
    defaultGateway: null,   // switch management gateway
    // config persistence: the text is what `show startup-config` prints; the
    // state snapshot is what a reload actually restores.
    startupConfig: null,
    startupState: null,
    savedAt: null,
    // bookkeeping
    clock: 0,
    log: []                 // console messages waiting to be printed
  };
  if (profile.svi) dev.ifaces.push(makeSvi(dev, 1, devIndex));
  return dev;
}

let sviSeq = 90;

/** `interface vlan <n>` on a switch. Created on demand, like the real thing. */
export function makeSvi(dev, vlanId, devIndex = 0) {
  const iface = makeIface({ name: `Vlan${vlanId}`, speed: 1000 }, devIndex, sviSeq++);
  iface.svi = true;
  iface.vlan = vlanId;
  iface.swMode = null;
  iface.trunkNative = null;
  iface.shutdown = true;    // an SVI comes up shut, same as a router port
  return iface;
}

/** The SVI for a VLAN on this switch, creating it if it does not exist yet. */
export function ensureSvi(dev, vlanId) {
  const existing = dev.ifaces.find(i => i.svi && i.vlan === vlanId);
  if (existing) return existing;
  const iface = makeSvi(dev, vlanId);
  dev.ifaces.push(iface);
  return iface;
}

/* ----------------------------------------------------------------- net --- */

export function createNet() {
  return { devices: [], links: [], tick: 0 };
}

export function addDevice(net, spec) {
  const dev = createDevice(spec);
  net.devices.push(dev);
  return dev;
}

export function getDevice(net, id) {
  return net.devices.find(d => d.id === id || d.hostname === id) || null;
}

export function getIface(dev, name) {
  if (!dev) return null;
  const want = String(name).toLowerCase();
  return dev.ifaces.find(i => i.name.toLowerCase() === want) || null;
}

/**
 * Connect two interfaces.
 * media: 'copper-straight' | 'copper-cross' | 'fiber' | 'serial' | 'console'
 * A wrong media choice leaves the link physically down — that is the U1/U2 lesson.
 */
export function addLink(net, aId, aIf, bId, bIf, media = 'copper-straight') {
  const a = getDevice(net, aId), b = getDevice(net, bId);
  const ai = getIface(a, aIf), bi = getIface(b, bIf);
  if (!a || !b || !ai || !bi) throw new Error(`bad link ${aId}:${aIf} <-> ${bId}:${bIf}`);
  const link = {
    a: { dev: a.id, iface: ai.name },
    b: { dev: b.id, iface: bi.name },
    media,
    ok: mediaIsCorrect(a, ai, b, bi, media)
  };
  net.links.push(link);
  return link;
}

function endpointClass(dev, iface) {
  // Devices in the same class need a crossover between them.
  if (dev.kind === 'switch') return 'switch';
  if (dev.kind === 'router') return iface.serial ? 'serial' : 'router';
  return 'host';
}

function mediaIsCorrect(a, ai, b, bi, media) {
  const ca = endpointClass(a, ai), cb = endpointClass(b, bi);
  if (ca === 'serial' || cb === 'serial') return media === 'serial';
  if (media === 'serial') return false;
  if (media === 'fiber') return false;           // no fiber ports on these models
  const like = (ca === 'switch') === (cb === 'switch');
  return like ? media === 'copper-cross' : media === 'copper-straight';
}

export function linkFor(net, devId, ifaceName) {
  return net.links.find(l =>
    (l.a.dev === devId && l.a.iface === ifaceName) ||
    (l.b.dev === devId && l.b.iface === ifaceName)) || null;
}

export function peerOf(net, devId, ifaceName) {
  const l = linkFor(net, devId, ifaceName);
  if (!l) return null;
  const other = l.a.dev === devId && l.a.iface === ifaceName ? l.b : l.a;
  return { dev: getDevice(net, other.dev), iface: getIface(getDevice(net, other.dev), other.iface), link: l };
}

/* ------------------------------------------------------ VLAN / trunking --- */

/** The physical port a frame for this interface actually leaves by.
 *  A subinterface has no cable of its own — its parent carries it. */
export function physicalOf(dev, iface) {
  return iface.parent ? (getIface(dev, iface.parent) || iface) : iface;
}

/** Subinterfaces configured under a physical router port. */
export function subInterfaces(dev, iface) {
  return dev.ifaces.filter(i => i.parent && i.parent.toLowerCase() === iface.name.toLowerCase());
}

/** Does this port carry 802.1Q tags?
 *  A switchport trunks if it was told to and the far end does not refuse;
 *  a router port trunks the moment it has a dot1Q subinterface on it. */
export function portIsTrunk(net, dev, iface) {
  if (iface.svi) return false;
  if (!iface.switchport) {
    return subInterfaces(dev, iface).some(s => s.encapVlan != null);
  }
  if (iface.swMode === 'access') return false;
  if (iface.swMode === 'trunk') return true;
  // Dynamic: desirable forms a trunk with any willing neighbour; auto only
  // ever answers, it never asks.
  const p = peerOf(net, dev.id, iface.name);
  if (!p) return false;
  const far = p.iface;
  const farMode = far.switchport
    ? far.swMode
    : (subInterfaces(p.dev, far).some(s => s.encapVlan != null) ? 'trunk' : 'access');
  if (iface.swMode === 'dynamic-desirable') return farMode === 'trunk' || farMode === 'dynamic-desirable' || farMode === 'dynamic-auto';
  return farMode === 'trunk' || farMode === 'dynamic-desirable';
}

/** Is `vlanId` allowed across this trunk? */
export function trunkAllows(iface, vlanId) {
  return iface.trunkAllowed == null || iface.trunkAllowed.includes(vlanId);
}

/** Every VLAN this port can carry, for `show interfaces trunk` and STP. */
export function vlansOnPort(net, dev, iface) {
  if (portIsTrunk(net, dev, iface)) {
    const known = dev.vlans.length ? dev.vlans.map(v => v.id) : [1];
    return (iface.trunkAllowed == null ? known : iface.trunkAllowed.filter(v => known.includes(v)));
  }
  return iface.vlan == null ? [] : [iface.vlan];
}

/* --------------------------------------------------------- link status --- */

/** Administrative status: what `shutdown` controls. */
export function adminStatus(iface) {
  return iface.shutdown ? 'administratively down' : 'up';
}

/** Line protocol: needs a good cable and a peer that is also up. */
export function lineStatus(net, dev, iface) {
  if (iface.svi) {
    // An SVI is up when its VLAN exists and at least one port carrying that
    // VLAN — access or trunk — is up.
    if (iface.shutdown) return 'down';
    const vlanKnown = !dev.vlans.length || dev.vlans.some(v => v.id === iface.vlan);
    if (!vlanKnown) return 'down';
    const anyUp = dev.ifaces.some(i =>
      !i.svi && i.switchport && !i.shutdown &&
      lineStatus(net, dev, i) === 'up' &&
      vlansOnPort(net, dev, i).includes(iface.vlan));
    return anyUp ? 'up' : 'down';
  }
  if (iface.parent) {
    // A subinterface follows its physical parent, and needs an encapsulation.
    const parent = getIface(dev, iface.parent);
    if (!parent || iface.shutdown || iface.encapVlan == null) return 'down';
    return lineStatus(net, dev, parent);
  }
  if (iface.shutdown) return 'down';
  const p = peerOf(net, dev.id, iface.name);
  if (!p || !p.link.ok) return 'down';
  if (p.iface.shutdown) return 'down';
  return 'up';
}

export function ifaceUp(net, dev, iface) {
  return !iface.shutdown && lineStatus(net, dev, iface) === 'up';
}

/** A device forwards other people's packets only if it is doing IP routing. */
export function canRoute(dev) {
  return !!dev.ipRouting && dev.kind !== 'pc' && dev.kind !== 'server';
}

/* ------------------------------------------------------- routing table --- */

/** Connected + local routes derived live from interface state, plus statics. */
export function routingTable(net, dev) {
  const rows = [];
  for (const i of dev.ifaces) {
    if (!i.ip || !i.mask) continue;
    if (!ifaceUp(net, dev, i)) continue;
    rows.push({
      code: 'C', prefix: networkOf(i.ip, i.mask), mask: i.mask,
      cidr: maskToCidr(i.mask), nextHop: null, exitIf: i.name, ad: 0, metric: 0
    });
    rows.push({
      code: 'L', prefix: i.ip, mask: '255.255.255.255',
      cidr: 32, nextHop: null, exitIf: i.name, ad: 0, metric: 0
    });
  }
  for (const r of dev.staticRoutes) {
    if (r.ipv6) continue;
    const isDefault = r.prefix === '0.0.0.0' && r.mask === '0.0.0.0';
    rows.push({
      code: isDefault ? 'S*' : 'S', prefix: r.prefix, mask: r.mask,
      cidr: maskToCidr(r.mask), nextHop: r.nextHop, exitIf: r.exitIf,
      ad: r.nextHop ? 1 : 0, metric: 0
    });
  }

  // Learned routes. OSPF only installs a prefix nothing better already covers,
  // which is what administrative distance is for.
  for (const r of ospfRoutes(net, dev)) {
    const better = rows.some(x => x.prefix === r.prefix && x.mask === r.mask && x.ad <= r.ad);
    if (!better) rows.push(r);
  }
  return rows;
}

/** Longest-prefix match, ignoring /32 local routes as forwarding targets. */
export function lookupRoute(net, dev, dstIp) {
  const table = routingTable(net, dev);
  let best = null;
  for (const r of table) {
    if (r.code === 'L') continue;
    if (!inPrefix(dstIp, r.prefix, r.mask)) continue;
    if (!best || r.cidr > best.cidr || (r.cidr === best.cidr && r.ad < best.ad)) best = r;
  }
  return best;
}

export function ownsIp(dev, ip) {
  return dev.ifaces.some(i => i.ip === ip);
}

/** The interface a device would use to reach an IP on a directly connected net. */
function connectedIfaceFor(net, dev, ip) {
  return dev.ifaces.find(i =>
    i.ip && i.mask && ifaceUp(net, dev, i) && sameNetwork(i.ip, ip, i.mask)) || null;
}

/* -------------------------------------------------- layer 2 reachability --- */

/**
 * Everything reachable from (dev, iface) without crossing a router — the
 * broadcast domain, which is exactly the path an ARP request takes.
 *
 * VLAN-aware. A frame carries a tag (or none). An access port hands it the
 * port's VLAN; a trunk keeps the tag, or applies the native VLAN when the
 * frame arrives untagged. A port in the wrong VLAN, a trunk that does not
 * allow the VLAN, and a port spanning tree has put in blocking all drop it —
 * which is how a VLAN really isolates traffic and how STP really stops a loop.
 *
 * Returns [{dev, iface, vlan, viaSwitches: [{dev, ingress, egress, vlan}]}]
 */
export function segmentEndpoints(net, dev, ifaceName) {
  const src = getIface(dev, ifaceName);
  if (!src) return [];
  const phys = physicalOf(dev, src);

  // What the frame looks like on the wire leaving this device.
  let tag = null;
  if (src.svi) {
    // Originated by the switch itself, inside its own VLAN.
    return floodFromSwitch(net, dev, null, src.vlan, []);
  }
  if (src.parent) tag = src.encapNative ? null : src.encapVlan;
  else if (src.switchport && !portIsTrunk(net, dev, src)) tag = null;

  const start = peerOf(net, dev.id, phys.name);
  if (!start || !start.link.ok || start.iface.shutdown || phys.shutdown) return [];
  return deliver(net, start.dev, start.iface, tag, []);
}

/** Hand a frame to whatever is on the far end of a wire. */
function deliver(net, dev, iface, tag, path) {
  if (dev.kind !== 'switch') {
    const landing = endpointIface(dev, iface, tag);
    return landing ? [{ dev, iface: landing, vlan: tag, viaSwitches: path }] : [];
  }
  // Ingress rules on a switch port.
  if (portIsTrunk(net, dev, iface)) {
    const vlan = tag == null ? iface.trunkNative : tag;
    if (!trunkAllows(iface, vlan)) return [];
    return floodFromSwitch(net, dev, iface, vlan, path);
  }
  if (tag != null && tag !== iface.vlan) return [];   // tagged frame onto an access port
  return floodFromSwitch(net, dev, iface, iface.vlan, path);
}

/** Flood a frame already inside `sw`, in `vlan`, arriving on `ingress`
 *  (null when the switch itself originated it). */
function floodFromSwitch(net, sw, ingress, vlan, path) {
  const out = [];
  const hop = { dev: sw, ingress: ingress ? ingress.name : null, egress: null, vlan };
  const here = [...path, hop];

  // The switch itself is an endpoint when it has an SVI in this VLAN.
  const svi = sw.ifaces.find(i => i.svi && i.vlan === vlan && i.ip);
  if (svi && ifaceUp(net, sw, svi)) out.push({ dev: sw, iface: svi, vlan, viaSwitches: here });

  const states = stpState(net, vlan);
  for (const port of sw.ifaces) {
    if (port.svi || port.parent) continue;
    if (ingress && port.name === ingress.name) continue;
    if (port.shutdown) continue;
    const trunk = portIsTrunk(net, sw, port);
    if (trunk ? !trunkAllows(port, vlan) : port.vlan !== vlan) continue;
    if (states.get(`${sw.id}:${port.name}`)?.state === 'blocking') continue;
    const nxt = peerOf(net, sw.id, port.name);
    if (!nxt || !nxt.link.ok || nxt.iface.shutdown) continue;
    // Loop guard: never re-enter a switch this copy of the frame already left.
    if (path.some(h => h.dev.id === nxt.dev.id)) continue;
    const outTag = trunk && vlan !== port.trunkNative ? vlan : null;
    const egressPath = [...path, { dev: sw, ingress: ingress ? ingress.name : null, egress: port.name, vlan }];
    out.push(...deliver(net, nxt.dev, nxt.iface, outTag, egressPath));
  }
  return out;
}

/** Which interface on a router or host actually receives this frame. */
function endpointIface(dev, iface, tag) {
  if (tag == null) {
    const nativeSub = subInterfaces(dev, iface).find(s => s.encapNative);
    return nativeSub || iface;
  }
  return subInterfaces(dev, iface).find(s => s.encapVlan === tag) || null;
}

/* ----------------------------------------------------------------- ARP --- */

function learnMac(net, dev, mac, ingressPort, vlan = 1) {
  if (!ingressPort) return;   // the switch's own SVI traffic teaches it nothing
  const existing = dev.macTable.find(e => e.mac === mac && e.vlan === vlan);
  if (existing) { existing.port = ingressPort; existing.age = net.tick; return; }
  dev.macTable.push({ vlan, mac, port: ingressPort, type: 'DYNAMIC', age: net.tick });
}

function recordArp(net, dev, ip, mac, ifaceName) {
  const e = dev.arp.find(a => a.ip === ip);
  if (e) { e.mac = mac; e.iface = ifaceName; e.age = net.tick; return; }
  dev.arp.push({ ip, mac, iface: ifaceName, age: net.tick, type: 'dynamic' });
}

/**
 * Resolve nextHopIp on the segment off (dev, iface).
 * Populates the ARP cache on both ends and MAC tables on every switch
 * the request and reply pass through — the U4/U5 evidence trail.
 */
export function arpResolve(net, dev, iface, nextHopIp, probe = false) {
  if (iface.serial) {
    // Point-to-point serial has no ARP; the peer is whoever is on the wire.
    const p = peerOf(net, dev.id, iface.name);
    if (!p || !p.link.ok || p.iface.shutdown) return null;
    return { mac: p.iface.mac, dev: p.dev, iface: p.iface, flooded: false };
  }
  const srcMac = physicalOf(dev, iface).mac;
  const endpoints = segmentEndpoints(net, dev, iface.name);
  // The broadcast reaches everyone: every switch on the way learns our MAC,
  // in the VLAN the frame was travelling in.
  if (!probe) for (const ep of endpoints) {
    for (const s of ep.viaSwitches) learnMac(net, s.dev, srcMac, s.ingress, s.vlan);
  }
  const match = endpoints.find(ep => ep.iface.ip === nextHopIp);
  if (!match) return null;
  if (!probe) {
    // The unicast reply comes back, teaching each switch where the target lives.
    const dstMac = physicalOf(match.dev, match.iface).mac;
    for (const s of match.viaSwitches) learnMac(net, s.dev, dstMac, s.egress || s.ingress, s.vlan);
    recordArp(net, dev, nextHopIp, dstMac, iface.name);
    if (iface.ip) recordArp(net, match.dev, iface.ip, srcMac, match.iface.name);
  }
  return { mac: physicalOf(match.dev, match.iface).mac, dev: match.dev, iface: match.iface,
           flooded: true, viaSwitches: match.viaSwitches };
}

/* ---------------------------------------------------------- forwarding --- */

export const FAIL = {
  NO_IP: 'no-ip',
  NO_GATEWAY: 'no-gateway',
  ARP_FAILED: 'arp-failed',
  NO_ROUTE: 'no-route',
  IFACE_DOWN: 'iface-down',
  TTL_EXPIRED: 'ttl-expired',
  LOOP: 'loop'
};

/**
 * Walk one packet from `src` toward `dstIp`.
 * Returns { ok, hops[], failure, failedAt, ttlUsed }
 * Each hop records what the student is asked to name at the U4 gate:
 * source and destination MAC (rewritten every hop) and source and
 * destination IP (unchanged end to end).
 */
export function forward(net, src, dstIp, opts = {}) {
  const ttlStart = opts.ttl ?? 128;
  const hops = [];
  if (!opts.probe) net.tick++;

  if (isLoopback(dstIp)) {
    return { ok: true, hops: [], loopback: true, srcIp: dstIp };
  }

  // --- originating host / router ---
  let cur = src;
  let srcIface = null;

  if (opts.sourceIface) {
    srcIface = getIface(src, opts.sourceIface);
  }
  if (!srcIface) {
    srcIface = connectedIfaceFor(net, src, dstIp) ||
               src.ifaces.find(i => i.ip && ifaceUp(net, src, i)) || null;
  }
  if (!srcIface || !srcIface.ip) {
    return { ok: false, failure: FAIL.NO_IP, failedAt: src.id, hops };
  }
  if (!ifaceUp(net, src, srcIface)) {
    return { ok: false, failure: FAIL.IFACE_DOWN, failedAt: src.id, hops };
  }
  const srcIp = srcIface.ip;

  if (ownsIp(src, dstIp)) {
    return { ok: true, hops: [], self: true, srcIp, dstIp };
  }

  let ttl = ttlStart;
  let egress = srcIface;
  let guard = 0;

  while (guard++ < 32) {
    // Where does THIS device send the packet next?
    let nextHopIp;

    if (cur.host) {
      // A host: is the destination on my own network, by my own mask?
      if (sameNetwork(egress.ip, dstIp, egress.mask)) {
        nextHopIp = dstIp;
      } else {
        const gw = cur.host.gateway;
        if (!gw || gw === '0.0.0.0')
          return { ok: false, failure: FAIL.NO_GATEWAY, failedAt: cur.id, hops };
        // A gateway off my own subnet is unreachable — the classic planted fault.
        if (!sameNetwork(egress.ip, gw, egress.mask))
          return { ok: false, failure: FAIL.NO_GATEWAY, failedAt: cur.id, hops, badGateway: true };
        nextHopIp = gw;
      }
    } else {
      const route = lookupRoute(net, cur, dstIp);
      if (!route) return { ok: false, failure: FAIL.NO_ROUTE, failedAt: cur.id, hops };
      nextHopIp = route.nextHop || dstIp;
      const exit = route.exitIf ? getIface(cur, route.exitIf)
                                : connectedIfaceFor(net, cur, nextHopIp);
      if (!exit) return { ok: false, failure: FAIL.NO_ROUTE, failedAt: cur.id, hops };
      if (!ifaceUp(net, cur, exit)) return { ok: false, failure: FAIL.IFACE_DOWN, failedAt: cur.id, hops };
      egress = exit;
    }

    const arp = arpResolve(net, cur, egress, nextHopIp, !!opts.probe);
    if (!arp) return { ok: false, failure: FAIL.ARP_FAILED, failedAt: cur.id, hops, arpFor: nextHopIp };

    hops.push({
      device: cur.id, hostname: cur.hostname,
      outIface: egress.name, inIface: arp.iface.name,
      nextDevice: arp.dev.id, nextHostname: arp.dev.hostname,
      srcMac: formatMac(physicalOf(cur, egress).mac), dstMac: formatMac(arp.mac),
      srcIp, dstIp, ttl,
      viaSwitches: (arp.viaSwitches || []).map(s => ({ id: s.dev.id, ingress: s.ingress, egress: s.egress }))
    });

    cur = arp.dev;
    egress = arp.iface;

    if (ownsIp(cur, dstIp)) return { ok: true, hops, srcIp, dstIp, ttlUsed: ttlStart - ttl };

    // Only something doing IP routing forwards a packet not addressed to it.
    // A layer 3 switch without `ip routing` is a switch, and drops it here.
    if (!canRoute(cur)) return { ok: false, failure: FAIL.NO_ROUTE, failedAt: cur.id, hops };

    ttl--;
    if (ttl <= 0) return { ok: false, failure: FAIL.TTL_EXPIRED, failedAt: cur.id, hops };
  }
  return { ok: false, failure: FAIL.LOOP, hops };
}

/**
 * A full request/reply. The return path is evaluated independently, which is
 * how a missing reverse route produces a timeout rather than a clean error —
 * exactly the U5 lesson.
 */
export function pingOnce(net, src, dstIp, opts = {}) {
  const out = forward(net, src, dstIp, opts);
  if (!out.ok) return { ok: false, phase: 'request', ...out };
  if (out.loopback || out.self) return { ok: true, phase: 'local', ...out };

  const dstDev = net.devices.find(d => ownsIp(d, dstIp));
  if (!dstDev) return { ok: false, phase: 'request', failure: FAIL.ARP_FAILED, hops: out.hops };

  const back = forward(net, dstDev, out.srcIp, { probe: !!opts.probe });
  if (!back.ok) {
    return { ok: false, phase: 'reply', failure: back.failure, failedAt: back.failedAt,
             hops: out.hops, returnHops: back.hops, noReturnPath: true };
  }
  return { ok: true, hops: out.hops, returnHops: back.hops, srcIp: out.srcIp, dstIp,
           ttlUsed: out.ttlUsed || 0 };
}

/** Hop-by-hop discovery for tracert, using increasing TTL just like the real thing. */
export function traceRoute(net, src, dstIp, maxHops = 30) {
  const results = [];
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const r = forward(net, src, dstIp, { ttl });
    if (r.ok) {
      results.push({ ttl, ip: dstIp, done: true });
      return { ok: true, results };
    }
    if (r.failure === FAIL.TTL_EXPIRED) {
      const dev = getDevice(net, r.failedAt);
      const lastHop = r.hops[r.hops.length - 1];
      const replyIp = dev && lastHop ? (getIface(dev, lastHop.inIface)?.ip || null) : null;
      results.push({ ttl, ip: replyIp, done: false });
      continue;
    }
    results.push({ ttl, ip: null, done: false, failure: r.failure });
    if (r.failure === FAIL.NO_ROUTE || r.failure === FAIL.NO_GATEWAY ||
        r.failure === FAIL.NO_IP || r.failure === FAIL.IFACE_DOWN) {
      return { ok: false, results, failure: r.failure };
    }
    if (results.filter(x => !x.ip).length > 3) return { ok: false, results, failure: r.failure };
  }
  return { ok: false, results, failure: 'max-hops' };
}

/* ---------------------------------------------------------------- DHCP --- */

function isExcluded(dev, ip) {
  const n = ipToInt(ip);
  return dev.dhcpExcluded.some(r => n >= ipToInt(r.start) && n <= ipToInt(r.end));
}

/** Find a server on the client's segment that has a pool covering it. */
export function dhcpRequest(net, client) {
  const iface = client.ifaces[0];
  const endpoints = segmentEndpoints(net, client, iface.name);
  for (const ep of endpoints) {
    const server = ep.dev;
    for (const pool of server.dhcpPools) {
      if (!pool.network || !pool.mask) continue;
      // The pool must match a network the server actually has an interface on.
      const serverIface = server.ifaces.find(i => i.ip && i.mask && networkOf(i.ip, i.mask) === pool.network);
      if (!serverIface) continue;
      if (!ifaceUp(net, server, serverIface)) continue;
      if (ep.iface.name !== serverIface.name && !ep.iface.svi) continue;

      const start = ipToInt(pool.network) + 1;
      const end = ipToInt(broadcastOf(pool.network, pool.mask)) - 1;
      for (let n = start; n <= end; n++) {
        const cand = intToIp(n);
        if (isExcluded(server, cand)) continue;
        if (server.dhcpBindings.some(b => b.ip === cand && b.mac !== iface.mac)) continue;
        if (net.devices.some(d => d !== client && ownsIp(d, cand))) continue;
        const existing = server.dhcpBindings.find(b => b.mac === iface.mac);
        if (existing) existing.ip = cand; else
          server.dhcpBindings.push({ ip: cand, mac: iface.mac, client: client.id, pool: pool.name });
        return {
          ok: true, ip: cand, mask: pool.mask,
          gateway: pool.defaultRouter || null,
          dns: pool.dnsServer || null,
          server: serverIface.ip, serverDev: server.id, pool: pool.name
        };
      }
      return { ok: false, reason: 'pool-exhausted' };
    }
  }
  return { ok: false, reason: 'no-server' };
}

export function applyDhcp(net, client) {
  const res = dhcpRequest(net, client);
  const iface = client.ifaces[0];
  if (!res.ok) {
    iface.ip = null; iface.mask = null;
    client.host.gateway = null;
    client.host.apipa = true;
    return res;
  }
  iface.ip = res.ip;
  iface.mask = res.mask;
  client.host.gateway = res.gateway;
  client.host.dnsServer = res.dns;
  client.host.apipa = false;
  client.host.dhcpServer = res.server;
  return res;
}

export function releaseDhcp(net, client) {
  const iface = client.ifaces[0];
  for (const d of net.devices) {
    d.dhcpBindings = d.dhcpBindings.filter(b => b.mac !== iface.mac);
  }
  iface.ip = '0.0.0.0';
  iface.mask = '0.0.0.0';
  client.host.gateway = '0.0.0.0';
}

/* ----------------------------------------------------------------- DNS --- */

export function resolveName(net, client, name) {
  const dnsIp = client.host?.dnsServer;
  if (!dnsIp || dnsIp === '0.0.0.0') return { ok: false, reason: 'no-server' };
  const reach = forward(net, client, dnsIp);
  if (!reach.ok) return { ok: false, reason: 'unreachable', server: dnsIp };
  const server = net.devices.find(d => ownsIp(d, dnsIp));
  if (!server || !server.dns.enabled) return { ok: false, reason: 'no-service', server: dnsIp };
  const rec = server.dns.records.find(r => r.name.toLowerCase() === name.toLowerCase());
  if (!rec) return { ok: false, reason: 'nxdomain', server: dnsIp, serverName: server.hostname };
  return { ok: true, ip: rec.ip, server: dnsIp, serverName: server.hostname };
}

/* ------------------------------------------------------------ snapshot --- */

/** Structural clone for reset/undo. Cheap enough at these sizes. */
export function snapshot(net) {
  return JSON.parse(JSON.stringify({ devices: net.devices, links: net.links, tick: net.tick }));
}

export function restore(net, snap) {
  const copy = JSON.parse(JSON.stringify(snap));
  net.devices = copy.devices;
  net.links = copy.links;
  net.tick = copy.tick;
  return net;
}

/* ------------------------------------------------------------- NVRAM --- */
// What survives a power cycle. Kept as state rather than replayed text,
// because running-config renders secrets hashed and a hash cannot be typed
// back in.

const PERSISTED = [
  'hostname', 'staticRoutes', 'dhcpPools', 'dhcpExcluded', 'ipv6Routing',
  'enableSecret', 'enablePassword', 'passwordEncryption', 'bannerMotd',
  'lines', 'domainLookup', 'defaultGateway',
  'vlans', 'stp', 'ipRouting', 'ospf'
];

const IFACE_PERSISTED = [
  'ip', 'mask', 'description', 'shutdown', 'switchport', 'swMode', 'vlan',
  'trunkNative', 'trunkAllowed', 'portfast', 'bpduguard', 'stpCost',
  'stpPortPriority', 'parent', 'encapVlan', 'encapNative', 'svi', 'speed', 'serial'
];

export function captureConfigState(dev) {
  const snap = {};
  for (const k of PERSISTED) snap[k] = JSON.parse(JSON.stringify(dev[k] ?? null));
  snap.ifaces = dev.ifaces.map(i => {
    const o = { name: i.name, ipv6: JSON.parse(JSON.stringify(i.ipv6)) };
    for (const k of IFACE_PERSISTED) o[k] = i[k] === undefined ? null : JSON.parse(JSON.stringify(i[k]));
    return o;
  });
  return snap;
}

export function restoreConfigState(dev, snap) {
  for (const k of PERSISTED) if (snap[k] !== undefined) dev[k] = JSON.parse(JSON.stringify(snap[k]));
  for (const saved of snap.ifaces || []) {
    let i = dev.ifaces.find(x => x.name === saved.name);
    if (!i) {
      // Subinterfaces and extra SVIs are created by configuration, so a
      // reload has to build them back before it can fill them in.
      if (!saved.parent && !saved.svi) continue;
      i = makeIface({ name: saved.name, speed: saved.speed || 1000 }, 0, sviSeq++);
      dev.ifaces.push(i);
    }
    i.ipv6 = JSON.parse(JSON.stringify(saved.ipv6 || []));
    for (const k of IFACE_PERSISTED) if (saved[k] !== undefined) i[k] = JSON.parse(JSON.stringify(saved[k]));
  }
}
