// pcsh.js — the PC Command Prompt.
//
// Module 17's utilities, which are core competition content and the first
// half of the standard diagnostic sequence. Same engine underneath as the
// router CLI, so what a ping proves here is exactly what it proves there.

import { isIpv4, formatMacWindows, formatMac } from './addr.js';
import {
  getDevice, pingOnce, traceRoute, resolveName, applyDhcp, releaseDhcp,
  ifaceUp, FAIL
} from './net.js';

const pad = (s, n) => String(s ?? '').padEnd(n);

export function createPcSession(net, deviceId, opts = {}) {
  const dev = getDevice(net, deviceId);
  if (!dev || !dev.host) throw new Error(`${deviceId} has no command prompt`);
  return {
    net, dev, kind: 'pc',
    mode: 'pc',
    history: [], histIndex: -1,
    pending: null,
    onChange: opts.onChange || (() => {}),
    prompt: () => 'C:\\>'
  };
}

export function promptFor() { return 'C:\\>'; }

/* ----------------------------------------------------------- resolution --- */

/** Turn a host argument into an IP, resolving names through DNS if needed. */
function targetToIp(s, host) {
  if (isIpv4(host)) return { ok: true, ip: host };
  const r = resolveName(s.net, s.dev, host);
  if (r.ok) return { ok: true, ip: r.ip, name: host };
  return { ok: false, reason: r.reason, name: host };
}

/* ------------------------------------------------------------- commands --- */

function cmdIpconfig(s, args) {
  const dev = s.dev;
  const iface = dev.ifaces[0];
  const flag = (args[0] || '').toLowerCase();

  if (flag === '/release') {
    releaseDhcp(s.net, dev);
    return ['', `FastEthernet0 Connection:(default port)`, '',
            '   Link-local IPv6 Address.........: ::',
            '   IPv4 Address....................: 0.0.0.0',
            '   Subnet Mask.....................: 0.0.0.0',
            '   Default Gateway.................: 0.0.0.0', ''];
  }
  if (flag === '/renew') {
    const r = applyDhcp(s.net, dev);
    if (!r.ok) {
      return ['', '   No DHCP server could be reached.', '',
              '   IPv4 Address....................: 169.254.' +
              (Math.abs(hashCode(iface.mac)) % 254 + 1) + '.' + (Math.abs(hashCode(iface.name)) % 254 + 1),
              '   Subnet Mask.....................: 255.255.0.0',
              '   Default Gateway.................: 0.0.0.0', ''];
    }
    return cmdIpconfig(s, []);
  }

  const all = flag === '/all';
  const out = ['', 'FastEthernet0 Connection:(default port)', ''];
  if (all) {
    out.push(`   Physical Address................: ${formatMacWindows(iface.mac)}`);
    out.push('   Connection-specific DNS Suffix..: ');
  }
  out.push('   Link-local IPv6 Address.........: ' + (iface.ipv6.find(a => a.linkLocal)?.addr?.toUpperCase() || '::'));
  out.push('   IPv6 Address....................: ' + (iface.ipv6.find(a => !a.linkLocal)?.addr?.toUpperCase() || '::'));
  out.push('   IPv4 Address....................: ' + (iface.ip || '0.0.0.0'));
  out.push('   Subnet Mask.....................: ' + (iface.mask || '0.0.0.0'));
  out.push('   Default Gateway.................: ' + (dev.host.gateway || '0.0.0.0'));
  if (all) {
    out.push('   DHCP Servers....................: ' + (dev.host.dhcpServer || '0.0.0.0'));
    out.push('   DNS Servers.....................: ' + (dev.host.dnsServer || '0.0.0.0'));
    out.push('   DHCP Enabled....................: ' + (dev.host.dhcp ? 'Yes' : 'No'));
  }
  out.push('');
  return out;
}

