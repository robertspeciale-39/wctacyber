// cli.test.js — the IOS command line: modes, abbreviation, help, completion,
// error messages, and the configuration commands actually changing state.
//
//   node cli/tests/cli.test.js

import { createHarness } from './assert.js';
import { buildTopology } from '../engine/topology.js';
import { getDevice, getIface, ifaceUp, routingTable, pingOnce } from '../engine/net.js';
import { createSession, execute, contextHelp, complete, promptFor } from '../engine/ios.js';
import { REFERENCE, REFERENCE_ROUTED } from './fixtures.js';

const t = createHarness('cli');
const { ok, eq, match, section } = t;

/** Run a list of commands, return every line of output joined. */
function run(session, ...cmds) {
  const out = [];
  for (const c of cmds) out.push(...(execute(session, c).lines || []));
  return out;
}
function text(session, ...cmds) { return run(session, ...cmds).join('\n'); }

function freshR1(spec = REFERENCE) {
  const net = buildTopology(JSON.parse(JSON.stringify(spec)));
  return { net, s: createSession(net, 'R1') };
}

/* ----------------------------------------------------------------- modes --- */
section('modes and prompts');

{
  const { s } = freshR1();
  eq('starts in user EXEC', promptFor(s), 'R1>');
  run(s, 'enable');
  eq('enable reaches privileged EXEC', promptFor(s), 'R1#');
  run(s, 'configure terminal');
  eq('conf t reaches global config', promptFor(s), 'R1(config)#');
  run(s, 'interface gigabitEthernet 0/0');
  eq('interface reaches config-if', promptFor(s), 'R1(config-if)#');
  run(s, 'exit');
  eq('exit steps back one level', promptFor(s), 'R1(config)#');
  run(s, 'interface g0/1', 'end');
  eq('end jumps straight to privileged EXEC', promptFor(s), 'R1#');
  ok('end logs a config message', s.dev.log.some(l => l.includes('%SYS-5-CONFIG_I')));
}

{
  const { s } = freshR1();
  run(s, 'enable', 'configure terminal', 'hostname Edge');
  eq('hostname changes the prompt', promptFor(s), 'Edge(config)#');
}

{
  const { s } = freshR1();
  run(s, 'enable', 'conf t', 'enable secret cisco123', 'end', 'disable');
  const r = execute(s, 'enable');
  eq('enable now asks for a password', r.prompt, 'Password: ');
  ok('...and hides it', r.secret === true);
  execute(s, 'wrong');
  eq('a bad password does not elevate', promptFor(s), 'R1>');
  execute(s, 'enable');
  execute(s, 'cisco123');
  eq('the right password does', promptFor(s), 'R1#');
}

/* ---------------------------------------------------------- abbreviation --- */
section('abbreviation and errors');

{
  const { s } = freshR1();
  run(s, 'en');
  eq('en is enough for enable', promptFor(s), 'R1#');
  const out = text(s, 'sh ip int br');
  match('sh ip int br works', out, /GigabitEthernet0\/0/);

  const amb = text(s, 'e');
  match('a single ambiguous letter is reported', amb, /Ambiguous command/);

  const bad = text(s, 'show ip rout3');
  match('a bad word gives the caret error', bad, /Invalid input detected/);
  const lines = run(s, 'show ip banana');
  eq('the caret sits under the offending word', lines[0].indexOf('^'), 'show ip '.length);

  match('an unfinished command says so', text(s, 'show ip'), /Incomplete command/);
}

{
  const { s } = freshR1();
  run(s, 'en', 'conf t', 'int g0/0');
  const lines = run(s, 'ip address 192.168.1.1');
  match('a missing mask is incomplete', lines.join('\n'), /Incomplete command/);
  const bad = run(s, 'ip address 192.168.1.1 255.255.0.255');
  match('an invalid mask is rejected', bad.join('\n'), /Invalid input/);
}

/* ----------------------------------------------------- interface naming --- */
section('interface naming');

