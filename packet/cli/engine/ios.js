// ios.js — the IOS command line: mode hierarchy, command tree, abbreviation,
// context-sensitive help, Tab completion, and the error messages students
// need to learn to read.
//
// The tree is data. `parse()` walks it the way IOS does — unique-prefix
// matching, ambiguity detection, and a caret under the first token it could
// not understand.

import {
  isIpv4, isValidMask, maskToCidr, cidrToMask, expandIpv6, compressIpv6,
  formatMac, networkOf
} from './addr.js';
import {
  getDevice, getIface, ifaceUp, lineStatus, pingOnce, traceRoute,
  captureConfigState, restoreConfigState, FAIL, applyDhcp
} from './net.js';
import * as show from './show.js';

/* ------------------------------------------------------------- helpers --- */

const MODES = {
  user:          { suffix: '>',              name: 'User EXEC' },
  priv:          { suffix: '#',              name: 'Privileged EXEC' },
  config:        { suffix: '(config)#',      name: 'Global configuration' },
  'config-if':   { suffix: '(config-if)#',   name: 'Interface configuration' },
  'config-line': { suffix: '(config-line)#', name: 'Line configuration' },
  'config-dhcp': { suffix: '(dhcp-config)#', name: 'DHCP pool configuration' }
};

export const CONFIG_MODES = ['config', 'config-if', 'config-line', 'config-dhcp'];

/** Node constructor. Keeps the tree readable. */
function n(kw, help, opts = {}) {
  return { kw, help, children: [], ...opts };
}
function arg(type, help, opts = {}) {
  return { argType: type, help, children: [], ...opts };
}

/* ------------------------------------------- interface name resolution --- */

const IF_PREFIXES = [
  { re: /^g(i(g(a(b(i(t(e(t(h(e(r(n(e(t)?)?)?)?)?)?)?)?)?)?)?)?)?)?$/i, full: 'GigabitEthernet' },
  { re: /^f(a(s(t(e(t(h(e(r(n(e(t)?)?)?)?)?)?)?)?)?)?)?$/i,             full: 'FastEthernet' },
  { re: /^s(e(r(i(a(l)?)?)?)?)?$/i,                                     full: 'Serial' },
  { re: /^v(l(a(n)?)?)?$/i,                                             full: 'Vlan' },
  { re: /^e(t(h(e(r(n(e(t)?)?)?)?)?)?)?$/i,                             full: 'Ethernet' }
];

/**
 * Accepts every spelling PT accepts: `g0/0`, `gi 0/0`, `gigabitethernet0/0`,
 * `int vlan 1`. Returns {iface, consumed} or null.
 */
export function resolveInterface(dev, tokens, start = 0) {
  const t0 = tokens[start];
  if (!t0) return null;
  const split = t0.match(/^([a-zA-Z]+)([\d/.]*)$/);
  if (!split) return null;
  const word = split[1];
  let number = split[2];
  let consumed = 1;
  if (!number) {
    number = tokens[start + 1];
    if (!number || !/^[\d/.]+$/.test(number)) return null;
    consumed = 2;
  }
  for (const p of IF_PREFIXES) {
    if (!p.re.test(word)) continue;
    const candidates = dev.ifaces.filter(i =>
      i.name.toLowerCase().startsWith(p.full.toLowerCase()) &&
      i.name.slice(p.full.length) === number);
    if (candidates.length === 1) return { iface: candidates[0], consumed };
    // Vlan1 has no slash — allow the exact match above to fail through.
  }
  return null;
}

/* ---------------------------------------------------------- validation --- */

function validateArg(type, tok, session) {
  switch (type) {
    case 'A.B.C.D':  return isIpv4(tok);
    case 'MASK':     return isValidMask(tok);
    case 'WORD':     return /^\S+$/.test(tok) && !/^\?$/.test(tok);
    case 'NUMBER':   return /^\d+$/.test(tok);
    case 'LINE':     return true;
    case 'IPV6':     return expandIpv6(tok) !== null;
    case 'IPV6PREFIX': {
      const [a, l] = tok.split('/');
      return expandIpv6(a) !== null && /^\d{1,3}$/.test(l || '') && +l <= 128;
    }
    case 'IFACE':    return resolveInterface(session.dev, [tok]) !== null ||
                            /^[a-zA-Z]+$/.test(tok);   // may need a second token
    default:         return false;
  }
}

/* --------------------------------------------------------------- parse --- */

const PARSE = { OK: 'ok', AMBIGUOUS: 'ambiguous', INVALID: 'invalid', INCOMPLETE: 'incomplete' };

function childrenFor(node, session) {
  return (node.children || []).filter(c => !c.modes || c.modes.includes(session.mode));
}

function matchKeywords(kids, tok) {
  const lower = tok.toLowerCase();
  const exact = kids.filter(c => c.kw && c.kw.toLowerCase() === lower);
  if (exact.length) return exact;
  return kids.filter(c => c.kw && c.kw.toLowerCase().startsWith(lower));
}

/**
 * Walk the tree. Returns
 *   { status, node, args }                    on success
 *   { status:'invalid', index }               with the token index to point at
 *   { status:'ambiguous', index, matches }
 *   { status:'incomplete' }
 */
