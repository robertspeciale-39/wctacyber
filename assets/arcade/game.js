/* =====================================================================
   WCTA ARCADE — engine
   ---------------------------------------------------------------------
   Arcade geometry, on purpose:
     tile          8 px
     playfield     28 x 31 tiles          = 224 x 248
     full screen   28 x 36 tiles          = 224 x 288   (3 rows HUD top, 2 bottom)
     base speed    1.25 px/frame @ 60Hz   = 75.76 px/s, the original's 100%

   The canvas is only ever scaled by whole integers. Fractional scaling is
   what makes clones look subtly wrong, and it is free to avoid.
   ===================================================================== */
(function (root) {
  "use strict";

  var NS = root.WCTAArcade = root.WCTAArcade || {};

  // ---- constants -------------------------------------------------------
  var T = 8;                     // tile size, px
  var COLS = 28, ROWS = 31;
  var HUD_TOP = 3, HUD_BOT = 2;  // in tiles
  var VIEW_W = COLS * T;                       // 224
  var VIEW_H = (ROWS + HUD_TOP + HUD_BOT) * T; // 288
  var MAZE_Y = HUD_TOP * T;                    // 24

  var BASE_SPEED = 1.25;         // px/frame at 100%
  var CORNER = 4;                // px from tile centre a turn may be taken
  var STEP_MS = 1000 / 60;

  var DIR = {
    up: { x: 0, y: -1, name: "up" },
    down: { x: 0, y: 1, name: "down" },
    left: { x: -1, y: 0, name: "left" },
    right: { x: 1, y: 0, name: "right" }
  };

  var COLOR = {
    dot: "#f5d9a8",
    energizer: "#f5d9a8",
    player: "#ffe600",
    door: "#f4a6c0",
    hud: "#ffffff",
    dim: "#8a8a8a",
    ready: "#ffcc00",
    over: "#ff3b30"
  };

  // ---- small helpers ---------------------------------------------------
  function sign(n) { return n < 0 ? -1 : n > 0 ? 1 : 0; }
  function centreOf(c, r) { return { x: c * T + T / 2, y: r * T + T / 2 }; }

  // Invokes `fn` once for the real x, and again for its mirror across the
  // tunnel seam when the sprite straddles an edge. Every actor draws
  // through this so nothing pops in and out at the tunnel mouth.
  function eachWrappedX(x, fn) {
    fn(x);
    if (x < 16) fn(x + COLS * T);
    else if (x > COLS * T - 16) fn(x - COLS * T);
  }

  /* =====================================================================
     Grid — one level's tile state
     ===================================================================== */
  function Grid(def, geom) {
    this.def = def;
    this.geom = geom;
    this.tiles = def.rows.map(function (row) { return row.split(""); });
    this.pellets = 0;
    this.total = 0;
    for (var r = 0; r < ROWS; r++)
      for (var c = 0; c < COLS; c++)
        if (this.tiles[r][c] === "." || this.tiles[r][c] === "o") this.pellets++;
    this.total = this.pellets;
    this.bake();
  }

  // Columns wrap on the tunnel row — a lookup one tile past the left edge
  // has to answer with the right edge, or the tunnel reads as a dead end
  // to every movement and pathing check in the game.
  Grid.prototype.at = function (c, r) {
    if (r < 0 || r >= ROWS) return "#";
    if (r === this.geom.TUNNEL_ROW) c = ((c % COLS) + COLS) % COLS;
    if (c < 0 || c >= COLS) return "#";
    return this.tiles[r][c];
  };

  Grid.prototype.isWall = function (c, r) { return this.at(c, r) === "#"; };

  // `who` is "player" or "ghost" — only ghosts pass the door and the house.
  Grid.prototype.walkable = function (c, r, who) {
    var ch = this.at(c, r);
    if (ch === "#") return false;
    if (who === "player" && (ch === "-" || ch === "X")) return false;
    return true;
  };

  Grid.prototype.eat = function (c, r) {
    var ch = this.at(c, r);
    if (ch !== "." && ch !== "o") return null;
    this.tiles[r][c] = " ";
    this.pellets--;
    return ch;
  };

  /* ---------------------------------------------------------------------
     Wall rendering, baked once per level to an offscreen canvas.

     Each wall tile strokes only the edges that face open space, inset by
     `INSET`. Edges extend to the tile boundary when the neighbour on that
     side is also wall (so runs join seamlessly), and quarter-arcs close
     both convex corners (two open sides) and concave notches (two wall
     sides with an open diagonal). Without the concave case you get tiny
     nicks at every inside corner, which is the tell of a rushed clone.
     --------------------------------------------------------------------- */
  var INSET = 1.5;

  Grid.prototype.bake = function () {
    var cv = document.createElement("canvas");
    cv.width = VIEW_W; cv.height = ROWS * T;
    var g = cv.getContext("2d");
    g.strokeStyle = this.def.wall || "#1e5cff";
    g.lineWidth = 1;
    g.lineCap = "butt";
    g.beginPath();

    var self = this;
    var wall = function (c, r) {
      // Outside the grid counts as wall so the border draws closed, except
      // across the tunnel mouth where the corridor genuinely continues.
      if (c < 0 || c >= COLS) return r !== self.geom.TUNNEL_ROW;
      return self.isWall(c, r);
    };

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        if (!this.isWall(c, r)) continue;
        var x = c * T, y = r * T, i = INSET;
        var N = wall(c, r - 1), S = wall(c, r + 1),
          W = wall(c - 1, r), E = wall(c + 1, r);
        var NW = wall(c - 1, r - 1), NE = wall(c + 1, r - 1),
          SW = wall(c - 1, r + 1), SE = wall(c + 1, r + 1);

        // straight edges facing open space
        if (!N) { g.moveTo(W ? x : x + i, y + i); g.lineTo(E ? x + T : x + T - i, y + i); }
        if (!S) { g.moveTo(W ? x : x + i, y + T - i); g.lineTo(E ? x + T : x + T - i, y + T - i); }
        if (!W) { g.moveTo(x + i, N ? y : y + i); g.lineTo(x + i, S ? y + T : y + T - i); }
        if (!E) { g.moveTo(x + T - i, N ? y : y + i); g.lineTo(x + T - i, S ? y + T : y + T - i); }

        // convex corners — two adjacent sides both open
        if (!N && !W) { g.moveTo(x, y + i); g.arc(x + i, y + i, i, Math.PI, Math.PI * 1.5); }
        if (!N && !E) { g.moveTo(x + T - i, y); g.arc(x + T - i, y + i, i, Math.PI * 1.5, Math.PI * 2); }
        if (!S && !E) { g.moveTo(x + T, y + T - i); g.arc(x + T - i, y + T - i, i, 0, Math.PI * 0.5); }
        if (!S && !W) { g.moveTo(x + i, y + T); g.arc(x + i, y + T - i, i, Math.PI * 0.5, Math.PI); }

        // concave notches — both sides wall, diagonal open
        if (N && W && !NW) { g.moveTo(x + i, y); g.arc(x, y, i, 0, Math.PI * 0.5); }
        if (N && E && !NE) { g.moveTo(x + T, y + i); g.arc(x + T, y, i, Math.PI * 0.5, Math.PI); }
        if (S && E && !SE) { g.moveTo(x + T - i, y + T); g.arc(x + T, y + T, i, Math.PI, Math.PI * 1.5); }
        if (S && W && !SW) { g.moveTo(x, y + T - i); g.arc(x, y + T, i, Math.PI * 1.5, Math.PI * 2); }
      }
    }
    g.stroke();

    // ghost-house door
    g.strokeStyle = COLOR.door;
    g.lineWidth = 1.5;
    g.beginPath();
    var d = this.geom.DOOR;
    g.moveTo(d.cols[0] * T, d.row * T + T / 2);
    g.lineTo((d.cols[d.cols.length - 1] + 1) * T, d.row * T + T / 2);
    g.stroke();

    this.baked = cv;
  };

  Grid.prototype.drawWalls = function (g) { g.drawImage(this.baked, 0, MAZE_Y); };

  Grid.prototype.drawPellets = function (g, blink) {
    g.fillStyle = COLOR.dot;
    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var ch = this.tiles[r][c];
        if (ch === ".") {
          g.fillRect(c * T + 3, MAZE_Y + r * T + 3, 2, 2);
        } else if (ch === "o" && blink) {
          var p = centreOf(c, r);
          g.beginPath();
          g.arc(p.x, MAZE_Y + p.y, 3.5, 0, Math.PI * 2);
          g.fill();
        }
      }
    }
  };

  /* =====================================================================
     Entity — shared movement for the player and (later) the ghosts
     ===================================================================== */
  function Entity(kind) {
    this.kind = kind;                 // "player" | "ghost"
    this.x = 0; this.y = 0;
    this.dir = DIR.left;
    this.want = null;
    this.glide = null;
    this.speed = BASE_SPEED;
  }

  // `col` may be a .5 seam value (13.5), which is how the arcade starts
  // actors straddling two tiles. Whole columns land on the tile centre.
  Entity.prototype.placeAt = function (col, row) {
    this.x = col * T + (col % 1 === 0 ? T / 2 : 0);
    this.y = row * T + T / 2;
    this.glide = null;
  };

  Entity.prototype.tile = function () {
    return { c: Math.floor(this.x / T), r: Math.floor(this.y / T) };
  };

  Entity.prototype.setWant = function (d) { this.want = d; };

  // Turning: reversals are free, perpendicular turns need the target tile
  // open and the entity within CORNER px of the junction. The residual
  // offset is then glided out over the following frames rather than
  // snapped, which is what produces the arcade's diagonal corner-cut.
  Entity.prototype.tryTurn = function (grid) {
    var w = this.want;
    if (!w || (w.x === this.dir.x && w.y === this.dir.y)) return;
    var t = this.tile();
    if (!grid.walkable(t.c + w.x, t.r + w.y, this.kind)) return;

    if (w.x === -this.dir.x && w.y === -this.dir.y) {   // reversal
      this.dir = w; this.want = null; this.glide = null;
      return;
    }
    var ctr = centreOf(t.c, t.r);
    var off = this.dir.x ? this.x - ctr.x : this.y - ctr.y;
    if (Math.abs(off) > CORNER) return;

    this.dir = w;
    this.want = null;
    this.glide = w.y !== 0 ? { axis: "x", to: ctr.x } : { axis: "y", to: ctr.y };
  };

  Entity.prototype.advance = function (grid) {
    // settle onto the lane centre while cornering
    if (this.glide) {
      var cur = this.glide.axis === "x" ? this.x : this.y;
      var delta = this.glide.to - cur;
      var step = Math.min(Math.abs(delta), this.speed);
      var next = cur + sign(delta) * step;
      if (this.glide.axis === "x") this.x = next; else this.y = next;
      if (Math.abs(this.glide.to - next) < 1e-6) this.glide = null;
    }

    var t = this.tile();
    var ctr = centreOf(t.c, t.r);
    var nx = this.x + this.dir.x * this.speed;
    var ny = this.y + this.dir.y * this.speed;

    if (this.dir.x && !grid.walkable(t.c + this.dir.x, t.r, this.kind)) {
      if (this.dir.x > 0 && nx > ctr.x) nx = ctr.x;
      if (this.dir.x < 0 && nx < ctr.x) nx = ctr.x;
    }
    if (this.dir.y && !grid.walkable(t.c, t.r + this.dir.y, this.kind)) {
      if (this.dir.y > 0 && ny > ctr.y) ny = ctr.y;
      if (this.dir.y < 0 && ny < ctr.y) ny = ctr.y;
    }
    this.x = nx; this.y = ny;

    // tunnel wrap
    if (this.x < -T / 2) this.x += COLS * T;
    else if (this.x > COLS * T + T / 2) this.x -= COLS * T;
  };

  Entity.prototype.stuck = function (grid) {
    var t = this.tile();
    var ctr = centreOf(t.c, t.r);
    var atCentre = Math.abs(this.x - ctr.x) < 0.01 && Math.abs(this.y - ctr.y) < 0.01;
    return atCentre && !grid.walkable(t.c + this.dir.x, t.r + this.dir.y, this.kind);
  };

  /* =====================================================================
     Player
     ===================================================================== */
  function Player() {
    Entity.call(this, "player");
    this.anim = 0;
  }
  Player.prototype = Object.create(Entity.prototype);
  Player.prototype.constructor = Player;

  Player.prototype.draw = function (g, dying, dieT) {
    var a;
    if (dying) {
      // death animation: the mouth opens until it swallows the whole sprite
      a = Math.min(1, dieT) * Math.PI;
    } else {
      // 0 -> closed, 1 -> wide; 8-frame chomp like the original
      var phase = (Math.floor(this.anim / 2) % 4);
      var open = [0, 1, 2, 1][phase] / 2;      // 0, .5, 1, .5
      a = open * 0.68;                          // radians of half-mouth
    }
    var rot = Math.atan2(this.dir.y, this.dir.x);
    var self = this;
    // Draw a second copy across the seam while crossing the tunnel mouth,
    // otherwise the sprite blinks out of one side before appearing on the
    // other.
    eachWrappedX(this.x, function (px) {
      g.save();
      g.translate(px, MAZE_Y + self.y);
      g.rotate(rot);
      g.fillStyle = COLOR.player;
      g.beginPath();
      if (a <= 0.001) {
        g.arc(0, 0, 6, 0, Math.PI * 2);
      } else {
        g.moveTo(0, 0);
        g.arc(0, 0, 6, a, Math.PI * 2 - a);
        g.closePath();
      }
      g.fill();
      g.restore();
    });
  };

  /* =====================================================================
     Ghosts

     Four target-tile functions, one per personality. Everything else —
     pathing, mode switching, speed — is shared. This is the whole trick of
     the original: the chase logic is identical for all four, and only the
     tile they aim at differs. That is what makes them read as characters
     with intentions instead of four copies of the same chaser.
     ===================================================================== */
  var GMODE = {
    HOUSE: "house",       // bobbing inside, waiting on the release counter
    EXIT: "exit",         // scripted climb out through the door
    SCATTER: "scatter",
    CHASE: "chase",
    FRIGHT: "fright",
    EYES: "eyes",         // eaten; running back to the house
    ENTER: "enter"        // scripted descent back into the house
  };

  var GHOSTS = [
    { key: "scanner", name: "SCANNER", color: "#ff2d20" },  // red
    { key: "spoof", name: "SPOOF", color: "#ff9ecb" },  // pink
    { key: "sniffer", name: "SNIFFER", color: "#31d8f0" },  // cyan
    { key: "worm", name: "WORM", color: "#ffa11f" }   // orange
  ];

  // Arcade tie-break order. When two directions are equidistant from the
  // target, the ghost prefers up, then left, then down, then right. Players
  // who have internalised the original are reading this order without
  // knowing it.
  var PREF = [DIR.up, DIR.left, DIR.down, DIR.right];

  function Ghost(index, geom) {
    Entity.call(this, "ghost");
    this.index = index;
    this.def = GHOSTS[index];
    this.geom = geom;
    this.mode = GMODE.HOUSE;
    this.pending = null;
    this.lastC = -1; this.lastR = -1;
    this.frightBlink = false;
    this.dotCounter = 0;
    this.reviveT = 0;
    this.bob = 0;
  }
  Ghost.prototype = Object.create(Entity.prototype);
  Ghost.prototype.constructor = Ghost;

  Ghost.prototype.reset = function (globalMode) {
    var s = this.geom.SPAWN.ghosts[this.index];
    this.placeAt(s.col, s.row);
    this.dir = this.index === 0 ? DIR.left : DIR.up;
    this.pending = null;
    this.glide = null;
    this.lastC = -1; this.lastR = -1;
    this.mode = s.home ? globalMode : GMODE.HOUSE;
    this.bob = 0;
    this.reviveT = 0;
  };

  Ghost.prototype.isHoused = function () {
    return this.mode === GMODE.HOUSE || this.mode === GMODE.EXIT || this.mode === GMODE.ENTER;
  };

  Ghost.prototype.edible = function () { return this.mode === GMODE.FRIGHT; };

  /* ---- target selection ---------------------------------------------- */
  Ghost.prototype.target = function (game) {
    var p = game.player;
    var pt = p.tile();
    var d = p.dir;

    if (this.mode === GMODE.EYES) {
      var e = this.geom.SPAWN.exit;
      return { c: Math.floor(e.col), r: e.row };
    }
    if (this.mode === GMODE.SCATTER) return this.geom.SCATTER[this.index];

    switch (this.index) {
      case 0:   // SCANNER — straight at you. The pressure that never lets up.
        return pt;

      case 1: { // SPOOF — four tiles ahead of you, cutting you off
        // The original has a signed-arithmetic bug that shifts this target
        // four tiles LEFT as well as up whenever the player faces up. It is
        // preserved here on purpose: without it this ghost is meaningfully
        // harder, and every strategy the game has ever taught assumes it.
        var c = pt.c + d.x * 4, r = pt.r + d.y * 4;
        if (d === DIR.up) c -= 4;
        return { c: c, r: r };
      }

      case 2: { // SNIFFER — plays off the red ghost, so it flanks
        var two = { c: pt.c + d.x * 2, r: pt.r + d.y * 2 };
        if (d === DIR.up) two.c -= 2;              // same bug, two tiles
        var red = game.ghosts[0].tile();
        return { c: two.c + (two.c - red.c), r: two.r + (two.r - red.r) };
      }

      default: { // WORM — bold at range, loses its nerve up close
        var dx = this.x - p.x, dy = this.y - p.y;
        var far = (dx * dx + dy * dy) > (8 * T) * (8 * T);
        return far ? pt : this.geom.SCATTER[3];
      }
    }
  };

  /* ---- pathing -------------------------------------------------------- */
  Ghost.prototype.canEnter = function (grid, c, r) {
    var ch = grid.at(c, r);
    if (ch === "#") return false;
    // The door is one-way by mode: only a ghost that is leaving or a pair of
    // eyes coming home may cross it.
    if (ch === "-") return this.mode === GMODE.EYES || this.mode === GMODE.EXIT || this.mode === GMODE.ENTER;
    if (ch === "X") return this.isHoused() || this.mode === GMODE.EYES;
    return true;
  };

  Ghost.prototype.chooseDir = function (grid, t, game) {
    var opts = [];
    var back = { x: -this.dir.x, y: -this.dir.y };
    var noUp = this.mode === GMODE.SCATTER || this.mode === GMODE.CHASE;

    for (var i = 0; i < PREF.length; i++) {
      var d = PREF[i];
      if (d.x === back.x && d.y === back.y) continue;          // never turn around
      if (noUp && d === DIR.up && game.isNoUp(t.c, t.r)) continue;
      if (!this.canEnter(grid, t.c + d.x, t.r + d.y)) continue;
      opts.push(d);
    }
    // Dead end: reversing is the only legal move left.
    if (!opts.length) return back.x || back.y ? { x: back.x, y: back.y, name: "back" } : this.dir;

    if (this.mode === GMODE.FRIGHT) {
      // Frightened ghosts pick at random. Seeded from the frame counter so
      // a recorded run replays identically — the determinism test depends
      // on this not being Math.random().
      return opts[game.rng() % opts.length];
    }

    var tgt = this.target(game);
    var best = null, bestD = Infinity;
    for (var j = 0; j < opts.length; j++) {
      var o = opts[j];
      var dc = (t.c + o.x) - tgt.c;
      var dr = (t.r + o.y) - tgt.r;
      var dist = dc * dc + dr * dr;                             // squared is enough
      if (dist < bestD) { bestD = dist; best = o; }            // PREF order breaks ties
    }
    return best;
  };

  Ghost.prototype.update = function (grid, game) {
    if (this.mode === GMODE.HOUSE) return this.updateHouse(game);
    if (this.mode === GMODE.EXIT) return this.updateExit(game);
    if (this.mode === GMODE.ENTER) return this.updateEnter(game);

    this.speed = game.ghostSpeed(this);

    var t = this.tile();
    if (t.c !== this.lastC || t.r !== this.lastR) {
      this.lastC = t.c; this.lastR = t.r;
      this.pending = this.chooseDir(grid, t, game);
    }

    // Ghosts turn on exact tile centres — no cornering. That difference in
    // handling is most of why the player can out-manoeuvre them at all.
    if (this.pending) {
      var ctr = centreOf(t.c, t.r);
      var reached = this.dir.x
        ? (this.dir.x > 0 ? this.x >= ctr.x : this.x <= ctr.x)
        : (this.dir.y > 0 ? this.y >= ctr.y : this.y <= ctr.y);
      if (reached) {
        var p = this.pending;
        this.pending = null;
        if (p.x !== this.dir.x || p.y !== this.dir.y) { this.x = ctr.x; this.y = ctr.y; }
        this.dir = p;
      }
    }

    this.advanceRaw(grid);

    // Eyes that have arrived above the door drop back into the house.
    if (this.mode === GMODE.EYES) {
      var e = this.geom.SPAWN.exit;
      if (Math.abs(this.x - e.col * T) < 1.5 && Math.abs(this.y - (e.row * T + T / 2)) < 1.5) {
        this.mode = GMODE.ENTER;
        this.x = e.col * T;
      }
    }
  };

  // Ghost movement without the player's cornering glide.
  Ghost.prototype.advanceRaw = function (grid) {
    var t = this.tile();
    var ctr = centreOf(t.c, t.r);
    var nx = this.x + this.dir.x * this.speed;
    var ny = this.y + this.dir.y * this.speed;

    if (this.dir.x && !this.canEnter(grid, t.c + this.dir.x, t.r)) {
      if (this.dir.x > 0 && nx > ctr.x) nx = ctr.x;
      if (this.dir.x < 0 && nx < ctr.x) nx = ctr.x;
    }
    if (this.dir.y && !this.canEnter(grid, t.c, t.r + this.dir.y)) {
      if (this.dir.y > 0 && ny > ctr.y) ny = ctr.y;
      if (this.dir.y < 0 && ny < ctr.y) ny = ctr.y;
    }
    this.x = nx; this.y = ny;
    if (this.x < -T / 2) this.x += COLS * T;
    else if (this.x > COLS * T + T / 2) this.x -= COLS * T;
  };

  /* ---- scripted house sequences --------------------------------------- */
  Ghost.prototype.updateHouse = function (game) {
    // idle bob, so a waiting ghost never looks frozen
    this.bob += 0.09;
    var s = this.geom.SPAWN.ghosts[this.index];
    this.y = s.row * T + T / 2 + Math.sin(this.bob) * 3;
    this.dir = Math.sin(this.bob) > 0 ? DIR.down : DIR.up;
    if (this.reviveT > 0) { this.reviveT--; return; }
    if (game.wantsRelease(this)) this.mode = GMODE.EXIT;
  };

  Ghost.prototype.updateExit = function (game) {
    var doorX = this.geom.SPAWN.house.col * T;
    var outY = this.geom.SPAWN.exit.row * T + T / 2;
    var sp = BASE_SPEED * 0.5;
    if (Math.abs(this.x - doorX) > 0.5) {          // slide under the door
      this.x += sign(doorX - this.x) * Math.min(sp, Math.abs(doorX - this.x));
      this.dir = doorX > this.x ? DIR.right : DIR.left;
      return;
    }
    this.x = doorX;
    this.dir = DIR.up;
    this.y -= sp;
    if (this.y <= outY) {                          // clear of the house
      this.y = outY;
      this.mode = game.mode;
      if (game.frightT > 0) this.mode = GMODE.FRIGHT;
      this.dir = DIR.left;
      this.lastC = -1; this.lastR = -1;
    }
  };

  Ghost.prototype.updateEnter = function (game) {
    var homeY = this.geom.SPAWN.house.row * T + T / 2;
    var sp = BASE_SPEED * 0.6;
    this.dir = DIR.down;
    this.y += sp;
    if (this.y >= homeY) {
      this.y = homeY;
      this.mode = GMODE.HOUSE;
      this.reviveT = 30;                            // brief pause, then it re-enters play
      this.bob = 0;
    }
  };

  /* ---- drawing -------------------------------------------------------- */
  Ghost.prototype.draw = function (g, game) {
    var self = this;
    var fright = this.mode === GMODE.FRIGHT;
    var eyes = this.mode === GMODE.EYES;

    // Flash white for the last two seconds of a frightened window — the
    // player's only warning that the window is closing.
    var flashing = fright && game.frightT > 0 && game.frightT < 120 &&
      Math.floor(game.frightT / 14) % 2 === 0;

    var body = eyes ? null : fright ? (flashing ? "#ffffff" : "#2323d8") : this.def.color;

    eachWrappedX(this.x, function (px) {
      var x = px, y = MAZE_Y + self.y;
      if (body) {
        g.fillStyle = body;
        g.beginPath();
        g.arc(x, y - 1, 6, Math.PI, 0);                 // domed head
        g.lineTo(x + 6, y + 5);
        // scalloped skirt
        for (var i = 0; i < 3; i++) {
          var x0 = x + 6 - i * 4;
          g.quadraticCurveTo(x0 - 2, y + 2, x0 - 4, y + 5);
        }
        g.lineTo(x - 6, y - 1);
        g.closePath();
        g.fill();
      }

      if (fright && !eyes) {
        // blank stare + gritted mouth
        g.fillStyle = flashing ? "#ff2d20" : "#ffffff";
        g.fillRect(x - 4, y - 2, 2, 2);
        g.fillRect(x + 2, y - 2, 2, 2);
        g.beginPath();
        g.moveTo(x - 4, y + 3);
        for (var k = 0; k < 4; k++) {
          g.lineTo(x - 4 + k * 2 + 1, y + 1);
          g.lineTo(x - 4 + k * 2 + 2, y + 3);
        }
        g.strokeStyle = flashing ? "#ff2d20" : "#ffffff";
        g.lineWidth = 1;
        g.stroke();
        return;
      }

      // eyes — whites plus a pupil pushed toward the direction of travel
      g.fillStyle = "#ffffff";
      g.beginPath(); g.ellipse(x - 2.6, y - 1, 2.4, 3, 0, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.ellipse(x + 2.6, y - 1, 2.4, 3, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = "#2323d8";
      var ox = self.dir.x * 1.2, oy = self.dir.y * 1.4;
      g.beginPath(); g.arc(x - 2.6 + ox, y - 1 + oy, 1.3, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(x + 2.6 + ox, y - 1 + oy, 1.3, 0, Math.PI * 2); g.fill();
    });
  };

  /* =====================================================================
     Input — WASD first, arrows accepted, swipe on touch
     ===================================================================== */
  function Input(target) {
    this.dir = null;
    this.pressed = {};
    this.handlers = [];
    var self = this;

    var MAP = {
      KeyW: DIR.up, KeyS: DIR.down, KeyA: DIR.left, KeyD: DIR.right,
      ArrowUp: DIR.up, ArrowDown: DIR.down, ArrowLeft: DIR.left, ArrowRight: DIR.right
    };

    function onKey(e) {
      var d = MAP[e.code];
      if (d) {
        e.preventDefault();
        self.dir = d;
        self.pressed[d.name] = true;
        return;
      }
      if (e.code === "KeyP" || e.code === "Escape" || e.code === "KeyM" ||
        e.code === "Enter" || e.code === "Space") {
        e.preventDefault();
        self.emit(e.code);
      }
    }
    function onKeyUp(e) {
      var d = MAP[e.code];
      if (d) self.pressed[d.name] = false;
    }

    var sx = 0, sy = 0, touching = false;
    function onStart(e) {
      var t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; touching = true;
    }
    function onEnd(e) {
      if (!touching) return;
      touching = false;
      var t = e.changedTouches[0];
      var dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) < 18 && Math.abs(dy) < 18) return;
      self.dir = Math.abs(dx) > Math.abs(dy)
        ? (dx > 0 ? DIR.right : DIR.left)
        : (dy > 0 ? DIR.down : DIR.up);
    }

    this.bind = function () {
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("keyup", onKeyUp, true);
      target.addEventListener("touchstart", onStart, { passive: true });
      target.addEventListener("touchend", onEnd, { passive: true });
    };
    this.unbind = function () {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("keyup", onKeyUp, true);
      target.removeEventListener("touchstart", onStart);
      target.removeEventListener("touchend", onEnd);
    };
  }
  Input.prototype.on = function (fn) { this.handlers.push(fn); };
  Input.prototype.emit = function (code) {
    for (var i = 0; i < this.handlers.length; i++) this.handlers[i](code);
  };
  Input.prototype.take = function () { var d = this.dir; this.dir = null; return d; };

  /* =====================================================================
     Sound — synthesised, no asset files

     Every effect is a square wave with an envelope, which is both what the
     original hardware did and the reason this costs zero bytes of download.
     Audio starts muted: nothing here should ambush someone who opened the
     easter egg on a school computer in a quiet room. `M` toggles.
     ===================================================================== */
  function Sound() {
    this.muted = true;
    this.ctx = null;
    this.master = null;
    this.siren = null;
    this.chompFlip = false;
  }

  Sound.prototype.ensure = function () {
    if (this.ctx || this.muted) return this.ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.16;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  };

  Sound.prototype.toggle = function () {
    this.muted = !this.muted;
    if (this.muted) {
      this.stopSiren();
      if (this.master) this.master.gain.value = 0;
    } else {
      this.ensure();
      if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
      if (this.master) this.master.gain.value = 0.16;
    }
    return !this.muted;
  };

  // freq may be a [from, to] pair for a sweep.
  Sound.prototype.blip = function (freq, dur, type, vol, delay) {
    var ctx = this.ensure();
    if (!ctx) return;
    var t0 = ctx.currentTime + (delay || 0);
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.type = type || "square";
    if (freq.length) {
      osc.frequency.setValueAtTime(freq[0], t0);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq[1]), t0 + dur);
    } else {
      osc.frequency.setValueAtTime(freq, t0);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(vol || 0.5, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain); gain.connect(this.master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  };

  Sound.prototype.chomp = function () {
    this.chompFlip = !this.chompFlip;
    this.blip(this.chompFlip ? 320 : 210, 0.05, "square", 0.35);
  };
  Sound.prototype.fright = function () { this.blip([180, 90], 0.35, "sawtooth", 0.4); };
  Sound.prototype.eatGhost = function () { this.blip([180, 900], 0.28, "square", 0.5); };
  Sound.prototype.fruit = function () {
    this.blip(520, 0.09, "square", 0.45, 0);
    this.blip(660, 0.09, "square", 0.45, 0.09);
    this.blip(880, 0.16, "square", 0.45, 0.18);
  };
  Sound.prototype.extra = function () {
    this.blip(660, 0.1, "square", 0.5, 0);
    this.blip(990, 0.22, "square", 0.5, 0.1);
  };
  Sound.prototype.death = function () {
    this.stopSiren();
    this.blip([700, 60], 0.9, "square", 0.5);
  };
  Sound.prototype.levelClear = function () {
    this.stopSiren();
    var n = [523, 659, 784, 1047];
    for (var i = 0; i < n.length; i++) this.blip(n[i], 0.13, "square", 0.45, i * 0.11);
  };

  // The background siren rises as the maze empties — an audible clock that
  // tells you how close the level is to over without looking at anything.
  Sound.prototype.updateSiren = function (progress, on) {
    if (this.muted || !on) return this.stopSiren();
    var ctx = this.ensure();
    if (!ctx) return;
    if (!this.siren) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = "triangle";
      gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(this.master);
      osc.start();
      this.siren = { osc: osc, gain: gain };
    }
    var base = 55 + progress * 45;
    this.siren.osc.frequency.setTargetAtTime(base, ctx.currentTime, 0.15);
  };

  Sound.prototype.stopSiren = function () {
    if (!this.siren) return;
    try { this.siren.osc.stop(); } catch (e) { /* already stopped */ }
    this.siren.osc.disconnect();
    this.siren.gain.disconnect();
    this.siren = null;
  };

  Sound.prototype.stop = function () {
    this.stopSiren();
    if (this.ctx && this.ctx.close) { try { this.ctx.close(); } catch (e) { } }
    this.ctx = null;
  };

  /* =====================================================================
     Game
     ===================================================================== */
  var STATE = { READY: "ready", PLAY: "play", DYING: "dying", CLEAR: "clear", OVER: "over" };

  /* ---------------------------------------------------------------------
     Level tables. Percentages are of BASE_SPEED; durations are in frames.
     The shape of these — fast early frightened windows collapsing to almost
     nothing by level 17 — is what turns the game from a chase into a
     memorisation problem, and it is the reason the difficulty curve works.
     --------------------------------------------------------------------- */
  function levelSpec(n) {
    var s;
    if (n === 1) s = { pac: .80, pacF: .90, gh: .75, ghF: .50, tun: .40, fright: 6 };
    else if (n <= 4) s = { pac: .90, pacF: .95, gh: .85, ghF: .55, tun: .45, fright: [0, 5, 4, 3][n - 1] };
    else if (n <= 20) s = { pac: 1.0, pacF: 1.0, gh: .95, ghF: .60, tun: .50, fright: 0 };
    else s = { pac: .90, pacF: .90, gh: .95, ghF: .60, tun: .50, fright: 0 };

    if (n >= 5) {
      var table = [2, 5, 2, 2, 1, 5, 2, 1, 1, 3, 1, 1, 0, 1, 0, 0];
      s.fright = n - 5 < table.length ? table[n - 5] : 0;
    }
    s.frightFrames = Math.round(s.fright * 60);

    // Elroy: the red ghost speeds up as the maze empties, so the last dozen
    // pellets are the hardest part of a level rather than a victory lap.
    // Values are "pellets remaining" thresholds.
    var ELROY = [20, 30, 40, 40, 40, 50, 50, 50, 60, 60, 60, 80, 80, 80, 100, 100, 100, 100, 120];
    s.elroy1 = ELROY[Math.min(n - 1, ELROY.length - 1)];
    s.elroy2 = Math.floor(s.elroy1 / 2);

    // Ghost release: dots the player must eat before each ghost leaves.
    s.release = n === 1 ? [0, 0, 30, 60] : n === 2 ? [0, 0, 0, 50] : [0, 0, 0, 0];
    return s;
  }

  // Scatter/chase alternation, in frames. The trailing -1 means "chase from
  // here on" — after the last wave the ghosts never scatter again.
  function waveTable(n) {
    if (n === 1) return [7 * 60, 20 * 60, 7 * 60, 20 * 60, 5 * 60, 20 * 60, 5 * 60, -1];
    if (n <= 4) return [7 * 60, 20 * 60, 7 * 60, 20 * 60, 5 * 60, 1033 * 60, 1, -1];
    return [5 * 60, 20 * 60, 5 * 60, 20 * 60, 5 * 60, 1037 * 60, 1, -1];
  }

  var FRUIT = [
    { name: "USB", value: 100, color: "#c0c0c0" },
    { name: "KEY", value: 300, color: "#f0c64a" },
    { name: "DISK", value: 500, color: "#31d8f0" },
    { name: "CHIP", value: 700, color: "#76b900" },
    { name: "CERT", value: 1000, color: "#ff9ecb" },
    { name: "ROOT", value: 2000, color: "#ff2d20" },
    { name: "ZERO", value: 3000, color: "#ffffff" },
    { name: "CORE", value: 5000, color: "#ffe600" }
  ];

  function Game(canvas, opts) {
    this.canvas = canvas;
    this.g = canvas.getContext("2d");
    this.g.imageSmoothingEnabled = false;
    this.opts = opts || {};

    this.data = NS.MAZES;
    this.geom = this.data.GEOM;

    this.score = 0;
    this.lives = 3;
    this.level = 1;
    this.best = 0;
    this.extraAwarded = false;

    this.player = new Player();
    this.ghosts = [];
    for (var i = 0; i < 4; i++) this.ghosts.push(new Ghost(i, this.geom));

    this.input = new Input(canvas);
    this.sound = new Sound();          // starts muted; M toggles

    this.state = STATE.READY;
    this.timer = 0;
    this.frame = 0;
    this.running = false;
    this.paused = false;
    this.seed = 0x2545f491;

    this.loadLevel(1);
  }

  // Deterministic PRNG. Frightened ghosts and any other "random" choice draw
  // from this so a recorded input sequence always replays to the same frame —
  // which is what makes the regression fixture in tools/test-ghosts.mjs
  // meaningful rather than flaky.
  Game.prototype.rng = function () {
    this.seed ^= this.seed << 13; this.seed >>>= 0;
    this.seed ^= this.seed >> 17;
    this.seed ^= this.seed << 5; this.seed >>>= 0;
    return this.seed >>> 0;
  };

  // Full restart. loadLevel deliberately preserves score and lives (it is
  // also used for advancing a level), so anything that means "start over"
  // has to come through here.
  Game.prototype.newGame = function () {
    this.score = 0;
    this.lives = 3;
    this.extraAwarded = false;
    this.seed = 0x2545f491;
    this.frame = 0;
    this.loadLevel(1);
  };

  Game.prototype.mazeFor = function (level) {
    var list = this.data.MAZES;
    return list[(level - 1) % list.length];
  };

  Game.prototype.loadLevel = function (level) {
    this.level = level;
    this.spec = levelSpec(level);
    this.waves = waveTable(level);
    this.grid = new Grid(this.mazeFor(level), this.geom);
    this.noUp = this.mazeFor(level).noUp || [];

    this.waveIndex = 0;
    this.waveT = this.waves[0];
    this.mode = GMODE.SCATTER;
    this.frightT = 0;
    this.ghostChain = 0;
    this.dotsEaten = 0;
    this.globalRelease = -1;      // -1 = per-ghost counters in force
    this.releaseIdle = 0;
    this.fruit = null;
    this.fruitT = 0;
    this.popups = [];

    this.resetActors();
    this.state = STATE.READY;
    this.timer = 0;
  };

  Game.prototype.resetActors = function () {
    var s = this.geom.SPAWN.player;
    this.player.placeAt(s.col, s.row);
    this.player.dir = DIR.left;
    this.player.want = null;
    this.player.glide = null;
    this.player.anim = 0;

    this.mode = GMODE.SCATTER;
    this.waveIndex = 0;
    this.waveT = this.waves[0];
    this.frightT = 0;
    this.ghostChain = 0;
    this.releaseIdle = 0;

    for (var i = 0; i < 4; i++) this.ghosts[i].reset(this.mode);
    // A life lost mid-level re-arms the release counters globally rather
    // than per ghost, exactly as the original does — it is why the house
    // empties faster after a death.
    this.globalRelease = this.dotsEaten > 0 ? 0 : -1;
  };

  Game.prototype.isNoUp = function (c, r) {
    for (var i = 0; i < this.noUp.length; i++)
      if (this.noUp[i][0] === c && this.noUp[i][1] === r) return true;
    return false;
  };

  /* ---- speeds --------------------------------------------------------- */
  Game.prototype.playerSpeed = function () {
    return BASE_SPEED * (this.frightT > 0 ? this.spec.pacF : this.spec.pac);
  };

  Game.prototype.ghostSpeed = function (gh) {
    if (gh.mode === GMODE.EYES) return BASE_SPEED * 2;
    var t = gh.tile();
    var inTunnel = t.r === this.geom.TUNNEL_ROW && (t.c <= 5 || t.c >= 22);
    if (inTunnel) return BASE_SPEED * this.spec.tun;
    if (gh.mode === GMODE.FRIGHT) return BASE_SPEED * this.spec.ghF;

    var mult = this.spec.gh;
    if (gh.index === 0) {                      // Elroy
      if (this.grid.pellets <= this.spec.elroy2) mult = this.spec.gh + 0.10;
      else if (this.grid.pellets <= this.spec.elroy1) mult = this.spec.gh + 0.05;
    }
    return BASE_SPEED * mult;
  };

  /* ---- ghost release --------------------------------------------------
     Ghosts leave the house on a dot counter, with a stall timer as a
     backstop. Without the backstop, a player who simply stops eating can
     park the whole game — the original's fix was a four-second idle timer
     and it is reproduced here.
     --------------------------------------------------------------------- */
  Game.prototype.wantsRelease = function (gh) {
    if (gh.index === 0) return true;                    // red never waits
    if (this.releaseIdle > (this.level < 5 ? 240 : 180)) return true;

    if (this.globalRelease >= 0) {
      var GLOBAL = [0, 7, 17, 32];
      return this.globalRelease >= GLOBAL[gh.index];
    }
    return this.dotsEaten >= this.spec.release[gh.index];
  };

  /* ---- mode switching -------------------------------------------------- */
  Game.prototype.updateModes = function () {
    if (this.frightT > 0) {
      this.frightT--;
      if (this.frightT === 0) {
        for (var i = 0; i < 4; i++)
          if (this.ghosts[i].mode === GMODE.FRIGHT) {
            this.ghosts[i].mode = this.mode;
            this.ghosts[i].lastC = -1;
          }
        this.ghostChain = 0;
      }
      return;                                   // the wave clock stops while frightened
    }

    if (this.waveT < 0) return;                 // final wave: chase forever
    if (--this.waveT > 0) return;

    this.waveIndex++;
    this.mode = this.mode === GMODE.SCATTER ? GMODE.CHASE : GMODE.SCATTER;
    this.waveT = this.waves[this.waveIndex] === undefined ? -1 : this.waves[this.waveIndex];

    // Every mode flip forces the loose ghosts to turn around. This single
    // rule is what creates the game's rhythm of pressure and relief.
    for (var j = 0; j < 4; j++) {
      var gh = this.ghosts[j];
      if (gh.isHoused() || gh.mode === GMODE.EYES) continue;
      gh.mode = this.mode;
      gh.dir = { x: -gh.dir.x, y: -gh.dir.y, name: "rev" };
      gh.pending = null;
      gh.lastC = -1; gh.lastR = -1;
    }
  };

  Game.prototype.energize = function () {
    var f = this.spec.frightFrames;
    this.ghostChain = 0;
    if (f <= 0) return;                          // late levels: no reprieve
    this.frightT = f;
    for (var i = 0; i < 4; i++) {
      var gh = this.ghosts[i];
      if (gh.isHoused() || gh.mode === GMODE.EYES) continue;
      gh.mode = GMODE.FRIGHT;
      gh.dir = { x: -gh.dir.x, y: -gh.dir.y, name: "rev" };
      gh.pending = null;
      gh.lastC = -1; gh.lastR = -1;
    }
    this.sound && this.sound.fright();
  };

  /* ---- scoring -------------------------------------------------------- */
  Game.prototype.addScore = function (n) {
    this.score += n;
    if (this.score > this.best) this.best = this.score;
    if (!this.extraAwarded && this.score >= 10000) {
      this.extraAwarded = true;
      this.lives++;
      this.sound && this.sound.extra();
    }
  };

  Game.prototype.popup = function (text, x, y, color) {
    this.popups.push({ text: text, x: x, y: y, color: color || "#31d8f0", t: 60 });
  };

  /* ---- loop ----------------------------------------------------------- */
  Game.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    this.input.bind();
    this.last = 0;
    this.acc = 0;
    var self = this;

    this.input.on(function (code) {
      if (code === "KeyP") self.paused = !self.paused;
      if (code === "KeyM" && self.sound) self.sound.toggle();
      if ((code === "Enter" || code === "Space") && self.state === STATE.OVER)
        self.opts.onRestart && self.opts.onRestart();
    });

    var loop = function (ts) {
      if (!self.running) return;
      if (!self.last) self.last = ts;
      var dt = ts - self.last;
      self.last = ts;
      // A backgrounded tab hands back a huge dt; clamp it so the game never
      // fast-forwards through five seconds of ghosts the moment it refocuses.
      if (dt > 250) dt = STEP_MS;
      self.acc += dt;
      var guard = 0;
      while (self.acc >= STEP_MS && guard++ < 8) {
        if (!self.paused) self.tick();
        self.acc -= STEP_MS;
      }
      self.render();
      self.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  };

  Game.prototype.stop = function () {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.input.unbind();
    this.sound && this.sound.stop();
  };

  Game.prototype.tick = function () {
    this.frame++;
    this.timer++;

    for (var p = this.popups.length - 1; p >= 0; p--)
      if (--this.popups[p].t <= 0) this.popups.splice(p, 1);

    if (this.state === STATE.READY) {
      if (this.timer > 110) { this.state = STATE.PLAY; this.timer = 0; }
      return;
    }
    if (this.state === STATE.CLEAR) {
      if (this.timer > 140) this.loadLevel(this.level + 1);
      return;
    }
    if (this.state === STATE.DYING) {
      if (this.timer > 150) {
        this.lives--;
        if (this.lives <= 0) {
          this.state = STATE.OVER;
          this.timer = 0;
          this.opts.onGameOver && this.opts.onGameOver(this.score, this.level);
        } else {
          this.resetActors();
          this.state = STATE.READY;
          this.timer = 0;
        }
      }
      return;
    }
    if (this.state === STATE.OVER) return;

    // --- player ---
    this.player.speed = this.playerSpeed();
    var d = this.input.take();
    if (d) this.player.setWant(d);
    this.player.tryTurn(this.grid);
    var moving = !this.player.stuck(this.grid);
    if (moving) { this.player.advance(this.grid); this.player.anim++; }

    // --- eating ---
    var t = this.player.tile();
    var ate = this.grid.eat(t.c, t.r);
    if (ate) {
      this.dotsEaten++;
      if (this.globalRelease >= 0) this.globalRelease++;
      this.releaseIdle = 0;
      this.sound && this.sound.chomp();
      if (ate === ".") this.addScore(10);
      else { this.addScore(50); this.energize(); }

      // fruit appears twice a level, at the classic thresholds
      var eaten = this.grid.total - this.grid.pellets;
      if ((eaten === 70 || eaten === 170) && !this.fruit) {
        this.fruit = FRUIT[Math.min(this.level - 1, FRUIT.length - 1)];
        this.fruitT = 60 * 10;
      }
    } else {
      this.releaseIdle++;
    }

    // --- fruit ---
    if (this.fruit) {
      if (--this.fruitT <= 0) this.fruit = null;
      else {
        var fc = this.geom.SPAWN.house.col * T, fr = 17 * T + T / 2;
        if (Math.abs(this.player.x - fc) < 7 && Math.abs(this.player.y - fr) < 7) {
          this.addScore(this.fruit.value);
          this.popup(String(this.fruit.value), fc, fr, this.fruit.color);
          this.sound && this.sound.fruit();
          this.fruit = null;
        }
      }
    }

    // --- ghosts ---
    this.updateModes();
    this.sound.updateSiren(
      1 - (this.grid.pellets / this.grid.total),
      this.state === STATE.PLAY && this.frightT === 0
    );
    for (var i = 0; i < 4; i++) this.ghosts[i].update(this.grid, this);

    // Collisions are resolved after every actor has moved, so a head-on
    // swap can't tunnel through: check both the post-move overlap and the
    // pre-move tiles.
    for (var k = 0; k < 4; k++) {
      var gh = this.ghosts[k];
      if (gh.isHoused() || gh.mode === GMODE.EYES) continue;
      var dx = Math.abs(gh.x - this.player.x);
      if (dx > COLS * T / 2) dx = COLS * T - dx;          // across the tunnel seam
      var dy = Math.abs(gh.y - this.player.y);
      if (dx * dx + dy * dy > 49) continue;

      if (gh.edible()) {
        this.ghostChain++;
        var pts = 200 * Math.pow(2, Math.min(this.ghostChain - 1, 3));
        this.addScore(pts);
        this.popup(String(pts), gh.x, gh.y, "#31d8f0");
        gh.mode = GMODE.EYES;
        gh.lastC = -1; gh.lastR = -1;
        this.sound && this.sound.eatGhost();
      } else {
        this.state = STATE.DYING;
        this.timer = 0;
        this.sound && this.sound.death();
        return;
      }
    }

    if (this.grid.pellets === 0) {
      this.state = STATE.CLEAR;
      this.timer = 0;
      this.sound && this.sound.levelClear();
    }
  };

  /* ---- rendering ------------------------------------------------------ */
  Game.prototype.render = function () {
    var g = this.g;
    g.fillStyle = "#000";
    g.fillRect(0, 0, VIEW_W, VIEW_H);

    // On level clear the maze walls flash — the one moment of celebration
    // the game gives you.
    var flash = this.state === STATE.CLEAR && Math.floor(this.timer / 12) % 2 === 1;
    if (!flash) this.grid.drawWalls(g);

    if (this.state !== STATE.CLEAR)
      this.grid.drawPellets(g, (this.frame % 20) < 12);

    if (this.fruit && this.state === STATE.PLAY) this.drawFruit(g);

    if (this.state !== STATE.CLEAR && this.state !== STATE.OVER) {
      if (this.state !== STATE.DYING)
        for (var i = 3; i >= 0; i--) this.ghosts[i].draw(g, this);
      this.player.draw(g, this.state === STATE.DYING, this.timer / 90);
    }

    for (var p = 0; p < this.popups.length; p++) {
      var pu = this.popups[p];
      this.g.globalAlpha = Math.min(1, pu.t / 30);
      this.text(pu.text, pu.x, MAZE_Y + pu.y - 3, pu.color, "center");
      this.g.globalAlpha = 1;
    }

    this.drawHud();

    if (this.state === STATE.READY) {
      this.banner("LEVEL " + String(this.level).padStart(2, "0") +
        "  //  " + this.grid.def.name, this.grid.def.wall, -2 * T);
      this.banner("READY", COLOR.ready);
    }
    if (this.state === STATE.OVER) this.banner("GAME OVER", COLOR.over);
    if (this.state === STATE.CLEAR && this.timer < 60)
      this.banner("LEVEL " + String(this.level).padStart(2, "0") + " CLEAR", "#76b900");
    if (this.paused) this.banner("PAUSED", COLOR.hud);
  };

  Game.prototype.drawFruit = function (g) {
    var x = this.geom.SPAWN.house.col * T, y = MAZE_Y + 17 * T + T / 2;
    g.fillStyle = this.fruit.color;
    g.beginPath();
    g.roundRect ? g.roundRect(x - 5, y - 4, 10, 8, 2) : g.rect(x - 5, y - 4, 10, 8);
    g.fill();
    g.fillStyle = "#000";
    g.font = "5px 'JetBrains Mono', ui-monospace, monospace";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(this.fruit.name.slice(0, 4), x, y + 0.5);
    g.textBaseline = "top";
  };

  Game.prototype.text = function (str, x, y, color, align) {
    var g = this.g;
    g.fillStyle = color || COLOR.hud;
    g.font = "7px 'JetBrains Mono', ui-monospace, monospace";
    g.textAlign = align || "left";
    g.textBaseline = "top";
    g.fillText(str, x, y);
  };

  Game.prototype.drawHud = function () {
    this.text("SCORE", 8, 2, COLOR.dim);
    this.text(String(this.score).padStart(6, "0"), 8, 11);
    this.text("HIGH", VIEW_W / 2, 2, COLOR.dim, "center");
    this.text(String(this.best).padStart(6, "0"), VIEW_W / 2, 11, COLOR.hud, "center");
    this.text("LEVEL", VIEW_W - 8, 2, COLOR.dim, "right");
    this.text(String(this.level).padStart(2, "0"), VIEW_W - 8, 11, COLOR.hud, "right");

    var g = this.g;
    for (var i = 0; i < Math.min(this.lives - 1, 5); i++) {
      g.save();
      g.translate(14 + i * 16, VIEW_H - 9);
      g.fillStyle = COLOR.player;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, 6, 0.35, Math.PI * 2 - 0.35);
      g.closePath();
      g.fill();
      g.restore();
    }
    this.text(this.mode === GMODE.SCATTER ? "SCATTER" : "CHASE",
      VIEW_W - 8, VIEW_H - 13, this.frightT > 0 ? "#31d8f0" : COLOR.dim, "right");
  };

  Game.prototype.banner = function (str, color, dy) {
    var y = MAZE_Y + 20 * T + 2 + (dy || 0);
    this.g.font = "8px 'JetBrains Mono', ui-monospace, monospace";
    this.g.textAlign = "center";
    this.g.fillStyle = color;
    this.g.fillText(str, VIEW_W / 2, y);
  };

  // ---- exports ---------------------------------------------------------
  NS.T = T;
  NS.COLS = COLS;
  NS.ROWS = ROWS;
  NS.VIEW_W = VIEW_W;
  NS.VIEW_H = VIEW_H;
  NS.MAZE_Y = MAZE_Y;
  NS.BASE_SPEED = BASE_SPEED;
  NS.DIR = DIR;
  NS.STATE = STATE;
  NS.Grid = Grid;
  NS.Entity = Entity;
  NS.Player = Player;
  NS.Sound = Sound;
  NS.Game = Game;

})(typeof self !== "undefined" ? self : this);
