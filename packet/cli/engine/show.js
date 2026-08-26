// show.js — output renderers.
//
// These are deliberately fussy about spacing. Students are asked to read
// `show ip route` under time pressure, and column positions are part of what
// they learn to read. Formats follow Packet Tracer's IOS 15.x output.

import {
  maskToCidr, cidrToMask, networkOf, formatMac, intToIp, ipToInt
} from './addr.js';
import {
  routingTable, lineStatus, adminStatus, ifaceUp, getIface, peerOf, MODELS
} from './net.js';

const pad = (s, n) => String(s ?? '').padEnd(n);
const rpad = (s, n) => String(s ?? '').padStart(n);

/** GigabitEthernet0/1 -> Gig0/1, FastEthernet0/3 -> Fa0/3 */
export function shortIf(name) {
  return name
    .replace(/^GigabitEthernet/, 'Gig')
    .replace(/^FastEthernet/, 'Fa')
    .replace(/^Serial/, 'Se')
    .replace(/^Vlan/, 'Vlan');
}

/* --------------------------------------------------- show ip int brief --- */

export function showIpInterfaceBrief(net, dev) {
  const out = ['Interface              IP-Address      OK? Method Status                Protocol'];
  for (const i of dev.ifaces) {
    const ip = i.ip || 'unassigned';
    const method = i.ip ? (i.configuredBy === 'dhcp' ? 'DHCP' : 'manual') : 'unset';
    const status = adminStatus(i) === 'up' ? (lineStatus(net, dev, i) === 'up' ? 'up' : 'down')
                                           : 'administratively down';
    const proto = lineStatus(net, dev, i) === 'up' ? 'up' : 'down';
    out.push(pad(i.name, 23) + pad(ip, 16) + pad('YES', 4) + pad(method, 7) + pad(status, 22) + proto);
  }
  return out;
}

export function showIpv6InterfaceBrief(net, dev) {
  const out = [];
  for (const i of dev.ifaces) {
    const status = adminStatus(i) === 'up' ? (lineStatus(net, dev, i) === 'up' ? 'up' : 'down')
                                           : 'administratively down';
    const proto = lineStatus(net, dev, i) === 'up' ? 'up' : 'down';
    out.push(`${pad(i.name, 22)} [${status}/${proto}]`);
    if (!i.ipv6.length) { out.push('    unassigned'); continue; }
    const ll = i.ipv6.filter(a => a.linkLocal);
    const gl = i.ipv6.filter(a => !a.linkLocal);
    for (const a of ll) out.push(`    ${a.addr.toUpperCase()}`);
    for (const a of gl) out.push(`    ${a.addr.toUpperCase()}`);
  }
  return out;
}

/* ---------------------------------------------------------- show ip route --- */

const ROUTE_CODES = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2, E - EGP',
  '       i - IS-IS, L1 - IS-IS level-1, L2 - IS-IS level-2, ia - IS-IS inter area',
  '       * - candidate default, U - per-user static route, o - ODR',
  '       P - periodic downloaded static route',
  ''
];

/** The classful major network a prefix belongs to — IOS still groups by it. */
function majorNet(prefix) {
  const first = +prefix.split('.')[0];
  const bits = first < 128 ? 8 : first < 192 ? 16 : 24;
  return { net: networkOf(prefix, cidrToMask(bits)), bits };
}

export function showIpRoute(net, dev, filter = null) {
  const rows = routingTable(net, dev).filter(r => {
    if (!filter) return true;
    if (filter === 'static') return r.code === 'S' || r.code === 'S*';
    if (filter === 'connected') return r.code === 'C';
    return true;
  });

  const out = [...ROUTE_CODES];
  const def = rows.find(r => r.code === 'S*');
  out.push(def ? `Gateway of last resort is ${def.nextHop} to network 0.0.0.0`
               : 'Gateway of last resort is not set');
  out.push('');

  if (!rows.length) return out;

  // Group by classful major network, the way IOS lays it out.
  const groups = new Map();
  for (const r of rows) {
    if (r.code === 'S*') continue;
    const m = majorNet(r.prefix);
    const key = `${m.net}/${m.bits}`;
    if (!groups.has(key)) groups.set(key, { ...m, rows: [] });
    groups.get(key).rows.push(r);
  }

  const sortedKeys = [...groups.keys()].sort((a, b) => ipToInt(a.split('/')[0]) - ipToInt(b.split('/')[0]));

  for (const key of sortedKeys) {
    const g = groups.get(key);
    const masks = new Set(g.rows.map(r => r.cidr));
    const subnetted = g.rows.length > 1 || g.rows[0].cidr !== g.bits;
    if (subnetted) {
      out.push(`     ${g.net}/${g.bits} is variably subnetted, ${g.rows.length} subnets, ${masks.size} masks`);
    }
    for (const r of g.rows.sort((a, b) => ipToInt(a.prefix) - ipToInt(b.prefix) || a.cidr - b.cidr)) {
      const label = `${r.prefix}/${r.cidr}`;
      const indent = subnetted ? '       ' : '    ';
      if (r.code === 'C' || r.code === 'L') {
        out.push(`${r.code}${indent}${label} is directly connected, ${r.exitIf}`);
      } else {
        const via = r.nextHop ? `via ${r.nextHop}` : `directly connected, ${r.exitIf}`;
        out.push(`${r.code}${indent}${label} [${r.ad}/${r.metric}] ${via}`);
      }
    }
  }

  if (def) {
    out.push(`S*   0.0.0.0/0 [1/0] via ${def.nextHop}`);
  }
  return out;
}

