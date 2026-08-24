/* ══════════════════════════════════════════════════════════════
   cs-core.js: shared runtime for the packet curriculum hub.

   Three jobs:
     1. The CyberSpesh theme controller, byte-compatible with the drill
        apps. Same `cs_theme` key, so a student's theme follows them from
        the hub into every app and back.
     2. Local student profiles and progress, under `pt_*` keys.
     3. The site chrome (topbar + round selector) and the data loader, so
        every page is a template rather than a copy.

   No frameworks, no build step, no network calls beyond the JSON in data/.
══════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// ── where are we ──────────────────────────────────────────────────────
// Derive the site root from this script's own URL so pages nest freely.
const SELF = document.currentScript ? document.currentScript.src : '';
const ROOT = SELF ? SELF.replace(/assets\/cs-core\.js.*$/, '') : './';
const rel = (p) => ROOT + p;

// ── storage, defensively ──────────────────────────────────────────────
// Private windows, locked-down school profiles, and quota errors all throw.
// Everything degrades to "works, just doesn't remember".
const store = {
  get(k, fallback) {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { return false; }
  },
  raw(k, fallback) { try { return localStorage.getItem(k) ?? fallback; } catch (e) { return fallback; } },
  rawSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

// ── theme ─────────────────────────────────────────────────────────────
const CS_THEMES = ['matrix', 'arctic', 'crimson', 'tokyo', 'galaxy'];
const THEME_NAMES = { matrix: 'Matrix', arctic: 'Arctic', crimson: 'Crimson Ops', tokyo: 'Tokyo', galaxy: 'Galaxy' };

function csSetTheme(name, persist) {
  if (!CS_THEMES.includes(name)) name = 'matrix';
  document.body.classList.remove.apply(document.body.classList, CS_THEMES);
  document.body.classList.add(name);
  document.querySelectorAll('.theme-btn').forEach(b => {
    const on = b.dataset.theme === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if (window.csRefreshRainPalette) window.csRefreshRainPalette();
  if (persist !== false) store.rawSet('cs_theme', name);
}
window.csSetTheme = csSetTheme;

// ── matrix rain ───────────────────────────────────────────────────────
function initRain() {
  const canvas = document.getElementById('matrix-rain');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF<>{}[]|/\\';
  let cols, drops;
  function resize() {
    canvas.width = window.innerWidth; canvas.height = window.innerHeight;
    cols = Math.floor(canvas.width / 16);
    drops = Array.from({ length: cols }, () => Math.random() * -50);
  }
  resize();
  window.addEventListener('resize', resize);
  let PAL = { bg: '#05070a', primary: '#35d67d', bright: '#eafff2' };
  window.csRefreshRainPalette = function () {
    const cs = getComputedStyle(document.body);
    PAL = {
      bg: cs.getPropertyValue('--bg').trim() || PAL.bg,
      primary: cs.getPropertyValue('--primary').trim() || PAL.primary,
      bright: cs.getPropertyValue('--text-bright').trim() || PAL.bright
    };
  };
  window.csRefreshRainPalette();
  function draw() {
    ctx.globalAlpha = 0.18; ctx.fillStyle = PAL.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = 1; ctx.font = '13px JetBrains Mono, monospace';
    drops.forEach((y, i) => {
      const ch = CHARS[Math.floor(Math.random() * CHARS.length)];
      ctx.fillStyle = Math.random() > 0.96 ? PAL.bright : PAL.primary;
      ctx.fillText(ch, i * 16, y * 16);
      if (y * 16 > canvas.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 0.5 + Math.random() * 0.5;
    });
  }
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) setInterval(draw, 50);
}

// ── data ──────────────────────────────────────────────────────────────
let _data = null;
async function data() {
  if (_data) return _data;
  const names = ['rounds', 'units', 'modules', 'resources', 'videos', 'links'];
  const parts = await Promise.all(
    names.map(n => fetch(rel('data/' + n + '.json')).then(r => {
      if (!r.ok) throw new Error(n + '.json → HTTP ' + r.status);
      return r.json();
    }))
  );
  _data = {};
  names.forEach((n, i) => { _data[n] = parts[i]; });
  // convenience indexes
  _data.moduleByN = {};
  _data.modules.modules.forEach(m => { _data.moduleByN[m.n] = m; });
  _data.resBySlug = {};
  Object.entries(_data.resources).forEach(([kind, items]) => {
    if (kind.startsWith('_')) return;
    items.forEach(it => { _data.resBySlug[it.slug] = Object.assign({ kind }, it); });
  });
  return _data;
}

// ── round selection ───────────────────────────────────────────────────
const ROUND_KEY = 'pt_round';
function round() { return store.raw(ROUND_KEY, 'r1'); }
function setRound(id) {
  store.rawSet(ROUND_KEY, id);
  document.querySelectorAll('.round-btn').forEach(b => {
    const on = b.dataset.round === id;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  window.dispatchEvent(new CustomEvent('pt:round', { detail: { round: id } }));
}
// `all` is a pseudo-round: everything visible, nothing dimmed.
function scopeOf(d, id) {
  if (id === 'all') return new Set(d.modules.modules.map(m => m.n));
  const r = d.rounds.rounds[id];
  return new Set(r ? r.modules : []);
}

// ── profiles ──────────────────────────────────────────────────────────
const STEPS = ['read', 'watch', 'drill', 'lab', 'check', 'recall'];
function profiles() { return store.get('pt_profiles', []); }
function active() {
  const id = store.raw('pt_active', null);
  const list = profiles();
  return list.find(p => p.id === id) || list[0] || null;
}
function addProfile(handle) {
  handle = String(handle || '').trim().slice(0, 24);
  if (!handle) return null;
  const list = profiles();
  const existing = list.find(p => p.handle.toLowerCase() === handle.toLowerCase());
  if (existing) { setActive(existing.id); return existing; }
  const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), handle, created: Date.now() };
  list.push(p);
  store.set('pt_profiles', list);
  setActive(p.id);
  return p;
}
function setActive(id) {
  store.rawSet('pt_active', id);
  window.dispatchEvent(new CustomEvent('pt:profile', { detail: { id } }));
}
function removeProfile(id) {
  store.set('pt_profiles', profiles().filter(p => p.id !== id));
  try {
    localStorage.removeItem('pt_progress_' + id);
    localStorage.removeItem('pt_bests_' + id);
    localStorage.removeItem('pt_gates_' + id);
  } catch (e) {}
  if (store.raw('pt_active', null) === id) {
    const first = profiles()[0];
    if (first) setActive(first.id); else store.rawSet('pt_active', '');
  }
}

// ── progress ──────────────────────────────────────────────────────────
function progressOf(pid) { return store.get('pt_progress_' + pid, {}); }
function progress(n) {
  const p = active(); if (!p) return {};
  return progressOf(p.id)['m' + n] || {};
}
function toggle(n, step) {
  const p = active(); if (!p) return false;
  if (!STEPS.includes(step)) return false;
  const all = progressOf(p.id);
  const key = 'm' + n;
  all[key] = all[key] || {};
  all[key][step] = !all[key][step];
  store.set('pt_progress_' + p.id, all);
  window.dispatchEvent(new CustomEvent('pt:progress', { detail: { module: n, step } }));
  return all[key][step];
}

// Readiness = checked steps / (modules in scope × 6), counting only steps
// that have something behind them. A module with no lab yet cannot cost you.
function readiness(d, roundId, pid) {
  const p = pid ? { id: pid } : active();
  const scope = scopeOf(d, roundId || round());
  if (!p) return { done: 0, total: scope.size * STEPS.length, pct: 0 };
  const all = progressOf(p.id);
  let done = 0;
  scope.forEach(n => {
    const rec = all['m' + n] || {};
    STEPS.forEach(s => { if (rec[s]) done++; });
  });
  const total = scope.size * STEPS.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

// ── drill bests + mastery gates (called by the apps) ──────────────────
// Apps call these through window.PT if it exists. Standalone, they no-op.
function recordBest(slug, seconds, meta) {
  const p = active(); if (!p || !slug) return false;
  const key = 'pt_bests_' + p.id;
  const all = store.get(key, {});
  const prev = all[slug];
  if (!prev || seconds < prev.seconds) {
    all[slug] = Object.assign({ seconds: Math.round(seconds), at: Date.now() }, meta || {});
    store.set(key, all);
    return true;   // it was a personal best
  }
  return false;
}
function bests(pid) {
  const p = pid ? { id: pid } : active();
  return p ? store.get('pt_bests_' + p.id, {}) : {};
}
function recordGate(unit, passed, seconds) {
  const p = active(); if (!p) return;
  const key = 'pt_gates_' + p.id;
  const all = store.get(key, {});
  all[unit] = { passed: !!passed, seconds: seconds || null, at: Date.now() };
  store.set(key, all);
}
function gates(pid) {
  const p = pid ? { id: pid } : active();
  return p ? store.get('pt_gates_' + p.id, {}) : {};
}

// ── export / import a profile as a paste-able code ────────────────────
function exportProfile(pid) {
  const p = pid ? profiles().find(x => x.id === pid) : active();
  if (!p) return '';
  const blob = { v: 1, h: p.handle, p: progressOf(p.id), b: bests(p.id), g: gates(p.id) };
  return btoa(unescape(encodeURIComponent(JSON.stringify(blob))));
}
function decodeProfile(code) {
  try {
    const o = JSON.parse(decodeURIComponent(escape(atob(String(code).trim()))));
    if (o && o.v === 1 && o.h) return o;
  } catch (e) {}
  return null;
}

// ── chrome ────────────────────────────────────────────────────────────
const NAV = [
  { href: '', label: 'Hub' },
  { href: 'videos/', label: 'Videos' },
  { href: 'scoreboard/', label: 'Scoreboard' },
  { href: 'resources/', label: 'Resources' },
  { href: 'coach/', label: 'Coach' }
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mountChrome(opts) {
  opts = opts || {};
  const host = document.getElementById('chrome');
  if (!host) return;
  const p = active();
  host.innerHTML =
    '<header class="topbar">' +
      '<a class="brand" href="' + rel('') + '">' +
        '<img class="brand-mark" src="' + rel('assets/brand-mark.png') + '" alt="West CTA Cybersecurity logo" width="38" height="38">' +
        '<div class="brand-text">' +
          '<div class="brand-title">Packet</div>' +
          '<div class="brand-sub">CYBERPATRIOT CISCO · WEST CTA CYBERSECURITY</div>' +
        '</div>' +
      '</a>' +
      '<nav class="topbar-nav" aria-label="Sections">' +
        NAV.map(n => '<a href="' + rel(n.href) + '"' + (opts.nav === n.label ? ' aria-current="page"' : '') + '>' + n.label + '</a>').join('') +
      '</nav>' +
      '<div class="topbar-sep"></div>' +
      '<button class="who" id="who-btn" aria-label="Switch student profile">' +
        '<span class="who-dot" aria-hidden="true"></span>' +
        '<span id="who-name">' + (p ? esc(p.handle) : 'WHO?') + '</span>' +
      '</button>' +
      '<div class="theme-switcher" role="group" aria-label="Colour theme">' +
        '<span class="theme-label">THEME</span>' +
        CS_THEMES.map(t => '<button class="theme-btn" data-theme="' + t + '" aria-pressed="false">' + THEME_NAMES[t] + '</button>').join('') +
      '</div>' +
    '</header>';

  csSetTheme(store.raw('cs_theme', 'matrix'), false);
  host.querySelectorAll('.theme-btn').forEach(b =>
    b.addEventListener('click', () => csSetTheme(b.dataset.theme)));
  const wb = document.getElementById('who-btn');
  if (wb) wb.addEventListener('click', openProfileDialog);
}

function mountRoundbar(d, onChange) {
  const host = document.getElementById('roundbar');
  if (!host) return;
  const cur = round();
  const items = d.rounds.order.concat(['all']);
  host.className = 'roundbar';
  host.innerHTML =
    '<div class="roundbar-inner wrap">' +
      '<span class="roundbar-label">Prepping for</span>' +
      '<div class="round-seg" role="group" aria-label="Competition round">' +
        items.map(id => {
          const r = id === 'all' ? { short: 'ALL 23' } : d.rounds.rounds[id];
          return '<button class="round-btn' + (id === cur ? ' active' : '') + '" data-round="' + id + '"' +
                 ' aria-pressed="' + (id === cur ? 'true' : 'false') + '">' + esc(r.short) + '</button>';
        }).join('') +
      '</div>' +
      '<span class="round-scope" id="round-scope"></span>' +
    '</div>';

  function paintScope() {
    const id = round();
    const el = document.getElementById('round-scope');
    if (!el) return;
    if (id === 'all') { el.innerHTML = '<b>All 23 modules</b> · nothing dimmed'; return; }
    const r = d.rounds.rounds[id];
    el.innerHTML = 'In scope: <b>' + esc(fmtRange(r.modules)) + '</b> · quiz: ' + esc(r.quiz) +
      (r.date ? ' · <b>' + esc(countdown(r.date)) + '</b>' : '');
  }
  host.querySelectorAll('.round-btn').forEach(b =>
    b.addEventListener('click', () => { setRound(b.dataset.round); paintScope(); if (onChange) onChange(b.dataset.round); }));
  paintScope();
}

function fmtRange(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const out = []; let i = 0;
  while (i < s.length) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? String(s[i]) : s[i] + '–' + s[j]);
    i = j + 1;
  }
  return 'Modules ' + out.join(', ');
}

function countdown(iso) {
  const then = new Date(iso + 'T00:00:00');
  const days = Math.ceil((then - Date.now()) / 86400000);
  if (isNaN(days)) return '';
  if (days < 0) return 'passed';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return days + ' days out';
}

// ── profile dialog ────────────────────────────────────────────────────
function openProfileDialog() {
  const list = profiles();
  const cur = active();
  const ov = document.createElement('div');
  ov.className = 'overlay open';
  ov.innerHTML =
    '<div class="overlay-card" role="dialog" aria-modal="true" aria-label="Student profile">' +
      '<div class="panel-title" style="margin-bottom:var(--sp-2)">Who\'s working?</div>' +
      '<p style="color:var(--text-2);font-size:var(--fs-sm);margin-bottom:var(--sp-4)">' +
        'Progress is saved in this browser only. On the team-room machine, pick your name each time.</p>' +
      (list.length ? '<div class="row-list" style="margin-bottom:var(--sp-4)">' + list.map(p =>
        '<button class="row-item' + (cur && p.id === cur.id ? ' active' : '') + '" data-pick="' + p.id + '">' +
          '<span style="flex:1"><span class="row-title">' + esc(p.handle) + '</span>' +
          '<span class="row-meta">since ' + new Date(p.created).toLocaleDateString() + '</span></span>' +
          '<span class="check" data-del="' + p.id + '" role="button" tabindex="0" aria-label="Remove ' + esc(p.handle) + '">REMOVE</span>' +
        '</button>').join('') + '</div>' : '') +
      '<div class="filter-bar" style="margin-bottom:var(--sp-3)">' +
        '<input type="text" id="new-handle" maxlength="24" placeholder="New name or initials" aria-label="New profile name">' +
        '<button class="btn" id="new-go">Add</button>' +
      '</div>' +
      '<button class="btn btn-ghost" id="prof-close" style="width:100%">Close</button>' +
    '</div>';
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) close(); });
  ov.querySelector('#prof-close').addEventListener('click', close);
  const input = ov.querySelector('#new-handle');
  const go = () => { if (addProfile(input.value)) location.reload(); };
  ov.querySelector('#new-go').addEventListener('click', go);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  ov.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', e => {
    if (e.target.closest('[data-del]')) return;
    setActive(b.dataset.pick); location.reload();
  }));
  ov.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    removeProfile(b.dataset.del); location.reload();
  }));
  input.focus();
}

// ── toast ─────────────────────────────────────────────────────────────
let toastEl = null, toastTimer = null;
function toast(msg) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  requestAnimationFrame(() => toastEl.classList.add('show'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2400);
}

// ── copy buttons (delegated, works on injected content) ───────────────
document.addEventListener('click', e => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const pre = btn.parentElement.querySelector('pre');
  if (!pre) return;
  const text = pre.innerText;
  const done = () => { btn.textContent = 'COPIED'; setTimeout(() => { btn.textContent = 'COPY'; }, 1400); };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(done).catch(fallback);
  else fallback();
  function fallback() {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); } catch (err) { toast('Copy failed. Select it by hand'); }
    ta.remove();
  }
});

// ── boot ──────────────────────────────────────────────────────────────
function boot() {
  if (!document.getElementById('matrix-rain')) {
    const c = document.createElement('canvas');
    c.id = 'matrix-rain'; c.setAttribute('aria-hidden', 'true');
    document.body.prepend(c);
  }
  if (!document.querySelector('.atmos')) {
    const a = document.createElement('div');
    a.className = 'atmos'; a.setAttribute('aria-hidden', 'true');
    document.body.prepend(a);
  }
  csSetTheme(store.raw('cs_theme', 'matrix'), false);
  initRain();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();

// ── public surface ────────────────────────────────────────────────────
window.PT = {
  ROOT, rel, esc, STEPS, CS_THEMES,
  data, round, setRound, scopeOf, fmtRange, countdown,
  profiles, active, addProfile, setActive, removeProfile, openProfileDialog,
  progress, progressOf, toggle, readiness,
  recordBest, bests, recordGate, gates,
  exportProfile, decodeProfile,
  mountChrome, mountRoundbar, toast, setTheme: csSetTheme
};

})();
