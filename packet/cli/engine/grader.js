// grader.js — declarative objectives, evaluated against device state.
//
// Deliberately never string-matches what the student typed (except where the
// objective IS about using a command). Any valid route to the goal counts,
// which is how the real Activity Wizard scores and how it should be.

import { isIpv4, cidrToMask, maskToCidr, networkOf, expandIpv6 } from './addr.js';
import {
  getDevice, getIface, ifaceUp, routingTable, pingOnce, ownsIp,
  portIsTrunk, vlansOnPort
} from './net.js';
import { rootBridge, bridgePriority, portState, stpState } from './stp.js';
import { ospfInterfaces, ospfNeighbors, routerId } from './ospf.js';
import { buildRunningConfig } from './show.js';

/* ------------------------------------------------- command-transcript --- */

/** Canonical commands run on a device (or anywhere, when device is null). */
function commandsIn(ctx, device) {
  return (ctx.transcript || [])
    .filter(e => !e.help && e.canonical && (device == null || e.device === device))
    .map(e => e.canonical);
}

const normCmd = s => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * One canonical command against one objective spec. Exact by default: a
 * command that stops short of the full form does not count, which is the
 * whole point. `re` is anchored on both ends unless the lab anchors it
 * itself, so a pattern cannot accidentally match a prefix.
 */
function matchesCommand(cmd, spec) {
  const c = normCmd(cmd);
  if (spec.cmd != null) return c === normCmd(spec.cmd);
  if (Array.isArray(spec.anyOf)) return spec.anyOf.some(x => c === normCmd(x));
  if (spec.re != null) {
    const body = /^\^|\$$/.test(spec.re) ? spec.re : `^(?:${spec.re})$`;
    return new RegExp(body, spec.flags || 'i').test(c);
  }
  throw new Error('commandUsed needs one of: cmd, anyOf, re');
}

/**
 * ctx = { net, transcript: [{device, raw, canonical, help}], answers: {id: value} }
 * Each check returns true/false. Unknown types fail loudly so a typo in a lab
 * file never silently marks an objective complete.
 */
