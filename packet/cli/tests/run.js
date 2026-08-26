// run.js — headless self-test. `node cli/tests/run.js`
// No dependencies, no build step. Asserts the engine's behaviour and then
// drives each lab's own answer sequence through the real CLI to 100%.

import { buildTopology } from '../engine/topology.js';
import {
  getDevice, getIface, pingOnce, traceRoute, forward, routingTable,
  lookupRoute, ifaceUp, applyDhcp, FAIL
} from '../engine/net.js';
import * as addr from '../engine/addr.js';
import { REFERENCE, REFERENCE_ROUTED } from './fixtures.js';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? `\n      ${detail}` : ''}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function section(title) { console.log(`\n\x1b[1m${title}\x1b[0m`); }

/* ------------------------------------------------------------ addressing --- */
section('addressing');

eq('maskToCidr /24', addr.maskToCidr('255.255.255.0'), 24);
eq('maskToCidr /26', addr.maskToCidr('255.255.255.192'), 26);
eq('cidrToMask 26', addr.cidrToMask(26), '255.255.255.192');
eq('cidrToMask 0', addr.cidrToMask(0), '0.0.0.0');
eq('networkOf', addr.networkOf('192.168.10.130', '255.255.255.192'), '192.168.10.128');
eq('broadcastOf', addr.broadcastOf('192.168.10.130', '255.255.255.192'), '192.168.10.191');
ok('validMask rejects 255.255.0.255', !addr.isValidMask('255.255.0.255'));
ok('validMask accepts 255.255.254.0', addr.isValidMask('255.255.254.0'));
eq('hostRange count /26', addr.hostRange('192.168.10.0', '255.255.255.192').count, 62);
eq('hostRange first /26', addr.hostRange('192.168.10.64', '255.255.255.192').first, '192.168.10.65');
ok('sameNetwork true', addr.sameNetwork('192.168.10.20', '192.168.10.1', '255.255.255.0'));
ok('sameNetwork false', !addr.sameNetwork('192.168.10.20', '192.168.20.1', '255.255.255.0'));
eq('binary octets', addr.toBinaryOctets('192.168.10.0'), '11000000.10101000.00001010.00000000');

eq('ipv6 expand', addr.expandIpv6('2001:db8:acad::10'), '2001:0db8:acad:0000:0000:0000:0000:0010');
eq('ipv6 compress', addr.compressIpv6('2001:0db8:acad:0000:0000:0000:0000:0010'), '2001:db8:acad::10');
eq('ipv6 compress longest run', addr.compressIpv6('2001:0:0:1:0:0:0:1'), '2001:0:0:1::1');
eq('ipv6 type link-local', addr.ipv6Type('fe80::1'), 'link-local');
eq('ipv6 type global', addr.ipv6Type('2001:db8::1'), 'global-unicast');
eq('ipv6 type multicast', addr.ipv6Type('ff02::1'), 'multicast');
ok('ipv6 rejects double ::', addr.expandIpv6('2001::db8::1') === null);
eq('eui64', addr.eui64('00:60:2f:00:01:02'), '0260:2fff:fe00:0102');

/* ----------------------------------------------------------------- links --- */
section('links and interface status');

{
  const net = buildTopology(REFERENCE);
  const r1 = getDevice(net, 'R1');
  ok('R1 g0/0 is up', ifaceUp(net, r1, getIface(r1, 'GigabitEthernet0/0')));
  ok('R1 s0/0/0 is down (unconnected)', !ifaceUp(net, r1, getIface(r1, 'Serial0/0/0')));

  const sw1 = getDevice(net, 'SW1');
  ok('SW1 Fa0/1 up', ifaceUp(net, sw1, getIface(sw1, 'FastEthernet0/1')));
  ok('SW1 Fa0/5 down (nothing plugged in)', !ifaceUp(net, sw1, getIface(sw1, 'FastEthernet0/5')));

  // Shut an interface and the neighbour's line protocol follows it down.
  getIface(r1, 'GigabitEthernet0/0').shutdown = true;
  ok('shutdown takes the link down', !ifaceUp(net, r1, getIface(r1, 'GigabitEthernet0/0')));
}

/* --------------------------------------------------------- routing table --- */
section('routing table');

