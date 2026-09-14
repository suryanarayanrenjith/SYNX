#!/usr/bin/env node
/* Walk the whole campaign, down both paths, without driving a metre of it.
 *
 *     node tools/checkstory.js            report and assert
 *     node tools/checkstory.js --print    ...and print every line
 *
 * WHY THIS CAN BE EXHAUSTIVE RATHER THAN A SAMPLE
 * -----------------------------------------------
 * A scene in js/story.js is an array of lines, or a pure function of the run's
 * state that returns one - and the only state it is allowed to read is the
 * context object `storyCtx` builds. So every scene in the game can be resolved
 * here, for every value that context can take, and what comes out is exactly
 * what a player would see. There is no branch this cannot reach.
 *
 * WHAT IT ASSERTS
 * ---------------
 * THE SCRIPT
 *   every scene resolves to lines, and no chapter is silent;
 *   every speaker is in the cast, and every expression that speaker names is a
 *   portrait that actually exists - a typo here is not an error at runtime, it
 *   is a character who quietly wears their neutral face for a whole chapter;
 *   every shot tag is one the camera knows, for the same reason;
 *   a chapter written as path-aware genuinely reads differently either way;
 *   the three decisions can never sum to zero, so there is always an ending;
 *   both endings are reachable, and both carry a cost, a coda and a record;
 *   and no line is empty, or too long for the card it has to fit on.
 *
 * THE FLOW - which is where the reported fault actually lived
 *   the campaign terminates, on every path, with no mode that never hands over
 *   and no conversation that never completes;
 *   every mode it passes through has an entry in the dispatch table;
 *   the three decisions are asked once each and produce the ending they earned;
 *   and A HELD KEY CANNOT WALK A LINE BEFORE IT CAN BE READ, which is the
 *   regression for the opening card going past before it arrived.
 *
 * It needs no browser. story.js is loaded against a stub of the game it hangs
 * off, and for the flow phase everything that DRAWS is replaced with a no-op
 * while everything that DECIDES is the shipped code.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const PRINT = process.argv.includes('--print');
let problems = 0;
const fail = (msg) => { problems++; console.log('  PROBLEM: ' + msg); };
const ok = (msg) => console.log('  ok   ' + msg);

/* The camera's own vocabulary, from `conversationShot`. A tag outside this set
   falls through to `wide`, which is not an error the eye can catch. */
const SHOTS = new Set(['player', 'closeup', 'rival', 'over', 'two', 'low',
  'wheel', 'rear', 'road', 'sky', 'wide']);
/* What one line of a dialogue card can hold before it sets type it cannot
   show. Measured against the widest line that reads correctly in the shipped
   card at the narrowest supported window. */
const MAX_LINE = 116;
const FLOW_DT = 1 / 60;
/* A finished line that a held key can leave faster than this is a line nobody
   reads. Four of them in a row is the opening card going past before it
   arrives, which is exactly what was reported. */
const MIN_DWELL = 0.38;

// ------------------------------------------------------------------ stubs --

function elementStub() {
  const cls = new Set();
  const el = {
    textContent: '', innerHTML: '', value: '', children: [],
    style: { setProperty() {}, removeProperty() {} },
    dataset: {},
    classList: {
      add: (...n) => n.forEach(x => cls.add(x)),
      remove: (...n) => n.forEach(x => cls.delete(x)),
      toggle: (n, on) => { if (on === undefined ? cls.has(n) : !on) cls.delete(n); else cls.add(n); },
      contains: (n) => cls.has(n),
    },
    setAttribute(k, v) { el['a_' + k] = v; },
    getAttribute(k) { return el['a_' + k]; },
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { el.children.push(c); return c; },
    append(...c) { c.forEach(x => el.appendChild(x)); },
    querySelector() { return elementStub(); },
    querySelectorAll() { return []; },
    focus() {}, click() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10 }; },
    offsetWidth: 10,
  };
  return el;
}

function documentStub() {
  const els = Object.create(null);
  return {
    body: elementStub(),
    getElementById(id) { return (els[id] = els[id] || elementStub()); },
    querySelector() { return elementStub(); },
    createElement() { return elementStub(); },
    addEventListener() {}, removeEventListener() {},
    activeElement: null,
  };
}

