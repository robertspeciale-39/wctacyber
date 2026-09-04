// switching.test.js — VLANs, trunking, spanning tree, layer 3 switching and
// OSPF, driven through the real CLI rather than by poking at state.
//
//   node cli/tests/switching.test.js
//
// The point of every check here is the same: a student's command has to
// change what the network actually does. A VLAN really isolates, a trunk
// really carries tags, spanning tree really blocks a port, and OSPF really
// installs a route somebody could have typed by hand instead.

import { createHarness } from './assert.js';
import { buildTopology } from '../engine/topology.js';
import { createSession, execute } from '../engine/ios.js';
import { getDevice, getIface, pingOnce, segmentEndpoints, portIsTrunk } from '../engine/net.js';
import { rootBridge, portState, stpState } from '../engine/stp.js';
import { ospfNeighbors, ospfRoutes, wildcardMatches } from '../engine/ospf.js';

const t = createHarness('switching');
const { ok, eq, match, section } = t;

/** Type a list of commands at a device, as a student would. */
function type(net, devId, lines) {
  const s = createSession(net, devId, { mode: 'priv' });
  const out = [];
  for (const line of lines) out.push(...(execute(s, line).lines || []));
  return { session: s, out };
}

/** Every command must be accepted — a rejected one is a bug in the tree. */
function typeStrict(net, devId, lines, label) {
  const s = createSession(net, devId, { mode: 'priv' });
  for (const line of lines) {
    const res = execute(s, line);
    const bad = (res.lines || []).some(l => /Invalid input|Incomplete|Ambiguous|Unrecognized/.test(l));
    ok(`${label}: "${line}" is accepted`, !bad, (res.lines || []).join(' / '));
  }
  return s;
}

const ping = (net, from, to) => pingOnce(net, getDevice(net, from), to).ok;

/* ================================================================= VLANs === */
section('VLANs isolate');

{
  // Two PCs on one switch. Same subnet, so only a VLAN can separate them.
  const net = buildTopology({
    devices: [
      { id: 'PC1', model: 'pc' }, { id: 'PC2', model: 'pc' },
      { id: 'SW1', model: 'switch-2960' }
    ],
    links: [
      { from: 'PC1:FastEthernet0', to: 'SW1:FastEthernet0/1' },
      { from: 'PC2:FastEthernet0', to: 'SW1:FastEthernet0/2' }
    ],
    config: {
      PC1: { ifaces: { FastEthernet0: { ip: '192.168.1.10', cidr: 24 } } },
      PC2: { ifaces: { FastEthernet0: { ip: '192.168.1.20', cidr: 24 } } }
    }
  });

  ok('same VLAN, they can ping', ping(net, 'PC1', '192.168.1.20'));

  typeStrict(net, 'SW1', [
    'configure terminal',
    'vlan 10', 'name STAFF', 'exit',
    'vlan 20', 'name STUDENT', 'exit',
    'interface FastEthernet0/1', 'switchport mode access', 'switchport access vlan 10', 'exit',
    'interface FastEthernet0/2', 'switchport mode access', 'switchport access vlan 20', 'end'
  ], 'vlan config');

  const sw = getDevice(net, 'SW1');
  eq('VLAN 10 is in the database', sw.vlans.find(v => v.id === 10)?.name, 'STAFF');
  eq('the port took the VLAN', getIface(sw, 'FastEthernet0/1').vlan, 10);
  ok('different VLANs, the ping fails', !ping(net, 'PC1', '192.168.1.20'));

  // Put them back together and it works again — nothing else changed.
  type(net, 'SW1', ['configure terminal', 'interface fa0/2', 'switchport access vlan 10', 'end']);
  ok('back in the same VLAN, it works again', ping(net, 'PC1', '192.168.1.20'));

  const showVlan = type(net, 'SW1', ['show vlan brief']).out.join('\n');
  match('show vlan brief lists the VLAN name', showVlan, /10\s+STAFF\s+active/);
  match('show vlan brief lists the ports', showVlan, /Fa0\/1/);
}

