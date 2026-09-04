// drill.js — timed "symptom in, command out".
//
// This is `show-command-triage` from the roadmap, living inside the CLI
// section because it draws on the same command surface. Answers are checked
// against the real IOS parser's idea of abbreviation, so `sh ip int br` counts.

const BANK = [
  // --- which command proves what -----------------------------------------
  { unit: 'u6', ask: 'A PC cannot reach anything. What is the very first command you run, on the PC?', answers: ['ipconfig'] },
  { unit: 'u6', ask: 'Prove the TCP/IP stack on this PC is alive, without touching the network.', answers: ['ping 127.0.0.1'] },
  { unit: 'u6', ask: 'Find out where along the path a packet stops. From a PC.', answers: ['tracert'], prefix: true },
  { unit: 'u6', ask: 'Decide whether this is a name-resolution problem rather than a connectivity one.', answers: ['nslookup'], prefix: true },
  { unit: 'u5', ask: 'See which hardware addresses this PC has resolved.', answers: ['arp -a'] },
  { unit: 'u4', ask: 'On a switch: see which MAC addresses it has learned and on which ports.', answers: ['show mac address-table', 'show mac-address-table'] },
  { unit: 'u4', ask: 'On a router: show every interface, its address and whether it is up, in one screen.', answers: ['show ip interface brief'] },
  { unit: 'u5', ask: 'On a router: show the routing table.', answers: ['show ip route'] },
  { unit: 'u5', ask: 'On a router: show only the static routes.', answers: ['show ip route static'] },
  { unit: 'u5', ask: 'On a router: show the hardware addresses it has resolved.', answers: ['show arp', 'show ip arp'] },
  { unit: 'u3', ask: 'On a router: confirm a DHCP client actually received a lease.', answers: ['show ip dhcp binding'] },
  { unit: 'u3', ask: 'On a router: list the IPv6 addresses on every interface.', answers: ['show ipv6 interface brief'] },
  { unit: 'x1', ask: 'Show the configuration the device is running right now.', answers: ['show running-config'] },
  { unit: 'x1', ask: 'Show the configuration the device will use after a reload.', answers: ['show startup-config'] },
  { unit: 'x1', ask: 'Save the running configuration so it survives a power cut.', answers: ['copy running-config startup-config', 'write memory', 'write'] },

  // --- exact syntax --------------------------------------------------------
  { unit: 'u3', ask: 'Give the interface you are in the address 192.168.10.1 with a /24 mask.', answers: ['ip address 192.168.10.1 255.255.255.0'] },
  { unit: 'u3', ask: 'Bring the interface you are in out of administrative shutdown.', answers: ['no shutdown'] },
  { unit: 'u5', ask: 'Add a static route to 192.168.20.0/24 via 10.0.0.2.', answers: ['ip route 192.168.20.0 255.255.255.0 10.0.0.2'] },
  { unit: 'u5', ask: 'Add a default route via 10.0.0.2.', answers: ['ip route 0.0.0.0 0.0.0.0 10.0.0.2'] },
  { unit: 'u3', ask: 'Stop DHCP from handing out 192.168.10.1 through 192.168.10.9.', answers: ['ip dhcp excluded-address 192.168.10.1 192.168.10.9'] },
  { unit: 'u3', ask: 'Create a DHCP pool called LAN10.', answers: ['ip dhcp pool LAN10'] },
  { unit: 'u3', ask: 'Inside a DHCP pool: hand clients the gateway 192.168.10.1.', answers: ['default-router 192.168.10.1'] },
  { unit: 'u3', ask: 'Turn on IPv6 routing globally.', answers: ['ipv6 unicast-routing'] },
  { unit: 'u3', ask: 'Give the interface you are in the IPv6 address 2001:db8:acad:1::1/64.', answers: ['ipv6 address 2001:db8:acad:1::1/64'] },
  { unit: 'x1', ask: 'Set the privileged EXEC secret to class.', answers: ['enable secret class'] },
  { unit: 'x1', ask: 'Name this device WCTA-R1.', answers: ['hostname WCTA-R1'] },
  { unit: 'u1', ask: 'Get from user EXEC to privileged EXEC.', answers: ['enable'] },
  { unit: 'u1', ask: 'Get from privileged EXEC into global configuration mode.', answers: ['configure terminal'] },
  { unit: 'u1', ask: 'Leave any configuration mode and go straight to privileged EXEC.', answers: ['end'] },
  { unit: 'u4', ask: 'Wipe the dynamically learned entries from a switch MAC address table.', answers: ['clear mac address-table dynamic'] },

  // --- VLANs and trunking --------------------------------------------------
  { unit: 'v1', ask: 'On a switch: list every VLAN and which ports are in it.', answers: ['show vlan brief', 'show vlan'] },
  { unit: 'v1', ask: 'Create VLAN 30.', answers: ['vlan 30'] },
  { unit: 'v1', ask: 'Inside VLAN configuration: name this VLAN STUDENT.', answers: ['name STUDENT'] },
  { unit: 'v1', ask: 'Put the interface you are in into VLAN 20 as an access port, in one command.', answers: ['switchport access vlan 20'] },
  { unit: 'v1', ask: 'Force the interface you are in to be an access port, never a trunk.', answers: ['switchport mode access'] },
  { unit: 'v1', ask: 'Force the interface you are in to be a trunk.', answers: ['switchport mode trunk'] },
  { unit: 'v1', ask: 'Move the native VLAN on this trunk to 99.', answers: ['switchport trunk native vlan 99'] },
  { unit: 'v1', ask: 'Allow only VLANs 10, 20 and 99 across this trunk.', answers: ['switchport trunk allowed vlan 10,20,99'] },
  { unit: 'v1', ask: 'On a switch: show every trunk, its native VLAN and its allowed list.', answers: ['show interfaces trunk'] },
  { unit: 'v2', ask: 'On a router subinterface: tag it for VLAN 10.', answers: ['encapsulation dot1Q 10'] },
  { unit: 'v2', ask: 'On a layer 3 switch: create the interface that acts as the gateway for VLAN 20.', answers: ['interface vlan 20'] },
  { unit: 'v2', ask: 'On a layer 3 switch: turn on routing between its VLANs.', answers: ['ip routing'] },
  { unit: 'v2', ask: 'On a layer 3 switch: turn this port into a routed port instead of a switchport.', answers: ['no switchport'] },

  // --- spanning tree -------------------------------------------------------
  { unit: 's1', ask: 'Show the spanning tree topology, root bridge and port roles.', answers: ['show spanning-tree'] },
  { unit: 's1', ask: 'Make this switch the root bridge for VLAN 1, using the priority value root primary sets.', answers: ['spanning-tree vlan 1 priority 24576'] },
  { unit: 's1', ask: 'Make this switch the root for VLAN 10 without doing the arithmetic yourself.', answers: ['spanning-tree vlan 10 root primary'] },
  { unit: 's1', ask: 'On an access port with a PC on it: skip the listening and learning delay.', answers: ['spanning-tree portfast'] },
  { unit: 's1', ask: 'Shut a port down if a switch is plugged into it and starts sending BPDUs.', answers: ['spanning-tree bpduguard enable'] },

  // --- OSPF ----------------------------------------------------------------
  { unit: 'o1', ask: 'Start OSPF process 1.', answers: ['router ospf 1'] },
  { unit: 'o1', ask: 'Inside OSPF: set the router ID to 1.1.1.1.', answers: ['router-id 1.1.1.1'] },
  { unit: 'o1', ask: 'Inside OSPF: advertise 192.168.10.0/24 into area 0.', answers: ['network 192.168.10.0 0.0.0.255 area 0'] },
  { unit: 'o1', ask: 'Inside OSPF: advertise the /30 link 10.0.0.0 into area 0.', answers: ['network 10.0.0.0 0.0.0.3 area 0'] },
  { unit: 'o1', ask: 'Stop OSPF sending hellos out of Gi0/0 while still advertising that network.', answers: ['passive-interface GigabitEthernet0/0', 'passive-interface g0/0'] },
  { unit: 'o1', ask: 'Show which OSPF neighbours this router has, and their state.', answers: ['show ip ospf neighbor'] },
  { unit: 'o1', ask: 'Show only the routes this router learned through OSPF.', answers: ['show ip route ospf'] },
  { unit: 'o1', ask: 'Show which networks this router is advertising and what it has heard from.', answers: ['show ip protocols'] }
];