export function parse(root, tokens, session) {
  let node = root;
  const args = {};
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];
    const kids = childrenFor(node, session);
    const kwMatches = matchKeywords(kids, tok);

    if (kwMatches.length > 1) return { status: PARSE.AMBIGUOUS, index: i, matches: kwMatches };
    if (kwMatches.length === 1) {
      node = kwMatches[0];
      if (node.name) args[node.name] = node.kw;
      i++;
      continue;
    }

    const argKids = kids.filter(c => c.argType);
    let advanced = false;
    for (const a of argKids) {
      if (a.argType === 'LINE') {
        args[a.name] = tokens.slice(i).join(' ');
        node = a; i = tokens.length; advanced = true; break;
      }
      if (a.argType === 'IFACE') {
        const r = resolveInterface(session.dev, tokens, i);
        if (!r) continue;
        args[a.name] = r.iface;
        node = a; i += r.consumed; advanced = true; break;
      }
      if (validateArg(a.argType, tok, session)) {
        args[a.name] = tok;
        node = a; i++; advanced = true; break;
      }
    }
    if (advanced) continue;
    return { status: PARSE.INVALID, index: i };
  }

  if (!node.run) {
    // Nothing runnable here — either more words are needed, or nothing exists.
    return { status: PARSE.INCOMPLETE, node };
  }
  return { status: PARSE.OK, node, args };
}

/* ---------------------------------------------------------------- help --- */

function helpList(node, session, partial = '') {
  const kids = childrenFor(node, session);
  const lines = [];
  const kws = kids.filter(c => c.kw && (!partial || c.kw.toLowerCase().startsWith(partial.toLowerCase())));
  const argsK = partial ? [] : kids.filter(c => c.argType);
  const width = Math.max(10, ...[...kws.map(k => k.kw.length), ...argsK.map(a => a.argType.length)]) + 2;
  for (const a of argsK) lines.push('  ' + a.argType.padEnd(width) + a.help);
  for (const k of kws) lines.push('  ' + k.kw.padEnd(width) + k.help);
  if (node.run && !partial) lines.push('  ' + '<cr>'.padEnd(width));
  if (!lines.length) lines.push('% Unrecognized command');
  return lines;
}

/* ------------------------------------------------------------- session --- */

let sessionSeq = 0;

export function createSession(net, deviceId, opts = {}) {
  const dev = getDevice(net, deviceId);
  if (!dev) throw new Error(`no device ${deviceId}`);
  const session = {
    id: ++sessionSeq,
    net, dev,
    mode: opts.mode || 'user',
    ctxIface: null, ctxLine: null, ctxPool: null,
    history: [], histIndex: -1,
    pending: null,
    authenticated: false,
    onChange: opts.onChange || (() => {}),
    banner: !!dev.bannerMotd
  };
  session.prompt = () => promptFor(session);
  return session;
}

export function promptFor(s) {
  return s.dev.hostname + MODES[s.mode].suffix;
}

/** Console messages queued on a device, drained when its terminal renders. */
function emit(s, dev, text) {
  dev.log.push(text);
}

function linkMessages(s, dev, iface, before) {
  const after = lineStatus(s.net, dev, iface);
  const adminNow = iface.shutdown;
  if (adminNow) {
    emit(s, dev, `%LINK-5-CHANGED: Interface ${iface.name}, changed state to administratively down`);
    if (before === 'up') emit(s, dev, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface.name}, changed state to down`);
  } else if (after !== before) {
    emit(s, dev, `%LINK-5-CHANGED: Interface ${iface.name}, changed state to ${after}`);
    emit(s, dev, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${iface.name}, changed state to ${after}`);
  }
}

/* ----------------------------------------------------------- the tree --- */
// Built once and shared. Nodes carry `run(session, args) -> string[]`.