function cmdPing(s, args) {
  let count = 4;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (/^-n$/i.test(args[i])) { count = Math.min(20, +args[++i] || 4); continue; }
    if (/^-t$/i.test(args[i])) { count = 8; continue; }
    rest.push(args[i]);
  }
  const host = rest[0];
  if (!host) return ['Invalid Command.', ''];

  const t = targetToIp(s, host);
  if (!t.ok) {
    return [`Ping request could not find host ${host}. Please check the name and try again.`, ''];
  }
  const target = t.ip;
  const label = t.name ? `${t.name} [${target}]` : target;

  const hadArp = s.dev.arp.length > 0;
  const r = pingOnce(s.net, s.dev, target);
  s.lastTrace = r;

  const out = ['', `Pinging ${label} with 32 bytes of data:`, ''];
  const replies = [];

  for (let i = 0; i < count; i++) {
    if (r.ok) {
      // The first echo is normally lost to ARP, which is why students see
      // four dots and a success and should not panic.
      if (i === 0 && !hadArp && r.hops.length) { replies.push(null); out.push('Request timed out.'); continue; }
      const ttl = 128 - (r.hops.filter(h => h.device !== s.dev.id).length);
      const ms = i === 0 ? 1 : 0;
      replies.push(ms);
      out.push(`Reply from ${target}: bytes=32 time${ms ? '=' + ms + 'ms' : '<1ms'} TTL=${ttl}`);
    } else if (r.failure === FAIL.NO_GATEWAY || (r.failure === FAIL.NO_ROUTE && r.failedAt !== s.dev.id)) {
      const from = r.failure === FAIL.NO_GATEWAY ? (s.dev.ifaces[0].ip || '0.0.0.0') : routerIp(s, r);
      replies.push(null);
      out.push(`Reply from ${from}: Destination host unreachable.`);
    } else {
      replies.push(null);
      out.push('Request timed out.');
    }
  }

  const got = replies.filter(x => x !== null);
  const lost = count - got.length;
  out.push('', `Ping statistics for ${target}:`);
  out.push(`    Packets: Sent = ${count}, Received = ${got.length}, Lost = ${lost} (${Math.round(lost / count * 100)}% loss),`);
  if (got.length) {
    out.push('Approximate round trip times in milli-seconds:');
    out.push(`    Minimum = ${Math.min(...got)}ms, Maximum = ${Math.max(...got)}ms, Average = ${Math.round(got.reduce((a, b) => a + b, 0) / got.length)}ms`);
  }
  out.push('');
  return out;
}

function routerIp(s, r) {
  const dev = getDevice(s.net, r.failedAt);
  const lastHop = (r.hops || [])[(r.hops || []).length - 1];
  if (!dev) return '0.0.0.0';
  const inIf = lastHop ? dev.ifaces.find(i => i.name === lastHop.inIface) : null;
  return inIf?.ip || dev.ifaces.find(i => i.ip)?.ip || '0.0.0.0';
}

function cmdTracert(s, args) {
  const host = args[0];
  if (!host) return ['Invalid Command.', ''];
  const t = targetToIp(s, host);
  if (!t.ok) return [`Unable to resolve target system name ${host}.`, ''];

  const tr = traceRoute(s.net, s.dev, t.ip);
  const out = ['', `Tracing route to ${t.name ? t.name + ' [' + t.ip + ']' : t.ip} over a maximum of 30 hops: `, ''];
  for (const hop of tr.results) {
    out.push(hop.ip
      ? `  ${pad(hop.ttl, 3)} ${pad(hop.ttl === 1 ? '0 ms' : hop.ttl + ' ms', 9)} ${pad('0 ms', 9)} ${pad('0 ms', 9)} ${hop.ip}`
      : `  ${pad(hop.ttl, 3)} ${pad('*', 9)} ${pad('*', 9)} ${pad('*', 9)} Request timed out.`);
  }
  out.push('', tr.ok ? 'Trace complete.' : '');
  return out;
}

