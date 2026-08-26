/* ══════════════════════════════════════════════════════════════
   hub.js: shared renderers. Pure functions from data to HTML strings,
   so every page stays a thin template. Depends on cs-core.js (window.PT).
══════════════════════════════════════════════════════════════ */
(function () {
'use strict';
const { esc, rel, STEPS } = window.PT;

// strand id → the hue token that carries it
const HUE = { A: 'u1', B: 'u2', C: 'u3', D: 'u4', E: 'u5' };
const hueVar = (strand) => 'var(--' + (HUE[strand] || 'primary') + ')';

// Which round does this module first appear in?
function firstRound(d, n) {
  for (const id of d.rounds.order) {
    if (d.rounds.rounds[id].modules.includes(n)) return d.rounds.rounds[id];
  }
  return null;
}

// ── module card ───────────────────────────────────────────────────────
function moduleCard(d, m, scope) {
  const unit = d.units.units[m.unit];
  const inScope = scope.has(m.n);
  const prog = window.PT.progress(m.n);
  const dots = STEPS.map(s =>
    '<span class="mod-dot' + (prog[s] ? ' on' : '') + '" title="' + s + '"></span>').join('');
  const fr = firstRound(d, m.n);
  return '' +
    '<a class="mod-card' + (inScope ? '' : ' out') + '" style="--hue:' + hueVar(m.strand) + '"' +
      ' href="' + rel('module/?m=' + m.n) + '">' +
      '<div class="mod-top">' +
        '<span class="mod-n">MODULE ' + m.n + '</span>' +
        '<span class="pill ' + (inScope ? 'pill-hue' : 'pill-mute') + '" style="--hue:' + hueVar(m.strand) + '">' +
          (inScope ? esc(unit.id.toUpperCase()) : 'NOT YET') + '</span>' +
      '</div>' +
      '<div class="mod-title">' + esc(m.title) + '</div>' +
      '<div class="mod-sum">' + esc(m.summary) + '</div>' +
      '<div class="mod-foot">' +
        '<span class="mod-prog" aria-label="' + STEPS.filter(s => prog[s]).length + ' of 6 steps done">' + dots + '</span>' +
        '<span class="res-meta" style="margin:0">' +
          (inScope ? esc(unit.title) : 'unlocks at ' + esc(fr ? fr.short : '?')) + '</span>' +
      '</div>' +
    '</a>';
}

// ── unit chip ─────────────────────────────────────────────────────────
function unitChip(d, u, scope) {
  const covered = u.modules.length ? u.modules.every(n => scope.has(n)) : false;
  return '' +
    '<a class="unit-chip' + (covered ? '' : ' out') + '" style="--hue:' + hueVar(u.primary) + '"' +
      ' href="' + rel('unit/?u=' + u.id) + '">' +
      '<span class="unit-id">' + u.id.toUpperCase() + (covered ? ' · REQUIRED' : '') + '</span>' +
      '<span class="unit-name">' + esc(u.title) + '</span>' +
      '<span class="unit-mods">' + (u.modules.length ? esc(window.PT.fmtRange(u.modules)) : 'All modules') + '</span>' +
    '</a>';
}

// ── resource card (app / lab / quiz / sheet) ──────────────────────────
const ICON = { cli: '❯', apps: '▶', labs: '⌗', quizzes: '✓', sheets: '▤' };
function resourceCard(d, slug, hue) {
  const r = d.resBySlug[slug];
  if (!r) return '';
  const ready = r.status === 'done' && r.url;
  const tag = ready ? 'a' : 'div';
  const href = ready ? ' href="' + esc(r.url) + '"' : '';
  return '' +
    '<' + tag + ' class="res-card" style="--hue:' + (hue || 'var(--primary)') + '"' + href + '>' +
      '<span class="res-icon" aria-hidden="true">' + (ICON[r.kind] || '·') + '</span>' +
      '<span class="res-main">' +
        '<span class="res-title">' + esc(r.name) + '</span>' +
        '<span class="res-desc">' + esc(r.desc) + '</span>' +
        '<span class="res-meta">' + esc(r.slug) + ' · ' + esc(r.priority) +
          (ready ? '' : ' · <b>NOT BUILT YET</b>') + '</span>' +
      '</span>' +
    '</' + tag + '>';
}

// ── video card ────────────────────────────────────────────────────────
function videoCard(v) {
  let href = v.url;
  if (v.start && /youtube\.com\/watch/.test(href)) href += '&t=' + v.start + 's';
  else if (v.start && /youtu\.be\//.test(href)) href += '?t=' + v.start;
  const meta = [v.channel, v.minutes ? v.minutes + ' min' : null].filter(Boolean).join(' · ');
  return '' +
    '<a class="res-card" style="--hue:var(--u3)" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      '<span class="res-icon" aria-hidden="true">▶</span>' +
      '<span class="res-main">' +
        '<span class="res-title">' + esc(v.title) + (v.mine ? ' <span class="badge" style="background:var(--primary-soft);color:var(--primary)">OURS</span>' : '') + '</span>' +
        (v.note ? '<span class="res-desc">' + esc(v.note) + '</span>' : '') +
        (meta ? '<span class="res-meta">' + esc(meta) + '</span>' : '') +
      '</span>' +
    '</a>';
}

// ── readiness ring ────────────────────────────────────────────────────
function ring(pct, caption) {
  const R = 56, C = 2 * Math.PI * R;
  const off = C * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return '' +
    '<div class="ring-box">' +
      '<svg class="ring" viewBox="0 0 132 132" role="img" aria-label="' + pct + ' percent ready">' +
        '<circle class="ring-track" cx="66" cy="66" r="' + R + '"></circle>' +
        '<circle class="ring-fill" cx="66" cy="66" r="' + R + '" stroke-dasharray="' + C.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"></circle>' +
      '</svg>' +
      '<div class="ring-num">' +
        '<div class="ring-pct">' + pct + '%</div>' +
        '<div class="ring-cap">' + esc(caption || 'ready') + '</div>' +
      '</div>' +
    '</div>';
}

// ── empty slot ────────────────────────────────────────────────────────
function empty(title, msg) {
  return '<div class="empty"><b>' + esc(title) + '</b>' + esc(msg) + '</div>';
}

// ── error banner ──────────────────────────────────────────────────────
function fail(err) {
  return '<div class="note" style="--hue:var(--danger)">' +
    '<span class="note-label">Could not load the curriculum data</span>' +
    esc(err && err.message ? err.message : String(err)) +
    '. If you opened this file directly from disk, the browser blocks the JSON fetch. ' +
    'Run <code>python3 -m http.server</code> from the repo root instead.</div>';
}

window.HUB = { HUE, hueVar, firstRound, moduleCard, unitChip, resourceCard, videoCard, ring, empty, fail };
})();