/* =============================================================== trunking === */
section('trunks carry tags between switches');

{
  const net = buildTopology({
    devices: [
      { id: 'PC1', model: 'pc' }, { id: 'PC3', model: 'pc' },
      { id: 'SW1', model: 'switch-2960' }, { id: 'SW2', model: 'switch-2960' }
    ],
    links: [
      { from: 'PC1:FastEthernet0', to: 'SW1:FastEthernet0/1' },
      { from: 'SW1:GigabitEthernet0/1', to: 'SW2:GigabitEthernet0/1' },
      { from: 'PC3:FastEthernet0', to: 'SW2:FastEthernet0/1' }
    ],
    config: {
      PC1: { ifaces: { FastEthernet0: { ip: '192.168.10.10', cidr: 24 } } },
      PC3: { ifaces: { FastEthernet0: { ip: '192.168.10.30', cidr: 24 } } },
      SW1: { vlans: [{ id: 10, name: 'STAFF' }], ifaces: { 'FastEthernet0/1': { accessVlan: 10 } } },
      SW2: { vlans: [{ id: 10, name: 'STAFF' }], ifaces: { 'FastEthernet0/1': { accessVlan: 10 } } }
    }
  });

  ok('an access uplink in VLAN 1 does not carry VLAN 10', !ping(net, 'PC1', '192.168.10.30'));

  typeStrict(net, 'SW1', ['configure terminal', 'interface g0/1', 'switchport mode trunk', 'end'], 'sw1 trunk');
  typeStrict(net, 'SW2', ['configure terminal', 'interface g0/1', 'switchport mode trunk', 'end'], 'sw2 trunk');

  ok('SW1 uplink is operationally a trunk',
     portIsTrunk(net, getDevice(net, 'SW1'), getIface(getDevice(net, 'SW1'), 'GigabitEthernet0/1')));
  ok('the trunk carries VLAN 10 across', ping(net, 'PC1', '192.168.10.30'));

  const trunkOut = type(net, 'SW1', ['show interfaces trunk']).out.join('\n');
  match('show interfaces trunk lists the port', trunkOut, /Gig0\/1\s+on\s+802\.1q\s+trunking\s+1/);

  // Prune VLAN 10 off the trunk and the same ping stops.
  typeStrict(net, 'SW1', ['configure terminal', 'interface g0/1',
                          'switchport trunk allowed vlan 20', 'end'], 'prune');
  ok('a VLAN not allowed on the trunk does not get across', !ping(net, 'PC1', '192.168.10.30'));
  type(net, 'SW1', ['configure terminal', 'interface g0/1', 'switchport trunk allowed vlan all', 'end']);
  ok('allowing every VLAN again restores it', ping(net, 'PC1', '192.168.10.30'));
}

/* ================================================= router on a stick === */
section('router-on-a-stick routes between VLANs');