function carStub() {
  return {
    x: 0, y: 0, z: 0, yaw: 0, sTrack: 0, maxS: 0, minS: 0, lateral: 0,
    vLong: 60, vLat: 0, speed: 60, lift: 1, roadY: 0, pitch: 0, roll: 0,
    boosting: false, offroad: false, driftAmount: 0, bodySlip: 0, impact: 0,
    scrape: 0, lastHit: false, lastHitType: null, beached: 0, wrongWay: 0,
    boost: 1, engineLoad: 0, wheelSpinFx: 0, damage: 0, landed: 0, landing: 0,
    raceModeMultiplier: 1, gripScale: 1, powerScale: 1, speedCap: Infinity,
    reset(s, lat) { this.sTrack = s || 0; this.maxS = this.sTrack; this.lateral = lat || 0; },
    update() {}, placeLateral(s, lat) { this.sTrack = s; this.lateral = lat; },
    armRamp() {}, clearRamp() {}, fitEngine() {},
  };
}

function gameStub() {
  const track = {
    length: 175800,
    at(s, out) { out = out || {}; out.x = 0; out.y = 0; out.z = s; out.yaw = 0; out.curv = 0; out.tunnel = false; return out; },
    project(x, z) { return { s: z, sExact: z, lateral: x, index: 0, yaw: 0, curv: 0 }; },
  };
  const audioCalls = [];
  const audio = new Proxy({}, { get: () => (...a) => { audioCalls.push(a); } });
  return {
    car: carStub(), rival: carStub(), track, audio, audioCalls,
    state: 'menu', levelIndex: 0, diffIndex: 1, distance: 0, progress: 0, time: 0,
    fade: 0, fadeTarget: 0, flash: 0, shake: 0, eye: [0, 0, 0], target: [0, 0, 0], fov: 55,
    startAt: 60, finishAt: 13000, raceTime: 0, countdown: 0, lastBeep: -1,
    won: true, place: 1, rivalGap: 0, raceOver: false, simulating: true,
    cleared: [0, 0, 0, 0, 0, 0, 0],
    levels: [{ from: 60, to: 13000 }], level: { from: 60, to: 13000 },
    difficulties: ['EASY', 'MEDIUM', 'HARD', 'IMPOSSIBLE'],
    driver: { setLevel() {}, reset() {}, personality: null, paceScale: 1, gripScale: 1 },
    scene: { time: 0, wet: 0, sunColor: [1, 1, 1], ambInt: 1 },
    input: { sample: () => ({ throttle: 1, steer: 0, brake: 0, boost: false, ebrake: false }) },
    menuItems: [{}],
    applyLevel() { this.level = this.levels[0]; },
    resetCar() { this.car.reset(this.startAt, -5.5); this.rival.reset(this.startAt, 5.5); },
    updateCamera() {}, updateAtmosphere() {}, idleFlyby() {}, finish() {},
    hideCursorForRun() {}, syncCursorVisibility() {}, toMenu() { this.state = 'menu'; },
    dentBetween() {}, recordImpact() {},
  };
}

function load() {
  const ctx = vm.createContext({ console, performance: { now: () => Date.now() } });
  ctx.window = ctx;
  ctx.global = ctx;
  ctx.setTimeout = () => 0;
  ctx.document = documentStub();
  ctx.addEventListener = () => {};
  const noop = () => {};
  /* The smallest stub story.js will attach to. Everything it reaches for at
     load time and nothing else; the flow phase fills in the rest. */
  ctx.NR = {
    Game: function Game() {}, Vehicle: carStub, Driver: function Driver() {},
    M: { clamp: (v, a, b) => Math.max(a, Math.min(b, v)), damp: (a, b) => b, angDiff: () => 0 },
    M4: { make: () => [], identity: (m) => m, mul: noop },
    Save: { getJSON: () => null, setJSON: noop },
    Pak: { url: (u) => u },
    Gate: { open: () => true, lock: noop, clear: noop },
    collideCars: () => 0,
  };
  ctx.NR.Game.prototype = {};
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web/js/story.js'), 'utf8'), ctx);
  if (!ctx.NR.STORY_CHAPTERS) throw new Error('story.js did not attach to the stub');
  return ctx;
}

// ----------------------------------------------------------- the script ---

function contexts(NR) {
  const out = [];
  for (const resolve of [-3, -1, 0, 1, 3]) {
    out.push({ resolve, path: NR.STORY_PATH_OF(resolve), choices: {}, chapterId: 0 });
  }
  return out;
}

