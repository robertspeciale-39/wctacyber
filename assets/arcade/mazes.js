/* =====================================================================
   WCTA ARCADE — maze data
   ---------------------------------------------------------------------
   Every maze is 28 columns x 31 rows, matching arcade geometry so the 8px
   tile grid renders at 224x248 and scales by whole integers.

   Mazes are authored as 14-column LEFT HALVES and mirrored at load time.
   Storing halves is not just brevity: it makes left/right symmetry a
   property of the format rather than something a later edit can quietly
   break on one row.

   Legend
     #   wall
     .   dot            (10 pts)
     o   energizer      (50 pts, frightens the ghosts)
     ' ' open floor, no pellet
     -   ghost-house door  (ghosts pass, the player does not)
     X   ghost-house interior floor

   Invariants every maze holds to (enforced by tools/validate-mazes.mjs):
     - rows 11-17 across cols 9-18 are identical in every maze: that block
       is the ghost house, its door, and the corridors that feed them
     - row 14 is the tunnel: open to both edges, and never carries pellets
     - exactly 4 energizers, and every pellet reachable from the spawn
   ===================================================================== */
(function (root, factory) {
  var mod = factory();
  if (typeof module === "object" && module.exports) module.exports = mod;
  else (root.WCTAArcade = root.WCTAArcade || {}).MAZES = mod;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Tiles a ghost may not turn upward on. This is the one piece of arcade
  // trivia players feel constantly without ever being able to name it: it
  // is why certain corridors are survivable at all.
  var STD_NO_UP = [[12, 11], [15, 11], [12, 17], [15, 17]];

  // The fixed middle block, rows 11-17. Shared by every maze so the ghost
  // house, its door, and the tunnel always behave identically.
  var CORE = [
    /* 11 */ "######.##.....",
    /* 12 */ "######.##.###-",
    /* 13 */ "######.##.#XXX",
    /* 14 */ "          #XXX",
    /* 15 */ "######.##.#XXX",
    /* 16 */ "######.##.####",
    /* 17 */ "######.##....."
  ];

  function build(name, wall, top, bottom) {
    return {
      name: name,
      wall: wall,
      half: [].concat(["##############"], top, CORE, bottom, ["##############"]),
      noUp: STD_NO_UP
    };
  }

  var MAZES = [
    // ---- 01 ---------------------------------------------------------
    build("SUBNET", "#1e5cff", [
      /*  1 */ "#............#",
      /*  2 */ "#.####.#####.#",
      /*  3 */ "#o####.#####.#",
      /*  4 */ "#.####.#####.#",
      /*  5 */ "#.............",
      /*  6 */ "#.####.##.####",
      /*  7 */ "#.####.##.####",
      /*  8 */ "#......##....#",
      /*  9 */ "######.#####.#",
      /* 10 */ "######.#####.#"
    ], [
      /* 18 */ "######.##.####",
      /* 19 */ "######.##.####",
      /* 20 */ "#............#",
      /* 21 */ "#.####.#####.#",
      /* 22 */ "#.####.#####.#",
      /* 23 */ "#o..##....... ",
      /* 24 */ "###.##.##.####",
      /* 25 */ "###.##.##.####",
      /* 26 */ "#......##....#",
      /* 27 */ "#.##########.#",
      /* 28 */ "#.##########.#",
      /* 29 */ "#............."
    ]),

    // ---- 02 ---------------------------------------------------------
    // Wider halls up top, a pillared lower field. Fewer long straights than
    // 01, so the ghosts cut you off more often.
    build("VLAN", "#00b3a4", [
      /*  1 */ "#....##......#",
      /*  2 */ "#.##.##.####.#",
      /*  3 */ "#o##.........#",
      /*  4 */ "#.##.####.##.#",
      /*  5 */ "#....#....##.#",
      /*  6 */ "####.#.##....#",
      /*  7 */ "#......##.##.#",
      /*  8 */ "#.####....##.#",
      /*  9 */ "#.####.##....#",
      /* 10 */ "#......##.####"
    ], [
      /* 18 */ "######.##.####",
      /* 19 */ "#.........#..#",
      /* 20 */ "#.######.##..#",
      /* 21 */ "#.#....#....##",
      /* 22 */ "#.#.##.####..#",
      /* 23 */ "#o..##....... ",
      /* 24 */ "##.###.##.##.#",
      /* 25 */ "#......##....#",
      /* 26 */ "#.##########.#",
      /* 27 */ "#.#........#.#",
      /* 28 */ "#.#.######.#.#",
      /* 29 */ "#............."
    ]),

    // ---- 03 ---------------------------------------------------------
    // Tight and lattice-like. The safe pockets are smaller and there are
    // more decision points per second.
    build("DMZ", "#8b5cf6", [
      /*  1 */ "#......##....#",
      /*  2 */ "#.####.##.##.#",
      /*  3 */ "#o#..........#",
      /*  4 */ "#.#.####.###.#",
      /*  5 */ "#...#..#...#.#",
      /*  6 */ "###.#..#.#.#.#",
      /*  7 */ "#.....##...#.#",
      /*  8 */ "#.###....#...#",
      /*  9 */ "#.###.##.#.###",
      /* 10 */ "#......#.....#"
    ], [
      /* 18 */ "######.##.####",
      /* 19 */ "#....#.##....#",
      /* 20 */ "#.##.......#.#",
      /* 21 */ "#.##.####.##.#",
      /* 22 */ "#....#..#....#",
      /* 23 */ "#o##......... ",
      /* 24 */ "#.##.##.####.#",
      /* 25 */ "#....##......#",
      /* 26 */ "#.#######..###",
      /* 27 */ "#.......#....#",
      /* 28 */ "#.#####.####.#",
      /* 29 */ "#............."
    ]),

    // ---- 04 ---------------------------------------------------------
    // Long outer loops with very few cross-links: easy to run, brutal to
    // escape once a ghost commits to the same lap.
    build("HONEYPOT", "#f0c64a", [
      /*  1 */ "#............#",
      /*  2 */ "#.##########.#",
      /*  3 */ "#o#........#.#",
      /*  4 */ "#.#.######.#.#",
      /*  5 */ "#.#.#....#.#.#",
      /*  6 */ "#...#.##.#...#",
      /*  7 */ "###.#.##.#.###",
      /*  8 */ "#.....##.....#",
      /*  9 */ "#.###.##.###.#",
      /* 10 */ "#............#"
    ], [
      /* 18 */ "######.##.####",
      /* 19 */ "#......#.....#",
      /* 20 */ "#.#.#....#.#.#",
      /* 21 */ "#.#.######.#.#",
      /* 22 */ "#.#........#.#",
      /* 23 */ "#o#.#####.... ",
      /* 24 */ "#.#.#....###.#",
      /* 25 */ "#...#.##.....#",
      /* 26 */ "#.###.##.#.#.#",
      /* 27 */ "#........#...#",
      /* 28 */ "#.######.###.#",
      /* 29 */ "#............."
    ]),

    // ---- 05 ---------------------------------------------------------
    // Open centre, dense edges. Rewards players who have learned to lead
    // the ghosts rather than outrun them.
    build("ZERO DAY", "#ff2d20", [
      /*  1 */ "#.....##.....#",
      /*  2 */ "#.###.##.###.#",
      /*  3 */ "#o###.##.###.#",
      /*  4 */ "#............#",
      /*  5 */ "#.###.##.###.#",
      /*  6 */ "#.###.##.###.#",
      /*  7 */ "#.....##.....#",
      /*  8 */ "####.####.####",
      /*  9 */ "#......##....#",
      /* 10 */ "#..###.##.##.#"
    ], [
      /* 18 */ "######.##.####",
      /* 19 */ "#......##....#",
      /* 20 */ "#.##.####.##.#",
      /* 21 */ "#.....##.....#",
      /* 22 */ "#.###.##.###.#",
      /* 23 */ "#o###.##..... ",
      /* 24 */ "#............#",
      /* 25 */ "#.###.##.###.#",
      /* 26 */ "#.###.##.###.#",
      /* 27 */ "#.....##.....#",
      /* 28 */ "#.##########.#",
      /* 29 */ "#............."
    ])
  ];

  // Mirror each half into a full 28-wide row.
  function expand(maze) {
    if (maze.rows) return maze;
    maze.rows = maze.half.map(function (h) {
      return h + h.split("").reverse().join("");
    });
    return maze;
  }
  MAZES.forEach(expand);

  // ---- Shared geometry -------------------------------------------------
  var GEOM = {
    COLS: 28,
    ROWS: 31,
    TILE: 8,
    TUNNEL_ROW: 14,
    HOUSE: { x0: 10, y0: 12, x1: 17, y1: 15 },
    DOOR: { row: 12, cols: [13, 14] },
    // Spawn points in tile coordinates. A .5 means "on the seam between two
    // tiles" — the arcade's actual start offsets.
    SPAWN: {
      player: { col: 13.5, row: 23 },
      house: { col: 13.5, row: 14 },   // where eyes return to
      exit: { col: 13.5, row: 11 },   // tile just above the door
      ghosts: [
        { col: 13.5, row: 11, home: true },  // SCANNER starts outside
        { col: 13.5, row: 14 },              // SPOOF,   centre of house
        { col: 11.5, row: 14 },              // SNIFFER, left
        { col: 15.5, row: 14 }               // WORM,    right
      ]
    },
    // Scatter corners are target *tiles*, so they use {c,r} like every other
    // target in the pathfinder — not the {col,row} of the spawn points above.
    // Mixing the two silently yields NaN distances and ghosts that appear to
    // wander during scatter instead of retreating.
    SCATTER: [
      { c: 25, r: 0 },   // SCANNER -> top right
      { c: 2, r: 0 },   // SPOOF   -> top left
      { c: 27, r: 30 },  // SNIFFER -> bottom right
      { c: 0, r: 30 }   // WORM    -> bottom left
    ]
  };

  return { MAZES: MAZES, GEOM: GEOM };
});
