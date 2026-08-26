// inspector.js — replay the last packet hop by hop.
//
// This is the U4 mastery gate made visible: the L3 addresses hold still while
// the L2 addresses are rewritten at every hop. The table colours the two
// differently on purpose.

import { getDevice, getIface } from '../engine/net.js';

/** Which device does a MAC belong to? Students are asked this, not for the hex. */
function ownerOf(net, mac) {
  const want = mac.toLowerCase().replace(/[.:-]/g, '');
  for (const dev of net.devices) {
    for (const i of dev.ifaces) {
      if (i.mac.toLowerCase().replace(/[.:-]/g, '') === want) return `${dev.hostname}:${i.name}`;
    }
  }
  return null;
}

export function renderInspector(container, net, trace) {
  container.replaceChildren();

  if (!trace || !trace.hops || !trace.hops.length) {
    const p = document.createElement('p');
    p.className = 'brief';
    p.textContent = trace && (trace.loopback || trace.self)
      ? 'That ping never left the host, so there is nothing to inspect. Ping something across the network.'
      : 'Send a ping, then come back here to walk it hop by hop.';
    container.append(p);
    return;
  }

  const wrap = document.createElement('div');
  wrap.className = 'scrollx';
  const table = document.createElement('table');
  table.innerHTML = `<thead><tr>
      <th>Hop</th><th>Leaves</th><th>Source MAC</th><th>Dest MAC</th>
      <th>Source IP</th><th>Dest IP</th><th>TTL</th>
    </tr></thead>`;
  const tbody = document.createElement('tbody');

  trace.hops.forEach((h, i) => {
    const tr = document.createElement('tr');
    const srcOwner = ownerOf(net, h.srcMac);
    const dstOwner = ownerOf(net, h.dstMac);
    const cell = (text, cls, title) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      td.textContent = text;
      if (title) td.title = title;
      return td;
    };
    tr.append(
      cell(String(i + 1)),
      cell(`${h.hostname} ${shortIf(h.outIface)}`),
      cell(srcOwner || h.srcMac, 'changed', h.srcMac),
      cell(dstOwner || h.dstMac, 'changed', h.dstMac),
      cell(h.srcIp, 'same'),
      cell(h.dstIp, 'same'),
      cell(String(h.ttl))
    );
    tbody.append(tr);
  });

  table.append(tbody);
  wrap.append(table);

  const legend = document.createElement('p');
  legend.className = 'legend';
  legend.innerHTML = '<b class="changed">Layer 2</b> is rewritten at every hop — it names the next device on this wire. ' +
                     '<b class="same">Layer 3</b> is the same from first hop to last — it names the endpoints. ' +
                     'Hover a MAC column to see the raw address.';

  container.append(wrap, legend);

  if (trace.returnHops && trace.returnHops.length) {
    const d = document.createElement('details');
    d.className = 'cli-fold';
    d.innerHTML = '<summary>Return path</summary>';
    const body = document.createElement('div');
    body.className = 'body';
    renderInspector(body, net, { hops: trace.returnHops });
    d.append(body);
    container.append(d);
  }

  if (trace.noReturnPath) {
    const warn = document.createElement('p');
    warn.className = 'legend';
    warn.innerHTML = '<b style="color:var(--bad)">The request arrived and the reply could not get home.</b> ' +
                     'On the sending host this looks identical to a packet that never left.';
    container.append(warn);
  }
}

function shortIf(name) {
  return String(name)
    .replace(/^GigabitEthernet/, 'G')
    .replace(/^FastEthernet/, 'F')
    .replace(/^Serial/, 'S');
}

/* ---------------------------------------------------- fill-in answers --- */

/**
 * Labs with `answer` objectives (the U4 gate) get a small form under the
 * inspector. Values are graded, not the typing.
 */
export function renderAnswers(container, lab, ctx, onChange) {
  container.replaceChildren();
  const answerTasks = (lab.tasks || []).filter(t =>
    (t.checks || (t.check ? [t.check] : [])).some(c => c.type === 'answer'));
  if (!answerTasks.length) return;

  const h = document.createElement('p');
  h.className = 'legend';
  h.textContent = 'Read the table above, then answer. Device names like R1:GigabitEthernet0/1 are accepted, and so are raw MAC addresses.';
  container.append(h);

  const form = document.createElement('div');
  form.className = 'answers';

  for (const task of answerTasks) {
    const check = (task.checks || [task.check]).find(c => c.type === 'answer');
    const label = document.createElement('label');
    label.textContent = task.text;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = ctx.answers[check.id] ?? '';
    input.setAttribute('aria-label', task.text);
    input.addEventListener('input', () => {
      ctx.answers[check.id] = input.value;
      onChange();
    });
    label.append(input);
    form.append(label);
  }
  container.append(form);
}