function checkLine(NR, where, line) {
  const CAST = NR.STORY_CAST;
  if (!line || typeof line !== 'object') return fail(where + ': not a line');
  const who = CAST[line.speaker];
  if (!who) return fail(where + ': unknown speaker "' + line.speaker + '"');
  if (typeof line.text !== 'string' || !line.text.trim()) return fail(where + ': empty text');
  for (const part of line.text.split('\n')) {
    if (part.length > MAX_LINE) {
      fail(where + ': ' + part.length + ' characters on one line (max ' + MAX_LINE + ')');
    }
  }
  const exp = line.expression || 'neutral';
  if (!who.art[exp]) {
    fail(where + ': ' + line.speaker + ' has no "' + exp + '" portrait (has: '
      + Object.keys(who.art).join(', ') + ')');
  }
  if (line.shot && !SHOTS.has(line.shot)) fail(where + ': unknown shot "' + line.shot + '"');
  if (line.wait !== undefined && !(line.wait >= 0 && line.wait <= 1.6)) {
    fail(where + ': wait ' + line.wait + ' is outside 0..1.6');
  }
  if (line.hold !== undefined && !(line.hold >= 0 && line.hold <= 2.5)) {
    fail(where + ': hold ' + line.hold + ' is outside 0..2.5');
  }
  if (PRINT) console.log('      ' + String(line.speaker).padEnd(9) + ' | ' + line.text.replace(/\n/g, ' / '));
}

function checkScript(NR) {
  const CH = NR.STORY_CHAPTERS, CHOICES = NR.STORY_CHOICES, ENDINGS = NR.STORY_ENDINGS;
  const scene = NR.STORY_SCENE, pick = NR.STORY_PICK;
  const ctxs = contexts(NR);

  console.log('\n=== CAMPAIGN ===');
  let total = 0;
  for (let id = 1; id <= NR.STORY_LAST_CHAPTER; id++) {
    const c = CH[id];
    if (!c) { fail('chapter ' + id + ' is missing'); continue; }
    const counts = [];
    for (const base of ctxs) {
      const cc = Object.assign({}, base, { chapterId: id });
      let n = 0;
      for (const key of ['coldOpen', 'intro', 'win']) {
        const lines = scene(c[key], cc);
        if (!Array.isArray(lines)) { fail('ch' + id + ' ' + key + ' is not an array'); continue; }
        if (PRINT && lines.length) console.log('    ch' + id + ' ' + key + ' [' + cc.path + ']');
        lines.forEach((l, i) => checkLine(NR, 'ch' + id + ' ' + key + '[' + cc.path + '] #' + i, l));
        n += lines.length;
      }
      counts.push(n);
      const diff = pick(c.diff, cc, 1);
      if (!(diff >= 0 && diff <= 3)) fail('ch' + id + ' difficulty ' + diff + ' is outside 0..3');
      if (typeof pick(c.brief, cc, '') !== 'string') fail('ch' + id + ' brief is not text');
      if (!pick(c.rating, cc, '')) fail('ch' + id + ' has no rating on path ' + cc.path);
    }
    total += counts[0];
    if (counts.every(n => n === 0)) fail('ch' + id + ' has no dialogue at all');

    /* A FORK HAS TO ACTUALLY FORK. Counting lines proves nothing - both sides
       are usually the same length - so this reads the TEXT down each path and
       the difficulty with it. A chapter that declares itself path-aware and
       then says the same thing either way is reported rather than shipped. */
    const at = (p) => ({ resolve: p === 'edge' ? 3 : -3, path: p, choices: {}, chapterId: id });
    const say = (p) => ['coldOpen', 'intro', 'win']
      .map(k => scene(c[k], at(p)).map(l => l.speaker + ':' + l.text).join('|')).join('||');
    const dif = (p) => pick(c.diff, at(p), 1);
    const textForks = say('edge') !== say('open');
    const diffForks = dif('edge') !== dif('open');
    const declared = ['coldOpen', 'intro', 'win', 'diff', 'brief', 'rating']
      .some(k => typeof c[k] === 'function');
    if (declared && !textForks && !diffForks) {
      fail('ch' + id + ' is written as path-aware but reads identically either way');
    }
    console.log('  ch' + id + ' ' + String(c.title).padEnd(15)
      + ' lines ' + String(Math.min.apply(null, counts)).padStart(3)
      + '..' + String(Math.max.apply(null, counts)).padStart(3)
      + (textForks || diffForks
        ? '   branches:' + (textForks ? ' dialogue' : '')
          + (diffForks ? ' difficulty ' + dif('open') + '->' + dif('edge') : '')
        : ''));
  }
  ok(total + ' lines on the default path');

  console.log('\n=== DECISIONS ===');
  const keys = Object.keys(CHOICES);
  if (keys.length !== 3) fail('expected three decisions, found ' + keys.length);
  for (const k of keys) {
    const d = CHOICES[k];
    if (!CH[d.after]) { fail(k + ' hangs off chapter ' + d.after + ', which does not exist'); continue; }
    for (const side of ['edge', 'open']) {
      const sd = d[side];
      if (!sd || !sd.label || !sd.sub || !sd.tag) { fail(k + '.' + side + ' is incomplete'); continue; }
      if (!sd.echo || !sd.echo.length) fail(k + '.' + side + ' has no spoken answer');
      else sd.echo.forEach((l, i) => checkLine(NR, k + '.' + side + '.echo #' + i, l));
    }
    console.log('  ' + k + '  after ch' + d.after + '  ' + d.edge.label + '  /  ' + d.open.label);
  }
  /* THE ARITHMETIC THAT GUARANTEES AN ENDING, enumerated rather than argued:
     three decisions of plus or minus one can never sum to zero. */
  let zero = 0; const reached = { edge: 0, open: 0 };
  for (const a of [1, -1]) for (const b of [1, -1]) for (const c of [1, -1]) {
    const t = a + b + c;
    if (t === 0) zero++;
    reached[t > 0 ? 'edge' : 'open']++;
  }
  if (zero) fail(zero + ' of the eight decision paths sum to zero');
  else ok('all eight decision paths reach an ending (' + reached.edge + ' edge, ' + reached.open + ' open)');

  console.log('\n=== ENDINGS ===');
  for (const key of ['edge', 'open']) {
    const E = ENDINGS[key];
    if (!E) { fail('no "' + key + '" ending'); continue; }
    for (const part of ['lines', 'coda']) {
      if (!E[part] || !E[part].length) { fail(key + ' ending has no ' + part); continue; }
      if (PRINT) console.log('    ' + key + ' ' + part);
      E[part].forEach((l, i) => checkLine(NR, key + '.' + part + ' #' + i, l));
    }
    if (!E.cards || E.cards.length < 3) fail(key + ' ending has fewer than three closing cards');
    for (const c of (E.cards || [])) {
      if (!Array.isArray(c) || c.length !== 3) fail(key + ' ending has a malformed card');
    }
    if (!E.title || !E.subtitle || !E.kicker) fail(key + ' ending is missing its card text');
    /* Both endings have to END: the player and Ryker both have to be given
       somewhere to land. Ryker may land in either skin - in one ending the
       last thing he says is said through the machine wearing him, which is
       that ending rather than an omission. */
    const cast = new Set((E.lines || []).concat(E.coda || []).map(l => l.speaker));
    if (!cast.has('PLAYER')) fail(key + ' ending never gives PLAYER a line');
    if (!cast.has('RYKER') && !cast.has('RAPTOR')) {
      fail(key + ' ending never gives Ryker a line, in either skin');
    }
    console.log('  ' + String(E.title).padEnd(20)
      + ' cost ' + String(E.lines.length).padStart(3)
      + '   coda ' + String(E.coda.length).padStart(3)
      + '   cards ' + (E.cards || []).length);
  }
}