/* --------------------------------------------------- show mac address-table --- */

export function showMacAddressTable(net, dev) {
  const out = [
    '          Mac Address Table',
    '-------------------------------------------',
    '',
    'Vlan    Mac Address       Type        Ports',
    '----    -----------       --------    -----'
  ];
  const rows = [...dev.macTable].sort((a, b) => a.port.localeCompare(b.port));
  for (const e of rows) {
    out.push(rpad(e.vlan, 4) + '    ' + pad(formatMac(e.mac).toLowerCase(), 18) +
             pad(e.type, 12) + shortIf(e.port));
  }
  if (!rows.length) out.push('');
  return out;
}

/* ------------------------------------------------------------- show arp --- */

export function showArp(net, dev) {
  const out = ['Protocol  Address          Age (min)  Hardware Addr   Type   Interface'];
  // A device always knows its own interfaces; IOS shows them with age "-".
  for (const i of dev.ifaces) {
    if (!i.ip || !ifaceUp(net, dev, i)) continue;
    out.push('Internet  ' + pad(i.ip, 17) + rpad('-', 9) + '   ' +
             pad(formatMac(i.mac).toLowerCase(), 16) + 'ARPA   ' + i.name);
  }
  for (const a of dev.arp) {
    const age = Math.max(0, Math.floor((net.tick - a.age) / 4));
    out.push('Internet  ' + pad(a.ip, 17) + rpad(age, 9) + '   ' +
             pad(formatMac(a.mac).toLowerCase(), 16) + 'ARPA   ' + a.iface);
  }
  return out;
}

/* -------------------------------------------------- show interfaces status --- */

export function showInterfacesStatus(net, dev) {
  const out = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const i of dev.ifaces) {
    if (i.svi) continue;
    const status = i.shutdown ? 'disabled' : (lineStatus(net, dev, i) === 'up' ? 'connected' : 'notconnect');
    const type = i.speed >= 1000 ? '10/100/1000BaseTX' : '10/100BaseTX';
    out.push(pad(shortIf(i.name), 10) + pad(i.description || '', 19) + pad(status, 13) +
             pad(i.vlan ?? '', 11) + pad('auto', 8) + pad('auto', 6) + type);
  }
  return out;
}

export function showInterface(net, dev, iface) {
  const admin = adminStatus(iface);
  const proto = lineStatus(net, dev, iface);
  const out = [
    `${iface.name} is ${admin === 'up' ? (proto === 'up' ? 'up' : 'down') : 'administratively down'}, ` +
    `line protocol is ${proto}`,
    `  Hardware is ${iface.speed >= 1000 ? 'CN Gigabit Ethernet' : 'Lance'}, address is ${formatMac(iface.mac).toLowerCase()} ` +
    `(bia ${formatMac(iface.mac).toLowerCase()})`
  ];
  if (iface.description) out.push(`  Description: ${iface.description}`);
  out.push(iface.ip
    ? `  Internet address is ${iface.ip}/${maskToCidr(iface.mask)}`
    : '  Internet protocol processing disabled');
  out.push(`  MTU 1500 bytes, BW ${iface.speed * 1000} Kbit/sec, DLY 100 usec,`);
  out.push('     reliability 255/255, txload 1/255, rxload 1/255');
  out.push('  Encapsulation ARPA, loopback not set');
  out.push('  Full-duplex, ' + (iface.speed >= 1000 ? '1000Mb/s' : '100Mb/s') + ', media type is RJ45');
  return out;
}

/* ------------------------------------------------------------ show dhcp --- */

export function showDhcpBinding(net, dev) {
  const out = [
    'IP address       Client-ID/              Lease expiration        Type',
    '                 Hardware address'
  ];
  for (const b of dev.dhcpBindings) {
    out.push(pad(b.ip, 17) + pad(formatMac(b.mac).toLowerCase(), 24) + pad('--', 24) + 'Automatic');
  }
  return out;
}

export function showDhcpPool(net, dev) {
  const out = [];
  for (const p of dev.dhcpPools) {
    const leased = dev.dhcpBindings.filter(b => b.pool === p.name).length;
    out.push(`Pool ${p.name} :`);
    out.push(` Utilization mark (high/low)    : 100 / 0`);
    out.push(` Subnet size (first/next)       : 0 / 0`);
    out.push(` Total addresses                : ${p.mask ? (~ipToInt(p.mask) >>> 0) - 1 : 0}`);
    out.push(` Leased addresses               : ${leased}`);
    out.push(` Excluded addresses             : ${dev.dhcpExcluded.length}`);
    out.push(` Pending event                  : none`);
    out.push('');
  }
  if (!out.length) out.push('');
  return out;
}