const ROUND_SIZE = 10;

/** Accept the abbreviations IOS accepts: every word a prefix of the real one. */
function matches(given, answer) {
  const g = given.trim().toLowerCase().replace(/\s+/g, ' ');
  const a = answer.trim().toLowerCase().replace(/\s+/g, ' ');
  if (g === a) return true;
  const gw = g.split(' '), aw = a.split(' ');
  if (gw.length !== aw.length) return false;
  return gw.every((w, i) => {
    // Literal arguments (addresses, names) must match exactly.
    if (/[0-9.:/]/.test(aw[i]) || /[A-Z]/.test(answer.split(' ')[i] || '')) return w === aw[i];
    return aw[i].startsWith(w) && w.length >= 2;
  });
}

export function startDrill(root) {
  const wrap = document.createElement('div');
  wrap.className = 'cli-wrap';
  root.append(wrap);

  let questions = [];
  let index = 0, correct = 0, startedAt = 0, timerId = null;

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function intro() {
    wrap.innerHTML = `
      <div class="lede">
        <h1>Command drill</h1>
        <p>Ten prompts. Read the symptom or the goal, type the command. Abbreviations
           count, exactly as they do on a real device — <code>sh ip int br</code> is a
           correct answer.</p>
        <p>The clock starts on your first question and stops on your last. Nothing
           is saved — the round tells you how it went and that is the end of it.</p>
      </div>
      <button class="primary" id="start" type="button">Start</button>`;
    wrap.querySelector('#start').addEventListener('click', begin);
  }

  function begin() {
    questions = shuffle(BANK).slice(0, ROUND_SIZE);
    index = 0; correct = 0; startedAt = Date.now();
    render();
    timerId = setInterval(() => {
      const c = wrap.querySelector('#dclock');
      if (c) c.textContent = fmt(Math.round((Date.now() - startedAt) / 1000));
    }, 500);
  }

  function render() {
    const q = questions[index];
    wrap.innerHTML = `
      <div class="lede">
        <p style="font-family:var(--mono);color:var(--ink-faint)">
          Question ${index + 1} of ${ROUND_SIZE} · ${correct} correct · <span id="dclock">0:00</span>
        </p>
        <h1 style="font-size:22px">${q.ask}</h1>
      </div>
      <div class="term-input" style="max-width:640px;border:1px solid var(--line-2);border-radius:8px;padding:10px 12px;background:var(--bg-2)">
        <span class="prompt">#</span>
        <input type="text" id="dans" spellcheck="false" autocomplete="off"
               autocapitalize="off" aria-label="Your command" />
      </div>
      <p id="dfeed" class="brief" style="min-height:2.4em;margin-top:12px"></p>
      <button id="dskip" type="button">Skip</button>`;

    const input = wrap.querySelector('#dans');
    input.focus();
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      answer(input.value);
    });
    wrap.querySelector('#dskip').addEventListener('click', () => answer(''));
  }

  function answer(value) {
    const q = questions[index];
    const good = q.answers.some(a => q.prefix
      ? value.trim().toLowerCase().startsWith(a)
      : matches(value, a));
    const feed = wrap.querySelector('#dfeed');
    if (good) correct++;
    feed.innerHTML = good
      ? `<span style="color:var(--good)">Correct.</span>`
      : `<span style="color:var(--bad)">Not quite.</span> The answer is <code>${q.answers[0]}</code>.`;
    wrap.querySelector('#dans').disabled = true;

    setTimeout(() => {
      index++;
      if (index >= questions.length) finish();
      else render();
    }, good ? 500 : 1900);
  }

  function finish() {
    clearInterval(timerId);
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    wrap.innerHTML = `
      <div class="lede">
        <h1>${correct} of ${ROUND_SIZE} in ${fmt(seconds)}</h1>
        <p>${correct === ROUND_SIZE ? 'Clean round.' : correct >= 7 ? 'Solid. Run it again and close the gap.' : 'Worth another pass — check the cheat sheets for the ones you missed.'}</p>
      </div>
      <button class="primary" id="again" type="button">Run it again</button>`;
    wrap.querySelector('#again').addEventListener('click', begin);
  }

  function fmt(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

  intro();
}