// ------------------------------------------------------------- the flow ---

/** Replace everything that draws with a no-op, keeping everything that decides. */
function muteRendering(SM) {
  const P = SM.prototype;
  const noop = function () {};
  for (const k of ['baseTick', 'conversationShot', 'establishingShot', 'carShot',
    'pairShot', 'overShot', 'trackShot', 'commitShot', 'cutTo', 'pulseScan',
    'textBlip', 'silenceCar', 'updateStoryAtmosphere', 'spawnInvitationalPack',
    'updateInvitationalPack', 'resolveInvitationalCollisions', 'tutorialTick']) P[k] = noop;
  P.setVehicle = function (car, s, lateral) { if (car) { car.sTrack = s; car.lateral = lateral || 0; } };
  P.guardEye = function (eye) { return eye; };
}

/* StoryManager is a class, so it is constructed rather than applied - and its
   constructor reads `global.document`, which is why the sandbox's document is
   swapped before it runs. NR.Save is stubbed empty, so every run here is a
   first playthrough rather than whatever is in this machine's storage. */
function makeStory(ctx, g) {
  ctx.document = documentStub();
  const story = new ctx.NR.StoryManager(g);
  g.story = story;
  return story;
}

/** One simulated ENTER per frame - a HELD key - for as long as a card is up. */
function pump(story, state) {
  if (!story.dialogue.active) return;
  const before = story.dialogue.index;
  const wasTyping = !story.dialogue.finishedLine;
  story.dialogue.advance();
  if (story.dialogue.index !== before || !story.dialogue.active) {
    state.lines++;
    if (!wasTyping) state.fastest = Math.min(state.fastest, state.age);
    state.age = 0;
  }
}