function buildTree() {
  const root = n(null, null);
  const add = (parent, node) => { parent.children.push(node); return node; };

  /* ---------------- EXEC ---------------- */

  const enable = add(root, n('enable', 'Turn on privileged commands', { modes: ['user'] }));
  enable.run = (s) => {
    if (s.dev.enableSecret || s.dev.enablePassword) {
      s.pending = {
        prompt: 'Password: ', secret: true,
        handle: (input) => {
          const want = s.dev.enableSecret || s.dev.enablePassword;
          if (input === want) { s.mode = 'priv'; return []; }
          return ['% Bad secrets', ''];
        }
      };
      return [];
    }
    s.mode = 'priv';
    return [];
  };

  const disable = add(root, n('disable', 'Turn off privileged commands', { modes: ['priv'] }));
  disable.run = (s) => { s.mode = 'user'; return []; };

  const exitN = add(root, n('exit', 'Exit from the EXEC'));
  exitN.run = (s) => {
    if (s.mode === 'config-if' || s.mode === 'config-line' || s.mode === 'config-dhcp') {
      s.mode = 'config'; s.ctxIface = null; s.ctxLine = null; s.ctxPool = null; return [];
    }
    if (s.mode === 'config') { s.mode = 'priv'; emit(s, s.dev, '%SYS-5-CONFIG_I: Configured from console by console'); return []; }
    if (s.mode === 'priv') { s.mode = 'user'; return []; }
    s.loggedOut = true;
    return [];
  };

  const endN = add(root, n('end', 'Exit to privileged EXEC mode', { modes: CONFIG_MODES }));
  endN.run = (s) => {
    s.mode = 'priv'; s.ctxIface = null; s.ctxLine = null; s.ctxPool = null;
    emit(s, s.dev, '%SYS-5-CONFIG_I: Configured from console by console');
    return [];
  };

  /* ---------------- ping / traceroute ---------------- */

  const ping = add(root, n('ping', 'Send echo messages', { modes: ['user', 'priv'] }));
  const pingTarget = add(ping, arg('A.B.C.D', 'Target IP address', { name: 'target' }));
  pingTarget.run = (s, a) => iosPing(s, a.target);

  const tr = add(root, n('traceroute', 'Trace route to destination', { modes: ['user', 'priv'] }));
  const trTarget = add(tr, arg('A.B.C.D', 'Target IP address', { name: 'target' }));
  trTarget.run = (s, a) => iosTraceroute(s, a.target);

  /* ---------------- show ---------------- */

  const showN = add(root, n('show', 'Show running system information', { modes: ['user', 'priv'] }));

  add(showN, n('version', 'System hardware and software status')).run =
    (s) => show.showVersion(s.net, s.dev);

  add(showN, n('running-config', 'Current operating configuration', { modes: ['priv'] })).run =
    (s) => { s.dev.viewedRunning = true; return show.buildRunningConfig(s.net, s.dev); };

  add(showN, n('startup-config', 'Contents of startup configuration', { modes: ['priv'] })).run =
    (s) => s.dev.startupConfig
      ? ['Using 1024 bytes', '!', ...s.dev.startupConfig]
      : ['startup-config is not present', ''];

  add(showN, n('arp', 'ARP table')).run = (s) => show.showArp(s.net, s.dev);

  add(showN, n('mac', 'MAC configuration')).children.push(
    (() => {
      const at = n('address-table', 'MAC forwarding table');
      at.run = (s) => show.showMacAddressTable(s.net, s.dev);
      return at;
    })()
  );
  // `show mac-address-table` is also accepted on some images.
  add(showN, n('mac-address-table', 'MAC forwarding table')).run =
    (s) => show.showMacAddressTable(s.net, s.dev);

  const showIp = add(showN, n('ip', 'IP information'));
  const showIpInt = add(showIp, n('interface', 'IP interface status and configuration'));
  add(showIpInt, n('brief', 'Brief summary of IP status and configuration')).run =
    (s) => show.showIpInterfaceBrief(s.net, s.dev);

  const showIpRoute = add(showIp, n('route', 'IP routing table'));
  showIpRoute.run = (s) => show.showIpRoute(s.net, s.dev);
  add(showIpRoute, n('static', 'Static routes')).run = (s) => show.showIpRoute(s.net, s.dev, 'static');
  add(showIpRoute, n('connected', 'Connected routes')).run = (s) => show.showIpRoute(s.net, s.dev, 'connected');

  add(showIp, n('arp', 'IP ARP table')).run = (s) => show.showArp(s.net, s.dev);

  const showIpDhcp = add(showIp, n('dhcp', 'Show items in the DHCP database'));
  add(showIpDhcp, n('binding', 'DHCP address bindings')).run = (s) => show.showDhcpBinding(s.net, s.dev);
  add(showIpDhcp, n('pool', 'DHCP pools information')).run = (s) => show.showDhcpPool(s.net, s.dev);

  const showV6 = add(showN, n('ipv6', 'IPv6 information'));
  const showV6Int = add(showV6, n('interface', 'IPv6 interface status'));
  add(showV6Int, n('brief', 'Brief summary of IPv6 status')).run =
    (s) => show.showIpv6InterfaceBrief(s.net, s.dev);
  add(showV6, n('route', 'IPv6 routing table')).run = (s) => {
    const rows = s.dev.ifaces.flatMap(i =>
      i.ipv6.filter(a => !a.linkLocal && ifaceUp(s.net, s.dev, i))
        .map(a => `C   ${a.addr.toUpperCase()}/${a.prefixLen} [0/0]`  + `\n     via ${i.name}, directly connected`));
    return ['IPv6 Routing Table - default - ' + (rows.length + 1) + ' entries',
            'Codes: C - Connected, L - Local, S - Static, U - Per-user Static route', ...rows, ''];
  };

  const showInt = add(showN, n('interfaces', 'Interface status and configuration'));
  showInt.run = (s) => s.dev.ifaces.flatMap(i => [...show.showInterface(s.net, s.dev, i), '']);
  add(showInt, n('status', 'Interface line status')).run = (s) => show.showInterfacesStatus(s.net, s.dev);
  add(showInt, arg('IFACE', 'Interface name', { name: 'iface' })).run =
    (s, a) => show.showInterface(s.net, s.dev, a.iface);

  add(showN, n('vlan', 'VTP VLAN status')).children.push((() => {
    const b = n('brief', 'VTP all VLAN status in brief');
    b.run = (s) => {
      const out = ['VLAN Name                             Status    Ports',
                   '---- -------------------------------- --------- -------------------------------'];
      const ports = s.dev.ifaces.filter(i => i.switchport && i.vlan === 1).map(i => show.shortIf(i.name));
      out.push('1    default                          active    ' + ports.slice(0, 6).join(', '));
      for (let k = 6; k < ports.length; k += 6) out.push(' '.repeat(48) + ports.slice(k, k + 6).join(', '));
      return out;
    };
    return b;
  })());

  /* ---------------- privileged actions ---------------- */

  const configure = add(root, n('configure', 'Enter configuration mode', { modes: ['priv'] }));
  add(configure, n('terminal', 'Configure from the terminal')).run = (s) => {
    s.mode = 'config';
    return ['Enter configuration commands, one per line.  End with CNTL/Z.'];
  };

  const copy = add(root, n('copy', 'Copy from one file to another', { modes: ['priv'] }));
  const copyRun = add(copy, n('running-config', 'Copy from current system configuration'));
  add(copyRun, n('startup-config', 'Copy to startup configuration')).run = (s) => {
    s.pending = {
      prompt: 'Destination filename [startup-config]? ',
      handle: () => { saveConfig(s); return ['Building configuration...', '[OK]', '']; }
    };
    return [];
  };

  const write = add(root, n('write', 'Write running configuration to memory', { modes: ['priv'] }));
  write.run = (s) => { saveConfig(s); return ['Building configuration...', '[OK]']; };
  add(write, n('memory', 'Write to NV memory')).run = (s) => { saveConfig(s); return ['Building configuration...', '[OK]']; };

  const erase = add(root, n('erase', 'Erase a filesystem', { modes: ['priv'] }));
  add(erase, n('startup-config', 'Erase contents of configuration memory')).run = (s) => {
    s.pending = {
      prompt: 'Erasing the nvram filesystem will remove all configuration files! Continue? [confirm]',
      handle: () => { s.dev.startupConfig = null; s.dev.savedAt = null; return ['[OK]', 'Erase of nvram: complete']; }
    };
    return [];
  };

  const reload = add(root, n('reload', 'Halt and perform a cold restart', { modes: ['priv'] }));
  reload.run = (s) => {
    const dirty = configIsDirty(s);
    s.pending = {
      prompt: dirty
        ? 'System configuration has been modified. Save? [yes/no]: '
        : 'Proceed with reload? [confirm]',
      handle: (input) => {
        if (dirty && /^y/i.test(input || '')) saveConfig(s);
        doReload(s);
        return ['', 'System Bootstrap, Version 15.1(4)M4', '',
                s.dev.startupConfig ? '' : '--- System Configuration Dialog ---',
                'Press RETURN to get started!', ''];
      }
    };
    return [];
  };

  const clear = add(root, n('clear', 'Reset functions', { modes: ['priv'] }));
  const clearMac = add(clear, n('mac', 'MAC forwarding table'));
  const clearMacAt = add(clearMac, n('address-table', 'MAC forwarding table'));
  clearMacAt.run = (s) => { s.dev.macTable = []; return []; };
  add(clearMacAt, n('dynamic', 'Dynamic entries')).run = (s) => {
    s.dev.macTable = s.dev.macTable.filter(e => e.type !== 'DYNAMIC');
    return [];
  };
  add(clear, n('arp-cache', 'Clear the entire ARP cache')).run = (s) => { s.dev.arp = []; return []; };

  /* ---------------- global configuration ---------------- */

  const cfgOnly = { modes: ['config'] };

  const hostname = add(root, n('hostname', 'Set system network name', cfgOnly));
  add(hostname, arg('WORD', 'This system network name', { name: 'name' })).run = (s, a) => {
    s.dev.hostname = a.name; return [];
  };

  const enableCfg = add(root, n('enable', 'Modify enable password parameters', cfgOnly));
  const enSecret = add(enableCfg, n('secret', 'Assign the privileged level secret'));
  add(enSecret, arg('WORD', 'The unencrypted (cleartext) secret', { name: 'pw' })).run = (s, a) => {
    if (a.no) { s.dev.enableSecret = null; return []; }
    s.dev.enableSecret = a.pw; return [];
  };
  const enPass = add(enableCfg, n('password', 'Assign the privileged level password'));
  add(enPass, arg('WORD', 'The unencrypted (cleartext) password', { name: 'pw' })).run = (s, a) => {
    if (a.no) { s.dev.enablePassword = null; return []; }
    s.dev.enablePassword = a.pw; return [];
  };

  const service = add(root, n('service', 'Modify use of network based services', cfgOnly));
  add(service, n('password-encryption', 'Encrypt system passwords')).run = (s, a) => {
    s.dev.passwordEncryption = !a.no; return [];
  };

  const banner = add(root, n('banner', 'Define a login banner', cfgOnly));
  const motd = add(banner, n('motd', 'Set Message of the Day banner'));
  add(motd, arg('LINE', 'c  Message text, delimited by c', { name: 'text' })).run = (s, a) => {
    const raw = a.text.trim();
    const delim = raw[0];
    const rest = raw.slice(1);
    if (rest.includes(delim)) {
      s.dev.bannerMotd = rest.slice(0, rest.indexOf(delim));
      return [];
    }
    // Multi-line banner: keep reading until the delimiter shows up.
    const buf = [rest];
    s.pending = {
      prompt: '',
      multiline: true,
      handle: (input) => {
        if (input.includes(delim)) {
          buf.push(input.slice(0, input.indexOf(delim)));
          s.dev.bannerMotd = buf.join('\n').replace(/^\n+/, '');
          s.pending = null;
          return [];
        }
        buf.push(input);
        s.pending.keep = true;
        return [];
      }
    };
    return [`Enter TEXT message.  End with the character '${delim}'.`];
  };

  const ipCfg = add(root, n('ip', 'Global IP configuration subcommands', cfgOnly));

  const ipRoute = add(ipCfg, n('route', 'Establish static routes'));
  const rPrefix = add(ipRoute, arg('A.B.C.D', 'Destination prefix', { name: 'prefix' }));
  const rMask = add(rPrefix, arg('MASK', 'Destination prefix mask', { name: 'mask' }));
  add(rMask, arg('A.B.C.D', 'Forwarding router\'s address', { name: 'nextHop' })).run = (s, a) => {
    return setRoute(s, a, a.nextHop, null);
  };
  add(rMask, arg('IFACE', 'Exit interface', { name: 'exitIf' })).run = (s, a) => {
    return setRoute(s, a, null, a.exitIf.name);
  };

  const ipDomain = add(ipCfg, n('domain-lookup', 'Enable IP Domain Name System hostname translation'));
  ipDomain.run = (s, a) => { s.dev.domainLookup = !a.no; return []; };

  const ipDefGw = add(ipCfg, n('default-gateway', 'Specify default gateway (if not routing IP)'));
  add(ipDefGw, arg('A.B.C.D', 'IP address of default gateway', { name: 'gw' })).run = (s, a) => {
    s.dev.defaultGateway = a.no ? null : a.gw; return [];
  };

  const ipDhcp = add(ipCfg, n('dhcp', 'Configure DHCP server and relay parameters'));
  const excl = add(ipDhcp, n('excluded-address', 'Prevent DHCP from assigning certain addresses'));
  const exclStart = add(excl, arg('A.B.C.D', 'Low IP address', { name: 'start' }));
  exclStart.run = (s, a) => addExcluded(s, a.start, a.start, a.no);
  add(exclStart, arg('A.B.C.D', 'High IP address', { name: 'end' })).run =
    (s, a) => addExcluded(s, a.start, a.end, a.no);

  const dhcpPool = add(ipDhcp, n('pool', 'Configure DHCP address pools'));
  add(dhcpPool, arg('WORD', 'Pool name', { name: 'pool' })).run = (s, a) => {
    if (a.no) {
      s.dev.dhcpPools = s.dev.dhcpPools.filter(p => p.name !== a.pool);
      return [];
    }
    let p = s.dev.dhcpPools.find(x => x.name === a.pool);
    if (!p) { p = { name: a.pool, network: null, mask: null, defaultRouter: null, dnsServer: null, domain: null }; s.dev.dhcpPools.push(p); }
    s.mode = 'config-dhcp'; s.ctxPool = p;
    return [];
  };

  const ipv6Cfg = add(root, n('ipv6', 'Global IPv6 configuration commands', cfgOnly));
  add(ipv6Cfg, n('unicast-routing', 'Enable unicast routing')).run = (s, a) => {
    s.dev.ipv6Routing = !a.no; return [];
  };
  const v6Route = add(ipv6Cfg, n('route', 'Configure static routes'));
  const v6Prefix = add(v6Route, arg('IPV6PREFIX', 'IPv6 prefix X:X:X:X::X/<0-128>', { name: 'prefix' }));
  add(v6Prefix, arg('IPV6', 'IPv6 address of next hop', { name: 'nextHop' })).run = (s, a) => {
    const [p, len] = a.prefix.split('/');
    if (a.no) {
      s.dev.staticRoutes = s.dev.staticRoutes.filter(r => !(r.ipv6 && r.prefix === p));
      return [];
    }
    s.dev.staticRoutes.push({ prefix: p, prefixLen: +len, mask: null, nextHop: a.nextHop, exitIf: null, ipv6: true });
    return [];
  };

  const iface = add(root, n('interface', 'Select an interface to configure', cfgOnly));
  add(iface, arg('IFACE', 'Interface name', { name: 'iface' })).run = (s, a) => {
    s.mode = 'config-if'; s.ctxIface = a.iface; return [];
  };

  const line = add(root, n('line', 'Configure a terminal line', cfgOnly));
  const lineCon = add(line, n('console', 'Primary terminal line'));
  add(lineCon, arg('NUMBER', 'First line number', { name: 'num' })).run = (s) => {
    s.mode = 'config-line'; s.ctxLine = 'console'; return [];
  };
  const lineVty = add(line, n('vty', 'Virtual terminal'));
  const vtyFirst = add(lineVty, arg('NUMBER', 'First line number', { name: 'first' }));
  vtyFirst.run = (s) => { s.mode = 'config-line'; s.ctxLine = 'vty'; return []; };
  add(vtyFirst, arg('NUMBER', 'Last line number', { name: 'last' })).run = (s) => {
    s.mode = 'config-line'; s.ctxLine = 'vty'; return [];
  };

  /* ---------------- interface configuration ---------------- */

  const ifOnly = { modes: ['config-if'] };

  const ifIp = add(root, n('ip', 'Interface Internet Protocol config commands', ifOnly));
  const ifIpAddr = add(ifIp, n('address', 'Set the IP address of an interface'));
  ifIpAddr.run = (s, a) => {
    if (a.no) { s.ctxIface.ip = null; s.ctxIface.mask = null; return []; }
    return ['% Incomplete command.', ''];
  };
  const ifIpA = add(ifIpAddr, arg('A.B.C.D', 'IP address', { name: 'ip' }));
  add(ifIpA, arg('MASK', 'IP subnet mask', { name: 'mask' })).run = (s, a) => {
    if (a.no) { s.ctxIface.ip = null; s.ctxIface.mask = null; return []; }
    const conflict = overlapCheck(s, a.ip, a.mask);
    if (conflict) return [`% ${a.ip} overlaps with ${conflict.name}`, ''];
    s.ctxIface.ip = a.ip;
    s.ctxIface.mask = a.mask;
    s.ctxIface.configuredBy = 'manual';
    return [];
  };
  add(ifIpAddr, n('dhcp', 'IP address negotiated via DHCP')).run = (s) => {
    s.ctxIface.configuredBy = 'dhcp';
    return [];
  };

  const ifV6 = add(root, n('ipv6', 'IPv6 interface subcommands', ifOnly));
  const ifV6Addr = add(ifV6, n('address', 'Configure IPv6 address on interface'));
  const ifV6A = add(ifV6Addr, arg('IPV6PREFIX', 'IPv6 prefix X:X:X:X::X/<0-128>', { name: 'addr' }));
  ifV6A.run = (s, a) => {
    const [addr, len] = a.addr.split('/');
    if (a.no) {
      s.ctxIface.ipv6 = s.ctxIface.ipv6.filter(x => x.addr.toLowerCase() !== addr.toLowerCase());
      return [];
    }
    s.ctxIface.ipv6.push({ addr: compressIpv6(addr), prefixLen: +len, linkLocal: false });
    return [];
  };
  const ifV6LL = add(ifV6Addr, arg('IPV6', 'IPv6 link-local address', { name: 'addr' }));
  add(ifV6LL, n('link-local', 'Use link-local address')).run = (s, a) => {
    if (a.no) { s.ctxIface.ipv6 = s.ctxIface.ipv6.filter(x => !x.linkLocal); return []; }
    s.ctxIface.ipv6 = s.ctxIface.ipv6.filter(x => !x.linkLocal);
    s.ctxIface.ipv6.push({ addr: compressIpv6(a.addr), prefixLen: 64, linkLocal: true });
    return [];
  };

  const desc = add(root, n('description', 'Interface specific description', ifOnly));
  add(desc, arg('LINE', 'Up to 240 characters describing this interface', { name: 'text' })).run = (s, a) => {
    s.ctxIface.description = a.no ? null : a.text; return [];
  };

  const shut = add(root, n('shutdown', 'Shutdown the selected interface', ifOnly));
  shut.run = (s, a) => {
    const before = lineStatus(s.net, s.dev, s.ctxIface);
    s.ctxIface.shutdown = !a.no;
    linkMessages(s, s.dev, s.ctxIface, before);
    notifyPeer(s, s.ctxIface);
    return [];
  };

  const swp = add(root, n('switchport', 'Set switching mode characteristics', ifOnly));
  const swpAccess = add(swp, n('access', 'Set access mode characteristics'));
  const swpVlan = add(swpAccess, n('vlan', 'Set VLAN when interface is in access mode'));
  add(swpVlan, arg('NUMBER', 'VLAN ID of the VLAN', { name: 'vlan' })).run = (s, a) => {
    s.ctxIface.vlan = a.no ? 1 : +a.vlan; return [];
  };
  const swpMode = add(swp, n('mode', 'Set trunking mode of the interface'));
  add(swpMode, n('access', 'Set trunking mode to ACCESS unconditionally')).run = () => [];

  /* ---------------- line configuration ---------------- */

  const lineOnly = { modes: ['config-line'] };
  const linePw = add(root, n('password', 'Set a password', lineOnly));
  add(linePw, arg('WORD', 'The UNENCRYPTED (cleartext) line password', { name: 'pw' })).run = (s, a) => {
    s.dev.lines[s.ctxLine].password = a.no ? null : a.pw; return [];
  };
  const lineLogin = add(root, n('login', 'Enable password checking', lineOnly));
  lineLogin.run = (s, a) => { s.dev.lines[s.ctxLine].login = !a.no; return []; };
  const lineTimeout = add(root, n('exec-timeout', 'Set the EXEC timeout', lineOnly));
  const lto = add(lineTimeout, arg('NUMBER', 'Timeout in minutes', { name: 'min' }));
  lto.run = () => [];
  add(lto, arg('NUMBER', 'Timeout in seconds', { name: 'sec' })).run = () => [];
  add(root, n('logging', 'Modify message logging facilities', lineOnly)).children.push(
    (() => { const sy = n('synchronous', 'Synchronized message output'); sy.run = () => []; return sy; })()
  );

  /* ---------------- DHCP pool configuration ---------------- */

  const poolOnly = { modes: ['config-dhcp'] };
  const pNet = add(root, n('network', 'Network number and mask', poolOnly));
  const pNetA = add(pNet, arg('A.B.C.D', 'The network number', { name: 'net' }));
  pNetA.run = (s, a) => { s.ctxPool.network = a.net; s.ctxPool.mask = '255.255.255.0'; return []; };
  add(pNetA, arg('MASK', 'Network mask', { name: 'mask' })).run = (s, a) => {
    s.ctxPool.network = networkOf(a.net, a.mask);
    s.ctxPool.mask = a.mask;
    return [];
  };
  const pRouter = add(root, n('default-router', 'Default routers', poolOnly));
  add(pRouter, arg('A.B.C.D', 'Router IP address', { name: 'ip' })).run = (s, a) => {
    s.ctxPool.defaultRouter = a.no ? null : a.ip; return [];
  };
  const pDns = add(root, n('dns-server', 'DNS servers', poolOnly));
  add(pDns, arg('A.B.C.D', 'Server IP address', { name: 'ip' })).run = (s, a) => {
    s.ctxPool.dnsServer = a.no ? null : a.ip; return [];
  };
  const pDomain = add(root, n('domain-name', 'Domain name', poolOnly));
  add(pDomain, arg('WORD', 'Domain name', { name: 'name' })).run = (s, a) => {
    s.ctxPool.domain = a.no ? null : a.name; return [];
  };

  return root;
}