{
  const net = buildTopology(REFERENCE_ROUTED);
  const r1 = getDevice(net, 'R1');
  const table = routingTable(net, r1);
  ok('R1 has connected route for 192.168.10.0',
     table.some(r => r.code === 'C' && r.prefix === '192.168.10.0'));
  ok('R1 has local /32 for its own address',
     table.some(r => r.code === 'L' && r.prefix === '192.168.10.1' && r.cidr === 32));
  ok('R1 has static route for 192.168.20.0',
     table.some(r => r.code === 'S' && r.prefix === '192.168.20.0' && r.nextHop === '10.0.0.2'));

  const hit = lookupRoute(net, r1, '192.168.20.20');
  eq('lookup picks the static', hit.nextHop, '10.0.0.2');

  const local = lookupRoute(net, r1, '192.168.10.99');
  eq('lookup prefers connected for local net', local.code, 'C');

  // Longest prefix wins over a default route.
  r1.staticRoutes.push({ prefix: '0.0.0.0', mask: '0.0.0.0', nextHop: '10.0.0.2', exitIf: null, ipv6: false });
  eq('longest prefix beats default', lookupRoute(net, r1, '192.168.20.20').cidr, 24);
  eq('default catches everything else', lookupRoute(net, r1, '8.8.8.8').code, 'S*');
}

/* -------------------------------------------------------------- the ping --- */
section('forwarding');

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  const r = pingOnce(net, pc1, '192.168.20.20');
  ok('PC1 reaches PC2 when both routes exist', r.ok, JSON.stringify(r.failure));
  eq('two routers means two forwarding hops beyond the source', r.hops.length, 3);

  const first = r.hops[0];
  eq('first hop leaves PC1', first.device, 'PC1');
  eq('first hop dst MAC is the gateway, not the far host', first.nextDevice, 'R1');
  eq('L3 source is unchanged at the last hop', r.hops[r.hops.length - 1].srcIp, '192.168.10.20');
  eq('L3 destination is unchanged at the last hop', r.hops[r.hops.length - 1].dstIp, '192.168.20.20');
  ok('L2 addresses are rewritten between hops',
     r.hops[0].srcMac !== r.hops[1].srcMac && r.hops[0].dstMac !== r.hops[1].dstMac);
  ok('the frame crossed SW1', r.hops[0].viaSwitches.some(s => s.id === 'SW1'));
}

{
  // The signature U5 failure: R1 knows the way there, R2 doesn't know the way back.
  const net = buildTopology({
    ...REFERENCE,
    config: { ...REFERENCE.config, R1: { ...REFERENCE.config.R1, routes: ['192.168.20.0/24 via 10.0.0.2'] } }
  });
  const pc1 = getDevice(net, 'PC1');
  const r = pingOnce(net, pc1, '192.168.20.20');
  ok('missing return route fails', !r.ok);
  eq('...and it fails on the reply, not the request', r.phase, 'reply');
  ok('...which is why it looks like a timeout', r.noReturnPath === true);
}

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  getIface(pc1, 'FastEthernet0').mask = '255.255.0.0';   // wrong mask
  const r = pingOnce(net, pc1, '192.168.20.20');
  ok('a /16 mask makes PC1 think the far host is local', !r.ok);
  eq('...so it ARPs for a host that is not on the wire', r.failure, FAIL.ARP_FAILED);
}

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  pc1.host.gateway = null;
  const r = pingOnce(net, pc1, '192.168.20.20');
  eq('no gateway is a distinct failure', r.failure, FAIL.NO_GATEWAY);

  pc1.host.gateway = '192.168.99.1';
  eq('a gateway off my subnet is the same failure',
     pingOnce(net, pc1, '192.168.20.20').failure, FAIL.NO_GATEWAY);
}

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  const r1 = getDevice(net, 'R1');
  getIface(r1, 'GigabitEthernet0/1').shutdown = true;
  const r = pingOnce(net, pc1, '192.168.20.20');
  ok('a shut interface breaks the path', !r.ok);
  ok('local ping to the gateway still works', pingOnce(net, pc1, '192.168.10.1').ok);
}

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  ok('ping 127.0.0.1 always answers', pingOnce(net, pc1, '127.0.0.1').ok);
  ok('ping own address answers', pingOnce(net, pc1, '192.168.10.20').ok);
  const unknown = pingOnce(net, pc1, '203.0.113.9');
  ok('unrouted destination fails', !unknown.ok);
  eq('...with no route, from R1', unknown.failure, FAIL.NO_ROUTE);
}

