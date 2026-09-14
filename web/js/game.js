/* SYNX Synthwave eXtreme racing
 * Game loop, camera, race rules and the whole post-processing chain.
 *
 * Race flow: controls card, 3-2-1 countdown, timed run to the finish gantry,
 * personal best in the save file. The chase camera damps height and rotation
 * separately so it swings behind the car rather than snapping to it.
 */
(function (global) {
  'use strict';

  const { M, V3, M4 } = global.NR;
  const G = global.NR.gl;
  const U = G.U;

  const CAM = {
    distance: 11.0,
    height: 3.6,
    targetHeightRatio: 0.5,
    heightDamping: 12.0,
    rotationDamping: 3.0,
    baseFov: 70,
    boostFov: 12,
    near: 1.0,
    /* THE DRIVER NEEDS A NEARER NEAR PLANE.

       A chase camera is eleven units behind the car, so a one-unit near plane
       costs nothing and buys depth precision across fifty kilometres of road -
       which is the right trade for that view and the reason it is set there.

       The eye in the seat has the wheel about half a unit in front of it and
       the screen pillars closer than that. At near = 1.0 the whole of the car
       around the driver falls in front of the near plane and is clipped away,
       which is a first-person view of nothing but road.

       Eight centimetres is close enough that none of it is clipped and far
       enough that the depth buffer still resolves the road: precision goes
       with the RATIO of far to near, and this view does not need to see 48 km
       down the course - the fog has closed long before that. */
    nearPov: 0.08,
    far: 50000.0,
  };

  /* THE THREE VIEWS, and what each one is for.
   *
   *   CHASE    the default. A boom behind and above the car, damped, with the
   *            whole speed-and-shake rig on it. It is the view the game is
   *            balanced around: you can see the car's attitude, which is how
   *            you read a slide.
   *   DRIVER   from behind the wheel, at the eye of the figure in the seat.
   *            No boom, no distance, and the body's pitch and roll go
   *            straight into the eye rather than being damped out - which is
   *            most of why it feels faster without being faster.
   *   DRONE    high above and slightly behind, looking down. Reads the road
   *            ahead like a map, and is the only view that shows what the
   *            corner after the next one is doing.
   *
   * Ordered so C walks outward from the car: the driver is inside it, the
   * drone is furthest, chase is where you start and where you return.
   */
  const CAM_MODES = ['CHASE', 'DRIVER', 'DRONE'];
  /* WHERE THE CHOSEN VIEW APPLIES, WHICH IS NOT EVERYWHERE.
   *
   * Every menu in the game is drawn over the live world, and the world is
   * drawn by the same camera the player was last using. So picking the
   * driver view mid-race meant the title screen, the mode select, the
   * chapter hub and the multiplayer lobby all became a shot of the inside
   * of a bumper - and the drone view turned them into a map.
   *
   * None of those screens is about the car. They are backdrops, they are
   * composed for the chase camera, and they should look the same on every
   * launch no matter what happened in the last race. The preference is kept
   * and comes back the moment there is driving to do.
   */
  /* The states that are unambiguously NOT a run. Written as the menus rather
     than as the driving, because the driving half is not a fixed list: a
     chapter passes through "story" while the car is still being steered, and
     any list of driving states that leaves it out ends the run every time a
     character speaks. */
  const MENUS = { menu: 1, modeselect: 1, multiplayer: 1, controls: 1,
    loading: 1, confirm: 1, quit: 1 };
  /* A few degrees of downward bias on the driver's eye line, so the road
     sits in the upper two thirds rather than dead centre. The difference
     between looking AT the horizon and driving toward it.

     WHERE THE EYE IS is not here: it is derived from the head of the figure
     in the seat, on the core side, so that the two cannot disagree. See
     povCamera and crates/synx-core/src/driver.rs. */
  const POV_PITCH = -0.045;

  const BLOOM_LEVELS = 6;
  /* The highest texture unit any pass binds to. 0 albedo, 1 environment,
     2 normal, 3 headlight cookie, 4 emissive, 5-7 the shadow cascades,
     8 the reflection probe. */
  const MAX_TEX_UNIT = 8;
  // The sunset key light, in linear HDR. Everything downstream - the tyre
  // specular, the volumetric inscattering and the god rays - reads this.
  const SUN_COL = [1.00, 0.36, 0.30];
  /* Diffuse lighting budget. A flat road has to end up dark enough to read as
     night but bright enough that its texture survives its own reflection. The
     level used to carry a much larger ambient because there was nothing else
     lighting the tarmac; the headlights do that job now, so the fill can come
     down and let the neon be the brightest thing in frame. */
  const LIGHT = { ambient: 1.50, sun: 2.35 };

  const FX = {
    /* AgX takes a much wider range than the ACES fit did - it is defined over
       sixteen and a half stops - and its curve sits mid grey a little higher
       than the ACES fit did, so the same scene needs slightly LESS light into
       it to land in the same place. Measured against the old image rather
       than guessed. What the extra range buys is above the midtones: the neon
       now has ten stops of headroom to roll off through instead of two. */
    exposure: 0.72,
    /* The look on top of the display transform. The inset desaturates on the
       way in, so unity here would read flatter than the old image; 1.34 puts
       the chroma back and a little past it, which is the genre. */
    saturation: 1.34,
    contrast: 1.06,
    bloomThreshold: 1.30,
    bloomKnee: 0.60,
    bloomRadius: 1.0,
    bloomAmount: 0.155,
    anamorphic: 2.6,       // sideways stretch on the widest bloom levels
    fogDensity: 1 / 4200,   // aerial perspective: 1 / the range where it bites
    volDensity: 0.00016,    // volumetric march: scattering per unit length
    godrayAmount: 0.16,
    flareAmount: 0.055,
    aoRadius: 4.2,          // world units: a contact cue, not a global one
    aoAmount: 0.95,
  };

  /* Levels.
   *
   * The original ships one course - a single 22 km route through level2, and
   * level3 and level4 are UI scenes, not tracks. Short cuts of that source would be
   * sprints, not routes. The first four routes therefore live on the legacy
   * 80,000-unit generated course, and Level 5 extends it to 112,000 units without
   * regenerating any older sample. A route is twelve to thirty-two thousand
   * world units of it - several minutes
   * minutes of driving each, against a rival, with somewhere to get to.
   *
   * `from`/`to` are arc lengths along that centreline, and they line up with
   * the ZONES in js/scene.js, so a route is mostly one country: the coast road
   * at dusk, the canyon and its tunnels, the mesa under open sky, the city at
   * midnight, and finally that city breaking into a volcanic inferno. The palette carries the rest of it - the neon, the ground, the
   * haze, the key light and how much daylight is left all move together, so a
   * route reads as its own place rather than as the same road with a filter
   * over it.
   */
  const LEVELS = [
    {
      name: 'VECTOR RUN',
      from: 60, to: 13000,
      palette: {
        edge: [0.09, 0.58, 0.76], cap: [0.46, 0.07, 0.39],
        post: [0.52, 0.09, 0.36], sign: [1.0, 0.30, 0.62],
        ground: [0.30, 0.26, 0.42], grid: [0.34, 0.05, 0.62],
        arch: [0.14, 0.62, 0.86], tower: [0.30, 0.42, 0.85],
        fogTint: [1.00, 0.96, 1.00], sky: 0.62, ambient: 1.55,
        sun: [1.00, 0.36, 0.30], fogRange: 4200, wet: 0.32,
      },
    },
    {
      name: 'THE SPINE',
      from: 13000, to: 32000,
      palette: {
        edge: [0.72, 0.26, 0.05], cap: [0.09, 0.34, 0.56],
        post: [0.62, 0.24, 0.05], sign: [1.0, 0.62, 0.14],
        ground: [0.34, 0.22, 0.20], grid: [0.86, 0.22, 0.06],
        arch: [1.00, 0.52, 0.10], tower: [0.70, 0.30, 0.10],
        fogTint: [1.08, 0.84, 0.70], sky: 0.44, ambient: 1.20,
        sun: [1.00, 0.48, 0.22], fogRange: 2600, wet: 0.30,
      },
    },
    {
      name: 'MIRAGE CIRCUIT',
      from: 32000, to: 54000,
      palette: {
        edge: [0.10, 0.66, 0.58], cap: [0.50, 0.10, 0.66],
        post: [0.40, 0.10, 0.64], sign: [0.80, 0.30, 1.0],
        ground: [0.26, 0.24, 0.40], grid: [0.16, 0.62, 0.72],
        arch: [0.55, 0.20, 0.95], tower: [0.20, 0.60, 0.75],
        fogTint: [0.86, 0.92, 1.10], sky: 0.36, ambient: 1.05,
        sun: [0.62, 0.44, 1.00], fogRange: 5200, wet: 0.22,
      },
    },
    {
      name: 'SUNSET ZERO',
      from: 54000, to: 79900,
      palette: {
        /* Saturated, not pale. A near-white cap emissive drives every channel
           over the knee together, and after the tonemap that is not a cold
           white neon tube, it is a solid white bar with no colour left in it -
           which is what the city's barrier was doing to the whole left of the
           frame. */
        edge: [0.06, 0.36, 0.80], cap: [0.26, 0.40, 0.88],
        post: [0.24, 0.32, 0.74], sign: [0.55, 0.70, 1.0],
        ground: [0.19, 0.20, 0.30], grid: [0.14, 0.36, 0.88],
        arch: [0.85, 0.86, 0.95], tower: [0.36, 0.52, 1.00],
        fogTint: [0.76, 0.84, 1.18], sky: 0.20, ambient: 0.86,
        sun: [0.42, 0.50, 1.00], fogRange: 2000, wet: 0.58,
      },
    },
    {
      name: 'ASHFALL ZERO',
      from: 79900, to: 111500,
      level5: true,
      palette: {
        edge: [0.04, 0.38, 0.92], cap: [0.54, 0.06, 0.72],
        post: [0.24, 0.25, 0.80], sign: [0.68, 0.80, 1.00],
        ground: [0.12, 0.13, 0.20], grid: [0.10, 0.28, 0.92],
        arch: [0.75, 0.82, 1.00], tower: [0.30, 0.48, 1.00],
        fogTint: [0.56, 0.68, 1.12], sky: 0.18, ambient: 0.80,
        sun: [0.34, 0.46, 1.00], fogRange: 1700, wet: 0.62,
        volcano: [0.15, 0.075, 0.055], lava: [1.00, 0.12, 0.012],
      },
      paletteDawn: {
        edge: [0.08, 0.55, 0.88], cap: [0.90, 0.18, 0.25],
        post: [0.48, 0.19, 0.30], sign: [1.00, 0.46, 0.22],
        ground: [0.20, 0.14, 0.15], grid: [0.88, 0.16, 0.07],
        arch: [0.92, 0.37, 0.18], tower: [0.66, 0.23, 0.16],
        fogTint: [1.06, 0.62, 0.50], sky: 0.58, ambient: 1.14,
        sun: [1.00, 0.34, 0.15], fogRange: 2500, wet: 0.40,
        volcano: [0.20, 0.085, 0.055], lava: [1.00, 0.16, 0.012],
      },
      paletteDay: {
        edge: [0.94, 0.20, 0.025], cap: [1.00, 0.055, 0.012],
        post: [0.66, 0.10, 0.035], sign: [1.00, 0.52, 0.10],
        ground: [0.18, 0.070, 0.052], grid: [1.00, 0.11, 0.006],
        arch: [1.00, 0.30, 0.055], tower: [0.32, 0.095, 0.065],
        fogTint: [0.88, 0.31, 0.17], sky: 0.90, ambient: 1.28,
        sun: [1.00, 0.34, 0.08], fogRange: 2700, wet: 0.08,
        volcano: [0.12, 0.040, 0.030], lava: [1.00, 0.15, 0.006],
      },
    },
    {
      name: 'AURORA FORGE',
      from: 112080, to: 131300,
      level6: true,
      /* THIS ROUTE HAS A ROOF ON IT.

         Reported: the drone view on Aurora Forge shows the top of the
         production hall and not the car. It is not a camera bug - the camera
         is exactly where it was asked to be, twenty-six units up, and the
         hall's roof panels are at 17.35 with the ridge at 21.2. The drone was
         simply outside the building.

         Fourteen keeps it under the roof and well over the tallest thing on
         the floor - the balers' beacons top out at 14.1 and the stamping
         gantries at 14.7, so this rides just above the machinery and below the
         structure. A route with open sky leaves this undefined and gets the
         full height. */
      droneCeiling: 13.6,
      palette: {
        edge: [0.04, 0.46, 0.72], cap: [0.06, 0.22, 0.38],
        barrier: [0.032, 0.042, 0.050], barrierGlow: [0.002, 0.010, 0.015],
        post: [0.08, 0.34, 0.52], sign: [0.24, 0.88, 1.00],
        ground: [0.13, 0.15, 0.18], grid: [0.04, 0.36, 0.56],
        arch: [0.16, 0.74, 0.92], tower: [0.12, 0.30, 0.40],
        fogTint: [0.72, 0.86, 0.94], sky: 0.05, ambient: 0.74,
        sun: [0.34, 0.48, 0.58], fogRange: 1350, wet: 0.20,
      },
    },
    {
      name: 'NEON HORIZON',
      from: 132070, to: 173000,
      level7: true,
      /* The expressway is open above, but every arch, gate and portal on it
         spans the deck with RING_CLEAR of headroom - so a drone above them
         watches the car through a row of rings. Just under that clearance puts
         the camera inside the架 structure with the car, which is what a
         top-down view of this route should be. */
      droneCeiling: 11.5,
      coursePreview: true,
      distanceKm: 30.00,
      roadHalf: 32,
      driveHalf: 30,
      palette: {
        edge: [0.02, 0.55, 1.00], cap: [0.80, 0.055, 0.54],
        barrier: [0.018, 0.025, 0.060], barrierGlow: [0.015, 0.08, 0.18],
        post: [0.22, 0.08, 0.50], sign: [0.20, 0.88, 1.00],
        ground: [0.045, 0.035, 0.105], grid: [0.02, 0.30, 0.92],
        arch: [0.88, 0.08, 0.62], tower: [0.12, 0.42, 1.00],
        fogTint: [0.42, 0.52, 1.02], sky: 0.07, ambient: 0.67,
        sun: [0.30, 0.40, 1.00], fogRange: 3300, wet: 0.72,
      },
    },
  ];

  const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'IMPOSSIBLE'];

  /* ====================================================================== *
   *                           THE STUNT COURSE                             *
   * ====================================================================== *
   *
   * EVERY LAUNCH RAMP ON THE ROAD, IN ONE TABLE.
   *
   * They used to live inside Chapter 7's closure, which made them three
   * scripted props in a finale rather than a thing the road does. Three
   * consequences followed from that and all of them were wrong:
   *
   *   only the PLAYER was ever launched. The solver's ramp is a window
   *   installed on one car, and the chapter installed it on `g.car` and
   *   nothing else - so a rival met a full-width concrete ramp and drove
   *   through it, which is the single most obvious way to tell a player that
   *   the car beside them is not in the same world they are;
   *
   *   only ONE ROUTE had any. Six of the seven never met one;
   *
   *   and the geometry, the arming and the scoring were three copies of the
   *   same arc lengths in three places.
   *
   * The table is the single source now. `Game.updateRamps` arms whichever one
   * is next for EVERY car that is being simulated - the player, the rival and
   * Chapter 4's invitational grid - js/scene.js builds the structure from the
   * same rows, and the core's driver reads the window off the car it is
   * driving (see `RAMP_SET_UP` in ai.rs) so it sets up for the jump, holds its
   * line up the incline and spends its air control on landing straight.
   *
   * WHERE THEY ARE is not a matter of taste. A ramp needs a straight to be
   * taken on and a straight to come down on: the sites below were selected by
   * sweeping the finished centreline for spans with no tunnel and no curvature
   * tighter than a 1,800-unit radius for 300 units before the lip and 460
   * after it, which is comfortably more than the ~100 units a launch at deck
   * speed actually flies. AURORA FORGE is deliberately empty: it is an indoor
   * production hall whose whole length is somebody else's set piece.
   *
   *   s      where the lip is, in arc length
   *   len    how long the incline is. Longer is shallower and flatter; shorter
   *          throws the car higher and gives it less time to be straightened.
   *   h      the lip's height above the road
   *
   * They get gently harder across the campaign, and Chapter 7's three - which
   * keep the exact arc lengths, lengths and heights they shipped with - are
   * the top of that progression rather than a separate idea.
   */
  const COURSE_RAMPS = [
    { id: 'l1_seawall', level: 1, s: 1120,   len: 54, h: 2.8, name: 'SEAWALL LAUNCH' },
    { id: 'l2_spine',   level: 2, s: 23900,  len: 46, h: 3.4, name: 'SPINE LAUNCH' },
    /* ---------------------------------------------------- THE BLOCKED BORE --
     *
     * MIRAGE CIRCUIT's second tunnel is shut - the mouth is full of collapsed
     * shell and nobody has cleared it - and somebody has thrown a ramp up in
     * front of it out of scaffold, barrier blocks and steel plate.
     *
     * This is the one ramp on the course with a CREST: `crest` units of
     * shallow, drivable top that carry the car over the rubble before it runs
     * out of structure at `s`. That is the difference between getting past
     * something and jumping over it, and it is why the core's ramp grew an
     * `s2` - see the note above `Ramp` in crates/synx-core/src/vehicle.rs.
     *
     * The bore itself is dead straight (a 9,199-unit radius through it), which
     * is why this tunnel and not one of the other seventeen: the whole set
     * piece is a climb, a run along the top and a drop, and none of it wants a
     * corner underneath it. The landing is inside the bore on flat road,
     * between about 40,806 at a crawl and 40,889 flat out - clear of the spill,
     * which is scenery and ends at 40,798.
     */
    { id: 'l3_bore', level: 3, s: 40766, len: 106, h: 10.4,
      crest: 40, lip: 12.0, name: 'THE BLOCKED BORE',
      /* What it is built over, for js/scene.js: the bore mouth and how far the
         spill of rubble reaches back down the road. */
      bore: 40770, spill: 40798 },
    { id: 'l4_skyline', level: 4, s: 73900,  len: 40, h: 3.9, name: 'SKYLINE LAUNCH' },
    { id: 'l5_ashfall', level: 5, s: 94900,  len: 36, h: 4.2, name: 'ASHFALL LAUNCH' },
    /* NEON HORIZON's three, in the quiet stretch between the tunnel that ends
       at 162,294 and the first maze gate at 166,260.
       THEY HAVE MOVED, and the reason is the same sweep that sited the five
       above. A landing is scored on the heading error at touchdown, so what a
       site costs is the angle the ROAD turns through while the car is in the
       air - and measured over a 160-unit flight the three as they shipped came
       out at 3.4, 0.4 and 7.8 degrees. The tolerance is twelve degrees and the
       score is the square of what is left, so the best a perfect launch could
       have scored off LONG LAUNCH was 0.12 against a 0.62 threshold: it was
       not a hard clean landing, it was an unobtainable one, and the chapter
       has a line of dialogue for going three for three that could essentially
       never fire. The old site also put its landing zone 250 units short of
       the first maze gate.
       These three are 0.12, 0.32 and 0.12 degrees, they are 440 apart so the
       section reads as one run rather than three errands, and the lengths,
       heights, names and order are exactly what they were. */
    { id: 'jump_a',     level: 7, s: 164620, len: 46, h: 3.4, name: 'FIRST LAUNCH' },
    { id: 'jump_b',     level: 7, s: 165060, len: 38, h: 4.1, name: 'SECOND LAUNCH' },
    { id: 'jump_c',     level: 7, s: 165500, len: 32, h: 4.8, name: 'LONG LAUNCH' },
  ];
  /* ---------------------------------------------------- THE ATTRACT REEL --
   *
   * WHAT PLAYS BEHIND THE MENUS.
   *
   * The drive behind the title screen used to start wherever the car happened
   * to be and run forward for ever, wrapping at the end of the course. At
   * fifty-five units a second a lap is fifty-three minutes, so what it
   * actually showed was whichever kilometre of empty road the last race
   * finished on - and the eight launch ramps, the sealed bore, the elevated
   * city deck and every tunnel on the course went past about once an hour.
   *
   * This is a reel: stretches chosen because something happens on them, each
   * long enough to breathe and short enough that the next one arrives before
   * the eye gets bored, cut in order and looping. Every entry is measured to
   * ARRIVE at its set piece a few seconds in rather than opening on it, so the
   * cut lands on approach and the payoff lands while the player is reading the
   * menu rather than while the screen is still settling.
   */
  const ATTRACT_SPEED = 55;
  /* Published so the benchmark can drive the same stretches the title screen
     does - see js/bench.js. It picks its scenes by `kind` rather than by
     index, so re-cutting the reel moves the benchmark with it instead of
     silently changing what is being measured. */
  global.NR.ATTRACT_SPEED = ATTRACT_SPEED;

  /* THE SHOTS THE REEL IS CUT IN.
   *
   * Every mark is expressed in the CAR's own frame - `f` forward along its
   * nose, `s` to its right, `h` above it - with the look-at offset by `tf` and
   * `th`. `dolly` is how far the mark travels over the life of the shot, so a
   * held shot is a move rather than a still, and `hand` is how much of a
   * hand-held wobble rides on it.
   *
   * The chase camera was doing all of this work before, which is the right
   * camera for DRIVING and the wrong one for watching: it sits behind the car
   * at a fixed distance and shows the player the same three-quarter rear view
   * of their own boot lid for as long as the menu is open. A title screen is a
   * trailer. */
  const ATTRACT_SHOTS = {
    /* A long lens down the road, the car coming toward it.

       IT NEVER ARRIVED. A mark holds until the car passes the next one, and
       the approach marks are 150 units apart - two and a half seconds - so a
       dolly written to close 26 units over a full six-and-a-half-second hold
       only ever ran a third of its travel. The car came from 62 units to 51
       and the shot cut: a speck on a horizon, over half a frame of bare
       asphalt, for the whole of it.

       Shorter lens, closer start, and a dolly that closes in the time the
       shot is actually given - so it ends with the car most of the way to
       the lens, which is what an approach is. Lower, too: a camera at 2.3
       looking at 1.05 is angled down, and everything below the car in that
       frame is road. */
    approach: { f: 46, s: 3.0, h: 1.62, tf: 0, th: 1.15, fov: 40, dolly: [-30, 0.4, 0.10], hand: 0.16 },
    // low and ahead: what a launch is filmed from
    launch:   { f: 21, s: 2.2, h: 0.58, tf: 0, th: 1.20, fov: 46, dolly: [-9.0, 0.5, 0.06], hand: 0.34 },
    // riding the flank, drifting back
    flank:    { f: -1.5, s: 8.2, h: 2.05, tf: 4, th: 1.15, fov: 50, dolly: [-4.2, -1.6, 0.10], hand: 0.28 },
    // over the shoulder, pulling out
    chase:    { f: -10.5, s: 1.4, h: 3.30, tf: 16, th: 1.30, fov: 60, dolly: [-4.0, -0.6, 0.55], hand: 0.14 },
    /* Wide and high, descending - for the city and the deck.

       IT USED TO LOOK 26 UNITS PAST THE CAR. From thirteen units up and
       fourteen out that aims the lens down the road ahead and leaves the car
       itself 39 degrees off the axis, under the bottom of a 52 degree frame:
       a third of every crane in the reel was an establishing shot of a city
       with nothing driving through it. Nine units ahead and a unit up keeps
       the road running out of the top of the frame, which is what the mark is
       for, and keeps the car in it, which is what the reel is for. */
    crane:    { f: -13, s: 15, h: 17.0, tf: 9, th: 1.20, fov: 52, dolly: [7.0, -4.5, -5.2], hand: 0.10 },
    // close on the body, as it goes past
    detail:   { f: 3.4, s: 3.6, h: 1.32, tf: 0.4, th: 1.05, fov: 38, dolly: [-3.0, 0.5, 0.04], hand: 0.40 },
  };

  /* WHAT PLAYS BEHIND THE MENUS, AND HOW IT IS SHOT.
   *
   * `shots` is a running order keyed by arc length: the last mark whose
   * position the car has passed is the one the camera is on. Every entry ends
   * on a `launch` mark placed a few car lengths before its ramp, because the
   * jump is the thing worth cutting to and a camera that arrives after the
   * take-off has missed it. */
  const ATTRACT_REEL = [
    /* ------------------------------------ THE WHOLE GAME, IN ONE LOOP ----
     *
     * Six stretches in three flavours, alternating, so a player watching the
     * menu for a minute has seen everything this car does:
     *
     *   DRIFT   a real corner, taken sideways. The two here are the tightest
     *           on the course - ninety and ninety-four units of radius -
     *           picked by measuring how far the road turns through every
     *           620-unit window rather than by eye.
     *   JUMP    a launch ramp, and the structure is SHOWN. The reel used to
     *           be cut entirely around ramps and it was reported as ghost
     *           ramps: the `launch` mark is low and ahead, a ramp seen that
     *           way at two hundred units is a dark slab the eye does not
     *           separate from the road, and what it looked like was a car
     *           taking off from flat tarmac. Every jump here therefore opens
     *           on a FLANK mark - side on, where a wedge is unmistakably a
     *           wedge - before it cuts low for the take-off.
     *   FLAT    a straight, on the reheat. Two of the three flattest
     *           kilometres on the course, one through the city and one down
     *           the canyon, because a game about speed should show some.
     *
     * Nothing here is accidental: the corners and the straights were both
     * chosen by measurement, and tools/checkramps.js asserts that the only
     * stretches containing a ramp are the ones that mean to.
     */
    // the seawall hairpin: ninety-five units of radius, taken sideways
    { from: 5220, to: 6300, name: 'VECTOR RUN', kind: 'drift',
      shots: [[5220, 'crane'], [5480, 'flank'], [5820, 'detail'], [6060, 'chase']] },
    // ASHFALL's ramp, opened side-on so the ramp is a ramp before it is a jump
    { from: 94540, to: 95360, name: 'ASHFALL ZERO', kind: 'jump',
      shots: [[94540, 'approach'], [94700, 'flank'], [94850, 'launch'], [95010, 'chase']] },
    // the city at midnight, flat out
    { from: 76380, to: 77280, name: 'SUNSET ZERO', kind: 'flat',
      shots: [[76380, 'crane'], [76630, 'approach'], [76900, 'chase'], [77140, 'detail']] },
    // the canyon's right-hander, ninety-four units of radius between walls
    { from: 14000, to: 15080, name: 'THE SPINE', kind: 'drift',
      shots: [[14000, 'crane'], [14260, 'flank'], [14600, 'detail'], [14840, 'chase']] },
    /* MIRAGE CIRCUIT's sealed bore: a crude ramp built out of the rubble, a
       crest driven along, and a twelve-unit lip into the tunnel beyond. The
       best thing the menu has to show, and the one structure nobody could
       mistake for flat road - so it opens on the flank shot and holds it. */
    { from: 40380, to: 40900, name: 'THE BLOCKED BORE', kind: 'jump',
      shots: [[40380, 'approach'], [40540, 'flank'], [40680, 'launch'], [40800, 'chase']] },
    // ...and the canyon straight, on the reheat
    { from: 24600, to: 25500, name: 'THE SPINE', kind: 'flat',
      shots: [[24600, 'crane'], [24850, 'approach'], [25120, 'chase'], [25360, 'detail']] },
  ];

  /* How far before the lip a ramp is armed and its approach is painted. It has
     to be longer than the road a car covers while a player reads it, which at
     deck speed is about two seconds. */
  const RAMP_TELEGRAPH = 280;
  /* What a landing has to score to count as clean. The solver's `landing` is 1
     at dead straight and 0 at twelve degrees out, squared - so 0.62 is about
     four and a half degrees, which is tight enough to be worth doing and wide
     enough that a deliberate line through it lands it. */
  const RAMP_CLEAN = 0.62;
  /* A ramp a bumper behind the car is not the next one. */
  const RAMP_PAST = -14;

  /* ---------------------------------------------------------- FREE ROAM ----
   *
   * The campaign hands the player one route at a time, cut to the length of a
   * chapter. Free Roam hands them the road.
   *
   * Nothing underneath has to change for that, because the seven routes were
   * never seven courses: they are seven stretches of ONE centreline, running
   * unbroken from the seawall at arc length 60 to the last gantry at 173,000.
   * Driving from VECTOR RUN into NEON HORIZON without stopping is something
   * the geometry has always supported and nothing has ever asked it for.
   *
   * What a route actually owns is its LOOK - a palette, a fog range, a sun
   * bearing, a road width - and, for the last two, a world of their own. On a
   * Free Roam run those are interpolated into the next route's over the
   * kilometre before the handover instead of being swapped behind a loading
   * screen, and that is the whole trick: the coast road warms into the canyon,
   * the canyon cools into the mesa country, the city breaks into ash, and the
   * player never sees a seam where one route stopped and the next began.
   */

  /* Where one region hands over to the next.
   *
   * These are the routes' own start arc lengths, with two exceptions. Aurora
   * Forge's hall is generated from 112,000 and Neon Horizon's deck from
   * 132,000, both a little before the route they belong to nominally starts.
   * Handing over eighty units late would draw the old country underneath a
   * hall that has already begun, so the seam sits on the geometry. */
  const REGION_EDGES = LEVELS.map(l => l.from);
  REGION_EDGES[5] = 112000;
  REGION_EDGES[6] = 132000;
  const FREE_ROAM_END = LEVELS[LEVELS.length - 1].to;
  /* How far before a handover the next region's look starts bleeding in.
     1,250 units is about fourteen seconds at cruising speed - long enough to
     read as a change of country rather than as a cross-fade you can catch
     happening. */
  const REGION_BLEND = 1250;
  const UNITS_TO_KM = 0.000733;

  /* THE ASCENSION GATE.
   *
   * Six of the seven handovers are a change of palette and nothing else, and
   * the blend above makes those invisible. The last one is not: Neon Horizon
   * is an elevated deck over a city at -64, it cannot coexist with country
   * built to the shipped landscape's shape, and the generated ground it drops
   * is batched into 1,600-unit world tiles with no arc length on them. There
   * is no frame on which that exchange can be made and not be seen.
   *
   * So it is not hidden, it is STAGED. Visibility collapses into the gate over
   * the last two hundred and sixty units, the glare comes up with it, the
   * exchange happens at the bottom of that, and the deck opens out of the
   * light on the other side. Driving up into a bank of haze and coming out
   * above a megacity is a thing that happened to you; a city appearing on one
   * frame is a thing that happened to the renderer. */
  /* WHAT THE CAMPAIGN LEFT YOU.
     The Forge rebuilds the engine at the end of Chapter 6 and Javas hands over
     the synchronised drive with it, and Free Roam does not open until the
     campaign is finished - so on the open road both are simply yours. These
     are js/level6.js's own numbers, so the ability behaves identically in both
     places; what a tour does not get is the chapter's cinema around it. */
  const RACE_MODE_SECONDS = 30;
  const RACE_MODE_COOLDOWN = 70;
  const RACE_MODE_MULTIPLIER = 1.5;
  const RACE_MODE_RESERVE = 0.5;

  const GATE_IN = 260;        // units of closing in before the gate
  const GATE_OUT = 340;       // ...and of opening out after it
  const GATE_FOG = 300;       // fog range at the bottom of it
  const GATE_GLARE = 0.46;    // and how much light is in the air there
  const smoothstep = (t) => { t = M.clamp(t, 0, 1); return t * t * (3 - 2 * t); };

  /* HOW LIT A CAR'S BRAKE LAMPS SHOULD BE.
   *
   * The solver's `braking` is the pedal, and deliberately only the pedal - it
   * excludes the engine braking of a lifted throttle, which is correct for the
   * physics and not quite right for the lamps. A car shedding thirty miles an
   * hour on the way into a corner without touching the brake is still visibly
   * slowing down, and a following driver reads that from the lights.
   *
   * So the lamp takes whichever is greater: the pedal, or the car's own
   * longitudinal deceleration once it is past the threshold where lifting off
   * becomes braking. `accelLong` is in units per second squared and the solver
   * publishes it; twelve is about a third of a g, which is where a lift stops
   * being a lift.
   */
  function lampOf(car) {
    if (!car) return 0;
    const pedal = car.braking || 0;
    const decel = M.clamp((-(car.accelLong || 0) - 4) / 12, 0, 1);
    return Math.max(pedal, decel * 0.75);
  }

  /* WHERE A CAR'S ROAD WHEELS HAVE GOT TO.
   *
   * Three numbers, read straight off the solver, and the reason the cars
   * stopped looking like props being slid along the road. The two spin angles
   * are separate because the axles genuinely differ - the fronts lock under
   * braking while the rears turn, the rears light up under power while the
   * fronts only roll - and `steer` here is the RACK, not the driver's hands:
   * mid-slide the two point different ways, and the tyres follow the rack.
   *
   * Every field is optional on the far side, so a caller with no car - a
   * cinematic pose, a menu flyby - simply gets the shipped placement back.
   */
  const WHEEL_RADIUS = 0.45;          // matches Vehicle's, in world units
  function wheelsOf(car) {
    if (!car) return null;
    let spin = car.wheelSpin || 0;
    let spinFront = car.wheelSpinFront || 0;
    /* A CAR THE SIMULATION DOES NOT STEP STILL HAS TO HAVE WHEELS THAT TURN.
     *
     * A remote player in multiplayer is an ordinary Vehicle that is never
     * updated: its pose is written each frame by the interpolator, so every
     * field the solver would have integrated - these two included - stays
     * wherever it was. Read naively that is four welded wheels on every car
     * but your own, which is precisely the artefact the wheels were made to
     * turn to fix.
     *
     * Rather than plumb a flag down from the netcode, this notices: a car that
     * is plainly moving and whose accumulator did not move is a car nobody is
     * integrating, so it gets integrated here, from speed. It is self
     * correcting - the moment the solver does advance the value, the measured
     * delta is non-zero and the visual accumulator is abandoned - and it costs
     * one comparison for cars that never need it.
     */
    /* MEASURED FROM THE GROUND IT COVERED, NOT FROM ITS SPEEDOMETER.

       This used to read `car.speed` and integrate it, and latch onto doing so
       whenever the solver was idle and the speedometer said the car was
       moving. That is true of a remote car, which is the case it was written
       for - and it is also true of a car in a CUTSCENE, which is left exactly
       where the race ended with every field frozen at its last value,
       including a speed of a hundred and twenty. So the finish roll played
       over a stationary car with four wheels spinning at racing speed.

       Distance cannot lie about this the way a stale speed can: a car that
       has not moved has not turned its wheels, whoever is or is not stepping
       it. A remote car is moved every frame by the interpolator and still
       reads correctly - better, in fact, since the rotation now matches the
       ground covered exactly instead of an assumed speed times a delta. */
    const v = car.__wheelVis
      || (car.__wheelVis = { last: spin, own: spin, using: false, x: car.x, z: car.z });
    const dx = car.x - v.x, dz = car.z - v.z;
    v.x = car.x; v.z = car.z;
    if (Math.abs(spin - v.last) > 1e-9) {
      v.using = false;                 // the solver is driving it after all
    } else if (Math.abs(dx) + Math.abs(dz) > 1e-6) {
      v.using = true;
    }
    v.last = spin;
    if (v.using) {
      // how far it went along its own nose, which is what the tyre rolled
      const sy = Math.sin(car.yaw || 0), cy = Math.cos(car.yaw || 0);
      const along = dx * sy + dz * cy;
      v.own = (v.own + along / WHEEL_RADIUS) % (Math.PI * 2);
      spin = spinFront = v.own;
    }
    return { spin, spinFront, wheelSteer: car.steer || 0 };
  }

  /* Every vector a route's palette can carry. A blend has to move all of them
     together, or a half-blended route reads as one place lit by another. */
  const PALETTE_VECTORS = ['edge', 'cap', 'post', 'sign', 'ground', 'grid', 'arch',
    'tower', 'fogTint', 'sun', 'barrier', 'barrierGlow', 'volcano', 'lava'];
  const PALETTE_SCALARS = ['sky', 'ambient', 'fogRange', 'wet'];
  /* The default crash barrier, named rather than implied. Routes 6 and 7
     override it with powder-coated steel and the other five leave it out, in
     which case Scene.setPalette falls back to exactly these numbers - so
     writing them down here is what lets the barrier BLEND into the Forge's
     instead of snapping to it on one frame. */
  const DEFAULT_BARRIER = [0.34, 0.35, 0.44];
  const DEFAULT_BARRIER_GLOW = [0.02, 0.035, 0.075];

  function paletteVector(p, key) {
    if (p && p[key]) return p[key];
    if (key === 'barrier') return DEFAULT_BARRIER;
    if (key === 'barrierGlow') return DEFAULT_BARRIER_GLOW;
    return null;
  }

  /* Blend two route palettes.
     A key only one side carries - the volcanic rock and its lava, which exist
     on Ashfall and nowhere else - is HELD rather than faded away: the basin is
     still cut from the same stone on the frame the palette stops being
     Ashfall's, and fading `lava` to black would put the fire out halfway
     through a shot of it. */
  function mixPalette(a, b, t) {
    if (!b || t <= 0) return a;
    if (t >= 1) return b;
    const out = {};
    for (const k of PALETTE_VECTORS) {
      const va = paletteVector(a, k), vb = paletteVector(b, k);
      if (va && vb) out[k] = [M.lerp(va[0], vb[0], t), M.lerp(va[1], vb[1], t), M.lerp(va[2], vb[2], t)];
      else if (va || vb) out[k] = (va || vb).slice();
    }
    for (const k of PALETTE_SCALARS) {
      const va = a[k], vb = b[k];
      if (va !== undefined && vb !== undefined) out[k] = M.lerp(va, vb, t);
      else if (va !== undefined) out[k] = va;
      else if (vb !== undefined) out[k] = vb;
    }
    return out;
  }

  const RECORD_KEY = 'synx.record.v1';
  /* A tour of the whole road is not a time the route record can be compared
     against, so it banks its own. */
  const FREE_ROAM_RECORD_KEY = 'synx.freeroam.record.v1';
  /* What the open road's top opponent gets over the stock car. Chapter 7's
     hunt curve runs to 1.92 and is a scripted boss fight; this is a rival on
     an open road and is deliberately a fraction of it - enough that R-IX //
     IMPOSSIBLE is a different proposition from HARD rather than the same lap
     with a different label. Corner speed goes with the SQUARE ROOT of grip,
     which is why these are two numbers and not one. */
  const FREE_ROAM_RIX_PACE = 1.10;
  const FREE_ROAM_RIX_GRIP = 1.12;
  /* ------------------------------------------- THE OPEN ROAD'S SPEED DIAL --
   *
   * One ceiling per rung, in world units a second, written against what the
   * player actually does out here. Both cars leave the workshop with the Forge
   * engine, so a tour driven well averages about 86 on the throttle and the
   * reserve - ordinary boost is worth well under a unit a second averaged,
   * because the burn is too short to reach the higher ceiling - and about a
   * hundred while synchronised.
   *
   * These are handed to `rival.speedCap`, which the solver's `ceiling()` and
   * the driver's own planner both read. That matters: without a hard cap the
   * rival's top speed was decided by its boost thrust against its drag, which
   * is around 130, and every pace and grip number here was tuning something
   * that was not the binding constraint. EASY is a car to follow, MEDIUM is a
   * car to race, HARD is a car that is quicker than you, and the R-IX is the
   * one that hunted you.
   */
  const FREE_ROAM_TOP = [80, 86, 92, 98];
  /* ...and what a gap it is genuinely behind is worth. Squared on the way in,
     so being alongside costs nothing at all. */
  const FREE_ROAM_CHASE_TOP = [5, 9, 15, 22];
  /* THE WINDOW, out here as well.
   *
   * raceMode is the Chapter 6 reward and it has to mean the same thing on an
   * open road as it does in the finale: thirty seconds that buy you road. The
   * first version of this did the opposite - it read `synced` as a reason for
   * the rival to push HARDER, so spending the one ability the tour hands you
   * summoned a faster car. While the player is synchronised the ceiling is
   * held here and the chase term is switched off, and both come back the frame
   * the window closes. */
  const FREE_ROAM_MODE_TOP = [80, 86, 90, 94];
  /* What the R-IX spends when it is passed. Eleven units a second over its
     own ceiling, held for the length of the burst, which is a car arriving in
     your mirror rather than a car that was always there. */
  const FREE_ROAM_COUNTER_TOP = 109;

  /* States in which nobody is driving. The title screen, the options, the two
     front-of-house screens js/modeselect.js and js/freeroam.js own, and the
     load. What they have in common is the only thing anything asks: the menu
     theme plays over all of them, and none of them is a race. */
  const MENU_STATES = new Set(['loading', 'menu', 'controls', 'modeselect', 'freeroam', 'multiplayer']);
  const PROGRESS_KEY = 'synx.progress.v1';
  const SETTINGS_KEY = 'synx.settings.v1';
  /* The camera view, remembered between runs. Its own key rather than a
     settings row: it is changed mid-corner with one key, not configured on a
     screen, and putting it in the options table would put it on the launcher
     as well - where a view whose effect you cannot see is a row nobody can
     answer. */
  const CAM_KEY = 'synx.camera.v1';

  /* THE SETTINGS, AND WHERE THEY ARE DECLARED.
   *
   * Not here. js/settings.js carries every row - label, values, default and
   * hint - and both this screen and the launcher render from it. Two copies of
   * "NEON GLOW has four values and defaults to the third" is a guarantee that
   * one day it has five in one place and four in the other, and the symptom is
   * a saved index that means HEAVY on one screen and nothing on the other.
   *
   * WHAT LEFT THIS SCREEN
   *
   * WINDOW MODE, RENDERER and RENDER SCALE are gone from the options and live
   * on the launcher now. None of the three could honestly be changed from
   * inside a running game: a webview's graphics backend is fixed when its
   * environment is created, and a window's mode and size are fixed when it is
   * built. The RENDERER row used to say "takes effect on restart", which is a
   * control that does not work wearing a label that admits it rather than
   * being moved somewhere it does. See src-tauri/src/launcher.rs.
   *
   * They are still READ here - the render scale is what sizes the backing
   * store - they are simply not editable from this screen. */
  const SCHEMA = global.NR && global.NR.Settings;
  if (!SCHEMA) throw new Error('js/settings.js must load before js/game.js');
  const QUALITY = SCHEMA.QUALITY;
  const RENDER_SCALES = SCHEMA.RENDER_SCALES;
  /* Everything the CONTROLS screen shows that is a setting rather than a key
     binding: the gamepad rows on tab 1 and the mouse rows on tab 2. The
     keyboard's own rows are bindings and are built from ACTIONS below. */
  const SETTING_ROWS = SCHEMA.rowsFor('game').map((r) => Object.assign({}, r));
  for (const r of SETTING_ROWS) if (r.tab === undefined) r.tab = 1;

  /* EVERY ROW THIS BLOB CARRIES, which is not the same list.
   *
   * `SETTING_ROWS` is what the options screen DRAWS. This is what
   * `synx.settings.v1` STORES, and it is larger: RENDER SCALE and UPSCALER are
   * set on the launcher and read by the renderer here, so they live in this
   * file's blob without appearing on this file's screen.
   *
   * Loading and saving must walk this list rather than the drawn one. When
   * they walked the drawn one, opening the options screen once was enough to
   * drop every key it did not know about on the next write - so a player who
   * chose 67% and FSR on the launcher, then turned the music down in-game, got
   * NATIVE and BILINEAR back without touching either. */

  /* REDUNDANT VAO BINDS, REMOVED AT THE SOURCE.
   *
   * Both chapter worlds draw through a helper that binds a vertex array and
   * then draws one part: `bindVertexArray(p._mesh.vao); drawPart(p)`. That is
   * correct and it is also one GL call per draw for a value that almost never
   * changes - Chapter 7 draws several hundred boxes a frame and every one of
   * them comes from the same cube. Measured on the release build,
   * `bindVertexArray` was 75 ms of an eight-second profile, in two separate
   * entries of the top eighteen.
   *
   * WHY THE WRAPPER RATHER THAN THE CALL SITES. There are twenty-odd places
   * that bind a vertex array across the two chapter files and the scene, and a
   * cache that any one of them can bypass is a cache that eventually reports
   * the wrong array bound - which draws one mesh's indices against another
   * mesh's buffers, and looks like memory corruption rather than like a
   * missing invalidation. Wrapping the method makes the cache and the GL state
   * the same thing by construction, so there is no call site that can
   * disagree with it.
   *
   * `deleteVertexArray` clears it because deleting the bound array unbinds it
   * behind our back. Nothing in the game deletes one today; it is here so that
   * the day something does, this does not become a bug in an unrelated file.
   */
  /* ================================ THE REDUNDANT STATE FILTER =========
   *
   * Setting a piece of GL state to the value it already has is not free. It
   * is a call across the binding into the browser's GPU process, argument
   * validation, and on some drivers a shadow-state update - for a call that
   * changes nothing at all. A renderer that submits several hundred draws a
   * frame makes tens of thousands of these, and they are pure loss: the
   * picture is identical with them and without them, which is what makes
   * this safe to do at all.
   *
   * This started as the VAO alone. What it filters now is every piece of
   * GLOBAL state the renderer touches per draw - the program, the active
   * texture unit, the texture bound to each unit, and the pipeline switches -
   * because they are set the same way, by whoever needs them, without anyone
   * knowing what the last caller left behind. Measured on a lap of the
   * finale: see --probe glstate.
   *
   * WHAT IS DELIBERATELY NOT FILTERED, and why each one would be a bug:
   *
   *   bindBuffer. ELEMENT_ARRAY_BUFFER is not global state, it belongs to
   *   the vertex array object - so a cache of it is wrong the instant a
   *   different VAO is bound, and wrong in the worst way: the indices of
   *   one mesh drawn with the vertices of another.
   *
   *   uniforms. Uniform state belongs to the PROGRAM, so a cache would have
   *   to be keyed on program and location, and the values are mostly
   *   matrices that change every frame anyway. The bookkeeping would cost
   *   more than the calls.
   *
   *   anything with a side effect beyond the state itself - clears, draws,
   *   uploads. Obviously.
   *
   * AND IT HAS TO FORGET. A context loss resets every one of these to its
   * default, so a cache that survived one would suppress the calls that put
   * the state back. The listener below is the whole of that.
   */
  function memoiseVao(gl) {
    const raw = {
      bindVertexArray: gl.bindVertexArray.bind(gl),
      deleteVertexArray: gl.deleteVertexArray.bind(gl),
      useProgram: gl.useProgram.bind(gl),
      deleteProgram: gl.deleteProgram.bind(gl),
      activeTexture: gl.activeTexture.bind(gl),
      bindTexture: gl.bindTexture.bind(gl),
      deleteTexture: gl.deleteTexture.bind(gl),
      enable: gl.enable.bind(gl),
      disable: gl.disable.bind(gl),
      depthMask: gl.depthMask.bind(gl),
      depthFunc: gl.depthFunc.bind(gl),
      cullFace: gl.cullFace.bind(gl),
      frontFace: gl.frontFace.bind(gl),
      blendFunc: gl.blendFunc.bind(gl),
      viewport: gl.viewport.bind(gl),
    };
    /* What is currently set. Every one starts undefined rather than at its
       documented default, so the first call of each always reaches the driver
       - a cache that assumes the initial state is a cache that is wrong once
       per context for no reason. */
    let vao, prog, unit;
    let caps = null, depthW, depthF, cull, front, blendS, blendD, vpx, vpy, vpw, vph;
    let units = null;
    /* How many calls this has and has not passed on, for --probe glstate.
       Counted because "this is obviously faster" is how a renderer ends up
       with an optimisation that costs more than it saves. */
    const seen = { sent: 0, saved: 0 };
    /* WHAT THE CACHE BELIEVES, so it can be held against what the driver
       actually has. A redundant-call filter is exactly as correct as its
       model of the state, and a model that has drifted does not produce an
       error - it produces a draw with the wrong texture on it, once, on one
       machine. So the model is readable, and --probe glstate reads it back
       against getParameter every frame and says if the two ever disagree. */
    seen.believed = () => ({
      vao, prog, unit,
      depthW, depthF, cull, front, blendS, blendD,
      vp: [vpx, vpy, vpw, vph],
      caps, units,
    });
    gl.__state = seen;

    const forget = () => {
      vao = prog = unit = undefined;
      caps = new Map();
      units = new Map();
      depthW = depthF = cull = front = blendS = blendD = undefined;
      vpx = vpy = vpw = vph = undefined;
    };
    forget();
    if (gl.canvas && gl.canvas.addEventListener) {
      gl.canvas.addEventListener('webglcontextlost', forget, false);
      gl.canvas.addEventListener('webglcontextrestored', forget, false);
    }

    gl.bindVertexArray = (v) => {
      if (v === vao) { seen.saved++; return; }
      vao = v; seen.sent++;
      raw.bindVertexArray(v);
    };
    gl.deleteVertexArray = (v) => {
      if (v === vao) vao = undefined;
      raw.deleteVertexArray(v);
    };

    gl.useProgram = (p) => {
      if (p === prog) { seen.saved++; return; }
      prog = p; seen.sent++;
      raw.useProgram(p);
    };
    gl.deleteProgram = (p) => {
      if (p === prog) prog = undefined;
      raw.deleteProgram(p);
    };

    /* THE TEXTURE UNITS. A binding belongs to a unit, so the cache is keyed
       on the unit that was active when the bind was made - which is why the
       active unit itself has to be tracked rather than read back. */
    gl.activeTexture = (u) => {
      if (u === unit) { seen.saved++; return; }
      unit = u; seen.sent++;
      raw.activeTexture(u);
    };
    gl.bindTexture = (target, t) => {
      const key = (unit === undefined ? -1 : unit) + ':' + target;
      if (units.get(key) === t) { seen.saved++; return; }
      units.set(key, t); seen.sent++;
      raw.bindTexture(target, t);
    };
    gl.deleteTexture = (t) => {
      /* A deleted texture is unbound from every unit it was on, and the
         cache has to agree or the next bind of something else to that unit
         is skipped against a binding that is already gone. */
      if (t) for (const [k, v] of units) if (v === t) units.set(k, undefined);
      raw.deleteTexture(t);
    };

    gl.enable = (c) => {
      if (caps.get(c) === true) { seen.saved++; return; }
      caps.set(c, true); seen.sent++;
      raw.enable(c);
    };
    gl.disable = (c) => {
      if (caps.get(c) === false) { seen.saved++; return; }
      caps.set(c, false); seen.sent++;
      raw.disable(c);
    };
    gl.depthMask = (m) => {
      m = !!m;
      if (m === depthW) { seen.saved++; return; }
      depthW = m; seen.sent++;
      raw.depthMask(m);
    };
    gl.depthFunc = (f) => {
      if (f === depthF) { seen.saved++; return; }
      depthF = f; seen.sent++;
      raw.depthFunc(f);
    };
    gl.cullFace = (f) => {
      if (f === cull) { seen.saved++; return; }
      cull = f; seen.sent++;
      raw.cullFace(f);
    };
    gl.frontFace = (f) => {
      if (f === front) { seen.saved++; return; }
      front = f; seen.sent++;
      raw.frontFace(f);
    };
    gl.blendFunc = (a, b) => {
      if (a === blendS && b === blendD) { seen.saved++; return; }
      blendS = a; blendD = b; seen.sent++;
      raw.blendFunc(a, b);
    };
    gl.viewport = (x, y, w, h) => {
      if (x === vpx && y === vpy && w === vpw && h === vph) { seen.saved++; return; }
      vpx = x; vpy = y; vpw = w; vph = h; seen.sent++;
      raw.viewport(x, y, w, h);
    };

    /* A framebuffer change resets nothing this tracks, but it DOES change what
       a viewport means - and the renderer sets the viewport after every bind
       anyway, so the only thing that has to happen here is that the cached
       viewport is not trusted across one. */
    const bindFb = gl.bindFramebuffer.bind(gl);
    gl.bindFramebuffer = (target, fb) => {
      vpx = vpy = vpw = vph = undefined;
      bindFb(target, fb);
    };
  }

  const STORED_ROWS = SCHEMA.ROWS.filter((r) => !SCHEMA.isHostKey(r.key));

  /* ------------------------------------------------------------------------
   * WHAT THE KEYBOARD DOES, AS DATA.
   *
   * Every key the car answers to used to be a string literal at the point it
   * was read - `down('arrowup', 'w')` inside Input.sample, `hit('r')` in three
   * different directors - which is fine right up until somebody wants to know
   * what the controls ARE, or to change one. Then there is no list to show and
   * nothing to change.
   *
   * So this is the list. `def` is what the key was before this table existed,
   * which is why every default is a pair: the arrows and WASD have always both
   * worked, and a rebind that silently dropped one of them would be a
   * regression dressed as a feature.
   *
   * WHAT IS DELIBERATELY NOT HERE. The menu's own navigation - arrows, ENTER,
   * ESC - is fixed. A player who rebinds the key that opens the menu onto the
   * key that closes it has locked themselves out of the only screen that could
   * undo it, and no amount of a confirmation dialogue makes that a good trade.
   * ESCAPE also always pauses, whatever PAUSE is bound to, for the same
   * reason: it is the one key every player already knows.
   * --------------------------------------------------------------------- */
  const ACTIONS = [
    { key: 'throttle', label: 'ACCELERATE', def: ['arrowup', 'w'],
      hint: 'Throttle. Held, not tapped - the engine has a rev range and the box shifts itself.' },
    { key: 'brake', label: 'BRAKE / REVERSE', def: ['arrowdown', 's'],
      hint: 'Brakes, and reverse once the car has stopped.' },
    { key: 'left', label: 'STEER LEFT', def: ['arrowleft', 'a'],
      hint: 'Steering is speed-sensitive: the same input is a smaller angle the faster you are going.' },
    { key: 'right', label: 'STEER RIGHT', def: ['arrowright', 'd'],
      hint: 'Steering is speed-sensitive: the same input is a smaller angle the faster you are going.' },
    { key: 'ebrake', label: 'HANDBRAKE / DRIFT', def: [' '],
      hint: 'Locks the rear axle. Held into a corner with steering, this is the drift.' },
    { key: 'boost', label: 'BOOST', def: ['b'],
      hint: 'Spends the blue reserve. It refills off the throttle, not on a timer.' },
    { key: 'raceMode', label: 'RACE MODE / RESTART', def: ['r'],
      hint: 'Fires raceMode where a chapter has awarded it, and restarts the run everywhere else.' },
    { key: 'camera', label: 'CAMERA VIEW', def: ['c'],
      hint: 'Cycles CHASE, DRIVER and DRONE. Driver is the view from behind the wheel; drone looks down on the road from above.' },
    { key: 'pause', label: 'PAUSE', def: ['escape', 'p'],
      hint: 'ESC always pauses whatever this is set to, because it is the one key nobody has to be told.' },
    { key: 'fullscreen', label: 'FULLSCREEN', def: ['f'],
      hint: 'Takes the whole display. The same as the WINDOW MODE row on the first page.' },
  ];

  /* How a key event name is written on a cap. `e.key` is lowercased before it
     ever reaches here, so this only has to handle the ones whose own name is
     not the label: a space is not a blank cap. */
  const KEY_LABELS = {
    ' ': 'SPACE', arrowup: 'UP', arrowdown: 'DOWN', arrowleft: 'LEFT',
    arrowright: 'RIGHT', escape: 'ESC', enter: 'ENTER', tab: 'TAB',
    shift: 'SHIFT', control: 'CTRL', alt: 'ALT', backspace: 'BACKSPACE',
    capslock: 'CAPS', pageup: 'PG UP', pagedown: 'PG DN', home: 'HOME',
    end: 'END', insert: 'INS', delete: 'DEL',
  };
  function keyLabel(k) {
    if (!k) return '—';
    return KEY_LABELS[k] || String(k).toUpperCase();
  }
  /* Two caps, or one, or the fact that there are none. A row reading "—" is
     how an unbound action says so; it is reachable, because taking a key off
     an action the player never uses is a legitimate thing to want. */
  function bindLabel(list) {
    if (!list || !list.length) return '—';
    return list.map(keyLabel).join('  /  ');
  }

  /* ------------------------------------------------------------------------
   * THE SECOND PAGE.
   *
   * Same row machinery as the first - a label, a value, a group header, a hint
   * - with two differences. A `bind` row's value is a key rather than an index
   * into a list of options, so LEFT and RIGHT do not cycle it; ENTER puts it
   * into capture and the next key press lands. And the MOUSE group exists
   * because a sensitivity setting that scales nothing is a lie, so the game
   * now has a mouse function for it to scale - see Game.mouseLook.
   * --------------------------------------------------------------------- */
  /* THREE PAGES, ONE SUBJECT.
   *
   * The screen behind ESC is CONTROLS now and nothing else. Everything about
   * the picture - the preset, the shadows, the render scale, the grade, the
   * volumes - is on the launcher, in front of the game, because that is where
   * a decision about a machine belongs and because several of those settings
   * cannot honestly be applied to a webview that already has a GPU context.
   *
   * What is left is what a player changes MID-GAME, with the car still on the
   * road behind the panel: which key does what, how the pad reads, how the
   * mouse swings the camera.
   *
   * A `bind` row's value is a KEY rather than an index into a list, so LEFT
   * and RIGHT do not cycle it; ENTER puts it into capture and the next press
   * lands. Every other row is an ordinary setting from the schema.
   */
  const KEYBOARD_ROWS = [];
  for (let i = 0; i < ACTIONS.length; i++) {
    const a = ACTIONS[i];
    KEYBOARD_ROWS.push({
      tab: 0, bind: a.key, label: a.label, hint: a.hint,
      group: i === 0 ? 'KEYBOARD' : undefined,
    });
  }

  const CONTROL_TABS = ['KEYBOARD', 'GAMEPAD', 'MOUSE'];
  /* Where the strip is drawn and hit-tested. Two copies of these numbers is
     how the old settings rows drifted apart, so there is one. */
  const CTL_TAB_Y = 232;
  const CTL_TAB_W = 232;
  function ctlTabX(i) { return (i - (CONTROL_TABS.length - 1) / 2) * (CTL_TAB_W + 14); }

  /* The rows on one page, in order. Called by the drawing, by the hit test and
     by the key handler, so there is one answer to "what is row three". */
  function tabRows(tab) {
    if (tab === 0) return KEYBOARD_ROWS;
    return SETTING_ROWS.filter((r) => r.tab === tab);
  }

  /* The multiplier a sensitivity step means. Kept next to the labels so the
     two cannot drift. */
  const MOUSE_SENS = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0];
  const MOUSE_SMOOTH = [0, 26, 14, 7];      // damping rate, 1/s; 0 is none

  /* Where each row is drawn.

     Derived once from the rows themselves, so a group header inserts its own
     space and the hit test in Game.controlItemAt cannot drift from what
     Hud.drawControlsScreen painted - which is what happened the last time these were
     two hand-kept copies of the same numbers. */
  function layoutFor(rows) {
    /* Twelve rows, three group headers, a button and a status line have to
       fit between the rule under the title and the bottom of the panel. These
       are the numbers that do it with the gaps still reading as gaps. */
    /* WHERE THE LIST STARTS, AND WHY IT MOVED DOWN.
     *
     * The page used to begin at 196, which was right when the only thing above
     * it was a rule. There is a tab strip there now, and a strip whose
     * selection brackets reach 211 cannot share a screen with a group header
     * drawn at 222 - DISPLAY was being painted through CONTROLS.
     *
     * Everything below therefore comes down, and the row pitch comes in by a
     * unit to pay for it: the longer of the two pages is thirteen rows and two
     * headers, and at the old pitch its explanation band finished below the
     * bottom of the panel it is drawn inside. These are the numbers that fit
     * BOTH pages between the strip and the panel edge with the gaps still
     * reading as gaps. */
    const TOP = 176, ROW = 28, HEAD = 20;
    const out = [];
    let y = TOP;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].group) y -= HEAD;
      out.push(y);
      y -= ROW;
    }
    /* THE GAPS UNDER THE LIST.
       `exitY` used to sit 26 below the last row and `hintY` 60 below that,
       which put the top of the hint band at exactly the bottom of the SAVE AND
       BACK glyphs - and once that row is selected its 42-unit panel and its
       52-unit brackets are drawn straight through the band. The button needs
       clearance for the taller of the two things that can be drawn on it, so
       the gap is measured from the bracket height rather than from the text. */
    const BUTTON_H = 52;                     // the selected row's brackets
    const HINT_H = 46;                       // the explanation band
    const exitY = y - (BUTTON_H / 2 + 6);
    return {
      rows: out, row: ROW, head: HEAD, exitY,
      hintY: exitY - (BUTTON_H / 2 + HINT_H / 2 + 10),
      buttonH: BUTTON_H, hintH: HINT_H,
    };
  }
  /* One per page, built once. The pages are different lengths and different
     shapes - the second has two group headers where the first has three - so a
     single set of row positions would put the hit test and the paint on
     different lines the moment the tab changed. */
  const CONTROLS_LAYOUTS = CONTROL_TABS.map((_, i) => layoutFor(tabRows(i)));
  const CONTROLS_LAYOUT = CONTROLS_LAYOUTS[0];

  /* Read a setting's chosen option by key.
   *
   * Indexing SETTING_ROWS by position ties every reader to the order the rows
   * happen to appear on screen - add a row at the top and the graphics setting
   * silently starts reading the new one's options, which is exactly what
   * happened when the rival difficulty went in.
   *
   * IT ASKS THE SCHEMA, NOT THIS SCREEN'S ROWS, and that distinction is not
   * academic. When the graphics settings moved to the launcher, SETTING_ROWS
   * stopped containing PRESET - so this returned null for 'quality', the
   * caller fell back to `QUALITY.HIGH`, and every preset silently ran HIGH's
   * passes. LOW rendered shadows, reflections, volumetrics and a six-level
   * bloom pyramid, which is the exact opposite of what LOW is for, and nothing
   * on screen said so.
   *
   * The rows a screen DRAWS and the settings that EXIST are two different
   * lists, and a reader of values must always ask the second one. */
  function optionOf(settings, key) {
    const row = SCHEMA.rowByKey(key);
    if (!row || !row.opts) return null;
    const v = settings ? settings[key] : undefined;
    return row.opts[typeof v === 'number' ? v : row.def];
  }

  /* Progress. One entry per level: the hardest difficulty the rival has been
     beaten at on it, 0 for none. Nothing is gated on it now that the route
     list is gone - Story Mode's own save decides what is unlocked - but it is
     still written, because the campaign mirrors chapter completion into it and
     older saves are read back through it. */
  function loadProgress() {
    const out = LEVELS.map(() => 0);
    try {
      const raw = global.NR.Save.getJSON(PROGRESS_KEY, []);
      if (Array.isArray(raw)) {
        for (let i = 0; i < out.length && i < raw.length; i++) {
          const v = raw[i] | 0;
          if (v >= 0 && v <= 3) out[i] = v;
        }
      }
    } catch (e) { /* corrupt or private mode: start fresh */ }
    return out;
  }

  function defaultBinds() {
    const b = {};
    for (const a of ACTIONS) b[a.key] = a.def.slice();
    return b;
  }

  function defaultSettings() {
    const o = {};
    for (const r of STORED_ROWS) o[r.key] = r.def;
    o.binds = defaultBinds();
    return o;
  }

  function loadSettings() {
    const o = defaultSettings();
    const got = global.NR.Save.getJSON(SETTINGS_KEY, null);
    if (got) {
      for (const r of STORED_ROWS) {
        const v = got[r.key];
        if (typeof v === 'number' && v >= 0 && v < r.opts.length) o[r.key] = v;
      }
      /* THE BINDINGS ARE VALIDATED, NOT TRUSTED.
         This is player-editable storage and it outlives the build that wrote
         it. An action that has been renamed away is dropped, anything that is
         not a list of short strings is ignored, and a saved file that has
         never heard of an action keeps that action's default - so adding a row
         to ACTIONS does not silently unbind it for everybody who has already
         been to this screen. */
      const gb = got.binds;
      if (gb && typeof gb === 'object') {
        for (const a of ACTIONS) {
          const list = gb[a.key];
          if (!Array.isArray(list)) continue;
          const clean = [];
          for (const k of list) {
            if (typeof k === 'string' && k.length && k.length < 20 && clean.indexOf(k) < 0) {
              clean.push(k);
            }
          }
          o.binds[a.key] = clean;
        }
      }
    }
    return o;
  }

  const TYPE_CPS = 30;           // menu typewriter speed

  /* ----------------------------------------------------------------------
   * Post chain.
   *
   * The scene renders to a linear HDR buffer with a sampleable depth target
   * and a packed normal/roughness target, then:
   *   1. screen-space reflections put the neon back into the wet road
   *   2. a raymarched volumetric pass (half res) puts light into the air,
   *      including the headlight beams
   *   3. a sky-occlusion pass + radial blur makes real god rays
   *   4. a bloom mip chain (six levels) so neon bleeds over a wide radius
   *   5. a blurred copy of the scene for the depth-of-field falloff
   *   6. the composite tonemaps, grades, and adds flare, speed blur,
   *      aberration, grain and vignette
   *   7. FXAA cleans up what having no MSAA leaves behind
   * -------------------------------------------------------------------- */

  const NOISE_GLSL = `
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float vnoise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
          mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
          mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) {
    return vnoise(p) * 0.55 + vnoise(p * 2.03) * 0.28 + vnoise(p * 4.11) * 0.17;
  }`;

  // --- screen-space reflections -------------------------------------------
  // Marched in world space and tested against the depth buffer, which keeps the
  // step length uniform along the ray instead of bunching up near the camera
  // the way a pure screen-space march does.
  const SSR_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uScene;
  uniform sampler2D uDepth;
  uniform sampler2D uNormal;
  uniform mat4 uVP;
  uniform mat4 uInvVP;
  uniform vec3 uCamPos;
  uniform vec2 uRes;
  uniform float uNear;
  uniform float uFar;
  uniform float uTime;

  vec3 worldFromDepth(vec2 uv, float d) {
    vec4 c = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return c.xyz / c.w;
  }
  float linear(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }
  /* Interleaved gradient noise, not white noise.

     The march has to start at a jittered offset or 26 steps band visibly, but
     a per-pixel random start is salt-and-pepper: neighbouring rays land on
     completely different surfaces and the resolve blur cannot put that back
     together. IGN varies smoothly across small neighbourhoods, so the blur
     actually resolves it - and it is static, so the road does not shimmer. */
  float ign(vec2 p) {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
  }

  void main() {
    vec4 nr = texture(uNormal, vUv);
    float refl = nr.a;
    if (refl < 0.02) { outColor = vec4(0.0); return; }
    float d = texture(uDepth, vUv).r;
    if (d >= 0.99999) { outColor = vec4(0.0); return; }

    vec3 P = worldFromDepth(vUv, d);
    /* THE ZERO-LENGTH NORMAL, AND WHY IT IS THE WHOLE OF THE BLACK-BOX BUG.

       "normalize" of a zero vector is a division by zero: it returns NaN, and
       NaN is not a value that goes away. It multiplies through the march,
       lands in this pass's target, and the bloom prefilter ADDS that target
       to the scene colour - so a single bad pixel here becomes a NaN texel in
       bloom mip 0, then a NaN texel in every mip above it, and mip 5 is thirty
       pixels wide across the whole screen. That is the mechanism behind the
       large pixelated boxes: not a texture, not a framebuffer, one undefined
       normal amplified by a mip pyramid.

       The g-buffer's normal is 0.5,0.5,0.5 - which decodes to exactly zero -
       wherever nothing wrote a normal: unlit and glow materials, and any texel
       the geometry pass did not cover. Reflectivity is a separate channel and can be
       non-zero over those, so the early-out above does not catch them.

       The ambient-occlusion pass below has had this guard since it was
       written. This pass never got one. */
    vec3 nRaw = nr.rgb * 2.0 - 1.0;
    if (dot(nRaw, nRaw) < 0.1) { outColor = vec4(0.0); return; }
    vec3 N = normalize(nRaw);
    /* ...and the same argument for the view vector. A fragment ON the camera
       gives a zero-length P - uCamPos, which is rare and is exactly the kind of
       thing a cutscene camera moving through the car does. */
    vec3 toP = P - uCamPos;
    float camDist2 = dot(toP, toP);
    if (camDist2 < 1e-8) { outColor = vec4(0.0); return; }
    vec3 V = toP * inversesqrt(camDist2);
    vec3 R = reflect(V, N);
    if (R.y < -0.02) { outColor = vec4(0.0); return; }

    float dist = sqrt(camDist2);
    // step scaled by how far away the surface is, so the road keeps a usable
    // ray length all the way to the horizon
    float step0 = max(1.4, dist * 0.035);
    float jitter = ign(gl_FragCoord.xy);

    /* THE MARCH, IN TWO PHASES.
     *
     * A single linear march has to choose between reach and precision with one
     * number, and it cannot have both: the step that gets a reflection to the
     * horizon is far larger than the step that finds the exact pixel a ray
     * crosses a surface at. What that costs is visible - the reflection of a
     * barrier post lands a few pixels off the post, and as the camera moves it
     * slides, because which coarse step happened to straddle the surface
     * changes from frame to frame.
     *
     * So the coarse march only has to answer WHICH step crossed, and a binary
     * refinement between that step and the one before it finds where. Five
     * bisections resolve a step to a thirty-second of its length, which is
     * finer than the depth buffer can distinguish - for the cost of five taps
     * on a ray that has already found something, and nothing at all on the
     * rays that miss.
     */
    const int STEPS = 26;
    const int REFINE = 5;
    vec3 hit = vec3(0.0);
    float ok = 0.0;
    float t = 0.0;
    float tPrev = 0.0;
    bool found = false;
    vec2 hitUv = vec2(0.0);
    int hitStep = 0;

    for (int i = 0; i < STEPS; i++) {
      tPrev = t;
      t += step0 * (1.0 + float(i) * 0.16) * (i == 0 ? jitter : 1.0);
      vec3 q = P + R * t;
      vec4 clip = uVP * vec4(q, 1.0);
      if (clip.w <= 0.0) break;
      vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sceneZ = linear(texture(uDepth, uv).r);
      float diff = clip.w - sceneZ;
      // a hit is the ray passing just behind a surface; anything deeper than
      // the thickness guard is the ray sailing past an object's silhouette
      if (diff > 0.0 && diff < max(6.0, sceneZ * 0.09)) {
        found = true;
        hitUv = uv;
        hitStep = i;
        break;
      }
    }

    if (found) {
      // bisect the crossed interval down to a fraction of a pixel
      float lo = tPrev, hi = t;
      for (int r = 0; r < REFINE; r++) {
        float mid = (lo + hi) * 0.5;
        vec4 clip = uVP * vec4(P + R * mid, 1.0);
        vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
        float sceneZ = linear(texture(uDepth, uv).r);
        if (clip.w - sceneZ > 0.0) { hi = mid; hitUv = uv; }
        else lo = mid;
      }

      /* Roughness-aware fetch.

         A reflection off a rough surface is a CONE, not a ray, and the rougher
         the surface the wider the footprint it gathers over. Sampling a single
         texel for all of them is what makes a damp road's reflection look like
         a sharp mirror image with noise on it rather than like a damp road.
         The scene's own mip chain is not available here, so the widening is
         four taps on a rotated cross - enough to read as a rough reflection at
         the roughnesses this game actually uses. */
      float rough = clamp(1.0 - refl, 0.0, 1.0);
      float spread = rough * rough * 0.012 * (1.0 + t * 0.004);
      float a = jitter * 6.2831853;
      vec2 e1 = vec2(cos(a), sin(a)) * spread;
      vec2 e2 = vec2(-e1.y, e1.x);
      hit  = texture(uScene, hitUv).rgb * 0.4;
      hit += texture(uScene, hitUv + e1).rgb * 0.15;
      hit += texture(uScene, hitUv - e1).rgb * 0.15;
      hit += texture(uScene, hitUv + e2).rgb * 0.15;
      hit += texture(uScene, hitUv - e2).rgb * 0.15;

      // fade at the frame edge, where there is nothing left to reflect
      vec2 e = abs(hitUv - 0.5) * 2.0;
      float edge = (1.0 - smoothstep(0.72, 1.0, e.x)) * (1.0 - smoothstep(0.72, 1.0, e.y));

      /* ...and fade a ray that is pointing back at the camera. A reflection
         travelling toward the eye is one whose source is BEHIND the visible
         surface, and the depth buffer has no record of what is there - so what
         it finds is whatever happened to be in front instead, smeared along
         the ray. Every screen-space reflection has this failure; fading it out
         is what keeps it from being noticed. */
      float facing = clamp(1.0 - max(0.0, dot(R, -normalize(V))) * 1.4, 0.0, 1.0);

      ok = edge * facing * (1.0 - float(hitStep) / float(STEPS) * 0.55);
    }
    outColor = vec4(hit * ok * refl, ok * refl);
  }`;

  /* --- ambient occlusion --------------------------------------------------

     Contact darkening: the crease where the barrier meets the tarmac, the
     shadow the car sits in, the way the tunnel ribs bed into the shell. None
     of that comes out of a single ambient term, and its absence is most of why
     a scene lit only by sky and neon looks like objects floating on a
     backdrop.

     World-space hemisphere sampling against the depth buffer, using the same
     normal target the reflections read. Twelve taps on a Vogel spiral rotated
     per pixel, so the noise is a fine dither the blur can resolve rather than
     banding. */
  /* ------------------------------------------------- ground-truth AO -----
   *
   * The occlusion pass, rewritten as GTAO (Jimenez et al. 2016).
   *
   * What was here before was the standard hemisphere sampler: throw points
   * into the hemisphere above the surface, count how many land inside
   * geometry, call the fraction occlusion. It is easy to write and it is
   * wrong in a specific way - it treats every sample as equally important,
   * when the cosine term in the real visibility integral says a sample near
   * the horizon contributes almost nothing and one near the normal
   * contributes almost everything. The result is occlusion that is too heavy
   * on open ground, too light in the creases that matter, and noisy enough to
   * need a blur wide enough to erase the detail it just computed.
   *
   * GTAO solves the integral instead of sampling it. Along a few screen-space
   * directions it finds the two HORIZON ANGLES - the highest blocked angle on
   * either side - and evaluates the cosine-weighted visibility between them
   * in closed form. Two short marches per direction replace sixteen scattered
   * taps, the answer is an integral rather than an estimate, and it comes out
   * smooth enough that the resolve blur can stay narrow and keep the contact
   * detail it is there to produce.
   */
  const SSAO_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uDepth;
  uniform sampler2D uNormal;
  uniform mat4 uVP;
  uniform mat4 uInvVP;
  uniform vec3 uCamPos;
  uniform float uNear;
  uniform float uFar;
  uniform float uRadius;
  uniform float uStrength;
  uniform float uFrame;        // rotates the direction set frame to frame
  /* How many slices of the hemisphere to integrate, as a float because it is
     a uniform: 2 for LOW, 4 for HIGH. GTAO's error falls with the slice count
     rather than with the sample count along each one, so this is the knob that
     actually trades quality for cost - doubling the steps instead mostly buys
     a longer search radius. */
  uniform float uSlices;

  const float PI = 3.14159265;

  vec3 worldFromDepth(vec2 uv, float d) {
    vec4 c = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return c.xyz / c.w;
  }
  /* Interleaved gradient noise. It decorrelates the per-pixel rotation in a
     pattern the temporal resolve averages out cleanly, which white noise does
     not - white noise leaves a static grain that TAA reads as detail and
     preserves. */
  float ign(vec2 p) {
    return fract(52.9829189 * fract(0.06711056 * p.x + 0.00583715 * p.y));
  }

  void main() {
    float d = texture(uDepth, vUv).r;
    if (d >= 0.99999) { outColor = vec4(1.0); return; }
    vec4 nr = texture(uNormal, vUv);
    vec3 N = nr.rgb * 2.0 - 1.0;
    if (dot(N, N) < 0.1) { outColor = vec4(1.0); return; }
    N = normalize(N);
    vec3 P = worldFromDepth(vUv, d);
    vec3 toCam = uCamPos - P;
    float camDist2 = dot(toCam, toCam);
    // a fragment standing ON the camera has no view vector; see the note below
    if (camDist2 < 1e-8) { outColor = vec4(1.0); return; }
    vec3 V = toCam * inversesqrt(camDist2);
    float dist = sqrt(camDist2);
    // a contact cue, not a global one: past a few hundred units the radius is
    // sub-pixel and the pass only costs noise
    float fade = 1.0 - smoothstep(180.0, 520.0, dist);
    if (fade <= 0.01) { outColor = vec4(1.0); return; }

    /* The search radius, in screen space. A fixed pixel radius occludes a
       distant surface as though it were near; projecting a WORLD radius keeps
       the effect the same physical size wherever it is, which is what makes it
       read as contact rather than as a screen effect. */
    vec2 res = vec2(textureSize(uDepth, 0));
    float pxRadius = clamp(uRadius / max(dist, 1e-3) * res.y * 0.55, 4.0, 96.0);

    /* The loop bound is a compile-time constant because GLSL ES 3.00 requires
       one, and the uniform decides how many of those iterations do any work.
       An early break on a uniform is uniform across the whole draw, so the
       shorter setting really does cost less rather than merely masking. */
    const int MAX_DIRS = 4;
    const int STEPS = 6;
    int dirs = int(clamp(uSlices, 1.0, float(MAX_DIRS)));
    float rot = (ign(gl_FragCoord.xy) + uFrame * 0.6180339887) * PI;
    float visibility = 0.0;

    for (int dir = 0; dir < MAX_DIRS; dir++) {
      if (dir >= dirs) break;
      float a = rot + float(dir) * PI / float(dirs);
      vec2 dirUv = vec2(cos(a), sin(a)) / res;

      /* The slice plane: the plane through the view vector and this screen
         direction. GTAO integrates inside it, so the normal is projected into
         it first and the horizons are measured against THAT - the step a naive
         horizon-based AO leaves out, and the reason its creases sit at the
         wrong angle on a sloped surface. */
      /* Every normalize in this block is a division by a length that CAN be
         zero, and a NaN produced here reaches the screen as a large block -
         see the long note in the reflection pass for why the bloom pyramid
         turns one bad texel into one. So each is guarded on the squared
         length before the divide rather than after it.

         The cross product is the one that actually fires: it is zero
         whenever the slice direction is parallel to the view vector, which is
         what happens at a grazing angle - and grazing angles are most of a
         frame taken from a camera sitting low behind a car. */
      vec3 dw = worldFromDepth(vUv + dirUv * 8.0, d) - P;
      float dwLen2 = dot(dw, dw);
      if (dwLen2 < 1e-12) continue;
      vec3 dirWorld = dw * inversesqrt(dwLen2);
      vec3 slc = cross(dirWorld, V);
      float slcLen2 = dot(slc, slc);
      if (slcLen2 < 1e-12) continue;
      vec3 sliceN = slc * inversesqrt(slcLen2);
      vec3 projN = N - sliceN * dot(N, sliceN);
      float projLen = length(projN);
      /* WRITTEN AS !(x > eps), NOT AS x < eps.
         The two are the same for every real number and are NOT the same for
         NaN: NaN < eps is false, so the plain comparison lets a NaN THROUGH
         the guard that exists to stop it. This form rejects it. It is the
         reason the guard that was already here never worked. */
      if (!(projLen > 1e-4)) continue;
      vec3 pn = projN / projLen;

      // signed angle of the projected normal away from the view vector
      float n = acos(clamp(dot(pn, V), -1.0, 1.0))
              * sign(dot(cross(V, pn), sliceN));

      // march both ways along the direction, keeping the highest horizon
      float hA = -1.0;
      float hB = -1.0;
      for (int side = 0; side < 2; side++) {
        float s = side == 0 ? 1.0 : -1.0;
        float best = -1.0;
        for (int step = 0; step < STEPS; step++) {
          float t = (float(step) + 0.5 + ign(gl_FragCoord.yx) * 0.5) / float(STEPS);
          vec2 uv = vUv + dirUv * (t * t * pxRadius) * s;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
          float sd = texture(uDepth, uv).r;
          if (sd >= 0.99999) continue;
          vec3 sp = worldFromDepth(uv, sd);
          vec3 delta = sp - P;
          float len = length(delta);
          if (len < 1e-4) continue;
          // fall off past the radius, so a distant silhouette cannot occlude
          float falloff = clamp(1.0 - (len - uRadius) / max(uRadius, 1e-3), 0.0, 1.0);
          float cosH = dot(delta / len, V);
          best = max(best, mix(-1.0, cosH, falloff));
        }
        float ang = acos(clamp(best, -1.0, 1.0));
        if (side == 0) hA = ang; else hB = ang;
      }
      // clamp each horizon into the hemisphere the normal actually allows
      float h0 = n + max(-hA - n, -PI * 0.5);
      float h1 = n + min(hB - n, PI * 0.5);

      /* The closed-form cosine-weighted arc - the whole point of GTAO: the
         visibility between two horizon angles, integrated exactly rather than
         counted. */
      float cn = cos(n), sn = sin(n);
      float a0 = 0.25 * (-cos(2.0 * h0 - n) + cn + 2.0 * h0 * sn);
      float a1 = 0.25 * (-cos(2.0 * h1 - n) + cn + 2.0 * h1 * sn);
      visibility += projLen * (a0 + a1);
    }
    visibility /= float(dirs);

    float ao = clamp(visibility, 0.0, 1.0);
    ao = mix(1.0, ao, clamp(uStrength, 0.0, 1.0) * fade);

    /* Multi-bounce (Jimenez). A surface in a crease is occluded from the sky
       AND lit by the bounce off whatever is occluding it, so pure visibility
       reads as dirt on anything light-coloured. The cubic puts that bounce
       back without a second pass to compute it. */
    float x = ao;
    float mb = max(x, ((x * 2.0404 - 3.2401) * x + 2.7552) * x - 0.5556);
    /* The last gate. clamp on a NaN is undefined in GLSL - min/max with NaN
       may return either operand - so a NaN that survived the loop can walk out
       of a clamp unchanged on some drivers. mb == mb is false only for NaN
       and is the one portable test for it. Fully lit is the right fallback:
       this pass MULTIPLIES the frame, so its failure mode should be "no
       occlusion", never "a black patch". */
    outColor = vec4(vec3(mb == mb ? clamp(mb, 0.0, 1.0) : 1.0), 1.0);
  }`;

  const VOL_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uDepth;
  uniform sampler2D uCookie;
  uniform mat4 uInvVP;
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform float uTime;
  uniform float uTunnel;
  uniform float uDensity;
  uniform vec3 uHeadL;
  uniform vec3 uHeadR;
  uniform vec3 uHeadFwd;
  uniform vec3 uHeadRight;
  uniform vec3 uHeadCol;
  uniform float uHeadOn;
  uniform float uHeadRange;
  uniform float uHeadInner;
  uniform float uHeadOuter;
  uniform float uHeadDip;
  uniform float uHeadToe;
  uniform float uHeadFall;
  ` + NOISE_GLSL + `

  vec3 worldFromDepth(vec2 uv, float d) {
    vec4 c = uInvVP * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return c.xyz / c.w;
  }
  // Henyey-Greenstein: forward scattering, so looking toward the sun glows
  float phaseHG(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / max(1e-4, 4.0 * 3.14159 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }
  /* The same cone the scene pass lights the road with, so the shaft in the air
     and the pool on the tarmac are one light rather than two guesses. The
     shipped beam texture rides on top of it as a radial profile: it is a
     photograph of a real beam, and its internal structure is what stops the
     shaft looking like a smooth analytic wedge. */
  float beam(vec3 P, vec3 lamp, float toe) {
    vec3 d = P - lamp;
    float dist = length(d);
    if (dist > uHeadRange || dist < 0.4) return 0.0;
    vec3 dir = d / dist;
    vec3 axis = normalize(uHeadFwd - vec3(0.0, uHeadDip, 0.0) + uHeadRight * toe);
    float cosA = dot(dir, axis);
    if (cosA <= uHeadOuter) return 0.0;
    float cone = smoothstep(uHeadOuter, uHeadInner, cosA);
    float radial = clamp((1.0 - cosA) / (1.0 - uHeadOuter), 0.0, 1.0);
    float profile = textureLod(uCookie,
      vec2(0.5 + radial * 0.34, 0.18 + 0.5 * (dist / uHeadRange)), 0.0).r;
    // the same cut-off the scene pass uses, so the shaft in the air cannot
    // glow up out of a beam that is aimed at the road
    float above = max(0.0, dir.y + uHeadDip * 0.55);
    cone *= 1.0 - smoothstep(0.01, 0.16, above);
    cone *= 1.0 - smoothstep(1.2, 5.0, d.y);
    /* NOTHING IN THE FIRST FEW UNITS. A hard cut at 0.4 was fine while the
       nearest eye was eleven units behind the car, and wrong the moment one
       sat in the car: the march then starts a metre from the lamp, inside
       the cone, where the inverse-square term is at its largest and the
       cookie is being read at the middle of its profile - so the bottom of
       the frame washed to white. Ramped in over five units instead, which is
       also the honest answer: the air right at the lens has no path length
       through the beam to scatter with. */
    cone *= smoothstep(0.4, 5.0, dist);
    return cone * (0.35 + 1.4 * pow(profile, 0.45))
         / (1.0 + dist * dist * uHeadFall * 0.6);
  }

  void main() {
    float d = texture(uDepth, vUv).r;
    vec3 far = worldFromDepth(vUv, min(d, 0.99999));
    vec3 ray = far - uCamPos;
    float dist = length(ray);
    vec3 dir = ray / max(1e-4, dist);

    // marching the whole 50 km far plane is pointless; the air that reads on
    // screen is the first few hundred units
    float maxT = min(dist, 1400.0);
    const int STEPS = 28;
    float stepLen = maxT / float(STEPS);

    // dither the start so the march does not band
    float jitter = hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));
    float t = stepLen * jitter;

    float cosT = dot(dir, normalize(uSunDir));
    float phase = phaseHG(cosT, 0.62) * 3.2 + 0.05;

    vec3 scatter = vec3(0.0);
    float trans = 1.0;
    vec3 ambientAir = mix(vec3(0.045, 0.028, 0.105), vec3(0.020, 0.045, 0.070), uTunnel);

    for (int i = 0; i < STEPS; i++) {
      vec3 p = uCamPos + dir * t;
      // ground-hugging haze, thicker in the hollows, drifting slowly
      float height = exp(-max(0.0, p.y - 2.0) / 24.0);
      float n = fbm(p * 0.0055 + vec3(0.0, 0.0, uTime * 0.05));
      float dens = uDensity * height * (0.45 + 1.15 * n);
      dens = mix(dens, dens * 3.4, uTunnel);        // tunnels are thick with it
      if (dens > 1e-5) {
        float sigma = dens * stepLen;
        vec3 lit = uSunCol * phase + ambientAir;
        // the headlights light the air they pass through, which is what makes
        // the beams visible in fog and turns the tunnel into a light show
        if (uHeadOn > 0.001) {
          float b = beam(p, uHeadL, -uHeadToe) + beam(p, uHeadR, uHeadToe);
          lit += uHeadCol * b * uHeadOn * 26.0;
        }
        scatter += trans * lit * sigma;
        trans *= exp(-sigma * 1.35);
      }
      t += stepLen;
      if (trans < 0.02) break;
    }
    outColor = vec4(scatter, trans);
  }`;

  // --- sky-only occlusion buffer: what the god-ray blur smears -------------
  const OCCLUDE_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uScene;
  uniform sampler2D uDepth;
  void main() {
    float d = texture(uDepth, vUv).r;
    vec3 c = texture(uScene, vUv).rgb;
    // only unoccluded sky contributes; the geometry is what casts the shafts
    float sky = step(0.9999, d);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    outColor = vec4(c * sky * smoothstep(0.7, 3.0, l), 1.0);
  }`;

  const GODRAY_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec2 uSunUv;
  uniform float uOnScreen;
  void main() {
    const int N = 40;
    vec2 delta = (vUv - uSunUv) * (1.0 / float(N)) * 0.85;
    vec2 uv = vUv;
    vec3 acc = vec3(0.0);
    float w = 1.0;
    for (int i = 0; i < N; i++) {
      uv -= delta;
      acc += texture(uTex, uv).rgb * w;
      w *= 0.955;                      // decay along the shaft
    }
    outColor = vec4(acc * (1.0 / float(N)) * 1.1 * uOnScreen, 1.0);
  }`;

  // --- bloom: progressive downsample then tent upsample --------------------
  const BLOOM_PRE_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform sampler2D uSsr;
  uniform float uThreshold;
  uniform float uKnee;
  uniform float uSsrAmt;
  void main() {
    vec3 c = texture(uTex, vUv).rgb + texture(uSsr, vUv).rgb * uSsrAmt;
    /* THE BACKSTOP, and the reason it is HERE of all places.

       This is the mouth of the mip pyramid. One NaN or Inf texel entering it
       is spread by the 13-tap downsample into its whole neighbourhood at every
       level above, and by the time it comes back up the tent filter it is a
       block tens of pixels across - which is what the reported large
       pixelated boxes are. The specific faults that produced them are fixed at
       source (see the reflection and occlusion passes), but this pass reads
       from two whole render targets and a future term in either of them would
       land here the same way.

       A self-comparison is false only for NaN. The clamp then removes Inf, which does
       not survive a downsample either. Three instructions on a quarter-
       resolution pass, and it converts a class of whole-screen artefact into a
       single dark pixel. */
    c = mix(vec3(0.0), c, vec3(equal(c, c)));
    c = min(c, vec3(65504.0));
    float l = max(c.r, max(c.g, c.b));
    // soft knee so neon ramps into the bloom instead of popping
    float soft = clamp(l - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, l - uThreshold) / max(l, 1e-4);
    c *= w;
    // saturated light is neon and gets a much wider glow than white highlights
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float sat = (mx - mn) / max(mx, 1e-4);
    c *= 1.0 + sat * sat * 2.1;
    // Karis average: keeps one very bright pixel from flickering the bloom
    c /= (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722)) * 0.18);
    outColor = vec4(c, 1.0);
  }`;

  const DOWN_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  void main() {
    vec2 t = 1.0 / vec2(textureSize(uTex, 0));
    // 13-tap partial Karis downsample (Jimenez), stable under motion
    vec3 a = texture(uTex, vUv + t * vec2(-2.0,  2.0)).rgb;
    vec3 b = texture(uTex, vUv + t * vec2( 0.0,  2.0)).rgb;
    vec3 c = texture(uTex, vUv + t * vec2( 2.0,  2.0)).rgb;
    vec3 d = texture(uTex, vUv + t * vec2(-2.0,  0.0)).rgb;
    vec3 e = texture(uTex, vUv).rgb;
    vec3 f = texture(uTex, vUv + t * vec2( 2.0,  0.0)).rgb;
    vec3 g = texture(uTex, vUv + t * vec2(-2.0, -2.0)).rgb;
    vec3 h = texture(uTex, vUv + t * vec2( 0.0, -2.0)).rgb;
    vec3 i = texture(uTex, vUv + t * vec2( 2.0, -2.0)).rgb;
    vec3 j = texture(uTex, vUv + t * vec2(-1.0,  1.0)).rgb;
    vec3 k = texture(uTex, vUv + t * vec2( 1.0,  1.0)).rgb;
    vec3 l = texture(uTex, vUv + t * vec2(-1.0, -1.0)).rgb;
    vec3 m = texture(uTex, vUv + t * vec2( 1.0, -1.0)).rgb;
    vec3 o = e * 0.125;
    o += (a + c + g + i) * 0.03125;
    o += (b + d + f + h) * 0.0625;
    o += (j + k + l + m) * 0.125;
    outColor = vec4(o, 1.0);
  }`;

  const UP_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform float uRadius;
  uniform float uStretch;    // >1 smears sideways for an anamorphic streak
  void main() {
    vec2 t = (1.0 / vec2(textureSize(uTex, 0))) * uRadius * vec2(uStretch, 1.0);
    vec3 o = texture(uTex, vUv).rgb * 4.0;
    o += (texture(uTex, vUv + vec2(-t.x, 0.0)).rgb + texture(uTex, vUv + vec2(t.x, 0.0)).rgb) * 2.0;
    o += (texture(uTex, vUv + vec2(0.0, -t.y)).rgb + texture(uTex, vUv + vec2(0.0, t.y)).rgb) * 2.0;
    o += texture(uTex, vUv + vec2(-t.x, -t.y)).rgb + texture(uTex, vUv + vec2(t.x, -t.y)).rgb;
    o += texture(uTex, vUv + vec2(-t.x,  t.y)).rgb + texture(uTex, vUv + vec2(t.x,  t.y)).rgb;
    outColor = vec4(o * (1.0 / 16.0), 1.0);
  }`;

  // --- depth of field: one blurred copy the composite fades toward ---------
  const DOF_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec2 uDir;
  void main() {
    vec2 t = uDir / vec2(textureSize(uTex, 0));
    vec3 o = texture(uTex, vUv).rgb * 0.227027;
    o += (texture(uTex, vUv + t * 1.3846).rgb + texture(uTex, vUv - t * 1.3846).rgb) * 0.316216;
    o += (texture(uTex, vUv + t * 3.2308).rgb + texture(uTex, vUv - t * 3.2308).rgb) * 0.070270;
    outColor = vec4(o, 1.0);
  }`;

  // --- composite: tonemap, grade, flare, aberration, blur, grain, vignette --
  const POST_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uScene;
  uniform sampler2D uBloom;
  uniform sampler2D uVol;
  uniform sampler2D uGod;
  uniform sampler2D uSsr;
  uniform sampler2D uDof;
  uniform sampler2D uDepth;
  uniform sampler2D uAo;
  uniform float uTime;
  uniform float uSpeed;
  uniform float uFlash;
  uniform float uTunnel;
  uniform vec2 uRes;
  uniform vec2 uSunUv;
  uniform float uBloomAmt;
  uniform float uExposure;
  uniform float uGodAmt;
  uniform float uGrain;
  uniform float uMotion;
  uniform float uSsrAmt;
  uniform float uDofAmt;
  uniform float uFlareAmt;
  uniform float uAoAmt;
  uniform float uNear;
  uniform float uFar;
  uniform vec3 uSunCol;
  uniform float uSat;          // AgX look: saturation past the inset
  uniform float uPunch;        // ...and its contrast power

  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }
  float linear(float d) {
    float z = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
  }

  /* ------------------------------------------------------------ AgX -----
   *
   * The display transform, and the single largest thing separating this from a
   * browser demo.
   *
   * ACES was here before, and ACES has one failure mode this game walks into on
   * every frame: it compresses each channel independently, so a saturated light
   * above white saturates one channel first and the other two catch up on the
   * way up. A magenta tube at six times white therefore arrives WHITE with a
   * coloured fringe - and a game whose entire subject is saturated light above
   * white cannot afford that. The old code fought it by blending in a
   * luminance-tonemapped, chroma-preserving path, which held the hue but lost
   * the filmic knee that made the rest of the frame read as photographed.
   *
   * AgX (Troy Sobotka) solves it at the root. It rotates into a working space
   * whose primaries are pulled inward, takes the log2 of the open domain, runs
   * a sigmoid across a fixed exposure window, and rotates back out. The inset
   * is what does the work: with the primaries no longer pure, a channel cannot
   * run away on its own, so a bright neon DESATURATES smoothly toward white
   * along a path that keeps its hue instead of skewing it. It is the transform
   * Blender made its default, and for the same reason.
   *
   * The sigmoid is Benjamin Wrensch's sixth-order fit to the reference curve -
   * within a thousandth of it across the range, and a handful of multiplies
   * rather than the 3D LUT the reference implementation uses.
   */
  const mat3 AGX_IN = mat3(
    0.8424790622530940, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.8784686364697720, 0.0784336000000000,
    0.0792237451477643, 0.0791661274605434, 0.8791429737931040);
  const mat3 AGX_OUT = mat3(
     1.1968790051201700, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368,  1.1519031299041700, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433,  1.1510736726411600);
  const float AGX_MIN_EV = -12.47393;
  const float AGX_MAX_EV =   4.026069;

  vec3 agxCurve(vec3 x) {
    vec3 x2 = x * x;
    vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
         - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  }

  /* The look. AgX's base transform is deliberately neutral - it is a display
     transform, not a grade - so the picture is put back on top of it here.
     Saturation is pushed past one on purpose: the inset has already taken some
     out, and how far this route's neon sits from grey is its whole identity. */
  vec3 agxLook(vec3 v, float sat, float punch) {
    const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
    float luma = dot(v, LW);
    v = pow(max(v, 0.0), vec3(punch));
    return max(luma + sat * (v - luma), 0.0);
  }

  vec3 filmic(vec3 c) {
    c = AGX_IN * max(c, 0.0);
    // log2 into the fixed exposure window the sigmoid is defined over
    c = clamp((log2(max(c, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV), 0.0, 1.0);
    c = agxCurve(c);
    c = agxLook(c, uSat, uPunch);
    c = clamp(AGX_OUT * c, 0.0, 1.0);
    /* AgX's sigmoid IS the display transform: what comes out of it is already
       perceptually encoded. Everything downstream of this - the violet/cyan
       split-tone, the S-curve, the vignette and the final gamma - was written
       against a display-LINEAR tonemapper, so handing them an encoded value
       double-encodes it and the whole frame washes out to pastel.

       Decoding here rather than rewriting the grade keeps the change where it
       belongs: only the shape of the tone curve has moved. */
    return pow(c, vec3(2.2));
  }

  /* Lens ghosts: the frame mirrored through the centre a few times, each copy
     scaled differently and tinted, masked to the bright parts. Cheap, and it
     is what sells a real lens looking into a low sun. */
  vec3 ghosts(vec2 uv) {
    vec3 acc = vec3(0.0);
    vec2 c = 0.5 - uv;
    const int N = 5;
    for (int i = 1; i <= N; i++) {
      float f = float(i) * 0.31;
      vec2 g = 0.5 + c * (1.0 - f * 1.6);
      vec3 s = texture(uBloom, g).rgb;
      float m = smoothstep(0.25, 1.4, dot(s, vec3(0.33)));
      vec3 tint = vec3(1.0 - f * 0.4, 0.55 + f * 0.35, 0.35 + f * 0.8);
      acc += s * m * tint * (1.0 - f * 0.5);
    }
    return acc * 0.2;
  }

  void main() {
    vec2 uv = vUv;
    vec2 c = uv - 0.5;
    float r2 = dot(c, c);

    /* Restrained peripheral shutter blur and chromatic dispersion, in one loop.

       These used to be two passes, and the second undid the first: the blur
       accumulated six taps into the working colour, and then the aberration OVERWROTE
       scene.r and scene.b with single unblurred samples. Two of the three
       channels therefore never smeared at all, so the "speed blur" was a green
       ghost with a sharp magenta image sitting on top of it - which is also
       why turning it on read as a colour fringe rather than as speed.

       Splitting the channels inside the blur is both the fix and what a real
       lens does: the smear and the dispersion are the same optical path. */
    float edge = smoothstep(0.06, 0.34, r2);
    float ab = (0.00024 + uSpeed * 0.00038) * edge;
    vec3 scene;
    float blurAmt = uSpeed * 0.0065 * uMotion * edge;
    if (blurAmt > 0.0008) {
      float j = hash21(uv * uRes + fract(uTime) * 31.0) * 0.6;
      const int NB = 7;
      scene = vec3(0.0);
      float wsum = 0.0;
      for (int i = 0; i < NB; i++) {
        float t = (float(i) + j) / float(NB);
        vec2 p = uv - c * blurAmt * t;
        // the near taps count for more, so the frame stays legible while the
        // smear reads as a tail rather than as a double exposure
        float w = 1.0 - t * 0.55;
        scene.r += texture(uScene, p + c * ab).r * w;
        scene.g += texture(uScene, p).g * w;
        scene.b += texture(uScene, p - c * ab).b * w;
        wsum += w;
      }
      scene /= wsum;
    } else {
      scene.r = texture(uScene, uv + c * ab).r;
      scene.g = texture(uScene, uv).g;
      scene.b = texture(uScene, uv - c * ab).b;
    }

    /* Ambient occlusion, applied before anything is added to the frame and
       masked by how bright the pixel already is. Occlusion is a statement
       about how much *sky* reaches a surface; multiplying a neon tube by it
       would be nonsense, so the effect fades out as a pixel gets brighter than
       the ambient it is meant to be modulating. */
    if (uAoAmt > 0.001) {
      float ao = texture(uAo, uv).r;
      float lum0 = dot(scene, vec3(0.2126, 0.7152, 0.0722));
      scene *= mix(1.0, ao, uAoAmt * (1.0 - smoothstep(0.35, 1.6, lum0)));
    }

    // wet road: the screen-space reflection, added before anything else reads
    // the frame so it blooms and tonemaps with the rest of the light
    scene += texture(uSsr, uv).rgb * uSsrAmt;

    /* Depth of field. Only the far field softens - the road under the car has
       to stay razor sharp - and that falloff plus the aerial haze is what
       keeps the far side of the level from reading as a flat cut-out. */
    if (uDofAmt > 0.001) {
      float z = linear(texture(uDepth, uv).r);
      float coc = smoothstep(320.0, 2600.0, z) * uDofAmt;
      scene = mix(scene, texture(uDof, uv).rgb, coc);
    }

    // volumetric: attenuate the scene by transmittance, add what scattered
    vec4 vol = texture(uVol, uv);
    vec3 col = scene * vol.a + vol.rgb;

    col += texture(uBloom, uv).rgb * uBloomAmt;
    col += texture(uGod, uv).rgb * (1.0 - uTunnel) * uGodAmt;

    /* Bright roadside sources carry a very short exposure tail. It stays in
       the outer frame and is intentionally too subtle to become a drawn line. */
    if (uSpeed > 0.03) {
      vec3 streak = vec3(0.0);
      const int NS = 5;
      for (int i = 1; i <= NS; i++) {
        float t = float(i) / float(NS);
        streak += texture(uBloom, uv + c * t * uSpeed * 0.055).rgb * (1.0 - t * 0.7);
      }
      col += streak * (1.0 / float(NS)) * uSpeed * uSpeed
           * 0.16 * smoothstep(0.08, 0.30, r2);
    }
    if (uFlareAmt > 0.001) {
      col += ghosts(uv) * uFlareAmt * (1.0 - uTunnel);
      // a soft halo around the sun itself
      float sd = distance(uv * vec2(uRes.x / uRes.y, 1.0),
                          uSunUv * vec2(uRes.x / uRes.y, 1.0));
      col += uSunCol * exp(-sd * 5.5) * uFlareAmt * 1.6 * (1.0 - uTunnel);
    }
    col += uFlash;

    col *= uExposure;
    col = filmic(col);

    // grade: push shadows violet and highlights cyan, then lift saturation
    vec3 shadows = vec3(0.010, 0.004, 0.024);
    vec3 highs   = vec3(1.00, 0.975, 1.07);
    col = col * highs + shadows * (1.0 - col);
    // a firmer S-curve: the night has to sit down in the blacks or the neon has
    // nothing to be brighter than
    col = col * col * (3.0 - 2.0 * col) * 0.62 + col * 0.38;
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    /* Pushing past 1.0 is what makes the neon sing, but it drives the weakest
       channel below zero on anything strongly tinted, and a negative channel
       clamps to black - a magenta sign loses its green and turns into a hole.
       Eased back now that the rolloff above keeps the highlights coloured on
       its own: 1.52 on top of that oversaturates the midtones. */
    col = max(mix(vec3(lum), col, 1.42), 0.0);

    col *= smoothstep(1.15, 0.16, r2);                   // vignette
    // the CRT pass now runs after the temporal resolve, so the grain is not
    // averaged into a smooth haze by the history buffer
    outColor = vec4(pow(max(col, 0.0), vec3(1.0 / 2.2)), 1.0);
  }`;

  /* --- temporal anti-aliasing ---------------------------------------------

     The single biggest thing between this and a PC release was that thin bright
     geometry crawled: the edge lines, the chevron rails and the tunnel rings
     are one or two pixels wide against a dark road, and no amount of FXAA fixes
     a one-pixel line that is a slightly different one-pixel line next frame.

     Each frame the projection is jittered by a fraction of a pixel on a Halton
     sequence, so over several frames the renderer samples the whole pixel
     rather than the same point in it. The history is reprojected through last
     frame's view-projection using this frame's depth - camera motion is
     therefore exact - and clamped to the neighbourhood of the current pixel,
     which is what stops the cars smearing: anything the history disagrees with
     too strongly is rejected rather than blended.  */
  const TAA_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uCur;
  uniform sampler2D uHist;
  uniform sampler2D uDepth;
  uniform mat4 uInvVP;
  uniform mat4 uPrevVP;
  uniform vec2 uRes;
  uniform float uBlend;

  /* YCoCg. The neighbourhood test decides what the history is allowed to be,
     and doing it in RGB tests three correlated channels: a pixel that is
     merely brighter than its neighbours fails on all three at once and the
     history is thrown away, which is most of why a temporal pass looks soft.
     YCoCg separates luma from the two chroma axes, so brightness and colour
     are judged independently and only the one that actually disagrees is
     rejected. It is a rotation, so it costs four multiplies. */
  vec3 toYCoCg(vec3 c) {
    return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
                0.5 * c.r - 0.5 * c.b,
                -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
  }
  vec3 toRGB(vec3 c) {
    float t = c.x - c.z;
    return max(vec3(t + c.y, c.x + c.z, t - c.y), 0.0);
  }

  /* Clip toward the centre of the box rather than clamping each axis to it.

     Clamping moves a rejected sample to the nearest CORNER, which is a colour
     that appears nowhere in the neighbourhood - and on a moving neon edge that
     corner is a hue the scene does not contain, which is what makes clamped
     TAA fringe. Clipping walks the sample back along the line to the mean and
     stops at the boundary, so whatever comes out is a colour that was actually
     there. */
  vec3 clipToBox(vec3 lo, vec3 hi, vec3 q) {
    vec3 centre = 0.5 * (hi + lo);
    vec3 extent = 0.5 * (hi - lo) + 1e-5;
    vec3 v = q - centre;
    vec3 a = abs(v / extent);
    float m = max(a.x, max(a.y, a.z));
    return m > 1.0 ? centre + v / m : q;
  }

  /* Catmull-Rom history fetch, the five-tap form.

     A bilinear fetch of the reprojected history blurs it by up to half a texel
     EVERY frame, and because the result becomes the next frame's history that
     blur compounds - which is the real reason temporal anti-aliasing has a
     reputation for softness. A bicubic filter has no such loss; the nine-tap
     kernel collapses to five by exploiting the hardware's own bilinear
     interpolation between the middle pairs. */
  vec3 historyCR(vec2 uv) {
    vec2 pos = uv * uRes;
    vec2 tc1 = floor(pos - 0.5) + 0.5;
    vec2 f = pos - tc1;
    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);
    vec2 w12 = w1 + w2;
    vec2 off12 = w2 / max(w12, 1e-5);
    vec2 p0 = (tc1 - 1.0) / uRes;
    vec2 p3 = (tc1 + 2.0) / uRes;
    vec2 p12 = (tc1 + off12) / uRes;
    vec3 r = vec3(0.0);
    r += texture(uHist, vec2(p12.x, p0.y)).rgb * w12.x * w0.y;
    r += texture(uHist, vec2(p0.x, p12.y)).rgb * w0.x * w12.y;
    r += texture(uHist, vec2(p12.x, p12.y)).rgb * w12.x * w12.y;
    r += texture(uHist, vec2(p3.x, p12.y)).rgb * w3.x * w12.y;
    r += texture(uHist, vec2(p12.x, p3.y)).rgb * w12.x * w3.y;
    float wsum = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y
               + w3.x * w12.y + w12.x * w3.y;
    return max(r / max(wsum, 1e-5), 0.0);
  }

  void main() {
    vec3 cur = texture(uCur, vUv).rgb;
    float d = texture(uDepth, vUv).r;

    // where this pixel was last frame
    vec4 wp = uInvVP * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec3 world = wp.xyz / wp.w;
    vec4 pc = uPrevVP * vec4(world, 1.0);
    vec2 prevUv = pc.xy / pc.w * 0.5 + 0.5;

    if (uBlend <= 0.0 || pc.w <= 0.0 || prevUv.x < 0.0 || prevUv.x > 1.0
        || prevUv.y < 0.0 || prevUv.y > 1.0) {
      outColor = vec4(cur, 1.0);       // nothing to blend against
      return;
    }

    /* Variance clipping (Salvi). The min/max of a 3x3 is decided by its two
       most extreme pixels, so one firefly opens the box wide enough to admit
       anything and the clamp stops doing its job. The first two moments give
       the mean and the spread instead, and a box of mu +- gamma*sigma tracks
       what the neighbourhood actually is. */
    vec2 px = 1.0 / uRes;
    vec3 m1 = vec3(0.0), m2 = vec3(0.0);
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec3 c = toYCoCg(texture(uCur, vUv + vec2(float(x), float(y)) * px).rgb);
        m1 += c;
        m2 += c * c;
      }
    }
    const float N = 9.0;
    vec3 mu = m1 / N;
    vec3 sigma = sqrt(max(m2 / N - mu * mu, 0.0));
    // 1.25 sigma is the usual compromise: tight enough to catch a car moving
    // across a barrier, loose enough not to reject a static dithered gradient
    const float GAMMA = 1.25;
    vec3 lo = mu - GAMMA * sigma;
    vec3 hi = mu + GAMMA * sigma;

    vec3 histY = toYCoCg(historyCR(prevUv));
    vec3 clipped = clipToBox(lo, hi, histY);

    /* How far the clip had to move it is exactly how much this pixel and its
       history disagree, and that is the honest measure of a disocclusion: a
       moving object dragging its old colour behind it is precisely the case
       where the two are far apart. Where they are, trust the current frame. */
    float moved = length(clipped - histY) / max(length(sigma) + 1e-3, 1e-3);
    float trust = uBlend * (1.0 - clamp(moved * 0.35, 0.0, 0.85));

    /* ...and a pixel whose reprojection landed a long way from where it
       started is under motion, where a long history is what smears. The
       velocity is in pixels, so this is resolution-independent. */
    float vel = length((prevUv - vUv) * uRes);
    trust *= mix(1.0, 0.72, clamp(vel / 24.0, 0.0, 1.0));

    outColor = vec4(mix(cur, toRGB(clipped), trust), 1.0);
  }`;

  /* --- spatial reconstruction: a pass of its own -------------------------
   *
   * IT IS A SEPARATE PASS ON PURPOSE, and that is a performance decision
   * rather than a tidiness one. EASU is a twelve-tap filter. Folding it into
   * the final pass would mean every one of that pass's own neighbourhood
   * reads - the sharpen cross, FXAA's five taps - re-running all twelve, so a
   * four-tap sharpen would cost forty-eight. Reconstructing once into a
   * full-size target and letting the existing final pass read THAT is one
   * EASU per output pixel and leaves every downstream filter working, as it
   * should, on the image the player will actually see.
   */
  const UPSCALE_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec2 uRes;           // the OUTPUT resolution: what we are writing
  uniform vec2 uSrcRes;        // ...and what was rendered, which is smaller
  /* 1 spatial only, 2 spatial plus the sharpening pass built to follow it. */
  uniform float uMode;

  /* ================= SPATIAL RECONSTRUCTION (FSR 1) =====================
   *
   * What a sub-native frame is stretched back up WITH, and the reason the low
   * render scales are worth having at all.
   *
   * The browser's own filter is bilinear, which is a linear ramp between four
   * texels. Across an edge that is exactly wrong: it does not know there is an
   * edge, so it smears one into a gradient. A frame made mostly of thin bright
   * lines on a dark ground is the worst possible input for that, and every
   * neon rail in this game is one of those lines.
   *
   * AMD's FidelityFX Super Resolution 1 is the answer that needs no history,
   * no motion vectors and no neural network: a filter that works out WHICH WAY
   * THE EDGE RUNS and then samples along it rather than across it. Two passes,
   * both of them here:
   *
   *   EASU  Edge-Adaptive Spatial Upsampling. Reads a twelve-tap
   *         neighbourhood, estimates the local luma gradient from it, and
   *         builds an anisotropic kernel stretched along the edge direction -
   *         so a one-pixel line stays a one-pixel line instead of becoming a
   *         three-pixel ramp.
   *   RCAS  Robust Contrast-Adaptive Sharpening, which is designed to run
   *         after EASU. The amount is derived per pixel from the local min and
   *         max, so flat regions get none and a pixel already at the limit is
   *         not pushed past it. That is what separates it from an unsharp mask
   *         and its halos.
   *
   * This is a compact GLSL ES 3.00 port of the published algorithm (FSR 1 is
   * MIT-licensed, AMD GPUOpen). It is deliberately not a transcription: the
   * reference is written against packed 16-bit types and a compute shader with
   * shared memory, and WebGL2 has neither. What is preserved is the part that
   * does the work - the feature detection and the shape of the kernel.
   *
   * It runs ONLY when there is something to reconstruct. At or above NATIVE
   * the whole block is one compare against uUpscale.
   */
  vec3 tap(vec2 p) { return texture(uTex, p).rgb; }

  /* THE KERNEL, AND WHY IT HAS TO GO NEGATIVE.
   *
   * The first version of this was a positive-only lobe, chosen because it is
   * cheap and looks like a reasonable window. It is not one. A reconstruction
   * filter whose weights are all positive is a weighted average, and a
   * weighted average of a one-texel line is a blur - tools/checkupscale.js
   * measured a bright line coming back at 0.37 where plain bilinear left it at
   * 0.75, so the upscaler was quantifiably worse than the stretch it replaced.
   *
   * What separates a resample from a blur is the negative lobe: the taps
   * either side of a feature have to be SUBTRACTED, and that is what keeps an
   * edge an edge. This is Catmull-Rom on the anisotropic distance - a cubic,
   * so it is a handful of multiplies, it interpolates its samples exactly, and
   * its negative lobe is what preserves the line. With it, that same test
   * returns the line at 1.00. */
  float kernel(float x) {
    x = abs(x);
    if (x < 1.0) return ((1.5 * x - 2.5) * x) * x + 1.0;
    if (x < 2.0) return (((-0.5 * x + 2.5) * x) - 4.0) * x + 2.0;
    return 0.0;
  }

  vec3 easu(vec2 uv) {
    vec2 srcPx = 1.0 / uSrcRes;
    // where this output pixel lands in the source, in source texels
    vec2 pp = uv * uSrcRes - 0.5;
    vec2 fp = floor(pp);
    vec2 fr = pp - fp;                     // sub-texel offset, 0..1
    vec2 base = (fp + 0.5) * srcPx;

    /* The twelve taps FSR reads: the 4x4 block with its corners dropped. The
       corners carry the least gradient information per fetch, and dropping
       them is four fewer texture reads per output pixel. */
    vec3 cB = tap(base + vec2( 0.0, -1.0) * srcPx);
    vec3 cC = tap(base + vec2( 1.0, -1.0) * srcPx);
    vec3 cE = tap(base + vec2(-1.0,  0.0) * srcPx);
    vec3 cF = tap(base + vec2( 0.0,  0.0) * srcPx);
    vec3 cG = tap(base + vec2( 1.0,  0.0) * srcPx);
    vec3 cH = tap(base + vec2( 2.0,  0.0) * srcPx);
    vec3 cI = tap(base + vec2(-1.0,  1.0) * srcPx);
    vec3 cJ = tap(base + vec2( 0.0,  1.0) * srcPx);
    vec3 cK = tap(base + vec2( 1.0,  1.0) * srcPx);
    vec3 cL = tap(base + vec2( 2.0,  1.0) * srcPx);
    vec3 cN = tap(base + vec2( 0.0,  2.0) * srcPx);
    vec3 cO = tap(base + vec2( 1.0,  2.0) * srcPx);

    /* Green as the luma proxy, which is what the reference does. It is most
       of perceived brightness and costs no dot product; running the detection
       on full colour would let a pure hue change masquerade as an edge. */
    float lB = cB.g, lC = cC.g, lE = cE.g, lF = cF.g;
    float lG = cG.g, lH = cH.g, lI = cI.g, lJ = cJ.g;
    float lK = cK.g, lL = cL.g, lN = cN.g, lO = cO.g;

    /* The local feature, accumulated over the four inner 2x2 quads and
       weighted by how close this output pixel is to each - so the direction is
       the one AT this pixel rather than at the nearest source texel. Each quad
       contributes a horizontal and a vertical second difference. */
    vec2 dir = vec2(0.0);
    float len = 0.0;

    {                                       // centred on F
      float w = (1.0 - fr.x) * (1.0 - fr.y);
      float dc = lF - lG, dd = lF - lE;
      float du = lF - lB, dv = lF - lJ;
      dir += vec2(dd - dc, dv - du) * w;
      len += (abs(dd) + abs(dc) + abs(du) + abs(dv)) * w;
    }
    {                                       // centred on G
      float w = fr.x * (1.0 - fr.y);
      float dc = lG - lH, dd = lG - lF;
      float du = lG - lC, dv = lG - lK;
      dir += vec2(dd - dc, dv - du) * w;
      len += (abs(dd) + abs(dc) + abs(du) + abs(dv)) * w;
    }
    {                                       // centred on J
      float w = (1.0 - fr.x) * fr.y;
      float dc = lJ - lK, dd = lJ - lI;
      float du = lJ - lF, dv = lJ - lN;
      dir += vec2(dd - dc, dv - du) * w;
      len += (abs(dd) + abs(dc) + abs(du) + abs(dv)) * w;
    }
    {                                       // centred on K
      float w = fr.x * fr.y;
      float dc = lK - lL, dd = lK - lJ;
      float du = lK - lG, dv = lK - lO;
      dir += vec2(dd - dc, dv - du) * w;
      len += (abs(dd) + abs(dc) + abs(du) + abs(dv)) * w;
    }

    /* Turn the gradient into a kernel shape. The accumulated length is how
       strongly this pixel sits on a feature at all: on flat ground it is near
       zero and the kernel
       stays isotropic, which is what stops the filter inventing structure in
       a smooth gradient - a sky, in this game. */
    float dirMax = max(abs(dir.x), abs(dir.y));
    vec2 d2 = dirMax > 1e-6 ? dir / dirMax : vec2(1.0, 0.0);
    d2 = normalize(d2);

    float lenN = clamp(len * 0.5, 0.0, 1.0);
    lenN = lenN * lenN;
    float stretch = mix(1.0, 2.0, lenN);    // 1 flat, 2 along a hard edge

    /* The anisotropic distance, and the one line in this shader that is easy
       to write backwards.

       The accumulated direction is the luma GRADIENT, so ax points ACROSS
       the feature and ay runs ALONG it. A tap displaced across the edge belongs to the other side of
       it and must be treated as FAR; one displaced along the edge is more of
       the same edge and must be treated as NEAR. So the across component is
       multiplied by the stretch and the along component divided by it.

       Reversing the pair does not look like a subtle error: it averages across
       the edge it was meant to follow, which is a worse blur than the bilinear
       it replaced. tools/checkupscale.js exists because it was reversed here
       first, and the one-texel-line case is what caught it. */
    vec2 ax = d2;
    vec2 ay = vec2(-d2.y, d2.x);
    vec2 sc = vec2(stretch, 1.0 / stretch);

    vec2 offs[12];
    vec3 cols[12];
    offs[0]  = vec2( 0.0, -1.0); cols[0]  = cB;
    offs[1]  = vec2( 1.0, -1.0); cols[1]  = cC;
    offs[2]  = vec2(-1.0,  0.0); cols[2]  = cE;
    offs[3]  = vec2( 0.0,  0.0); cols[3]  = cF;
    offs[4]  = vec2( 1.0,  0.0); cols[4]  = cG;
    offs[5]  = vec2( 2.0,  0.0); cols[5]  = cH;
    offs[6]  = vec2(-1.0,  1.0); cols[6]  = cI;
    offs[7]  = vec2( 0.0,  1.0); cols[7]  = cJ;
    offs[8]  = vec2( 1.0,  1.0); cols[8]  = cK;
    offs[9]  = vec2( 2.0,  1.0); cols[9]  = cL;
    offs[10] = vec2( 0.0,  2.0); cols[10] = cN;
    offs[11] = vec2( 1.0,  2.0); cols[11] = cO;

    vec3 acc = vec3(0.0);
    float wsum = 0.0;
    for (int q = 0; q < 12; q++) {
      vec2 d = offs[q] - fr;
      vec2 r = vec2(dot(d, ax), dot(d, ay)) * sc;
      float w = kernel(length(r));
      acc += cols[q] * w;
      wsum += w;
    }

    /* Clamped to the 2x2 the sample actually sits in. Without this the
       anisotropic kernel overshoots on a hard edge and rings, which on neon
       reads as a dark outline round every bright line - the artefact FSR is
       most often blamed for, and which the reference clamps away in exactly
       this place. */
    vec3 lo4 = min(min(cF, cG), min(cJ, cK));
    vec3 hi4 = max(max(cF, cG), max(cJ, cK));
    return clamp(wsum > 1e-6 ? acc / wsum : cF, lo4, hi4);
  }

  /* RCAS. Runs on the RECONSTRUCTED image, so its neighbourhood is in output
     pixels and it reads the already-upscaled centre passed in rather than
     re-fetching, which would sample the source again at the wrong rate. */
  vec3 rcas(vec3 centre, vec2 uv, float amount) {
    vec2 px = 1.0 / uRes;
    vec3 up = easu(uv + vec2( 0.0, -1.0) * px);
    vec3 dn = easu(uv + vec2( 0.0,  1.0) * px);
    vec3 lf = easu(uv + vec2(-1.0,  0.0) * px);
    vec3 rt = easu(uv + vec2( 1.0,  0.0) * px);
    vec3 mn = min(min(up, dn), min(lf, rt));
    vec3 mx = max(max(up, dn), max(lf, rt));
    /* How much room there is to push, on whichever side is tighter. A pixel
       whose neighbourhood already spans the range gets almost nothing, which
       is what keeps this from ringing where an unsharp mask would. */
    vec3 headroom = min(max(mn, vec3(0.0)), max(vec3(1.0) - mx, vec3(0.0)));
    vec3 w = -sqrt(max(headroom, vec3(1e-5))) * amount;
    vec3 sum = up + dn + lf + rt;
    vec3 outc = (centre + sum * w) / (vec3(1.0) + 4.0 * w);
    return clamp(outc, mn, mx);
  }


  void main() {
    vec3 c = easu(vUv);
    /* RCAS is what FSR is designed to be followed by, and it is the reason
       the SHARP setting exists as something other than "more sharpening":
       the amount is derived per pixel from the local range, so it cannot
       push a pixel past what its neighbourhood already spans. */
    if (uMode > 1.5) c = rcas(c, vUv, 0.25);
    outColor = vec4(max(c, 0.0), 1.0);
  }`;

  /* --- final pass: sharpen, grain, scanlines, and FXAA when there is no TAA -
     Contrast-adaptive sharpening restores the bite temporal resolve costs, and
     doing the grain here rather than in the composite keeps it from being
     averaged away by the history. */
  const FINAL_FRAG = `#version 300 es
  precision highp float;
  in vec2 vUv; out vec4 outColor;
  uniform sampler2D uTex;
  uniform vec2 uRes;
  uniform float uFxaa;
  uniform float uSharpen;
  uniform float uGrain;
  uniform float uTime;

  /* --- the windscreen ----------------------------------------------------
     One sheet built on the CPU the moment something hits hard enough; see
     js/glass.js for what is in which channel. uCrackAmt is how much of it is
     left, and at zero the whole block below costs one compare. */
  uniform sampler2D uCrack;
  uniform float uCrackAmt;
  /* The tiling micro-fracture sheet, generated by tools/gentex.js and carried
     in the pack. R is the crack web, G the pulverised dust, B the sparkle. It
     only ever contributes where the star's own halo says there is damage. */
  uniform sampler2D uShards;


  float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  float hash21(vec2 p) {
    p = fract(p * vec2(233.34, 851.73));
    p += dot(p, p + 23.45);
    return fract(p.x * p.y);
  }

  vec3 fxaa(vec2 uv, vec2 px, vec3 rgbM) {
    float lNW = lum(texture(uTex, uv + vec2(-1.0, -1.0) * px).rgb);
    float lNE = lum(texture(uTex, uv + vec2( 1.0, -1.0) * px).rgb);
    float lSW = lum(texture(uTex, uv + vec2(-1.0,  1.0) * px).rgb);
    float lSE = lum(texture(uTex, uv + vec2( 1.0,  1.0) * px).rgb);
    float lM  = lum(rgbM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    if (lMax - lMin < max(0.0312, lMax * 0.125)) return rgbM;
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
    dir = clamp(dir * rcp, -8.0, 8.0) * px;
    vec3 a = 0.5 * (texture(uTex, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
                    texture(uTex, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 b = a * 0.5 + 0.25 * (texture(uTex, uv + dir * -0.5).rgb +
                               texture(uTex, uv + dir *  0.5).rgb);
    float lB = lum(b);
    return (lB < lMin || lB > lMax) ? a : b;
  }

  void main() {
    vec2 px = 1.0 / uRes;
    vec2 uv = vUv;

    /* BROKEN GLASS, BEFORE ANYTHING SAMPLES THE FRAME.
     *
     * The shard offset has to be applied to the LOOKUP, not to the result:
     * displacing the colour after the fact moves a pixel, while displacing the
     * fetch moves what the pixel is looking through - which is the difference
     * between a smear and a piece of glass sitting at an angle. So it happens
     * here, and the anti-aliasing and the sharpen downstream then work on the
     * refracted image the way they would on any other.
     *
     * The sheet is square and the frame is not, so it is sampled through an
     * aspect correction: without it every impact star is an ellipse, wider the
     * wider the window, and the one thing a radial crack pattern must be is
     * radial. */
    float crack = 0.0, frost = 0.0, sparkle = 0.0;
    vec2 ridge = vec2(0.0);
    vec3 c;
    if (uCrackAmt > 0.001) {
      vec2 cuv = vec2((vUv.x - 0.5) * ((uRes.x / max(uRes.y, 1.0)) / 1.7778) + 0.5, vUv.y);
      vec3 g = texture(uCrack, cuv).rgb;
      vec2 off = (g.gb - 0.5) * 2.0 * uCrackAmt * 0.016;
      off.x *= uRes.y / max(uRes.x, 1.0);
      uv += off;

      /* THE SCALE BELOW THE DRAWN CRACK.
         The star carries the structure; this carries the substance. Sampled at
         thirty times the frame and gated on the star's own halo, so it exists
         only where there is damage and is invisible everywhere else. */
      float halo = smoothstep(0.010, 0.52, g.r);
      vec3 sh = texture(uShards, cuv * 30.0 + off * 9.0).rgb;
      float web = sh.r * halo;
      crack = smoothstep(0.40, 0.92, g.r + web * 0.34) * uCrackAmt;
      frost = clamp(smoothstep(0.015, 0.46, g.r) + sh.g * halo * 0.55, 0.0, 1.0) * uCrackAmt;
      sparkle = sh.b * halo * uCrackAmt;

      /* WHICH WAY THE FRACTURE FACE IS TURNED.
         A crack is a bevel, and a bevel has a lit side and a dark one - that
         is most of what separates a fracture from a line drawn on the frame.
         The gradient of the crack field IS the edge normal, and it costs two
         texture fetches. */
      float e = 1.0 / 512.0;
      ridge = vec2(
        texture(uCrack, cuv + vec2(e, 0.0)).r - texture(uCrack, cuv - vec2(e, 0.0)).r,
        texture(uCrack, cuv + vec2(0.0, e)).r - texture(uCrack, cuv - vec2(0.0, e)).r);

      /* DISPERSION. Glass does not refract every wavelength by the same
         amount, and along a fracture face the split is wide enough to see -
         which is why a real cracked screen has colour along its edges that no
         amount of white line ever reproduces. Three fetches, at three
         slightly different offsets, only while there is damage. */
      float disp = length(off) * 0.55 * uCrackAmt;
      vec2 dir = length(off) > 1e-5 ? normalize(off) : vec2(1.0, 0.0);
      c = vec3(
        texture(uTex, uv + dir * disp).r,
        texture(uTex, uv).g,
        texture(uTex, uv - dir * disp).b);
    } else {
      c = texture(uTex, uv).rgb;
    }
    if (uFxaa > 0.5) c = fxaa(uv, px, c);

    if (uSharpen > 0.001) {
      // contrast-adaptive: a cross of neighbours, weighted by how much local
      // contrast there is, so flat areas are left alone and edges get their
      // bite back without ringing
      vec3 n = texture(uTex, uv + vec2(0.0, -px.y)).rgb;
      vec3 s = texture(uTex, uv + vec2(0.0,  px.y)).rgb;
      vec3 w = texture(uTex, uv + vec2(-px.x, 0.0)).rgb;
      vec3 e = texture(uTex, uv + vec2( px.x, 0.0)).rgb;
      vec3 mn = min(c, min(min(n, s), min(w, e)));
      vec3 mx = max(c, max(max(n, s), max(w, e)));
      vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, 1e-4), 0.0, 1.0);
      amp = sqrt(amp) * uSharpen;
      c = clamp(c + (c * 4.0 - n - s - w - e) * amp * 0.25, 0.0, 1.0);
    }

    /* ...and then the glass itself, over the top of the refracted image.
     *
     * MILLED GLASS SCATTERS. It does not darken and it does not tint: it takes
     * whatever light is behind it and spreads it, so a frosted patch over the
     * night sky stays dark and the same patch over a headlight goes white.
     * Driving it off the local luminance is what makes it behave like that in
     * both places from one term.
     *
     * A CRACK IS A MIRROR ON EDGE. The fracture face is a total-internal
     * reflection surface, which is why a cracked screen shows bright hairlines
     * against a dark scene and dark ones against a bright one. Both come out
     * of the same expression: a hot core scaled by what is behind it, over a
     * darkened base. */
    if (uCrackAmt > 0.001) {
      float l = lum(c);
      /* MILLED GLASS SCATTERS. It does not darken and it does not tint: it
         takes whatever light is behind it and spreads it, so a frosted patch
         over the night sky stays dark and the same patch over a headlight goes
         white. Driving it off the local luminance is what makes it behave like
         that in both places from one term. */
      vec3 milk = mix(c, vec3(l) * 1.25 + 0.035, 0.72);
      c = mix(c, milk, frost * 0.62);

      /* A CRACK IS A BEVEL, NOT A LINE.
         The fracture face is a total-internal-reflection surface: it is bright
         where it is turned toward the light and dark where it is turned away,
         and the transition across the few pixels of the face is what the eye
         reads as depth. The ridge vector is which way it is turned; the key is fixed
         and up-left, because a windscreen is lit from the sky. */
      vec2 key = normalize(vec2(-0.55, -0.83));
      float lit = clamp(dot(normalize(ridge + vec2(1e-6)), key), -1.0, 1.0);
      float face = 0.42 + 0.58 * lit;
      vec3 edge = vec3(0.86, 0.93, 1.10) * (0.14 + l * 2.30) * face;
      // ...and the dark side of the same bevel, which is what gives it a solid
      c = mix(c, c * (0.22 + 0.26 * (1.0 - face)) + edge, crack * 0.88);

      // the few fragments that happen to be turned at the light
      c += vec3(0.9, 0.96, 1.0) * sparkle * (0.25 + l * 1.4);
    }

    // the CRT pass goes last so nothing downstream averages it away
    c *= 1.0 - 0.030 * uGrain * step(0.5, fract(gl_FragCoord.y * 0.5));
    c += (hash21(vUv * uRes + fract(uTime) * 91.0) - 0.5) * 0.014 * uGrain;
    outColor = vec4(c, 1.0);
  }`;

  const EMPTY_KEYS = [];

  /* One synthetic key press, delivered where the real ones arrive.
   *
   * Down and up together, in the same tick. Every menu in the game tests for
   * the EDGE - `hit`, not `down` - so a press that is over immediately still
   * registers, while a key left down would steer the car the moment the panel
   * closed. The pair also means a disconnected pad cannot leave a direction
   * stuck on. */
  function synthKey(key) {
    if (!global.KeyboardEvent) return;
    const opts = { key: key, bubbles: true, cancelable: true, composed: true };
    try {
      global.dispatchEvent(new global.KeyboardEvent('keydown', opts));
      global.dispatchEvent(new global.KeyboardEvent('keyup', opts));
    } catch (e) { /* a browser that will not construct one */ }
  }

  class Input {
    constructor() {
      this.keys = Object.create(null);
      this.pressed = Object.create(null);
      this.touch = { steer: 0, throttle: 0, brake: 0, boost: false, ebrake: false };
      this.usingTouch = false;
      global.addEventListener('keydown', (e) => {
        const k = e.key.toLowerCase();
        if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].indexOf(k) >= 0) e.preventDefault();
        if (e.repeat) return;
        /* A REBIND EATS THE KEY IT IS LISTENING FOR.
           Otherwise pressing SPACE to bind the handbrake also arrives at the
           options screen as "confirm", which closes the very row that was
           waiting for it. The capture consumes the event and nothing else in
           the game sees that press at all. */
        if (this.captureNext) {
          e.preventDefault();
          const fn = this.captureNext;
          this.captureNext = null;
          fn(k);
          return;
        }
        this.keys[k] = true;
        this.pressed[k] = true;
      });
      global.addEventListener('keyup', (e) => { this.keys[e.key.toLowerCase()] = false; });
      global.addEventListener('blur', () => { this.keys = Object.create(null); });
    }
    down() { for (let i = 0; i < arguments.length; i++) if (this.keys[arguments[i]]) return true; return false; }
    /* Nothing is a hit while the gate is shut - see NR.Gate. A press that
       arrives in the first fifth of a second after a screen change was
       almost certainly meant for the screen that just left. */
    hit() {
      if (NR.Gate && !NR.Gate.open()) return false;
      for (let i = 0; i < arguments.length; i++) if (this.pressed[arguments[i]]) return true;
      return false;
    }

    /* ---------------------------------------------------------------------
     * THE SAME TWO QUESTIONS, ASKED BY ACTION RATHER THAN BY KEY.
     *
     * `binds` is handed over by Game whenever the settings change. Until it
     * is - and for any action a save has managed to strip entirely - the
     * table's own defaults answer, so a corrupt or half-written settings file
     * cannot produce a car that will not accelerate.
     * ------------------------------------------------------------------ */
    keysFor(action) {
      const b = this.binds && this.binds[action];
      if (b && b.length) return b;
      const d = NR.ACTION_DEFAULTS && NR.ACTION_DEFAULTS[action];
      return d || EMPTY_KEYS;
    }
    /** Is this action being held? */
    act(action) {
      const k = this.keysFor(action);
      for (let i = 0; i < k.length; i++) if (this.keys[k[i]]) return true;
      return this.padAct(action, false);
    }
    /** Did this action start this frame? */
    actHit(action) {
      const k = this.keysFor(action);
      for (let i = 0; i < k.length; i++) if (this.pressed[k[i]]) return true;
      return this.padAct(action, true);
    }

    /* The pad's answer to the same question.
     *
     * The controller's layout is FIXED rather than bound, and deliberately:
     * a rebind screen for fifteen buttons is a screen, the standard mapping
     * already tells every player which button is which, and a pad whose face
     * buttons had been swapped would make the diagram on the CONTROLS screen
     * a lie. The keyboard is where rebinding lives. */
    padAct(action, edge) {
      const p = this.pad;
      if (!p || !p.active) return false;
      const B = NR.PAD_BUTTONS;
      const q = edge ? (i) => p.hit(i) : (i) => p.held(i);
      switch (action) {
        case 'throttle': return p.value(B.RT) > 0.5;
        case 'brake': return p.value(B.LT) > 0.5;
        case 'boost': return q(B.A) || q(B.RB);
        case 'ebrake': return q(B.B) || q(B.LB);
        case 'raceMode': return q(B.X);
        case 'pause': return q(B.START);
        default: return false;
      }
    }
    endFrame() { this.pressed = Object.create(null); }
    sample() {
      let steer = 0, throttle = 0, brake = 0, boost = false, ebrake = false;
      if (this.act('left')) steer -= 1;
      if (this.act('right')) steer += 1;
      if (this.act('throttle')) throttle = 1;
      if (this.act('brake')) brake = 1;
      if (this.act('boost')) boost = true;
      if (this.act('ebrake')) ebrake = true;
      /* THE CONTROLLER.
       *
       * Read through js/gamepad.js rather than out of `navigator` here: it
       * polls once a frame, applies the player's deadzone and response curve,
       * and is the only thing in the game holding the current snapshot. This
       * used to call getGamepads itself with a hardcoded 0.12 deadzone and no
       * curve, which meant a worn stick drifted and none of it was adjustable.
       *
       * The pad REPLACES the keyboard's steering rather than adding to it. The
       * old code summed them, so a stick resting a hair off centre pulled
       * against a held arrow key and the car would not go straight on either
       * input. Whichever is asking for more, wins. */
      const pad = this.pad;
      if (pad && pad.active) {
        const ps = pad.steer();
        if (Math.abs(ps) > Math.abs(steer)) steer = ps;
        const B = NR.PAD_BUTTONS;
        const rt = pad.value(B.RT);
        const lt = pad.value(B.LT);
        if (rt > 0.04) throttle = Math.max(throttle, rt);
        if (lt > 0.04) brake = Math.max(brake, lt);
        if (pad.held(B.A) || pad.held(B.RB)) boost = true;
        if (pad.held(B.B) || pad.held(B.LB)) ebrake = true;
      }
      /* A LIVE WALL TAKES THE STEERING BUS.
       *
       * Chapter 6's arc walls invert it and Chapter 7's sensor curtains now do
       * the same, so the rule belongs to the input rather than to whichever
       * director happens to be running: Game.update publishes `invert` once a
       * frame and this is the only place that reads it. It used to be a test
       * against `NR.__level6ActiveDirector` reaching into another chapter's
       * private state from inside the input layer. */
      if (this.invert) steer = -steer;
      if (this.usingTouch) {
        steer = M.clamp(steer + this.touch.steer, -1, 1);
        throttle = Math.max(throttle, this.touch.throttle);
        brake = Math.max(brake, this.touch.brake);
        boost = boost || this.touch.boost;
        ebrake = ebrake || this.touch.ebrake;
      }
      const forge = global.NR.__level6ActiveDirector;
      // Cognition gates temporarily own WASD; the car coasts straight while
      // the player chooses.
      if (forge && forge.isChapter && forge.isChapter() && forge.question) {
        return { steer: 0, throttle: .35, brake: 0, boost: false, ebrake: false };
      }
      return { steer: M.clamp(steer, -1, 1), throttle, brake, boost, ebrake };
    }
  }

  class Game {
    constructor(opts) {
      this.canvas = opts.canvas;
      this.gl = this.canvas.getContext('webgl2', {
        antialias: false, alpha: false, depth: true,
        powerPreference: 'high-performance',
      });
      if (!this.gl) throw new Error('WebGL2 is not available in this browser.');
      memoiseVao(this.gl);

      this.gameData = opts.gameData || {};
      this.hud = new global.NR.Hud(opts.hudCanvas, this.gameData);
      /* The interface can see the picture behind it.
         Both canvases are drawn in the same animation frame - the 3D first,
         the interface over it - so the modal screens can sample the finished
         3D frame and blur it rather than covering it with a rectangle. See
         Hud.frost. */
      this.hud.glCanvas = this.canvas;
      this.audio = new global.NR.Audio();
      this.input = new Input();
      /* THE CONTROLLER.

         One poll per frame, at the top of update, and everything else reads
         the result - see js/gamepad.js for why that matters: getGamepads
         hands back a snapshot rather than live objects, so two readers asking
         in the same frame get two different frames and one of them misses an
         edge. The input layer is given a reference rather than calling the
         API itself for exactly that reason. */
      this.pad = global.NR.Pad ? new global.NR.Pad() : null;
      this.input.pad = this.pad;
      this.scene = new global.NR.Scene(this.gl);
      this.scene.sunColor = SUN_COL;
      this.scene.ambInt = LIGHT.ambient;
      this.scene.sunInt = LIGHT.sun;
      this.fx = global.NR.Fx ? new global.NR.Fx(this.gl) : null;
      /* What each car has been driven into. One record per body on the road:
         the player's, the rival's (which is also the R-IX's, because Chapter 7
         skins the rival Vehicle rather than fielding a second one) and one per
         entrant on Chapter 4's invitational grid. */
      this.damage = global.NR.Damage ? new global.NR.Damage() : null;
      this.rivalDamage = global.NR.Damage ? new global.NR.Damage() : null;
      // ...and the screen the player is looking through
      this.glass = global.NR.Glass ? new global.NR.Glass(this.gl) : null;
      /* The run in progress, kept without being asked. See js/autosave.js for
         what it can and cannot restore. */
      this.autosave = global.NR.Autosave ? new global.NR.Autosave(this) : null;
      // a lit gantry across the road at the end of every route, generated with
      // the rest of the dressing so it is there whichever route is chosen
      this.scene.gates = LEVELS.map(l => l.to);

      const gl = this.gl;
      this.pPre = G.program(gl, G.FS_VERT, BLOOM_PRE_FRAG, 'bloomPre');
      this.pDown = G.program(gl, G.FS_VERT, DOWN_FRAG, 'down');
      this.pUp = G.program(gl, G.FS_VERT, UP_FRAG, 'up');
      this.pVol = G.program(gl, G.FS_VERT, VOL_FRAG, 'volumetric');
      this.pOcc = G.program(gl, G.FS_VERT, OCCLUDE_FRAG, 'occlude');
      this.pGod = G.program(gl, G.FS_VERT, GODRAY_FRAG, 'godray');
      this.pSsr = G.program(gl, G.FS_VERT, SSR_FRAG, 'ssr');
      this.pAo = G.program(gl, G.FS_VERT, SSAO_FRAG, 'ssao');
      this.pDof = G.program(gl, G.FS_VERT, DOF_FRAG, 'dof');
      this.pPost = G.program(gl, G.FS_VERT, POST_FRAG, 'post');
      this.pTaa = G.program(gl, G.FS_VERT, TAA_FRAG, 'taa');
      this.pUpscale = G.program(gl, G.FS_VERT, UPSCALE_FRAG, 'upscale');
      this.pFinal = G.program(gl, G.FS_VERT, FINAL_FRAG, 'final');

      // linear HDR scene with a sampleable depth buffer for the volumetrics
      // and a packed normal/roughness buffer for the reflections
      this.rtScene = G.target(gl, 2, 2, { float: true, depthTex: true, mrt: true });
      this.rtVol = G.target(gl, 2, 2, { float: true });
      this.rtOcc = G.target(gl, 2, 2, { float: true });
      this.rtGod = G.target(gl, 2, 2, { float: true });
      this.rtSsr = G.target(gl, 2, 2, { float: true });
      this.rtSsrB = G.target(gl, 2, 2, { float: true });
      this.rtVolB = G.target(gl, 2, 2, { float: true });
      this.rtAo = G.target(gl, 2, 2, {});
      this.rtAoB = G.target(gl, 2, 2, {});
      this.rtDofA = G.target(gl, 2, 2, { float: true });
      this.rtDofB = G.target(gl, 2, 2, { float: true });
      this.rtLdr = G.target(gl, 2, 2, {});
      /* Where a reconstructed frame lands. Sized to the CANVAS rather than to
         the render targets, because it is the only buffer in the chain that is
         the size of the thing the player is looking at. Allocated always and
         resized to 2x2 when it is not in use, which costs nothing and keeps
         the resize path from having to create and destroy an attachment. */
      this.rtUp = G.target(gl, 2, 2, {});
      // two history buffers, swapped each frame
      this.rtHist = [G.target(gl, 2, 2, {}), G.target(gl, 2, 2, {})];
      this.histIndex = 0;
      this.prevVP = M4.identity(M4.make());
      this.haveHistory = false;
      this.frameIndex = 0;
      // six-level bloom pyramid; each level halves again
      this.bloom = [];
      for (let i = 0; i < BLOOM_LEVELS; i++) this.bloom.push(G.target(gl, 2, 2, { float: true }));
      this.emptyVAO = gl.createVertexArray();

      this.proj = M4.make();
      this.view = M4.make();
      this.vp = M4.make();
      this.invVP = M4.make();
      this.model = M4.make();
      this.rivalModel = M4.make();
      this.eye = V3.make();
      this.target = V3.make();
      this.up = V3.make(0, 1, 0);

      this._state = 'loading';
      // ...and nothing plays over the photosensitivity notice. See onMusic.
      this.musicHeld = true;
      this.time = 0;
      this.fade = 1;
      this.fadeTarget = 0;
      this.loadProgress = 0;
      this.raceTime = 0;
      this.countdown = 0;
      this.chase = 0.5;
      // the HUD is MPH, as the original was
      this.useMetric = false;
      this.newRecord = false;
      this.record = readNum(RECORD_KEY);
      this.flash = 0;
      this.shake = 0;
      this.speedFx = 0;
      this.speedRush = 0;
      this.speedLimitFx = 0;
      this.boostFx = 0;
      this.boostKick = 0;
      this.raceModeFx = 0;
      this.speedBoostWas = false;
      this.tunnel = 0;
      this.progress = 0;
      this.distance = 0;
      this.fov = CAM.baseFov;
      this.camYaw = 0;
      this.camHeight = CAM.height;
      /* WHICH VIEW THE PLAYER IS DRIVING FROM. See CAM_MODES and cycleCamera.
         Held on the game rather than in the settings because it is a thing
         changed mid-corner, not a preference configured once - but it is
         persisted, because coming back to a different camera than the one you
         left in is the kind of small wrongness nobody reports and everybody
         notices. */
      const savedCam = readNum(CAM_KEY);
      this.camMode = (savedCam !== null && savedCam >= 0 && savedCam < CAM_MODES.length)
        ? savedCam | 0 : 0;

      // scoring
      this.score = 0;
      this.combo = 1;
      this.comboTimer = 0;
      this.driftBank = 0;
      this.topSpeedSeen = 0;
      this.cleanTime = 0;

      this.settings = loadSettings();
      /* Which page of the options screen is open, and which row on it.
         `settingRows` is re-derived whenever the tab changes rather than being
         a second list that has to be kept in step with it. */
      this.controlTab = 0;
      this.settingRows = tabRows(0);
      this.controlIndex = 0;
      /* The action whose key is being listened for, or null. While this is
         set the keyboard belongs to the options screen and to nothing else -
         see Input.captureNext. */
      this.bindCapture = null;

      this.levels = LEVELS;
      this.difficulties = DIFFICULTIES;
      this.cleared = loadProgress();   // hardest difficulty beaten, per level
      this.levelIndex = 0;
      this.diffIndex = 0;
      /* Free Roam. Off until a run is started from the open-route screen;
         js/freeroam.js owns that screen, this file owns the run. */
      this.freeRoam = false;
      this.freeRoamRegion = 0;
      this.freeRoamFrom = LEVELS[0].from;
      this.freeRoamRegionShown = -1;
      this.freeRoamClock = 0;
      this.freeRoamBanner = null;
      this.freeRoamFog = 1 / 4200;
      this.freeRoamGate = 0;
      this.freeRoamMode = null;
      this.soloRun = false;
      this.recordKey = RECORD_KEY;
      this.regionEdges = REGION_EDGES;
      this.freeRoamEnd = FREE_ROAM_END;
      this.menuIndex = 0;
      this.menuPointerIndex = -1;
      this.controlsPointer = null;
      this.pausePointerIndex = -1;
      this.confirmPointerIndex = -1;
      this.finishPointerIndex = -1;
      this.confirmBox = null;
      this.confirmIndex = 0;
      this.confirmFrom = null;
      this.cursorHiddenForRun = false;
      /* Two rows, and START is a door rather than a mode: js/modeselect.js
         rebinds it to the driver terminal, where STORY MODE and FREE ROAM are
         chosen. js/story.js rebinds it to the campaign when that file is
         loaded and the terminal is not. */
      this.menuItems = [
        { label: 'START', typed: 0, act: () => { if (this.story) this.story.enterStory(); } },
        { label: 'CONTROLS', typed: 0, act: () => { this.state = 'controls'; this.controlIndex = 0; } },
        /* QUIT ends the process.

           On the desktop build that is what it says: js/host.js asks the
           native host to exit, which releases the GPU context and the audio
           device rather than leaving a hidden window holding both. Under a
           plain web server there is nothing to quit to, so the row fades the
           screen out and stops the simulation - the honest version of the same
           gesture when the page cannot close itself. */
        { label: 'QUIT', typed: 0, act: () => this.askQuit() },
      ];
    /* The rows are rebuilt when the card opens - see enterPause - because
       whether there is a checkpoint to go back to depends on where the player
       is when they press it. */
      this.pauseItems = ['RESUME', 'RESTART', 'MAIN MENU'];
      this.pauseIndex = 0;
      this.finishItems = ['RETRY', 'MAIN MENU'];
      this.finishIndex = 0;

      this.bindUi();
      this.onResize();
      global.addEventListener('resize', () => this.onResize());
    }

    async load() {
      await this.hud.load();
      await this.scene.load(p => { this.loadProgress = p * 0.98; });
      this.track = new global.NR.Track(this.scene.man.centre);
      this.car = new global.NR.Vehicle(this.track);
      this.car.lift = this.scene.man.carLift || 0;
      // the rival is a second car of exactly the same class, driven by a
      // driver rather than by a keyboard
      this.rival = new global.NR.Vehicle(this.track);
      this.rival.lift = this.car.lift;
      this.driver = new global.NR.Driver(this.track, DIFFICULTIES[this.diffIndex]);
      this.finishAt = this.findFinishLine();
      this.applyLevel();
      this.resetCar();
      this.loadProgress = 1;
      this.applySettings();
      this.toMenu();
      /* The theme exists now. If the host or the browser was ever going to let
         it play unprompted, this is the call that does it. */
      if (this.startAudio) this.startAudio();
    }

    /* Where the race actually ends.
       The finish gantry stands at 22.6 km but the centreline runs on to 26.9,
       so ending the race at the end of the data left the player driving four
       kilometres past a finish line that had already gone by. The line is taken
       from the gantry's own position instead. */
    findFinishLine() {
      const man = this.scene.man;
      let bill = null;
      for (const inst of man.world) {
        const named = (inst.mats || []).some(mi => mi >= 0 && man.materials[mi] &&
          /^Finish/i.test(man.materials[mi].name || ''));
        if (named) { bill = inst; break; }
      }
      if (!bill) return this.track.length;
      // Track.project searches around a hint; the gantry has no hint to search
      // around, so this sweeps the whole centreline once, at load time.
      let best = 0, bestD = Infinity;
      const C = this.track.C;
      for (let i = 0; i < C.count; i++) {
        const dx = C.x[i] - bill.m[12], dz = C.z[i] - bill.m[14];
        const d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = i * C.step; }
      }
      return M.clamp(best, 500, this.track.length);
    }

    bindUi() {
      /* The first gesture starts the audio graph and nothing else.

         This used to grab fullscreen as well, on the first click or key press
         anywhere on the page. A racer taking over the whole screen the instant
         you touch it is hostile: it fires while you are still reading the title
         card, it re-lays out the canvas mid-frame, and the only way back out is
         ESC - which is also the pause key. Fullscreen is now something the
         player asks for, with F, and never something interacting with the game
         does to them. */
      /* THE THEME SHOULD BE PLAYING BEFORE ANYTHING IS TOUCHED.
       *
       * Reported: the music only starts once you click inside the game. That
       * is exactly what the old binding did - `go` was attached to the CANVAS
       * pointerdown and to one window keydown - so a player who came in
       * through the mode-select panel, or who moved the mouse and read the
       * title for a while, sat in silence.
       *
       * Two things are going on and they need different answers.
       *
       * THE POLICY. A browser will not let a page start audio before the
       * player has interacted with it, and no amount of asking changes that.
       * But it is not a browser-only game: inside the desktop host there is no
       * such gate, and a browser that has decided this origin has enough media
       * engagement will also allow it. Both of those only pay off if the game
       * ACTUALLY TRIES at startup instead of assuming it will be refused - so
       * it tries, immediately, and checks whether it worked.
       *
       * THE BINDING. When it is refused, the very next interaction of ANY kind
       * anywhere on the page should start it - not a click on one particular
       * element. That is what the wide listener list below is: every event
       * type a browser will accept as an activation gesture, on the document,
       * at capture, so a handler that stops propagation cannot swallow it.
       *
       * It is idempotent and it disarms itself the moment the context reports
       * `running`, which is the only reliable signal that the gate is open -
       * `resume()` resolving is not, because a resume from a gesture the
       * browser did not count leaves the context suspended and returns
       * perfectly happily. */
      const go = () => {
        this.audio.init();
        this.audio.resume();
        this.onMusic();
        if (this.audio.running) disarm();
      };
      /* ...and the same call from anywhere else that has a reason to try
         again. The most important one is the end of load(): the first attempt
         happens in the constructor, before the pack is open, so there is no
         theme to start yet even where the policy would have allowed it. */
      this.startAudio = go;
      const GESTURES = ['pointerdown', 'pointerup', 'mousedown', 'touchstart',
        'touchend', 'keydown', 'click', 'wheel'];
      const disarm = () => {
        for (const ev of GESTURES) global.document.removeEventListener(ev, go, true);
      };
      for (const ev of GESTURES) {
        global.document.addEventListener(ev, go, { capture: true, passive: true });
      }
      /* ...and a first attempt now, which is the one that carries the desktop
         host. A context created before the page has settled can also come back
         suspended for a moment and then be allowed, so it is retried a few
         times over the first couple of seconds and then left to the gesture. */
      go();
      let tries = 0;
      const poll = global.setInterval(() => {
        if (this.audio.running || ++tries > 8) { global.clearInterval(poll); return; }
        go();
      }, 250);

      /* LOSING THE WINDOW IS A PAUSE.
       *
       * Alt-tab out of a race and the loop keeps running: the car keeps
       * driving on whatever the last sampled input was, and - because the
       * mixer is told the car is active - it keeps making the noise of it, in
       * a window that is not on screen. Input already clears its held keys on
       * blur, which stops the car, but the state machine still says `racing`
       * and the idle note still sits there.
       *
       * So a lost window pauses the run, exactly as ESC would. It is only ever
       * applied to a live race - a menu, a cutscene or the finish card have no
       * reason to change state - and it is one-way: coming back does not
       * resume for you, because being dropped straight back into a race you
       * were not looking at is worse than the pause. */
      const lostFocus = () => {
        if (this.autosave) this.autosave.flush('focus');
        if (this.state === 'racing' || this.state === 'countdown') this.enterPause();
        else if (this.audio && this.audio.silenceCar) this.audio.silenceCar();
      };
      global.addEventListener('blur', lostFocus);
      global.document.addEventListener('visibilitychange', () => {
        if (global.document.hidden) lostFocus();
      });
      this.canvas.addEventListener('pointermove', (e) => {
        /* FREE LOOK.
         *
         * A sensitivity setting that scales nothing is a lie, so the mouse
         * does something now: while a run is live and FREE LOOK is on, moving
         * it swings the chase camera round the car. It is deliberately a LOOK
         * and not a steer - the car is driven from the keyboard and having two
         * devices fighting over the same axis is how a racing game ends up
         * feeling loose - and it recentres itself the moment the pointer
         * stops, so it can never be left pointing somewhere the player has
         * forgotten about.
         *
         * Raw movementX/Y where the browser gives it, because that is the only
         * figure that is independent of where in the window the pointer
         * happens to have run out of room. */
        if (this.mouseLookOn && (this.state === 'racing' || this.state === 'countdown')) {
          const dx = e.movementX === undefined ? 0 : e.movementX;
          const dy = e.movementY === undefined ? 0 : e.movementY;
          const k = 0.0022 * (this.mouseSens === undefined ? 1 : this.mouseSens);
          this.lookYawWant = M.clamp((this.lookYawWant || 0) + dx * k, -1.35, 1.35);
          this.lookPitchWant = M.clamp(
            (this.lookPitchWant || 0) + dy * k * (this.mouseInvert || 1) * 0.6, -0.5, 0.7);
          this.lookHold = 0.45;
        }
        const index = this.menuItemAt(e);
        if (index >= 0 && index !== this.menuIndex) {
          this.menuIndex = index;
          this.audio.uiMove();
        }
        const option = this.controlItemAt(e);
        if (option && option.index !== this.controlIndex) {
          this.controlIndex = option.index;
          this.audio.uiMove();
        }
        const pauseIndex = this.pauseItemAt(e);
        if (pauseIndex >= 0 && pauseIndex !== this.pauseIndex) {
          this.pauseIndex = pauseIndex;
          this.audio.uiMove();
        }
        const confirmIndex = this.confirmItemAt(e);
        if (confirmIndex >= 0 && confirmIndex !== this.confirmIndex) {
          this.confirmIndex = confirmIndex;
          this.audio.uiMove();
        }
        const finishIndex = this.finishItemAt(e);
        if (finishIndex >= 0 && finishIndex !== this.finishIndex) {
          this.finishIndex = finishIndex;
          this.audio.uiMove();
        }
      });
      this.canvas.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        // the audio unlock is on the document now, so this does not repeat it
        const index = this.menuItemAt(e);
        if (index >= 0) {
          this.menuPointerIndex = index;
          return;
        }
        const option = this.controlItemAt(e);
        if (option) {
          this.controlsPointer = option;
          return;
        }
        const confirmIndex = this.confirmItemAt(e);
        if (confirmIndex >= 0) {
          this.confirmPointerIndex = confirmIndex;
          return;
        }
        const pauseIndex = this.pauseItemAt(e);
        if (pauseIndex >= 0) {
          this.pausePointerIndex = pauseIndex;
          return;
        }
        /* ...and the card at the end, which takes a click on the row under
           the pointer rather than "anywhere on the screen means RETRY". */
        const finishIndex = this.finishItemAt(e);
        if (finishIndex >= 0) {
          this.finishPointerIndex = finishIndex;
          return;
        }
        /* Non-menu screens retain their tap/click-to-continue behaviour; a
           blank click on the title screen deliberately does nothing. */
        if (this.state !== 'menu' && this.state !== 'controls') this.pointer = true;
      });
      document.addEventListener('fullscreenchange', () => this.onResize());
      document.addEventListener('webkitfullscreenchange', () => this.onResize());

      const tc = document.getElementById('touch');
      if (tc && ('ontouchstart' in global || navigator.maxTouchPoints > 0)) {
        tc.classList.remove('hidden');
        this.input.usingTouch = true;
        const bind = (id, on, off) => {
          const el = document.getElementById(id);
          if (!el) return;
          const dn = (e) => { e.preventDefault(); go(); on(); };
          const up = (e) => { e.preventDefault(); off(); };
          el.addEventListener('touchstart', dn, { passive: false });
          el.addEventListener('touchend', up, { passive: false });
          el.addEventListener('touchcancel', up, { passive: false });
          el.addEventListener('mousedown', dn);
          el.addEventListener('mouseup', up);
        };
        const t = this.input.touch;
        bind('tLeft', () => { t.steer = -1; }, () => { t.steer = 0; });
        bind('tRight', () => { t.steer = 1; }, () => { t.steer = 0; });
        bind('tGas', () => { t.throttle = 1; }, () => { t.throttle = 0; });
        bind('tBrake', () => { t.brake = 1; }, () => { t.brake = 0; });
        bind('tBoost', () => { t.boost = true; }, () => { t.boost = false; });
        bind('tStart', () => { this.confirm(); }, () => {});
      }
    }

    /** Convert a browser pointer position to the canvas HUD's virtual space. */
    canvasPoint(e) {
      if (!this.hud || !this.hud.k) return null;
      const r = this.canvas.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const x = ((e.clientX - r.left) * this.hud.w / r.width - this.hud.w / 2) / this.hud.k;
      const y = (this.hud.h / 2 - (e.clientY - r.top) * this.hud.h / r.height) / this.hud.k;
      return { x, y };
    }

    /** Return the title-menu row under a pointer, in the HUD's virtual space.
     * Keeping these dimensions alongside Hud.drawMenu makes mouse hit areas
     * match the visible neon brackets at every aspect ratio and DPR. */
    menuItemAt(e) {
      if (this.state !== 'menu') return -1;
      const p = this.canvasPoint(e);
      if (!p) return -1;
      const { x, y } = p;
      if (Math.abs(x) > 230) return -1;
      // the same geometry Hud.drawMenu lays the rows out with
      const ML = global.NR.MENU_LAYOUT;
      const n = this.menuItems.length;
      for (let i = 0; i < n; i++) {
        if (Math.abs(y - ML.yFor(i, n)) <= 40) return i;
      }
      return -1;
    }

    /* Leave the game.

       The fade and the audio stop are not decoration: quitting from a running
       title screen means an engine loop and a menu theme are playing, and a
       process that exits with them mid-buffer clicks. A tenth of a second is
       enough to duck them and to let the last frame land. */
    quitGame() {
      if (this.quitting) return;
      if (this.autosave) this.autosave.flush('quit');
      this.quitting = true;
      this.fadeTo(1);
      try {
        if (this.audio && this.audio.stopAll) this.audio.stopAll();
        else if (this.audio && this.audio.setVolumes) this.audio.setVolumes(0, 0);
      } catch (e) { /* the mixer may never have started */ }
      const host = global.NR.Host;
      global.setTimeout(() => {
        if (host && host.native) { host.quit(); return; }
        /* A browser tab cannot close itself unless it opened itself. Say so,
           and stop pretending to be a game that is still running. */
        this.state = 'quit';
        try { global.close(); } catch (e) { /* not permitted */ }
      }, 260);
    }

    /** Hit-test the visual columns in Hud.drawControlsScreen: label, previous/next
     * chevrons, value field, level meter, and Save and Back. */
    controlItemAt(e) {
      if (this.state !== 'controls') return null;
      const p = this.canvasPoint(e);
      if (!p) return null;
      const rows = this.settingRows || [];
      const L = CONTROLS_LAYOUTS[this.controlTab] || CONTROLS_LAYOUT;
      /* THE TABS, WHICH ARE ROW MINUS ONE.
         Drawn as a strip under the title rule and hit-tested here from the
         same numbers the strip is painted from - see Hud.drawControlsScreen. */
      if (Math.abs(p.y - CTL_TAB_Y) <= 18) {
        for (let t = 0; t < CONTROL_TABS.length; t++) {
          const cx = ctlTabX(t);
          if (Math.abs(p.x - cx) <= CTL_TAB_W / 2) return { tab: t };
        }
      }
      for (let i = 0; i < rows.length; i++) {
        const y = L.rows[i];
        if (Math.abs(p.y - y) > 27 || p.x < -430 || p.x > 425) continue;
        const row = rows[i];
        // a binding row has one target: the key itself, which starts listening
        if (row.bind) return { index: i, bind: true };
        /* Each lit meter segment is itself a direct setting target. */
        if (row.opts.length > 2 && p.x >= 318 && p.x <= 412) {
          const value = M.clamp(Math.round((p.x - 365) / 16 + (row.opts.length - 1) / 2), 0, row.opts.length - 1);
          return { index: i, value };
        }
        if (p.x >= -80 && p.x <= 70) return { index: i, direction: -1 };
        if (p.x >= 185 && p.x <= 310) return { index: i, direction: 1 };
        if (p.x >= 70 && p.x < 185) return { index: i, direction: 1 };
        return { index: i, direction: 0 };
      }
      const exitY = L.exitY;
      if (Math.abs(p.y - exitY) <= 34 && Math.abs(p.x) <= 235) return { index: rows.length, exit: true };
      /* RESET, on the controls page only, beside the exit button rather than
         in the list - it is not a setting, it is a way out of one. */
      if (this.controlTab === 1 && Math.abs(p.y - exitY) <= 34
          && p.x >= 250 && p.x <= 470) return { index: rows.length, reset: true };
      return null;
    }

    /** Pause buttons share Hud.menuList's centre, height, and vertical gap. */
    /* ------------------------------ WHICH ROW IS UNDER THE POINTER --
     *
     * One answer for every card that has a list on it, taken from where the
     * list was actually drawn rather than from a copy of its numbers.
     *
     * All three used to carry their own copy and all three had drifted. The
     * pause card tested rows at -8 with a 62 gap against a list drawn at -12
     * with a 64 gap, so every row was a few units out and the error grew down
     * the card. The confirmation tested a half-width of 205 against a bar 470
     * wide, so the outer thirty units of a row you could see highlighted did
     * not answer the mouse. And the card at the end of a race had no test at
     * all - RETRY and MAIN MENU were keyboard-only on the one screen a player
     * is guaranteed to meet, which is what was reported.
     *
     * Hud.menuList publishes `listRows` when it draws. The states below are
     * modal and only one list is ever up, so one record is enough - and each
     * caller checks its own state first, so a stale record from another card
     * can never be read by the wrong one. */
    listItemAt(e, pad) {
      const rows = this.hud && this.hud.listRows;
      if (!rows || !rows.n) return -1;
      const p = this.canvasPoint(e);
      if (!p || Math.abs(p.x) > rows.width * 0.5 + (pad === undefined ? 18 : pad)) return -1;
      for (let i = 0; i < rows.n; i++) {
        if (Math.abs(p.y - (rows.baseY - i * rows.gap)) <= rows.half) return i;
      }
      return -1;
    }

    pauseItemAt(e) {
      if (this.state !== 'paused') return -1;
      return this.listItemAt(e);
    }

    /* ------------------------------------------------------ ARE YOU SURE --
     *
     * One modal, used by everything irreversible. QUIT is the reason it
     * exists - it ends the process, and on the title screen it sits one row
     * below CONTROLS, which is a keystroke away from a campaign - but the same
     * question is worth asking of anything that throws work away.
     *
     * It is a STATE rather than a flag on the menu, for the same reason the
     * pause card is: the thing underneath must stop reading the keyboard.
     * A confirmation the arrow keys walk past is not a confirmation.
     *
     * NO is index 0 and is where the selection starts. A dialogue that opens
     * on YES is a dialogue that turns a mis-hit ENTER into the exact action it
     * was put there to prevent. */
    askConfirm(opts) {
      const o = opts || {};
      this.confirmBox = {
        title: o.title || 'ARE YOU SURE?',
        body: o.body || '',
        note: o.note || '',
        items: [o.cancel || 'NO — GO BACK', o.confirm || 'YES'],
        onYes: typeof o.onYes === 'function' ? o.onYes : () => {},
      };
      this.confirmIndex = 0;
      this.confirmFrom = this.state;
      this.state = 'confirm';
      this.hud.selY = null;         // the bar re-seeks rather than sliding in
      this.audio.uiMove();
    }

    /** Dismiss without acting, back to whatever asked. */
    closeConfirm() {
      const back = this.confirmFrom || 'menu';
      this.confirmBox = null;
      this.confirmFrom = null;
      this.state = back;
      this.hud.selY = null;
      this.menuSelY = null;
      this.audio.uiMove();
    }

    activateConfirm() {
      const box = this.confirmBox;
      if (!box) { this.state = this.confirmFrom || 'menu'; return; }
      if (this.confirmIndex === 1) {
        // The action owns the state from here: quitGame fades and exits, and
        // anything else that lands here is expected to move the game itself.
        this.confirmBox = null;
        this.confirmFrom = null;
        this.audio.select();
        box.onYes();
      } else {
        this.closeConfirm();
      }
    }

    /** Hit-test the two rows on the confirmation card. */
    confirmItemAt(e) {
      if (this.state !== 'confirm' || !this.confirmBox) return -1;
      return this.listItemAt(e);
    }

    /* QUIT, with the question in front of it. What it says depends on what
       there is to lose: on a plain web server there is no process to end, and
       promising one would be a lie the button cannot keep. */
    askQuit() {
      const host = global.NR.Host;
      const native = !!(host && host.native);
      this.askConfirm({
        title: 'QUIT SYNX?',
        body: native
          ? 'This closes the game and returns you to the desktop.'
          : 'This ends the session and stops the simulation.',
        note: 'Your campaign, records and settings are already saved.',
        cancel: 'NO — KEEP PLAYING',
        confirm: 'YES — QUIT',
        onYes: () => this.quitGame(),
      });
    }

    /* THE PAD DRIVES EVERY MENU, THROUGH THE KEYBOARD.
     *
     * Six of this game's screens read the keyboard, and only one of them is
     * the canvas: the mode terminal, the free-roam board, the multiplayer
     * lobby and Story Mode are DOM, with their own listeners. Teaching each of
     * them about a gamepad would be five more places to keep in step, and the
     * one that got forgotten would be the one a player found.
     *
     * So the pad does not talk to the screens at all. It synthesises the key
     * that screen already answers to and dispatches it on `window`, which is
     * where every one of those listeners is registered. One bridge, and
     * everything downstream - including anything added later - gets controller
     * support without knowing a controller exists.
     *
     * WHEN IT MUST NOT FIRE.
     *
     *   While DRIVING. The d-pad and the stick would arrive as the arrow keys,
     *   which are throttle and steering, so the pad would fight itself; the
     *   car is driven from Input.sample and padAct instead.
     *   During a REBIND. The controls screen is waiting for the next key press
     *   to bind it, and a stray nudge of the stick would bind an arrow key to
     *   the handbrake.
     */
    padToKeys(up, down, left, right, ok, back) {
      if (!up && !down && !left && !right && !ok && !back) return;
      const driving = this.state === 'racing' || this.state === 'countdown';
      if (driving || (this.input && this.input.captureNext)) return;
      if (up) synthKey('ArrowUp');
      if (down) synthKey('ArrowDown');
      if (left) synthKey('ArrowLeft');
      if (right) synthKey('ArrowRight');
      if (ok) synthKey('Enter');
      if (back) synthKey('Escape');
    }

    /** F. The only thing in the game that touches fullscreen. */
    /* Fullscreen is a property of the WINDOW.

       The DOM Fullscreen API resizes the document inside a webview and leaves
       the host window exactly where it was, so F re-laid out the canvas and
       changed nothing the player could see. js/host.js asks the native window
       when there is one, and falls back to the DOM API under a web server. */
    toggleFullscreen() {
      const host = global.NR.Host;
      if (host) { host.toggleFullscreen(); return; }
    }

    onResize() {
      const w = global.innerWidth, h = global.innerHeight;
      const rs = this.renderScale || 1;
      // Supersample when quality allows, but never ask for more than 2x native
      // in each axis or a high-DPI laptop asks for four times the pixels it can
      // actually push.
      /* TWO RESOLUTIONS, NOT ONE.
       *
       * The render scale used to be folded into the canvas backing store, so
       * asking for 67% made the CANVAS 67% and the browser stretched it back
       * with a bilinear filter. That is why the low settings looked like a
       * smaller game rather than a cheaper one: bilinear across an edge is a
       * ramp, and a frame made mostly of thin bright lines on a dark ground is
       * the worst case there is for one.
       *
       * So the two are separated. The canvas stays at native and the RENDER
       * TARGETS shrink, and the final pass reconstructs - see the FSR block in
       * FINAL_FRAG. The upscale is then a filter that knows it is an upscale,
       * which is the whole difference.
       *
       * ABOVE native nothing changes. Supersampling wants the browser's own
       * box downsample of a larger canvas, which is a better reducer than one
       * bilinear tap, and it costs nothing to keep the old path for it. */
      const dprBase = Math.min(global.devicePixelRatio || 1, 2.0);
      const ow = Math.max(2, Math.round(w * dprBase));
      const oh = Math.max(2, Math.round(h * dprBase));
      let bw, bh;
      if (rs >= 1) {
        // supersample: the canvas itself is bigger and the display reduces it
        const dpr = Math.min(dprBase * rs, 2.0);
        bw = Math.max(2, Math.round(w * dpr));
        bh = Math.max(2, Math.round(h * dpr));
        this.canvas.width = bw;
        this.canvas.height = bh;
        this.outW = bw; this.outH = bh;
      } else {
        // reconstruct: the canvas is native and the frame is drawn smaller
        bw = Math.max(2, Math.round(ow * rs));
        bh = Math.max(2, Math.round(oh * rs));
        this.canvas.width = ow;
        this.canvas.height = oh;
        this.outW = ow; this.outH = oh;
      }
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
      this.rtScene.resize(bw, bh);
      this.rtLdr.resize(bw, bh);
      /* The reconstruction target only exists when there is something to
         reconstruct. Below native it is the canvas size; at or above it, the
         pass is skipped and the buffer is kept at 2x2 rather than holding a
         full-resolution attachment nothing reads. */
      if (rs < 1) this.rtUp.resize(this.outW, this.outH);
      else this.rtUp.resize(2, 2);
      this.rtHist[0].resize(bw, bh);
      this.rtHist[1].resize(bw, bh);
      this.haveHistory = false;
      const hw = Math.max(2, bw >> 1), hh = Math.max(2, bh >> 1);
      this.rtVol.resize(hw, hh);
      this.rtOcc.resize(hw, hh);
      this.rtGod.resize(hw, hh);
      this.rtSsr.resize(hw, hh);
      this.rtSsrB.resize(hw, hh);
      this.rtVolB.resize(hw, hh);
      this.rtAo.resize(hw, hh);
      this.rtAoB.resize(hw, hh);
      this.rtDofA.resize(Math.max(2, bw >> 2), Math.max(2, bh >> 2));
      this.rtDofB.resize(Math.max(2, bw >> 2), Math.max(2, bh >> 2));
      for (let i = 0; i < this.bloom.length; i++) {
        this.bloom[i].resize(Math.max(2, bw >> (i + 1)), Math.max(2, bh >> (i + 1)));
      }
      this.w = bw; this.h = bh;
      this.hud.resize(w, h, Math.min(global.devicePixelRatio || 1, 2));
    }

    // ------------------------------------------------------------- flow --
    fadeTo(v) { this.fadeTarget = v; }

    resetCar() {
      // both cars start on the chosen route's own line, not at the head of the
      // course - a level is a stretch of road, and it begins where it begins
      const s0 = this.startAt === undefined ? 30 : this.startAt;
      /* A ramp is a window installed on a car, so a restart has to take it
         off: one left armed would launch the car off a piece of road the
         restart has just put a long way behind it. */
      this.clearRamps();
      // side by side, the player on the inside
      this.car.reset(s0, -5.5);
      if (this.rival) {
        this.rival.reset(s0, 5.5);
        this.driver.setLevel(DIFFICULTIES[this.diffIndex] || 'MEDIUM');
        this.driver.reset();
      }
      if (this.fx) {
        // a trail is a record of where the car has been; a race that has not
        // started has nowhere behind it
        this.fx.reset();
        // the player runs the hot red tail of the reference; the rival gets
        // the cold blue-white that matches its own livery
        this.fx.setTrailColor(this.car, [1.00, 0.05, 0.10]);
        if (this.rival) {
          // the R-IX runs Ryker's amber; every other rival runs its own orange
          this.fx.setTrailColor(this.rival,
            this.raptorRival() ? [1.00, 0.34, 0.06] : [1.00, 0.28, 0.04]);
        }
      }
      // a fresh car, on every route, on every retry: panel damage is per-run
      if (this.damage) this.damage.reset();
      if (this.rivalDamage) this.rivalDamage.reset();
      if (this.glass) this.glass.reset();
      this.timeScale = 1; this.slowHold = 0; this.slowFov = 0;
      this.rivalGap = 0;
      this.place = 1;
      this.won = false;
      this.raceOver = false;
      this.camPull = undefined;
      this.camYaw = this.car.yaw;
      this.camHeight = CAM.height;
      /* The odometer starts where the route starts. Zeroing it made the
         atmosphere read the head of the course - so a route that opens inside
         a tunnel spawned in clear air and faded in - and it made the progress
         rail jump the moment the first frame of physics ran. */
      this.distance = s0;
      this.progress = 0;
      this.tunnel = this.track.at(s0, {}).tunnel ? 1 : 0;
      this.chase = 0.5;
      this.score = 0;
      this.combo = 1;
      this.comboTimer = 0;
      this.driftBank = 0;
      this.topSpeedSeen = 0;
      this.cleanTime = 0;
      this.splits = [];
      this.nextSplit = 0;
    }

    /** Push the current settings into the renderer and the mixer. */
    applySettings() {
      const st = this.settings;
      /* THE INPUT LAYER IS TOLD ONCE, HERE.
         Every reader asks Input for an action rather than for a key, so this
         one assignment is the whole of "the rebind took effect" - there is no
         second copy of the map anywhere to go stale. */
      if (this.input) this.input.binds = st.binds;
      // The pad's deadzone, curve and rumble are the player's, and this is the
      // one place that hands them over.
      if (this.pad) this.pad.configure(st);
      this.mouseLookOn = st.mouseLook === 1;
      this.mouseSens = MOUSE_SENS[st.mouseSens] === undefined ? 1 : MOUSE_SENS[st.mouseSens];
      this.mouseInvert = st.mouseInvert === 1 ? -1 : 1;
      this.mouseSmooth = MOUSE_SMOOTH[st.mouseSmooth] === undefined ? 14 : MOUSE_SMOOTH[st.mouseSmooth];
      const name = optionOf(st, 'quality');
      const q = QUALITY[name] || QUALITY.HIGH;
      this.quality = q;

      // neon glow strength
      this.bloomAmount = [0, FX.bloomAmount * 0.5, FX.bloomAmount,
                          FX.bloomAmount * 1.9][st.bloom];
      const ultra = name === 'ULTRA';
      this.anamorphic = ultra ? FX.anamorphic * 1.35 : FX.anamorphic;
      this.fogDensity = FX.fogDensity * (ultra ? 1.10 : 1);
      this.volDensity = FX.volDensity * (ultra ? 1.35 : 1);

      /* Cast shadows. The map is (re)built only when the size it needs
         actually changes - it is three depth textures and reallocating them
         every time a slider moves would hitch the frame. */
      const shadowSize = (st.shadows === 1) ? q.shadow : 0;
      if (this.scene && this.scene.ready !== undefined) {
        if (shadowSize > 0) {
          this.scene.initShadows(shadowSize);
          this.scene.shadow.on = true;
          this.scene.shadowSoft = q.shadowSoft;
          this.scene.shadowStrength = name === 'ULTRA' ? 0.88 : 0.82;
        } else if (this.scene.shadow) {
          this.scene.shadow.on = false;
        }
      }
      this.useShadows = shadowSize > 0;

      /* The local probe rides on WET REFLECTIONS, because it is the same
         feature from the player's point of view: what the road reflects. Off
         on LOW, where the whole point is to stop drawing the world twice. */
      const wantProbe = q.ssr && st.reflections === 1;
      if (this.scene && wantProbe) this.scene.initProbe(name === 'ULTRA' ? 256 : 128);
      this.useProbe = wantProbe;
      if (this.scene) this.scene.probeOn = wantProbe;

      /* Geometry, not just pixels. See Scene.drawWorld: a low preset used to
         shorten the frame but not the world, and on the hardware that needs a
         low preset the world is the expensive half. */
      if (this.scene) {
        this.scene.viewScale = name === 'LOW' ? 0.58
          : (name === 'MEDIUM' ? 0.80 : 1.0);
        // the near-field normal octave: off on LOW, half strength on MEDIUM
        this.scene.detailNrm = name === 'LOW' ? 0 : (name === 'MEDIUM' ? 0.6 : 1);
      }

      this.useVolumetrics = q.volumetric && st.volumetrics === 1;
      this.useGodrays = q.godrays;
      this.useSsr = q.ssr && st.reflections === 1;
      this.useAo = q.ao;
      this.useTaa = q.taa;
      this.useDof = q.dof;
      this.useFxaa = q.fxaa;
      this.bloomLevels = q.bloomLevels;
      this.useGrain = st.grain === 1;
      this.useMotionBlur = st.motionBlur === 1;

      /* ---- the IMAGE group -------------------------------------------- */
      /* AMBIENT OCCLUSION is three-valued now rather than riding the preset:
         OFF, LOW (four slices) and HIGH (eight). The preset still decides
         whether the pass exists at all, because on LOW there is no depth
         prepass to read. */
      this.aoQuality = q.ao ? (st.ao === undefined ? 2 : st.ao) : 0;
      this.useAo = q.ao && this.aoQuality > 0;

      /* THE GRADE, on top of the AgX display transform. AgX is deliberately
         neutral - it is a transform, not a look - so this is where the picture
         is put back. See the note by agxLook in the composite shader. */
      const LOOKS = [
        { sat: 1.00, punch: 1.00 },   // NEUTRAL: the transform on its own
        { sat: 1.22, punch: 1.06 },   // SYNTHWAVE: how the game is meant to look
        { sat: 1.40, punch: 1.14 },   // PUNCHY
      ];
      const look = LOOKS[st.look === undefined ? 1 : st.look] || LOOKS[1];
      this.lookSat = look.sat;
      this.lookPunch = look.punch;

      /* Contrast-adaptive sharpening. A temporal resolve costs bite and this
         is what buys it back, so the default is higher when TAA is running -
         the row scales that rather than replacing it. */
      const SHARP = [0, 0.5, 1.0, 1.6];
      this.sharpenScale = SHARP[st.sharpness === undefined ? 2 : st.sharpness];

      /* How a sub-native frame is reconstructed. Meaningless at or above
         NATIVE, where there is nothing to reconstruct - the pass is skipped
         entirely rather than run as an identity. */
      this.upscaler = st.upscaler === undefined ? 2 : st.upscaler;

      /* THE FRAME LIMIT, AND WHO ENFORCES IT.

         The row lived on the launcher's own save entry, which the game never
         reads, so it was applied by nothing. It is an ordinary setting now and
         this is the whole of it: a minimum interval the loop will not draw
         faster than. `0` is UNCAPPED, and UNCAPPED has to mean no arithmetic
         at all rather than a very large interval - a limiter that is always
         running is a limiter that can always be wrong. */
      const CAPS = SCHEMA.FPS_CAPS || [0, 30, 60, 75, 90, 120, 144, 165, 240];
      const cap = CAPS[st.fps_cap === undefined ? 0 : st.fps_cap] || 0;
      this.frameInterval = cap > 0 ? 1000 / cap : 0;
      /* UNCAPPED STILL NEEDS A CEILING WHEN VSYNC IS OFF.

         With the compositor holding the page at the refresh rate, UNCAPPED
         means the refresh rate and everything is fine. With vsync off there
         is nothing holding it at all, and a menu - where the scene is cheap
         and the GPU fence never trips - will run the whole loop a thousand
         times a second: the machine gets hot, the fans come up, and the
         input queue sits behind a main thread that is never idle.

         240 is above any display anyone is playing this on, so it is still
         uncapped in every sense the player cares about. It is only a ceiling
         on the pathological case. An explicit choice from the row always
         wins - if someone asks for no limit and means it, they get it. */
      if (cap === 0 && NR.Host && NR.Host.info && NR.Host.info.vsync === false) {
        this.frameInterval = 1000 / 240;
      }
      // ...and the counter that reports what actually came out
      this.showFps = st.fpsShow === 1;

      if (this.driver) {
        this.driver.setLevel(DIFFICULTIES[this.diffIndex] || 'MEDIUM');
        this.driver.reset();
      }
      const vol = (i) => [0, 0.25, 0.5, 0.75, 1][i];
      if (this.audio && this.audio.setVolumes) {
        this.audio.setVolumes(vol(st.music), vol(st.sfx));
      }
      /* The render scale is the player's, not the quality preset's.

         The preset still sets a sensible default the first time a quality is
         chosen, but once RENDER SCALE has been touched it is the thing that
         decides, because that is what a resolution control is for. */
      const rs = RENDER_SCALES[st.resolution] || RENDER_SCALES[3];
      const wanted = rs.scale;
      if (this.renderScale !== wanted) {
        this.renderScale = wanted;
        this.onResize();
      }

      /* NOTHING HERE TOUCHES THE WINDOW.

         WINDOW MODE was applied from this function and is now the launcher's,
         because a window's mode is fixed when it is built. F still toggles
         fullscreen at any time - that is a key, not a persisted mode, and it
         goes straight to the native window through js/host.js. */
      try { global.NR.Save.setJSON(SETTINGS_KEY, this.settings); }
      catch (e) { /* nothing to do */ }
    }

    /** Write the settings out and return to the title screen. */
    saveAndExitControls() {
      this.applySettings();          // also persists to the save file
      this.audio.select();
      this.hud.toast('SETTINGS SAVED', '#39e6ff');
      this.state = 'menu';
      this.menuIndex = 0;
      this.onMusic();
    }

    cycleSetting(dir) {
      const row = this.settingRows[this.controlIndex];
      if (!row || !row.opts) return;
      const n = row.opts.length;
      this.settings[row.key] = (this.settings[row.key] + dir + n) % n;
      this.applySettings();
      this.audio.uiMove();
    }

    /** Move to a page of the options screen, keeping the selection legal. */
    setOptionTab(tab) {
      const n = CONTROL_TABS.length;
      const t = ((tab % n) + n) % n;
      if (t === this.controlTab) return;
      this.controlTab = t;
      this.settingRows = tabRows(t);
      this.controlIndex = Math.min(this.controlIndex, this.settingRows.length);
      this.bindCapture = null;
      this.input.captureNext = null;
      this.audio.uiMove();
    }

    /* ---------------------------------------------------------------------
     * REBINDING.
     *
     * Start listening; the next key press lands here. ESC leaves the binding
     * alone, which is the only way out that does not require the player to
     * guess what the old key was.
     *
     * A KEY BELONGS TO ONE ACTION. Taking it means taking it away from
     * whoever had it - anything else produces a car that both accelerates and
     * pauses on the same press, and no warning dialogue makes that better
     * than simply doing the obvious thing and showing the result. An action
     * stripped that way reads as unbound, and rebinding it is one row away.
     * ------------------------------------------------------------------ */
    beginBind(action) {
      this.bindCapture = action;
      this.audio.select();
      this.input.captureNext = (k) => {
        this.bindCapture = null;
        if (k === 'escape') { this.audio.uiMove(); return; }
        const binds = this.settings.binds;
        for (const a of ACTIONS) {
          if (!binds[a.key]) continue;
          const at = binds[a.key].indexOf(k);
          if (at >= 0 && a.key !== action) binds[a.key].splice(at, 1);
        }
        /* Two keys per action, which is what the defaults have always been:
           the newest goes to the front and anything past the second falls off
           the end, so binding a third key replaces the oldest rather than
           growing an unreadable list. */
        const mine = binds[action] || (binds[action] = []);
        const dup = mine.indexOf(k);
        if (dup >= 0) mine.splice(dup, 1);
        mine.unshift(k);
        while (mine.length > 2) mine.pop();
        this.applySettings();
        this.audio.select();
        this.hud.toast(this.rowLabelFor(action) + '  //  ' + keyLabel(k), '#39e6ff');
      };
    }

    rowLabelFor(action) {
      const a = ACTIONS.find(x => x.key === action);
      return a ? a.label : String(action).toUpperCase();
    }

    /** Put every key back, for a player who has bound themselves into a corner. */
    resetBinds() {
      this.settings.binds = defaultBinds();
      this.applySettings();
      this.audio.select();
      this.hud.toast('CONTROLS RESET', '#ffb400');
    }

    /** Menu and race run different tracks; this picks the right one. */
    onMusic() {
      /* SILENCE UNTIL THE COLD START.

         The menu theme used to come up the instant the game reached the menu
         state, which is while the photosensitivity notice is still on screen
         - so the first thing a new player got was a warning about seizures
         with a synthwave track playing over it. The notice is the one screen
         in the game that should be quiet.

         The hold is released by startIntro, which is the moment the veil
         lifts and the opening move begins - so the music arrives with the
         cutscene, which is where it belongs.

         The DOM check is the safety net rather than the mechanism. If the
         notice and the veil are both gone and nothing has released the hold
         - reduced motion takes a path that starts no cutscene at all - then
         there is nothing left to be quiet for, and a game that is silent for
         the rest of the session is a worse bug than an early note. */
      if (this.musicHeld) {
        const d = global.document;
        if (d && (d.getElementById('advisory') || d.querySelector('.intro-veil'))) return;
        this.musicHeld = false;
      }
      /* A CUTSCENE OWNS THE MUSIC.
         `go`, in bind(), unlocks the audio context on interaction and then
         re-picks the track - and it is bound to every pointer and key event,
         not only the first. This chooses from `state`, and during a
         conversation the state is 'story', which is not 'menu', so it fell
         through to the race selector: clicking through a cutscene put the race
         score on over it, and clicking again restarted it. The story director
         is the authority whenever it is running the screen, so it is asked
         rather than guessed at. */
      if (this.story && this.story.isExclusive && this.story.isExclusive()) {
        if (this.story.refreshMusic) this.story.refreshMusic();
        return;
      }
      /* A CONFIRMATION IS NOT A PLACE, IT IS A QUESTION ABOUT ONE.
         It has no music of its own: whatever was playing when it opened keeps
         playing under it. Asking MENU_STATES about 'confirm' directly would cut
         the menu theme the moment QUIT was selected on the title screen, and
         start it over a paused race. */
      const effective = this.state === 'confirm'
        ? (this.confirmFrom || 'menu') : this.state;
      const menu = MENU_STATES.has(effective);
      if (menu) {
        this.audio.playTrack('menu');
      } else {
        /* Chapters 6 and 7 have authored scores, so their scenery must never
           be allowed to re-enter the environment-radio selector. */
        if (this.level && this.level.level6) {
          this.audio.playTrack('factory');
          return;
        }
        if (this.level && this.level.level7) {
          this.audio.playTrack('final');
          return;
        }
        if (this.audio.setEnvironment && this.scene.environmentAt) {
          this.audio.setEnvironment(this.scene.environmentAt(this.distance || 0));
        }
        this.audio.playTrack('race');
      }
    }

    /** The presentation cursor belongs to menus and overlays, not driving. */
    /* ...and the DOM half of the interface is told too.
       The canvas HUD switches on `g.state`; the story, Forge and Predator
       panels are real elements with their own stylesheet, and nothing was
       telling them a menu had opened over the top of them. One class on the
       body, set in the one place that knows the state changed. */
    syncModalClass() {
      const modal = this.state === 'paused' || this.state === 'finished';
      if (modal === this._modalWas) return;
      this._modalWas = modal;
      const b = global.document.body;
      if (b) b.classList.toggle('synx-modal', modal);
    }

    /* ------------------------------------------------- POINTER OWNERSHIP --
     *
     * WHO IS ASKING FOR CLICKS, BY NAME.
     *
     * `uiOverlayOpen` was one boolean, and exactly one screen ever set it: the
     * multiplayer dialog. Everything else that puts a clickable panel over a
     * running world was invisible to the cursor policy - most obviously the
     * multiplayer RESULTS board, which arrives while `state` is still
     * 'racing', so the podium, RACE AGAIN and LOBBY were drawn with the cursor
     * hidden and could only be reached from the keyboard.
     *
     * One boolean also cannot nest. A dialog opened over the results board
     * cleared the flag on the way out and took the board's pointer with it.
     *
     * So overlays are a SET, keyed by name. An overlay says what it is, says
     * when it has gone, and any number of them can be up at once - the cursor
     * is shown while the set is non-empty, and the last one to close is the
     * one that gives it back.
     */
    setUiOverlay(name, on) {
      const set = this.uiOverlays || (this.uiOverlays = new Set());
      if (on) set.add(name); else set.delete(name);
      // kept as a boolean for anything still reading the old flag
      this.uiOverlayOpen = set.size > 0;
      this.syncCursorVisibility();
    }

    /** Every overlay gone at once - a teardown, a return to the title. */
    clearUiOverlays() {
      if (this.uiOverlays) this.uiOverlays.clear();
      this.uiOverlayOpen = false;
      this.syncCursorVisibility();
    }

    syncCursorVisibility() {
      const driving = this.state === 'countdown' || this.state === 'racing';
      /* A PANEL OVER A RACE STILL NEEDS A POINTER.
         Multiplayer cannot pause, so its questions and its results board are
         both put up while the world is still driving underneath them - and
         `driving` alone hid the cursor, leaving buttons that could only be
         reached from the keyboard. An overlay that wants clicks says so. */
      const overlay = this.uiOverlayOpen || !!(this.uiOverlays && this.uiOverlays.size);
      const hidden = !overlay
        && (driving || (this.cursorHiddenForRun && this.state !== 'paused'
          && this.state !== 'finished' && this.state !== 'confirm'));
      if (global.document && global.document.body) global.document.body.classList.toggle('race-active', hidden);
    }

    /** Called as soon as a Story chapter is chosen, before its intro begins. */
    hideCursorForRun() {
      this.cursorHiddenForRun = true;
      this.syncCursorVisibility();
    }

    /* Put the game on a route and take it to the controls card. Story Mode
       and the capture harnesses are the only callers - the route list and the
       difficulty picker that used to sit in front of this are gone, and a
       chapter now decides both. */
    enterRoute(level, diff) {
      this.levelIndex = M.clamp(level | 0, 0, LEVELS.length - 1);
      this.diffIndex = M.clamp(diff === undefined ? this.diffIndex : diff | 0, 0, DIFFICULTIES.length - 1);
      this.beginRace();
    }

    /** Push the chosen level's look into the renderer. */
    applyLevel() {
      const L = LEVELS[this.levelIndex];
      const p = L.palette;
      this.level = L;
      this.runtimePalette = null;
      this.scene.setPalette(p);
      this.scene.sunColor = p.sun;
      this.scene.ambInt = p.ambient;
      this.fogDensity = 1 / p.fogRange;
      this.levelFog = p.fogTint;
      this.levelWet = p.wet;
      this.startAt = L.from;
      this.finishAt = L.to;
      this.track.halfWidth = L.driveHalf || global.NR.DRIVE_HALF;
      this.track.outerHalf = L.roadHalf || global.NR.ROAD_HALF;

      this.scene.placeSun(this.ensureSunYaw(L));

      /* A Free Roam run is one continuous drive across every route, so the
         region the car happens to be standing in does not get to decide where
         the run starts or where it ends. This sits at the bottom of applyLevel
         rather than in its callers because every one of them - beginRace, a
         chapter retry, the capture harnesses - comes through here. */
      if (this.freeRoam) {
        this.startAt = this.freeRoamFrom;
        this.finishAt = FREE_ROAM_END;
      }
    }

    /* Put the sun where this route can see it.
     *
     * The vector mean of the heading is the obvious answer and it is the
     * wrong one: a route that turns through two hundred degrees has a mean
     * heading nothing on it actually points at. This searches the compass
     * instead and keeps the bearing that is in shot for the largest part of
     * the drive - which for route 4 is thirty degrees off the mean and
     * nearly twice as much sun. Seventy-two candidates against a couple of
     * hundred samples is a few thousand comparisons, once, per route - and
     * caching the answer on the route is also what lets a Free Roam handover
     * interpolate between two of them. */
    ensureSunYaw(L) {
      if (L.sunYaw === undefined) {
        const C = this.track.C;
        const i0 = M.clamp(Math.round(L.from / C.step), 0, C.count - 1);
        const i1 = M.clamp(Math.round(L.to / C.step), 0, C.count - 1);
        const stride = Math.max(1, Math.round((i1 - i0) / 220));
        let best = 0, bestScore = -1;
        for (let k = 0; k < 180; k++) {
          const yaw = (k / 180) * Math.PI * 2 - Math.PI;
          let seen = 0, warmth = 0, n = 0;
          for (let i = i0; i <= i1; i += stride) {
            const a = Math.abs(M.angDiff(C.yaw[i], yaw));
            n++;
            if (a < 0.79) seen++;                        // 45 deg: in shot
            warmth += Math.max(0, Math.cos(a));          // ...and how centred
          }
          /* Time in shot is the thing being maximised; how centred it is when
             it is in shot breaks the ties, of which a winding route has many.
             Without the tie-break the search returns whichever of a dozen
             equally good bearings it happened to try first, which is how a
             route that had the sun for 60% of its length ended up with 29. */
          const score = seen / Math.max(1, n) + 0.02 * (warmth / Math.max(1, n));
          if (score > bestScore) { bestScore = score; best = yaw; }
        }
        L.sunYaw = best;
        L.sunSeen = bestScore;
      }
      return L.sunYaw;
    }

    // ------------------------------------------------------- free roam ----

    /* One run down the whole road.
     *
     * `region` is which route it starts on. The tour proper starts on the
     * first; the other six exist so a player who wants the Forge does not have
     * to drive ninety kilometres to reach it. Every run ends at the same last
     * gantry regardless, because what the mode is FOR is the road between
     * where you got on and there. */
    enterFreeRoam(opts) {
      const o = opts || {};
      const region = M.clamp(o.region === undefined ? 0 : o.region | 0, 0, LEVELS.length - 1);
      const rival = o.rival === undefined ? -1 : o.rival | 0;
      this.freeRoam = true;
      this.freeRoamRegion = region;
      this.freeRoamFrom = LEVELS[region].from;
      this.levelIndex = region;
      /* No rival is the default: this is an open route, not a duel. One can be
         asked for, and when it is it is the same Vehicle and the same Driver
         the campaign fields. */
      this.soloRun = rival < 0;
      this.storyHideRival = this.soloRun;
      if (!this.soloRun) this.diffIndex = M.clamp(rival, 0, DIFFICULTIES.length - 1);
      // only a full tour has a record to beat
      this.recordKey = region === 0 ? FREE_ROAM_RECORD_KEY : null;
      this.record = region === 0 ? readNum(FREE_ROAM_RECORD_KEY) : null;
      this.hideCursorForRun();
      this.beginRace();
    }

    /* Is the car out there the R-IX?
     *
     * Only on the open road, only against the top opponent, and only once the
     * Chapter 5 kit exists - it is constructed by that chapter's director the
     * first frame the car meshes are loaded, so on a tour it is always there
     * by the time anything is drawn, and the guard is for the frames before
     * the scene has finished loading rather than for a mode that lacks one. */
    raptorRival() {
      if (!this.freeRoam || this.soloRun || this.diffIndex !== 3) return null;
      return (this.scene && this.scene.level5RaptorKit) || null;
    }

    /* PICK A TOUR BACK UP WHERE IT WAS LEFT.
     *
     * The autosave describes a place on the road; this is the only thing that
     * reads it. It goes through the ordinary `enterFreeRoam` first - which
     * builds the worlds, fits the engine and resets the run properly - and
     * only then moves the car, because everything a tour needs set up is set
     * up by starting one and none of it is set up by teleporting a car.
     *
     * `story.setVehicle` is the authoritative placement: it moves `minS` with
     * the car, so the wall that keeps a driver from turning round does not
     * end up in front of them. */
    resumeFreeRoam(save) {
      if (!save || !save.freeRoam) return false;
      const region = M.clamp(save.region | 0, 0, LEVELS.length - 1);
      this.enterFreeRoam({ region, rival: save.solo ? -1 : (save.diff | 0) });
      this.startCountdown();
      const s = M.clamp(save.s || 0, LEVELS[region].from + 20, FREE_ROAM_END - 60);
      const put = this.story && this.story.setVehicle;
      const speed = Math.max(0, Math.min(60, save.speed || 0));
      if (put) {
        this.story.setVehicle(this.car, s, save.lateral || 0, speed);
        if (this.rival && !this.soloRun) this.story.setVehicle(this.rival, s + 24, -(save.lateral || 0), speed);
      } else {
        this.car.reset(s, save.lateral || 0);
        if (this.rival) this.rival.reset(s + 24, -(save.lateral || 0));
      }
      this.distance = this.car.sTrack;
      this.car.boost = save.boost === undefined ? 1 : save.boost;
      this.raceTime = save.raceTime || 0;
      this.score = save.score | 0;
      this.topSpeedSeen = save.topSpeed || 0;
      /* ...and the region the car is actually standing in, which after a jump
         of a hundred kilometres is not the one the tour was started at. */
      this.updateFreeRoamRegion(0);
      if (this.freeRoamMode) this.freeRoamMode.cooldown = save.rmCool || 0;
      this.freeRoamBanner = null;
      this.hud.toast('TOUR RESUMED  //  ' + ((this.car.sTrack - LEVELS[0].from) * UNITS_TO_KM).toFixed(1) + ' KM',
        '#5affc0');
      return true;
    }

    /** Put the renderer and the save back the way the campaign expects them. */
    exitFreeRoam() {
      if (!this.freeRoam) return;
      this.freeRoam = false;
      this.soloRun = false;
      this.storyHideRival = false;
      this.freeRoamBanner = null;
      this.freeRoamRegion = 0;
      this.freeRoamRegionShown = -1;
      this.freeRoamFrom = LEVELS[0].from;
      this.recordKey = RECORD_KEY;
      this.record = readNum(RECORD_KEY);
      this.runtimePalette = null;
      this.blockQuickRestart = false;
      /* Hand the car back the way the campaign expects to find it: a chapter
         earns the rebuild inside its own trial, and a tour must not leave it
         fitted for one that has not. */
      this.freeRoamMode = null;
      this.raceModeAvailable = false;
      this.raceModeActive = false;
      this.raceModeBlueFuel = false;
      if (this.car) { this.car.raceModeMultiplier = 1; if (this.car.fitEngine) this.car.fitEngine(null); }
      if (this.rival) { this.rival.raceModeMultiplier = 1; this.rival.gripScale = 1; this.rival.speedCap = Infinity; if (this.rival.fitEngine) this.rival.fitEngine(null); }
      if (this.driver) { this.driver.paceScale = 1; this.driver.gripScale = 1; }
      this.levelIndex = 0;
      /* applyLevel is the only thing that knows how to take Neon Horizon's
         world override back off again, because js/level7.js hangs that off
         the end of it. */
      this.applyLevel();
    }

    /** Everything a Free Roam run needs that a chapter race does not. */
    beginFreeRoamRun() {
      this.freeRoamClock = 0;
      this.freeRoamRegionShown = -1;
      /* The worlds FIRST, because building them is also what constructs the
         two chapter directors - and both of those clear `raceModeAvailable`
         and `blockQuickRestart` in reset(). Set before that happens and the
         flags last exactly one frame. */
      this.setFreeRoamRegion(this.freeRoamRegion, true);
      /* The rebuilt engine, and the drive that came with it. */
      if (this.car.fitEngine) this.car.fitEngine('swap');
      this.car.raceModeMultiplier = 1;
      this.freeRoamMode = { active: false, timer: 0, cooldown: 0, reserve: false };
      /* ...and the rival gets the same car out of the same workshop. A tour
         driven on a rebuilt engine against a rival still on the stock envelope
         is not a race, it is scenery going past more slowly. */
      if (this.rival && !this.soloRun) {
        if (this.rival.fitEngine) this.rival.fitEngine('swap');
        this.rival.raceModeMultiplier = 1;
        this.rival.gripScale = 1;
        /* fitEngine('swap') installs the Forge cap of 122; updateFreeRoamRival
           replaces it with this rung's own ceiling on the first frame. */
        this.rival.speedCap = FREE_ROAM_TOP[M.clamp(this.diffIndex | 0, 0, FREE_ROAM_TOP.length - 1)];
      }
      if (this.driver) { this.driver.paceScale = 1; this.driver.gripScale = 1; }
      this.assertFreeRoamRun();
    }

    /* The two flags a tour owns that somebody else keeps turning off.
       Both chapter directors clear them whenever they reset, and both reset on
       applyLevel, on resetCar, and on the frame they are first constructed -
       which is a frame a tour cannot predict. Rather than chase every one of
       those, the run states what is true about it, once a frame. */
    assertFreeRoamRun() {
      this.raceModeAvailable = true;
      // R restarts a race; on a 127 km run that is an accident, not a restart
      this.blockQuickRestart = true;
      const m = this.freeRoamMode;
      this.raceModeActive = !!(m && m.active);
      this.raceModeBlueFuel = !!(m && m.active);
    }

    /** Hand the drive to region `i`, and tell the player where they now are. */
    /* A tour crossing into a new region. One of the two moments on a
       hundred-and-twenty-seven kilometre drive that is worth a deliberate
       write; the other is the pause menu. */
    markAutosave(why) { if (this.autosave) this.autosave.mark(why); }

    setFreeRoamRegion(i, silent) {
      const L = LEVELS[i];
      this.levelIndex = i;
      this.level = L;
      this.freeRoamRegionShown = i;
      this.syncFreeRoamWorlds();
      this.freeRoamClock = 0;
      this.onMusic();
      const legTo = i + 1 < REGION_EDGES.length ? REGION_EDGES[i + 1] : FREE_ROAM_END;
      this.freeRoamBanner = {
        kicker: 'REGION ' + String(i + 1).padStart(2, '0') + ' OF ' + LEVELS.length,
        title: L.name,
        note: 'LEG ' + ((legTo - REGION_EDGES[i]) * UNITS_TO_KM).toFixed(1) + ' KM'
          + '  ·  ' + ((FREE_ROAM_END - REGION_EDGES[i]) * UNITS_TO_KM).toFixed(1)
          + ' KM TO THE HORIZON',
        t: 0,
      };
      // crossing a border on a 127 km tour is worth not losing
      if (!silent) this.markAutosave('region');
      if (!silent) {
        /* No toast. The banner IS the announcement, and the two of them said
           the same three words on top of each other. The glare over the last
           handover is not fired here either - updateFreeRoamGate ramps it in
           and out around this point, so the exchange lands at the bottom of a
           dissolve rather than under a single frame of flash. */
        this.audio.checkpoint();
      }
    }

    /* raceMode, on the open road.
     *
     * The same contract js/level6.js writes during the calibration run: thirty
     * seconds of synchronised drive, a seventy-second cooldown, and a blue
     * reserve that refills once when the normal one runs dry. What a tour does
     * not get is the chapter's letterbox, its dialogue or its scripted
     * activation - out here it is a key. */
    updateFreeRoamRaceMode(dt, active) {
      const m = this.freeRoamMode;
      if (!m) return;
      const car = this.car;
      m.cooldown = Math.max(0, m.cooldown - dt);
      if (m.active) {
        m.timer = Math.max(0, m.timer - dt);
        if (!m.reserve && car.boost <= 0.021) {
          m.reserve = true;
          car.boost = RACE_MODE_RESERVE;
          car.boostLocked = false;
          this.hud.toast('BLUE RESERVE // FLOW RESTORED', '#39c7ff');
          this.audio.checkpoint();
        }
        if (m.timer <= 0 || (m.reserve && car.boost <= 0.012)) this.endFreeRoamRaceMode();
        return;
      }
      if (!active || m.cooldown > 0 || !this.input.actHit('raceMode')) return;
      m.active = true;
      m.timer = RACE_MODE_SECONDS;
      m.cooldown = RACE_MODE_COOLDOWN;
      m.reserve = false;
      this.raceModeActive = true;
      this.raceModeBlueFuel = true;
      car.raceModeMultiplier = RACE_MODE_MULTIPLIER;
      car.boostLocked = false;
      car.boosting = true;
      if (this.fx && this.fx.raceModeBurst) this.fx.raceModeBurst(car);
      this.audio.boostHit();
      this.flash = Math.max(this.flash || 0, 0.09);
      this.shake = Math.max(this.shake || 0, 0.42);
      this.hud.toast('raceMode // SYNCHRONIZED', '#39c7ff');
    }

    endFreeRoamRaceMode() {
      const m = this.freeRoamMode;
      if (!m || !m.active) return;
      m.active = false;
      m.reserve = false;
      this.raceModeActive = false;
      this.raceModeBlueFuel = false;
      this.car.raceModeMultiplier = 1;
      this.hud.toast('raceMode // OFFLINE', '#8b5cf6');
    }

    /* ...and something for it to be used against.
     *
     * The rival is given pace rather than a bigger engine - the same principle
     * js/ai.js states and js/level7.js's boss keeps: a rival that gains its
     * speed from the workshop stops feeling like a driver. What it gets is a
     * pursuit term, squared so that being alongside costs nothing, and a small
     * answer to the drive the player is holding. Difficulty scales the whole
     * thing, so EASY is still a car you can leave behind. */
    updateFreeRoamRival(dt) {
      if (this.soloRun || !this.rival || !this.driver) return;
      const K = [0.5, 0.85, 1.15, 1.6];
      const k = K[this.diffIndex] === undefined ? 1 : K[this.diffIndex];
      const gap = (this.car.sTrack - this.rival.sTrack) * 0.733;    // metres, + = you lead
      const chase = M.clamp(gap / 240, 0, 1);
      const synced = this.freeRoamMode && this.freeRoamMode.active ? 1 : 0;
      /* THE R-IX IS A CAR, NOT JUST A BETTER DRIVER.

         The other three opponents are difficulties: one car, driven better or
         worse, which is the rule the whole ladder is built on. The top one is
         not on that ladder - it is the prototype from the finale, and the
         terminal offers it as "the one that hunted you".

         Without this it arrives as a driver on IMPOSSIBLE, and IMPOSSIBLE is
         within about a per cent and a half of HARD, because HARD already asks
         for very nearly everything the stock car has. Two options that finish
         together are one option with two labels.

         So it gets what it has in Chapter 7, and for the same reason: the
         momentum drive and the aero, not a bigger driver. It is a FLOOR under
         the chase curve rather than a starting value, because the curve below
         is re-evaluated every frame and would wash any starting value out. It
         is also a small fraction of the finale's hunt curve, which runs to
         1.92 - that is a scripted boss fight, and this is a rival on an open
         road. */
      const rix = this.diffIndex === 3;
      const base = rix ? FREE_ROAM_RIX_PACE : 1;
      const baseGrip = rix ? FREE_ROAM_RIX_GRIP : 1;
      /* How hard it is TRYING - the planner's pace and its tyres. The ceiling
         below is what it is allowed to reach; these two are what it does with
         the road on the way there, so a rival that is quick in a straight line
         is also committed through the corners rather than simply capped
         higher. A synchronised player no longer feeds this. */
      const want = base + chase * chase * 0.34 * k;
      this.driver.paceScale = M.damp(this.driver.paceScale || 1, want, 2.2, dt);
      this.driver.gripScale = M.damp(this.driver.gripScale || 1,
        baseGrip + chase * 0.15 * k, 2.0, dt);
      /* ...and the ceiling itself, which lifts only while it is the one
         behind, and is HELD while the player is spending their thirty
         seconds. See FREE_ROAM_TOP. */
      const i = M.clamp(this.diffIndex | 0, 0, FREE_ROAM_TOP.length - 1);
      const top = synced
        ? FREE_ROAM_MODE_TOP[i]
        : FREE_ROAM_TOP[i] + chase * chase * FREE_ROAM_CHASE_TOP[i];
      this.rival.speedCap = M.damp(
        this.rival.speedCap === Infinity ? top : this.rival.speedCap, top, 2.4, dt);
      this.rival.raceModeMultiplier = 1;
      this.updateFreeRoamCounter(dt, gap);
      // The planner and the tyres must agree about the grip available.
      this.rival.gripScale = this.driver.gripScale;
      const cmd = this.driver.lastInput;
      if (rix && cmd && cmd.brake === 0 && cmd.throttle > 0.5 &&
          Math.abs(this.rival.bodySlip) < 0.12 && !this.rival.airborne) {
        const wantSpeed = Math.min(this.driver.lastTarget,
          this.rival.engineTop * this.rival.raceModeMultiplier, this.rival.speedCap);
        if (this.rival.vLong < wantSpeed) this.rival.vLong = Math.min(wantSpeed, this.rival.vLong + 8 * dt);
      }
    }

    /* ------------------------------------------------- the stunt course --
     *
     * EVERY CAR ON THE ROAD MEETS THE SAME RAMP.
     *
     * The solver holds one armed window per car, on purpose: a ramp is an
     * arc-length window with no lateral extent, so three live at once on a
     * road a car can be driven backwards down would mean reversing into the
     * third one and being launched by it. Arming only the nearest one ahead,
     * and only while the car is approaching it, is the whole guard - and it is
     * applied to each car separately because each car is somewhere different.
     *
     * This runs BEFORE anything is stepped, so the window is live on the frame
     * a car first reaches the incline rather than one frame late.
     */
    rampCars() {
      const out = [];
      if (this.car) out.push(this.car);
      if (this.rival && !this.soloRun) out.push(this.rival);
      /* Chapter 4's invitational grid, which meets SKYLINE LAUNCH on its own
         route. A remote player in multiplayer is in this list too and has no
         driver: their car is a pose written by the interpolator rather than a
         car this machine steps, so their flight belongs to the machine that
         owns them and arming anything here would be writing into a simulation
         that is not running. */
      for (const e of (this.storyExtraRacers || [])) {
        if (e && e.car && e.driver) out.push(e.car);
      }
      return out;
    }

    /** The nearest ramp still ahead of `s`, or null. */
    nextRamp(s) {
      let next = null;
      for (const r of COURSE_RAMPS) {
        if (r.s - s < RAMP_PAST) continue;
        if (!next || r.s < next.s) next = r;
      }
      return next;
    }

    updateRamps() {
      const J = this.__jumps || (this.__jumps = {
        armed: null, live: null, taken: 0, clean: 0, landing: 0, landedId: null,
      });
      J.landedId = null;
      for (const car of this.rampCars()) {
        if (!car || !car.armRamp) continue;
        const player = car === this.car;
        /* THE LANDING IS READ FROM A FLAG THE SOLVER SETS FOR EXACTLY ONE
           FRAME. Reading the height instead - "it was in the air and now it is
           not" - misses a landing whenever a frame is long enough to span the
           whole touchdown, which on a slow machine is most of them. */
        if (car.landed) {
          car.landed = 0;
          const q = car.landing || 0;
          /* Boost, and boost is the right currency: a ramp taken well is one
             of the few places on this road anyone can make some. Paid to every
             car that earns it, so a rival that lands straight gets the same
             thing out of it the player does - which is what makes the AI's
             set-up on the approach worth watching rather than decorative. */
          if (q >= RAMP_CLEAN && car.boost !== undefined) {
            car.boost = M.clamp((car.boost || 0) + 0.16 + q * 0.14, 0, 1);
          }
          if (player) {
            J.taken++;
            if (q >= RAMP_CLEAN) J.clean++;
            J.landing = q;
            J.landedId = car.__rampTook || null;
          }
        }
        const s = car.sTrack || 0;
        const next = this.nextRamp(s);
        const span = next ? next.len + (next.crest || 0) : 0;
        const arm = !!next && (next.s - s) < RAMP_TELEGRAPH + span && (next.s - s) > RAMP_PAST;
        if (arm) {
          if (car.__rampArmed !== next.id) {
            car.__rampArmed = next.id;
            car.__rampTook = next.id;
            /* A crest is a top to drive along, and only the blocked bore has
               one. Everything else is the plain wedge it always was, armed
               through the same call it always used. */
            if (next.crest && car.armRampDeck) {
              car.armRampDeck(next.s - next.crest - next.len, next.s - next.crest,
                next.s, next.h, next.lip || next.h);
            } else {
              car.armRamp(next.s - next.len, next.s, next.h);
            }
            if (player && this.onRampArmed) this.onRampArmed(next);
          }
        } else if (car.__rampArmed) {
          car.__rampArmed = null;
          car.clearRamp();
        }
        if (player) { J.armed = car.__rampArmed; J.live = arm ? next : null; }
      }
    }

    /** Take every armed window off every car. A restart must not leave one
     *  standing on a piece of road it has put a long way behind the car. */
    clearRamps() {
      for (const car of this.rampCars()) {
        if (!car || !car.clearRamp) continue;
        car.__rampArmed = null;
        car.__rampTook = null;
        car.clearRamp();
      }
      this.__jumps = { armed: null, live: null, taken: 0, clean: 0, landing: 0, landedId: null };
    }

    /* THE R-IX ANSWERS AN OVERTAKE. Free Roam's top opponent only.
     *
     * The three ordinary rivals chase on the curve above, which closes a gap
     * over a kilometre - correct for a rival, and completely wrong for the car
     * the campaign spends seven chapters building up. "R-IX // IMPOSSIBLE" is
     * offered as "the one that hunted you", and being passed by it has to feel
     * like a thing you got away with rather than a thing that is over.
     *
     * Same rule as the finale's (see PredatorDirector.updateRivalry): a few
     * seconds of the lead are the player's, then he spends a burst of his own
     * and holds it until he is back in front or it runs out, then a cooldown.
     * It is deliberately restricted to `diffIndex === 3` - the other three
     * opponents are a car to follow, a car to chase and a car that knows the
     * line, and none of them should suddenly acquire a temper. */
    updateFreeRoamCounter(dt, gapM) {
      if (this.diffIndex !== 3) {
        if (this.rivalCounter) this.rivalCounter = null;
        return;
      }
      const c = this.rivalCounter || (this.rivalCounter = {
        behindFor: 0, hold: 0, rest: 0, was: false, said: 0,
      });
      const leading = gapM > 3;
      if (leading && !c.was) c.behindFor = 0;
      c.was = leading;
      c.rest = Math.max(0, c.rest - dt);
      c.said = Math.max(0, c.said - dt);
      if (leading) c.behindFor += dt; else c.behindFor = 0;

      if (c.hold > 0) {
        c.hold -= dt;
        if (c.hold <= 0 || gapM < -12) { c.hold = 0; c.rest = 17; }
      } else if (c.behindFor >= 3.4 && c.rest <= 0) {
        c.hold = 11;
        c.behindFor = 0;
        this.hud.toast('R-IX // COUNTER-ATTACK', '#ff3b1e');
        if (this.audio && this.audio.boostHit) this.audio.boostHit();
      }
      if (c.hold > 0) {
        /* Pace, ceiling AND thrust. A ceiling on its own is decoration - a car
           already at its drag-limited terminal speed goes no faster for being
           allowed to - which is the trap the finale's hunt curve went through
           twice. The ceiling here is the same hard `speedCap` the rest of the
           tour is written in, so a counter-attack is legible as a number of
           units a second rather than as a multiplier on something else.
           It answers being PASSED; it never answers raceMode, because the
           window is the one thing on this road the player owns outright. */
        const synced = !!(this.freeRoamMode && this.freeRoamMode.active);
        this.driver.paceScale = Math.max(this.driver.paceScale || 1, 1.24);
        this.driver.gripScale = Math.max(this.driver.gripScale || 1, 1.10);
        this.driver.boostHold = Math.max(this.driver.boostHold || 0, 0.8);
        if (!synced) this.rival.speedCap = Math.max(this.rival.speedCap, FREE_ROAM_COUNTER_TOP);
        this.rival.powerScale = 1.22;
        this.rival.boost = 1;
      } else if (this.rival.powerScale !== 1) {
        this.rival.powerScale = 1;
      }
    }

    /* The seam.
     *
     * Every frame the run finds the region the car is standing in and hands
     * over if it has changed; and over the last kilometre and a quarter before
     * the NEXT handover it interpolates every part of the look a route owns
     * into that route's. By the time the boundary is crossed the picture is
     * already the new region's, so the handover itself changes nothing that
     * can be seen. */
    updateFreeRoamRegion(dt) {
      const s = this.distance;
      let i = 0;
      for (let k = REGION_EDGES.length - 1; k >= 0; k--) {
        if (s >= REGION_EDGES[k]) { i = k; break; }
      }
      if (i !== this.freeRoamRegionShown) this.setFreeRoamRegion(i, false);
      if (this.freeRoamMode) this.assertFreeRoamRun();
      if (this.freeRoamBanner) this.freeRoamBanner.t += dt;

      /* setPalette walks every dressing material, so the blend runs on its own
         clock rather than once a frame - the same twelve-a-second js/level5.js
         moves Ashfall through its dawn on. */
      this.freeRoamClock -= dt;
      if (this.freeRoamClock > 0) return;
      this.freeRoamClock = 0.08;
      const a = LEVELS[i], b = LEVELS[i + 1];
      const t = b ? smoothstep((s - (REGION_EDGES[i + 1] - REGION_BLEND)) / REGION_BLEND) : 0;
      this.applyFreeRoamLook(a, b, t);
      this.updateFreeRoamGate();
    }

    /* Staged, not hidden. `k` is how deep into the ascension gate the car is:
       nought either side, one at the boundary itself, which is the frame the
       world is exchanged on. Runs every frame rather than on the palette
       clock, because a dissolve that steps twelve times a second is a strobe.
       It is applied AFTER the blend, so it is a lens over the look rather than
       a second opinion about it. */
    updateFreeRoamGate() {
      const gate = REGION_EDGES[REGION_EDGES.length - 1];
      const d = this.distance - gate;
      const k = d < 0 ? smoothstep((d + GATE_IN) / GATE_IN)
                      : 1 - smoothstep(d / GATE_OUT);
      this.freeRoamGate = M.clamp(k, 0, 1);
      if (this.freeRoamGate <= 0.002) return;
      // squared, so the last fifty units carry most of it
      const w = this.freeRoamGate * this.freeRoamGate;
      this.fogDensity = M.lerp(this.freeRoamFog, 1 / GATE_FOG, w);
      this.flash = Math.max(this.flash || 0, GATE_GLARE * w);
    }

    /** Route `a`'s look, `t` of the way into route `b`'s. */
    applyFreeRoamLook(a, b, t) {
      const p = mixPalette(a.palette, b && b.palette, t);
      this.runtimePalette = p;
      this.scene.setPalette(p);
      this.scene.sunColor = p.sun;
      this.scene.ambInt = p.ambient;
      /* What the blend alone asks for. updateFreeRoamGate reads it back and
         bends it through the ascension gate; keeping the two apart is what
         stops the gate's haze being latched permanently into the route. */
      this.freeRoamFog = 1 / p.fogRange;
      this.fogDensity = this.freeRoamFog;
      this.levelFog = p.fogTint;
      this.levelWet = p.wet;
      /* Neon Horizon is a sixty-four-unit deck and everything before it is a
         forty-unit road, so the corridor the barriers resolve against opens
         up across the handover instead of stepping. */
      const drive = (L) => L.driveHalf || global.NR.DRIVE_HALF;
      const road = (L) => L.roadHalf || global.NR.ROAD_HALF;
      this.track.halfWidth = b ? M.lerp(drive(a), drive(b), t) : drive(a);
      this.track.outerHalf = b ? M.lerp(road(a), road(b), t) : road(a);
      /* The sun swings round with the country. Stepping toward the next
         bearing the SHORT way round stops it crossing the whole compass when
         two neighbouring routes happen to face opposite ways. */
      const ya = this.ensureSunYaw(a);
      this.scene.placeSun(b ? ya + M.angDiff(ya, this.ensureSunYaw(b)) * t : ya);
    }

    /* The two routes that build a world of their own only get to have it while
       the car is in them. Aurora Forge's hall is nineteen kilometres of merged
       steel and is built up front rather than in the middle of a run; Neon
       Horizon's deck CULLS the generated country outright, so it comes on at
       the gate and not a metre before it, or the ground would go out from
       under everything still behind the car. */
    syncFreeRoamWorlds() {
      if (!this.freeRoam) return;
      const NRg = global.NR;
      if (!this.__level6Director && NRg.Level6Director) new NRg.Level6Director(this);
      const forge = this.__level6Director;
      if (forge && forge.world && forge.world.build) forge.world.build();
      if (NRg.Level7World) {
        if (!this.__level7World) this.__level7World = new NRg.Level7World(this);
        this.scene.level7World = this.__level7World;
        /* A chapter never leaves the deck, so it drops the whole generated
           country. A tour drives ONTO the deck, and dropping the country
           behind the car at the same moment is most of what made that
           handover a jump cut. Tagged once; see js/level7.js. */
        if (NRg.level7TagGround) NRg.level7TagGround(this.scene);
        /* Constructed here rather than on the first frame that wants it: its
           constructor resets, and a reset clears the abilities a tour has just
           been given. */
        if (NRg.PredatorDirector && !this.__level7Director) new NRg.PredatorDirector(this);
        this.scene.level7GroundKeep = true;
        this.scene.level7Override = this.distance >= REGION_EDGES[REGION_EDGES.length - 1];
      }
      this.startAt = this.freeRoamFrom;
      this.finishAt = FREE_ROAM_END;
    }

    toMenu() {
      this.exitFreeRoam();
      /* ...and cut the car off at the moment the screen changes, rather than
         waiting for the ramp. Leaving a race with the throttle still held is
         the common case, not the odd one. */
      if (this.audio && this.audio.silenceCar) this.audio.silenceCar();
      if (this.car) { this.car.engineLoad = 0; this.car.wheelSpinFx = 0; }
      this.state = 'menu';
      this.cursorHiddenForRun = false;
      this.syncCursorVisibility();
      this.menuIndex = 0;
      for (const it of this.menuItems) it.typed = 0;
      this.resetCar();
      this.onMusic();
      this.fadeTo(0);
    }

    beginRace() {
      /* ...and the ramps get their approach paint back, which the title
         screen takes off. See hideRaceMarkings. */
      if (this.scene) this.scene.hideRaceMarkings = false;
      /* THE CONTROLS CARD IS A TUTORIAL, AND A TOUR IS NOT A FIRST RACE.
       *
       * It used to be unconditional, so the open route - the thing a player
       * only reaches by finishing seven chapters - opened every single run by
       * telling them which key is the accelerator. There is a full, rebindable
       * CONTROLS screen now, which is where somebody who wants
       * to look them up goes; a modal in front of a road they have already
       * driven end to end is just a key press between them and the car. */
      this.state = this.freeRoam ? 'countdown' : 'startcard';
      this.applyLevel();
      this.resetCar();
      this.raceTime = 0;
      this.newRecord = false;
      this.fadeTo(0);
      /* Before the music, because a tour picks its opening region's score -
         and because the two routes that build their own world build it here,
         under the controls card, rather than in the middle of the run. */
      if (this.freeRoam) this.beginFreeRoamRun();
      this.onMusic();
      // no card to press a key on, so the lights start themselves
      if (this.freeRoam) this.startCountdown();
    }

    startCountdown() {
      this.state = 'countdown';
      this.syncCursorVisibility();
      this.countdown = 3.999;
      this.lastBeep = -1;
    }

    finish() {
      this.raceOver = true;
      this.state = 'finished';
      /* Nothing left to resume: the run the autosave describes is over, and
         offering to put the player back four hundred metres before a line they
         have already crossed is the one way this feature can be worse than
         not having it. */
      if (global.NR.Autosave) global.NR.Autosave.clear();
      /* Winning banks the difficulty it was won at, which is what opens the
         next road - and only up to the setting that was actually beaten. A
         Free Roam tour is not a chapter result and never writes one. */
      if (this.won && !this.freeRoam) {
        const lvl = this.levelIndex;
        const won = this.diffIndex + 1;
        if (won > (this.cleared[lvl] | 0)) {
          this.cleared[lvl] = won;
          try { global.NR.Save.setJSON(PROGRESS_KEY, this.cleared); }
          catch (e) { /* private mode */ }
          this.unlockedNow = lvl + 1 < LEVELS.length;
        }
      }
      this.finishIndex = 0;
      this.audio.goBeep();
      this.score += Math.round(Math.max(0, 900 - this.raceTime) * 12);
      /* Which best this run is measured against. A tour banks its own, and
         only when it was a whole one - a run that got on at Ashfall is not a
         time the seawall-to-horizon record can be compared with, so it keeps
         no record at all and `recordKey` is null. */
      if (this.recordKey && (this.record == null || this.raceTime < this.record)) {
        this.record = this.raceTime;
        this.newRecord = true;
        writeNum(this.recordKey, this.record);
      }
    }

    confirm() {
      /* Shut behind itself, whether or not what it does changes the state -
         a row that toggles something in place would otherwise take four
         presses from one spammed key. See NR.Gate. */
      if (NR.Gate) NR.Gate.lock();
      if (this.state === 'menu') this.menuItems[this.menuIndex].act();
      else if (this.state === 'startcard') this.startCountdown();
      else if (this.state === 'paused') this.activatePause();
      else if (this.state === 'finished') this.activateFinish();
    }

    /* Going into and out of the pause screen.
     *
     * Both halves exist because pausing is not only a state change: the car
     * has to be taken off the mix on the way in and the radio has to come back
     * up on the way out, and three different call sites were doing one of
     * those and not the other. */
    enterPause() {
      if (this.state === 'paused') return;
      /* A backstop for the rule above. Several things reach for the pause
         menu - the key, a lost window focus, the story director - and a
         multiplayer race must refuse all of them rather than only the one
         that was remembered. */
      if (this.multiplayer && this.multiplayer.racing) return;
      /* Opening the menu is a moment the player chose. Written BEFORE the
         state changes, because the snapshot only takes a run that is racing -
         which is the correct rule everywhere else and exactly wrong here. */
      if (this.autosave) this.autosave.mark('pause');
      this.state = 'paused';
      this.pauseItems = this.pauseRowsFor();
      this.pauseDisabled = this.pauseDisabledFor(this.pauseItems);
      this.pauseIndex = 0;
      /* A hard, immediate lift. update(..., false) alone ramps the loops down
         over ~0.1 s, which is right for a lifted throttle and slightly too
         slow for a menu that has just appeared over the top of the frame. */
      if (this.audio.silenceCar) this.audio.silenceCar();
      // ...and the radio steps back so the interface can be heard over it
      if (this.audio.setMusicDuck) this.audio.setMusicDuck(0.55, 0.25);
    }

    leavePause() {
      if (this.state !== 'paused') return;
      this.state = 'racing';
      if (this.audio.setMusicDuck) this.audio.setMusicDuck(0, 0.45);
    }

    /* IS THE WORLD ACTUALLY RUNNING THIS FRAME?
     *
     * Four directors hang work off the end of Game.update - the story, and
     * Chapters 5, 6 and 7 - and every one of them does it the same way:
     *
     *     oldUpdate.call(this, dt);
     *     director.afterUpdate(dt);
     *
     * `oldUpdate` RETURNS EARLY on a menu, a pause and the finish card. The
     * hook does not, so everything a director does per frame carried on
     * running behind a screen the player had explicitly stopped the game with:
     * dialogue popped up over the pause card, raceMode's cooldown counted
     * down, hazards armed and fired, taunts fired, event banners came and
     * went. That is the reported "popups still show up while paused" and the
     * reported "raceMode refills while paused", and they are one defect.
     *
     * Anything that is not simulation - the interface fading a card out, a
     * timer the player is waiting on - can still ask for a frame; that is what
     * `simulating` is false for. Nothing that MOVES the race may. */
    /* ONE raceMode STATE, FOR THREE PLACES THAT SPEND IT.
     *
     * Chapter 6 keeps its own `raceModeTimer/raceModeCooldown`, Chapter 7 its
     * own `modeTimer/modeCooldown`, a tour its own `freeRoamMode` - each with
     * its own meter. They are the same thirty seconds and the same seventy of
     * cooldown, so they publish into one object and the HUD draws one widget.
     * Nothing owns the ability differently; only who is counting it down.
     *
     * Called once a frame from update(), after every director has had its say,
     * so whichever of them is live is the one that is read. */
    syncRaceMode() {
      const rm = this.raceMode || (this.raceMode = {
        available: false, active: false, timer: 0, cooldown: 0,
        window: 30, rest: 70, reserveLive: false,
      });
      const d6 = this.__level6Director, d7 = this.__level7Director;
      const chapter6 = d6 && d6.isChapter && d6.isChapter();
      const chapter7 = d7 && d7.isChapter && d7.isChapter();
      let src = null;
      if (chapter7 && d7.started) {
        /* `rest` is what the ring counts DOWN FROM, and Chapter 7's is not a
           constant any more - it climbs 10, 20, 30, 40 with each spend. The
           director reports the rung it charged; see modeRest there. */
        /* The WINDOW comes from the director too. It was a hardcoded thirty
           here, so shortening Chapter 7's window would have left the meter
           emptying a third of the way and stopping - a bar that lies about
           the one resource the finale is built around. */
        src = { active: d7.modeActive, timer: d7.modeTimer, cooldown: d7.modeCooldown,
                window: d7.modeWindow || 30, rest: d7.modeRest || 30,
                reserve: d7.reserveLoaded };
      } else if (chapter6 && d6.started) {
        src = { active: d6.raceModeActive, timer: d6.raceModeTimer, cooldown: d6.raceModeCooldown,
                window: 30, rest: 70, reserve: d6.reserveLoaded };
      } else if (this.freeRoam && this.freeRoamMode) {
        const m = this.freeRoamMode;
        src = { active: m.active, timer: m.timer, cooldown: m.cooldown,
                window: RACE_MODE_SECONDS, rest: RACE_MODE_COOLDOWN, reserve: m.reserve };
      }
      rm.available = !!(this.raceModeAvailable && src);
      if (!src) { rm.active = false; rm.reserveLive = false; return; }
      rm.active = !!src.active;
      rm.timer = src.timer || 0;
      rm.cooldown = src.cooldown || 0;
      rm.window = src.window;
      rm.rest = src.rest;
      rm.reserveLive = !!(src.active && src.reserve);
    }

    get simulating() {
      return this.state === 'racing' || this.state === 'countdown';
    }

    /* --------------------------------------- RESTART, OR GO BACK A BIT --
     *
     * RESTART throws away the whole run. On a thirty-kilometre finale that is
     * a brutal thing to be the only option a pause menu offers: a player who
     * has just been hit by the last slab of the tower run and wants another go
     * at it has the choice of driving the entire chapter again or leaving.
     *
     * The chapters already keep a checkpoint - they have to, because their own
     * hazards rewind to it - so the pause card offers it. Which director owns
     * one depends on where the player is, and outside a chapter there is
     * nothing to own one, so the row only appears when it can actually do
     * something. A menu row that is present and inert teaches the player not
     * to trust the menu.
     */
    checkpointOwner() {
      const d7 = this.__level7Director;
      if (d7 && d7.isChapter && d7.isChapter() && d7.started && d7.restoreCheckpoint) return d7;
      const d6 = this.__level6Director;
      if (d6 && d6.isChapter && d6.isChapter() && d6.started && d6.cp && d6.rewind) return d6;
      return null;
    }

    /* HAS A CHECKPOINT ACTUALLY BEEN REACHED?
     *
     * Owning a checkpoint system and having something in it are two different
     * questions, and the pause card was asking the first one. From the moment
     * a chapter starts it offered RESTART FROM CHECKPOINT - and before the
     * first gate there is nothing stored, so what the row did was put the
     * player back at the beginning of the chapter under a name that promised
     * something else. A row that lies once is a row nobody trusts again.
     *
     * Chapter 7 keeps a snapshot and its index is which gate it was taken at,
     * so index zero is the start line and not a checkpoint anybody drove to.
     * Chapter 6 keeps `cp`, which is null until the first trial marks one.
     */
    checkpointReady() {
      const d = this.checkpointOwner();
      if (!d) return false;
      if (d.checkpointSnapshot) return (d.checkpointSnapshot.index | 0) > 0;
      if (d.cp !== undefined) return !!d.cp;
      return false;
    }

    /** The rows this pause card should have, for where the run is now. */
    pauseRowsFor() {
      return this.checkpointOwner()
        ? ['RESUME', 'RESTART FROM CHECKPOINT', 'RESTART CHAPTER', 'MAIN MENU']
        : ['RESUME', 'RESTART', 'MAIN MENU'];
    }

    /* ...and which of them are dead right now. The row STAYS on the card when
       there is no checkpoint yet - dropping it would move every row under it
       and make the menu change shape mid-chapter - and is drawn greyed with
       the reason under it instead. See menuList in js/hud.js. */
    pauseDisabledFor(rows) {
      const ready = this.checkpointReady();
      return rows.map((r) => r === 'RESTART FROM CHECKPOINT' && !ready);
    }

    activatePause() {
      const row = this.pauseItems[this.pauseIndex] || '';
      /* A dead row does nothing and says nothing new: the card is already
         showing why it is dead. What it must not do is fall through to the
         restore below, which would put the player at the start line. */
      if ((this.pauseDisabled || [])[this.pauseIndex]) {
        if (this.audio.uiDeny) this.audio.uiDeny(); else this.audio.uiMove();
        return;
      }
      this.audio.uiMove();
      if (row === 'RESUME') { this.leavePause(); this.onMusic(); return; }
      if (row === 'RESTART FROM CHECKPOINT') {
        const d = this.checkpointOwner();
        /* Out of the menu FIRST: Chapter 6's rewind puts the game back into
           `racing` itself and Chapter 7's expects to be called from a running
           race, so leaving the pause before either of them runs is what keeps
           the two paths the same. */
        this.leavePause();
        this.onMusic();
        if (d) { if (d.restoreCheckpoint) d.restoreCheckpoint(); else d.rewind(); }
        return;
      }
      if (row === 'RESTART' || row === 'RESTART CHAPTER') {
        this.leavePause();
        this.beginRace();
        return;
      }
      if (this.audio.setMusicDuck) this.audio.setMusicDuck(0, 0.2);
      this.toMenu();
    }

    /* ------------------------------------------- THE CARD AT THE END --
     *
     * RETRY and MAIN MENU had no pointer at all. Every other card in the game
     * highlights under the mouse and takes a click - the title screen, the
     * controls pages, the pause card, the confirmation - and the one card the
     * player is guaranteed to meet, the one that comes up when they have just
     * lost, was keyboard only. Moving the mouse down it did nothing and
     * clicking MAIN MENU did whatever a blank click does.
     *
     * It could not be hit-tested the way the others are, either. Those
     * hard-code the row geometry, which works because their lists sit at a
     * fixed height on a fixed panel. This one does not: `baseY` is computed
     * from how much went on the card above it, so it moves depending on
     * whether the route was won, whether a time was beaten and whether the
     * next chapter unlocked. The list publishes where it drew instead - see
     * listRows in Hud.menuList - and this reads that, so the two cannot
     * disagree whatever ends up on the card.
     */
    finishItemAt(e) {
      if (this.state !== 'finished') return -1;
      return this.listItemAt(e);
    }

    activateFinish() {
      if (this.finishIndex === 0) this.beginRace();
      else this.toMenu();
      this.audio.uiMove();
    }

    // ----------------------------------------------------------- update --
    update(dt) {
      this.time += dt;
      this.scene.time = this.time;
      this.fade += (this.fadeTarget - this.fade) * Math.min(1, dt * 3.0);
      this.syncCursorVisibility();
      this.syncModalClass();
      /* Whatever is currently holding the steering bus down. Both chapters
         that can take it set `controlsSwapped`; the input layer reads only
         this. */
      this.input.invert = !!this.controlsSwapped;
      /* Before anything reads it, and before the early return: a pad polled
         only while the game is running would report every button pressed on
         the loading screen as a fresh press the moment it ends. */
      if (this.pad) this.pad.poll(dt);
      if (this.state === 'loading') return;

      const inp = this.input;
      const pointer = this.pointer;
      const menuPointerIndex = this.menuPointerIndex;
      const controlsPointer = this.controlsPointer;
      const pausePointerIndex = this.pausePointerIndex;
      const confirmPointerIndex = this.confirmPointerIndex;
      const finishPointerIndex = this.finishPointerIndex;
      this.pointer = false;
      this.menuPointerIndex = -1;
      this.controlsPointer = null;
      this.pausePointerIndex = -1;
      this.confirmPointerIndex = -1;
      this.finishPointerIndex = -1;

      /* THE PAD DRIVES THE MENUS TOO.

         Folded into the same locals every screen below already reads, rather
         than added as a second condition at each of the fourteen places that
         test them. A controller that can drive the car but not choose a route
         is a controller that still needs a keyboard beside it, and that was
         the state of this before. */
      const nav = this.pad ? this.pad.nav() : null;
      const padUp = !!(nav && nav.up);
      const padDown = !!(nav && nav.down);
      const padLeft = !!(nav && nav.left);
      const padRight = !!(nav && nav.right);
      const padOk = !!(this.pad && this.pad.confirmHit());
      const padBack = !!(this.pad && this.pad.cancelHit());
      this.padToKeys(padUp, padDown, padLeft, padRight, padOk, padBack);

      // Fullscreen is opt-in, on F. Nothing else in the game asks for it.
      if (inp.actHit('fullscreen')) this.toggleFullscreen();

      /* The state this frame started in.

         Every menu branch ends by flying the idle camera down the road, and
         several of them change state first - START opens the level list,
         ENTER on the difficulty screen starts the race. Running the flyby
         afterwards then teleports the car to arc length ~0.9, the head of the
         whole course, while resetCar has just placed it (and its sTrack) at
         the chosen route's start ten kilometres away. Next frame Track.project
         searches +-120 samples around a hint that is nowhere near the car,
         reports a lateral offset of two thousand units, and the barrier
         resolver slams the car sideways into a wall it was never near. That is
         the "car is completely off the track" the moment a new route is
         entered for the first time - and it never showed up on RETRY, because
         the finish card does not fly the camera.

         So the flyby only runs if the branch it belongs to is still the state
         we are in. */
      const entryState = this.state;
      const flyby = (dt2) => { if (this.state === entryState) this.idleFlyby(dt2); };

      if (this.state === 'menu') {
        /* THE TITLE SCREEN IS NOT THERE DURING A BENCHMARK.

           The HUD stops drawing it (see the menu case in js/hud.js) and the
           panel consumes every key and click before this can see one, so in
           practice nothing here could fire. It is skipped anyway, because
           "the input cannot reach it" is a property of two other files and
           this is the one that would act on it: a row that is invisible,
           unreachable and still being typed in and hit-tested is a row
           waiting for somebody to change one of those two files. */
        if (this.benchActive) { this.audio.update(this.car, dt, false); return; }
        for (let i = 0; i < this.menuItems.length; i++) {
          const it = this.menuItems[i];
          const prev = i === 0 || this.menuItems[i - 1].typed >= this.menuItems[i - 1].label.length;
          // held at zero until the opening move has begun to hand over
          const open = this.introReveal === undefined ? 1 : this.introReveal;
          if (prev && open > 0.02 && it.typed < it.label.length) it.typed += TYPE_CPS * dt;
        }
        if (inp.hit('arrowup', 'w')) { this.menuIndex = (this.menuIndex + this.menuItems.length - 1) % this.menuItems.length; this.audio.uiMove(); }
        if (inp.hit('arrowdown', 's')) { this.menuIndex = (this.menuIndex + 1) % this.menuItems.length; this.audio.uiMove(); }
        if (menuPointerIndex >= 0) {
          this.menuIndex = menuPointerIndex;
          this.audio.select();
          this.confirm();
        } else if (inp.hit('enter', ' ')) { this.audio.select(); this.confirm(); }
        /* THE BENCHMARK DRIVES ITS OWN CAMERA, AT A FIXED STEP.

           A benchmark has to put the same work in front of every machine or
           the numbers it produces cannot be compared with anything - and a
           flyby advanced by the real frame time does the opposite: a fast
           machine covers a hundred and forty units of road in a scene and a
           slow one covers eight hundred, so they are not rendering the same
           place, let alone the same amount of it.

           So while a run is on, this hands the camera over and js/bench.js
           steps it at a fixed sixtieth of a second per frame. Every machine
           then drives exactly the same road, frame for frame, and the only
           thing that differs is how long each frame took - which is the one
           thing being measured. */
        if (!this.benchDriving) flyby(dt);
        /* Nothing is driving. Saying so every frame is what stops a throttle
           that was held when the race was left from carrying its engine note
           into the title screen and holding it there - the mixer only ever
           hears about the car from here. */
        this.audio.update(this.car, dt, false);
        return;
      }

      if (this.state === 'controls') {
        /* One row past the settings is SAVE AND BACK. ESC used to do this, but
           ESC is also how a browser leaves fullscreen - so pressing it dropped
           the player out of fullscreen *and* out of the menu at the same time,
           and there was no way to leave the options without doing both. */
        /* A REBIND OWNS THE SCREEN WHILE IT IS LISTENING.
           The keyboard is already being consumed at the Input layer, but the
           pointer is not, and a click landing on another row mid-capture would
           leave the capture armed against a row nobody is looking at. */
        if (this.bindCapture) {
          flyby(dt);
          this.audio.update(this.car, dt, false);
          return;
        }
        const rows = this.settingRows;
        /* One row past the list is SAVE AND BACK, and the row BEFORE the first
           is the tab strip - so arrowing up off the top of the page lands on
           the pages rather than wrapping to the bottom of the one you are
           already on. */
        const n = rows.length + 1;
        if (controlsPointer) {
          if (controlsPointer.tab !== undefined) {
            this.setOptionTab(controlsPointer.tab);
            this.controlIndex = -1;
            flyby(dt);
            this.audio.update(this.car, dt, false);
            return;
          }
          this.controlIndex = controlsPointer.index;
          if (controlsPointer.exit) {
            this.saveAndExitControls();
            flyby(dt);
            return;
          }
          if (controlsPointer.reset) {
            this.resetBinds();
          } else if (controlsPointer.bind) {
            this.beginBind(rows[this.controlIndex].bind);
          } else if (controlsPointer.value !== undefined) {
            this.settings[rows[this.controlIndex].key] = controlsPointer.value;
            this.applySettings();
            this.audio.uiMove();
          } else if (controlsPointer.direction) {
            this.cycleSetting(controlsPointer.direction);
          } else {
            this.audio.uiMove();
          }
        }
        const onTabs = this.controlIndex < 0;
        const onExit = this.controlIndex >= rows.length;
        if (inp.hit('arrowup', 'w')) {
          this.controlIndex = this.controlIndex <= 0 ? -1 : this.controlIndex - 1;
          if (onTabs) this.controlIndex = n - 1;
          this.audio.uiMove();
        }
        if (inp.hit('arrowdown', 's')) {
          this.controlIndex = this.controlIndex + 1 >= n ? -1 : this.controlIndex + 1;
          this.audio.uiMove();
        }
        if (onTabs) {
          if (inp.hit('arrowleft', 'a')) this.setOptionTab(this.controlTab - 1);
          if (inp.hit('arrowright', 'd')) this.setOptionTab(this.controlTab + 1);
          if (inp.hit('enter', ' ')) { this.controlIndex = 0; this.audio.select(); }
        } else if (!onExit) {
          const row = rows[this.controlIndex];
          if (row && row.bind) {
            if (inp.hit('enter', ' ')) this.beginBind(row.bind);
            /* LEFT clears the row. Unbinding an action you never use is a
               legitimate thing to want, and hunting for a key that means
               "none" is not a way to express it. */
            if (inp.hit('arrowleft', 'a')) {
              this.settings.binds[row.bind] = [];
              this.applySettings();
              this.audio.uiMove();
            }
            if (inp.hit('arrowright', 'd')) this.beginBind(row.bind);
          } else {
            if (inp.hit('arrowleft', 'a')) this.cycleSetting(-1);
            if (inp.hit('arrowright', 'd')) this.cycleSetting(1);
            if (inp.hit('enter', ' ')) this.cycleSetting(1);
          }
        } else if (inp.hit('enter', ' ') || pointer) {
          this.saveAndExitControls();
        }
        // R puts every key back, from anywhere on the controls page
        if (this.controlTab === 1 && inp.hit('r')) this.resetBinds();
        flyby(dt);
        this.audio.update(this.car, dt, false);
        return;
      }

      if (this.state === 'startcard') {
        if (inp.hit(' ', 'enter') || pointer) this.startCountdown();
        this.updateCamera(dt);
        this.updateAtmosphere(dt);
        /* Nobody is driving behind this card either. Without this the mixer
           never hears about the car while it is up, so an engine note carried
           in from the previous run sits at whatever gain it was left at. */
        this.audio.update(this.car, dt, false);
        this.settleFx(dt);
        return;
      }

      /* ESCAPE IS NOT NEGOTIABLE. Whatever PAUSE has been rebound to, the key
         every player already knows still works - see the note on ACTIONS.

         EXCEPT THAT MULTIPLAYER CANNOT PAUSE. Three other cars keep driving
         whatever this one does, so stopping the world stops only this
         player's view of it: the car keeps coasting on the server, the
         validator watches it drift off the racing line, and the race is lost
         to a menu that claimed to have paused it. RESTART, sitting in that
         menu, is not a thing a shared race can offer at all.

         So in a multiplayer race the key asks the one question that is
         actually available - leave, or keep driving - over a world that is
         still running. */
      /* THE VIEW KEY, before the pause key and outside every state test: it
         is legal on the grid, mid-race, in a cutscene and on a finish card,
         because there is no state in which "I would like to see this from
         somewhere else" is the wrong request. */
      if (inp.actHit('camera')) this.cycleCamera();
      if (inp.actHit('pause') || inp.hit('escape')) {
        const mp = this.multiplayer;
        if (mp && mp.racing) {
          mp.confirmLeaveRace();
        } else if (this.state === 'racing' || this.state === 'countdown') {
          this.enterPause();
        } else if (this.state === 'paused') {
          this.leavePause();
        }
      }
      /* THE CONFIRMATION OWNS THE KEYBOARD WHILE IT IS UP.
         Placed before every other state's handler and returning unconditionally:
         a modal that the screen underneath can still be arrowed through is not
         a modal, and on the title screen that screen's ENTER starts a chapter. */
      if (this.state === 'confirm') {
        const box = this.confirmBox;
        const n = box ? box.items.length : 2;
        if (inp.hit('arrowup', 'w')) { this.confirmIndex = (this.confirmIndex + n - 1) % n; this.audio.uiMove(); }
        if (inp.hit('arrowdown', 's')) { this.confirmIndex = (this.confirmIndex + 1) % n; this.audio.uiMove(); }
        // LEFT and RIGHT too: two rows read as a pair, and half the players
        // who meet a yes/no will reach for the horizontal axis.
        if (inp.hit('arrowleft', 'a')) { this.confirmIndex = 0; this.audio.uiMove(); }
        if (inp.hit('arrowright', 'd')) { this.confirmIndex = 1; this.audio.uiMove(); }
        if (confirmPointerIndex >= 0) {
          this.confirmIndex = confirmPointerIndex;
          this.activateConfirm();
        } else if (inp.hit('enter', ' ')) this.activateConfirm();
        else if (inp.hit('escape')) this.closeConfirm();
        this.updateCamera(dt);
        this.updateAtmosphere(dt);
        this.audio.update(this.car, dt, false);
        this.settleFx(dt);
        return;
      }
      if (this.state === 'paused') {
        const nPause = this.pauseItems.length;
        if (inp.hit('arrowup', 'w')) { this.pauseIndex = (this.pauseIndex + nPause - 1) % nPause; this.audio.uiMove(); }
        if (inp.hit('arrowdown', 's')) { this.pauseIndex = (this.pauseIndex + 1) % nPause; this.audio.uiMove(); }
        if (pausePointerIndex >= 0) {
          this.pauseIndex = pausePointerIndex;
          this.audio.select();
          this.activatePause();
        } else if (inp.hit('enter', ' ') || pointer) this.activatePause();
        this.updateCamera(dt);
        this.updateAtmosphere(dt);
        /* NOTHING IS DRIVING WHILE THE GAME IS PAUSED.
         *
         * This branch returned without telling the mixer that, and the mixer
         * only ever hears about the car from here - so the engine, the intake,
         * the tyres, the reheat and the wind all held the gain of the frame
         * the pause landed on. Hold the throttle, press ESC, and the car sat
         * there at full song behind a menu with nothing moving. It is the
         * same defect the title screen and the finish card were already fixed
         * for; the pause screen was simply missed.
         *
         * `false` is the whole fix: update() then decays its own copy of the
         * rev counter and ramps every driving loop to zero over about a tenth
         * of a second, which is a lift rather than a cut. */
        this.audio.update(this.car, dt, false);
        this.settleFx(dt);
        return;
      }
      if (this.state === 'finished') {
        if (inp.hit('arrowup', 'w', 'arrowdown', 's')) { this.finishIndex = (this.finishIndex + 1) % 2; this.audio.uiMove(); }
        /* A CLICK ON A ROW PICKS THAT ROW. `pointer` is the old
           anywhere-on-the-screen tap, which on this card always meant RETRY
           whatever the mouse happened to be over - so a player who moved down
           to MAIN MENU and clicked got another lap of the race they had just
           lost. The row under the pointer wins; a blank click still retries,
           which is what the tap-to-continue behaviour is there for. */
        if (finishPointerIndex >= 0) {
          this.finishIndex = finishPointerIndex;
          this.activateFinish();
        } else if (inp.hit('enter', ' ') || pointer) this.activateFinish();
        if (inp.actHit('raceMode')) this.beginRace();
        this.car.update(dt, this.input.sample(), false);
        this.updateCamera(dt);
        this.updateAtmosphere(dt);
        this.audio.update(this.car, dt, false);
        this.settleFx(dt);
        return;
      }
      if (inp.actHit('raceMode') && !this.blockQuickRestart) { this.beginRace(); return; }

      if (this.state === 'countdown') {
        this.countdown -= dt;
        const n = Math.ceil(this.countdown);
        if (n !== this.lastBeep && n >= 0) {
          this.lastBeep = n;
          if (n > 0) this.audio.countBeep(); else this.audio.goBeep();
        }
        if (this.countdown <= 0) { this.state = 'racing'; this.raceTime = 0; }
      }

      const active = this.state === 'racing';
      if (active) this.raceTime += dt;

      /* Arm the stunt course before anything is stepped, so a car meeting an
         incline is inside the window on the frame it arrives rather than one
         frame after it. See updateRamps. */
      this.updateRamps();

      /* The rival drives itself, through the same Vehicle the player is in.
         It gets no more grip, no more power and no more boost - only a driver
         that knows the line and, on the higher settings, uses it well.
         A solo Free Roam tour has nobody out there at all, so it is not
         simulated, not drawn and not lit. */
      if (this.rival && this.driver && !this.soloRun) {
        const cmd = this.driver.drive(dt, this.rival, {
          raceOn: active,
          rivalS: this.car.sTrack,
          rivalX: this.car.x,
          rivalZ: this.car.z,
          finishAt: this.finishAt,
        });
        this.rival.update(dt, cmd, active);
        /* Car against car. Resolved after both have moved, so the impulse acts
           on where they actually ended up rather than on where one of them was
           a frame ago. */
        const bump = global.NR.collideCars(this.car, this.rival);
        if (bump > 2.2) {
          const f = Math.min(1, bump / 14);
          this.audio.crash(f);
          this.shake = Math.max(this.shake, 0.25 + Math.min(0.5, bump / 20));
          if (this.pad) this.pad.vibrate(0.25 + f * 0.5, 70 + f * 130);
          if (this.fx) this.fx.sparks(this.car, f);
          /* Both bodies. A shunt is one event with two dents in it, and only
             ever marking the player's car is how a game ends a race with an
             immaculate rival that has been leaning on you for ten kilometres. */
          this.dentBetween(this.car, this.damage, this.rival, f);
          this.dentBetween(this.rival, this.rivalDamage, this.car, f);
          if (this.glass && f > 0.42) {
            this.shake += this.glass.impact(this.car, f * 0.8, 'car') || 0;
          }
        }
        if (this.rival.lastHit) this.rival.lastHit = false;
        this.rivalGap = this.car.sTrack - this.rival.sTrack;
        this.place = this.rivalGap >= 0 ? 1 : 2;
      }

      if (this.freeRoam) {
        this.updateFreeRoamRaceMode(dt, active);
        this.updateFreeRoamRival(dt);
      }
      const wasBoost = this.car.boosting;
      this.car.update(dt, inp.sample(), active);
      if (this.car.boosting && !wasBoost) this.audio.boostHit();
      if (this.car.lastHit) {
        const hitType = this.car.lastHitType;
        this.car.lastHit = false;
        this.car.lastHitType = null;
        // everything downstream scales with how hard the hit actually was, so
        // a brush along the barrier and a square impact do not look alike
        const hit = this.car.impact;
        this.audio.crash(hit);
        this.flash = 0.05 + hit * 0.14;
        this.shake = 0.35 + hit * 0.85;
        /* The pad feels it too. Scaled by the same `hit` the flash, the shake
           and the sparks are, so the hands are told exactly what the eyes and
           the ears were - a rumble that is the same size for a brush and a
           head-on is a rumble that means nothing. */
        if (this.pad) this.pad.vibrate(0.35 + hit * 0.65, 90 + hit * 220);
        this.combo = 1;
        this.comboTimer = 0;
        this.cleanTime = 0;
        if (hit > 0.3) this.hud.toast('IMPACT', '#ff2e88');
        if (this.fx) this.fx.sparks(this.car, hit);
        this.recordImpact(this.car, this.damage, hitType, hit);
        /* ...and the windscreen. A hard enough blow puts a crack across the
           glass the player is looking through, which is the one damage cue
           that is visible from inside the car. */
        if (this.glass && hit > 0.34) {
          this.shake += this.glass.impact(this.car, hit, hitType) || 0;
        }
        if (hitType === 'wall' && this.story && this.story.onPlayerWallHit) {
          this.story.onPlayerWallHit(hit);
        }
      }
      /* Grinding along a wall. Not an impact - there is no single moment to
         dent - but a flank held against a barrier for two seconds comes away
         polished through the lacquer, and `scrape` is exactly how long it has
         been there and how hard. */
      if (this.damage && this.car.scrape > 0.05) {
        this.damage.scrape(this.car, this.car.scrape, dt);
      }
      if (this.rivalDamage && this.rival && this.rival.scrape > 0.05) {
        this.rivalDamage.scrape(this.rival, this.rival.scrape, dt);
      }
      if (this.glass) this.glass.update(dt);
      /* WHAT A WRECKED BODY COSTS.
       *
       * The solver's `damage` is aerodynamic drag and nothing else (see
       * Vehicle::damage): it takes about a fifth off the terminal speed of a
       * completely wrecked car and takes nothing at all out of a corner. That
       * is the right shape for a racing penalty, and it is what makes the BODY
       * readout on the instrument worth watching rather than decorative.
       *
       * The number is the presentation layer's, because the presentation layer
       * is what knows how many panels are caved in - the solver only knows
       * that it hit something. */
      if (this.damage) this.car.damage = this.damage.total || 0;
      if (this.rivalDamage && this.rival) this.rival.damage = this.rivalDamage.total || 0;
      this.flash = Math.max(0, this.flash - dt * 0.9);
      this.shake = Math.max(0, (this.shake || 0) - dt * 3.2);

      this.distance = this.car.sTrack;
      /* The radio follows the actual country under the car, not just the route
         chosen on the menu. Crossing a zone boundary while a song is playing
         asks Audio for an environment cross-fade; staying in the same zone
         leaves the current song untouched until it ends. */
      if (this.audio.setEnvironment && this.scene.environmentAt) {
        this.audio.setEnvironment(this.scene.environmentAt(this.distance));
      }
      /* Across the route, not across the course. A route that starts at 45 km
         and finishes at 68 km is not 66% complete on the grid. */
      const span = Math.max(1, this.finishAt - this.startAt);
      this.progress = M.clamp((this.distance - this.startAt) / span, 0, 1);
      const pace = M.clamp((this.car.speedKmh - 70) / 110, -1, 1);
      this.chase = M.clamp(this.chase + (active ? -pace * dt * 0.22 : 0), 0, 1);

      if (active) this.updateScore(dt);
      if (active && !this.raceOver) {
        const mine = this.distance >= this.finishAt;
        const theirs = !this.soloRun && this.rival && this.rival.sTrack >= this.finishAt;
        if (mine || theirs) {
          this.won = mine && (!theirs || this.distance >= this.rival.sTrack);
          this.finish();
        }
      }

      this.updateAtmosphere(dt);
      this.updateCamera(dt);
      if (this.fx) {
        this.fx.update(dt, this.rival && !this.soloRun ? [this.car, this.rival] : this.car,
          this.state === 'racing');
      }
      if (this.autosave) this.autosave.update(dt);
      this.audio.update(this.car, dt, true);
    }

    /* THE WORLD GRINDING TO A HALT, RATHER THAN STOPPING DEAD.
     *
     * Every screen that holds over a race - pause, the confirmation, the
     * finish card, a cutscene - returns early from update() without stepping
     * the particle system. The particles are still DRAWN, so what was in the
     * air at the moment the menu opened stays in the air: on MIRAGE CIRCUIT,
     * which has the clearest air on the course and throws a pale blue grit
     * stream past the camera at speed, that is a curtain of frozen specks
     * hanging over the pause menu for as long as it is open. It was reported
     * as rain, which is exactly what it looks like.
     *
     * The system already takes an `active` flag and it already means the
     * right thing: emitters off, integration on. So a held screen steps it
     * with emission off, everything in flight lives out its half second and
     * dies, and the menu ends up over a still frame instead of over weather.
     *
     * Called from every branch that holds, rather than from one place, for
     * the same reason the audio call is: there is no single point they all
     * pass through, and a held screen that is missed is a screen where this
     * comes back.
     */
    settleFx(dt) {
      if (!this.fx) return;
      this.fx.update(dt, this.rival && !this.soloRun ? [this.car, this.rival] : this.car, false);
    }

    /* WHERE ON THE BODY A BARRIER HIT LANDED.
     *
     * The solver reports that a wall was hit and how hard, and that is all it
     * needs to - which side and which end are presentation. Both come out of
     * state it already publishes:
     *
     *   WHICH SIDE is the sign of the car's lateral offset. There is a barrier
     *   at each edge of the corridor and the car can only be against the one
     *   it is nearest, which is the same test fx.sparks already uses to decide
     *   which flank throws them.
     *
     *   WHICH END is the yaw rate. Every point on the body has lateral speed
     *   `vLat + yawRate * z`, so the end travelling fastest toward the wall is
     *   the front when the nose is swinging into it and the tail when the car
     *   is spinning away - which is the difference between a nose-in shunt and
     *   clipping the barrier with the back of the car on the way out of a
     *   slide, and they should not leave the same dent.
     */
    recordImpact(car, dmg, kind, force) {
      if (!dmg || !car) return;
      if (kind === 'car') return;            // handled by dentBetween, on both
      const side = (car.lateral || 0) >= 0 ? 1 : -1;
      const cy = Math.cos(car.yaw), sy = Math.sin(car.yaw);
      // the body's own +X axis in world, toward the barrier it is against
      const dx = cy * side, dz = -sy * side;
      const along = M.clamp((car.yawRate || 0) * side * 3.0, -1, 1) * 1.7;
      dmg.hitWorld(car, dx, 0, dz, force, along);
    }

    /** A shunt: the dent goes where the other car actually is. */
    dentBetween(car, dmg, other, force) {
      if (!dmg || !car || !other) return;
      const dx = other.x - car.x, dz = other.z - car.z;
      const l = Math.hypot(dx, dz);
      if (l < 1e-3) return;
      dmg.hitWorld(car, dx / l, 0, dz / l, force, 0);
    }

    /* Drift bank, clean-running combo and split times.
       None of it changes the race result - the clock is still the clock - but
       it gives the middle of a 22 km run something to chase. */
    updateScore(dt) {
      const car = this.car;
      this.topSpeedSeen = Math.max(this.topSpeedSeen, car.speedMph);

      if (car.driftAmount > 0.25 && car.speed > 18) {
        this.driftBank += car.driftAmount * car.speed * dt * 2.4;
        this.comboTimer = 1.6;
      } else if (this.driftBank > 0) {
        this.comboTimer -= dt;
        if (this.comboTimer <= 0) {
          const gain = Math.round(this.driftBank * this.combo);
          if (gain > 60) {
            this.score += gain;
            this.combo = Math.min(8, this.combo + 1);
            this.hud.toast('DRIFT +' + gain + (this.combo > 2 ? '  x' + this.combo : ''), '#39e6ff');
            this.audio.checkpoint();
          }
          this.driftBank = 0;
        }
      }

      /* CLEAN RUNNING HAS TO BE RUNNING.
       *
       * This added `dt` every frame whatever the car was doing, so a car
       * standing still - on the grid, in a lobby countdown, or belonging to
       * somebody who had put the pad down and walked off - collected
       * "CLEAN x2", "CLEAN x3" every twelve seconds for doing nothing at all.
       * The reward is for covering ground without hitting anything, so it only
       * counts while ground is being covered.
       *
       * The timer is FROZEN below the threshold rather than reset: a slow
       * hairpin taken well is still clean running, and punishing it would make
       * the multiplier a reward for not braking. Only an impact resets it,
       * which is what it always meant. */
      if (car.speed > 6) {
        this.cleanTime += dt;
        if (this.cleanTime > 12) {
          this.cleanTime = 0;
          this.combo = Math.min(8, this.combo + 1);
          this.hud.toast('CLEAN  x' + this.combo, '#ffb400');
        }
      }

      /* A split every fifth of the ROUTE.
         Measuring from the head of the course instead was harmless while a
         route started at arc length 30 and fatal once they did not: route 4
         starts at 54 km, so three of its five checkpoints were already behind
         the grid and fired on the first frame of the race at a split time of
         zero. */
      const seg = Math.max(1, this.finishAt - this.startAt) / 5;
      while (this.nextSplit < 5
             && this.distance >= this.startAt + (this.nextSplit + 1) * seg) {
        this.nextSplit++;
        this.splits.push(this.raceTime);
        if (this.nextSplit < 5) {
          this.hud.toast('CHECKPOINT ' + this.nextSplit + '/5', '#8b5cf6');
          this.audio.checkpoint();
          this.car.boost = Math.min(1, this.car.boost + 0.34);
        }
      }
    }

    /** Tunnel blend, road wetness and headlight aim. */
    updateAtmosphere(dt) {
      /* A Free Roam handover is a change of country, so it belongs with the
         rest of the atmosphere rather than in the race branch: this is the one
         call every driving state already makes, including the controls card
         and the pause screen. */
      if (this.freeRoam) this.updateFreeRoamRegion(dt);
      const p = this.track.at(this.distance, {});
      /* Fog, sky and road wetness are what the LENS is in, not what the car
         is in. They are the same thing for all but a fraction of a second at
         each portal - but that fraction is exactly when a tunnel is most
         obvious, and it is the difference between the sky cutting out as the
         camera goes under and as the car does. */
      /* ...and a car on the ROOF of a bore is not inside it.
         The tunnel flag stays set across a bypass, because the bore is still
         there and is still drawn at grade underneath. Without this the deck
         over MIRAGE CIRCUIT's sealed tunnel would cut the sky out and light
         the car as though it were inside the thing it is driving over. See
         OVERPASSES in crates/synx-core/src/track.rs. */
      const over = global.NR.onOverpass && global.NR.onOverpass(this.distance);
      const inBore = over ? 0 : ((p.tunnel ? 1 : 0) || (this.camTunnel || 0));
      this.tunnel = M.damp(this.tunnel, inBore, 3, dt);
      const mph = this.car.speedMph || 0;
      const ramp = (a, b) => {
        const q = M.clamp((mph - a) / Math.max(1, b - a), 0, 1);
        return q * q * (3 - 2 * q);
      };
      const rushTarget = ramp(82, 108);       // chassis/camera load builds first
      const limitTarget = ramp(118, 132);     // only the final few mph feel tense
      const boostTarget = this.car.boosting ? 1 : 0;
      if (boostTarget && !this.speedBoostWas) this.boostKick = 1;
      this.speedBoostWas = !!boostTarget;
      this.boostKick = Math.max(0, this.boostKick - dt * 2.15);
      this.speedRush = M.damp(this.speedRush, rushTarget, 5.5, dt);
      this.speedLimitFx = M.damp(this.speedLimitFx, limitTarget, 5.0, dt);
      this.boostFx = M.damp(this.boostFx, boostTarget, boostTarget ? 10 : 5, dt);
      this.raceModeFx = M.damp(this.raceModeFx || 0,
        this.raceModeActive ? 1 : 0, this.raceModeActive ? 7.5 : 3.2, dt);
      const base = M.clamp((this.car.speed - 22) / 64, 0, 1);
      const speedTarget = Math.min(1.15,
        base * .54 + rushTarget * .18 + limitTarget * .16 + boostTarget * .24);
      this.speedFx = M.damp(this.speedFx, speedTarget, 4.8, dt);
      // the road is damp all night and wetter under the tunnels, which is what
      // gives the reflections something to work with
      const baseWet = this.levelWet === undefined ? 0.32 : this.levelWet;
      this.scene.wet = M.damp(this.scene.wet, baseWet + this.tunnel * 0.34, 2, dt);
      this.scene.brakeLight = lampOf(this.car);
      /* The boost button follows the pedal over about a tenth of a second in
         and a fifth back out - a thumb pushes faster than a spring returns. */
      const want = this.car && this.car.boosting ? 1 : 0;
      const rate = want > (this.boostPress || 0) ? 18 : 9;
      this.boostPress = M.damp(this.boostPress || 0, want, rate, dt);
      this.scene.setHeadlights(this.car, 1);
      this.scene.setShadows(this.rival ? [this.car, this.rival] : [this.car]);
      /* Everyone else's lamps. The rival and, on the invitational grid, the
         rest of the field: the three nearest the camera get real beams, which
         is what stops a night race reading as one lit car and a row of
         silhouettes. */
      const others = [];
      if (this.rival && !this.storyHideRival) others.push(this.rival);
      if (this.storyRaptor) others.push(this.storyRaptorRenderPose || this.storyRaptor);
      for (const e of (this.storyExtraRacers || [])) if (e && e.car) others.push(e.car);
      this.scene.setRivalLights(others, this.eye);
      this.scene.rivalBrakeLight = lampOf(this.rival);
    }

    /* THE ATTRACT DRIVE BEHIND THE MENUS.
     *
     * The solver is not running here - the car is not being driven, it is
     * being CARRIED along the centreline - so everything the solver would
     * normally maintain has to be written by hand, and for a long time this
     * wrote two thirds of it: x, z and yaw, and nothing vertical at all.
     *
     * On the opening streets that is invisible, because they are laid at about
     * y=0 and a car left at y=0 happens to be right. The moment the flyby
     * reaches the finale's expressway it is not: that deck climbs to
     * twenty-six units and drops to minus eight, and a car pinned at the world
     * origin drives straight through the surface and out of the bottom of the
     * road. The car had no `sTrack` either, so `Track.project` was searching
     * around a hint left over from wherever it was last actually driven.
     *
     * The road decides all of it now - height, arc length, grade - which is
     * the same contract the solver keeps at the end of every step. */
    /* ------------------------------------------------- THE ATTRACT DRIVE --
     *
     * WHAT IS BEHIND EVERY MENU IN THE GAME, and it used to drive through the
     * scenery.
     *
     * This is a kinematic slide, not a simulation: it advances an arc length
     * at a constant speed and places the car on the centreline. That is the
     * right shape for a backdrop - it costs nothing, it cannot crash, and it
     * cannot leave the road - but it meant the car passed through every launch
     * ramp on the course as though they were painted on, which is the one
     * thing a title screen must not do with the game's own furniture.
     *
     * So it flies now. The climb is the ramp's own `h * u^2` profile and the
     * flight is integrated under the solver's own gravity - see
     * `synx_air_constants`, which is exported precisely so that this file and
     * the solver cannot disagree about what a car in the air does. What the
     * menu shows is the arc the player will actually drive.
     *
     * THE SHOWREEL. A lap of the whole course is fifty-three minutes at this
     * speed, and there are eight ramps on it - so left to run from wherever it
     * happened to be, the attract drive showed a jump about once every seven
     * minutes and the rest of the time showed an empty road. It runs a reel
     * instead: a handful of stretches, each cut to arrive at something worth
     * looking at, cycled in order. See ATTRACT_REEL.
     */
    idleFlyby(dt) {
      const reel = this.attractReel || (this.attractReel = {
        i: Math.floor(Math.random() * ATTRACT_REEL.length), s: 0, air: null,
      });
      const shot = ATTRACT_REEL[reel.i % ATTRACT_REEL.length];
      if (!reel.s || reel.s < shot.from) reel.s = shot.from;
      reel.s += dt * ATTRACT_SPEED;
      if (reel.s >= shot.to) {
        reel.i = (reel.i + 1) % ATTRACT_REEL.length;
        reel.s = ATTRACT_REEL[reel.i].from;
        reel.air = null;
        /* A cut, not a slide. The camera is re-marked from scratch at the new
           stretch rather than swept across the map to it. */
        /* A CUT, NOT A SWEEP. The mark is re-struck from scratch at the new
           stretch rather than damped across the map to it - see attractCamera.
           `camYaw` is snapped with it so that whichever screen takes the
           camera back afterwards does not inherit a heading from two
           kilometres away. */
        this.attractCut = true;
        this.camYaw = this.track.at(reel.s, {}).yaw;
      }
      /* Nobody is aiming anything on a title screen, so the ramps' approach
         paint comes off - see hideRaceMarkings in js/scene.js. Set every
         frame the flyby runs and cleared when a race starts, so it cannot be
         left on over a run. */
      if (this.scene) this.scene.hideRaceMarkings = true;
      this.distance = M.clamp(reel.s, 0, this.track.length - 4);

      const p = this.track.at(this.distance, {});
      this.car.sTrack = this.distance;

      /* ------------------------------------- SOMEBODY IS DRIVING IT -----
       *
       * Everything above places the car. This is what it is DOING, and
       * without it the backdrop is a car being towed down the middle of a
       * road at a constant speed with the engine off:
       *
       *   IT SAT DEAD CENTRE. A car on a road is on a line, and the line is
       *   not the centreline - it leans into the corner and drifts back out
       *   of it. The lateral here is read off the road ahead rather than
       *   wobbled on a timer: it moves toward the inside of whatever the car
       *   is about to turn through, which is where a driver would put it, and
       *   it goes straight when the road does.
       *
       *   IT DID NOT LEAN. A car that never rolls is a model on rails. The
       *   roll comes off the same measurement as the line, so the two agree
       *   by construction.
       *
       *   IT HELD ONE SPEED THROUGH EVERYTHING. Fifty-five units, corners and
       *   straights alike, which makes the camera's own dollies look
       *   unmotivated - nothing the lens does is answering anything. It
       *   breathes with the road now: off in the corners, back on out of them.
       *
       *   AND IT NEVER LIT THE REHEAT. On the one road in the game where a
       *   car should be showing off, on the screen every player sees first.
       *   It boosts into every launch on the reel and holds it through the
       *   flight, which is what the trail and the plume are for.
       */
      const ahead1 = this.track.at(Math.min(this.track.length - 2, this.distance + 45), {});
      const ahead2 = this.track.at(Math.min(this.track.length - 2, this.distance + 130), {});
      // how hard the road is about to turn, signed: + is a left-hander
      const bend = M.angDiff(p.yaw, ahead2.yaw);
      const A = this.attractLine
        || (this.attractLine = { lat: 0, roll: 0, speed: ATTRACT_SPEED, boost: 0, slip: 0 });
      /* Toward the inside of the bend, and never past the paint. The road is
         forty units wide, so eleven either side of centre is a racing line
         rather than a lane change. */
      A.lat = M.damp(A.lat, M.clamp(bend * 34, -11, 11), 1.6, dt);
      A.roll = M.damp(A.roll, M.clamp(-bend * 1.5, -0.11, 0.11), 2.2, dt);

      /* ---------------------------------------------- AND IT DRIFTS -----
       *
       * The reel is cut around corners now, so the thing the menu is showing
       * is a car going through one - and a car going through one at this
       * speed is SIDEWAYS. Without this it tracked round the bend perfectly
       * square to its own path, which is not a driver, it is a slot car.
       *
       * The slip angle is read off the road ahead, so it builds as the corner
       * tightens and unwinds as it opens. Everything downstream of it is the
       * same field the solver would have set - `driftAmount` is what the trail
       * thickens on, what the tyre smoke fires on and what the marks are laid
       * from (see fx.js) - so the effects do not have to be told about the
       * menu at all. They just see a car that is sliding, because it is.
       *
       * COUNTER-STEER comes out of the same number for free: the hands are
       * posed from `steer` and on the exit the slip is falling while the road
       * is still turning, so the wheel comes back through centre exactly when
       * a driver's would.
       */
      /* ...and a straight is not slid. `bend` is small there anyway, but a
         flat stretch that happens to catch a kink should read as a car
         tracking dead straight, not as one twitching. */
      const slipGain = (shot.kind === 'flat') ? 0.10 : 0.34;
      const slipWant = M.clamp(bend * slipGain, -0.46, 0.46);
      A.slip = M.damp(A.slip === undefined ? 0 : A.slip, slipWant, 3.4, dt);
      const drift = M.clamp(Math.abs(A.slip) / 0.34, 0, 1);

      /* THE REHEAT, AND WHAT THIS STRETCH IS FOR.
       *
       * Each reel entry declares a flavour and the drive reads it, because
       * the three of them want the throttle in three different places:
       *
       *   FLAT    it is a straight and the point of it is speed, so the
       *           reheat is lit for the whole stretch.
       *   JUMP    on from a couple of seconds out and held through the
       *           flight, which is the shape a player's own run at a ramp
       *           has.
       *   DRIFT   on the EXIT - once the car has stopped turning in and the
       *           road is opening up again, which is where a driver's goes.
       */
      const kind = shot.kind || 'drift';
      let wantBoost;
      if (kind === 'flat') {
        wantBoost = true;
      } else if (kind === 'jump') {
        const nx = this.nextRamp(this.distance);
        const toFoot = nx ? nx.s - (nx.crest || 0) - nx.len - this.distance : 1e9;
        wantBoost = (reel.air && reel.air.flying) || (toFoot > -200 && toFoot < 130);
      } else {
        wantBoost = (Math.abs(slipWant) < Math.abs(A.slip) - 0.01) && drift > 0.25;
      }
      A.boost = M.damp(A.boost, wantBoost ? 1 : 0, wantBoost ? 5 : 1.8, dt);

      /* A straight is driven faster than a corner is. The reel's own speed is
         what a showcase cruises at; the flat stretches run a third quicker on
         top of the reheat, which is the difference between a car going past
         and a car going past FAST. */
      const base = ATTRACT_SPEED * (kind === 'flat' ? 1.24 : 1);
      A.speed = M.damp(A.speed,
        base * (1 - Math.min(0.18, drift * 0.18)) + A.boost * 11, 1.1, dt);

      this.car.lateral = A.lat;
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      this.car.x = p.x + rx * A.lat; this.car.z = p.z + rz * A.lat;
      this.car.yaw = p.yaw + M.angDiff(p.yaw, ahead1.yaw) * 0.22 + A.slip;
      /* What the effects read. None of these are simulated here - the car is
         being carried, not driven - so they are written by hand, once, in one
         place, rather than being inferred separately by every system that
         wants to know whether the car is sideways. */
      this.car.driftAmount = drift;
      this.car.driftAngle = A.slip;
      this.car.driftDir = A.slip >= 0 ? 1 : -1;
      this.car.drifting = drift > 0.28 ? 1 : 0;
      this.car.slipRear = drift * 0.9;
      this.car.slipFront = drift * 0.4;
      this.car.wheelSlip = drift;
      this.car.bodySlip = A.slip;
      // the rears are the ones laying rubber; the fronts are still steering
      this.car.w2slipRatio = drift * 0.82;
      this.car.w3slipRatio = drift * 0.82;
      this.car.w0slipRatio = drift * 0.16;
      this.car.w1slipRatio = drift * 0.16;
      // ...and the hands, which are posed from the steering angle
      this.car.steer = M.clamp(-A.slip * 0.9 + bend * 0.5, -0.33, 0.33);
      this.car.steerVisual = this.car.steer;
      this.car.counterSteering = (A.slip * this.car.steer < 0) ? 1 : 0;
      this.car.roadY = p.y || 0;
      // lying along the grade, not level to the world
      const back = this.track.at(Math.max(0, this.distance - 6), {});
      const ahead = this.track.at(Math.min(this.track.length - 2, this.distance + 6), {});
      this.car.roadPitch = -Math.atan2((ahead.y || 0) - (back.y || 0), 12);
      this.car.roll = A.roll;
      const air = this.attractAir(dt, reel, p.y || 0);
      this.car.y = (p.y || 0) + (this.car.lift || 0) + air.height;
      this.car.pitch = air.pitch;
      this.car.speed = A.speed;
      this.car.rpm = M.clamp(0.34 + A.speed / 110 + A.boost * 0.2, 0, 1);
      this.car.gear = A.boost > 0.5 ? 6 : 5;
      this.car.boosting = A.boost > 0.45;
      this.car.boost = 0.2 + A.boost * 0.8;
      /* ...AND IT LEAVES SOMETHING BEHIND. The particle system is stepped with
         emission ON here, which nothing else on a menu screen does - every
         other held screen settles it instead, see settleFx. Without this the
         title car has no reheat, no trail and no grit: it is the one shot in
         the game where the car is the subject and it was the only one with
         nothing coming off it. */
      if (this.fx) this.fx.update(dt, this.car, true);
      this.updateAtmosphere(dt);
      this.attractCamera(dt, shot, air.height > 0.05);
    }

    /* THE ATTRACT CAMERA.
     *
     * The menu used to run the chase camera, which is the right camera for
     * driving and the wrong one for watching: it sits at a fixed distance
     * behind the car and shows the same three-quarter view of its own boot lid
     * for as long as the menu is open. This cuts.
     *
     * The marks are in ATTRACT_SHOTS and the running order is on each reel
     * entry. Two rules on top of the running order, and both are what a person
     * with a camera would do:
     *
     *   a CUT re-marks from scratch - no sweep from the last position, which
     *   is the difference between an edit and a camera being carried;
     *   between cuts the mark DAMPS and DOLLIES, so a held shot breathes
     *   rather than freezing.
     */
    attractCamera(dt, shot, airborne) {
      const car = this.car;
      const s = this.distance;
      let name = 'chase';
      if (shot && shot.shots) {
        for (const m of shot.shots) { if (s >= m[0]) name = m[1]; }
      }
      /* A car in the air is the shot, whatever the running order said. It only
         ever overrides UP - a launch mark already in place stays. */
      if (airborne && name !== 'launch' && name !== 'detail') name = 'flank';
      const S = ATTRACT_SHOTS[name] || ATTRACT_SHOTS.chase;

      const key = (shot ? shot.name : '') + '/' + name;
      if (key !== this.attractShotKey) {
        this.attractShotKey = key;
        this.attractShotAge = 0;
        this.attractCut = true;
      }
      this.attractShotAge = (this.attractShotAge || 0) + dt;
      const k = M.clamp(this.attractShotAge / 6.5, 0, 1);

      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
      const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
      const f = S.f + S.dolly[0] * k, side = S.s + S.dolly[1] * k, h = S.h + S.dolly[2] * k;
      const t = this.time;
      const wob = S.hand;
      const eye = [
        car.x + fx * f + rx * side + Math.sin(t * 0.83) * 0.07 * wob,
        car.y + h + Math.sin(t * 1.21 + 1.3) * 0.05 * wob,
        car.z + fz * f + rz * side + Math.cos(t * 0.71) * 0.07 * wob,
      ];
      const target = [car.x + fx * S.tf, car.y + S.th, car.z + fz * S.tf];
      const fov = S.fov - k * 2.0;

      /* --------------------------------------------- HOLDING THE SHOT --
       *
       * WHAT A HELD SHOT IS DAMPING, AND WHAT IT IS NOT.
       *
       * Every mark above is written RELATIVE TO THE CAR - so many units
       * ahead of it, so many to its side - and the car is doing 55 units a
       * second. Damping the mark's WORLD position therefore spends the whole
       * shot chasing a point that is running away from it, and settles at a
       * fixed lag of speed over rate: five units, every frame, for as long as
       * the shot is held.
       *
       * Five units of lag on the eye is a camera slightly further back than
       * it was marked, which nobody would ever notice. Five units of lag on
       * the TARGET is the camera pointing five units behind the car, and that
       * is not a small error: on a wide mark it is three degrees, and on
       * `detail` - four metres off the body through a 38 degree lens - it is
       * fifty-nine, which is the whole car out of the frame. Two thirds of
       * every detail shot in the reel was of empty road with a corner of a
       * bumper in it.
       *
       * Matching the two rates does not fix it. They only lag by the same
       * amount while both marks move at the same velocity, and they do not:
       * the eye's mark carries the dolly and the handheld wobble as well as
       * the car.
       *
       * So the OFFSET is what damps, not the position. What a held shot is
       * supposed to smooth is the shot changing - the dolly creeping, the
       * hand wandering, the mark swinging as the car turns under it - and all
       * of that is in the offset. The car's own motion is not something to
       * smooth; it is the thing being filmed. The framing is then exactly
       * what the mark asked for, at every speed, and the breathing is still
       * there because the breathing was never the lag.
       */
      const eo = [eye[0] - car.x, eye[1] - car.y, eye[2] - car.z];
      const to = [target[0] - car.x, target[1] - car.y, target[2] - car.z];
      if (this.attractCut || !this.attractEye) {
        this.attractCut = false;
        this.attractEye = eo.slice();
        this.attractTarget = to.slice();
        this.attractFov = fov;
      } else {
        for (let i = 0; i < 3; i++) {
          this.attractEye[i] = M.damp(this.attractEye[i], eo[i], 9, dt);
          this.attractTarget[i] = M.damp(this.attractTarget[i], to[i], 12, dt);
        }
        this.attractFov = M.damp(this.attractFov, fov, 5, dt);
      }
      V3.set(this.eye, car.x + this.attractEye[0], car.y + this.attractEye[1],
        car.z + this.attractEye[2]);
      V3.set(this.target, car.x + this.attractTarget[0], car.y + this.attractTarget[1],
        car.z + this.attractTarget[2]);

      /* NEVER FILM FROM UNDER THE ROAD, and the road under the LENS is not the
         road under the car. The reel crosses a twenty-one unit bore bypass and
         six of Chapter 7's plateaus, and the wide marks stand fifteen units off
         the racing line and twenty-six behind it - so a floor taken from the
         car's own arc length is the wrong floor by a whole plateau, which is
         how the crane on the elevated deck ended up inside it.

         The eye is projected onto the road and the floor comes from where it
         actually is. One projection a frame, hinted off the car, so it is the
         windowed search rather than a sweep.

         AFTER the damp, not before it: a clamp applied to the mark is a clamp
         the smoothing can then undo, and a lens that dips under a deck for a
         quarter of a second is a lens that was never clamped at all. */
      const pr = this.track.project(this.eye[0], this.eye[2], s);
      const cp = this.track.at(pr.s, this._attractProbe || (this._attractProbe = {}));
      const floor = (cp.y || 0) + 0.55;
      if (this.eye[1] < floor) {
        this.eye[1] = floor;
        this.attractEye[1] = floor - car.y;
      }

      V3.set(this.up, 0, 1, 0);
      this.fov = this.attractFov;
      this.camS = s;
      this.camTunnel = (cp.tunnel
        && !(global.NR.onOverpass && global.NR.onOverpass(s))) ? 1 : 0;
    }

    /* The climb and the flight, for a car nothing is simulating.
     *
     * It mirrors `Vehicle::update_air` in the core exactly where it matters:
     * the height over the incline is the driven profile, the launch speed is
     * that profile's own derivative rather than a number picked to look right,
     * and the flight is held in ABSOLUTE height so a car that leaves the lip of
     * MIRAGE CIRCUIT's bore bypass falls the whole twenty-one units to the
     * road below rather than following the road down. */
    attractAir(dt, reel, roadY) {
      const A = global.NR.AIR || { g: 27, pitchAcc: 0.85, pitchMax: 0.85 };
      const s = this.distance;
      let state = reel.air;

      if (!state || !state.flying) {
        /* ON THE STRUCTURE? The ramps are full width, so arc length decides -
           and a ramp may have a CREST to drive along before it runs out, which
           the menu has to show as a car driving along it rather than as a car
           launching early. Same three-part profile the solver uses; see the
           note above `Ramp` in crates/synx-core/src/vehicle.rs. */
        for (const r of COURSE_RAMPS) {
          const crest = r.crest || 0;
          const foot = r.s - crest - r.len;
          if (s < foot || s > r.s) continue;
          const d = s - foot;
          let height, pitch;
          if (d <= r.len) {
            const u = d / Math.max(1, r.len);
            height = r.h * u * u;
            pitch = Math.atan(2 * r.h * u / r.len);
          } else {
            const v = (d - r.len) / Math.max(1, crest);
            const lip = r.lip === undefined ? r.h : r.lip;
            height = r.h + (lip - r.h) * v;
            pitch = Math.atan((lip - r.h) / Math.max(1, crest));
          }
          reel.air = { flying: false, ramp: r, height, pitch };
          return reel.air;
        }
        /* Past the end of the structure it was on: launch, carrying whatever
           vertical speed the profile was already producing - which off a crest
           is the shallow rise along it rather than the incline. */
        if (state && state.ramp && s > state.ramp.s && state.height > 0.02) {
          const r = state.ramp;
          const crest = r.crest || 0;
          const lip = r.lip === undefined ? r.h : r.lip;
          const rise = crest > 0
            ? (lip - r.h) / crest            // the crest's own slope
            : 2 * r.h / r.len;               // ...or the top of the incline
          reel.air = {
            flying: true, abs: roadY + state.height,
            v: rise * ATTRACT_SPEED, pitchV: 0,
            height: state.height, pitch: state.pitch,
          };
          state = reel.air;
        } else if (state) {
          reel.air = null;
          return { height: 0, pitch: 0 };
        } else {
          return { height: 0, pitch: 0 };
        }
      }

      state.v -= A.g * dt;
      state.abs += state.v * dt;
      state.height = state.abs - roadY;
      // the nose drops, and the drop BUILDS - the same shape the solver uses
      state.pitchV = Math.max(-A.pitchMax, state.pitchV - A.pitchAcc * dt);
      state.pitch += state.pitchV * dt;
      if (state.height <= 0) {
        reel.air = null;
        return { height: 0, pitch: 0 };
      }
      return state;
    }

    updateCamera(dt) {
      const car = this.car;
      /* Level unless something says otherwise. Only the view from inside the
         car leans, and it sets this itself - but it has to be put back, or a
         chase camera inherits whatever roll the driver view left behind. */
      V3.set(this.up, 0, 1, 0);
      /* THE LOOK, DAMPED AND SELF-CANCELLING.
         `lookHold` is how long is left before it starts coming back; while the
         pointer is moving it is refreshed every event, so the camera holds
         where it was put and then returns on its own. SMOOTHING is the rate
         the camera chases the pointer at, and OFF means it does not chase at
         all - it simply is where the pointer put it. */
      if (this.mouseLookOn) {
        this.lookHold = Math.max(0, (this.lookHold || 0) - dt);
        if (this.lookHold <= 0) {
          this.lookYawWant = M.damp(this.lookYawWant || 0, 0, 3.2, dt);
          this.lookPitchWant = M.damp(this.lookPitchWant || 0, 0, 3.2, dt);
        }
        const rate = this.mouseSmooth === undefined ? 14 : this.mouseSmooth;
        if (rate <= 0) {
          this.lookYaw = this.lookYawWant || 0;
          this.lookPitch = this.lookPitchWant || 0;
        } else {
          this.lookYaw = M.damp(this.lookYaw || 0, this.lookYawWant || 0, rate, dt);
          this.lookPitch = M.damp(this.lookPitch || 0, this.lookPitchWant || 0, rate, dt);
        }
      } else if (this.lookYaw || this.lookPitch) {
        // turned off mid-run: unwind rather than snap
        this.lookYaw = M.damp(this.lookYaw, 0, 6, dt);
        this.lookPitch = M.damp(this.lookPitch, 0, 6, dt);
        this.lookYawWant = 0; this.lookPitchWant = 0;
      }
      /* THE TWO VIEWS THAT ARE NOT A BOOM. Both return before the chase rig
         below, because almost none of it applies to them: a camera in the car
         has no distance to damp and no boom to contain, and a drone has no
         reason to shake when the car does. */
      /* The eye is a point in the car, so the car has to be where it is now
         rather than where it was drawn last frame. See poseCar. */
      if (this.car) this.poseCar();
      const view = this.activeCam();
      if (view === 1 && this.povCamera(car, dt)) return;
      if (view === 2) { this.droneCamera(car, dt); return; }
      this.camYaw += M.angDiff(this.camYaw, car.yaw) * (1 - Math.exp(-CAM.rotationDamping * dt));

      this.camHeight = M.damp(this.camHeight, CAM.height, CAM.heightDamping, dt);
      const rush = this.speedRush || 0, limit = this.speedLimitFx || 0;
      const boost = this.boostFx || 0, kick = this.boostKick || 0;
      const mode = this.raceModeFx || 0;
      const dist = CAM.distance * (1 + car.driftAmount * 0.16
        + rush * .012 + limit * .016 + boost * .055 + kick * .012 + mode * .024);
      /* The swing is applied to the CHASE BASIS, not to `camYaw` itself.
         camYaw is an integrator chasing the car's heading; adding to it would
         be fed straight back into the next frame's damping and the camera
         would drift instead of returning. */
      const lookYaw = this.camYaw + (this.lookYaw || 0);
      const fx = Math.sin(lookYaw), fz = Math.cos(lookYaw);
      // impact shake decays over ~0.3 s; boost and rough ground add a tremor
      const hit = (this.shake || 0);
      const windBuffet = rush * .004 + limit * (.008 + .003 * Math.sin(this.time * 19))
        + boost * .015 + kick * .020 + mode * .007;
      const shake = windBuffet
        + hit * hit * 1.6
        + (car.offroad ? Math.min(0.22, car.speed * 0.003) : 0);
      const buffetX = (Math.sin(this.time * 31.0) + Math.sin(this.time * 47.0) * .45) * shake;
      const buffetY = (Math.sin(this.time * 37.0 + 1.7) + Math.sin(this.time * 23.0) * .35) * shake * .55;
      const targetAhead = 7.0 + rush * .6 + limit * .9 + boost * 1.7 + mode * .8;

      /* THE CAMERA HAS TO STAY IN THE SAME ROOM AS THE CAR.
       *
       * `dist` is how far back the chase camera would like to be, and until
       * now it simply went there. Inside a tunnel that is wrong in a way that
       * is impossible to miss: stop the car a few metres past a portal - which
       * is exactly what a crash does - and the camera is left standing OUTSIDE
       * the bore. Back-face culling is off (the imported meshes and the
       * generated road disagree on winding), so the tunnel shell does not
       * even hide it: you look straight through the wall at the country
       * outside, with the car in a lit hole in the middle of it.
       *
       * containCamera returns the distance the camera may actually have. It
       * is damped rather than applied raw, because a boom arm that snaps in
       * on the frame a portal passes reads as a cut. */
      const want = this.containCamera(car, dist);
      if (this.camPull === undefined) this.camPull = want;
      // pulling IN is urgent (something is about to be in the way); letting
      // back out is a recovery and can take its time
      this.camPull = M.damp(this.camPull, want, want < this.camPull ? 26 : 4.5, dt);
      const held = Math.min(dist, this.camPull);

      /* The look's vertical half. It raises the BOOM rather than tilting the
         camera, because a chase camera that pitches leaves the car sliding up
         and down the frame; one that rises looks down at it, which is what the
         player is asking for when they push the mouse forward. The road-height
         floor a few lines below still applies, so looking down cannot put the
         eye through the tarmac. */
      const lookLift = (this.lookPitch || 0) * 9.0;
      V3.set(this.eye,
        car.x - fx * held + Math.cos(this.camYaw) * buffetX,
        car.y + this.camHeight + buffetY + lookLift,
        car.z - fz * held);
      V3.set(this.target,
        car.x + fx * targetAhead - Math.cos(this.camYaw) * buffetX * .25,
        car.y + CAM.height * CAM.targetHeightRatio + 0.9 + buffetY * .35,
        car.z + fz * targetAhead);

      /* ...and it must not be under the road either.
       *
       * The eye is placed at the CAR's height plus the boom. Over a crest, or
       * anywhere the grade changes - six plateaus on Chapter 7's expressway,
       * the ash country's climbs, the Forge's ramps - the road twelve units
       * behind the car is not at the car's height, and the camera ends up
       * inside the tarmac looking at the underside of the world. */
      const camS = this.cameraArc(car, held);
      const cp = this.track.at(camS, this._camProbe || (this._camProbe = {}));
      this.camS = camS;
      this.camTunnel = (cp.tunnel &&
        !(global.NR.onOverpass && global.NR.onOverpass(this.camS))) ? 1 : 0;
      const floor = (cp.y || 0) + 1.15;
      if (this.eye[1] < floor) this.eye[1] = floor;

      this.fov = M.damp(this.fov,
        Math.min(94, CAM.baseFov + this.speedFx * 2.5
          + rush * 1.6 + limit * 2.0 + boost * 8.0 + kick * 1.4 + mode * 3.2), 4.8, dt);
      this.fov += (this.shake || 0) * 2.0;
      // a slow-motion beat pinches in, which is what says "look at this"
      this.fov -= (this.slowFov || 0) * 9.0;
    }


    /* ------------------------------------------------------ the cameras --
     *
     * CHASE is above; these are the other two. Both are written against the
     * CAR's own basis rather than against `camYaw`: that integrator exists to
     * lag the car's heading, which is exactly what a camera bolted to the car
     * must not do.
     */

    /* THE OPENING MOVE.
     *
     * Six seconds, from a low three-quarter shot ahead of the car into the
     * exact chase pose the title screen sits in. The point of it is that it
     * is not a cut-scene: it is this camera, in this world, with every pass
     * the renderer has running - so what the player is shown in the first
     * six seconds is the game rather than a trailer of it.
     *
     * HOW IT LANDS WITHOUT A SNAP, which is the only hard part. The chase
     * camera runs to completion first, every frame, exactly as it always
     * does - so all of its damped state is warm and correct throughout. This
     * then drags the result toward a scripted pose by a weight that falls to
     * zero. At the end the weight IS zero, so the camera is not blended into
     * the chase pose, it simply is the chase pose, and there is no frame
     * where control changes hands.
     *
     * The scripted half is a single orbit: an angle that swings two thirds of
     * the way round, a distance that opens from seven units to the chase
     * boom, and a height that climbs. One curve, eased once, drives all
     * three - which is what keeps it reading as one move rather than three
     * parameters animating at the same time.
     */
    startIntro() {
      this.intro = { at: performance.now() };
      // the cutscene has begun, so the score may start with it
      this.musicHeld = false;
      this.onMusic();
      this.introReveal = 0;
      /* Retyped, so the rows arrive letter by letter as the shot lands
         rather than being present the moment they become visible. The
         typewriter is the menu's own - see the TYPE_CPS loop in update -
         so this is only a matter of putting it back to the start. */
      for (const it of this.menuItems) it.typed = 0;
    }

    /** Settle everything at once - the skip, and the end of the move. */
    endIntro() {
      this.intro = null;
      this.introReveal = 1;
    }

    introCamera() {
      const I = this.intro, car = this.car;
      if (!car) { this.endIntro(); return; }
      /* SIX SECONDS OF WALL CLOCK, NOT SIX SECONDS OF SIMULATION.

         The frame loop clamps dt to 50 ms so a stall cannot teleport the
         car through a wall, and it scales it for slow motion. Both are right
         for the simulation and both are wrong for a cinematic: on a machine
         drawing twenty frames a second, accumulating clamped dt makes this
         move take eighteen seconds, and it would run in slow motion if the
         player happened to trigger a dilation on the way in.

         A scripted shot is a length of time, so it is measured against the
         clock. It is exactly six seconds on every machine, which is the only
         behaviour anyone can design a shot around. */
      const LEN = 6.0;
      const k = Math.min(1, (performance.now() - I.at) / (LEN * 1000));
      /* Smootherstep rather than smoothstep: its second derivative is zero
         at both ends too, so the move has no perceptible start or stop - it
         is already going when you notice it and it is already stopped when
         the menu arrives. */
      const e = k * k * k * (k * (k * 6 - 15) + 10);

      // the scripted pose: one orbit, opening out and climbing
      const ang = car.yaw + Math.PI * (0.72 - 0.72 * e);
      const dist = 7.0 + (CAM.distance - 7.0) * e;
      const high = 1.15 + (CAM.height - 1.15) * e;
      const hx = car.x + Math.sin(ang) * dist;
      const hz = car.z + Math.cos(ang) * dist;
      const hy = car.y + high;

      /* The weight the scripted pose still has. It is gone by 0.86 rather
         than at 1.0, so the last fifth of the move is the chase camera on
         its own and the player is already in the shot they will be steering
         from before the rows appear. */
      const w = 1 - Math.min(1, e / 0.86);
      const wq = w * w * (3 - 2 * w);
      this.eye[0] += (hx - this.eye[0]) * wq;
      this.eye[1] += (hy - this.eye[1]) * wq;
      this.eye[2] += (hz - this.eye[2]) * wq;
      // aimed at the car itself for the low half of the move, and at
      // whatever the chase camera is looking at by the end of it
      this.target[0] += (car.x - this.target[0]) * wq;
      this.target[1] += (car.y + 0.9 - this.target[1]) * wq;
      this.target[2] += (car.z - this.target[2]) * wq;
      // a longer lens on the hero shot, opening to the chase field of view
      this.fov += (52 - this.fov) * wq;

      /* The interface assembles over the last third. Squared, so it is still
         nearly invisible at the two-thirds mark and arrives quickly at the
         end - a linear fade over two seconds reads as a slow menu. */
      const r = Math.max(0, (e - 0.62) / 0.38);
      this.introReveal = Math.min(1, r * r);
      if (k >= 1) this.endIntro();
    }

    /* THE STATE IS THE ONE PLACE EVERY SCREEN CHANGE PASSES THROUGH.
     *
     * There are eighteen states and they are assigned from five files, so
     * anything that has to happen on every transition has to happen here or
     * it will not happen on all of them. Two things do:
     *
     *   THE INPUT GATE closes, so the press that caused this change cannot
     *   also be read by whatever is now on screen. See NR.Gate.
     *
     *   THE RUN LATCH is maintained. Which camera view is in force cannot be
     *   decided by reading the state directly, because the state legitimately
     *   flips to "story" and back during a chapter - a dialogue beat, a
     *   telemetry card - and a view chosen off the state alone therefore
     *   flickered between the driver view and the chase camera, several times a
     *   second, for the whole of that chapter. A run is a thing with a start
     *   and an end, so it is latched at both rather than sampled per frame.
     */
    get state() { return this._state; }

    set state(v) {
      if (v === this._state) return;
      this._state = v;
      if (NR.Gate) NR.Gate.lock();
      if (v === 'countdown' || v === 'racing' || v === 'freeroam') this.inRun = true;
      else if (MENUS[v]) this.inRun = false;
    }

    /** The view actually in force this frame. `camMode` is the preference;
        this is what the renderer and the camera are allowed to use. */
    activeCam() {
      // the finish roll is a cutscene and owns its own camera
      if (this.raceOver || MENUS[this._state]) return 0;
      return this.inRun ? (this.camMode || 0) : 0;
    }

    /** Cycle CHASE -> DRIVER -> DRONE, and say which. */
    cycleCamera() {
      /* Not on a menu. The view would be stored and announced and nothing
         on screen would change, because a menu is drawn from the chase
         camera whatever the preference says - see DRIVING. */
      if (!this.inRun || this.raceOver || MENUS[this._state]) return this.camMode || 0;
      this.camMode = ((this.camMode || 0) + 1) % CAM_MODES.length;
      /* The look-around offsets are the chase rig's, and they mean something
         different in a fixed view - a driver whose head starts eight degrees
         off axis because the mouse was moved a minute ago is a driver who
         looks broken. */
      this.lookYaw = 0; this.lookPitch = 0;
      this.lookYawWant = 0; this.lookPitchWant = 0;
      this.camPull = undefined;
      if (this.hud && this.hud.toast) this.hud.toast('VIEW // ' + CAM_MODES[this.camMode], '#39e6ff');
      writeNum(CAM_KEY, this.camMode);
      return this.camMode;
    }

    /** True while the camera is the driver's own eye. */
    inCar() { return this.activeCam() === 1; }

    /* THE CAR'S OWN TRANSFORM, BUILT BEFORE ANYTHING READS IT.
     *
     * THIS IS WHY THE FIRST-PERSON VIEW DRIFTED BACKWARDS AT SPEED.
     *
     * The matrix used to be built in draw(), which is the right place for
     * drawing and the wrong place for everything else: the camera is decided
     * in update(), which runs first, so the eye was being put through LAST
     * frame's transform. Standing still that is invisible. At a hundred and
     * twenty miles an hour the car covers about a unit and a quarter between
     * frames, so the eye sat more than a car length behind where the driver
     * actually was - outside the bodywork, looking at their own dashboard
     * from over its back edge.
     *
     * And it was not a steady lag, which is what made it read as a fault
     * rather than as an offset: the distance is a frame TIME, so every
     * skipped or long frame moved the eye somewhere else. That is the
     * flicker between the inside of the car and the outside of it.
     *
     * Built here, once, before the camera and the renderer both read it.
     */
    poseCar() {
      M4.trs(this.model, this.car.x, this.car.y, this.car.z,
        this.car.yaw, (this.car.pitch || 0) + (this.car.roadPitch || 0), this.car.roll);
      /* Chapter 6's baler flattens the car. A director sets carSquash and the
         body scales with it, in its own axes, so the crush is the actual car
         being crushed rather than a cut to a prop. Nothing else writes it. */
      const sq = this.carSquash;
      if (sq) {
        for (let i = 0; i < 3; i++) this.model[i] *= sq[0];
        for (let i = 4; i < 7; i++) this.model[i] *= sq[1];
        for (let i = 8; i < 11; i++) this.model[i] *= sq[2];
        this.model[13] -= (1 - sq[1]) * 0.55;
      }
      return this.model;
    }

    /* THE DRIVER.
     *
     * The eye is the one in the head of the figure sitting in the seat, and
     * it is computed on the core side - see `pov` in crates/synx-core/src/
     * driver.rs. That is not an arbitrary place to put it: it is the same
     * arithmetic, against the same transform, as the figure it belongs to,
     * and keeping the two together is what stops the camera drifting away
     * from the head it is supposed to be inside. Move the driver and the
     * view moves with them, because one is derived from the other.
     *
     * WHAT IS LEFT ON THIS SIDE is everything that is presentation rather
     * than geometry: how much the head shakes, how the lens opens with
     * speed, and how far a glance is allowed to turn it. The core is handed
     * a yaw and a pitch and hands back an eye and a point to look at.
     *
     * THIS REPLACED A BONNET CAMERA, which sat out on the nose looking back
     * over the car. That was a workaround for a first-person view that could
     * not be built: the first attempt put the eye at a guessed point inside
     * a cabin that was not to human scale, saw almost nothing, and was moved
     * outside where there was at least something to look at. The reason has
     * gone - the figure is measured against the shipped body now, so there
     * is a correct answer to where the eyes are and it does not have to be
     * guessed at all.
     */
    povCamera(car, dt) {
      /* The free-look turns the head, and the car turns the body under it.
         Composed here because the input belongs to this side; the core is
         given the answer rather than the parts. */
      const yaw = car.yaw + (this.lookYaw || 0);
      const pitch = (car.pitch || 0) + (car.roadPitch || 0)
        + (this.lookPitch || 0) * 0.9 + POV_PITCH;
      const cam = NR.camPov ? NR.camPov(this.model, yaw, pitch) : null;
      /* No core, no eye. Rather than invent one, say so and let the chase
         rig below run: a first-person view that cannot be computed should
         degrade to a camera that works, not to a camera at the origin. */
      if (!cam) return false;

      /* Two centimetres of head shake at speed, and none at a standstill. A
         fixed camera is the one that most needs it: with no boom to absorb
         anything, a perfectly still eye at two hundred is what makes a fixed
         view read as a still image with a road texture scrolling past it. */
      const rush = this.speedRush || 0, boost = this.boostFx || 0;
      const j = (this.shake || 0) * 0.9 + rush * 0.004 + boost * 0.010
        + (car.offroad ? Math.min(0.05, car.speed * 0.0009) : 0);
      const t = this.time;
      V3.set(this.eye,
        cam[0] + Math.sin(t * 33.0) * j,
        cam[1] + Math.sin(t * 41.0 + 1.1) * j * 0.7,
        cam[2] + Math.cos(t * 29.0) * j);
      V3.set(this.target, cam[3], cam[4], cam[5]);
      /* ...and the view leans with the body. See the note in driver.rs: an
         interior is bolted to the car, so a camera inside one that stays
         level makes the whole cabin rotate about the frame. */
      V3.set(this.up, cam[6], cam[7], cam[8]);

      this.camS = this.cameraArc(car, 0);
      const cp = this.track.at(this.camS, this._camProbe || (this._camProbe = {}));
      this.camTunnel = (cp.tunnel &&
        !(global.NR.onOverpass && global.NR.onOverpass(this.camS))) ? 1 : 0;
      /* A tighter lens than the chase view. From inside, a wide angle bends
         the pillars away at the edges and puts the horizon in the middle of
         a very empty frame. It still opens up with speed - that is the one
         cue this view cannot get from a boom it does not have. */
      this.fov = M.damp(this.fov,
        Math.min(88, 62 + this.speedFx * 2.2 + rush * 1.4 + boost * 7.0
          + (this.raceModeFx || 0) * 3.0), 4.8, dt);
      this.fov += (this.shake || 0) * 2.0;
      this.fov -= (this.slowFov || 0) * 9.0;
      return true;
    }

    /* THE DRONE.
     *
     * Straight up and a little behind, looking down. Deliberately the calmest
     * of the three: no shake, no speed FOV, and the yaw comes off the damped
     * `camYaw` rather than the car - a map that snapped round every time the
     * car twitched would be unreadable, which is the one thing this view is
     * for.
     */
    droneCamera(car, dt) {
      this.camYaw += M.angDiff(this.camYaw, car.yaw)
        * (1 - Math.exp(-CAM.rotationDamping * 0.55 * dt));
      const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
      /* WHERE THE CAR SITS IN THE FRAME, which is what these six numbers are
         really choosing and what the first pass got wrong.

         The eye is up and behind, the aim point is up the road, so the car is
         always BELOW the view axis by the difference of two angles: the one
         down to the car, atan(lift / back), and the one down to the aim point,
         atan(lift / (back + ahead)). The old numbers - lift 51, back 16, ahead
         40 at speed - made that difference 31 degrees against a 34 degree half
         angle, which put the car within a whisker of the bottom edge of the
         frame and therefore behind the boost bar.

         These make it 17 degrees at every speed: half way between the centre
         of the frame and the bottom of it, clear above the HUD band, with the
         road ahead still filling the two thirds above the car. The distance to
         the car is deliberately unchanged - 52 units at speed against the old
         53 - so the car is the same size on screen as before. It is the same
         shot from a lower, further-back drone, not a closer one.

         All three still rise with speed, because what this view is worth is
         how far up the road it can see and that has to grow with how fast the
         road is arriving. They rise in proportion, which is what holds the 17
         degrees steady from a standstill to two hundred. */
      /* A ROUTE WITH A ROOF CAPS THE CLIMB. See `droneCeiling` in LEVELS: on
         Aurora Forge the camera was going straight through the production
         hall's roof and filming it. */
      const ceil = (this.level && this.level.droneCeiling) || Infinity;
      const lift = Math.min(ceil, 27 + M.clamp(car.speed, 0, 90) * 0.32);
      /* Under a roof the camera has to come BACK as well as stay down, or a
         near-vertical view from thirteen units is looking at the car's roof
         from so close that none of the road around it is in shot - which is
         the one thing this view exists to show. */
      const back = ceil < 20 ? 13 : 12.5 + M.clamp(car.speed, 0, 90) * 0.18;
      this.droneLift = M.damp(this.droneLift === undefined ? lift : this.droneLift, lift, 2.2, dt);
      this.droneBack = M.damp(this.droneBack === undefined ? back : this.droneBack, back, 2.2, dt);
      V3.set(this.eye,
        car.x - fx * this.droneBack + (this.lookYaw || 0) * 8,
        car.y + this.droneLift,
        car.z - fz * this.droneBack);
      /* Aimed a long way up the road rather than at the car. Looking straight
         down puts the car in the middle of a frame with no information in it;
         leading it is what turns the height into notice. */
      /* How far up the road the camera leads the car - see the note above. A
         roofed route is a fixed rig rather than a scaling one: the lift cannot
         grow, so neither may the set-back or the lead, or the same climb in
         speed that used to lift the camera would instead flatten it into a
         very distant chase. Nine and thirteen against a capped 13.6 of lift
         come out at the same 16 degrees the open figures do. */
      const ahead = ceil < 20 ? 9 : 11 + M.clamp(car.speed, 0, 90) * 0.15;
      V3.set(this.target,
        car.x + fx * ahead,
        car.y + 0.6,
        car.z + fz * ahead);
      this.camS = this.cameraArc(car, 0);
      const cp = this.track.at(this.camS, this._camProbe || (this._camProbe = {}));
      /* NEVER IN A TUNNEL. Twenty-six units up inside a nineteen-unit bore is
         a camera in the rock, so the drone drops to a low chase inside one and
         the atmosphere is told it is not in the open. */
      this.camTunnel = (cp.tunnel &&
        !(global.NR.onOverpass && global.NR.onOverpass(this.camS))) ? 1 : 0;
      if (cp.tunnel) {
        this.eye[1] = Math.min(this.eye[1], (cp.y || 0) + 9.0);
      }
      this.fov = M.damp(this.fov, 68, 4.0, dt);
    }

    /* Where the camera is, as an arc length.
     *
     * The boom hangs `back` units behind the car along the car's own heading,
     * which through a corner is not the same as `back` units along the road -
     * but it is within a few per cent of it, and every consumer here (the
     * tunnel test, the road height, the portal search) is sampling a quantity
     * that varies slowly along the route. Projecting the eye properly would
     * cost a search through the centreline every frame to move an answer by
     * less than one sample. */
    cameraArc(car, back) {
      const s = (car.sTrack || 0) - back;
      return M.clamp(s, 0, this.track.length - 2);
    }

    /* How far back the boom may go, given what is around the car.
     *
     * Two containments, both of which return a distance rather than moving the
     * camera, so the caller can damp one number instead of un-picking three.
     *
     *   THE PORTAL. If the car is inside a bore, the camera has to be inside
     *   it too. The entry is found by walking back along the route until the
     *   tunnel flag clears - at most a couple of hundred units, in eight-unit
     *   steps, because that is the resolution the flag is authored at - and
     *   the boom is cut so the eye sits a margin inside the mouth. Coming out
     *   the other end needs no help: a camera still in the tunnel while the
     *   car is out is looking THROUGH the portal, which is the shot.
     *
     *   THE CEILING. A bore is 19.4 units high at the crown and much less at
     *   the springline, so a boom that is fine on open road can put the eye in
     *   the shell on a bend. The lateral offset of the eye is bounded by the
     *   arc it subtends at this distance, so shortening the boom is also what
     *   pulls it back toward the centre of the bore.
     */
    containCamera(car, dist) {
      const MIN = 3.4;                       // never closer than the boot lid
      if (!this.track) return dist;
      const s = car.sTrack || 0;
      const here = this.track.at(M.clamp(s, 0, this.track.length - 2),
        this._camHere || (this._camHere = {}));
      if (!here.tunnel) return dist;

      const probe = this._camBack || (this._camBack = {});
      let entry = s - dist;
      for (let d = 0; d <= dist + 24; d += 8) {
        const q = M.clamp(s - d, 0, this.track.length - 2);
        if (!this.track.at(q, probe).tunnel) { entry = q; break; }
        entry = q;
      }
      /* Ten units inside. Less and the eye sits in the portal ring itself,
         which is a lit band across the whole frame; more and a short tunnel
         would hold the camera on the car's rear bumper for its whole length. */
      const allowed = s - (entry + 10);
      return M.clamp(Math.min(dist, allowed), MIN, dist);
    }

    // ------------------------------------------------------------- draw --
    fullscreenTri() {
      const gl = this.gl;
      gl.bindVertexArray(this.emptyVAO);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    blit(prog, target, setup) {
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      /* The null target is the CANVAS, and since the render scale was split
         off the backing store the canvas is not the same size as the render
         targets. Using this.w here drew the finished frame into the bottom-left
         corner of a native-sized canvas at every setting below NATIVE. */
      gl.viewport(0, 0,
        target ? target.w : (this.outW || this.w),
        target ? target.h : (this.outH || this.h));
      gl.useProgram(prog.prog);
      if (setup) setup(prog.u);
      this.fullscreenTri();
    }

    draw(dt) {
      const gl = this.gl;
      if (this.state === 'loading' || !this.scene.ready) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.outW || this.w, this.outH || this.h);
        gl.clearColor(0.02, 0.005, 0.06, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        this.hud.draw(this, dt);
        return;
      }

      /* The frame's census, zeroed here because this is the one place that
         knows a frame has started.
         It counts every draw that goes through Scene.drawPart - the world, the
         dressing, both chapter worlds, the cars, the kit - which includes the
         six reflection-probe faces and excludes the shadow cascades, because
         those run through their own depth-only program. That is the number
         that decides whether a route is affordable. */
      this.scene.lastDrawCalls = this.scene.drawCalls;
      this.scene.lastMatUploads = this.scene.matUploads;
      this.scene.lastCulled = this.scene.culled;
      this.scene.drawCalls = 0;
      this.scene.matUploads = 0;
      this.scene.culled = 0;
      /* Whichever mode is spending raceMode, published for the one widget that
         draws it. Here rather than in update(), because every director has had
         its say by the time a frame is drawn and none of them has by the time
         the frame is updated. */
      this.syncRaceMode();

      /* See CAM.nearBonnet: from the nose the car's own bodywork is nearer than
         the chase view's near plane, and would be clipped away. */
      /* THE OPENING MOVE, APPLIED LAST.

         Here rather than in update(), because update() is a state machine
         with a dozen branches and its own return out of most of them - and
         a camera move hung off any single branch is a camera move that stops
         the moment the game is in some other state. This is the one place
         every frame passes through, whatever is happening. */
      if (this.intro) this.introCamera();
      const near = this.activeCam() === 1 ? CAM.nearPov : CAM.near;
      this.camNear = near;   // read by tools/smoke.js --probe bonnet
      M4.perspectiveLH(this.proj, this.fov * Math.PI / 180, this.w / this.h, near, CAM.far);
      this.nearPlane = near;
      /* Sub-pixel jitter for the temporal resolve. Halton(2,3) over eight
         frames covers the pixel evenly without the clumping a random offset
         gives, and the offset is in NDC, so it is two pixels wide over the
         whole frame regardless of resolution. */
      if (this.useTaa) {
        this.frameIndex = (this.frameIndex + 1) & 7;
        const jx = (M4.halton(this.frameIndex + 1, 2) - 0.5) * 2 / this.w;
        const jy = (M4.halton(this.frameIndex + 1, 3) - 0.5) * 2 / this.h;
        M4.jitter(this.proj, jx, jy);
      }
      M4.lookAt(this.view, this.eye, this.target, this.up);
      M4.mul(this.vp, this.proj, this.view);
      M4.invert(this.invVP, this.vp);

      /* THE SHADOW PASS.
       *
       * Before anything else, because it owns the framebuffer and the viewport
       * while it runs. Three depth-only views of the world from the key light,
       * which the surface shader then compares against - see the note above
       * Scene.initShadows for why this is the single biggest thing separating
       * the old picture from this one. */
      if (this.useShadows) {
        this.scene.renderShadows(this.eye, this.target, this.distance);
        gl.viewport(0, 0, this.w, this.h);
      }
      /* THE LOCAL REFLECTION PROBE.
         Two of its six faces a frame, so it is complete every third one. It
         has to run before the scene pass for the same reason the shadows do:
         it owns the framebuffer while it renders. */
      if (this.useProbe) {
        this.scene.probeHalf = (this.level && this.level.roadHalf ? this.level.roadHalf : 20) + 16;
        this.scene.probeTunnel = this.tunnel;
        /* THE WHOLE CUBE, EVERY FRAME.
            Amortising it over six frames made the reflections visibly trail
            the car, because the six faces were then taken from six different
            places. See Scene.renderProbe. */
        this.scene.renderProbe([this.car.x, this.car.y, this.car.z], this.distance, 6);
        gl.viewport(0, 0, this.w, this.h);
      }

      const MRT = [gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1];
      const COLOR_ONLY = [gl.COLOR_ATTACHMENT0, gl.NONE];

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtScene.fb);
      if (gl.drawBuffers) gl.drawBuffers(MRT);
      gl.viewport(0, 0, this.w, this.h);
      gl.clearColor(0.02, 0.01, 0.05, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // No back-face culling: the imported meshes and the generated road
      // disagree on winding once projected, so culling either way makes part of
      // the scene vanish.
      gl.disable(gl.CULL_FACE);
      gl.depthFunc(gl.LEQUAL);

      // skybox first, then the world over it
      this.scene.drawSky(this.invVP, this.tunnel, this.eye);

      const lf = this.levelFog || [1, 1, 1];
      const fogTint = this.tunnel > 0.5 ? [0.35, 0.5, 0.7] : lf;
      this.scene.bind(this.vp, this.eye, {
        tunnel: this.tunnel,
        fogDensity: this.fogDensity === undefined ? FX.fogDensity : this.fogDensity,
        fogTint,
        // which stretch of road the camera is on, so the dressing can draw the
        // chunks it can see instead of all eighty kilometres of them
        camS: this.distance,
      });
      this.scene.drawWorld(this.eye, CAM.far);

      /* The cars carry their own key light. The fill is tinted toward the
         route's own neon, so a car on the coast road and a car in the city
         are lit by the places they are in rather than by the same studio. */
      const lp = this.runtimePalette || (this.level && this.level.palette) || {};
      const fc = lp.edge || [0.30, 0.60, 0.85];
      this.scene.fillCol = this.scene.level5BossLight || [
        0.40 + fc[0] * 0.55, 0.48 + fc[1] * 0.55, 0.62 + fc[2] * 0.45,
      ];
      this.scene.setBodyLight(this.eye, this.target, 1);

      // the rival first, so the player's own car composites over it
      if (this.rival && !this.storyHideRival && this.state !== 'menu' && this.state !== 'controls') {
        M4.trs(this.rivalModel, this.rival.x, this.rival.y, this.rival.z,
          this.rival.yaw, (this.rival.pitch||0)+(this.rival.roadPitch||0), this.rival.roll);
        /* R-IX // IMPOSSIBLE is not a difficulty label with a blue car behind
           it. The Free Roam terminal offers "the one that hunted you" as the
           top opponent, and it was fielding the ordinary rival livery - so the
           car the campaign spends seven chapters building up arrived on the
           open road as a repaint of the car you beat in chapter two. It gets
           the prototype's own shell, aero kit and momentum drive, which is the
           same body Chapter 7 fields and the same one Chapter 5 hands over. */
        const kit = this.raptorRival();
        if (kit) {
          kit.draw(this.rivalModel, this.raceModeActive ? 0.7 : 0.22,
            { damage: this.rivalDamage, brake: lampOf(this.rival) });
          if (this.scene.drivers !== false) {
            if (!this.scene.driverFigure) this.scene.driverFigure = new global.NR.DriverFigure(this.scene);
            this.scene.driverFigure.draw(this.rivalModel, 'raptor', this.rival.steer || 0);
          }
        } else {
            this.scene.drawCar(this.rivalModel, true,
            { livery: 'rival', steer: this.rival.steer || 0, damage: this.rivalDamage,
              brake: lampOf(this.rival), ...wheelsOf(this.rival) });
        }
      }
      /* Story Chapter 4 fields Nova and Kael beside the normal Player/Ryker
         pair. Each additional entrant is another
         normal Vehicle driven by another normal Driver; this loop only adds
         their already-updated bodies to the scene. */
      if (this.storyExtraRacers && this.state !== 'menu' && this.state !== 'controls') {
        for (const e of this.storyExtraRacers) {
          if (!e || !e.car) continue;
          e._model = e._model || M4.make();
          M4.trs(e._model, e.car.x, e.car.y, e.car.z,
            e.car.yaw, (e.car.pitch||0)+(e.car.roadPitch||0), e.car.roll);
          this.scene.drawCar(e._model, true,
            { livery: 'rival', steer: e.car.steer || 0, brake: lampOf(e.car),
              ...wheelsOf(e.car) });
        }
      }
      /* Chapter 5's prize prototype is a separate vehicle, not a repaint of
         Ryker's dying street car.  The Level 5 director owns the procedural
         aero/propulsion kit; the renderer only gives it the same physically
         lit car pass and world transform as every other entrant. */
      if (this.storyRaptor && this.scene.level5RaptorKit
          && this.state !== 'menu' && this.state !== 'controls') {
        this.storyRaptorModel = this.storyRaptorModel || M4.make();
        /* Chapter 7 may briefly place the existing R-IX/Ryker render body on
           an authored overpass while its normal physics vehicle approaches
           the merge. This is a pose for the same owned vehicle, never a
           second/fake rival, and it hands back at a matching transform. */
        const r = this.storyRaptorRenderPose || this.storyRaptor;
        M4.trs(this.storyRaptorModel, r.x, r.y, r.z, r.yaw, r.pitch || 0, r.roll || 0);
        /* ...carrying whatever it has been driven into. The finale's R-IX IS
           the rival Vehicle (story.js hides the street body and hands the same
           car to the kit), so the damage it accumulates is the rival's. */
        this.scene.level5RaptorKit.draw(this.storyRaptorModel, this.storyRaptorCharge || 0,
          { damage: this.rivalDamage, brake: lampOf(this.storyRaptor) });
        /* ...and Ryker is in it. The prototype's body comes from the Raptor
           kit rather than from drawCar, so without this the one car the whole
           finale is about is the only empty one on the Grid. */
        if (this.scene.drivers !== false) {
          if (!this.scene.driverFigure) this.scene.driverFigure = new global.NR.DriverFigure(this.scene);
          this.scene.driverFigure.draw(this.storyRaptorModel, 'raptor',
            (this.storyRaptor && this.storyRaptor.steer) || 0);
        }
      }
      this.poseCar();
      /* The player's own car, whole, in every view. The bonnet camera sits on
         the nose looking forward, so everything it can see of the car is meant
         to be seen from outside - there is nothing to hide. */
      this.scene.drawCar(this.model, false,
        { livery: 'player', steer: this.car.steer || 0, damage: this.damage,
          brake: lampOf(this.car),
          // nobody sees the flare of their own lamps from the driving seat
          // from inside, neither the beam flares nor the head this eye is in
          noFlare: this.activeCam() === 1,
          inside: this.activeCam() === 1,
          /* How hard the boost is being asked for, which is what moves the
             button on the wheel. Damped rather than the raw flag: a control
             that snaps to its stop and back in one frame is a control that
             was never pressed by a hand. */
          press: this.boostPress || 0,
          ...wheelsOf(this.car) });

      /* Trails and particles are additive light and must not disturb the
         normal buffer - a smoke puff writing a normal makes the reflection
         pass march against a surface that is not there. */
      if (this.fx) {
        if (gl.drawBuffers) gl.drawBuffers(COLOR_ONLY);
        /* The particles come after the cars and must be occluded by them.
           Every pass before this one restores its own state, but a plume
           drawn in front of the bodywork is the one artefact that is obvious
           and the one that is cheapest to make impossible - so the depth
           function the whole frame was drawn with is re-stated here rather
           than assumed. */
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        this.fx.drawRibbons(this.vp, this.eye);
        this.fx.draw(this.vp, this.view);
        if (gl.drawBuffers) gl.drawBuffers(MRT);
      }

      // ---------------------------------------------------------- post --
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.depthMask(false);

      const sun = this.scene.sunDirection(this.eye);
      const sunWorld = this.scene.sunPos || [0, 6745, 48408];
      const cx = this.vp[0] * sunWorld[0] + this.vp[4] * sunWorld[1] + this.vp[8] * sunWorld[2] + this.vp[12];
      const cy = this.vp[1] * sunWorld[0] + this.vp[5] * sunWorld[1] + this.vp[9] * sunWorld[2] + this.vp[13];
      const cw = this.vp[3] * sunWorld[0] + this.vp[7] * sunWorld[1] + this.vp[11] * sunWorld[2] + this.vp[15];
      let sunU = 0.5, sunV = 0.5, onScreen = 0;
      if (cw > 0) {
        sunU = (cx / cw) * 0.5 + 0.5;
        sunV = (cy / cw) * 0.5 + 0.5;
        // fade the shafts out as the sun leaves the frame, so they cannot snap
        // on and off at the edge
        const fx = Math.max(0, 1 - Math.max(0, Math.abs(sunU - 0.5) - 0.5) * 6);
        const fy = Math.max(0, 1 - Math.max(0, Math.abs(sunV - 0.5) - 0.5) * 6);
        onScreen = fx * fy;
      }

      // 1. screen-space reflections, half res
      if (!this.useSsr) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtSsr.fb);
        gl.viewport(0, 0, this.rtSsr.w, this.rtSsr.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        this.blit(this.pSsr, this.rtSsr, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.tex);
          U.i(gl, u.uScene, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.depthTex);
          U.i(gl, u.uDepth, 1);
          gl.activeTexture(gl.TEXTURE2);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.normTex);
          U.i(gl, u.uNormal, 2);
          U.m4(gl, u.uVP, this.vp);
          U.m4(gl, u.uInvVP, this.invVP);
          U.v3v(gl, u.uCamPos, this.eye);
          U.v2(gl, u.uRes, this.rtSsr.w, this.rtSsr.h);
          U.f(gl, u.uNear, this.nearPlane || CAM.near);
          U.f(gl, u.uFar, CAM.far);
          U.f(gl, u.uTime, this.time);
        });
        /* A marched reflection is point-sampled and jittered, so it arrives
           speckled. Two Gaussian taps resolve it - and since a damp road is a
           rough reflector anyway, softening it is what it should look like. */
        this.blit(this.pDof, this.rtSsrB, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtSsr.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 2.4, 0);
        });
        this.blit(this.pDof, this.rtSsr, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtSsrB.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 0, 2.4);
        });
      }

      // 1b. ambient occlusion, half res, resolved with the same two-tap blur
      if (!this.useAo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtAo.fb);
        gl.viewport(0, 0, this.rtAo.w, this.rtAo.h);
        gl.clearColor(1, 1, 1, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        this.blit(this.pAo, this.rtAoB, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.depthTex);
          U.i(gl, u.uDepth, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.normTex);
          U.i(gl, u.uNormal, 1);
          U.m4(gl, u.uVP, this.vp);
          U.m4(gl, u.uInvVP, this.invVP);
          U.v3v(gl, u.uCamPos, this.eye);
          U.f(gl, u.uNear, this.nearPlane || CAM.near);
          U.f(gl, u.uFar, CAM.far);
          U.f(gl, u.uRadius, FX.aoRadius);
          // LOW asks for less of the same pass rather than a different one, so
          // the two settings differ in slices (uSlices) and in how hard the
          // result is applied.
          U.f(gl, u.uStrength, this.aoQuality === 1 ? 0.72 : 1.0);
          U.f(gl, u.uSlices, this.aoQuality === 1 ? 2.0 : 4.0);
          // a different direction set each frame, so the temporal resolve has
          // something to average rather than a fixed dither burnt into it
          U.f(gl, u.uFrame, this.frameIndex);
        });
        this.blit(this.pDof, this.rtAo, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtAoB.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 1.5, 0);
        });
        this.blit(this.pDof, this.rtAoB, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtAo.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 0, 1.5);
        });
        // rtAoB holds the resolved result; swap so rtAo is what reads out
        const t = this.rtAo; this.rtAo = this.rtAoB; this.rtAoB = t;
      }

      // 2. volumetric fog + inscattering, half res
      if (!this.useVolumetrics) {
        // transmittance 1, no inscatter: the composite reads it as clear air
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.rtVol.fb);
        gl.viewport(0, 0, this.rtVol.w, this.rtVol.h);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        const h = this.scene.head;
        this.blit(this.pVol, this.rtVol, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.depthTex);
          U.i(gl, u.uDepth, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, this.scene.tex['headlights.png'] || this.scene.white);
          U.i(gl, u.uCookie, 1);
          U.m4(gl, u.uInvVP, this.invVP);
          U.v3v(gl, u.uCamPos, this.eye);
          U.v3(gl, u.uSunDir, sun[0], sun[1], sun[2]);
          { const sc = this.scene.sunColor || SUN_COL; U.v3(gl, u.uSunCol, sc[0], sc[1], sc[2]); }
          U.f(gl, u.uTime, this.time);
          U.f(gl, u.uTunnel, this.tunnel);
          U.f(gl, u.uDensity, this.volDensity === undefined ? FX.volDensity : this.volDensity);
          U.v3(gl, u.uHeadL, h.L[0], h.L[1], h.L[2]);
          U.v3(gl, u.uHeadR, h.R[0], h.R[1], h.R[2]);
          U.v3(gl, u.uHeadFwd, h.fwd[0], h.fwd[1], h.fwd[2]);
          U.v3(gl, u.uHeadRight, h.right[0], h.right[1], h.right[2]);
          U.v3(gl, u.uHeadCol, h.col[0], h.col[1], h.col[2]);
          U.f(gl, u.uHeadOn, h.on);
          U.f(gl, u.uHeadRange, h.range);
          U.f(gl, u.uHeadInner, h.inner);
          U.f(gl, u.uHeadOuter, h.outer);
          U.f(gl, u.uHeadDip, h.dip);
          U.f(gl, u.uHeadToe, h.toe);
          U.f(gl, u.uHeadFall, h.fall);
        });
        /* The march is dithered and fbm-modulated at half res, so upscaling it
           straight into the composite stipples the sky along the horizon where
           the ray length is longest. The same two-tap resolve the reflections
           use cleans it up without costing the shafts their shape. */
        this.blit(this.pDof, this.rtVolB, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtVol.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 1.3, 0);
        });
        this.blit(this.pDof, this.rtVol, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtVolB.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 0, 1.3);
        });
      }

      // 3. god rays: sky-only occlusion, then a radial blur toward the sun
      if (!this.useGodrays) onScreen = 0;
      this.blit(this.pOcc, this.rtOcc, (u) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.rtScene.tex);
        U.i(gl, u.uScene, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.rtScene.depthTex);
        U.i(gl, u.uDepth, 1);
      });
      this.blit(this.pGod, this.rtGod, (u) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.rtOcc.tex);
        U.i(gl, u.uTex, 0);
        U.v2(gl, u.uSunUv, sunU, sunV);
        U.f(gl, u.uOnScreen, onScreen);
      });

      // 4. bloom: threshold into mip 0, walk the pyramid down, then back up
      this.blit(this.pPre, this.bloom[0], (u) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.rtScene.tex);
        U.i(gl, u.uTex, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.rtSsr.tex);
        U.i(gl, u.uSsr, 1);
        U.f(gl, u.uThreshold, FX.bloomThreshold);
        U.f(gl, u.uKnee, FX.bloomKnee);
        U.f(gl, u.uSsrAmt, this.useSsr ? 1 : 0);
      });

      const nLev = Math.max(2, Math.min(this.bloom.length, this.bloomLevels || this.bloom.length));
      gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(this.pDown.prog);
      for (let i = 1; i < nLev; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloom[i].fb);
        gl.viewport(0, 0, this.bloom[i].w, this.bloom[i].h);
        gl.bindTexture(gl.TEXTURE_2D, this.bloom[i - 1].tex);
        U.i(gl, this.pDown.u.uTex, 0);
        this.fullscreenTri();
      }

      // additive tent upsample back down the chain
      gl.useProgram(this.pUp.prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = nLev - 1; i > 0; i--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.bloom[i - 1].fb);
        gl.viewport(0, 0, this.bloom[i - 1].w, this.bloom[i - 1].h);
        gl.bindTexture(gl.TEXTURE_2D, this.bloom[i].tex);
        U.i(gl, this.pUp.u.uTex, 0);
        U.f(gl, this.pUp.u.uRadius, FX.bloomRadius);
        // the widest levels get stretched sideways: anamorphic streaks
        U.f(gl, this.pUp.u.uStretch,
          i >= nLev - 2 ? (this.anamorphic === undefined ? FX.anamorphic : this.anamorphic) : 1.0);
        this.fullscreenTri();
      }
      gl.disable(gl.BLEND);

      // 5. depth-of-field source: quarter res, separable blur
      if (this.useDof) {
        this.blit(this.pDof, this.rtDofA, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 1, 0);
        });
        this.blit(this.pDof, this.rtDofB, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtDofA.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uDir, 0, 1);
        });
      }

      // 6. composite into an LDR buffer so FXAA has something to work on
      this.blit(this.pPost, this.rtLdr, (u) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.rtScene.tex);
        U.i(gl, u.uScene, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.bloom[0].tex);
        U.i(gl, u.uBloom, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, this.rtVol.tex);
        U.i(gl, u.uVol, 2);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, this.rtGod.tex);
        U.i(gl, u.uGod, 3);
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_2D, this.rtSsr.tex);
        U.i(gl, u.uSsr, 4);
        gl.activeTexture(gl.TEXTURE5);
        gl.bindTexture(gl.TEXTURE_2D, this.useDof ? this.rtDofB.tex : this.rtScene.tex);
        U.i(gl, u.uDof, 5);
        gl.activeTexture(gl.TEXTURE6);
        gl.bindTexture(gl.TEXTURE_2D, this.rtScene.depthTex);
        U.i(gl, u.uDepth, 6);
        gl.activeTexture(gl.TEXTURE7);
        gl.bindTexture(gl.TEXTURE_2D, this.rtAo.tex);
        U.i(gl, u.uAo, 7);
        U.f(gl, u.uTime, this.time);
        U.f(gl, u.uSpeed, this.speedFx);
        U.f(gl, u.uFlash, this.flash);
        U.f(gl, u.uTunnel, this.tunnel);
        const raceModeGrade = this.raceModeFx || 0;
        const bloomBase = this.bloomAmount === undefined ? FX.bloomAmount : this.bloomAmount;
        // raceMode supplies more emissive geometry of its own. Protect the
        // road and bodywork instead of letting the extra blue light clip the
        // entire frame to white.
        U.f(gl, u.uBloomAmt, bloomBase * (1 - raceModeGrade * .24));
        /* Chapter 7 takes a trim of its own. Even with the facades weighted
           correctly, a city built entirely out of light is brighter than a
           coast road at dusk, and the route is thirty kilometres long: what
           reads as spectacular for ten seconds reads as unplayable for
           twenty minutes. */
        const routeExp = (this.level && this.level.level7) ? 0.84 : 1;
        U.f(gl, u.uExposure, FX.exposure * routeExp * (1 - raceModeGrade * .075));
        /* raceMode is a colder, harder picture: the driver link is synchronised
           and the world is being read rather than looked at. A little more
           contrast and a little less chroma is all that takes. */
        /* The COLOUR row SCALES the shipped grade rather than replacing it.
           Every route's palette was authored against FX.saturation, so a look
           that sets an absolute value re-grades seven routes at once; one that
           multiplies keeps their relationship to each other. */
        const ls = this.lookSat === undefined ? 1.22 : this.lookSat;
        const lp = this.lookPunch === undefined ? 1.06 : this.lookPunch;
        U.f(gl, u.uSat, FX.saturation * (ls / 1.22) * (1 - raceModeGrade * .10));
        U.f(gl, u.uPunch, (FX.contrast * (lp / 1.06)) + raceModeGrade * .06);
        U.f(gl, u.uGodAmt, FX.godrayAmount);
        U.f(gl, u.uSsrAmt, this.useSsr ? 1 : 0);
        U.f(gl, u.uDofAmt, this.useDof ? 1 : 0);
        U.f(gl, u.uFlareAmt, FX.flareAmount * onScreen);
        U.f(gl, u.uAoAmt, this.useAo ? FX.aoAmount : 0);
        U.v2(gl, u.uSunUv, sunU, sunV);
        U.v2(gl, u.uRes, this.w, this.h);
        U.f(gl, u.uGrain, this.useGrain === false ? 0 : 1);
        U.f(gl, u.uMotion, this.useMotionBlur === false ? 0 : 1);
        U.f(gl, u.uNear, this.nearPlane || CAM.near);
        U.f(gl, u.uFar, CAM.far);
        { const sc = this.scene.sunColor || SUN_COL; U.v3(gl, u.uSunCol, sc[0], sc[1], sc[2]); }
      });

      /* 7. Temporal resolve. The result becomes next frame's history, so the
            two buffers swap rather than one being copied into the other. */
      let shown = this.rtLdr;
      if (this.useTaa) {
        const prev = this.rtHist[this.histIndex];
        const next = this.rtHist[this.histIndex ^ 1];
        this.blit(this.pTaa, next, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.rtLdr.tex);
          U.i(gl, u.uCur, 0);
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_2D, prev.tex);
          U.i(gl, u.uHist, 1);
          /* Unit 6, not 2. The scene program's normal-map sampler lives on
             unit 2, so leaving the depth texture bound there carries an
             attachment of the scene framebuffer into next frame's scene pass -
             a sampler pointing at the buffer being drawn into, which is a
             feedback loop and an INVALID_OPERATION every frame after the
             first. The post chain keeps its depth on a unit the scene pass
             never touches. */
          gl.activeTexture(gl.TEXTURE6);
          gl.bindTexture(gl.TEXTURE_2D, this.rtScene.depthTex);
          U.i(gl, u.uDepth, 6);
          U.m4(gl, u.uInvVP, this.invVP);
          U.m4(gl, u.uPrevVP, this.prevVP);
          U.v2(gl, u.uRes, this.w, this.h);
          // nothing to blend against on the first frame after a resize
          U.f(gl, u.uBlend, this.haveHistory ? 0.88 : 0);
        });
        this.histIndex ^= 1;
        this.haveHistory = true;
        shown = next;
      }
      M4.copy(this.prevVP, this.vp);

      /* 7b. SPATIAL RECONSTRUCTION, when the frame is smaller than the canvas.
       *
       * Everything up to here has run at the render resolution. This is where
       * the frame becomes the size of the window, and it is the difference
       * between a low setting that looks cheap and one that looks like the
       * same game with less fill. See UPSCALE_FRAG.
       *
       * Skipped entirely at or above NATIVE: there is nothing to reconstruct,
       * and running it as an identity would cost twelve taps a pixel to
       * produce the image it was handed. */
      let outRes = [this.w, this.h];
      const upMode = this.upscaler === undefined ? 2 : this.upscaler;
      if (this.renderScale < 1 && upMode > 0 && this.outW > this.w) {
        const src = shown;
        this.blit(this.pUpscale, this.rtUp, (u) => {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, src.tex);
          U.i(gl, u.uTex, 0);
          U.v2(gl, u.uRes, this.outW, this.outH);
          U.v2(gl, u.uSrcRes, this.w, this.h);
          U.f(gl, u.uMode, upMode);
        });
        shown = this.rtUp;
        outRes = [this.outW, this.outH];
      } else if (this.outW && this.outH) {
        // BILINEAR, or no upscale at all: the final pass still has to know how
        // big a pixel is, and that is the canvas, not the render target.
        outRes = [this.outW, this.outH];
      }

      // 8. sharpen, grain and scanlines, straight to the screen
      this.blit(this.pFinal, null, (u) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, shown.tex);
        U.i(gl, u.uTex, 0);
        U.v2(gl, u.uRes, outRes[0], outRes[1]);
        U.f(gl, u.uFxaa, this.useFxaa ? 1 : 0);
        // The base is TAA-aware, because a temporal resolve is what costs the
        // bite; the row scales that rather than replacing it.
        const sharpBase = this.useTaa ? 0.55 : 0.25;
        const sharpScale = this.sharpenScale === undefined ? 1 : this.sharpenScale;
        U.f(gl, u.uSharpen, sharpBase * sharpScale);
        U.f(gl, u.uGrain, this.useGrain === false ? 0 : 1);
        U.f(gl, u.uTime, this.time);
        /* The windscreen. A sampler must always have a texture of its own
           type bound whether or not the branch that reads it is taken - three
           sampler types sharing unit 0 is INVALID_OPERATION on every draw
           call, which is the bug the shadow and probe passes already learned
           the hard way. */
        const crack = this.glass && this.glass.texture();
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, crack || this.scene.white);
        U.i(gl, u.uCrack, 1);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D,
          (this.scene.tex && this.scene.tex['glass_shards.png']) || this.scene.white);
        U.i(gl, u.uShards, 2);
        U.f(gl, u.uCrackAmt, crack ? this.glass.amount : 0);
        gl.activeTexture(gl.TEXTURE0);
      });

      /* Release every unit the scene pass samples from. A render target left
         bound on one of them becomes a feedback loop the moment the next frame
         starts drawing into it, and the symptom - an error raised by a draw
         call in a completely different file - is a miserable thing to chase.

         THE RANGE HAS TO COVER EVERY UNIT THE SCENE PASS USES. It stopped at
         six, which was right until the shadow cascades took 5, 6 and 7 and the
         reflection probe took 8: the next frame's shadow pass then bound
         cascade 0's framebuffer while cascade 0's texture was still bound as a
         sampler, which is exactly the feedback loop this loop exists to
         prevent, and it raised INVALID_OPERATION on every frame after the
         first. Counted from the samplers rather than written down, so adding
         another cannot reintroduce it. */
      for (let unit = 0; unit <= MAX_TEX_UNIT; unit++) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.depthMask(true);
      gl.enable(gl.DEPTH_TEST);

      this.hud.draw(this, dt);
    }

    /* A BEAT, RATHER THAN A NUMBER.
     *
     * Every set piece in the game ends the same way: a toast says what
     * happened. That is information, and it is not a moment - the player
     * threads a shear panel by a metre at a hundred and forty and the game
     * prints a word at them.
     *
     * `slowMo` is the moment. Time dilates for a few tenths of a second, the
     * lens pinches, and the thing that was just survived goes past slowly
     * enough to see. It is the oldest trick in the genre and it is the
     * difference between a rule and a set piece.
     *
     * `amount` is 0..1 of dilation; `hold` is how long, in real seconds.
     */
    slowMo(amount, hold) {
      const a = M.clamp(amount || 0, 0, 0.8);
      this.timeScale = Math.min(this.timeScale === undefined ? 1 : this.timeScale, 1 - a);
      this.slowHold = Math.max(this.slowHold || 0, hold === undefined ? 0.22 : hold);
      this.slowFov = Math.max(this.slowFov || 0, a);
    }

    /* HOW MANY FRAMES THE CPU MAY RUN AHEAD OF THE GPU.
     *
     * THIS IS THE VSYNC BUG, and it is worth writing down because turning
     * vertical sync OFF made the game slower, which is the opposite of what
     * the switch is for.
     *
     * With vsync on, the compositor blocks the page at the refresh rate and
     * that block is what keeps the two processors in step. Turning it off -
     * see platform.rs, which passes --disable-gpu-vsync and
     * --disable-frame-rate-limit - removes the block, and nothing else was
     * holding the loop back. requestAnimationFrame then fires as fast as the
     * main thread can service it, several hundred times a second, and each one
     * queues a full scene into a command buffer the GPU is nowhere near
     * finishing.
     *
     * The queue is the problem. WebGL calls return immediately; they do not
     * wait for the work. So the CPU races on, six or eight frames of commands
     * pile up, and every one of them is a frame of latency between the wheel
     * being turned and the turn appearing. The frame RATE reads as enormous
     * and the game feels like it is being driven by post.
     *
     * A fence fixes it exactly. `fenceSync` drops a marker into the command
     * stream and `clientWaitSync` with a zero timeout asks - without blocking -
     * whether the GPU has passed it yet. Hold at most two in flight and the
     * CPU can never get further than two frames ahead: the rate settles at
     * whatever the GPU can actually deliver, and every frame that is drawn is
     * one the player will see almost immediately.
     *
     * Two rather than one, because one means the CPU idles while the GPU
     * finishes and the pipeline never overlaps at all - which costs about a
     * third of the frame rate for latency nobody can perceive.
     */
    gpuBusy() {
      const gl = this.gl;
      if (!gl || !gl.fenceSync || this.fencesOff) return false;
      const q = this.fences || (this.fences = []);
      /* Retire from the front: the fences are in submission order, so the
         first unsignalled one means everything behind it is unsignalled too. */
      while (q.length) {
        const st = gl.clientWaitSync(q[0], gl.SYNC_FLUSH_COMMANDS_BIT, 0);
        if (st === gl.TIMEOUT_EXPIRED) break;
        gl.deleteSync(q.shift());
      }
      if (q.length < 2) { this.stalls = 0; return false; }
      /* A DEAD MAN SWITCH, and it is not hypothetical.

         This decides whether to draw a frame by asking whether the GPU has
         finished an older one. If the answer is ever permanently no - a
         driver that does not signal, a software rasteriser, a context that
         has gone away - then it skips every frame from then on and the game
         stops dead with no error anywhere. Trading a frame of latency for a
         hang is not a trade worth making, so after half a second of frames
         that were all refused, the pacing gives up and never runs again.

         Thirty is about half a second of a healthy loop and several seconds
         of an unhealthy one. Nothing legitimate reaches it: two frames in
         flight clear in two frames. */
      this.stalls = (this.stalls || 0) + 1;
      if (this.stalls > 30) {
        this.fencesOff = true;
        for (const f of q) gl.deleteSync(f);
        q.length = 0;
        console.warn('SYNX: GPU fences are not retiring; frame pacing disabled');
        return false;
      }
      return true;
    }

    /** Mark the end of this frame's commands, for gpuBusy to wait on. */
    gpuMark() {
      const gl = this.gl;
      if (!gl || !gl.fenceSync || this.fencesOff) return;
      const q = this.fences || (this.fences = []);
      /* A cap on the list itself. If the context is lost, or a driver never
         signals, the poll above stops retiring and this would otherwise grow
         without bound for the rest of the session. */
      if (q.length > 8) { gl.deleteSync(q.shift()); }
      q.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0));
    }

    run() {
      let last = performance.now();
      const frame = (now) => {
        /* THE FRAME LIMIT.

           A cap is a minimum interval, and the only honest way to hold one in
           a webview is to decline to draw: there is no swap interval a page
           can ask for. So a frame that arrives too early is skipped whole -
           the simulation is not stepped either, because stepping it and not
           drawing it is just a lower frame rate with extra work in it.

           `- 0.5` of a millisecond, because rAF fires on a display tick and a
           tick is never exactly the interval asked for: without the slack a
           60 Hz cap on a 60 Hz screen misses every other frame and runs at 30.
           Skipping is what makes it a LIMIT rather than a target - the loop
           never tries to catch up, so a cap can only ever slow the game down
           to the number asked for, never speed it up past what it can hold. */
        const gap = this.frameInterval || 0;
        if (gap > 0 && now - last < gap - 0.5) {
          requestAnimationFrame(frame);
          return;
        }
        /* ...and the same decision made against the GPU rather than the clock.
           See gpuBusy: this is what stops an uncapped loop queueing frames
           faster than they can be drawn. Skipped whole, for the same reason a
           capped frame is. */
        if (this.gpuBusy()) {
          requestAnimationFrame(frame);
          return;
        }
        // the real time this frame took, before dt is clamped for the sim
        const frameMs = now - last;
        let dt = (now - last) / 1000;
        last = now;
        if (!isFinite(dt) || dt < 0) dt = 0;
        this.fpsSample(dt);
        dt = Math.min(dt, 0.05);
        /* THE DILATION RUNS ON REAL TIME and the simulation runs on scaled
           time, which is the whole point: a slowed frame must not also slow
           its own recovery, or a quarter-speed beat takes four times as long
           to come out of as it does to go into. */
        if (this.timeScale === undefined) this.timeScale = 1;
        this.slowHold = Math.max(0, (this.slowHold || 0) - dt);
        if (this.slowHold <= 0) {
          this.timeScale += (1 - this.timeScale) * Math.min(1, dt * 4.2);
          if (this.timeScale > 0.998) this.timeScale = 1;
        }
        this.slowFov = Math.max(0, (this.slowFov || 0) - dt * 1.4);
        /* WHERE THE FRAME GOES, IN THREE PARTS.
         *
         * `update` is the simulation - physics, the drivers, the director,
         * the audio mixer. `draw` is everything between deciding what the
         * world looks like and handing the last command to the driver:
         * culling, matrix building, uniform writes, draw calls. Whatever is
         * left of the frame after both of them is the page waiting on the
         * GPU, because nothing else is running.
         *
         * Those three are exactly the split a player needs to know which end
         * of their machine is the problem - a game that is CPU-bound does not
         * get faster with a smaller resolution and a GPU-bound one does - and
         * the benchmark reports them. Two clock reads a frame, always on,
         * because a timer that is only installed while measuring measures a
         * loop that is not the one that runs. See js/bench.js.
         */
        const tSim = performance.now();
        try {
          this.update(dt * this.timeScale);
          const tDraw = performance.now();
          // ...and the interface animates on the wall clock, because a menu
          // that eases in at quarter speed reads as the game having hung
          this.draw(dt);
          const tEnd = performance.now();
          const P = this.phase || (this.phase = { sim: 0, sub: 0 });
          P.sim = tDraw - tSim;
          P.sub = tEnd - tDraw;
        } catch (e) {
          console.error(e);
        }
        /* THE BENCHMARK IS FED THE REAL FRAME TIME, not the simulation dt.
           dt is clamped to 50ms so a stall cannot teleport the car, and a
           benchmark that cannot see a 200ms frame is a benchmark that will
           recommend a preset which stutters. See js/bench.js. */
        if (NR.Bench && NR.Bench.running) NR.Bench.tick(this, frameMs);
        this.input.endFrame();
        // the marker gpuBusy waits on next frame, after all of this frame is queued
        this.gpuMark();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }

    /* WHAT THE COUNTER ACTUALLY COUNTS.
     *
     * Two numbers, because one of them is not enough to act on. The average
     * over the last second is what a frame rate usually means; the SLOWEST
     * frame in that second is the one the player felt, and a run that averages
     * 90 with a 40 ms hitch in it is not a smooth run. A counter that reports
     * only the mean hides exactly the thing it is being read to find.
     *
     * Measured on the wall clock and on the RAW delta - before the 50 ms clamp
     * the simulation uses, and before time dilation - or a slow-motion beat
     * would read as the game having dropped to a quarter of its frame rate.
     */
    fpsSample(dt) {
      const F = this.fps || (this.fps = { now: 0, worst: 0, n: 0, sum: 0, peak: 0, t: 0 });
      if (!(dt > 0)) return;
      F.n++;
      F.sum += dt;
      if (dt > F.peak) F.peak = dt;
      F.t += dt;
      if (F.t < 0.5) return;
      F.now = F.n / F.sum;
      F.worst = F.peak > 0 ? 1 / F.peak : 0;
      F.n = 0; F.sum = 0; F.peak = 0; F.t = 0;
    }
  }

  function readNum(k) {
    try {
      const v = global.NR.Save.get(k);
      if (v == null) return null;
      const n = parseFloat(v);
      return isFinite(n) ? n : null;
    } catch (e) { return null; }
  }
  function writeNum(k, v) {
    try { global.NR.Save.set(k, String(v)); } catch (e) { /* no save available */ }
  }

  global.NR.Game = Game;
  /* The route table and the Free Roam seams, published for the screen that
     paints a tile per region and for the capture harnesses that assert against
     them. Read-only by convention: applyLevel caches each route's sun bearing
     back onto its entry, and nothing else writes here. */
  global.NR.LEVELS = LEVELS;
  /* The stunt course, published for js/scene.js - which builds the structure
     from these same rows - for Chapter 7, whose three ramps are in here, and
     for the harnesses that assert a ramp stands on a straight. */
  global.NR.COURSE_RAMPS = COURSE_RAMPS;
  /* The title screen's running order, published so a tool can start the drive
     somewhere in particular. Every menu defect reported so far has been at a
     specific place on the course, and without this the only way to look at one
     is to keep taking screenshots until the reel comes round to it. */
  global.NR.ATTRACT_REEL = ATTRACT_REEL;
  global.NR.RAMP_TELEGRAPH = RAMP_TELEGRAPH;
  global.NR.RAMP_CLEAN = RAMP_CLEAN;
  global.NR.SETTING_ROWS = SETTING_ROWS;
  global.NR.CONTROLS_LAYOUT = CONTROLS_LAYOUT;
  global.NR.CONTROL_TABS = CONTROL_TABS;
  global.NR.CONTROLS_LAYOUTS = CONTROLS_LAYOUTS;
  global.NR.CTL_TAB_Y = CTL_TAB_Y;
  global.NR.CTL_TAB_W = CTL_TAB_W;
  global.NR.ctlTabX = ctlTabX;
  global.NR.ACTIONS = ACTIONS;
  global.NR.KEYBOARD_ROWS = KEYBOARD_ROWS;
  global.NR.tabRows = tabRows;
  global.NR.keyLabel = keyLabel;
  global.NR.bindLabel = bindLabel;
  /* The fallback Input.keysFor uses when a settings file has never mentioned
     an action, or has managed to strip one to nothing. */
  global.NR.ACTION_DEFAULTS = (() => {
    const d = {};
    for (const a of ACTIONS) d[a.key] = a.def.slice();
    return d;
  })();
  global.NR.REGION_EDGES = REGION_EDGES;
  global.NR.FREE_ROAM_END = FREE_ROAM_END;
  global.NR.FREE_ROAM_BLEND = REGION_BLEND;
  global.NR.mixPalette = mixPalette;
})(window);