/* --------------------------------------------------------- run helpers --- */

function overlapCheck(s, ip, mask) {
  return s.dev.ifaces.find(i =>
    i !== s.ctxIface && i.ip && i.mask &&
    networkOf(i.ip, i.mask) === networkOf(ip, mask));
}

function setRoute(s, a, nextHop, exitIf) {
  const { prefix, mask } = a;
  s.dev.staticRoutes = s.dev.staticRoutes.filter(r =>
    !(r.prefix === prefix && r.mask === mask && (r.nextHop === nextHop || nextHop === null)));
  if (a.no) return [];
  s.dev.staticRoutes.push({ prefix, mask, nextHop, exitIf, ipv6: false });
  return [];
}

function addExcluded(s, start, end, no) {
  if (no) {
    s.dev.dhcpExcluded = s.dev.dhcpExcluded.filter(r => !(r.start === start && r.end === end));
    return [];
  }
  s.dev.dhcpExcluded.push({ start, end });
  return [];
}

function notifyPeer(s, iface) {
  // The device on the other end sees its own link message.
  const link = s.net.links.find(l =>
    (l.a.dev === s.dev.id && l.a.iface === iface.name) ||
    (l.b.dev === s.dev.id && l.b.iface === iface.name));
  if (!link) return;
  const other = link.a.dev === s.dev.id ? link.b : link.a;
  const dev = getDevice(s.net, other.dev);
  const pi = getIface(dev, other.iface);
  if (!dev || !pi || pi.shutdown) return;
  const state = lineStatus(s.net, dev, pi);
  emit(s, dev, `%LINK-5-CHANGED: Interface ${pi.name}, changed state to ${state}`);
  emit(s, dev, `%LINEPROTO-5-UPDOWN: Line protocol on Interface ${pi.name}, changed state to ${state}`);
}

