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
    vlan: spec.switchport ? 1 : null,
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
    ifaces: profile.ifaces.map((s, i) => makeIface(s, devIndex, i)),
    // L3
    staticRoutes: [],       // {prefix, mask, nextHop|null, exitIf|null, ipv6:false}
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
  if (profile.svi) {
    dev.ifaces.push({
      name: profile.svi, speed: 1000, serial: false, switchport: false, host: false,
      mac: makeMac(devIndex, 90), ip: null, mask: null, ipv6: [],
      shutdown: true, description: null, vlan: 1, duplex: 'auto', svi: true
    });
  }
  return dev;
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

/* --------------------------------------------------------- link status --- */

/** Administrative status: what `shutdown` controls. */
export function adminStatus(iface) {
  return iface.shutdown ? 'administratively down' : 'up';
}

/** Line protocol: needs a good cable and a peer that is also up. */
export function lineStatus(net, dev, iface) {
  if (iface.svi) {
    // An SVI is up when at least one access port in its VLAN is up.
    const anyUp = dev.ifaces.some(i => i.switchport && i.vlan === iface.vlan && !i.shutdown && lineStatus(net, dev, i) === 'up');
    return (!iface.shutdown && anyUp) ? 'up' : 'down';
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
 * Everything reachable from (dev, iface) without crossing a router.
 * Switches forward out every other port, which is exactly how a broadcast
 * travels — so this doubles as the ARP flood.
 * Returns [{dev, iface, viaSwitches: [{dev, ingress, egress}]}]
 */
export function segmentEndpoints(net, dev, ifaceName) {
  const start = peerOf(net, dev.id, ifaceName);
  if (!start || !start.link.ok || start.iface.shutdown) return [];
  const out = [];
  const seen = new Set();
  const queue = [{ dev: start.dev, iface: start.iface, path: [] }];
  while (queue.length) {
    const cur = queue.shift();
    const key = `${cur.dev.id}:${cur.iface.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (cur.dev.kind === 'switch') {
      const hop = { dev: cur.dev, ingress: cur.iface.name, egress: null };
      // The switch itself is an endpoint if its SVI is addressed.
      const svi = cur.dev.ifaces.find(i => i.svi && i.ip);
      if (svi && ifaceUp(net, cur.dev, svi)) {
        out.push({ dev: cur.dev, iface: svi, viaSwitches: [...cur.path, hop] });
      }
      for (const port of cur.dev.ifaces) {
        if (port.svi || port.name === cur.iface.name) continue;
        if (port.shutdown || port.vlan !== cur.iface.vlan) continue;
        const nxt = peerOf(net, cur.dev.id, port.name);
        if (!nxt || !nxt.link.ok || nxt.iface.shutdown) continue;
        queue.push({
          dev: nxt.dev, iface: nxt.iface,
          path: [...cur.path, { dev: cur.dev, ingress: cur.iface.name, egress: port.name }]
        });
      }
    } else {
      out.push({ dev: cur.dev, iface: cur.iface, viaSwitches: cur.path });
    }
  }
  return out;
}

/* ----------------------------------------------------------------- ARP --- */

function learnMac(net, switches, mac, ingressPort, dev) {
  const existing = dev.macTable.find(e => e.mac === mac && e.vlan === 1);
  if (existing) { existing.port = ingressPort; existing.age = net.tick; return; }
  dev.macTable.push({ vlan: 1, mac, port: ingressPort, type: 'DYNAMIC', age: net.tick });
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
  const endpoints = segmentEndpoints(net, dev, iface.name);
  // The broadcast reaches everyone: every switch on the way learns our MAC.
  if (!probe) for (const ep of endpoints) {
    for (const s of ep.viaSwitches) learnMac(net, null, iface.mac, s.ingress, s.dev);
  }
  const match = endpoints.find(ep => ep.iface.ip === nextHopIp || (ep.dev.host && ep.iface.ip === nextHopIp));
  if (!match) return null;
  if (!probe) {
    // The unicast reply comes back, teaching each switch where the target lives.
    for (const s of match.viaSwitches) learnMac(net, null, match.iface.mac, s.egress || s.ingress, s.dev);
    recordArp(net, dev, nextHopIp, match.iface.mac, iface.name);
    if (iface.ip) recordArp(net, match.dev, iface.ip, iface.mac, match.iface.name);
  }
  return { mac: match.iface.mac, dev: match.dev, iface: match.iface, flooded: true, viaSwitches: match.viaSwitches };
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
      srcMac: formatMac(egress.mac), dstMac: formatMac(arp.mac),
      srcIp, dstIp, ttl,
      viaSwitches: (arp.viaSwitches || []).map(s => ({ id: s.dev.id, ingress: s.ingress, egress: s.egress }))
    });

    cur = arp.dev;
    egress = arp.iface;

    if (ownsIp(cur, dstIp)) return { ok: true, hops, srcIp, dstIp, ttlUsed: ttlStart - ttl };

    // Only a router forwards a packet that isn't addressed to it.
    if (cur.kind !== 'router') return { ok: false, failure: FAIL.NO_ROUTE, failedAt: cur.id, hops };

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
  'lines', 'domainLookup', 'defaultGateway'
];

export function captureConfigState(dev) {
  const snap = {};
  for (const k of PERSISTED) snap[k] = JSON.parse(JSON.stringify(dev[k] ?? null));
  snap.ifaces = dev.ifaces.map(i => ({
    name: i.name, ip: i.ip, mask: i.mask, ipv6: JSON.parse(JSON.stringify(i.ipv6)),
    description: i.description, shutdown: i.shutdown, vlan: i.vlan
  }));
  return snap;
}

export function restoreConfigState(dev, snap) {
  for (const k of PERSISTED) if (snap[k] !== undefined) dev[k] = JSON.parse(JSON.stringify(snap[k]));
  for (const saved of snap.ifaces || []) {
    const i = dev.ifaces.find(x => x.name === saved.name);
    if (!i) continue;
    i.ip = saved.ip; i.mask = saved.mask;
    i.ipv6 = JSON.parse(JSON.stringify(saved.ipv6 || []));
    i.description = saved.description; i.shutdown = saved.shutdown; i.vlan = saved.vlan;
  }
}