const CHECKS = {

  /* --- addressing ------------------------------------------------------ */

  interface(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    const iface = getIface(dev, c.if);
    if (!dev || !iface) return false;
    if (c.ip && iface.ip !== c.ip) return false;
    const wantMask = c.mask || (c.cidr != null ? cidrToMask(c.cidr) : null);
    if (wantMask && iface.mask !== wantMask) return false;
    if (c.description != null && iface.description !== c.description) return false;
    if (c.up === true && !ifaceUp(ctx.net, dev, iface)) return false;
    if (c.up === false && ifaceUp(ctx.net, dev, iface)) return false;
    if (c.notShutdown === true && iface.shutdown) return false;
    return true;
  },

  ipv6Address(ctx, c) {
    const iface = getIface(getDevice(ctx.net, c.device), c.if);
    if (!iface) return false;
    const want = expandIpv6(c.addr);
    return iface.ipv6.some(a =>
      expandIpv6(a.addr) === want &&
      (c.prefixLen == null || a.prefixLen === c.prefixLen) &&
      (c.linkLocal == null || a.linkLocal === c.linkLocal));
  },

  ipv6Routing(ctx, c) {
    return !!getDevice(ctx.net, c.device)?.ipv6Routing;
  },

  host(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev || !dev.host) return false;
    const iface = dev.ifaces[0];
    if (c.ip && iface.ip !== c.ip) return false;
    const wantMask = c.mask || (c.cidr != null ? cidrToMask(c.cidr) : null);
    if (wantMask && iface.mask !== wantMask) return false;
    if (c.gateway && dev.host.gateway !== c.gateway) return false;
    if (c.dns && dev.host.dnsServer !== c.dns) return false;
    if (c.dhcp != null && !!dev.host.dhcp !== c.dhcp) return false;
    if (c.anyAddress && !isIpv4(iface.ip || '')) return false;
    return true;
  },

  /* --- VLANs and switching --------------------------------------------- */

  /** The VLAN exists in the switch's database, optionally under a name. */
  vlan(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const v = dev.vlans.find(x => x.id === c.id);
    if (c.absent) return !v;
    if (!v) return false;
    return c.name == null || v.name.toLowerCase() === String(c.name).toLowerCase();
  },

  /** An access port, in the VLAN it is supposed to be in. */
  accessPort(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    const iface = getIface(dev, c.if);
    if (!dev || !iface || !iface.switchport) return false;
    if (portIsTrunk(ctx.net, dev, iface)) return false;
    if (c.vlan != null && iface.vlan !== c.vlan) return false;
    if (c.mode === 'access' && iface.swMode !== 'access') return false;
    if (c.portfast === true && !iface.portfast) return false;
    return true;
  },

  /** A working trunk, with the native VLAN and allowed list the lab wants. */
  trunkPort(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    const iface = getIface(dev, c.if);
    if (!dev || !iface) return false;
    if (!portIsTrunk(ctx.net, dev, iface)) return false;
    if (c.mode === 'trunk' && iface.swMode !== 'trunk') return false;
    if (c.native != null && iface.trunkNative !== c.native) return false;
    if (c.carries) {
      const carried = vlansOnPort(ctx.net, dev, iface);
      if (!c.carries.every(v => carried.includes(v))) return false;
    }
    if (c.excludes) {
      const carried = vlansOnPort(ctx.net, dev, iface);
      if (c.excludes.some(v => carried.includes(v))) return false;
    }
    if (c.up === true && !ifaceUp(ctx.net, dev, iface)) return false;
    return true;
  },

  /** A dot1Q subinterface — router-on-a-stick. */
  subInterface(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    const iface = getIface(dev, c.if);
    if (!dev || !iface || !iface.parent) return false;
    if (c.vlan != null && iface.encapVlan !== c.vlan) return false;
    if (c.native != null && !!iface.encapNative !== c.native) return false;
    if (c.ip && iface.ip !== c.ip) return false;
    const wantMask = c.mask || (c.cidr != null ? cidrToMask(c.cidr) : null);
    if (wantMask && iface.mask !== wantMask) return false;
    if (c.up === true && !ifaceUp(ctx.net, dev, iface)) return false;
    return true;
  },

  /** A switched virtual interface, addressed and up. */
  svi(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const iface = dev.ifaces.find(i => i.svi && i.vlan === c.vlan);
    if (!iface) return false;
    if (c.ip && iface.ip !== c.ip) return false;
    const wantMask = c.mask || (c.cidr != null ? cidrToMask(c.cidr) : null);
    if (wantMask && iface.mask !== wantMask) return false;
    if (c.up === true && !ifaceUp(ctx.net, dev, iface)) return false;
    if (c.notShutdown === true && iface.shutdown) return false;
    return true;
  },

  /** `ip routing` on a layer 3 switch. */
  ipRouting(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    return !!dev && !!dev.ipRouting === (c.enabled !== false);
  },

  /** A routed port — `no switchport` on a layer 3 switch. */
  routedPort(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    const iface = getIface(dev, c.if);
    if (!dev || !iface) return false;
    if (iface.switchport) return false;
    if (c.ip && iface.ip !== c.ip) return false;
    return true;
  },

  /* --- spanning tree ---------------------------------------------------- */

  /** Who is the root bridge for a VLAN. */
  stpRoot(ctx, c) {
    const root = rootBridge(ctx.net, c.vlan ?? 1);
    if (!root) return false;
    const want = getDevice(ctx.net, c.device);
    return !!want && root.id === want.id;
  },

  /** The configured bridge priority for a VLAN. */
  stpPriority(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const prio = bridgePriority(dev, c.vlan ?? 1);
    if (c.value != null) return prio === c.value;
    if (c.lessThan != null) return prio < c.lessThan;
    return prio !== 32768;
  },

  /** The role or state spanning tree has given one port. */
  stpPort(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    const iface = getIface(dev, c.if);
    if (!dev || !iface) return false;
    const st = portState(ctx.net, dev, iface, c.vlan ?? 1);
    if (c.role && st.role !== c.role) return false;
    if (c.state && st.state !== c.state) return false;
    return true;
  },

  /** Somewhere in this VLAN, exactly one port is blocking — the loop is cut. */
  stpBlocking(ctx, c) {
    const states = stpState(ctx.net, c.vlan ?? 1);
    const blocked = [...states.values()].filter(v => v.state === 'blocking');
    if (c.count != null) return blocked.length === c.count;
    return blocked.length > 0;
  },

  /* --- OSPF ------------------------------------------------------------- */

  /** The process exists, with the process ID and router ID the lab wants. */
  ospfProcess(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev || !dev.ospf) return false;
    if (c.pid != null && dev.ospf.pid !== c.pid) return false;
    if (c.routerId && routerId(ctx.net, dev) !== c.routerId) return false;
    return true;
  },

  /** An interface really joined the process, in the right area. */
  ospfInterface(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const entry = ospfInterfaces(ctx.net, dev).find(x => x.iface.name === c.if);
    if (!entry) return false;
    if (c.area != null && entry.area !== c.area) return false;
    if (c.passive != null && entry.passive !== c.passive) return false;
    return true;
  },

  /** An adjacency is up. */
  ospfNeighbor(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const nbrs = ospfNeighbors(ctx.net, dev);
    if (c.with) return nbrs.some(n => n.dev.id === c.with || n.dev.hostname === c.with);
    return nbrs.length >= (c.min ?? 1);
  },

  /** A prefix learned by OSPF, not by hand. */
  ospfRoute(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const mask = c.mask || cidrToMask(c.cidr ?? 24);
    return routingTable(ctx.net, dev).some(r =>
      r.code.startsWith('O') && r.prefix === c.prefix && r.mask === mask &&
      (c.nextHop == null || r.nextHop === c.nextHop));
  },

  /* --- routing --------------------------------------------------------- */

  route(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const mask = c.mask || cidrToMask(c.cidr ?? 24);
    return routingTable(ctx.net, dev).some(r =>
      r.prefix === c.prefix && r.mask === mask &&
      (c.nextHop == null || r.nextHop === c.nextHop) &&
      (c.exitIf == null || r.exitIf === c.exitIf) &&
      (c.code == null || r.code === c.code));
  },

  defaultRoute(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    return routingTable(ctx.net, dev).some(r =>
      r.code === 'S*' && (c.nextHop == null || r.nextHop === c.nextHop));
  },

  /* --- connectivity ---------------------------------------------------- */

  reachability(ctx, c) {
    const from = getDevice(ctx.net, c.from);
    if (!from) return false;
    const to = isIpv4(c.to) ? c.to : (getDevice(ctx.net, c.to)?.ifaces.find(i => i.ip)?.ip);
    if (!to) return false;
    // probe: an objective check must never teach a switch or fill an ARP cache.
    const res = pingOnce(ctx.net, from, to, { probe: true }).ok;
    return c.expect === false ? !res : res;
  },

  /* --- services -------------------------------------------------------- */

  dhcpPool(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    return dev.dhcpPools.some(p =>
      (c.name == null || p.name === c.name) &&
      (c.network == null || p.network === c.network) &&
      (c.mask == null || p.mask === c.mask) &&
      (c.defaultRouter == null || p.defaultRouter === c.defaultRouter) &&
      (c.dnsServer == null || p.dnsServer === c.dnsServer));
  },

  dhcpExcluded(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    return !!dev && dev.dhcpExcluded.some(r => r.start === c.start && r.end === c.end);
  },

  dhcpLease(ctx, c) {
    const client = getDevice(ctx.net, c.device);
    if (!client || !client.host) return false;
    if (!client.host.dhcp) return false;
    if (!isIpv4(client.ifaces[0].ip || '')) return false;
    if (c.inNetwork && networkOf(client.ifaces[0].ip, client.ifaces[0].mask) !== c.inNetwork) return false;
    if (c.gateway && client.host.gateway !== c.gateway) return false;
    return true;
  },

  /* --- evidence a student actually looked ------------------------------ */

  arpEntry(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    if (c.absent) return !dev.arp.some(a => a.ip === c.ip);
    return dev.arp.some(a => a.ip === c.ip);
  },

  macTable(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    if (c.empty) return dev.macTable.length === 0;
    return dev.macTable.length >= (c.minEntries ?? 1);
  },

  /* --- device baseline -------------------------------------------------- */

  hostname(ctx, c) {
    return getDevice(ctx.net, c.device)?.hostname === c.name;
  },

  enableSecret(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    return !!dev && (c.value ? dev.enableSecret === c.value : !!dev.enableSecret);
  },

  linePassword(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    const l = dev.lines[c.line];
    return !!l && !!l.password && (c.login == null || l.login === c.login);
  },

  banner(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev || !dev.bannerMotd) return false;
    return c.contains ? dev.bannerMotd.toLowerCase().includes(c.contains.toLowerCase()) : true;
  },

  passwordEncryption(ctx, c) {
    return !!getDevice(ctx.net, c.device)?.passwordEncryption;
  },

  saved(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev || !dev.startupConfig) return false;
    return buildRunningConfig(ctx.net, dev).join('\n') === dev.savedSignature;
  },

  /* --- escape hatches --------------------------------------------------- */

  configMatches(ctx, c) {
    const dev = getDevice(ctx.net, c.device);
    if (!dev) return false;
    return new RegExp(c.re, c.flags || 'm').test(buildRunningConfig(ctx.net, dev).join('\n'));
  },

  /**
   * For labs whose point is that you ran the diagnostic, not that you fixed it.
   *
   * Graded against the CANONICAL command — the fully spelled-out form the CLI
   * resolved after parsing. `sh ip int br` counts as
   * `show ip interface brief`, because IOS abbreviation is a real skill. A
   * half-typed or invalid command never parses, so it never reaches the
   * transcript at all and can never satisfy an objective.
   *
   *   { "type": "commandUsed", "device": "R1", "cmd": "show ip interface brief" }
   *   { "type": "commandUsed", "device": "R1", "anyOf": ["show ip route", "show ip route static"] }
   *   { "type": "commandUsed", "device": "PC1", "re": "^ping 192\\.168\\.10\\.1$" }
   */
  commandUsed(ctx, c) {
    return commandsIn(ctx, c.device).some(cmd => matchesCommand(cmd, c));
  },

  /** The student pressed `?` — evidence they used context-sensitive help. */
  helpUsed(ctx, c) {
    return (ctx.transcript || []).some(e =>
      e.help && (c.device == null || e.device === c.device) &&
      (c.contains == null || (e.raw || '').toLowerCase().includes(c.contains.toLowerCase())));
  },

  /**
   * Ordered sequence of commands — the U6 eight-step drill. Each step is
   * either an exact canonical command string, or the same shape
   * `commandUsed` takes: { cmd } | { anyOf } | { re }.
   */
  commandSequence(ctx, c) {
    const cmds = commandsIn(ctx, c.device);
    let idx = 0;
    for (const cmd of cmds) {
      const step = c.steps[idx];
      if (matchesCommand(cmd, typeof step === 'string' ? { cmd: step } : step)) idx++;
      if (idx === c.steps.length) return true;
    }
    return false;
  },

  /** Fill-in answers, used by the U4 hop table. */
  answer(ctx, c) {
    const given = (ctx.answers || {})[c.id];
    if (given == null) return false;
    const norm = v => String(v).trim().toLowerCase().replace(/[.:-]/g, '');
    return norm(given) === norm(c.value);
  }
};