{
  const net = buildTopology({
    devices: [
      { id: 'PC1', model: 'pc' }, { id: 'PC2', model: 'pc' },
      { id: 'SW1', model: 'switch-2960' }, { id: 'R1', model: 'router-1941' }
    ],
    links: [
      { from: 'PC1:FastEthernet0', to: 'SW1:FastEthernet0/1' },
      { from: 'PC2:FastEthernet0', to: 'SW1:FastEthernet0/2' },
      { from: 'SW1:GigabitEthernet0/1', to: 'R1:GigabitEthernet0/0' }
    ],
    config: {
      PC1: { ifaces: { FastEthernet0: { ip: '192.168.10.10', cidr: 24 } }, host: { gateway: '192.168.10.1' } },
      PC2: { ifaces: { FastEthernet0: { ip: '192.168.20.20', cidr: 24 } }, host: { gateway: '192.168.20.1' } },
      SW1: {
        vlans: [{ id: 10, name: 'STAFF' }, { id: 20, name: 'STUDENT' }],
        ifaces: {
          'FastEthernet0/1': { accessVlan: 10 },
          'FastEthernet0/2': { accessVlan: 20 },
          'GigabitEthernet0/1': { mode: 'trunk' }
        }
      }
    }
  });

  ok('with no router, the VLANs cannot reach each other', !ping(net, 'PC1', '192.168.20.20'));

  typeStrict(net, 'R1', [
    'configure terminal',
    'interface g0/0', 'no shutdown', 'exit',
    'interface g0/0.10', 'encapsulation dot1Q 10', 'ip address 192.168.10.1 255.255.255.0', 'exit',
    'interface g0/0.20', 'encapsulation dot1Q 20', 'ip address 192.168.20.1 255.255.255.0', 'end'
  ], 'router on a stick');

  const r1 = getDevice(net, 'R1');
  eq('the subinterface exists', getIface(r1, 'GigabitEthernet0/0.10')?.encapVlan, 10);
  ok('PC1 reaches its own gateway', ping(net, 'PC1', '192.168.10.1'));
  ok('PC1 reaches the other VLAN', ping(net, 'PC1', '192.168.20.20'));

  // The classic trap: the encapsulation was never typed.
  type(net, 'R1', ['configure terminal', 'interface g0/0.20', 'no encapsulation dot1Q 20', 'end']);
  ok('without encapsulation the subinterface is dead', !ping(net, 'PC1', '192.168.20.20'));

  const cfg = type(net, 'R1', ['show running-config']).out.join('\n');
  match('running-config shows the subinterface', cfg, /interface GigabitEthernet0\/0\.10/);
  match('running-config shows the encapsulation', cfg, /encapsulation dot1Q 10/);
}

/* ============================================== layer 3 switch === */
section('a layer 3 switch routes only once told to');

{
  const net = buildTopology({
    devices: [
      { id: 'PC1', model: 'pc' }, { id: 'PC2', model: 'pc' },
      { id: 'MLS1', model: 'switch-3560' }
    ],
    links: [
      { from: 'PC1:FastEthernet0', to: 'MLS1:FastEthernet0/1' },
      { from: 'PC2:FastEthernet0', to: 'MLS1:FastEthernet0/2' }
    ],
    config: {
      PC1: { ifaces: { FastEthernet0: { ip: '192.168.10.10', cidr: 24 } }, host: { gateway: '192.168.10.1' } },
      PC2: { ifaces: { FastEthernet0: { ip: '192.168.20.20', cidr: 24 } }, host: { gateway: '192.168.20.1' } },
      MLS1: {
        vlans: [{ id: 10, name: 'STAFF' }, { id: 20, name: 'STUDENT' }],
        ifaces: { 'FastEthernet0/1': { accessVlan: 10 }, 'FastEthernet0/2': { accessVlan: 20 } }
      }
    }
  });

  typeStrict(net, 'MLS1', [
    'configure terminal',
    'interface vlan 10', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface vlan 20', 'ip address 192.168.20.1 255.255.255.0', 'no shutdown', 'end'
  ], 'svi');

  ok('the SVI answers on its own VLAN', ping(net, 'PC1', '192.168.10.1'));
  ok('but without ip routing nothing crosses', !ping(net, 'PC1', '192.168.20.20'));

  typeStrict(net, 'MLS1', ['configure terminal', 'ip routing', 'end'], 'ip routing');
  ok('ip routing is what makes it route', ping(net, 'PC1', '192.168.20.20'));

  // A 2960 must refuse the same command.
  const net2 = buildTopology({ devices: [{ id: 'SW9', model: 'switch-2960' }], links: [], config: {} });
  const res = type(net2, 'SW9', ['configure terminal', 'ip routing']);
  match('a 2960 rejects ip routing', res.out.join('\n'), /Invalid input/);
}

/* ========================================================= spanning tree === */
section('spanning tree breaks the loop');