{
  const { s } = freshR1();
  run(s, 'en', 'conf t');
  for (const form of ['g0/0', 'gi0/0', 'gig 0/0', 'gigabitethernet0/0', 'GigabitEthernet 0/0']) {
    run(s, 'interface ' + form);
    eq(`interface ${form}`, s.ctxIface?.name, 'GigabitEthernet0/0');
    run(s, 'exit');
  }
  run(s, 'int s0/0/0');
  eq('serial abbreviations work too', s.ctxIface?.name, 'Serial0/0/0');
}

/* ------------------------------------------------------------------ help --- */
section('context-sensitive help');

{
  const { s } = freshR1();
  run(s, 'en');
  const top = contextHelp(s, '');
  ok('bare ? lists commands', top.some(l => /\bshow\b/.test(l)));
  ok('...including privileged ones', top.some(l => /configure/.test(l)));

  const showKids = contextHelp(s, 'show ');
  ok('show ? lists subcommands', showKids.some(l => /\bip\b/.test(l)));
  ok('...with help text', showKids.some(l => /IP information/.test(l)));

  const partial = contextHelp(s, 'sh');
  ok('sh? completes on the prefix', partial.some(l => /show/.test(l)));

  const route = contextHelp(s, 'show ip route ');
  ok('show ip route ? offers <cr>', route.some(l => /<cr>/.test(l)));
  ok('...and its filters', route.some(l => /static/.test(l)));

  run(s, 'conf t', 'int g0/0');
  const ipHelp = contextHelp(s, 'ip address ');
  ok('ip address ? asks for an address', ipHelp.some(l => /A\.B\.C\.D/.test(l)));
}

/* ------------------------------------------------------------ completion --- */
section('tab completion');

{
  const { s } = freshR1();
  run(s, 'en');
  eq('unique prefix completes', complete(s, 'sho').line, 'show ');
  eq('already-complete word is left alone', complete(s, 'show ').line, 'show ');
  eq('nested completion', complete(s, 'show ru').line, 'show running-config ');
  const many = complete(s, 'show i');
  ok('an ambiguous prefix lists the options', (many.lines || []).length > 1);
}

/* -------------------------------------------------------- configuration --- */
section('configuration changes state');

{
  const { net, s } = freshR1({ ...REFERENCE, config: {} });
  const r1 = getDevice(net, 'R1');
  ok('interfaces start administratively down', !ifaceUp(net, r1, getIface(r1, 'GigabitEthernet0/0')));

  run(s, 'en', 'conf t', 'int g0/0', 'ip address 192.168.10.1 255.255.255.0');
  ok('the address lands but the interface is still down',
     getIface(r1, 'GigabitEthernet0/0').ip === '192.168.10.1' &&
     !ifaceUp(net, r1, getIface(r1, 'GigabitEthernet0/0')));

  run(s, 'no shutdown');
  ok('no shutdown brings it up', ifaceUp(net, r1, getIface(r1, 'GigabitEthernet0/0')));
  ok('...and logs the link message', r1.log.some(l => /LINK-5-CHANGED.*changed state to up/.test(l)));
  ok('...and the neighbour sees it too',
     getDevice(net, 'SW1').log.some(l => /LINK-5-CHANGED/.test(l)));

  run(s, 'shutdown');
  ok('shutdown takes it back down', !ifaceUp(net, r1, getIface(r1, 'GigabitEthernet0/0')));
  ok('...with the administratively down message',
     r1.log.some(l => /administratively down/.test(l)));
}

{
  const { net, s } = freshR1();
  run(s, 'en', 'conf t', 'ip route 192.168.20.0 255.255.255.0 10.0.0.2');
  const table = routingTable(net, getDevice(net, 'R1'));
  ok('ip route adds a static route',
     table.some(r => r.code === 'S' && r.prefix === '192.168.20.0' && r.nextHop === '10.0.0.2'));
  run(s, 'no ip route 192.168.20.0 255.255.255.0 10.0.0.2');
  ok('no ip route removes it',
     !routingTable(net, getDevice(net, 'R1')).some(r => r.code === 'S'));

  run(s, 'ip route 0.0.0.0 0.0.0.0 10.0.0.2');
  const out = text(s, 'do-not-a-command') + text(s, 'end') + text(s, 'show ip route');
  match('a default route shows a gateway of last resort', out, /Gateway of last resort is 10\.0\.0\.2/);
}