function saveConfig(s) {
  s.dev.startupConfig = show.buildRunningConfig(s.net, s.dev);
  s.dev.startupState = captureConfigState(s.dev);
  s.dev.savedAt = s.net.tick;
  s.dev.savedSignature = configSignature(s.net, s.dev);
}

export function configSignature(net, dev) {
  return show.buildRunningConfig(net, dev).join('\n');
}

function configIsDirty(s) {
  return configSignature(s.net, s.dev) !== (s.dev.savedSignature ?? null);
}

/**
 * Reload: everything not saved is lost. This is the cheapest possible way to
 * teach `copy running-config startup-config`, so it is modelled honestly.
 */
function doReload(s) {
  const dev = s.dev;
  const saved = dev.startupState;

  // Everything volatile goes.
  dev.staticRoutes = [];
  dev.dhcpPools = [];
  dev.dhcpExcluded = [];
  dev.dhcpBindings = [];
  dev.arp = [];
  dev.macTable = [];
  dev.enableSecret = null;
  dev.enablePassword = null;
  dev.bannerMotd = null;
  dev.passwordEncryption = false;
  dev.ipv6Routing = false;
  dev.domainLookup = true;
  dev.defaultGateway = null;
  dev.lines = { console: { password: null, login: false }, vty: { password: null, login: false } };
  for (const i of dev.ifaces) {
    i.ip = null; i.mask = null; i.ipv6 = []; i.description = null;
    i.shutdown = !i.host && !i.switchport;
  }
  dev.hostname = dev.kind === 'switch' ? 'Switch' : 'Router';

  // NVRAM comes back.
  if (saved) {
    restoreConfigState(dev, saved);
    dev.savedSignature = configSignature(s.net, dev);
  }
  s.mode = 'user';
  s.ctxIface = null; s.ctxLine = null; s.ctxPool = null;
}