{
  // Three switches in a triangle: without STP this is a broadcast storm.
  const net = buildTopology({
    devices: [
      { id: 'SW1', model: 'switch-2960' }, { id: 'SW2', model: 'switch-2960' },
      { id: 'SW3', model: 'switch-2960' },
      { id: 'PC1', model: 'pc' }, { id: 'PC2', model: 'pc' }
    ],
    links: [
      { from: 'SW1:GigabitEthernet0/1', to: 'SW2:GigabitEthernet0/1' },
      { from: 'SW2:GigabitEthernet0/2', to: 'SW3:GigabitEthernet0/2' },
      { from: 'SW1:GigabitEthernet0/2', to: 'SW3:GigabitEthernet0/1' },
      { from: 'PC1:FastEthernet0', to: 'SW1:FastEthernet0/1' },
      { from: 'PC2:FastEthernet0', to: 'SW3:FastEthernet0/1' }
    ],
    config: {
      PC1: { ifaces: { FastEthernet0: { ip: '192.168.1.10', cidr: 24 } } },
      PC2: { ifaces: { FastEthernet0: { ip: '192.168.1.20', cidr: 24 } } }
    }
  });

  const states = stpState(net, 1);
  const blocked = [...states.values()].filter(v => v.state === 'blocking');
  eq('exactly one port is blocking', blocked.length, 1);
  ok('the ring still passes traffic', ping(net, 'PC1', '192.168.1.20'));

  // Lowest MAC wins when every priority is the default.
  const root = rootBridge(net, 1);
  eq('the lowest bridge ID is root', root.id, 'SW1');

  // Now make SW3 root on purpose.
  typeStrict(net, 'SW3', ['configure terminal', 'spanning-tree vlan 1 priority 4096', 'end'], 'priority');
  eq('a lower priority takes the root role', rootBridge(net, 1).id, 'SW3');

  const bad = type(net, 'SW3', ['configure terminal', 'spanning-tree vlan 1 priority 5000']);
  match('a priority off the 4096 step is refused', bad.out.join('\n'), /increments of 4096/);

  typeStrict(net, 'SW2', ['configure terminal', 'spanning-tree vlan 1 root primary', 'end'], 'root primary');
  eq('root primary sets 24576', getDevice(net, 'SW2').stp.priority[1], 24576);

  const treeOut = type(net, 'SW1', ['show spanning-tree']).out.join('\n');
  match('show spanning-tree names the protocol', treeOut, /Spanning tree enabled protocol ieee/);
  match('show spanning-tree lists a port role', treeOut, /(Root|Desg|Altn)\s+(FWD|BLK)/);

  // Still exactly one blocked port after the elections moved around.
  eq('still exactly one blocking port',
     [...stpState(net, 1).values()].filter(v => v.state === 'blocking').length, 1);
}

/* ================================================================== OSPF === */
section('OSPF learns routes');