{
  // The whole U5 lab, driven through the CLI.
  const net = buildTopology(JSON.parse(JSON.stringify(REFERENCE)));
  const r1 = createSession(net, 'R1');
  const r2 = createSession(net, 'R2');
  const pc1 = getDevice(net, 'PC1');

  ok('before routing, PC1 cannot reach PC2', !pingOnce(net, pc1, '192.168.20.20').ok);

  run(r1, 'en', 'conf t', 'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end');
  ok('one route is still not enough', !pingOnce(net, pc1, '192.168.20.20').ok);

  run(r2, 'en', 'conf t', 'ip route 192.168.10.0 255.255.255.0 10.0.0.1', 'end');
  ok('both routes make the ping work', pingOnce(net, pc1, '192.168.20.20').ok);
}

{
  const { net, s } = freshR1(REFERENCE_ROUTED);
  run(s, 'en', 'conf t',
      'ip dhcp excluded-address 192.168.10.1 192.168.10.9',
      'ip dhcp pool LAN10',
      'network 192.168.10.0 255.255.255.0',
      'default-router 192.168.10.1',
      'dns-server 8.8.8.8',
      'end');
  const r1 = getDevice(net, 'R1');
  eq('the pool exists', r1.dhcpPools.length, 1);
  eq('...with the network set', r1.dhcpPools[0].network, '192.168.10.0');
  eq('...and the gateway option', r1.dhcpPools[0].defaultRouter, '192.168.10.1');
  eq('the exclusion is recorded', r1.dhcpExcluded[0].end, '192.168.10.9');
  match('show ip dhcp pool renders', text(s, 'show ip dhcp pool'), /Pool LAN10/);
}

{
  const { net, s } = freshR1();
  run(s, 'en', 'conf t', 'ipv6 unicast-routing', 'int g0/0',
      'ipv6 address 2001:db8:acad:1::1/64', 'ipv6 address fe80::1 link-local', 'end');
  const i = getIface(getDevice(net, 'R1'), 'GigabitEthernet0/0');
  eq('IPv6 routing is on', getDevice(net, 'R1').ipv6Routing, true);
  eq('two IPv6 addresses configured', i.ipv6.length, 2);
  ok('one is link-local', i.ipv6.some(a => a.linkLocal));
  match('show ipv6 int brief renders', text(s, 'show ipv6 interface brief'), /2001:DB8:ACAD:1::1/);
}

/* --------------------------------------------------------- show renders --- */
section('show output');

{
  const { s } = freshR1(REFERENCE_ROUTED);
  run(s, 'en');
  const brief = text(s, 'show ip interface brief');
  match('brief has the header', brief, /Interface\s+IP-Address\s+OK\?\s+Method\s+Status\s+Protocol/);
  match('brief shows an up interface', brief, /GigabitEthernet0\/0\s+192\.168\.10\.1\s+YES manual up\s+up/);
  match('brief shows an unused one as admin down', brief, /Serial0\/0\/0\s+unassigned\s+YES unset\s+administratively down down/);

  const route = text(s, 'show ip route');
  match('route table has the codes block', route, /Codes: L - local, C - connected, S - static/);
  match('route table shows the connected LAN', route, /C\s+192\.168\.10\.0\/24 is directly connected, GigabitEthernet0\/0/);
  match('route table shows the local /32', route, /L\s+192\.168\.10\.1\/32 is directly connected/);
  match('route table shows the static', route, /S\s+192\.168\.20\.0\/24 \[1\/0\] via 10\.0\.0\.2/);

  const running = text(s, 'show running-config');
  match('running-config has the hostname', running, /hostname R1/);
  match('running-config has the interface block', running, /interface GigabitEthernet0\/0/);
  match('running-config has the address', running, / ip address 192\.168\.10\.1 255\.255\.255\.0/);
  match('running-config has the static route', running, /ip route 192\.168\.20\.0 255\.255\.255\.0 10\.0\.0\.2/);
  match('running-config ends properly', running, /\nend/);

  match('show version renders', text(s, 'show version'), /Cisco IOS Software/);
}

