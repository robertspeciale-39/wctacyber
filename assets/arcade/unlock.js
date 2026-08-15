/* =====================================================================
   WCTA ARCADE — the gate

   This is the only arcade file the index page loads, and all it does is
   watch a footer glyph. Nothing else — no CSS, no engine, no maze data —
   is fetched until someone actually goes looking. The index page's hero
   already preloads 97 WebP frames; the easter egg has no business adding
   to that budget for the 99% of visitors who never find it.

   Flow:  [ ? ]  ->  terminal challenge  ->  solve  ->  load engine  ->  play
   ===================================================================== */
(function () {
  "use strict";

  var BASE = "assets/arcade/";
  var KEY = "wcta.arcade.unlocked";
  var loaded = false;
  var loading = false;

  // ---- storage is best-effort ------------------------------------------
  // Private-mode Safari throws on localStorage access rather than returning
  // null. A blocked read must not take the whole easter egg down with it.
  function remembered() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }
  function remember() {
    try { localStorage.setItem(KEY, "1"); } catch (e) { /* fine, they solve it again */ }
  }

  // ---- lazy asset loading ----------------------------------------------
  function loadCSS(href) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('link[data-arcade="' + href + '"]')) return resolve();
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      link.setAttribute("data-arcade", href);
      link.onload = resolve;
      link.onerror = function () { reject(new Error("css " + href)); };
      document.head.appendChild(link);
    });
  }

  function loadJS(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-arcade="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.async = false;                  // preserve order across the batch
      s.setAttribute("data-arcade", src);
      s.onload = resolve;
      s.onerror = function () { reject(new Error("js " + src)); };
      document.body.appendChild(s);
    });
  }

  function loadEngine() {
    if (loaded) return Promise.resolve();
    if (loading) return loading;
    loading = Promise.all([
      loadCSS(BASE + "arcade.css"),
      loadJS(BASE + "mazes.js")
        .then(function () { return loadJS(BASE + "scores.js"); })
        .then(function () { return loadJS(BASE + "game.js"); })
    ]).then(function () { loaded = true; });
    return loading;
  }

  /* =====================================================================
     The terminal challenge
     ===================================================================== */
  var ANSWER = /^sudo\s+pacman\s+-s(?:y{1,2}u?)?\s+ghosts$/;

  var RIDDLE =
    '<span class="d">wcta-shell 3.2 — unrecognised service on this host</span>\n' +
    '\n' +
    '$ <span class="w">systemctl status ???</span>\n' +
    '<span class="r">●</span> unknown.service - <span class="w">not in the manifest</span>\n' +
    '   Loaded: <span class="r">masked</span>\n' +
    '   Active: <span class="g">running</span> (something is here)\n' +
    '\n' +
    'It will not answer to <span class="w">apt</span>. It will not answer to <span class="w">yum</span>.\n' +
    'It answers to the package manager that eats its way through\n' +
    'its dependencies — and what it wants installed is the ghosts.\n' +
    '\n' +
    '<span class="d">install it. (esc to give up)</span>';

  var HINT_1 = '<span class="d">hint: the package manager is also the game.</span>';
  var HINT_2 = '<span class="d">hint: arch, btw. and you will need to be root.</span>';

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Graded responses. A puzzle that answers every wrong guess with the same
  // "nope" teaches nothing; these tell you how close you are, which is the
  // whole point of putting it on a cyber program's site.
  function respond(raw) {
    var cmd = raw.trim().replace(/\s+/g, " ");
    var low = cmd.toLowerCase();
    var head = low.split(" ")[0];

    if (!cmd) return "";
    if (ANSWER.test(low)) return null;                       // null = solved

    if (/^(sudo\s+)?pacman\s+-s\S*\s+\S+/.test(low) && !/\bsudo\b/.test(low))
      return '<span class="r">error:</span> you cannot perform this operation unless you are root.';

    if (/^sudo\s+pacman\s+-s\S*\s+(\S+)/.test(low))
      return '<span class="r">error:</span> target not found: ' +
        esc(low.match(/^sudo\s+pacman\s+-s\S*\s+(\S+)/)[1]);

    if (/^(sudo\s+)?pacman\b/.test(low))
      return '<span class="r">error:</span> no operation specified (use -h for help)';

    if (/^(sudo\s+)?(apt|apt-get|yum|dnf|zypper|brew|snap|choco|winget)\b/.test(low))
      return "Command '" + esc(head === "sudo" ? low.split(" ")[1] : head) +
        "' not found. <span class=\"d\">wrong distribution.</span>";

    switch (head) {
      case "ls":
        return "boot.log  index.html  <span class=\"g\">pacman.d/</span>  pathways/  README";
      case "cat":
        return /readme/.test(low)
          ? "<span class=\"d\"># nothing here but a note that says: check pacman.d/</span>"
          : "cat: " + esc(cmd.slice(4)) + ": No such file or directory";
      case "whoami": return "guest";
      case "id": return "uid=1000(guest) gid=1000(guest) groups=1000(guest),27(sudo)";
      case "sudo": return "usage: sudo -h | -K | -k | command";
      case "man":
        return /pacman/.test(low)
          ? '<span class="w">PACMAN(8)</span>  package manager utility\n' +
          '  -S, --sync   <span class="d">install packages from the repositories</span>'
          : "No manual entry for " + esc(cmd.slice(4));
      case "help": case "?": return HINT_1;
      case "exit": case "quit": return "<span class=\"d\">use esc.</span>";
      case "clear": return "\x00clear";
      default:
        return "bash: " + esc(head) + ": command not found";
    }
  }

  /* =====================================================================
     UI
     ===================================================================== */
  var overlay = null;
  var lastFocus = null;

  function closeOverlay() {
    if (!overlay) return;
    if (overlay.game) overlay.game.stop();
    document.removeEventListener("keydown", overlay.trap, true);
    document.documentElement.style.overflow = overlay.prevOverflow;
    var main = document.querySelector("main");
    if (main) main.removeAttribute("aria-hidden");
    overlay.el.remove();
    overlay = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // Builds the fullscreen shell. Everything the arcade shows — terminal and
  // game alike — lives inside it, so there is exactly one thing to tear down.
  function openOverlay() {
    lastFocus = document.activeElement;

    var el = document.createElement("div");
    el.className = "wa-root";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", "WCTA Arcade");

    var prevOverflow = document.documentElement.style.overflow;
    // Locking scroll also parks the index page's hero: its frame-scrubbing
    // canvas only redraws on scroll, so there is no second animation loop
    // competing with the game for frames.
    document.documentElement.style.overflow = "hidden";
    var main = document.querySelector("main");
    if (main) main.setAttribute("aria-hidden", "true");

    // Keep focus inside the dialog.
    function trap(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeOverlay(); return; }
      if (e.key !== "Tab") return;
      var f = el.querySelectorAll("button, input, [href], [tabindex]:not([tabindex='-1'])");
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", trap, true);

    document.body.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("on"); });

    overlay = { el: el, trap: trap, prevOverflow: prevOverflow, game: null };
    return el;
  }

  function showTerminal() {
    var el = openOverlay();
    el.innerHTML =
      '<div class="wa-term">' +
      '<pre class="wa-out" id="waOut"></pre>' +
      '<div class="wa-line">' +
      '<span class="wa-ps1">guest@wcta:~$</span>' +
      '<input class="wa-in" id="waIn" autocomplete="off" autocorrect="off" ' +
      'autocapitalize="off" spellcheck="false" aria-label="terminal input">' +
      '</div></div>';

    var out = el.querySelector("#waOut");
    var input = el.querySelector("#waIn");
    var tries = 0;
    out.innerHTML = RIDDLE;
    setTimeout(function () { input.focus(); }, 60);

    function print(html) {
      out.innerHTML += "\n\n<span class=\"d\">$</span> " + esc(input.value.trim()) +
        (html ? "\n" + html : "");
      out.scrollTop = out.scrollHeight;
    }

    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      e.preventDefault();
      var value = input.value;
      if (!value.trim()) return;

      var reply = respond(value);

      if (reply === null) {                       // solved
        print('<span class="g">resolving dependencies...</span>\n' +
          '<span class="g">(1/4) installing scanner  (2/4) installing spoof</span>\n' +
          '<span class="g">(3/4) installing sniffer  (4/4) installing worm</span>\n' +
          '<span class="w">4 ghosts installed. starting arcade.</span>');
        input.value = "";
        input.disabled = true;
        remember();
        setTimeout(startGame, 750);
        return;
      }

      if (reply === "\x00clear") { out.innerHTML = RIDDLE; input.value = ""; return; }

      tries++;
      print(reply);
      if (tries === 4) out.innerHTML += "\n" + HINT_1;
      if (tries === 8) out.innerHTML += "\n" + HINT_2;
      input.value = "";
      out.scrollTop = out.scrollHeight;
    });
  }

  /* ---- the game shell -------------------------------------------------- */
  function startGame() {
    loadEngine().then(function () {
      if (!overlay) openOverlay();
      var A = window.WCTAArcade;
      var el = overlay.el;

      el.innerHTML =
        '<div class="wa-bar">' +
        '<span class="wa-g">●</span><span><b>WCTA</b> ARCADE</span>' +
        '<span class="wa-spacer"></span>' +
        '<button class="wa-btn" id="waBoard">Scores</button>' +
        '<button class="wa-btn" id="waClose">Close</button>' +
        '</div>' +
        '<div class="wa-stage"><canvas class="wa-screen" id="waScreen"></canvas>' +
        '<div class="wa-crt"></div><div id="waPanel"></div></div>' +
        '<div class="wa-bar">' +
        '<span class="wa-key">W A S D</span><span>move</span>' +
        '<span class="wa-key">P</span><span>pause</span>' +
        '<span class="wa-key">M</span><span>sound</span>' +
        '<span class="wa-key">esc</span><span>close</span>' +
        '<span class="wa-touch-hint" hidden>swipe to move</span>' +
        '<span class="wa-spacer"></span>' +
        '<span id="waStatus"></span>' +
        '</div>';

      var cv = el.querySelector("#waScreen");

      // Whole-number scaling keeps the pixel art crisp, and is used whenever
      // 2x or more fits. It cannot be the only rule, though: the playfield is
      // 224px wide, so 2x needs 448px and no phone in portrait has that. On
      // those screens an integer rule would pin the game at 1x — a postage
      // stamp — so below 2x we scale to fit instead and accept slightly
      // uneven pixels. A game you can actually see beats a purist one.
      function fit() {
        var raw = Math.min(
          (window.innerWidth - 16) / A.VIEW_W,
          (window.innerHeight - chromeHeight()) / A.VIEW_H
        );
        var scale = raw >= 2 ? Math.floor(raw) : Math.max(1, raw);
        cv.width = A.VIEW_W;
        cv.height = A.VIEW_H;
        cv.style.width = Math.round(A.VIEW_W * scale) + "px";
        cv.style.height = Math.round(A.VIEW_H * scale) + "px";
        if (overlay.game) overlay.game.g.imageSmoothingEnabled = false;
      }

      // Space taken by the two bars, which stack on narrow screens.
      function chromeHeight() { return window.innerWidth < 560 ? 150 : 130; }
      fit();
      window.addEventListener("resize", fit);

      if (window.matchMedia("(hover: none) and (pointer: coarse)").matches) {
        var hint = el.querySelector(".wa-touch-hint");
        if (hint) hint.hidden = false;
      }

      var panel = el.querySelector("#waPanel");
      var game = new A.Game(cv, {
        onGameOver: function (score, level) {
          A.Scores.gameOver(panel, score, level, function () {
            game.newGame();
            game.state = A.STATE.READY;
            A.Scores.beginRun();            // fresh token for the new run
          });
        },
        onRestart: function () { game.newGame(); A.Scores.beginRun(); }
      });
      overlay.game = game;
      A.current = game;          // handle for the console and for tests
      A.Scores.beginRun();
      game.start();

      el.querySelector("#waClose").addEventListener("click", closeOverlay);
      el.querySelector("#waBoard").addEventListener("click", function () {
        A.Scores.showBoard(panel);
      });

      // The engine owns Escape (it captures keys); route it back to the shell.
      game.input.on(function (code) {
        if (code === "Escape") closeOverlay();
      });

      // Never let the game run on while the tab is hidden.
      document.addEventListener("visibilitychange", function () {
        if (document.hidden && overlay && overlay.game) overlay.game.paused = true;
      });

      setInterval(function () {
        var s = el.querySelector("#waStatus");
        if (s && overlay && overlay.game)
          s.textContent = "LEVEL " + String(overlay.game.level).padStart(2, "0") +
            " // " + overlay.game.grid.def.name;
      }, 250);
    }).catch(function (err) {
      // A missing asset should say so rather than leaving a dead black screen.
      if (overlay) {
        overlay.el.innerHTML =
          '<div class="wa-term"><pre class="wa-out">' +
          '<span class="r">arcade failed to load.</span>\n' +
          '<span class="d">' + esc(err && err.message) + '</span>\n\n' +
          '<span class="d">press esc to go back.</span></pre></div>';
      }
      if (window.console) console.error("[wcta-arcade]", err);
    });
  }

  /* =====================================================================
     Wire up the footer trigger
     ===================================================================== */
  function init() {
    var egg = document.getElementById("egg");
    if (!egg) return;

    if (remembered()) {
      egg.textContent = "[ ARCADE ]";
      egg.setAttribute("aria-label", "Open WCTA Arcade");
      egg.title = "you already know the way in";
    }

    egg.addEventListener("click", function (e) {
      e.preventDefault();
      if (overlay) return;
      if (remembered()) {
        // Already solved once — don't make them do the puzzle again.
        openOverlay();
        overlay.el.innerHTML = '<div class="wa-term"><pre class="wa-out">' +
          '<span class="g">welcome back. starting arcade.</span></pre></div>';
        loadCSS(BASE + "arcade.css").then(startGame);
      } else {
        loadCSS(BASE + "arcade.css").then(showTerminal).catch(showTerminal);
      }
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
