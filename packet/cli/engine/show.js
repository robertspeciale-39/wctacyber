// show.js — output renderers.
//
// These are deliberately fussy about spacing. Students are asked to read
// `show ip route` under time pressure, and column positions are part of what
// they learn to read. Formats follow Packet Tracer's IOS 15.x output.

import {
  maskToCidr, cidrToMask, networkOf, formatMac, intToIp, ipToInt
} from './addr.js';
import {
  routingTable, lineStatus, adminStatus, ifaceUp, getIface, peerOf, MODELS,
  portIsTrunk, vlansOnPort, subInterfaces
} from './net.js';
import { stpState, rootBridge, bridgePriority, bridgeMac, stpVlans, portState, pathCost } from './stp.js';
import { ospfInterfaces, ospfNeighbors, routerId } from './ospf.js';

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
    if (filter === 'ospf') return r.code.startsWith('O');
    return true;
  });

  const out = [...ROUTE_CODES];
  const def = rows.find(r => r.code === 'S*' || r.code === 'O*E2');
  out.push(def ? `Gateway of last resort is ${def.nextHop} to network 0.0.0.0`
               : 'Gateway of last resort is not set');
  out.push('');

  if (!rows.length) return out;

  // Group by classful major network, the way IOS lays it out.
  const groups = new Map();
  for (const r of rows) {
    if (r.code === 'S*' || r.code === 'O*E2') continue;
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
      } else if (r.code.startsWith('O')) {
        out.push(`${r.code}${indent}${label} [${r.ad}/${r.metric}] via ${r.nextHop}, 00:04:11, ${shortIf(r.exitIf)}`);
      } else {
        const via = r.nextHop ? `via ${r.nextHop}` : `directly connected, ${r.exitIf}`;
        out.push(`${r.code}${indent}${label} [${r.ad}/${r.metric}] ${via}`);
      }
    }
  }

  if (def) {
    out.push(def.code === 'S*'
      ? `S*   0.0.0.0/0 [1/0] via ${def.nextHop}`
      : `O*E2 0.0.0.0/0 [110/${def.metric}] via ${def.nextHop}, 00:04:11, ${shortIf(def.exitIf)}`);
  }
  return out;
}

/* ------------------------------------------------------------ show vlan --- */

export function showVlan(net, dev, brief = true) {
  if (dev.kind !== 'switch') return ['% Invalid input detected', ''];
  const out = ['VLAN Name                             Status    Ports',
               '---- -------------------------------- --------- -------------------------------'];
  const vlans = dev.vlans.length ? dev.vlans : [{ id: 1, name: 'default' }];
  for (const v of vlans) {
    // A trunk belongs to no single VLAN, so IOS lists only access ports here.
    const ports = dev.ifaces
      .filter(i => !i.svi && !i.parent && i.switchport && !portIsTrunk(net, dev, i) && i.vlan === v.id)
      .map(i => shortIf(i.name));
    out.push(pad(v.id, 5) + pad(v.name, 33) + pad('active', 10) + ports.slice(0, 6).join(', '));
    for (let k = 6; k < ports.length; k += 6) out.push(' '.repeat(48) + ports.slice(k, k + 6).join(', '));
  }
  // The reserved VLANs are always in the list, and students are asked why.
  for (const [id, name] of [[1002, 'fddi-default'], [1003, 'token-ring-default'],
                            [1004, 'fddinet-default'], [1005, 'trnet-default']]) {
    out.push(pad(id, 5) + pad(name, 33) + 'active');
  }
  if (!brief) {
    out.push('', 'VLAN Type  SAID       MTU   Parent RingNo BridgeNo Stp  BrdgMode Trans1 Trans2',
             '---- ----- ---------- ----- ------ ------ -------- ---- -------- ------ ------');
    for (const v of vlans) {
      out.push(pad(v.id, 5) + pad('enet', 6) + pad(100000 + v.id, 11) + pad(1500, 6) +
               pad('-', 7) + pad('-', 7) + pad('-', 9) + pad('-', 5) + pad('-', 9) + pad(0, 7) + '0');
    }
  }
  out.push('');
  return out;
}

/* ------------------------------------------------- show interfaces trunk --- */