/* ------------------------------------------------------------------- ARP --- */
section('ARP and MAC learning');

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  const sw1 = getDevice(net, 'SW1');

  eq('ARP cache starts empty', pc1.arp.length, 0);
  eq('MAC table starts empty', sw1.macTable.length, 0);

  pingOnce(net, pc1, '192.168.20.20');

  const cached = pc1.arp.map(a => a.ip);
  ok('PC1 ARPs for the gateway when the target is remote', cached.includes('192.168.10.1'));
  ok('PC1 does NOT ARP for the far host', !cached.includes('192.168.20.20'));
  ok('SW1 learned PC1 MAC', sw1.macTable.some(e => e.mac === getIface(pc1, 'FastEthernet0').mac));
  ok('SW1 learned the router MAC too', sw1.macTable.length >= 2);
}

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  // Add a second PC on LAN 10 and ping it: now ARP resolves the host itself.
  pingOnce(net, pc1, '192.168.10.1');
  ok('local target is ARPed directly', pc1.arp.some(a => a.ip === '192.168.10.1'));
}

/* -------------------------------------------------------------- tracert --- */
section('tracert');

{
  const net = buildTopology(REFERENCE_ROUTED);
  const pc1 = getDevice(net, 'PC1');
  const t = traceRoute(net, pc1, '192.168.20.20');
  ok('tracert completes', t.ok, JSON.stringify(t.results));
  eq('hop 1 is R1 on the LAN side', t.results[0].ip, '192.168.10.1');
  eq('hop 2 is R2 on the transit link', t.results[1].ip, '10.0.0.2');
  ok('final hop is the destination', t.results[t.results.length - 1].done);
}

/* ------------------------------------------------------------------ DHCP --- */
section('DHCP');

{
  const spec = JSON.parse(JSON.stringify(REFERENCE_ROUTED));
  spec.config.R1.dhcp = {
    excluded: [{ start: '192.168.10.1', end: '192.168.10.9' }],
    pools: [{ name: 'LAN10', network: '192.168.10.0', mask: '255.255.255.0',
              defaultRouter: '192.168.10.1', dnsServer: '8.8.8.8' }]
  };
  spec.config.PC1 = { host: { dhcp: true, gateway: null } };
  const net = buildTopology(spec);
  const pc1 = getDevice(net, 'PC1');

  eq('client got an address from the pool', getIface(pc1, 'FastEthernet0').ip, '192.168.10.10');
  eq('...respecting the excluded range', getIface(pc1, 'FastEthernet0').mask, '255.255.255.0');
  eq('...and the default-router option', pc1.host.gateway, '192.168.10.1');
  ok('server recorded the binding', getDevice(net, 'R1').dhcpBindings.length === 1);
  ok('a DHCP client can still reach the far LAN', pingOnce(net, pc1, '192.168.20.20').ok);
}

{
  const spec = JSON.parse(JSON.stringify(REFERENCE));
  spec.config.PC1 = { host: { dhcp: true, gateway: null } };
  const net = buildTopology(spec);
  const pc1 = getDevice(net, 'PC1');
  ok('no DHCP server means no address', !getIface(pc1, 'FastEthernet0').ip);
  ok('...and the client is flagged APIPA', pc1.host.apipa === true);
}

/* --------------------------------------------------------------- faults --- */
section('planted faults');

{
  const spec = { ...REFERENCE_ROUTED, faults: [{ type: 'missing-route', device: 'R2', prefix: '192.168.10.0' }] };
  const net = buildTopology(spec);
  ok('missing-route fault breaks the ping', !pingOnce(net, getDevice(net, 'PC1'), '192.168.20.20').ok);
}
{
  const spec = { ...REFERENCE_ROUTED, faults: [{ type: 'shutdown', device: 'R1', iface: 'GigabitEthernet0/1' }] };
  const net = buildTopology(spec);
  ok('shutdown fault breaks the ping', !pingOnce(net, getDevice(net, 'PC1'), '192.168.20.20').ok);
}
{
  const spec = { ...REFERENCE_ROUTED, faults: [{ type: 'wrong-gateway', device: 'PC2', gateway: '192.168.20.9' }] };
  const net = buildTopology(spec);
  const r = pingOnce(net, getDevice(net, 'PC1'), '192.168.20.20');
  ok('a wrong gateway on the FAR host still breaks the ping', !r.ok);
  eq('...and it shows up on the reply', r.phase, 'reply');
}

/* ---------------------------------------------------------------- report --- */
console.log('');
if (fail) {
  console.log(`\x1b[31m${fail} failed\x1b[0m, ${pass} passed\n`);
  failures.forEach(f => console.log(`  \x1b[31m✗\x1b[0m ${f}`));
  console.log('');
  process.exit(1);
} else {
  console.log(`\x1b[32m✓ all ${pass} engine checks passed\x1b[0m\n`);
}
