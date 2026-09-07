/* SYNX — the controller.
 *
 * One place that knows about the Gamepad API, so nothing else has to.
 *
 * WHAT WAS HERE BEFORE
 *
 * Six lines inside `Input.sample`: read axis 0, read triggers 6 and 7, treat
 * buttons 0 and 1 as boost and handbrake. It worked, and it was the whole of
 * it - no deadzone worth the name, no response curve, nothing to steer a menu
 * with, no way to know whether a pad was even attached, and no way for the
 * player to change any of it. A controller you can drive with but cannot press
 * START on is a controller that still needs a keyboard next to it.
 *
 * WHAT A GAMEPAD ACTUALLY IS
 *
 * `navigator.getGamepads()` returns a SNAPSHOT, not live objects - the arrays
 * it hands back are only valid for the frame they were fetched in, which is
 * why this polls once per frame and everything else reads the result rather
 * than calling the API itself. Two readers calling `getGamepads` in the same
 * frame is two different snapshots and an edge that one of them misses.
 *
 * THE STANDARD MAPPING
 *
 * A browser that recognises a pad reports `mapping === 'standard'` and lays it
 * out the way the W3C specifies - which is the Xbox layout, because that is
 * what the specification was written from. Everything below is indexed against
 * that. A pad the browser does NOT recognise reports an empty mapping and an
 * arbitrary order, and there is no honest way to guess it; those still drive,
 * because axis 0 and the first few buttons are near-universal, but the diagram
 * says the layout is unknown rather than drawing a lie.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  if (NR.Pad) return;

  /* The standard mapping, named. Indices are meaningless at the call site and
     this is the whole reason a wrong one is hard to spot. */
  const B = {
    A: 0, B: 1, X: 2, Y: 3,
    LB: 4, RB: 5, LT: 6, RT: 7,
    BACK: 8, START: 9,
    LS: 10, RS: 11,
    UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15,
    GUIDE: 16,
  };

  /* What each control does in SYNX. The controls screen draws this, and it is
     here rather than there because it is a fact about the binding, not about
     the panel - and because two lists of it would drift the moment one
     changed. `side` places the callout on the diagram. */
  const MAP = [
    { id: 'RT', button: B.RT, label: 'ACCELERATE', side: 'right', analog: true },
    { id: 'LT', button: B.LT, label: 'BRAKE / REVERSE', side: 'left', analog: true },
    { id: 'LSTICK', axis: 0, label: 'STEER', side: 'left', analog: true },
    { id: 'A', button: B.A, label: 'BOOST', side: 'right' },
    { id: 'B', button: B.B, label: 'HANDBRAKE / DRIFT', side: 'right' },
    { id: 'X', button: B.X, label: 'RACE MODE / RESTART', side: 'right' },
    { id: 'Y', button: B.Y, label: 'LOOK BEHIND', side: 'right' },
    { id: 'RB', button: B.RB, label: 'BOOST', side: 'right' },
    { id: 'LB', button: B.LB, label: 'HANDBRAKE', side: 'left' },
    { id: 'START', button: B.START, label: 'PAUSE', side: 'right' },
    { id: 'BACK', button: B.BACK, label: 'BACK / CANCEL', side: 'left' },
    { id: 'DPAD', button: B.UP, label: 'MENU NAVIGATION', side: 'left' },
    { id: 'RSTICK', axis: 2, label: 'FREE LOOK', side: 'right', analog: true },
  ];

  /* Deadzone radii, by setting index. A stick reports a small non-zero value
     at rest and a worn one reports a large one, which is why this is a player
     setting and not a constant: the right number is a property of the pad in
     their hands, not of the game. */
  const DEADZONES = [0.02, 0.08, 0.14, 0.22];

  /* How stick travel becomes lock. LINEAR is one to one. The other two spend
     more of the stick on small corrections, which is most of what fast driving
     actually is - a curve is not a sensitivity, it is where the resolution
     goes. */
  const CURVES = [1.0, 1.6, 2.2];

  const RUMBLE = [0, 0.35, 0.7, 1.0];

  /** How long a held direction waits before it starts repeating, and then how
      fast - the same numbers a text field uses, because the expectation comes
      from there. */
  const REPEAT_DELAY = 0.42;
  const REPEAT_RATE = 0.11;

  class Pad {
    constructor() {
      /** The live snapshot, replaced once a frame by `poll`. */
      this.raw = null;
      /** True while a recognised pad is attached and the setting allows it. */
      this.active = false;
      /** True when a pad is attached at all, whatever the setting says. */
      this.present = false;
      /** 'standard' when the browser recognised the layout, '' when it did not. */
      this.mapping = '';
      this.id = '';
      this.index = -1;

      /* Per-button state, kept across frames so an edge can be reported. The
         API gives level, not edges, and every caller deriving its own is how
         one of them ends up missing a press that happened between polls. */
      this._held = [];
      this._hit = [];
      this._value = [];
      this.axes = [0, 0, 0, 0];

      /* Menu repeat. A d-pad that fires once per press is unusable for a list
         of twelve, and one that fires every frame is unusable for a list of
         two. */
      this._repeatDir = 0;
      this._repeatT = 0;
      this._navHit = { up: false, down: false, left: false, right: false };

      this.deadzone = DEADZONES[2];
      this.curve = CURVES[1];
      this.rumble = RUMBLE[2];
      this.enabled = true;

      /* Connection events are advisory: Chrome does not fire `gamepadconnected`
         until the pad has been touched, so `poll` also discovers pads on its
         own. These exist so the interface can react the moment one arrives. */
      global.addEventListener('gamepadconnected', (e) => {
        this._note(e && e.gamepad ? e.gamepad : null);
      });
      global.addEventListener('gamepaddisconnected', () => {
        this.present = false;
        this.active = false;
        this.id = '';
        this.index = -1;
      });
    }

    _note(g) {
      if (!g) return;
      this.present = true;
      this.id = g.id || '';
      this.mapping = g.mapping || '';
      this.index = g.index;
    }

    /** Push the player's settings in. Called from Game.applySettings. */
    configure(st) {
      if (!st) return;
      this.enabled = st.pad === undefined ? true : st.pad === 1;
      this.deadzone = DEADZONES[st.padDeadzone === undefined ? 2 : st.padDeadzone] || DEADZONES[2];
      this.curve = CURVES[st.padSteer === undefined ? 1 : st.padSteer] || CURVES[1];
      this.rumble = RUMBLE[st.padVibration === undefined ? 2 : st.padVibration] || 0;
    }

    /* Read the pads, once, at the top of the frame.
     *
     * The FIRST connected pad wins. Choosing among several would need a rule
     * nobody has asked for, and "whichever one you are holding" is not
     * something the API can answer. */
    poll(dt) {
      const list = global.navigator && global.navigator.getGamepads
        ? global.navigator.getGamepads() : null;
      let g = null;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          if (list[i] && list[i].connected) { g = list[i]; break; }
        }
      }
      this.raw = g;
      this.present = !!g;
      if (g) {
        this.id = g.id || '';
        this.mapping = g.mapping || '';
        this.index = g.index;
      }
      this.active = !!g && this.enabled;

      // Edges are computed even when the pad is switched off, so turning it
      // back on does not deliver a press that happened while it was off.
      const held = this._held;
      const hit = this._hit;
      const val = this._value;
      const n = g ? g.buttons.length : 0;
      for (let i = 0; i < Math.max(n, held.length); i++) {
        const btn = g && g.buttons[i];
        const v = btn ? (typeof btn.value === 'number' ? btn.value : (btn.pressed ? 1 : 0)) : 0;
        /* A TRIGGER IS NOT A BUTTON, and `pressed` on one is a threshold the
           browser chose. Half-pressing a trigger to trail the brakes must not
           read as a button press in a menu, so the edge is taken against a
           threshold of our own that is high enough to mean intent. */
        const isDown = btn ? (btn.pressed || v > 0.55) : false;
        hit[i] = this.active && isDown && !held[i];
        held[i] = isDown;
        val[i] = v;
      }

      if (g && g.axes) {
        for (let i = 0; i < 4; i++) this.axes[i] = g.axes[i] || 0;
      } else {
        this.axes[0] = this.axes[1] = this.axes[2] = this.axes[3] = 0;
      }

      this._pollNav(dt || 0.016);
    }

    /* Menu direction, with a hold-repeat. Both the d-pad and the left stick
       drive it: a player who has just steered with the stick should not have
       to find the d-pad to choose a route. */
    _pollNav(dt) {
      const nav = this._navHit;
      nav.up = nav.down = nav.left = nav.right = false;
      if (!this.active) { this._repeatDir = 0; this._repeatT = 0; return; }

      const ax = this.stickX(0);
      const ay = this.axis(1);
      const dU = this.held(B.UP) || ay < -0.55;
      const dD = this.held(B.DOWN) || ay > 0.55;
      const dL = this.held(B.LEFT) || ax < -0.55;
      const dR = this.held(B.RIGHT) || ax > 0.55;

      // one axis at a time: a diagonal on a d-pad should not move twice
      let dir = 0;
      if (dU) dir = 1; else if (dD) dir = 2; else if (dL) dir = 3; else if (dR) dir = 4;

      if (dir !== this._repeatDir) {
        this._repeatDir = dir;
        this._repeatT = 0;
        if (dir) this._fireNav(dir);
        return;
      }
      if (!dir) return;
      /* Held. Fire once on the press (above), then nothing until the delay has
         passed, then once every REPEAT_RATE. Winding the clock back to
         DELAY - RATE rather than to zero is what makes the repeats even: reset
         to zero and the second one would wait the whole delay again. */
      this._repeatT += dt;
      if (this._repeatT >= REPEAT_DELAY) {
        this._repeatT = REPEAT_DELAY - REPEAT_RATE;
        this._fireNav(dir);
      }
    }

    _fireNav(dir) {
      const nav = this._navHit;
      if (dir === 1) nav.up = true;
      else if (dir === 2) nav.down = true;
      else if (dir === 3) nav.left = true;
      else if (dir === 4) nav.right = true;
    }

    // ------------------------------------------------------------ reading --

    /** Is this standard-mapping button held? */
    held(i) { return !!this._held[i] && this.active; }
    /** Did it go down this frame? */
    hit(i) { return !!this._hit[i]; }
    /** Its analogue value, 0..1 - meaningful for the triggers. */
    value(i) { return this.active ? (this._value[i] || 0) : 0; }
    /** A raw axis, with no deadzone applied. For the diagram. */
    axis(i) { return this.active ? (this.axes[i] || 0) : 0; }

    /* A stick axis with the deadzone taken out and RESCALED.
     *
     * Subtracting the deadzone without rescaling leaves a control whose range
     * is 0.14 to 1.0 - so full lock needs the stick fully over and the first
     * eighth of its travel does nothing at all. Rescaling puts the usable
     * range back to 0..1, which is what makes a large deadzone tolerable
     * rather than a control that feels broken. */
    stickX(i) {
      const v = this.axis(i);
      const a = Math.abs(v);
      if (a <= this.deadzone) return 0;
      const t = (a - this.deadzone) / (1 - this.deadzone);
      return Math.sign(v) * Math.min(1, t);
    }

    /** Steering: deadzone, rescale, then the response curve. */
    steer() {
      const v = this.stickX(0);
      if (!v) return 0;
      return Math.sign(v) * Math.pow(Math.abs(v), this.curve);
    }

    /** Menu edges, already de-repeated. */
    nav() { return this._navHit; }

    /** The confirm and cancel buttons, as edges. */
    confirmHit() { return this.hit(B.A) || this.hit(B.START); }
    cancelHit() { return this.hit(B.B) || this.hit(B.BACK); }

    /* Rumble. Best-effort in every direction: the API is unevenly implemented,
       the promise it returns rejects on some builds rather than resolving
       false, and a pad without motors reports nothing at all. None of that is
       worth a line of error handling at the call site. */
    vibrate(strength, ms) {
      if (!this.active || !this.rumble) return;
      const g = this.raw;
      const act = g && g.vibrationActuator;
      if (!act || !act.playEffect) return;
      const s = Math.max(0, Math.min(1, strength)) * this.rumble;
      if (s <= 0.001) return;
      try {
        const p = act.playEffect('dual-rumble', {
          startDelay: 0,
          duration: Math.max(16, ms || 120),
          weakMagnitude: s * 0.7,
          strongMagnitude: s,
        });
        if (p && p.catch) p.catch(() => {});
      } catch (e) { /* not supported here */ }
    }

    /** What the controls screen draws. */
    describe() {
      if (!this.present) return { connected: false, name: '', standard: false };
      /* The reported id is a hardware string - "Xbox 360 Controller (XInput
         STANDARD GAMEPAD Vendor: 045e Product: 028e)" - and putting that on
         screen is putting a driver string on screen. The useful half is the
         front of it. */
      let name = this.id || 'CONTROLLER';
      const cut = name.indexOf('(');
      if (cut > 2) name = name.slice(0, cut);
      name = name.replace(/[_-]+/g, ' ').trim().toUpperCase();
      if (name.length > 34) name = name.slice(0, 33) + '…';
      return {
        connected: true,
        name: name || 'CONTROLLER',
        standard: this.mapping === 'standard',
        enabled: this.enabled,
      };
    }
  }

  NR.PAD_BUTTONS = B;
  NR.PAD_MAP = MAP;
  NR.Pad = Pad;
})(typeof window !== 'undefined' ? window : globalThis);