/* `carry` replays on an existing manager and its existing save, which is what
   the closing card promises: the other ending is reachable from the same seven
   chapters by deciding differently. */
function runCampaign(ctx, choices, carry) {
  const g = carry ? carry.g : gameStub();
  const story = carry ? carry.story : makeStory(ctx, g);
  const seen = new Set();
  const asked = [];
  const state = { lines: 0, fastest: Infinity, age: 0 };
  const LIMIT = 60 * 60 * 30;
  let frames = 0;

  story.startChapter(1, {});
  while (frames++ < LIMIT) {
    seen.add(story.mode);
    story.update(FLOW_DT);
    state.age += FLOW_DT;
    pump(story, state);

    if (story.mode === 'choice' && story.pendingChoice) {
      const which = choices[story.pendingChoice.id] || 'open';
      asked.push(story.pendingChoice.id + ':' + which);
      story.commitChoice(which);
      continue;
    }
    if (story.mode === 'continuePrompt') { story.chooseContinue(true); continue; }
    /* The race belongs to the game, so it is resolved the way the game
       resolves it: the player crosses the line in front. */
    if (story.mode === 'race') {
      g.won = true;
      g.car.sTrack = g.finishAt + 10;
      story.handleFinish(function () {});
      continue;
    }
    if (story.mode === 'hub' || story.mode === 'none') break;
  }
  return {
    seen, asked, frames, lines: state.lines, fastest: state.fastest,
    ending: story.save.endingSeen, resolve: story.save.resolve,
    completed: story.save.completedChapters.slice(), timedOut: frames >= LIMIT,
    story, g,
  };
}

/* The opening, which is where the reported fault lived: the prologue, its
   anonymous card, and the tutorial that follows it. */
function runPrologue(ctx) {
  const g = gameStub();
  const story = makeStory(ctx, g);
  const seen = new Set();
  const state = { lines: 0, fastest: Infinity, age: 0 };
  const LIMIT = 60 * 60 * 8;
  let frames = 0;
  story.startPrologue(false);
  while (frames++ < LIMIT) {
    seen.add(story.mode);
    story.update(FLOW_DT);
    state.age += FLOW_DT;
    pump(story, state);
    if (story.mode === 'coldOpen' || story.mode === 'chapterTitle') break;
  }
  return { seen, frames, lines: state.lines, fastest: state.fastest, timedOut: frames >= LIMIT };
}

/* THE DISPATCH TABLE, READ OUT OF THE DISPATCHER.
 *
 * This used to be a hand-written list of the modes js/story.js knows how to
 * update, and it went stale the first time a mode was added: `endingCredits`
 * was wired into the switch and into both endings, and this check failed four
 * paths for a mode the game handles perfectly well. A test that fails when the
 * code is EXTENDED rather than when it breaks is a test people learn to
 * ignore.
 *
 * So the set comes from the switch itself. Adding a mode and a handler
 * together now passes silently, which is correct; adding a mode WITHOUT a
 * handler still fails, which is the thing this was written to catch. */
const DISPATCH = (() => {
  const src = fs.readFileSync(path.join(ROOT, 'web/js/story.js'), 'utf8');
  const at = src.indexOf('switch (this.mode)');
  if (at < 0) throw new Error('js/story.js no longer dispatches on this.mode');
  const end = src.indexOf('default: break;', at);
  if (end < 0) throw new Error('the mode switch in js/story.js has no default arm');
  const out = new Set(['none']);
  const re = /case '([A-Za-z0-9_]+)':/g;
  let m;
  const body = src.slice(at, end);
  while ((m = re.exec(body))) out.add(m[1]);
  if (out.size < 8) throw new Error('only ' + out.size + ' modes found - the switch was not parsed');
  return out;
})();

