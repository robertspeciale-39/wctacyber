// grader.js — declarative objectives, evaluated against device state.
//
// Deliberately never string-matches what the student typed (except where the
// objective IS about using a command). Any valid route to the goal counts,
// which is how the real Activity Wizard scores and how it should be.

import { isIpv4, cidrToMask, maskToCidr, networkOf, expandIpv6 } from './addr.js';
import {
  getDevice, getIface, ifaceUp, routingTable, pingOnce, ownsIp
} from './net.js';
import { buildRunningConfig } from './show.js';

/**
 * ctx = { net, transcript: [{device, line}], answers: {id: value} }
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

  /** For labs whose point is that you ran the diagnostic, not that you fixed it. */
  commandUsed(ctx, c) {
    const re = new RegExp(c.re, c.flags || 'i');
    return (ctx.transcript || []).some(e =>
      (c.device == null || e.device === c.device) && re.test(e.line));
  },

  /** Ordered sequence of commands — the U6 eight-step drill. */
  commandSequence(ctx, c) {
    const lines = (ctx.transcript || [])
      .filter(e => c.device == null || e.device === c.device)
      .map(e => e.line);
    let idx = 0;
    for (const line of lines) {
      if (new RegExp(c.steps[idx], 'i').test(line)) idx++;
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
      points: task.points ?? 1,
      hint: task.hint || null,
      device: task.device || null,
      once: !!task.once,
      met,
      detail
    });
  }
  const total = results.reduce((a, r) => a + r.points, 0);
  const earned = results.reduce((a, r) => a + (r.met ? r.points : 0), 0);
  return {
    tasks: results,
    earned, total,
    percent: total ? Math.round(earned / total * 100) : 0,
    complete: total > 0 && earned === total
  };
}

export const CHECK_TYPES = Object.keys(CHECKS);