/* ---------------------------------------------------------------- grade --- */

export function evaluate(ctx, tasks) {
  // Some objectives are about something you did, not something that is still
  // true — "watch the MAC table fill, then clear it" cannot hold both states at
  // once. A task marked `once: true` latches the first time it is satisfied.
  ctx.latched = ctx.latched || new Set();
  const results = [];
  for (const task of tasks) {
    const checks = task.checks || (task.check ? [task.check] : []);
    const detail = checks.map(c => {
      const fn = CHECKS[c.type];
      if (!fn) throw new Error(`unknown objective check type: ${c.type}`);
      let met = false;
      try { met = !!fn(ctx, c); } catch { met = false; }
      return { type: c.type, met, label: c.label || null };
    });
    let met = detail.length > 0 && detail.every(d => d.met);
    if (task.once) {
      if (met) ctx.latched.add(task.id);
      met = ctx.latched.has(task.id);
    }
    results.push({
      id: task.id,
      text: task.text,
      hint: task.hint || null,
      device: task.device || null,
      once: !!task.once,
      met,
      detail
    });
  }
  // No points, no percentage, no grade. A task is done or it is not, and the
  // only summary anything downstream needs is how many are done.
  const done = results.filter(r => r.met).length;
  return {
    tasks: results,
    done,
    complete: results.length > 0 && done === results.length
  };
}

export const CHECK_TYPES = Object.keys(CHECKS);
