/* SYNX — the settings schema, in one place.
 *
 * Every row on the launcher and every row on the in-game CONTROLS screen is
 * declared here, once. Both screens read this file and neither carries its own
 * copy of a label, a default or a list of values.
 *
 * WHY THIS FILE EXISTS
 *
 * The two screens are written in different files by different renderers - the
 * launcher is DOM, the controls screen is drawn on a canvas - and they save to
 * the same file. Two declarations of "NEON GLOW has four values and defaults
 * to the third" is a guarantee that one day it has five in one place and four
 * in the other, and the symptom is a saved index that means HEAVY on one
 * screen and nothing at all on the other.
 *
 * So the rows are data, and the screens are renderers for it.
 *
 * WHAT A ROW IS
 *
 *   key      what it is saved under, inside `synx.settings.v1`
 *   label    what the player reads
 *   opts     the values, in order; the saved value is an INDEX into this
 *   def      the default index
 *   hint     why anyone would change it, and what it costs
 *   group    starts a new headed section when present
 *   tab      which page of its screen it belongs to
 *   where    'game' or 'launcher'
 *
 * THE SPLIT, AND WHY IT IS WHERE IT IS
 *
 * Everything about the PICTURE is on the launcher. Everything about the
 * PLAYER'S HANDS is in the game.
 *
 * That line is not arbitrary. A graphics setting is chosen once, against a
 * machine, by someone deciding what their hardware can do - and several of
 * them genuinely cannot be applied to a webview that already has a GPU
 * context, so a screen that offered all of them and honoured only some was
 * lying about the rest. Putting the whole set in front of the game means the
 * answer is always the same kind of answer: it is decided before there is
 * anything to disturb.
 *
 * A control binding is the opposite. It is discovered while playing, changed
 * because something felt wrong in a corner, and has to take effect on the next
 * corner. It belongs behind ESC, and nowhere else.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  if (NR.Settings) return;

  /* THE QUALITY PRESETS.

     `shadow` is the NEAR cascade's resolution; the outer two take half of it
     (see Scene.initShadows). The near one covers forty-two units, so 1024 is
     twenty-four texels per unit - about a hundred and fifty across a car,
     which is sharper than the filter that reads it. 2048 was four times the
     fill for a difference nobody can see, and it was three milliseconds. */
  const QUALITY = {
    LOW: {
      bloomLevels: 3, volumetric: false, godrays: false, ssr: false, ao: false,
      dof: false, fxaa: false, taa: false, scale: 0.70, shadow: 0, shadowSoft: 0,
    },
    MEDIUM: {
      bloomLevels: 4, volumetric: false, godrays: true, ssr: false, ao: true,
      dof: true, fxaa: true, taa: false, scale: 0.90, shadow: 512, shadowSoft: 0,
    },
    HIGH: {
      bloomLevels: 6, volumetric: true, godrays: true, ssr: true, ao: true,
      dof: true, fxaa: false, taa: true, scale: 1.00, shadow: 1024, shadowSoft: 1,
    },
    ULTRA: {
      bloomLevels: 6, volumetric: true, godrays: true, ssr: true, ao: true,
      dof: true, fxaa: false, taa: true, scale: 1.35, shadow: 2048, shadowSoft: 2,
    },
  };

  /* THE RENDER SCALE LADDER.

     How many pixels the 3D is drawn at before being reconstructed to fit the
     window. It is the only control anywhere that changes the frame rate by a
     large factor.

     NATIVE renders one pixel per screen pixel. The entries below it render
     fewer and cost less; the two above render more and are downsampled, which
     is plain supersampling and the cheapest anti-aliasing there is.

     The ones below NATIVE used to be stretched back up by the browser's own
     bilinear filter, which is why they looked like a smaller game rather than
     a cheaper one. They go through the spatial reconstruction pass now - see
     UPSCALER below, and UPSCALE_FRAG in js/game.js. */
  const RENDER_SCALES = [
    { label: '50%', scale: 0.50 },
    { label: '67%', scale: 0.67 },
    { label: '80%', scale: 0.80 },
    { label: 'NATIVE', scale: 1.00 },
    { label: '125%', scale: 1.25 },
    { label: '150%', scale: 1.50 },
    { label: '200%', scale: 2.00 },
  ];

  /* Values the FRAME LIMIT row's indices mean. Index 0 is uncapped, and the
     zero is deliberate: it is what the frame loop reads as "no cap". */
  const FPS_CAPS = [0, 30, 60, 75, 90, 120, 144, 165, 240];

  const ROWS = [
    // =================================================== LAUNCHER: display ==
    // Window shape and the graphics backend. None of these can be changed
    // underneath a live webview, which is why the launcher exists.
    { where: 'launcher', tab: 0, group: 'DISPLAY', key: 'mode', label: 'WINDOW MODE',
      opts: ['WINDOWED', 'BORDERLESS', 'FULLSCREEN'], def: 1,
      hint: 'BORDERLESS fills the display with no frame and alt-tabs instantly. FULLSCREEN goes through the platform’s own path. WINDOWED uses the size below.' },
    { where: 'launcher', tab: 0, key: 'monitor', label: 'DISPLAY', opts: null, def: 0,
      hint: 'Which screen the game opens on.' },
    { where: 'launcher', tab: 0, key: 'size', label: 'WINDOW SIZE', opts: null, def: 0,
      hint: 'The size of the window in WINDOWED mode. Filtered to what fits on the display above.' },
    { where: 'launcher', tab: 0, key: 'gpu', label: 'RENDERER', opts: ['SOFTWARE', 'HARDWARE'], def: 1,
      hint: 'HARDWARE is the GPU path and is what the game is built for. SOFTWARE is a fallback for a machine whose driver cannot give a 3D context — correct, and very slow. Changing this restarts the game.' },
    { where: 'launcher', tab: 0, key: 'vsync', label: 'VERTICAL SYNC', opts: ['OFF', 'ON'], def: 1,
      hint: 'Matches the frame to the display refresh. Off can tear; on is smoother and adds a frame of latency.' },
    /* THE GAME OWNS THIS ONE, not the host.

       It used to be a host key, stored under the launcher's own save entry -
       which the game never reads. So it was written, sanitised, unit-tested
       and applied by nothing at all: the row moved, and the frame rate did
       not. A limit is enforced by the thing that draws the frames, so it lives
       where every other row the renderer reads lives. */
    { where: 'launcher', tab: 0, key: 'fps_cap', label: 'FRAME LIMIT',
      opts: ['UNCAPPED', '30', '60', '75', '90', '120', '144', '165', '240'], def: 0,
      hint: 'An upper bound on the frame rate. Useful on a laptop, where an uncapped menu screen is a fan at full speed for nothing.' },
    { where: 'launcher', tab: 0, key: 'fpsShow', label: 'FPS COUNTER', opts: ['OFF', 'ON'], def: 0,
      hint: 'Shows the frame rate in the corner while you drive, with the slowest frame of the last second beside it.' },
    { where: 'launcher', tab: 0, key: 'always_on_top', label: 'ALWAYS ON TOP', opts: ['OFF', 'ON'], def: 0,
      hint: 'Keeps the window above everything else on the desktop.' },

    // ================================================== LAUNCHER: graphics ==
    /* RENDER SCALE and UPSCALER lead the graphics tab because they are about
       how many pixels there are, which is the question everything below them
       is spending. They are stored in the GAME's blob - see HOST_KEYS -
       because the renderer is what reads them. */
    { where: 'launcher', tab: 1, group: 'RESOLUTION', key: 'resolution', label: 'RENDER SCALE',
      opts: RENDER_SCALES.map((r) => r.label), def: 3,
      hint: 'How many pixels the 3D is drawn at before it is fitted to the window. Below NATIVE is reconstructed by the upscaler and costs far less; above it is supersampled, the sharpest and most expensive thing in the game.' },
    { where: 'launcher', tab: 1, key: 'upscaler', label: 'UPSCALER',
      opts: ['BILINEAR', 'FSR — SPATIAL', 'FSR — SHARP'], def: 2,
      hint: 'How a sub-native frame is reconstructed. BILINEAR is the plain stretch a browser does on its own. FSR is an edge-directed filter that follows the shape of the image rather than blurring across it; SHARP adds a contrast-adaptive pass. Nothing to do at or above NATIVE.' },

    { where: 'launcher', tab: 1, group: 'DETAIL', key: 'quality', label: 'PRESET',
      opts: ['LOW', 'MEDIUM', 'HIGH', 'ULTRA'], def: 2,
      hint: 'Which passes exist at all. The preset and the rows below COMPOSE: a feature runs when the preset provides it and the row asks for it, so a row can decline what the preset offers but cannot conjure what it does not.' },
    { where: 'launcher', tab: 1, key: 'shadows', label: 'CAST SHADOWS', opts: ['OFF', 'ON'], def: 1,
      hint: 'Real shadows from the key light, in three cascades. The single largest thing on this screen.' },
    { where: 'launcher', tab: 1, key: 'ao', label: 'AMBIENT OCCLUSION',
      opts: ['OFF', 'LOW', 'HIGH'], def: 2,
      hint: 'Ground-truth horizon occlusion: contact darkening where surfaces meet, with the bounce light put back so a crease is shaded rather than dirty. HIGH doubles the slices.' },
    { where: 'launcher', tab: 1, key: 'bloom', label: 'NEON GLOW',
      opts: ['OFF', 'SUBTLE', 'NORMAL', 'HEAVY'], def: 2,
      hint: 'How far light bleeds past what emits it.' },
    { where: 'launcher', tab: 1, key: 'volumetrics', label: 'VOLUMETRIC FOG', opts: ['OFF', 'ON'], def: 1,
      hint: 'Light in the air: headlight beams, god rays, haze with depth in it.' },
    { where: 'launcher', tab: 1, key: 'reflections', label: 'WET REFLECTIONS', opts: ['OFF', 'ON'], def: 1,
      hint: 'Screen-space reflections in the road surface, and the local probe that feeds them.' },
    { where: 'launcher', tab: 1, key: 'motionBlur', label: 'SPEED BLUR', opts: ['OFF', 'ON'], def: 1,
      hint: 'Radial blur that builds with speed.' },

    /* THE IMAGE GROUP. The picture, as opposed to what is in it. Separated
       because none of these three costs anything measurable: they are taste,
       and a player hunting for frames should not have to read past them. */
    { where: 'launcher', tab: 1, group: 'IMAGE', key: 'look', label: 'COLOUR',
      opts: ['NEUTRAL', 'SYNTHWAVE', 'PUNCHY'], def: 1,
      hint: 'The grade on top of the AgX display transform. NEUTRAL is the transform on its own; SYNTHWAVE is how the game is meant to look; PUNCHY pushes contrast and saturation further.' },
    { where: 'launcher', tab: 1, key: 'sharpness', label: 'SHARPNESS',
      opts: ['OFF', 'LOW', 'NORMAL', 'HIGH'], def: 2,
      hint: 'Contrast-adaptive sharpening over the finished frame. It restores the bite a temporal resolve costs, and too much of it rings on the neon.' },
    { where: 'launcher', tab: 1, key: 'grain', label: 'CRT FILTER', opts: ['OFF', 'ON'], def: 1,
      hint: 'Scanlines and film grain over the finished frame.' },

    // ===================================================== LAUNCHER: audio ==
    { where: 'launcher', tab: 2, group: 'AUDIO', key: 'music', label: 'MUSIC',
      opts: ['OFF', '25%', '50%', '75%', '100%'], def: 3,
      hint: 'The menu theme and the in-car radio.' },
    { where: 'launcher', tab: 2, key: 'sfx', label: 'SOUND FX',
      opts: ['OFF', '25%', '50%', '75%', '100%'], def: 4,
      hint: 'Engine, tyres, impacts and the interface.' },

    // ======================================================= GAME: gamepad ==
    /* Tab 1 of the CONTROLS screen. Tab 0 is the keyboard, whose rows are key
       BINDINGS rather than settings and are declared in js/game.js beside the
       actions they bind. */
    { where: 'game', tab: 1, group: 'GAMEPAD', key: 'pad', label: 'CONTROLLER',
      opts: ['OFF', 'ON'], def: 1,
      hint: 'Use a connected controller. The game reads it whether or not this screen is open; turning it off is for when a drifting stick is fighting the keyboard.' },
    { where: 'game', tab: 1, key: 'padDeadzone', label: 'STICK DEADZONE',
      opts: ['NONE', 'SMALL', 'NORMAL', 'LARGE'], def: 2,
      hint: 'How far the stick must move before the car does. Raise it if the car drifts with your hands off the pad; a worn stick needs LARGE.' },
    { where: 'game', tab: 1, key: 'padSteer', label: 'STEER RESPONSE',
      opts: ['LINEAR', 'SMOOTH', 'PRECISE'], def: 1,
      hint: 'How stick travel maps to lock. LINEAR is one to one. SMOOTH and PRECISE give more of the stick to small corrections, which is most of what fast driving is.' },
    { where: 'game', tab: 1, key: 'padVibration', label: 'VIBRATION',
      opts: ['OFF', 'LIGHT', 'NORMAL', 'STRONG'], def: 2,
      hint: 'Rumble on impacts, kerbs and the boost. Silently ignored by a pad or a browser that cannot do it.' },

    // ========================================================= GAME: mouse ==
    { where: 'game', tab: 2, group: 'MOUSE', key: 'mouseLook', label: 'FREE LOOK',
      opts: ['OFF', 'ON'], def: 0,
      hint: 'Moving the mouse while driving swings the chase camera round the car. It recentres itself the moment you stop.' },
    { where: 'game', tab: 2, key: 'mouseSens', label: 'LOOK SENSITIVITY',
      opts: ['25%', '50%', '75%', '100%', '150%', '200%'], def: 3,
      hint: 'How far the camera swings for the same movement. Applies to FREE LOOK above.' },
    { where: 'game', tab: 2, key: 'mouseInvert', label: 'INVERT Y', opts: ['OFF', 'ON'], def: 0,
      hint: 'Push the mouse away from you to look down rather than up.' },
    { where: 'game', tab: 2, key: 'mouseSmooth', label: 'SMOOTHING',
      opts: ['OFF', 'LIGHT', 'NORMAL', 'HEAVY'], def: 2,
      hint: 'Damps the camera behind the pointer. More is calmer and less immediate.' },
  ];

  /* WHICH BLOB A ROW IS SAVED IN.
   *
   * Two keys, because two different things read them. The host reads the
   * window answers before any JavaScript exists, out of the save file, in
   * Rust; the game reads everything else from inside its frame loop.
   *
   * Deriving this from `where` would be wrong: RENDER SCALE and UPSCALER are
   * shown only on the launcher and belong to the game's blob, because the
   * renderer is what reads them. So it is a list. */
  /* Rows the HOST owns, stored under the launcher's own save entry and read
     by Rust before any window exists. Everything else on the launcher screen
     is an ordinary game setting that happens to be shown there, stored in the
     same place the in-game options screen stores its rows and read by the same
     loader - which is the only reason those rows work.

     `fps_cap` was in this list and had no business being here: nothing in the
     host reads it, and the game cannot see this entry. See the row itself. */
  const HOST_KEYS = ['mode', 'monitor', 'size', 'gpu', 'vsync', 'always_on_top'];

  /** True when this row is saved in the launcher's own blob. */
  function isHostKey(key) {
    return HOST_KEYS.indexOf(key) >= 0;
  }

  /** Every row a given screen shows, in order. */
  function rowsFor(where) {
    return ROWS.filter((r) => r.where === where);
  }

  /** A row by key, or undefined. Nothing indexes ROWS by position. */
  function rowByKey(key) {
    for (const r of ROWS) if (r.key === key) return r;
    return undefined;
  }

  /** The defaults for every row the GAME's settings blob carries. */
  function defaults() {
    const out = Object.create(null);
    for (const r of ROWS) if (!isHostKey(r.key)) out[r.key] = r.def;
    return out;
  }

  NR.Settings = {
    QUALITY, RENDER_SCALES, ROWS, FPS_CAPS, HOST_KEYS,
    rowsFor, rowByKey, defaults, isHostKey,
    /** Where the game's own settings live. */
    KEY: 'synx.settings.v1',
    /** ...and where the launcher's window answers live. */
    LAUNCHER_KEY: 'synx.launcher.v1',
    /** Where the benchmark leaves what it measured, for the launcher to
        offer the next time it opens. See js/bench.js. */
    BENCH_KEY: 'synx.bench.v1',
  };
})(typeof window !== 'undefined' ? window : globalThis);