/* ------------------------------------------------------- running-config --- */

export function buildRunningConfig(net, dev) {
  const L = [];
  L.push('Building configuration...', '');
  L.push('Current configuration : ' + '1024' + ' bytes', '!');
  L.push('version 15.1');
  if (dev.passwordEncryption) L.push('service password-encryption');
  else L.push('no service password-encryption');
  L.push('!');
  L.push(`hostname ${dev.hostname}`);
  L.push('!');
  if (dev.enableSecret) {
    L.push(`enable secret 5 $1$mERr$${hash(dev.enableSecret)}`);
    L.push('!');
  } else if (dev.enablePassword) {
    L.push(`enable password ${dev.passwordEncryption ? '7 ' + weakEncrypt(dev.enablePassword) : dev.enablePassword}`);
    L.push('!');
  }
  if (dev.ipv6Routing) { L.push('ipv6 unicast-routing'); L.push('!'); }
  if (!dev.domainLookup) { L.push('no ip domain-lookup'); L.push('!'); }

  for (const ex of dev.dhcpExcluded) L.push(`ip dhcp excluded-address ${ex.start} ${ex.end}`);
  if (dev.dhcpExcluded.length) L.push('!');
  for (const p of dev.dhcpPools) {
    L.push(`ip dhcp pool ${p.name}`);
    if (p.network) L.push(` network ${p.network} ${p.mask}`);
    if (p.defaultRouter) L.push(` default-router ${p.defaultRouter}`);
    if (p.dnsServer) L.push(` dns-server ${p.dnsServer}`);
    if (p.domain) L.push(` domain-name ${p.domain}`);
    L.push('!');
  }

  for (const i of dev.ifaces) {
    L.push(`interface ${i.name}`);
    if (i.description) L.push(` description ${i.description}`);
    if (i.ip) L.push(` ip address ${i.ip} ${i.mask}`);
    else if (!i.switchport && !i.svi) L.push(' no ip address');
    for (const a of i.ipv6) {
      L.push(a.linkLocal ? ` ipv6 address ${a.addr.toUpperCase()} link-local`
                         : ` ipv6 address ${a.addr.toUpperCase()}/${a.prefixLen}`);
    }
    if (i.shutdown) L.push(' shutdown');
    if (i.serial && i.ip) L.push(' clock rate 2000000');
    L.push('!');
  }

  for (const r of dev.staticRoutes) {
    if (r.ipv6) L.push(`ipv6 route ${r.prefix}/${r.prefixLen} ${r.nextHop}`);
    else L.push(`ip route ${r.prefix} ${r.mask} ${r.nextHop || r.exitIf}`);
  }
  if (dev.staticRoutes.length) L.push('!');

  if (dev.defaultGateway) { L.push(`ip default-gateway ${dev.defaultGateway}`); L.push('!'); }

  if (dev.bannerMotd) { L.push(`banner motd ^C${dev.bannerMotd}^C`); L.push('!'); }

  L.push('line con 0');
  if (dev.lines.console.password)
    L.push(` password ${dev.passwordEncryption ? '7 ' + weakEncrypt(dev.lines.console.password) : dev.lines.console.password}`);
  if (dev.lines.console.login) L.push(' login');
  L.push('!');
  L.push('line vty 0 4');
  if (dev.lines.vty.password)
    L.push(` password ${dev.passwordEncryption ? '7 ' + weakEncrypt(dev.lines.vty.password) : dev.lines.vty.password}`);
  L.push(dev.lines.vty.login ? ' login' : ' login');
  L.push('!');
  L.push('!');
  L.push('end');
  L.push('');
  return L;
}

function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h.toString(36).padEnd(12, 'x').slice(0, 12);
}
function weakEncrypt(s) {
  return '08' + [...s].map(c => (c.charCodeAt(0) ^ 0x4a).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/* -------------------------------------------------------- show version --- */

export function showVersion(net, dev) {
  const model = MODELS[dev.model];
  return [
    'Cisco IOS Software, C' + (dev.kind === 'switch' ? '2960' : '1900') +
      ' Software (C' + (dev.kind === 'switch' ? '2960' : '1900') + '-UNIVERSALK9-M), Version 15.1(4)M4, RELEASE SOFTWARE (fc2)',
    'Technical Support: http://www.cisco.com/techsupport',
    'Copyright (c) 1986-2012 by Cisco Systems, Inc.',
    '',
    `${dev.hostname} uptime is 1 hour, 12 minutes`,
    'System returned to ROM by power-on',
    `System image file is "flash:c${dev.kind === 'switch' ? '2960' : '1900'}-universalk9-mz.SPA.151-4.M4.bin"`,
    '',
    `${model.label} with 491520K/32768K bytes of memory.`,
    `Processor board ID FTX1524${String(dev.hostname).length}HHR`,
    `${dev.ifaces.filter(i => !i.svi).length} interfaces`,
    '',
    'Configuration register is 0x2102',
    ''
  ];
}