export function showInterfacesTrunk(net, dev) {
  const trunks = dev.ifaces.filter(i =>
    !i.svi && !i.parent && i.switchport && portIsTrunk(net, dev, i) && lineStatus(net, dev, i) === 'up');
  if (!trunks.length) return [''];

  const out = ['Port        Mode         Encapsulation  Status        Native vlan'];
  for (const i of trunks) {
    const mode = i.swMode === 'trunk' ? 'on' : (i.swMode === 'dynamic-desirable' ? 'desirable' : 'auto');
    out.push(pad(shortIf(i.name), 12) + pad(mode, 13) + pad('802.1q', 15) + pad('trunking', 14) + i.trunkNative);
  }
  out.push('', 'Port        Vlans allowed on trunk');
  for (const i of trunks) {
    out.push(pad(shortIf(i.name), 12) + (i.trunkAllowed == null ? '1-1005' : compressList(i.trunkAllowed)));
  }
  out.push('', 'Port        Vlans allowed and active in management domain');
  for (const i of trunks) {
    out.push(pad(shortIf(i.name), 12) + compressList(vlansOnPort(net, dev, i)));
  }
  out.push('', 'Port        Vlans in spanning tree forwarding state and not pruned');
  for (const i of trunks) {
    const fwd = vlansOnPort(net, dev, i).filter(v => portState(net, dev, i, v).state === 'forwarding');
    out.push(pad(shortIf(i.name), 12) + (fwd.length ? compressList(fwd) : 'none'));
  }
  out.push('');
  return out;
}