function cmdArp(s, args) {
  const flag = (args[0] || '-a').toLowerCase();
  if (flag === '-d') { s.dev.arp = []; return ['']; }
  const iface = s.dev.ifaces[0];
  if (!s.dev.arp.length) {
    return ['No ARP Entries Found', ''];
  }
  const out = ['', `Interface: ${iface.ip} --- 0x2`,
               '  Internet Address      Physical Address      Type'];
  for (const a of s.dev.arp) {
    out.push('  ' + pad(a.ip, 22) + pad(formatMac(a.mac).toLowerCase(), 22) + 'dynamic');
  }
  out.push('');
  return out;
}

function cmdNslookup(s, args) {
  const name = args[0];
  const server = s.dev.host.dnsServer;
  if (!server || server === '0.0.0.0') {
    return ['', '*** Can\'t find server name for address: Timed out', ''];
  }
  if (!name) {
    return ['', `Server:  [${server}]`, `Address:  ${server}`, ''];
  }
  const r = resolveName(s.net, s.dev, name);
  const head = ['', `Server:  [${server}]`, `Address:  ${server}`, ''];
  if (r.ok) {
    head.push(`Name:      ${name}`, `Address:  ${r.ip}`, '');
    return head;
  }
  if (r.reason === 'unreachable' || r.reason === 'no-service') {
    head.push(`*** Request to [${server}] timed-out`, '');
  } else {
    head.push(`*** [${server}] can't find ${name}: Non-existent domain`, '');
  }
  return head;
}

function cmdHelp() {
  return ['', 'Available Commands:', '',
    '  arp        - Display or clear the ARP cache',
    '  ipconfig   - Display IP configuration  (/all  /release  /renew)',
    '  nslookup   - Query a DNS server for a name',
    '  ping       - Test reachability of a host  (-n count)',
    '  tracert    - Show the path to a host',
    '  cls        - Clear the screen',
    ''];
}

const COMMANDS = {
  ipconfig: cmdIpconfig,
  ping: cmdPing,
  tracert: cmdTracert,
  traceroute: cmdTracert,
  arp: cmdArp,
  nslookup: cmdNslookup,
  help: cmdHelp,
  '?': cmdHelp
};

/* -------------------------------------------------------------- execute --- */

export function executePc(session, rawLine) {
  const line = rawLine.trim();
  if (!line) return { lines: [] };
  const parts = line.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (cmd === 'cls' || cmd === 'clear') return { lines: [], clear: true };
  if (cmd === 'exit') { session.loggedOut = true; return { lines: [] }; }

  const fn = COMMANDS[cmd];
  if (!fn) return { lines: ['Invalid Command.', ''] };
  const out = fn(session, args) || [];
  session.onChange(session);
  return { lines: out };
}

export function pcHelp() {
  return Object.keys(COMMANDS).filter(k => k !== '?');
}

export function pcComplete(session, line) {
  if (/\s/.test(line.trim())) return { line };
  const matches = Object.keys(COMMANDS).filter(k => k !== '?' && k.startsWith(line.trim().toLowerCase()));
  if (matches.length === 1) return { line: matches[0] + ' ' };
  if (matches.length > 1) return { line, lines: matches.map(m => '  ' + m) };
  return { line };
}

/* ------------------------------------------------- IP Configuration panel --- */
// Packet Tracer students set host addressing through a dialog, not a command.
// These are what the UI panel calls.

export function setStatic(net, dev, { ip, mask, gateway, dns }) {
  dev.host.dhcp = false;
  dev.ifaces[0].ip = ip || null;
  dev.ifaces[0].mask = mask || null;
  dev.ifaces[0].configuredBy = 'manual';
  dev.host.gateway = gateway || null;
  dev.host.dnsServer = dns || null;
  dev.host.apipa = false;
}

export function setDhcp(net, dev) {
  dev.host.dhcp = true;
  dev.ifaces[0].configuredBy = 'dhcp';
  return applyDhcp(net, dev);
}

function hashCode(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