/** Re-apply a text configuration by running it back through the CLI.
 *  Used by the sandbox's "paste a config" affordance, not by reload. */
export
function replayConfig(s, lines) {
  const sub = { ...s, mode: 'priv', ctxIface: null, ctxLine: null, ctxPool: null, pending: null };
  sub.dev = s.dev; sub.net = s.net;
  execute(sub, 'configure terminal');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === '!' || line === 'end' || line.startsWith('Building') ||
        line.startsWith('Current configuration') || line.startsWith('version') ||
        line.startsWith('Using')) continue;
    execute(sub, line);
  }
  s.dev.savedSignature = configSignature(s.net, s.dev);
}

/* ------------------------------------------------------------- ping/tr --- */

function iosPing(s, target) {
  const knownArp = s.dev.arp.length > 0;
  const r = pingOnce(s.net, s.dev, target);
  const out = [
    'Type escape sequence to abort.',
    `Sending 5, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:`
  ];
  if (r.ok) {
    // The first packet is usually lost to ARP resolution, exactly as in PT.
    const marks = knownArp || r.phase === 'local' ? '!!!!!' : '.!!!!';
    const got = marks.split('').filter(c => c === '!').length;
    out.push(marks, '');
    out.push(`Success rate is ${got * 20} percent (${got}/5), round-trip min/avg/max = 0/1/10 ms`);
  } else if (r.failure === FAIL.NO_ROUTE && r.failedAt === s.dev.id) {
    out.push('.....', '', 'Success rate is 0 percent (0/5)');
  } else {
    out.push('.....', '', 'Success rate is 0 percent (0/5)');
  }
  out.push('');
  s.lastTrace = r;
  return out;
}