/** [1,2,3,7] -> "1-3,7", the way IOS prints a VLAN list. */
function compressList(ids) {
  const s = [...ids].sort((a, b) => a - b);
  const parts = [];
  let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

export function showInterfacesSwitchport(net, dev) {
  const out = [];
  for (const i of dev.ifaces) {
    if (i.svi || i.parent) continue;
    out.push(`Name: ${shortIf(i.name)}`);
    if (!i.switchport) {
      out.push('Switchport: Disabled', '');
      continue;
    }
    const trunk = portIsTrunk(net, dev, i);
    const admin = i.swMode === 'access' ? 'static access'
      : i.swMode === 'trunk' ? 'trunk'
      : i.swMode === 'dynamic-desirable' ? 'dynamic desirable' : 'dynamic auto';
    out.push('Switchport: Enabled');
    out.push(`Administrative Mode: ${admin}`);
    out.push(`Operational Mode: ${trunk ? 'trunk' : 'static access'}`);
    out.push('Administrative Trunking Encapsulation: dot1q');
    out.push('Operational Trunking Encapsulation: ' + (trunk ? 'dot1q' : 'native'));
    out.push('Negotiation of Trunking: ' + (i.swMode === 'access' || i.swMode === 'trunk' ? 'Off' : 'On'));
    out.push(`Access Mode VLAN: ${i.vlan} (${vlanName(dev, i.vlan)})`);
    out.push(`Trunking Native Mode VLAN: ${i.trunkNative} (${vlanName(dev, i.trunkNative)})`);
    out.push('Trunking VLANs Enabled: ' + (i.trunkAllowed == null ? 'ALL' : compressList(i.trunkAllowed)));
    out.push('');
  }
  return out;
}

function vlanName(dev, id) {
  const v = dev.vlans.find(x => x.id === id);
  return v ? v.name : (id === 1 ? 'default' : 'inactive');
}

/* -------------------------------------------------- show spanning-tree --- */

export function showSpanningTree(net, dev, onlyVlan = null) {
  if (dev.kind !== 'switch') return ['% Invalid input detected', ''];
  const vlans = onlyVlan != null ? [onlyVlan] : stpVlans(net, dev);
  const out = [];
  for (const vlan of vlans) {
    const states = stpState(net, vlan);
    const root = rootBridge(net, vlan) || dev;
    const isRoot = root.id === dev.id;
    const rootCost = states.rootCostOf ? states.rootCostOf(dev.id) : 0;

    out.push(`VLAN${String(vlan).padStart(4, '0')}`);
    out.push(`  Spanning tree enabled protocol ${dev.stp.mode === 'rapid-pvst' ? 'rstp' : 'ieee'}`);
    out.push(`  Root ID    Priority    ${bridgePriority(root, vlan) + vlan}`);
    out.push(`             Address     ${formatMac(bridgeMac(root)).toLowerCase()}`);
    if (isRoot) {
      out.push('             This bridge is the root');
    } else {
      const rp = [...states.entries()].find(([k, v]) => k.startsWith(dev.id + ':') && v.role === 'root');
      out.push(`             Cost        ${rootCost}`);
      if (rp) out.push(`             Port        ${shortIf(rp[0].split(':')[1])}`);
    }
    out.push('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec');
    out.push('');
    out.push(`  Bridge ID  Priority    ${bridgePriority(dev, vlan) + vlan}  (priority ${bridgePriority(dev, vlan)} sys-id-ext ${vlan})`);
    out.push(`             Address     ${formatMac(bridgeMac(dev)).toLowerCase()}`);
    out.push('             Hello Time  2 sec  Max Age 20 sec  Forward Delay 15 sec');
    out.push('             Aging Time  20');
    out.push('');
    out.push('Interface        Role Sts Cost      Prio.Nbr Type');
    out.push('---------------- ---- --- --------- -------- --------------------------------');
    for (const port of dev.ifaces) {
      if (port.svi || port.parent || port.shutdown) continue;
      if (!vlansOnPort(net, dev, port).includes(vlan)) continue;
      const p = peerOf(net, dev.id, port.name);
      if (!p || !p.link.ok || p.iface.shutdown) continue;
      const st = portState(net, dev, port, vlan);
      const role = st.role === 'root' ? 'Root' : st.role === 'designated' ? 'Desg' : 'Altn';
      const sts = st.state === 'forwarding' ? 'FWD' : 'BLK';
      const type = port.portfast ? 'P2p Edge' : 'P2p';
      out.push(pad(shortIf(port.name), 17) + pad(role, 5) + pad(sts, 4) +
               pad(st.cost, 10) + pad(`${port.stpPortPriority}.${portNumber(port)}`, 9) + type);
    }
    out.push('');
  }
  return out;
}

export function showSpanningTreeSummary(net, dev) {
  const out = [`Switch is in ${dev.stp.mode === 'rapid-pvst' ? 'rapid-pvst' : 'pvst'} mode`,
               'Name                   Blocking Listening Learning Forwarding STP Active',
               '---------------------- -------- --------- -------- ---------- ----------'];
  let blkAll = 0, fwdAll = 0;
  for (const vlan of stpVlans(net, dev)) {
    let blk = 0, fwd = 0;
    for (const port of dev.ifaces) {
      if (port.svi || port.parent || port.shutdown) continue;
      if (!vlansOnPort(net, dev, port).includes(vlan)) continue;
      const p = peerOf(net, dev.id, port.name);
      if (!p || !p.link.ok || p.iface.shutdown) continue;
      portState(net, dev, port, vlan).state === 'blocking' ? blk++ : fwd++;
    }
    blkAll += blk; fwdAll += fwd;
    out.push(pad(`VLAN${String(vlan).padStart(4, '0')}`, 23) + rpad(blk, 8) + rpad(0, 10) +
             rpad(0, 9) + rpad(fwd, 11) + rpad(blk + fwd, 11));
  }
  out.push('---------------------- -------- --------- -------- ---------- ----------');
  out.push(pad(`${stpVlans(net, dev).length} vlans`, 23) + rpad(blkAll, 8) + rpad(0, 10) +
           rpad(0, 9) + rpad(fwdAll, 11) + rpad(blkAll + fwdAll, 11));
  out.push('');
  return out;
}

function portNumber(iface) {
  const nums = iface.name.match(/\d+/g) || ['0'];
  return +nums[nums.length - 1];
}

/* -------------------------------------------------------------- OSPF --- */

export function showIpOspfNeighbor(net, dev) {
  if (!dev.ospf) return [''];
  const out = ['Neighbor ID     Pri   State           Dead Time   Address         Interface'];
  for (const nb of ospfNeighbors(net, dev)) {
    out.push(pad(nb.routerId, 16) + pad(1, 6) + pad('FULL/DR', 16) +
             pad('00:00:36', 12) + pad(nb.ip, 16) + shortIf(nb.localIf));
  }
  out.push('');
  return out;
}

export function showIpOspf(net, dev) {
  if (!dev.ospf) return [''];
  const areas = [...new Set(ospfInterfaces(net, dev).map(i => i.area))];
  const out = [
    ` Routing Process "ospf ${dev.ospf.pid}" with ID ${routerId(net, dev)}`,
    ' Supports only single TOS(TOS0) routes',
    ' Supports opaque LSA',
    ` Number of areas in this router is ${areas.length}. ${areas.length} normal 0 stub 0 nssa`
  ];
  for (const area of areas) {
    const ifs = ospfInterfaces(net, dev).filter(i => i.area === area);
    out.push(`    Area ${area === 0 ? 'BACKBONE(0)' : area}`,
             `        Number of interfaces in this area is ${ifs.length}`);
  }
  out.push('');
  return out;
}

export function showIpOspfInterfaceBrief(net, dev) {
  if (!dev.ospf) return [''];
  const out = ['Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C'];
  const nbrs = ospfNeighbors(net, dev);
  for (const entry of ospfInterfaces(net, dev)) {
    const count = nbrs.filter(n => n.localIf === entry.iface.name).length;
    out.push(pad(shortIf(entry.iface.name), 13) + pad(dev.ospf.pid, 6) +
             pad(entry.area, 16) + pad(`${entry.iface.ip}/${maskToCidr(entry.iface.mask)}`, 19) +
             pad(entry.cost, 6) + pad(entry.passive ? 'DR' : (entry.up ? 'BDR' : 'DOWN'), 6) +
             `${count}/${count}`);
  }
  out.push('');
  return out;
}

export function showIpProtocols(net, dev) {
  if (!dev.ospf) return ['', ''];
  const out = [
    `Routing Protocol is "ospf ${dev.ospf.pid}"`,
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    `  Router ID ${routerId(net, dev)}`,
    '  Number of areas in this router is ' + new Set(ospfInterfaces(net, dev).map(i => i.area)).size +
      '. 0 normal 0 stub 0 nssa',
    '  Maximum path: 4',
    '  Routing for Networks:'
  ];
  for (const nw of dev.ospf.networks) out.push(`    ${nw.network} ${nw.wildcard} area ${nw.area}`);
  const passive = ospfInterfaces(net, dev).filter(i => i.passive);
  if (passive.length) {
    out.push('  Passive Interface(s):');
    for (const p of passive) out.push(`    ${p.iface.name}`);
  }
  out.push('  Routing Information Sources:');
  out.push('    Gateway         Distance      Last Update');
  for (const nb of ospfNeighbors(net, dev)) {
    out.push(`    ${pad(nb.routerId, 16)}${pad(110, 14)}00:00:12`);
  }
  out.push('  Distance: (default is 110)', '');
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
    const vlanCol = !i.switchport ? 'routed' : (portIsTrunk(net, dev, i) ? 'trunk' : (i.vlan ?? ''));
    out.push(pad(shortIf(i.name), 10) + pad(i.description || '', 19) + pad(status, 13) +
             pad(vlanCol, 11) + pad('auto', 8) + pad('auto', 6) + type);
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

  for (const st of Object.entries(dev.stp?.priority || {})) {
    L.push(`spanning-tree vlan ${st[0]} priority ${st[1]}`);
  }
  if (Object.keys(dev.stp?.priority || {}).length) L.push('!');
  if (dev.stp?.mode === 'rapid-pvst') { L.push('spanning-tree mode rapid-pvst'); L.push('!'); }

  for (const i of dev.ifaces) {
    L.push(`interface ${i.name}`);
    if (i.description) L.push(` description ${i.description}`);
    if (i.parent && i.encapVlan != null) {
      L.push(` encapsulation dot1Q ${i.encapVlan}${i.encapNative ? ' native' : ''}`);
    }
    // A layer 3 switch port that has been routed says so, and an access or
    // trunk port shows the switching lines a competition check looks for.
    if (dev.layer3Capable && !i.switchport && !i.svi && !i.parent) L.push(' no switchport');
    if (i.switchport) {
      if (i.swMode === 'access') L.push(' switchport mode access');
      if (i.swMode === 'trunk') L.push(' switchport mode trunk');
      if (i.swMode === 'dynamic-desirable') L.push(' switchport mode dynamic desirable');
      if (i.vlan && i.vlan !== 1) L.push(` switchport access vlan ${i.vlan}`);
      if (i.trunkNative && i.trunkNative !== 1) L.push(` switchport trunk native vlan ${i.trunkNative}`);
      if (i.trunkAllowed) L.push(` switchport trunk allowed vlan ${i.trunkAllowed.join(',')}`);
    }
    if (i.ip) L.push(` ip address ${i.ip} ${i.mask}`);
    else if (!i.switchport && !i.svi) L.push(' no ip address');
    for (const a of i.ipv6) {
      L.push(a.linkLocal ? ` ipv6 address ${a.addr.toUpperCase()} link-local`
                         : ` ipv6 address ${a.addr.toUpperCase()}/${a.prefixLen}`);
    }
    if (i.portfast) L.push(' spanning-tree portfast');
    if (i.bpduguard) L.push(' spanning-tree bpduguard enable');
    if (i.stpCost != null) L.push(` spanning-tree cost ${i.stpCost}`);
    if (i.stpPortPriority !== 128) L.push(` spanning-tree port-priority ${i.stpPortPriority}`);
    if (i.shutdown) L.push(' shutdown');
    if (i.serial && i.ip) L.push(' clock rate 2000000');
    L.push('!');
  }

  if (dev.kind === 'switch' && dev.ipRouting) { L.push('ip routing'); L.push('!'); }

  if (dev.ospf) {
    L.push(`router ospf ${dev.ospf.pid}`);
    if (dev.ospf.routerId) L.push(` router-id ${dev.ospf.routerId}`);
    if (dev.ospf.refBw !== 100) L.push(` auto-cost reference-bandwidth ${dev.ospf.refBw}`);
    if (dev.ospf.passiveDefault) L.push(' passive-interface default');
    for (const p of dev.ospf.passive) L.push(`${dev.ospf.passiveDefault ? ' no' : ''} passive-interface ${p}`);
    for (const nw of dev.ospf.networks) L.push(` network ${nw.network} ${nw.wildcard} area ${nw.area}`);
    if (dev.ospf.defaultOriginate) L.push(` default-information originate${dev.ospf.defaultAlways ? ' always' : ''}`);
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