function checkFlow(ctx) {
  const NR = ctx.NR;
  console.log('\n=== FLOW ===');
  muteRendering(NR.StoryManager);

  const runs = [
    ['every decision EDGE', { d1: 'edge', d2: 'edge', d3: 'edge' }, 'edge', 3],
    ['every decision OPEN', { d1: 'open', d2: 'open', d3: 'open' }, 'open', -3],
    ['split, leaning EDGE', { d1: 'edge', d2: 'open', d3: 'edge' }, 'edge', 1],
    ['split, leaning OPEN', { d1: 'open', d2: 'edge', d3: 'open' }, 'open', -1],
  ];
  for (const row of runs) {
    const name = row[0];
    let r;
    try { r = runCampaign(ctx, row[1]); }
    catch (e) { fail(name + ': threw - ' + e.message); continue; }
    if (r.timedOut) { fail(name + ': the campaign never reached the hub'); continue; }
    if (r.completed.length !== NR.STORY_LAST_CHAPTER) {
      fail(name + ': completed ' + r.completed.length + ' of ' + NR.STORY_LAST_CHAPTER + ' chapters');
    }
    if (r.asked.length !== 3) fail(name + ': ' + r.asked.length + ' decisions asked, expected 3');
    if (r.resolve !== row[3]) fail(name + ': resolve came to ' + r.resolve + ', expected ' + row[3]);
    if (r.ending !== row[2]) fail(name + ': reached "' + r.ending + '", expected "' + row[2] + '"');
    for (const m of r.seen) {
      if (!DISPATCH.has(m)) fail(name + ': mode "' + m + '" has no entry in the dispatch table');
    }
    if (r.fastest < MIN_DWELL) {
      fail(name + ': a finished line was left after only ' + r.fastest.toFixed(3)
        + 's of a held key - a conversation can be walked through again');
    }
    const E = NR.STORY_ENDINGS[r.ending] || {};
    console.log('  ' + name.padEnd(21)
      + String(r.lines).padStart(4) + ' lines'
      + '   ' + (r.frames * FLOW_DT / 60).toFixed(1) + ' min'
      + '   min dwell ' + r.fastest.toFixed(2) + 's'
      + '   -> ' + E.title);
  }

  /* THE CLAIM ON THE CLOSING CARD, TESTED.
     Finish the campaign one way, then play it again on the same save deciding
     the other way, and the ending has to change. If a decision were only ever
     asked once - which is how it was first written - this run would end where
     the first one did and the card would be lying. */
  try {
    const first = runCampaign(ctx, { d1: 'edge', d2: 'edge', d3: 'edge' });
    const again = runCampaign(ctx, { d1: 'open', d2: 'open', d3: 'open' },
      { story: first.story, g: first.g });
    if (first.ending !== 'edge') fail('replay: the first run did not reach the EDGE ending');
    else if (again.ending !== 'open') {
      fail('replay: deciding the other way still ended on "' + again.ending
        + '" - the second ending is unreachable without wiping the save');
    } else if (again.asked.length !== 3) {
      fail('replay: only ' + again.asked.length + ' decisions were re-asked');
    } else {
      console.log('  ' + 'replay, decided anew'.padEnd(21)
        + String(again.lines).padStart(4) + ' lines'
        + '   resolve ' + first.resolve + ' -> ' + again.resolve
        + '   -> ' + NR.STORY_ENDINGS[again.ending].title);
    }
  } catch (e) { fail('replay: threw - ' + e.message); }

  let p;
  try { p = runPrologue(ctx); }
  catch (e) { return fail('the prologue threw - ' + e.message); }
  if (!p.lines) fail('the prologue played no dialogue at all');
  if (p.timedOut) fail('the prologue never handed over to Chapter 1');
  if (p.fastest < MIN_DWELL) {
    fail('a prologue line was left after only ' + p.fastest.toFixed(3)
      + 's of a held key - the opening card can still be walked past');
  }
  for (const m of ['prologue', 'prologueDialogue', 'tutorial']) {
    if (!p.seen.has(m)) fail('the prologue never entered "' + m + '"');
  }
  console.log('  ' + 'prologue -> chapter 1'.padEnd(21)
    + String(p.lines).padStart(4) + ' lines'
    + '   ' + (p.frames * FLOW_DT).toFixed(0) + ' s'
    + '   min dwell ' + p.fastest.toFixed(2) + 's');
  if (!problems) ok('every path terminates, paces and lands the ending it earned');
}

function main() {
  const ctx = load();
  checkScript(ctx.NR);
  checkFlow(ctx);
  console.log('\n' + (problems
    ? problems + ' problem(s) in the campaign\n'
    : 'the campaign is complete, both paths resolve and both endings land\n'));
  process.exitCode = problems ? 1 : 0;
}

main();
