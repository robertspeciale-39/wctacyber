// topology.js — turn a lab's JSON description into a live network.
//
// A lab file declares devices, links, seed configuration and (optionally)
// planted faults. Faults are applied last, so a scenario is written as
// "here is the working network, now break these two things."

import { createNet, addDevice, addLink, getDevice, getIface, applyDhcp, ensureSvi } from './net.js';
import { cidrToMask, isValidMask, maskToCidr } from './addr.js';
import { stpDirty } from './stp.js';
import { newOspfProcess } from './ospf.js';

/**
 * spec = {
 *   devices: [{ id, model, hostname?, x?, y? }],
 *   links:   [{ from: "PC1:Fa0", to: "SW1:Fa0/1", media?: "copper-straight" }],
 *   config:  { R1: { ifaces: {...}, routes: [...], ... }, PC1: {...} },
 *   faults:  [{ type, ... }]
 * }
 */
export function buildTopology(spec) {
  const net = createNet();

  for (const d of spec.devices || []) addDevice(net, d);

  for (const l of spec.links || []) {
    const [aId, aIf] = String(l.from).split(':');
    const [bId, bIf] = String(l.to).split(':');
    addLink(net, aId, aIf, bId, bIf, l.media || defaultMedia(net, aId, aIf, bId, bIf));
  }

  for (const [devId, cfg] of Object.entries(spec.config || {})) {
    applyDeviceConfig(net, devId, cfg);
  }

  // Hosts set to DHCP pull a lease once the network exists.
  for (const dev of net.devices) {
    if (dev.host && dev.host.dhcp) applyDhcp(net, dev);
  }

  for (const f of spec.faults || []) applyFault(net, f);

  return net;
}

function defaultMedia(net, aId, aIf, bId, bIf) {
  const a = getDevice(net, aId), b = getDevice(net, bId);
  const ai = getIface(a, aIf), bi = getIface(b, bIf);
  if (ai?.serial || bi?.serial) return 'serial';
  const cls = (d, i) => d.kind === 'switch' ? 'switch' : 'other';
  return cls(a, ai) === cls(b, bi) ? 'copper-cross' : 'copper-straight';
}

export function applyDeviceConfig(net, devId, cfg) {
  const dev = getDevice(net, devId);
  if (!dev) throw new Error(`config for unknown device ${devId}`);

  if (cfg.hostname) dev.hostname = cfg.hostname;
  if (cfg.enableSecret) dev.enableSecret = cfg.enableSecret;
  if (cfg.banner) dev.bannerMotd = cfg.banner;
  if (cfg.ipv6Routing) dev.ipv6Routing = true;
  if (cfg.domainLookup === false) dev.domainLookup = false;
  if (cfg.defaultGateway) dev.defaultGateway = cfg.defaultGateway;
  if (cfg.ipRouting != null) dev.ipRouting = !!cfg.ipRouting;

  // VLAN database: [{id, name}] or a bare list of ids.
  for (const v of cfg.vlans || []) {
    const entry = typeof v === 'object' ? v : { id: v };
    const id = +entry.id;
    const existing = dev.vlans.find(x => x.id === id);
    if (existing) { if (entry.name) existing.name = entry.name; continue; }
    dev.vlans.push({ id, name: entry.name || `VLAN${String(id).padStart(4, '0')}` });
  }
  dev.vlans.sort((a, b) => a.id - b.id);

  // Spanning tree: { mode: "rapid-pvst", priority: { "10": 24576 } }
  if (cfg.stp) {
    if (cfg.stp.mode) dev.stp.mode = cfg.stp.mode;
    for (const [vlan, prio] of Object.entries(cfg.stp.priority || {})) dev.stp.priority[+vlan] = +prio;
  }

  // OSPF: { pid: 1, routerId, networks: ["192.168.10.0 0.0.0.255 area 0"], passive: [...] }
  if (cfg.ospf) {
    const o = newOspfProcess(cfg.ospf.pid ?? 1);
    o.routerId = cfg.ospf.routerId || null;
    o.passiveDefault = !!cfg.ospf.passiveDefault;
    o.passive = [...(cfg.ospf.passive || [])];
    if (cfg.ospf.refBw) o.refBw = +cfg.ospf.refBw;
    if (cfg.ospf.defaultOriginate) o.defaultOriginate = true;
    for (const n of cfg.ospf.networks || []) o.networks.push(normalizeOspfNetwork(n));
    dev.ospf = o;
  }

  for (const [ifName, i] of Object.entries(cfg.ifaces || {})) {
    // `interface vlan 20` in a seed builds the SVI, same as typing it would.
    // So does a name with a dot in it: `GigabitEthernet0/0.10`.
    const iface = resolveSeedInterface(dev, ifName);
    if (!iface) throw new Error(`${devId} has no interface ${ifName}`);

    if (i.routed) {
      iface.switchport = false; iface.swMode = null;
      iface.vlan = null; iface.trunkNative = null; iface.trunkAllowed = null;
    }
    if (i.mode) iface.swMode = i.mode;    // access | trunk | dynamic-auto | dynamic-desirable
    if (i.accessVlan != null) { iface.vlan = +i.accessVlan; iface.swMode = i.mode || 'access'; }
    if (i.nativeVlan != null) iface.trunkNative = +i.nativeVlan;
    if (i.allowedVlans) iface.trunkAllowed = i.allowedVlans.map(Number);
    if (i.portfast) iface.portfast = true;
    if (i.bpduguard) iface.bpduguard = true;
    if (i.stpCost != null) iface.stpCost = +i.stpCost;
    if (i.encapVlan != null) {
      iface.encapVlan = +i.encapVlan;
      iface.encapNative = !!i.encapNative;
    }
    if (i.ip) {
      iface.ip = i.ip;
      iface.mask = i.mask || (i.cidr != null ? cidrToMask(i.cidr) : '255.255.255.0');
    }
    if (i.ipv6) {
      for (const a of [].concat(i.ipv6)) {
        const [addr, len] = String(a).split('/');
        iface.ipv6.push({ addr, prefixLen: +(len || 64), linkLocal: /^fe[89ab]/i.test(addr) });
      }
    }
    if (i.description) iface.description = i.description;
    if (i.shutdown != null) iface.shutdown = !!i.shutdown;
    else if (i.ip) iface.shutdown = false;   // an addressed interface in a seed is meant to be live
  }

  for (const r of cfg.routes || []) {
    dev.staticRoutes.push(normalizeRoute(r));
  }

  if (cfg.dhcp) {
    for (const ex of cfg.dhcp.excluded || []) dev.dhcpExcluded.push(ex);
    for (const p of cfg.dhcp.pools || []) dev.dhcpPools.push({ ...p });
  }

  if (cfg.dns) {
    dev.dns.enabled = true;
    dev.dns.records = cfg.dns.records || [];
  }
  if (cfg.http) dev.http.enabled = true;

  if (cfg.host && dev.host) {
    Object.assign(dev.host, cfg.host);
  }

  stpDirty(net);
}