function iosTraceroute(s, target) {
  const t = traceRoute(s.net, s.dev, target);
  const out = ['Type escape sequence to abort.',
               `Tracing the route to ${target}`, ''];
  for (const hop of t.results) {
    out.push(hop.ip
      ? `  ${hop.ttl}   ${hop.ip}     ${1 + hop.ttl} msec    ${1 + hop.ttl} msec    ${1 + hop.ttl} msec`
      : `  ${hop.ttl}   *     *     *`);
  }
  out.push('');
  return out;
}

/* --------------------------------------------------------------- execute --- */

const TREE = buildTree();
export { TREE };

export function tokenize(line) {
  return line.trim().split(/\s+/).filter(Boolean);
}

/**
 * Run one line. Returns { lines, prompt?, secret? }.
 * `prompt` set means the session is waiting for more input (password,
 * confirmation, banner text).
 */
export function execute(session, rawLine) {
  const line = rawLine.replace(/\s+$/, '');

  if (session.pending) {
    const p = session.pending;
    const keepMultiline = p.multiline;
    const res = p.handle(line) || [];
    if (!p.keep && !session.pending?.keep) session.pending = keepMultiline && session.pending === p ? p : null;
    if (session.pending) session.pending.keep = false;
    if (keepMultiline && session.pending === p) return { lines: res, prompt: '', multiline: true };
    session.pending = null;
    return { lines: res };
  }

  if (!line.trim()) return { lines: [] };

  let tokens = tokenize(line);
  let no = false;
  if ((tokens[0] === 'no' || (CONFIG_MODES.includes(session.mode) && 'no'.startsWith(tokens[0].toLowerCase()) && tokens[0].length >= 2))
      && CONFIG_MODES.includes(session.mode) && tokens.length > 1) {
    no = true;
    tokens = tokens.slice(1);
  }

  let result = parse(TREE, tokens, session);

  // IOS accepts a global-configuration command typed from a sub-mode: it drops
  // you back to (config) and runs it. Students do this constantly.
  if (result.status !== PARSE.OK && session.mode !== 'config' && CONFIG_MODES.includes(session.mode)) {
    const probe = { ...session, mode: 'config' };
    const retry = parse(TREE, tokens, probe);
    if (retry.status === PARSE.OK) {
      session.mode = 'config';
      session.ctxIface = null; session.ctxLine = null; session.ctxPool = null;
      result = retry;
    }
  }

  if (result.status === PARSE.AMBIGUOUS) {
    return { lines: [`% Ambiguous command:  "${line.trim()}"`, ''] };
  }
  if (result.status === PARSE.INVALID) {
    return { lines: caretError(line, tokens, result.index, no) };
  }
  if (result.status === PARSE.INCOMPLETE) {
    return { lines: ['% Incomplete command.', ''] };
  }

  const out = result.node.run(session, { ...result.args, no }) || [];
  session.onChange(session);
  if (session.pending) {
    return { lines: out, prompt: session.pending.prompt, secret: !!session.pending.secret,
             multiline: !!session.pending.multiline };
  }
  return { lines: out };
}