{
  const net = buildTopology(JSON.parse(JSON.stringify(REFERENCE_ROUTED)));
  const sw = createSession(net, 'SW1');
  pingOnce(net, getDevice(net, 'PC1'), '192.168.20.20');
  run(sw, 'en');
  const mac = text(sw, 'show mac address-table');
  match('MAC table has the header', mac, /Vlan\s+Mac Address\s+Type\s+Ports/);
  match('MAC table learned a dynamic entry', mac, /DYNAMIC\s+Fa0\/1/);
  run(sw, 'clear mac address-table dynamic');
  ok('clear empties it', getDevice(net, 'SW1').macTable.length === 0);

  match('interfaces status renders', text(sw, 'show interfaces status'), /Fa0\/1\s+connected\s+1/);
}

{
  const { net, s } = freshR1(REFERENCE_ROUTED);
  run(s, 'en');
  const p = text(s, 'ping 10.0.0.2');
  match('ping prints the escape line', p, /Type escape sequence to abort/);
  match('ping succeeds', p, /Success rate is (100|80) percent/);
  const bad = text(s, 'ping 203.0.113.1');
  match('ping to nowhere fails', bad, /Success rate is 0 percent/);

  const arp = text(s, 'show arp');
  match('ARP table lists our own interface', arp, /Internet\s+10\.0\.0\.1\s+-\s+/);
}

/* --------------------------------------------------------- save / reload --- */
section('save and reload');

{
  const { net, s } = freshR1();
  run(s, 'en', 'conf t', 'hostname Saved', 'ip route 192.168.20.0 255.255.255.0 10.0.0.2', 'end');
  const r = execute(s, 'copy running-config startup-config');
  eq('copy asks for the destination filename', r.prompt, 'Destination filename [startup-config]? ');
  const done = execute(s, '');
  match('...then confirms', done.lines.join('\n'), /\[OK\]/);
  ok('startup-config now exists', getDevice(net, 'Saved').startupConfig !== null);

  run(s, 'conf t', 'ip route 172.16.0.0 255.255.0.0 10.0.0.2', 'end');
  const rl = execute(s, 'reload');
  match('reload warns about unsaved changes', rl.prompt, /System configuration has been modified/);
  execute(s, 'no');
  const dev = getDevice(net, 'Saved');
  eq('the saved hostname survived', dev.hostname, 'Saved');
  ok('the saved route survived', dev.staticRoutes.some(x => x.prefix === '192.168.20.0'));
  ok('the unsaved route did not', !dev.staticRoutes.some(x => x.prefix === '172.16.0.0'));
  eq('reload drops us back to user EXEC', promptFor(s), 'Saved>');
}

{
  const { net, s } = freshR1();
  run(s, 'en', 'conf t', 'hostname Gone', 'end');
  execute(s, 'reload');
  execute(s, 'no');
  eq('with nothing saved, reload returns a default hostname', getDevice(net, 'R1')?.hostname ?? net.devices[2].hostname, 'Router');
}

/* ------------------------------------------------------------ X1 baseline --- */
section('device baseline (X1)');

{
  const { net, s } = freshR1();
  run(s, 'en', 'conf t',
      'hostname R1',
      'enable secret class',
      'service password-encryption',
      'line console 0', 'password cisco', 'login', 'exit',
      'line vty 0 4', 'password cisco', 'login', 'exit',
      'banner motd #Authorized access only#',
      'end');
  const dev = getDevice(net, 'R1');
  eq('enable secret set', dev.enableSecret, 'class');
  eq('password encryption on', dev.passwordEncryption, true);
  eq('console password set', dev.lines.console.password, 'cisco');
  ok('console login enabled', dev.lines.console.login);
  eq('banner captured', dev.bannerMotd, 'Authorized access only');
  const running = text(s, 'show running-config');
  match('running-config hides the secret', running, /enable secret 5 \$1\$/);
  match('running-config encrypts line passwords', running, /password 7 /);
  match('running-config carries the banner', running, /banner motd/);
}

process.exit(t.report() ? 0 : 1);