{
  const net = buildTopology({
    devices: [
      { id: 'PC1', model: 'pc' }, { id: 'PC2', model: 'pc' },
      { id: 'R1', model: 'router-1941' }, { id: 'R2', model: 'router-1941' }
    ],
    links: [
      { from: 'PC1:FastEthernet0', to: 'R1:GigabitEthernet0/0' },
      { from: 'R1:GigabitEthernet0/1', to: 'R2:GigabitEthernet0/1' },
      { from: 'PC2:FastEthernet0', to: 'R2:GigabitEthernet0/0' }
    ],
    config: {
      PC1: { ifaces: { FastEthernet0: { ip: '192.168.10.10', cidr: 24 } }, host: { gateway: '192.168.10.1' } },
      PC2: { ifaces: { FastEthernet0: { ip: '192.168.20.20', cidr: 24 } }, host: { gateway: '192.168.20.1' } },
      R1: {
        ifaces: {
          'GigabitEthernet0/0': { ip: '192.168.10.1', cidr: 24 },
          'GigabitEthernet0/1': { ip: '10.0.0.1', cidr: 30 }
        }
      },
      R2: {
        ifaces: {
          'GigabitEthernet0/0': { ip: '192.168.20.1', cidr: 24 },
          'GigabitEthernet0/1': { ip: '10.0.0.2', cidr: 30 }
        }
      }
    }
  });

  ok('with no routing protocol the far LAN is unreachable', !ping(net, 'PC1', '192.168.20.20'));

  ok('a wildcard mask covers its own subnet', wildcardMatches('192.168.10.1', '192.168.10.0', '0.0.0.255'));
  ok('and does not cover a different one', !wildcardMatches('192.168.20.1', '192.168.10.0', '0.0.0.255'));

  typeStrict(net, 'R1', [
    'configure terminal', 'router ospf 1', 'router-id 1.1.1.1',
    'network 192.168.10.0 0.0.0.255 area 0',
    'network 10.0.0.0 0.0.0.3 area 0', 'end'
  ], 'r1 ospf');

  eq('one router alone has no neighbours', ospfNeighbors(net, getDevice(net, 'R1')).length, 0);

  typeStrict(net, 'R2', [
    'configure terminal', 'router ospf 1', 'router-id 2.2.2.2',
    'network 192.168.20.0 0.0.0.255 area 0',
    'network 10.0.0.0 0.0.0.3 area 0', 'end'
  ], 'r2 ospf');

  const nbrs = ospfNeighbors(net, getDevice(net, 'R1'));
  eq('the adjacency comes up', nbrs.length, 1);
  eq('and names the right router', nbrs[0].routerId, '2.2.2.2');

  const routes = ospfRoutes(net, getDevice(net, 'R1'));
  const learned = routes.find(r => r.prefix === '192.168.20.0');
  ok('R1 learns the far LAN', !!learned);
  eq('with the OSPF administrative distance', learned?.ad, 110);
  eq('via its neighbour', learned?.nextHop, '10.0.0.2');
  ok('and the PCs can now reach each other', ping(net, 'PC1', '192.168.20.20'));

  const nbrOut = type(net, 'R1', ['show ip ospf neighbor']).out.join('\n');
  match('show ip ospf neighbor lists it', nbrOut, /2\.2\.2\.2\s+1\s+FULL/);
  const routeOut = type(net, 'R1', ['show ip route']).out.join('\n');
  match('show ip route marks it O', routeOut, /^O\s+192\.168\.20\.0\/24 \[110\//m);

  // The classic fault: a wildcard mask that covers nothing.
  type(net, 'R2', ['configure terminal', 'router ospf 1',
                   'no network 192.168.20.0 0.0.0.255 area 0',
                   'network 192.168.20.0 0.0.0.0 area 0', 'end']);
  ok('a wildcard that matches no interface advertises nothing',
     !ospfRoutes(net, getDevice(net, 'R1')).some(r => r.prefix === '192.168.20.0'));
  type(net, 'R2', ['configure terminal', 'router ospf 1',
                   'network 192.168.20.0 0.0.0.255 area 0', 'end']);
  ok('fixing the wildcard brings the route back',
     ospfRoutes(net, getDevice(net, 'R1')).some(r => r.prefix === '192.168.20.0'));

  // A mismatched area is the other classic: the neighbour never forms.
  type(net, 'R2', ['configure terminal', 'router ospf 1',
                   'no network 10.0.0.0 0.0.0.3 area 0',
                   'network 10.0.0.0 0.0.0.3 area 1', 'end']);
  eq('an area mismatch kills the adjacency', ospfNeighbors(net, getDevice(net, 'R1')).length, 0);
  type(net, 'R2', ['configure terminal', 'router ospf 1',
                   'no network 10.0.0.0 0.0.0.3 area 1',
                   'network 10.0.0.0 0.0.0.3 area 0', 'end']);
  eq('putting it back in area 0 restores it', ospfNeighbors(net, getDevice(net, 'R1')).length, 1);

  // passive-interface stops adjacencies without stopping advertisement.
  typeStrict(net, 'R1', ['configure terminal', 'router ospf 1',
                         'passive-interface GigabitEthernet0/0', 'end'], 'passive');
  eq('a passive LAN interface keeps the WAN adjacency',
     ospfNeighbors(net, getDevice(net, 'R1')).length, 1);
  ok('and R2 still learns the passive LAN',
     ospfRoutes(net, getDevice(net, 'R2')).some(r => r.prefix === '192.168.10.0'));
}

process.exit(t.report() ? 0 : 1);
