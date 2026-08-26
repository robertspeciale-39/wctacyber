// fixtures.js — the reference topology from curriculum.md §5 (U5), used by
// most labs and by the tests.
//
//   PC1 ─ SW1 ─ R1 ─ R2 ─ SW2 ─ PC2

export const REFERENCE = {
  devices: [
    { id: 'PC1', model: 'pc',           hostname: 'PC1', x: 0,  y: 1 },
    { id: 'SW1', model: 'switch-2960',  hostname: 'SW1', x: 1,  y: 1 },
    { id: 'R1',  model: 'router-1941',  hostname: 'R1',  x: 2,  y: 1 },
    { id: 'R2',  model: 'router-1941',  hostname: 'R2',  x: 3,  y: 1 },
    { id: 'SW2', model: 'switch-2960',  hostname: 'SW2', x: 4,  y: 1 },
    { id: 'PC2', model: 'pc',           hostname: 'PC2', x: 5,  y: 1 }
  ],
  links: [
    { from: 'PC1:FastEthernet0',       to: 'SW1:FastEthernet0/1' },
    { from: 'SW1:GigabitEthernet0/1',  to: 'R1:GigabitEthernet0/0' },
    { from: 'R1:GigabitEthernet0/1',   to: 'R2:GigabitEthernet0/0' },
    { from: 'R2:GigabitEthernet0/1',   to: 'SW2:GigabitEthernet0/1' },
    { from: 'SW2:FastEthernet0/1',     to: 'PC2:FastEthernet0' }
  ],
  config: {
    R1: {
      ifaces: {
        'GigabitEthernet0/0': { ip: '192.168.10.1', cidr: 24, description: 'LAN 10' },
        'GigabitEthernet0/1': { ip: '10.0.0.1',     cidr: 24, description: 'Link to R2' }
      }
    },
    R2: {
      ifaces: {
        'GigabitEthernet0/0': { ip: '10.0.0.2',     cidr: 24, description: 'Link to R1' },
        'GigabitEthernet0/1': { ip: '192.168.20.1', cidr: 24, description: 'LAN 20' }
      }
    },
    PC1: {
      ifaces: { 'FastEthernet0': { ip: '192.168.10.20', cidr: 24 } },
      host: { gateway: '192.168.10.1', dnsServer: null }
    },
    PC2: {
      ifaces: { 'FastEthernet0': { ip: '192.168.20.20', cidr: 24 } },
      host: { gateway: '192.168.20.1', dnsServer: null }
    }
  }
};

/** The same network with both static routes already in place — the "working" state. */
export const REFERENCE_ROUTED = {
  ...REFERENCE,
  config: {
    ...REFERENCE.config,
    R1: { ...REFERENCE.config.R1, routes: ['192.168.20.0/24 via 10.0.0.2'] },
    R2: { ...REFERENCE.config.R2, routes: ['192.168.10.0/24 via 10.0.0.1'] }
  }
};