/** A seed can name an interface that does not exist yet — an SVI or a
 *  dot1Q subinterface — and mean "create it". */
function resolveSeedInterface(dev, ifName) {
  const existing = getIface(dev, ifName);
  if (existing) return existing;

  const svi = ifName.match(/^vlan\s*(\d+)$/i);
  if (svi && dev.kind === 'switch') return ensureSvi(dev, +svi[1]);

  const dot = ifName.indexOf('.');
  if (dot > 0) {
    const parent = getIface(dev, ifName.slice(0, dot));
    if (!parent) return null;
    const iface = {
      ...JSON.parse(JSON.stringify(parent)),
      name: ifName, parent: parent.name,
      ip: null, mask: null, ipv6: [], description: null,
      encapVlan: null, encapNative: false, shutdown: false, svi: false
    };
    dev.ifaces.push(iface);
    return iface;
  }
  return null;
}

/** "192.168.10.0 0.0.0.255 area 0" or {network, wildcard, area}. */
function normalizeOspfNetwork(n) {
  if (typeof n === 'string') {
    const m = n.match(/^(\S+)\s+(\S+)\s+area\s+(\d+)$/i);
    if (!m) throw new Error(`bad ospf network: ${n}`);
    return { network: m[1], wildcard: m[2], area: +m[3] };
  }
  return { network: n.network, wildcard: n.wildcard, area: +(n.area ?? 0) };
}

function normalizeRoute(r) {
  if (typeof r === 'string') {
    // "192.168.20.0/24 via 10.0.0.2"  or  "0.0.0.0/0 via 10.0.0.1"
    const m = r.match(/^(\S+?)(?:\/(\d+))?\s+via\s+(\S+)$/i);
    if (!m) throw new Error(`bad route string: ${r}`);
    return { prefix: m[1], mask: cidrToMask(+(m[2] ?? 24)), nextHop: m[3], exitIf: null, ipv6: false };
  }
  return {
    prefix: r.prefix,
    mask: r.mask || cidrToMask(r.cidr ?? 24),
    nextHop: r.nextHop || null,
    exitIf: r.exitIf || null,
    ipv6: !!r.ipv6
  };
}

/* --------------------------------------------------------------- faults --- */
// Declarative sabotage. Each fault mirrors a real mistake students make, and
// each one is diagnosable with the standard sequence.