/** IOS points at the first word it could not parse. Getting this right matters. */
function caretError(line, tokens, index, hadNo) {
  const trimmed = line.trim();
  const offset = tokenOffset(trimmed, tokens, index) + (hadNo ? trimmed.indexOf(tokens[0]) === 0 ? 0 : 0 : 0);
  const prefixLen = hadNo ? (trimmed.match(/^\s*\S+\s+/)?.[0].length || 0) : 0;
  return [
    ' '.repeat(prefixLen + offset) + '^',
    '% Invalid input detected at \'^\' marker.',
    ''
  ];
}

function tokenOffset(line, tokens, index) {
  let pos = 0;
  for (let k = 0; k < index; k++) {
    pos = line.indexOf(tokens[k], pos) + tokens[k].length;
  }
  const at = line.indexOf(tokens[index], pos);
  return at < 0 ? pos : at;
}

/* ------------------------------------------------------------------ help --- */

/** `line` is what the user typed before the `?`. */
export function contextHelp(session, line) {
  const endsWithSpace = /\s$/.test(line) || line.trim() === '';
  let tokens = tokenize(line);
  if (tokens[0] === 'no' && CONFIG_MODES.includes(session.mode)) tokens = tokens.slice(1);
  const partial = endsWithSpace ? '' : (tokens.pop() || '');

  if (!tokens.length) return helpList(TREE, session, partial);

  const res = parse(TREE, tokens, session);
  if (res.status === PARSE.INVALID) {
    return ['% Unrecognized command', ''];
  }
  if (res.status === PARSE.AMBIGUOUS) {
    return [`% Ambiguous command:  "${line.trim()}"`, ''];
  }
  return helpList(res.node, session, partial);
}

/** Tab completion. Returns the completed line, or the original. */
export function complete(session, line) {
  if (/\s$/.test(line)) return { line };
  let tokens = tokenize(line);
  if (!tokens.length) return { line };
  const partial = tokens.pop();
  let head = tokens;
  let stripped = null;
  if (head[0] === 'no' && CONFIG_MODES.includes(session.mode)) { stripped = 'no'; head = head.slice(1); }

  let node = TREE;
  if (head.length) {
    const res = parse(TREE, head, session);
    if (res.status === PARSE.INVALID || res.status === PARSE.AMBIGUOUS) return { line };
    node = res.node;
  }
  const kids = childrenFor(node, session).filter(c => c.kw &&
    c.kw.toLowerCase().startsWith(partial.toLowerCase()));
  if (kids.length === 1) {
    const parts = [...(stripped ? [stripped] : []), ...head, kids[0].kw];
    return { line: parts.join(' ') + ' ' };
  }
  if (kids.length > 1) {
    return { line, lines: kids.map(k => '  ' + k.kw) };
  }
  return { line };
}

export { MODES };
