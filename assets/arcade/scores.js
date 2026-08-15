/* =====================================================================
   WCTA ARCADE — high scores

   Two tiers behind one interface:

     remote   a shared board, so a score set in third period is still there
              at lunch and on someone else's laptop
     local    a per-browser top ten, used when the API is unreachable

   The fallback is deliberately visible rather than silent: a board that
   quietly shows only your own scores while claiming to be global is worse
   than one that admits it is offline.
   ===================================================================== */
(function (root) {
  "use strict";

  var NS = root.WCTAArcade = root.WCTAArcade || {};

  // Set to the deployed API origin to turn the shared board on. Left empty,
  // everything below still works — it just stays local to this browser.
  var API = "";

  var LOCAL_KEY = "wcta.arcade.scores";
  var LIMIT = 10;

  function readLocal() {
    try {
      var raw = localStorage.getItem(LOCAL_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function writeLocal(list) {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(list.slice(0, LIMIT))); }
    catch (e) { /* storage blocked; the session board still works */ }
  }

  function insertLocal(entry) {
    var list = readLocal();
    list.push(entry);
    list.sort(function (a, b) { return b.score - a.score; });
    list = list.slice(0, LIMIT);
    writeLocal(list);
    return list;
  }

  function timeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; reject(new Error("timeout")); } }, ms);
      promise.then(
        function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } }
      );
    });
  }

  // The run token is fetched when a game starts and spent on submit. It is
  // what lets the server refuse a score that arrived faster than the game
  // could have produced it, and refuse the same run twice.
  var runToken = null;

  var Scores = {
    beginRun: function () {
      runToken = null;
      if (!API) return Promise.resolve(null);
      return timeout(fetch(API + "/api/token")
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { runToken = (d && d.token) || null; return runToken; }), 4000)
        .catch(function () { return null; });   // board just falls back to local
    },

    // Resolves to { entries, source } where source is "remote" or "local".
    top: function () {
      if (!API) return Promise.resolve({ entries: readLocal(), source: "local" });
      return timeout(fetch(API + "/api/scores", { method: "GET" })
        .then(function (r) {
          if (!r.ok) throw new Error("http " + r.status);
          return r.json();
        })
        .then(function (data) {
          return { entries: (data && data.entries) || [], source: "remote" };
        }), 4000)
        .catch(function () { return { entries: readLocal(), source: "local" }; });
    },

    submit: function (entry) {
      insertLocal(entry);                  // always keep a local copy
      if (!API) return Promise.resolve({ source: "local" });
      var payload = {
        initials: entry.initials,
        score: entry.score,
        level: entry.level,
        token: runToken
      };
      return timeout(fetch(API + "/api/scores", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return { source: "remote" };
      }), 4000).catch(function () { return { source: "local" }; });
    },

    qualifies: function (score) {
      if (score <= 0) return false;
      var list = readLocal();
      return list.length < LIMIT || score > list[list.length - 1].score;
    },

    setEndpoint: function (url) { API = url || ""; }
  };

  /* ---------------------------------------------------------------------
     Panel UI — rendered into the overlay above the canvas
     --------------------------------------------------------------------- */
  function rowsHtml(entries, highlight) {
    if (!entries.length)
      return '<div class="wa-sc-empty">no scores yet. be first.</div>';
    return entries.map(function (e, i) {
      var me = highlight && e.initials === highlight.initials &&
        e.score === highlight.score ? " wa-sc-me" : "";
      return '<div class="wa-sc-row' + me + '">' +
        '<span class="wa-sc-rank">' + String(i + 1).padStart(2, "0") + '</span>' +
        '<span class="wa-sc-who">' + esc(e.initials) + '</span>' +
        '<span class="wa-sc-lv">L' + String(e.level || 1).padStart(2, "0") + '</span>' +
        '<span class="wa-sc-pts">' + String(e.score).padStart(6, "0") + '</span>' +
        '</div>';
    }).join("");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function shell(title, body, source) {
    return '<div class="wa-sc">' +
      '<div class="wa-sc-hd">' + title +
      (source ? '<span class="wa-sc-src' + (source === "local" ? " off" : "") + '">' +
        (source === "local" ? "LOCAL // OFFLINE" : "GLOBAL") + '</span>' : "") +
      '</div>' + body + '</div>';
  }

  function hide(panel) {
    panel.classList.remove("on");
    panel.innerHTML = "";
  }

  // Resolves once the board is on screen, with the action button, so callers
  // can relabel or rebind it without racing the fetch.
  Scores.showBoard = function (panel, highlight, label, onClick) {
    panel.innerHTML = shell("HIGH SCORES", '<div class="wa-sc-empty">loading…</div>', null);
    panel.classList.add("on");
    return Scores.top().then(function (res) {
      panel.innerHTML = shell("HIGH SCORES", rowsHtml(res.entries, highlight), res.source) +
        '<button class="wa-btn wa-sc-close">' + esc(label || "Back") + '</button>';
      var btn = panel.querySelector(".wa-sc-close");
      btn.addEventListener("click", function () {
        hide(panel);
        if (onClick) onClick();
      });
      btn.focus();
      return btn;
    });
  };

  /* Arcade initials entry: three slots, W/S to change a letter, A/D to move,
     Enter to confirm. Typing a letter also works, because making someone
     scroll through the alphabet on a keyboard is nostalgia at the player's
     expense. */
  Scores.gameOver = function (panel, score, level, onDone) {
    if (!Scores.qualifies(score)) {
      panel.innerHTML = shell("GAME OVER",
        '<div class="wa-sc-final">' + String(score).padStart(6, "0") + '</div>' +
        '<div class="wa-sc-empty">no place on the board this time.</div>', null) +
        '<button class="wa-btn wa-sc-close">Play again</button>';
      panel.classList.add("on");
      panel.querySelector(".wa-sc-close").addEventListener("click", function () {
        hide(panel); onDone();
      });
      panel.querySelector(".wa-sc-close").focus();
      return;
    }

    var CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    var slots = [0, 0, 0];
    var pos = 0;

    panel.classList.add("on");
    draw();

    function initials() {
      return slots.map(function (i) { return CHARS[i]; }).join("");
    }

    function draw() {
      panel.innerHTML = shell("NEW HIGH SCORE",
        '<div class="wa-sc-final">' + String(score).padStart(6, "0") +
        '<span class="wa-sc-lv"> L' + String(level).padStart(2, "0") + '</span></div>' +
        '<div class="wa-sc-entry">' +
        slots.map(function (i, n) {
          return '<span class="wa-sc-slot' + (n === pos ? " on" : "") + '">' +
            CHARS[i] + '</span>';
        }).join("") +
        '</div>' +
        '<div class="wa-sc-hint">W / S letter &nbsp; A / D move &nbsp; ENTER save</div>',
        null);
    }

    function key(e) {
      var k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (k === "W" || k === "ArrowUp") { slots[pos] = (slots[pos] + 1) % CHARS.length; }
      else if (k === "S" || k === "ArrowDown") { slots[pos] = (slots[pos] + CHARS.length - 1) % CHARS.length; }
      else if (k === "A" || k === "ArrowLeft") { pos = (pos + 2) % 3; }
      else if (k === "D" || k === "ArrowRight") { pos = (pos + 1) % 3; }
      else if (k === "Enter") { return finish(); }
      else if (CHARS.indexOf(k) >= 0) {
        slots[pos] = CHARS.indexOf(k);
        pos = Math.min(2, pos + 1);
      } else return;
      e.preventDefault();
      e.stopPropagation();
      draw();
    }

    // Capture phase, so the running game's own key handler never sees these.
    document.addEventListener("keydown", key, true);

    function finish() {
      document.removeEventListener("keydown", key, true);
      var entry = { initials: initials(), score: score, level: level, at: Date.now() };
      panel.innerHTML = shell("SAVING", '<div class="wa-sc-empty">…</div>', null);
      Scores.submit(entry).then(function () {
        Scores.showBoard(panel, entry, "Play again", onDone);
      });
    }
  };

  NS.Scores = Scores;
})(typeof self !== "undefined" ? self : this);