export const FAULTS = {
  'wrong-mask': (net, f) => {
    const iface = getIface(getDevice(net, f.device), f.iface || firstAddressed(net, f.device));
    iface.mask = f.mask || '255.255.0.0';
  },
  'wrong-ip': (net, f) => {
    const iface = getIface(getDevice(net, f.device), f.iface || firstAddressed(net, f.device));
    iface.ip = f.ip;
  },
  'wrong-gateway': (net, f) => {
    const dev = getDevice(net, f.device);
    dev.host.gateway = f.gateway ?? null;
  },
  'no-gateway': (net, f) => {
    getDevice(net, f.device).host.gateway = null;
  },
  'shutdown': (net, f) => {
    getIface(getDevice(net, f.device), f.iface).shutdown = true;
  },
  'missing-route': (net, f) => {
    const dev = getDevice(net, f.device);
    dev.staticRoutes = dev.staticRoutes.filter(r => r.prefix !== f.prefix);
  },
  'wrong-next-hop': (net, f) => {
    const dev = getDevice(net, f.device);
    const r = dev.staticRoutes.find(r => r.prefix === f.prefix);
    if (r) r.nextHop = f.nextHop;
  },
  'bad-cable': (net, f) => {
    const link = net.links.find(l =>
      (l.a.dev === f.device && l.a.iface === f.iface) ||
      (l.b.dev === f.device && l.b.iface === f.iface));
    if (link) { link.media = f.media || 'copper-cross'; link.ok = false; }
  },
  'wrong-dns': (net, f) => {
    getDevice(net, f.device).host.dnsServer = f.dnsServer ?? null;
  },
  'dns-record': (net, f) => {
    const dev = getDevice(net, f.device);
    const rec = dev.dns.records.find(r => r.name === f.name);
    if (rec) rec.ip = f.ip;
  },
  'service-off': (net, f) => {
    const dev = getDevice(net, f.device);
    if (f.service === 'dns') dev.dns.enabled = false;
    if (f.service === 'http') dev.http.enabled = false;
  },

  /* --- switching --- */

  /** The port is in the wrong VLAN. The single most common VLAN mistake. */
  'wrong-vlan': (net, f) => {
    getIface(getDevice(net, f.device), f.iface).vlan = f.vlan;
    stpDirty(net);
  },
  /** A VLAN was never created, so every port assigned to it is inactive. */
  'missing-vlan': (net, f) => {
    const dev = getDevice(net, f.device);
    dev.vlans = dev.vlans.filter(v => v.id !== f.vlan);
    stpDirty(net);
  },
  /** The uplink was left as an access port. Only one VLAN gets across. */
  'access-instead-of-trunk': (net, f) => {
    const iface = getIface(getDevice(net, f.device), f.iface);
    iface.swMode = 'access';
    if (f.vlan != null) iface.vlan = f.vlan;
    stpDirty(net);
  },
  /** A VLAN pruned off the trunk — traffic in it stops at the uplink. */
  'trunk-vlan-missing': (net, f) => {
    const dev = getDevice(net, f.device);
    const iface = getIface(dev, f.iface);
    const all = dev.vlans.map(v => v.id);
    iface.trunkAllowed = (iface.trunkAllowed || all).filter(v => v !== f.vlan);
    stpDirty(net);
  },
  /** Native VLAN mismatch across a trunk. */
  'native-vlan-mismatch': (net, f) => {
    getIface(getDevice(net, f.device), f.iface).trunkNative = f.vlan;
  },
  /** Somebody set a priority that hands the root role to the wrong switch. */
  'stp-priority': (net, f) => {
    const dev = getDevice(net, f.device);
    dev.stp.priority[f.vlan ?? 1] = f.priority;
    stpDirty(net);
  },

  /* --- routing protocols --- */

  /** The wrong wildcard mask, so the interface never joins the process. */
  'ospf-wrong-wildcard': (net, f) => {
    const o = getDevice(net, f.device).ospf;
    const nw = o?.networks.find(n => n.network === f.network);
    if (nw) nw.wildcard = f.wildcard;
  },
  /** A network statement that was never typed. */
  'ospf-missing-network': (net, f) => {
    const o = getDevice(net, f.device).ospf;
    if (o) o.networks = o.networks.filter(n => n.network !== f.network);
  },
  /** The right networks, in the wrong area — neighbours never come up. */
  'ospf-wrong-area': (net, f) => {
    const o = getDevice(net, f.device).ospf;
    const nw = o?.networks.find(n => n.network === f.network);
    if (nw) nw.area = f.area;
  },
  /** passive-interface on the link that needed the adjacency. */
  'ospf-passive': (net, f) => {
    const o = getDevice(net, f.device).ospf;
    if (o && !o.passive.includes(f.iface)) o.passive.push(f.iface);
  },
  /** A layer 3 switch that was never told to route. */
  'no-ip-routing': (net, f) => {
    getDevice(net, f.device).ipRouting = false;
  },
  /** A subinterface missing its encapsulation — the router-on-a-stick trap. */
  'missing-encapsulation': (net, f) => {
    const iface = getIface(getDevice(net, f.device), f.iface);
    if (iface) { iface.encapVlan = null; iface.encapNative = false; }
  }
};

function firstAddressed(net, devId) {
  const dev = getDevice(net, devId);
  return (dev.ifaces.find(i => i.ip) || dev.ifaces[0]).name;
}

export function applyFault(net, f) {
  const fn = FAULTS[f.type];
  if (!fn) throw new Error(`unknown fault type: ${f.type}`);
  fn(net, f);
}
