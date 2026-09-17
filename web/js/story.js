/* SYNX Story Mode - WELCOME TO THE NIGHT
 *
 * StoryManager is deliberately a director above the existing game. Vehicle,
 * camera, renderer, AI, route and race-result authority remain in Game. This
 * file supplies the save state, the cast, the seven-chapter campaign, the shot
 * language the cutscenes are cut in, and the short seams between those systems.
 *
 * THE SHOT LANGUAGE
 * -----------------
 * Cutscene cameras used to be a switch over four names that pointed at
 * `g.rival` whenever it could not identify a speaker. On any chapter where the
 * speaker had no car in the scene - the network relay, the broadcast, Nova and
 * Kael during Chapter 5's two-car Exhibition - that meant every one of their
 * lines was framed on Ryker's bonnet.
 *
 * Shots are now resolved from three facts: who is speaking, whether that
 * speaker has a body on the road, and who they are speaking to. A speaker with
 * no car never borrows somebody else's; the camera goes to the listener or to
 * a broadcast crane instead. On top of that every shot carries a dolly and a
 * little handheld, and the camera damps toward its mark rather than snapping,
 * so a cut is crisp and the shot between cuts breathes.
 */
(function (global) {
  'use strict';

  const NR = global.NR;
  if (!NR || !NR.Game || NR.StoryManager) return;

  const { M, M4 } = NR;
  const SAVE_KEY = 'synx.story.v2';
  const LEGACY_SAVE_KEY = 'synx.story.v1';
  const LEGACY_PROGRESS_KEY = 'synx.progress.v1';
  const LAST_CHAPTER = 7;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
  const damp = (a, b, rate, dt) => (M && M.damp ? M.damp(a, b, rate, dt) : b + (a - b) * Math.exp(-rate * dt));

  /* ------------------------------------------------------------- the cast --
     Name, the role strip under the nameplate, the accent colour the whole
     dialogue frame takes on while they speak, and whether they own a car the
     camera is allowed to point at. `body` is what stops a broadcast voice from
     stealing a rival's close-up. */
  const CAST = {
    PLAYER: {
      name: 'YOU', role: 'SYNX GRID // DRIVER', voice: '#39e6ff', body: 'player',
      art: {
        neutral: 'sprites/Player_IDLE.jpeg', focus: 'sprites/Player_Focus.jpeg',
        surprised: 'sprites/Player_surprised.jpeg', shocked: 'sprites/Player_surprised.jpeg',
        smirk: 'sprites/Player_Smirk.jpeg', race: 'sprites/Player_raceMode.jpeg',
        damaged: 'sprites/Player_Damaged.jpeg', battle: 'sprites/PlayerBattleCard.jpeg',
      },
    },
    RYKER: {
      name: 'RYKER', role: 'GRID RANK 01 // VECTOR', voice: '#ff2e88', body: 'rival',
      art: {
        neutral: 'sprites/Ryker_IDLE.jpeg', smug: 'sprites/Ryker_smirk.jpeg',
        amused: 'sprites/Ryker_laugh.jpeg', angry: 'sprites/Ryker_angry.jpeg',
        concerned: 'sprites/Ryker_sad.jpeg', shocked: 'sprites/Ryker_sad.jpeg',
        damaged: 'sprites/Ryker_damaged.jpeg', battle: 'sprites/Ryker_Battlecard.jpeg',
      },
    },
    KAEL: {
      name: 'KAEL', role: '"CRASH" MORROW // OFF-ROUTE', voice: '#ffb400', body: 'rival',
      art: {
        neutral: 'sprites/Kael_IDLE.jpeg', smug: 'sprites/Kael_Smirk.jpeg',
        amused: 'sprites/Kael_laugh.jpeg', adrenaline: 'sprites/Kael_adrenaline.jpeg',
        concerned: 'sprites/Kael_dissapointed.jpeg', shocked: 'sprites/Kael_dissapointed.jpeg',
        damaged: 'sprites/Kael_Damaged.jpeg', battle: 'sprites/Kael_Battlecard.jpeg',
      },
    },
    NOVA: {
      name: 'NOVA', role: 'VEYRA // EX-AURORA TEST DRIVER', voice: '#8b5cf6', body: 'rival',
      art: {
        neutral: 'sprites/Nova_neutral.jpeg', calm: 'sprites/Nova_IDLE.jpeg',
        calculating: 'sprites/Nova_calculating.jpeg', smug: 'sprites/Nova_smirk.jpeg',
        concerned: 'sprites/Nova_calculating.jpeg', shocked: 'sprites/Nova_neutral.jpeg',
        battle: 'sprites/Nove_battlecard.jpeg',
      },
    },
    JAVAS: {
      name: 'JAVAS', role: 'AURORA // FORMER LEAD ENGINEER', voice: '#39e6ff', body: 'rival',
      art: {
        neutral: 'sprites/Javas_neutral.png', calm: 'sprites/Javas_neutral.png',
        calculating: 'sprites/Javas_neutral.png', smug: 'sprites/Javas_neutral.png',
        concerned: 'sprites/Javas_neutral.png', battle: 'sprites/Javas_neutral.png',
      },
    },
    /* The R-IX speaks on Ryker's channel, in Ryker's voice, with Ryker's face
       on the relay. The portrait is deliberately his - corrupted - because the
       point of the character is that it is wearing him. */
    RAPTOR: {
      name: 'R-IX', role: 'AURORA EXPERIMENTAL // RAPTOR', voice: '#ff3b1e', body: 'rival',
      corrupt: true,
      art: {
        neutral: 'sprites/Ryker_IDLE.jpeg', smug: 'sprites/Ryker_smirk.jpeg',
        amused: 'sprites/Ryker_laugh.jpeg', angry: 'sprites/Ryker_angry.jpeg',
        concerned: 'sprites/Ryker_sad.jpeg', damaged: 'sprites/Ryker_damaged.jpeg',
        battle: 'sprites/Ryker_Battlecard.jpeg',
      },
    },
    GRID: {
      name: 'SYNX GRID', role: 'NETWORK RELAY', voice: '#39e6ff', body: null,
      art: { neutral: 'sprites/SYNX_Grid_Unknown.png', radio: 'sprites/SYNX_Grid_Unknown.png', battle: 'sprites/SYNX_Grid_Unknown.png' },
    },
    AURORA: {
      name: 'AURORA', role: 'MOTORWORKS // BROADCAST', voice: '#f2f0ff', body: null,
      art: { neutral: 'sprites/SYNX_Grid_Unknown.png', radio: 'sprites/SYNX_Grid_Unknown.png', battle: 'sprites/SYNX_Grid_Unknown.png' },
    },
    ANNOUNCER: {
      name: 'RACE CONTROL', role: 'MIDNIGHT INVITATIONAL', voice: '#ffb400', body: null,
      art: { neutral: 'sprites/SYNX_Grid_Unknown.png', radio: 'sprites/SYNX_Grid_Unknown.png', battle: 'sprites/SYNX_Grid_Unknown.png' },
    },
    UNKNOWN: {
      name: 'UNKNOWN', role: 'OPEN CHANNEL // NO ID', voice: '#8b5cf6', body: null,
      art: { neutral: 'sprites/SYNX_Grid_Unknown.png', radio: 'sprites/SYNX_Grid_Unknown.png', battle: 'sprites/SYNX_Grid_Unknown.png' },
    },
  };

  /* THE GATE.
     Free Roam opens when the campaign is finished, and "finished" has to be
     answerable by a screen that does not own a StoryManager - the driver
     terminal is painted before a chapter has ever been entered. So it is read
     off the SAVE, which is the thing that actually records it, and exported
     as a plain function rather than as a method. */
  function campaignComplete(save) {
    const s = save || StorySave.load();
    return !!(s && Array.isArray(s.completedChapters)
      && s.completedChapters.map(Number).indexOf(LAST_CHAPTER) >= 0);
  }

  function cast(id) { return CAST[id] || CAST.UNKNOWN; }
  /* Every portrait in the game is resolved here, which is why the pack is
     consulted here rather than at each of the six assignment sites. */
  function portraitOf(speaker, expression, battle) {
    const set = cast(speaker).art;
    const p = battle ? (set.battle || set.neutral) : (set[expression] || set.neutral || set.radio);
    return p ? global.NR.Pak.url(p) : p;
  }

  /* ---------------------------------------------------------- the campaign --
   *
   * SEVEN CHAPTERS, ONE QUESTION, TWO ANSWERS.
   *
   * EVERY PERSON IN THIS STORY IS ONE THE PLAYER RACES. There is no missing
   * driver, no off-screen victim, no name in a list. The campaign is carried by
   * the five characters the game actually has art, a voice and a car for -
   * Ryker, Kael, Nova, Javas and the thing wearing Ryker at the end of it - and
   * every beat is something one of them says to your face.
   *
   * THE SPINE. Aurora Motorworks is finishing an autonomous chassis, and a
   * driver model can only close on a driver it can PREDICT. So what Aurora
   * needs is not the best driver on the Grid. It is the most REPEATABLE one.
   *
   * That is Ryker, and it is the cruelty at the centre of this: nine years at
   * rank one driving the same immaculate line every night, and the reason they
   * have never once asked him to drive for them is that they never wanted a
   * driver. They wanted a template. He has spent nine years reading their
   * silence as a verdict on him.
   *
   * The player is the opposite and does not know it either: unreadable, never
   * twice the same corner. That is the one thing the model is missing, which is
   * why Aurora flags a rookie in a fortnight and why Ryker cannot forgive it.
   *
   *   KAEL  races where nothing records, because he noticed what happens to
   *         drivers Aurora logs: they get SMOOTHER. They stop improvising.
   *   NOVA  built half the handling model and left the afternoon she read what
   *         the other half was for.
   *   JAVAS designed the driver link. It was meant to let a car learn from a
   *         driver. They turned it round, and it does not close by itself.
   *
   * THE SHAPE is a foldback, which is the structure that lets a branching story
   * keep one set of levels: the routes, the rivals and the running order never
   * change, and three decisions steer the DIALOGUE, the DIFFICULTY and the
   * ending between them. Paths diverge after a chapter and converge at the
   * start of the next, so no beat is ever missed and no route is built twice.
   *
   * ALL THREE DECISIONS ARE ABOUT RYKER, because he is what the story is about.
   *
   *   EDGE  keep it to yourself. Nobody owes you anything, the next rival
   *         arrives a difficulty higher, and you race with no one in your ear.
   *   OPEN  bring them in. The rival stays where it is and you spend the race
   *         being told what it is about to do.
   *
   * Three decisions of plus or minus one can never sum to zero, so there is
   * always an ending and it is always the one the player drove to.
   *
   * A SCENE is an array of lines, or a function of the run's state returning
   * one. A LINE is { speaker, expression, text, shot } plus two optional pacing
   * controls: `wait` holds a beat before the line types, `hold` keeps it on
   * screen after it finishes. Both are for the few moments a campaign gets
   * where the silence is the line.
   */

  /* Which way the player has been leaning, as a word, so a scene can read it
     without doing arithmetic. Nothing is decided until the first choice lands,
     and until then a scene gets the warmer of its two readings. */
  function pathOf(resolve) {
    const r = resolve | 0;
    return r > 0 ? 'edge' : r < 0 ? 'open' : 'none';
  }
  /* Flattened one level on the way out, so a fork may return a RUN of lines
     inline - `fork(ctx, [a, b], [c])` - rather than having to be spliced by
     the author. A nested array would otherwise arrive at the card as a single
     line with no speaker: a whole beat replaced by a blank frame. */
  function scene(v, ctx) {
    const r = typeof v === 'function' ? v(ctx) : v;
    return r ? [].concat.apply([], r) : [];
  }
  function pick(v, ctx, fallback) {
    const r = typeof v === 'function' ? v(ctx) : v;
    return r === undefined || r === null ? fallback : r;
  }
  /** The EDGE reading of a beat, or the OPEN one. `none` reads as OPEN. */
  function fork(ctx, edge, open) { return ctx && ctx.path === 'edge' ? edge : open; }

  /* ------------------------------------------------------------ the forks --
   *
   * Three, each offered the moment the chapter it belongs to has finished
   * paying off - so it is a decision about what the player has just learned
   * rather than a menu between two levels.
   *
   * Every one of them is a real trade and none of them is the kind one. The
   * second is the one that puts Ryker in the car, and it does so whichever way
   * it is answered: that is the point of it, and both players should feel it
   * was theirs.
   */
  const CHOICES = {
    d1: {
      after: 2, weight: 1,
      kicker: 'DECISION // WHAT KAEL FOUND',
      question: 'AURORA HAS NINE YEARS OF RYKER',
      detail: 'Every lap he has ever driven, logged and modelled. Kael says the file is closed - they are not still collecting. They already have what they wanted from him.',
      edge: {
        label: 'SAY NOTHING', sub: 'IT IS NOT YOUR CHANNEL',
        tag: 'He is the only person on this Grid who can beat you. A rattled Ryker is a slower Ryker, and you know it.',
        echo: [
          { speaker: 'KAEL', expression: 'concerned', text: "You're not going to tell him.", shot: 'rival' },
          { speaker: 'PLAYER', expression: 'focus', text: 'He would not believe me. He would just drive angry.', shot: 'player' },
          { speaker: 'KAEL', expression: 'neutral', text: 'Yeah. That is the bit you like.', shot: 'closeup', wait: 0.4, hold: 1.2 },
        ],
      },
      open: {
        label: 'TELL HIM', sub: 'ON AN OPEN CHANNEL',
        tag: 'Nine years of his life is in a file he has never seen. He has earned the right to be the one who decides what that means.',
        echo: [
          { speaker: 'PLAYER', expression: 'neutral', text: 'Ryker. They have been logging you since before I could drive.', shot: 'player' },
          { speaker: 'RYKER', expression: 'amused', text: 'Of course they have. I am rank one.', shot: 'rival' },
          { speaker: 'RYKER', expression: 'angry', text: 'And if you ever pity me on an open channel again I will put you in the seawall.', shot: 'closeup', hold: 1.3 },
        ],
      },
    },
    d2: {
      after: 4, weight: 1,
      kicker: 'DECISION // THE SEAT',
      question: 'THE EXHIBITION SEAT IS YOURS',
      detail: 'Whoever holds it drives the R-IX at Ashfall. Ryker has wanted that seat for nine years and Aurora has never once asked him for it.',
      edge: {
        label: 'KEEP IT', sub: 'FINISH THIS YOURSELF',
        tag: 'If the car is the only way to see what they built, you will be the one sitting in it.',
        echo: [
          { speaker: 'RYKER', expression: 'angry', text: 'Of course you keep it.', shot: 'rival' },
          { speaker: 'PLAYER', expression: 'focus', text: 'I won it.', shot: 'player' },
          { speaker: 'RYKER', expression: 'concerned', text: 'You won it in a fortnight. I have been asking for nine years and they have never once said my name.', shot: 'closeup', wait: 0.4, hold: 1.3 },
        ],
      },
      open: {
        label: 'REFUSE IT', sub: 'LET IT GO DOWN THE ORDER',
        tag: 'Aurora hands it to the next name on the sheet. There is only one name above yours, and it has been there for nine years.',
        echo: [
          { speaker: 'NOVA', expression: 'shocked', text: 'You know who is second.', shot: 'over' },
          { speaker: 'PLAYER', expression: 'neutral', text: 'I know.', shot: 'player', hold: 1.0 },
          { speaker: 'RYKER', expression: 'smug', text: 'They asked me. Thirty-one seconds after you turned it down.', shot: 'rival' },
          { speaker: 'RYKER', expression: 'amused', text: 'Do not look like that. This is the best night of my life.', shot: 'closeup', hold: 1.3 },
        ],
      },
    },
    d3: {
      after: 6, weight: 1,
      kicker: 'DECISION // THE LINK',
      question: 'JAVAS CAN REACH THE R-IX FROM THE ROAD',
      detail: 'The driver link runs both ways. He can push a corrupted sync down it and end the model on the deck - or hold it open and read the operator back out, if you can stay unpredictable long enough for it to keep failing to close.',
      edge: {
        label: 'BURN IT', sub: 'END THE PROGRAMME',
        tag: 'One sync and the model is gone, tonight, for good. Everything on it goes with it. Everything.',
        echo: [
          { speaker: 'NOVA', expression: 'shocked', text: 'Say what you are actually choosing.', shot: 'over' },
          { speaker: 'PLAYER', expression: 'focus', text: 'That they never get to do this to anybody else.', shot: 'player', hold: 1.1 },
          { speaker: 'JAVAS', expression: 'concerned', text: '...I will have the sync built by midnight.', shot: 'closeup', wait: 0.6 },
        ],
      },
      open: {
        label: 'PULL HIM OUT', sub: 'THIRTY KILOMETRES OF IT',
        tag: 'The link stays open only while it cannot predict you. Never take the same corner twice - not once, not anywhere - and Javas reads him back out on the way.',
        echo: [
          { speaker: 'JAVAS', expression: 'concerned', text: 'Thirty kilometres. If it gets a lock on you even once, the link shuts and he stays in there.', shot: 'over' },
          { speaker: 'PLAYER', expression: 'focus', text: 'Then it does not get one.', shot: 'player', hold: 1.1 },
          { speaker: 'NOVA', expression: 'calm', text: '...That is the first thing anybody has said in this factory that I believe.', shot: 'closeup' },
        ],
      },
    },
  };

  const CHAPTERS = [
    null,
    {
      id: 1, title: 'FIRST BLOOD', track: 'VECTOR RUN', rival: 'RYKER',
      cardFace: 'smug',
      levelIndex: 0, personality: 'ryker', diff: 2,
      rating: 'UNRANKED → ROOKIE',
      brief: 'RANK ONE HAS BEEN CALLING THE CHANNEL FOR A MONTH.\nNOBODY HAS ANSWERED IT.',
      /* A COLD OPEN, and every chapter has one. The old structure put ten
         lines between the menu and the road, which is a conversation with a
         race stapled to the end of it. Two or three lines land first, over a
         moving car and before the title card. */
      coldOpen: [
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Somebody answered.', shot: 'road', hold: 0.8 },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Thirty-one nights I have had this channel open. Say something.', shot: 'sky' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'Where do you want it.', shot: 'player' },
      ],
      intro: [
        { speaker: 'RYKER', expression: 'smug', text: 'Vector Run. Where else.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'You called the whole Grid for a month for one run?', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'I called the whole Grid for a month because nobody comes any more.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'neutral', text: 'They watch the replays from somewhere warm and they go to bed.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'smug', text: 'Eleven minutes of dark a night, and everyone has decided it is mine.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Then hand it over.', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'There it is.', shot: 'closeup', hold: 0.8 },
        { speaker: 'RYKER', expression: 'smug', text: 'Vector to the seawall. Try keeping me in the frame.', shot: 'two' },
      ],
      win: [
        { speaker: 'GRID', expression: 'radio', text: 'GRID RATING UPDATED\nUNRANKED → ROOKIE', shot: 'sky' },
        { speaker: 'RYKER', expression: 'shocked', text: '...', shot: 'closeup', hold: 1.1 },
        { speaker: 'RYKER', expression: 'neutral', text: 'Nine months. Nobody has done that in nine months.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'You sound pleased about it.', shot: 'player' },
        { speaker: 'RYKER', expression: 'concerned', text: 'You have no idea how boring it is up here.', shot: 'closeup', wait: 0.4, hold: 1.0 },
        { speaker: 'GRID', expression: 'radio', text: 'EXTERNAL RELAY // TELEMETRY REQUEST\nAURORA MOTORWORKS - GRANTED', shot: 'sky', wait: 0.5 },
        { speaker: 'PLAYER', expression: 'surprised', text: 'What was that?', shot: 'player' },
        { speaker: 'RYKER', expression: 'smug', text: 'Somebody watching. Get used to it - that is what winning buys you.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Same time tomorrow. Do not make me call the channel again.', shot: 'two', hold: 0.9 },
      ],
    },
    {
      id: 2, title: 'NO BRAKES', track: 'THE SPINE', rival: 'KAEL',
      cardFace: 'amused',
      levelIndex: 1, personality: 'kael', diff: 2,
      rating: 'ROOKIE → STREET',
      brief: 'KAEL MORROW RACES WHERE NOTHING RECORDS.\nHE HAS A REASON AND NOBODY BELIEVES IT.',
      coldOpen: [
        { speaker: 'GRID', expression: 'radio', text: 'CHANNEL 7 // 4,200 LISTENING', shot: 'sky' },
        { speaker: 'KAEL', expression: 'amused', text: 'You beat Ryker on Vector. On camera. On the lit road.', shot: 'road' },
        { speaker: 'KAEL', expression: 'concerned', text: 'Congratulations. You are on file now.', shot: 'rival', hold: 0.8 },
      ],
      intro: [
        { speaker: 'PLAYER', expression: 'neutral', text: 'On file with who?', shot: 'player' },
        { speaker: 'KAEL', expression: 'smug', text: 'Every metre of Vector is a camera. That is the whole reason people race it.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'adrenaline', text: 'The Spine is not. Service road, freight ramps, whatever is holding up the overpass this week.', shot: 'road' },
        { speaker: 'PLAYER', expression: 'surprised', text: "Half of that isn't road.", shot: 'player' },
        { speaker: 'KAEL', expression: 'amused', text: 'Exactly. Nothing out here is recording.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'neutral', text: 'Beat me on it and I will show you what I have been collecting.', shot: 'two' },
      ],
      win: [
        { speaker: 'KAEL', expression: 'damaged', text: '...', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'amused', text: 'HAHAHA! You took the ramp!', shot: 'rival' },
        { speaker: 'KAEL', expression: 'smug', text: 'Okay. You are actually fun. Come and look at this.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'neutral', text: 'Aurora has been pulling telemetry off this Grid for nine years. One driver, the whole time.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Ryker.', shot: 'player', hold: 0.8 },
        { speaker: 'KAEL', expression: 'concerned', text: 'Every lap he has ever driven. And here is the part that kept me off the lit roads.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'adrenaline', text: 'The file is CLOSED. They stopped collecting in March. They already have everything he does.', shot: 'rival', wait: 0.4, hold: 1.2 },
        { speaker: 'PLAYER', expression: 'shocked', text: 'Everything he does.', shot: 'player' },
        { speaker: 'KAEL', expression: 'neutral', text: 'He drives the same line every night. To the centimetre. Nine years of it.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'concerned', text: 'That is not a driver they are watching. That is a driver they have finished reading.', shot: 'two', hold: 1.3 },
      ],
    },
    {
      id: 3, title: 'QUEEN OF NEON', track: 'MIRAGE CIRCUIT', rival: 'NOVA',
      cardFace: 'calculating',
      levelIndex: 2, personality: 'nova',
      /* DIFFICULTY IS CHARACTERISATION. Sitting on what Kael found puts
         Aurora's own former test driver across from you in a mood, and she
         drives like it. Telling Ryker buys you a rival at her ordinary pace
         and a crew who talk to you through the race. */
      diff: (ctx) => fork(ctx, 3, 2),
      rating: 'STREET → VECTOR',
      brief: (ctx) => fork(ctx,
        'NOVA VEYRA BUILT HALF OF WHAT IS COMING.\nSHE HAS READ WHAT YOU DID WITH KAEL\'S FILE.',
        'NOVA VEYRA BUILT HALF OF WHAT IS COMING.\nSHE WANTS TO SEE WHAT AURORA FLAGGED.'),
      coldOpen: (ctx) => fork(ctx, [
        { speaker: 'NOVA', expression: 'calculating', text: 'Kael showed you the file. You sat on it.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'It was not mine to hand over.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'No. It was his. That is rather the point.', shot: 'closeup', hold: 1.1 },
      ], [
        { speaker: 'NOVA', expression: 'calm', text: 'You told him. On an open channel, in front of four thousand people.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'He took it well.', shot: 'player' },
        { speaker: 'NOVA', expression: 'smug', text: 'He threatened to put you in a wall. For Ryker that is gratitude.', shot: 'closeup', hold: 0.9 },
      ]),
      intro: (ctx) => [
        { speaker: 'NOVA', expression: 'calm', text: 'Mirage. In this weather. On purpose.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'You picked it.', shot: 'player' },
        { speaker: 'NOVA', expression: 'calculating', text: 'I picked it because wet Mirage is the only route on this Grid where being fast is not enough.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'neutral', text: 'Six years I drove for Aurora. I built half the handling model that is coming for all of us.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'You built it.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'I built the half that drives. Then I read what the other half was for and I left the same afternoon.', shot: 'closeup', hold: 1.0 },
        { speaker: 'PLAYER', expression: 'focus', text: 'What is the other half for?', shot: 'player' },
        { speaker: 'NOVA', expression: 'calculating', text: 'It does not learn to drive. It learns A DRIVER. One, specifically, all the way down.', shot: 'rival', wait: 0.4, hold: 1.2 },
        fork(ctx,
          { speaker: 'NOVA', expression: 'calculating', text: 'And you are keeping quiet about whose. So no, I am not going to be gentle tonight.', shot: 'closeup' },
          { speaker: 'NOVA', expression: 'calm', text: 'You told him. That is more than I did, and I knew for six years.', shot: 'closeup' }),
        { speaker: 'NOVA', expression: 'smug', text: 'Now. Are you actually fast, or just unrepeatable enough to be interesting to them?', shot: 'two' },
      ],
      win: (ctx) => [
        { speaker: 'NOVA', expression: 'calculating', text: "You're abusing the rear differential.", shot: 'over' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'I won.', shot: 'player' },
        { speaker: 'NOVA', expression: 'neutral', text: 'You won because you are never twice in the same place.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: 'Every driver on this Grid converges. Six laps and I can drive their line better than they can.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'concerned', text: 'I have three corners of you and none of them agree with each other.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: "That's a compliment?", shot: 'player' },
        { speaker: 'NOVA', expression: 'neutral', text: 'It is the reason they flagged you in a fortnight and left Ryker alone for nine years.', shot: 'rival', hold: 1.0 },
        { speaker: 'PLAYER', expression: 'shocked', text: 'They left him alone because he is TOO good?', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'They left him alone because they were finished. You do not keep interviewing a man whose answers you already have.', shot: 'closeup', wait: 0.5, hold: 1.4 },
        { speaker: 'GRID', expression: 'radio', text: 'AURORA MOTORWORKS\nMIDNIGHT INVITATIONAL - ENTRY CONFIRMED', shot: 'sky', wait: 0.4 },
        { speaker: 'NOVA', expression: 'calm', text: 'And there is the invitation.', shot: 'closeup' },
        fork(ctx,
          { speaker: 'NOVA', expression: 'calculating', text: 'Go. Win it. And when he asks you why you never said anything, have a better answer than the one you gave me.', shot: 'two' },
          { speaker: 'NOVA', expression: 'smug', text: 'Go. Win it. And this time you are not going on your own.', shot: 'two' }),
      ],
    },
    {
      id: 4, title: 'THE GOLDEN RUN', track: 'SUNSET ZERO', rival: 'RYKER',
      cardFace: 'angry',
      levelIndex: 3, personality: 'ryker', diff: 2, pack: true,
      rating: 'VECTOR → INVITATIONAL',
      brief: 'FOUR CARS. SANCTIONED. TELEVISED.\nEVERYONE KNOWS IT IS A CASTING CALL.',
      coldOpen: [
        { speaker: 'ANNOUNCER', expression: 'radio', text: 'Sunset Zero. Four entrants. Aurora Motorworks presents the Midnight Invitational.', shot: 'sky' },
        { speaker: 'ANNOUNCER', expression: 'radio', text: 'The winner takes the Exhibition seat.', shot: 'wide' },
        { speaker: 'KAEL', expression: 'concerned', text: 'Four of us on a lit road with their cameras on every post. What could possibly go wrong.', shot: 'rival' },
      ],
      intro: (ctx) => [
        { speaker: 'KAEL', expression: 'amused', text: 'I hate everything about tonight and I would not miss it.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: 'It is not a race, it is an audition. They will take whoever wins.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Good.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'concerned', text: 'Ryker.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'smug', text: 'Nine years, Nova. Nine years at the top of a list they read every single night.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'angry', text: 'They flagged a rookie in a fortnight. They have never once said my name.', shot: 'rival', hold: 1.0 },
        fork(ctx, [
          { speaker: 'PLAYER', expression: 'focus', text: 'Ryker...', shot: 'player' },
          { speaker: 'RYKER', expression: 'angry', text: 'Do not. Whatever it is, do not do it on the grid.', shot: 'closeup', hold: 1.0 },
        ], [
          { speaker: 'RYKER', expression: 'neutral', text: 'And you. Telling me they closed my file like it was a kindness.', shot: 'closeup' },
          { speaker: 'PLAYER', expression: 'neutral', text: 'It was not meant as one.', shot: 'player' },
          { speaker: 'RYKER', expression: 'concerned', text: 'No. I have had a week to work out what it was meant as.', shot: 'rival', hold: 1.0 },
        ]),
        { speaker: 'RYKER', expression: 'smug', text: 'Tonight they say a name. Do not expect me to wait for the pack.', shot: 'two' },
      ],
      win: [
        { speaker: 'ANNOUNCER', expression: 'radio', text: 'The Exhibition seat goes to the rookie.', shot: 'sky', hold: 1.0 },
        { speaker: 'RYKER', expression: 'neutral', text: 'Say something clever. Go on.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'neutral', text: "I've got nothing.", shot: 'player' },
        { speaker: 'RYKER', expression: 'angry', text: 'Every time I get faster, you do too. Nine years, and you did it in a fortnight.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'concerned', text: 'They were never going to say it. Were they.', shot: 'rival', wait: 0.5, hold: 1.3 },
        { speaker: 'NOVA', expression: 'calculating', text: "He's planning something.", shot: 'rival' },
        { speaker: 'KAEL', expression: 'amused', text: 'Obviously. He was smiling.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'concerned', text: 'Ryker does not smile after he loses.', shot: 'closeup', hold: 0.9 },
      ],
    },
    {
      id: 5, title: 'ASHFALL ZERO', track: 'ASHFALL ZERO', rival: 'RYKER',
      cardFace: 'amused',
      levelIndex: 4, personality: 'ryker',
      diff: (ctx) => fork(ctx, 3, 2),
      canonicalLoss: true,
      rating: 'RESULT STOLEN // R-IX REVEALED',
      brief: 'THE EXHIBITION. NO CREWS, NO BARRIERS.\nTHE PRIZE IS THE CAR THEY BUILT OUT OF HIM.',
      coldOpen: [
        { speaker: 'AURORA', expression: 'radio', text: 'AURORA EXHIBITION - ASHFALL ZERO\nEAST CITY THROUGH THE CALDERA. NO SAFETY CREWS ON ROUTE.', shot: 'sky' },
        { speaker: 'AURORA', expression: 'radio', text: 'PRIZE OF RECORD: R-IX PROTOTYPE AND THE AURORA SEAT ATTACHED TO IT.', shot: 'wide', hold: 0.9 },
      ],
      intro: (ctx) => [
        { speaker: 'NOVA', expression: 'calculating', text: 'There it is in writing. They are not hiding it any more.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'They put the car up as the prize.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'The car is not the prize. Whoever wins gets IN it. That is the point.', shot: 'over', hold: 0.9 },
        fork(ctx, [
          { speaker: 'RYKER', expression: 'angry', text: 'You kept the seat.', shot: 'closeup' },
          { speaker: 'PLAYER', expression: 'neutral', text: 'I won it.', shot: 'player' },
          { speaker: 'RYKER', expression: 'angry', text: 'You won a seat in a car they built out of MY nine years, and you are going to sit in it.', shot: 'rival', hold: 1.2 },
          { speaker: 'RYKER', expression: 'neutral', text: 'No. Not tonight. Not this one.', shot: 'closeup' },
        ], [
          { speaker: 'RYKER', expression: 'smug', text: 'You turned it down and they called me inside a minute.', shot: 'closeup' },
          { speaker: 'PLAYER', expression: 'focus', text: 'Because you were second. Not because they wanted you.', shot: 'player' },
          { speaker: 'RYKER', expression: 'amused', text: 'Do you think I care which it was?', shot: 'rival' },
          { speaker: 'RYKER', expression: 'concerned', text: 'They said my name. First time in nine years anyone from that company has said my name.', shot: 'closeup', wait: 0.4, hold: 1.3 },
        ]),
        { speaker: 'PLAYER', expression: 'focus', text: 'Then make me believe it.', shot: 'two' },
      ],
      win: [],
    },
    {
      id: 6, title: 'BROKEN CIRCUIT', track: 'AURORA FORGE', rival: 'JAVAS',
      levelIndex: 5, personality: 'nova', diff: 2,
      factoryTrial: true,
      rating: 'raceMode // SYNCHRONIZED',
      brief: 'THE MAN WHO DESIGNED THE DRIVER LINK\nWANTS TO SEE YOU SURVIVE ONE.',
      coldOpen: [
        { speaker: 'NOVA', expression: 'calm', text: 'Stop watching the replay.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'damaged', text: "Eleven days. He hasn't been out of that car in eleven days.", shot: 'player' },
        { speaker: 'NOVA', expression: 'neutral', text: 'I know. Get up. There is one person left who knows what they switched on.', shot: 'over' },
      ],
      intro: [
        { speaker: 'JAVAS', expression: 'calm', text: 'Nova brings me a driver and half a car.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'smug', text: 'The useful half.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'You worked for Aurora.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'calculating', text: 'I designed the driver link. Twelve years of it.', shot: 'closeup' },
        { speaker: 'JAVAS', expression: 'calm', text: 'It was meant to let a car learn from a driver. That is all it was ever meant to do.', shot: 'rival' },
        { speaker: 'JAVAS', expression: 'concerned', text: 'Then they turned it round.', shot: 'closeup', wait: 0.5, hold: 1.1 },
        { speaker: 'JAVAS', expression: 'smug', text: 'In this factory everything is a test. Survive mine and I will tell you what that means for your friend.', shot: 'two' },
      ],
      /* Chapter 6 used to hand back an empty `win`, so the trial that gives the
         player raceMode ended in silence and a card. This is the beat the whole
         campaign is built on, and it is where the third decision is asked
         from - so it is where the answer has to land. */
      win: [
        { speaker: 'JAVAS', expression: 'smug', text: 'Thirty seconds of synchronised drive, on a car you bolted back together in my yard.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'You said you would tell me.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'calm', text: '...Yes. I did.', shot: 'closeup', wait: 0.6, hold: 0.9 },
        { speaker: 'JAVAS', expression: 'calculating', text: 'A link reads an operator and closes. Mine closed. It took about four hours and the driver walked out of the bay.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'And theirs?', shot: 'player' },
        { speaker: 'JAVAS', expression: 'concerned', text: 'Theirs cannot close. They removed the part that ends it, because a model that is finished stops improving.', shot: 'closeup', hold: 1.2 },
        { speaker: 'NOVA', expression: 'shocked', text: 'Say the rest of it, Javas.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'It has been reading him for eleven days. It does not stop. It has no reason to stop.', shot: 'rival', wait: 0.5, hold: 1.4 },
        { speaker: 'PLAYER', expression: 'shocked', text: 'He is still in there.', shot: 'player', hold: 1.1 },
        { speaker: 'KAEL', expression: 'shocked', text: 'I said. For a YEAR I said something was wrong with that company.', shot: 'sky' },
        { speaker: 'JAVAS', expression: 'calculating', text: 'The link runs both ways, and it is on the road tomorrow night. I get one pass at it.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'concerned', text: 'And there is a price either way. Tell them the price.', shot: 'over' },
      ],
    },
    {
      id: 7, title: 'PREDATOR', track: 'NEON HORIZON', rival: 'RAPTOR',
      /* Not another angry Ryker - chapter 4 already is one. The R-IX wears
         his face after Aurora has had it, and the damaged plate is the one
         portrait in his set that reads as something having happened to him
         rather than as a mood. Under the red duotone it is unrecognisable as
         a mood at all, which is the point. */
      cardFace: 'damaged',
      levelIndex: 6, personality: 'ryker',
      diff: (ctx) => fork(ctx, 3, 2),
      finale: true,
      rating: (ctx) => fork(ctx, 'THE LAST LAP // RATING: NIGHT', 'THE OPEN CHANNEL // RATING: NIGHT'),
      brief: (ctx) => fork(ctx,
        'ONE SYNC ENDS THE PROGRAMME TONIGHT.\nAND EVERYTHING THAT IS ON IT.',
        'HOLD THE LINK OPEN FOR THIRTY KILOMETRES.\nNEVER DRIVE THE SAME CORNER TWICE.'),
      coldOpen: [
        { speaker: 'JAVAS', expression: 'calculating', text: 'Neon Horizon. Aurora built this deck to validate the R-IX. Nobody has ever raced it.', shot: 'sky' },
        { speaker: 'NOVA', expression: 'calm', text: 'It answered your channel request in four seconds.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Then he wants this too.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'concerned', text: 'Careful with that word.', shot: 'over', hold: 0.8 },
      ],
      intro: (ctx) => [
        { speaker: 'RAPTOR', expression: 'smug', text: 'So you came all the way up here.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'Ryker.', shot: 'player' },
        { speaker: 'RAPTOR', expression: 'smug', text: 'Vector to the seawall. Try keeping me in the frame.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'shocked', text: '...He said that to me the first night. Word for word.', shot: 'player', hold: 1.0 },
        { speaker: 'NOVA', expression: 'concerned', text: 'It has eleven days of him. It uses his lines because they worked.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'And nine years underneath them. Every route, every corner, every habit he ever had.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Not every corner.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'smug', text: 'No. Not one of yours twice.', shot: 'closeup' },
        fork(ctx, [
          { speaker: 'JAVAS', expression: 'calculating', text: 'The sync is built. One window, at speed, and the model is gone.', shot: 'over' },
          { speaker: 'NOVA', expression: 'concerned', text: 'He goes with it. You know he goes with it.', shot: 'over', hold: 1.0 },
          { speaker: 'PLAYER', expression: 'focus', text: 'I know.', shot: 'player', hold: 1.1 },
          { speaker: 'JAVAS', expression: 'calm', text: 'Then drive it into the ground and do not look at the mirror.', shot: 'closeup' },
        ], [
          { speaker: 'JAVAS', expression: 'calculating', text: 'The link is open. It stays open as long as it cannot get a lock on you.', shot: 'over' },
          { speaker: 'NOVA', expression: 'calm', text: 'Thirty kilometres. Every corner different. Converge once and it shuts with him inside.', shot: 'over' },
          { speaker: 'PLAYER', expression: 'focus', text: 'Then I never take the same line twice.', shot: 'player', hold: 1.1 },
          { speaker: 'JAVAS', expression: 'smug', text: 'That is the whole job. Bring him home.', shot: 'closeup' },
        ]),
        { speaker: 'NOVA', expression: 'calculating', text: 'Thirty seconds of raceMode. Spend them where it thinks it knows you.', shot: 'over' },
        { speaker: 'RAPTOR', expression: 'angry', text: 'I can hear that channel.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Good.', shot: 'two' },
      ],
      /* The finale's `win` is the last beat of the RACE. The ending is a scene
         of its own - see ENDINGS and startEnding. */
      win: [
        { speaker: 'GRID', expression: 'radio', text: 'AURORA DRIVER LINK // SYNC LOST\nR-IX - MODEL DID NOT CLOSE', shot: 'sky' },
        { speaker: 'RAPTOR', expression: 'damaged', text: 'Th... that is not... recalculating...', shot: 'rival' },
        { speaker: 'RAPTOR', expression: 'angry', text: 'The line was correct. The line was CORRECT...', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: 'It was. That was always the problem.', shot: 'player' },
        { speaker: 'NOVA', expression: 'calculating', text: 'It only ever had one answer. You never gave it the same question.', shot: 'over', hold: 1.2 },
      ],
    },
  ];

  /* ------------------------------------------------------------ the end --
   *
   * THE CAMPAIGN USED TO STOP RATHER THAN END. Chapter 7 was won, a card said
   * WELCOME TO THE NIGHT over a six-second crane, and the hub came back - which
   * is a results screen, not an ending.
   *
   * An ending owes three things after the climax and this had none of them: the
   * COST paid in front of the player, the CHARACTERS given somewhere to land,
   * and a last image that answers the first one. So there is an epilogue now,
   * it is written twice, and which one plays is the sum of three decisions
   * about the same man.
   *
   *   THE LAST LAP     you burned the model. Aurora is finished and so is
   *                    Ryker. You are rank one of a Grid with nobody on it who
   *                    can push you, and you are the only person alive who
   *                    knows why the top of that list is quiet.
   *
   *   THE OPEN CHANNEL you held the link open for thirty kilometres and never
   *                    took the same corner twice. You did not beat it by
   *                    being faster. You outlasted it, and he came back.
   *
   * Neither is the good one. They are the two honest answers to the question
   * the campaign asks, and the player answered it three times on the way up.
   */
  /* -------------------------------------------------------- THE CREDITS --
   *
   * They run themselves. A game that finishes a seven-chapter campaign and
   * then asks whether you would like to see who made it has already lost the
   * moment: the credits are the last beat of the ending, not a menu item, so
   * they come up on the same slow lift the ending cards are held under and
   * they end where the ending was always going to end.
   *
   * Both endings get them, because both are endings. The only thing after
   * this is the hub.
   *
   * Skippable on ENTER or a click - a player on their second run through has
   * read them - but never PROMPTED. See updateEndingCredits.
   */
  const CREDITS = [
    ['SYNX', 'SYNTHWAVE EXTREME RACING', 'THIRTY KILOMETRES. ONE ROAD. THANK YOU FOR DRIVING IT.'],
    ['BUILT BY', 'suryanarayanrenjith', 'github.com/suryanarayanrenjith'],
    ['BUILT BY', 'smsolutionsva-byte', 'github.com/smsolutionsva-byte'],
    /* THE SITE IS WHERE THE GAME IS DOWNLOADED, not where it is played.
       This card used to read PLAY IT ANYWHERE / IN YOUR BROWSER, which is a
       claim about the product and a wrong one: synx-racing.vercel.app is the
       official site and what it hands you is a build. Crediting a game with a
       distribution model it does not have is the kind of thing a player finds
       out by being disappointed. */
    ['THE OFFICIAL SITE', 'synx-racing.vercel.app', 'WHERE SYNX IS DOWNLOADED'],
  ];
  /* How long each one is held. Slower than the ending cards at 3.6: these are
     names and a web address, and a name that has gone before it has been read
     is a name nobody was credited with. */
  const CREDIT_HOLD = 4.4;

  const ENDINGS = {
    edge: {
      id: 'edge',
      kicker: 'ENDING // THE LAST LAP',
      title: 'THE LAST LAP',
      subtitle: 'THE PROGRAMME IS OVER. SO IS HE.',
      rating: 'GRID RATING // NIGHT',
      lines: [
        { speaker: 'JAVAS', expression: 'calculating', text: 'Sync is in. The model is writing over itself.', shot: 'sky' },
        { speaker: 'RAPTOR', expression: 'damaged', text: 'Wait...', shot: 'rival', hold: 1.0 },
        { speaker: 'RAPTOR', expression: 'concerned', text: 'Wait. I was nearly out. I could see the...', shot: 'closeup', wait: 0.5, hold: 1.4 },
        { speaker: 'GRID', expression: 'radio', text: 'AURORA DRIVER LINK // TERMINATED\nOPERATOR - NOT RECOVERED', shot: 'sky', wait: 0.8, hold: 1.5 },
        { speaker: 'PLAYER', expression: 'shocked', text: '...Ryker.', shot: 'player', wait: 0.9, hold: 1.3 },
        { speaker: 'NOVA', expression: 'shocked', text: 'I know.', shot: 'over', hold: 1.1 },
        { speaker: 'KAEL', expression: 'concerned', text: 'Somebody say something. Please.', shot: 'sky', hold: 1.0 },
        { speaker: 'JAVAS', expression: 'concerned', text: 'Twelve years I built that link. It is off.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'That is what you asked me for, and it is the only true thing I have left to give you.', shot: 'closeup', hold: 1.2 },
        { speaker: 'GRID', expression: 'radio', text: 'AURORA MOTORWORKS // AUTONOMOUS PROGRAMME\nSUSPENDED INDEFINITELY', shot: 'sky' },
        { speaker: 'GRID', expression: 'radio', text: 'GRID RANK 01 - VACANT\nGRID RATING UPDATED: VECTOR → NIGHT', shot: 'sky', wait: 0.5, hold: 1.4 },
        { speaker: 'PLAYER', expression: 'damaged', text: 'Ryker, come in.', shot: 'closeup', wait: 1.0 },
        { speaker: 'GRID', expression: 'radio', text: 'OPEN CHANNEL // NO CARRIER', shot: 'sky', wait: 1.2, hold: 1.8 },
      ],
      /* THE LAST IMAGE, and it answers the first one. The game opens on a man
         who has had a channel open for thirty-one nights because nobody comes
         to Vector any more. */
      coda: [
        { speaker: 'GRID', expression: 'radio', text: 'VECTOR RUN // 00:00\nOPEN CHANNEL - 1 LISTENING', shot: 'sky', hold: 1.4 },
        { speaker: 'KAEL', expression: 'neutral', text: "...You're early.", shot: 'road' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'I am always early now.', shot: 'player', hold: 0.9 },
        { speaker: 'KAEL', expression: 'concerned', text: 'Nova says you drive it every night. The whole route. On your own.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Somebody has to keep the channel open.', shot: 'player', wait: 0.5, hold: 1.4 },
        { speaker: 'KAEL', expression: 'amused', text: '...Then stop being rank one at me and race.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'Vector to the seawall.', shot: 'player' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Try keeping me in the frame.', shot: 'two', wait: 0.6, hold: 1.9 },
      ],
      cards: [
        ['AURORA MOTORWORKS', 'PROGRAMME SUSPENDED', 'THE R-IX NEVER TURNED A WHEEL AGAIN'],
        ['SYNX GRID // RANK 01', 'YOU', 'THE SEAT AT THE TOP WAS ALWAYS THIS QUIET'],
        ['VECTOR RUN // 00:00', 'THE CHANNEL IS OPEN', 'AND YOU ARE THE ONE CALLING IT NOW'],
      ],
    },
    open: {
      id: 'open',
      kicker: 'ENDING // THE OPEN CHANNEL',
      title: 'THE OPEN CHANNEL',
      subtitle: 'YOU DID NOT OUTRUN IT. YOU OUTLASTED IT.',
      rating: 'GRID RATING // NIGHT',
      lines: [
        { speaker: 'JAVAS', expression: 'calculating', text: 'Link is holding. It cannot get a lock on you.', shot: 'sky' },
        { speaker: 'RAPTOR', expression: 'angry', text: 'You always brake here. You ALWAYS...', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Not tonight.', shot: 'player', hold: 0.9 },
        { speaker: 'JAVAS', expression: 'calculating', text: 'Nine years of him coming back out. Eight. Six.', shot: 'over', wait: 0.5 },
        { speaker: 'NOVA', expression: 'concerned', text: 'Do not give it a corner. Not one.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'Three. Two.', shot: 'over' },
        { speaker: 'NOVA', expression: 'shocked', text: 'One.', shot: 'over', wait: 0.7, hold: 1.5 },
        { speaker: 'GRID', expression: 'radio', text: 'AURORA DRIVER LINK // CLOSED\nOPERATOR - RELEASED', shot: 'sky', wait: 0.8, hold: 1.6 },
        { speaker: 'RYKER', expression: 'damaged', text: '...', shot: 'closeup', wait: 1.0, hold: 1.3 },
        { speaker: 'RYKER', expression: 'concerned', text: 'Eleven days.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'Ryker?', shot: 'player' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Own channel. Own voice. First time in eleven days.', shot: 'closeup', hold: 1.1 },
        { speaker: 'RYKER', expression: 'concerned', text: 'I could hear it using me. Every corner it took was one of mine.', shot: 'rival', hold: 1.0 },
        { speaker: 'PLAYER', expression: 'focus', text: 'I know. I raced them all for a fortnight.', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'And you still could not beat it driving properly, so you drove like an idiot for thirty kilometres.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'It worked.', shot: 'player' },
        { speaker: 'RYKER', expression: 'neutral', text: '...You took your time coming to get me.', shot: 'rival', wait: 0.5, hold: 1.3 },
        { speaker: 'KAEL', expression: 'amused', text: 'HE IS ALIVE! I am putting this on every channel I have!', shot: 'sky' },
        { speaker: 'NOVA', expression: 'smug', text: 'Javas. The model.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'Gone. It converged on a driver who does not exist.', shot: 'over' },
        { speaker: 'GRID', expression: 'radio', text: 'GRID RATING UPDATED\nVECTOR → NIGHT', shot: 'sky' },
      ],
      coda: [
        { speaker: 'GRID', expression: 'radio', text: 'VECTOR RUN // 00:00\nOPEN CHANNEL - 9,400 LISTENING', shot: 'sky', hold: 1.3 },
        { speaker: 'KAEL', expression: 'adrenaline', text: 'Nine thousand! On VECTOR! Nobody has come to Vector in a year!', shot: 'road' },
        { speaker: 'NOVA', expression: 'smug', text: 'They came to see whether it was true.', shot: 'over' },
        { speaker: 'RYKER', expression: 'neutral', text: 'It is my channel. I have had it open for thirty-one nights.', shot: 'rival', hold: 0.9 },
        { speaker: 'PLAYER', expression: 'smirk', text: 'Thirty-one? It has been months.', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'I started counting again.', shot: 'closeup', wait: 0.5, hold: 1.4 },
        { speaker: 'RYKER', expression: 'concerned', text: '...And I am not driving the same line tonight. Not ever again.', shot: 'rival', hold: 1.2 },
        { speaker: 'RYKER', expression: 'smug', text: 'Vector to the seawall. All of you. Right now.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'Try keeping me in the frame.', shot: 'two', wait: 0.5, hold: 1.9 },
      ],
      cards: [
        ['AURORA MOTORWORKS', 'DRIVER LINK // DISMANTLED', 'JAVAS PUT THE SCHEMATICS ON EVERY CHANNEL AT ONCE'],
        ['SYNX GRID // RANK 01', 'RYKER', 'HE KEPT IT. HE DRIVES IT DIFFERENTLY NOW'],
        ['VECTOR RUN // 00:00', 'THE CHANNEL IS OPEN', 'AND THE WHOLE GRID IS ON IT'],
      ],
    },
  };
  /* Grid rating by chapters cleared - the hub dossier reads from this. */
  const RATINGS = ['UNRANKED', 'ROOKIE', 'STREET', 'VECTOR', 'INVITATIONAL', 'EXHIBITION', 'SYNCHRONIZED', 'NIGHT'];

  class StorySave {
    static fresh() {
      return {
        version: 3,
        hasSeenPrologue: false,
        currentChapter: 1,
        highestUnlockedChapter: 1,
        completedChapters: [],
        unlockedTracks: [],
        unlockedTutorialMechanics: [],
        seenDialogues: {},
        /* THE SPINE OF THE BRANCH, AS ONE NUMBER.
           Three decisions of plus or minus one. Positive is EDGE, negative is
           OPEN, and because there are three of them it can never come to rest
           on zero - so the campaign always has an ending and it is always the
           one the player drove to. `choices` keeps which way each went so the
           hub can show it and a scene can name it. */
        resolve: 0,
        choices: {},
        endingSeen: null,
      };
    }

    static load() {
      const base = StorySave.fresh();
      let raw = null;
      raw = global.NR.Save.getJSON(SAVE_KEY, null);
      if (!raw) {
        // A v1 save stopped at chapter six. Carry it forward rather than
        // making anyone who already finished the campaign start again.
        raw = global.NR.Save.getJSON(LEGACY_SAVE_KEY, null);
      }
      try {
        if (!raw || typeof raw !== 'object') return base;
        base.hasSeenPrologue = !!raw.hasSeenPrologue;
        base.currentChapter = clamp(raw.currentChapter | 0 || 1, 1, LAST_CHAPTER);
        base.highestUnlockedChapter = clamp(raw.highestUnlockedChapter | 0 || 1, 1, LAST_CHAPTER);
        for (const k of ['completedChapters', 'unlockedTracks', 'unlockedTutorialMechanics']) {
          if (Array.isArray(raw[k])) base[k] = raw[k].slice(0, 32);
        }
        if (base.completedChapters.indexOf(6) >= 0 && base.completedChapters.indexOf(7) < 0) {
          base.currentChapter = 7;
          base.highestUnlockedChapter = Math.max(base.highestUnlockedChapter, 7);
          if (base.unlockedTracks.indexOf('NEON HORIZON') < 0) base.unlockedTracks.push('NEON HORIZON');
        }
        if (raw.seenDialogues && typeof raw.seenDialogues === 'object') base.seenDialogues = raw.seenDialogues;
        /* A v2 save predates the branch. It carries no decisions, so it
           resumes on a clean slate rather than being assigned a path it never
           chose - the three cards simply come round again. */
        base.resolve = clamp(raw.resolve | 0, -3, 3);
        if (raw.choices && typeof raw.choices === 'object') base.choices = raw.choices;
        if (raw.endingSeen === 'edge' || raw.endingSeen === 'open') base.endingSeen = raw.endingSeen;
      } catch (e) { /* corrupt save: a fresh story is safe */ }
      return base;
    }

    static write(data) {
      try { global.NR.Save.setJSON(SAVE_KEY, data); }
      catch (e) { /* private mode still gets a playable in-memory campaign */ }
    }
  }

  /* ------------------------------------------------------ READING SPEED --
   *
   * A LINE HAS TO BE READABLE BEFORE IT CAN BE LEFT.
   *
   * Reported: the opening card "shows and goes to the next very fast". It was
   * not the writing. Three things were letting a conversation run away:
   *
   *   KEY REPEAT. `onKey` never looked at `e.repeat`, so a held ENTER arrived
   *   as thirty keydowns a second. NR.Gate swallowed most of them, but its
   *   window is 190 ms - which is not a guard against auto-repeat, it is a
   *   rate limit OF five advances a second. The prologue is four short lines;
   *   a player who held the key they had just used to start the game walked
   *   the whole scene in under a second and never saw it.
   *
   *   NO FLOOR UNDER A SHORT LINE. "Again." is six characters. At forty
   *   characters a second it is typed in a sixth of a second, which is faster
   *   than the eye finds the card the words are on.
   *
   *   AN UNGATED CARD. The pointer handler called `advance()` with no gate at
   *   all, so a double click was two lines.
   *
   * So: auto-repeat never advances (see `onKey`), a completed line holds for
   * LINE_HOLD before ENTER will leave it, and every line gets a minimum dwell
   * proportional to its length whether or not it is being read at speed. The
   * FIRST press still snaps the typing to the end - that is the responsive
   * thing a player expects - it simply cannot also skip the line.
   */
  /* MEASURED, against the scene that was reported.
     Holding ENTER through the old opening left each of its four lines on
     screen for 0.38, 0.42 and 0.35 of a second - the whole conversation in a
     second and a sixth. The floor below is what one short line needs to be
     read once it is already complete, and it is the number that matters most
     because a held key SKIPS THE TYPING: the first press snaps the line to the
     end, so the dwell is all the reading time there is. */
  const LINE_HOLD = 0.40;
  /* ...and how long a finished line sits there on its own before the caret
     appears, as a function of its length. A beat, not a reading timer: the
     player still advances it. */
  const dwellFor = (text) => clamp(0.32 + text.length / 46, 0.42, 1.15);

  class DialogueController {
    constructor(story) {
      this.story = story;
      this.active = false;
      this.lines = [];
      this.index = 0;
      this.visible = 0;
      this.delay = 0;
      this.cps = 34;
      this.finishedLine = false;
      this.held = 0;
      this.key = null;
      this.onDone = null;
      this.onLine = null;
      this.lastBlip = 0;
    }

    play(lines, opts) {
      opts = opts || {};
      this.lines = lines.slice();
      this.index = 0;
      this.visible = 0;
      this.delay = 0;
      this.finishedLine = false;
      this.held = 0;
      this.key = opts.key || null;
      this.onDone = opts.onDone || null;
      this.onLine = opts.onLine || null;
      /* Thirty-four rather than forty. It is about a hundred and ninety words
         a minute - a shade under a person reading aloud, which is the speed
         the ear expects a line of dialogue to arrive at. */
      this.cps = opts.cps || 34;
      this.active = true;
      this.story.setDialogueVisible(true);
      this.renderLine(true);
    }

    renderLine(first) {
      const line = this.lines[this.index];
      if (!line) return this.complete();
      const ui = this.story.ui, who = cast(line.speaker);
      ui.nameplateName.textContent = who.name;
      ui.nameplateRole.textContent = who.role;
      ui.text.textContent = '';
      ui.cont.classList.remove('show');
      ui.dialogue.classList.add('typing');
      // The whole frame takes the speaker's colour: edge, nameplate, rail,
      // caret, voice trace and portrait wash all read from --voice.
      this.story.setVoice(who.voice);
      const src = portraitOf(line.speaker, line.expression || 'neutral', false);
      ui.portrait.classList.toggle('corrupt', !!who.corrupt);
      if (ui.portrait.getAttribute('src') !== src) {
        ui.portrait.classList.add('swap');
        global.setTimeout(() => {
          ui.portrait.src = src;
          ui.portrait.alt = who.name + ' portrait';
          ui.portrait.classList.remove('swap');
          this.story.pulseScan();
        }, first ? 0 : 90);
      } else if (!first) this.story.pulseScan();
      this.visible = 0;
      /* `wait` is a held beat BEFORE a line starts typing - a character taking
         a moment before they say the thing. It is the only pacing control the
         script has that the player cannot skip past, so it is used sparingly
         and never for more than a breath. */
      this.delay = (first ? 0.10 : 0.05) + clamp(line.wait || 0, 0, 1.6);
      this.finishedLine = false;
      this.held = 0;
      this.lastBlip = 0;
      if (this.onLine) this.onLine(line, this.index);
    }

    update(dt) {
      if (!this.active) return;
      const line = this.lines[this.index];
      if (!line) return;
      if (this.finishedLine) {
        // the dwell that makes a two-word line legible; see LINE_HOLD
        if (this.held < 9) this.held += dt;
        if (this.held >= this.holdWanted() && !this.story.ui.cont.classList.contains('show')) {
          this.story.ui.cont.classList.add('show');
        }
        return;
      }
      if (this.delay > 0) { this.delay -= dt; return; }

      let budget = this.cps * dt;
      while (budget > 0 && this.visible < line.text.length) {
        const step = Math.min(1, budget);
        this.visible += step;
        budget -= step;
        if (step >= 1 || this.visible >= line.text.length) {
          const i = Math.min(line.text.length - 1, Math.max(0, Math.floor(this.visible) - 1));
          const ch = line.text.charAt(i);
          if (ch === ',') this.delay += 0.06;
          else if (ch === '.' || ch === '!' || ch === '?') this.delay += 0.12;
          else if (ch === '…') this.delay += 0.16;
          if (/[^\s.,!?…]/.test(ch) && i - this.lastBlip >= 3) {
            this.lastBlip = i;
            this.story.textBlip(line.speaker);
          }
        }
      }
      uiText(this.story.ui.text, line.text.slice(0, Math.floor(this.visible)));
      if (this.visible >= line.text.length) this.finishLine();
    }

    /** How long this line has to sit finished before ENTER will leave it. */
    holdWanted() {
      const line = this.lines[this.index];
      if (!line) return 0;
      return Math.max(LINE_HOLD, clamp(line.hold || 0, 0, 2.5), dwellFor(line.text) * 0.85);
    }

    finishLine() {
      const line = this.lines[this.index];
      if (!line) return;
      this.visible = line.text.length;
      uiText(this.story.ui.text, line.text);
      this.finishedLine = true;
      this.held = 0;
      this.story.ui.dialogue.classList.remove('typing');
      /* The caret is the affordance, so it appears when the line can actually
         be left rather than the moment the last character lands. */
      this.story.ui.cont.classList.remove('show');
    }

    advance() {
      if (!this.active) return;
      /* One press snaps the typing to the end. That press may not also leave
         the line - which is the whole of the "it went past before I read it"
         report, because the two used to be the same keystroke at auto-repeat
         speed. */
      if (!this.finishedLine) { this.finishLine(); return; }
      if (this.held < this.holdWanted()) return;
      this.index++;
      if (this.index >= this.lines.length) this.complete();
      else this.renderLine(false);
    }

    skip() {
      if (!this.active || !(this.key && this.story.save.seenDialogues[this.key])) return;
      this.complete();
    }

    complete() {
      if (!this.active) return;
      this.active = false;
      this.story.ui.dialogue.classList.remove('typing');
      if (this.key) {
        this.story.save.seenDialogues[this.key] = true;
        this.story.persist();
      }
      this.story.setDialogueVisible(false);
      const done = this.onDone;
      this.onDone = null;
      if (done) done();
    }
  }

  function uiText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function ordinal(n) {
    const m = n % 100;
    if (m >= 11 && m <= 13) return n + 'TH';
    return n + ({ 1: 'ST', 2: 'ND', 3: 'RD' }[n % 10] || 'TH');
  }

  /* ------------------------------------------------------------- the shots --
     Every entry is expressed in the subject car's own frame: `f` forward along
     its nose, `s` to its right, `h` above it, with the target offset by `tf`
     and `th`. `dolly` is how far that mark travels over the life of the shot -
     a slow push, drift or lift, so a held shot is never a still frame. */
  const CAR_SHOTS = {
    hero:    { f: -2.4, s:  6.4, h: 2.05, tf: 1.1, th: 1.05, fov: 50, dolly: [1.5, -0.8, -0.16], hand: 0.35 },
    closeup: { f:  2.6, s:  3.0, h: 1.44, tf: 0.2, th: 1.08, fov: 36, dolly: [-0.9, 0.28, 0.05], hand: 0.55 },
    low:     { f:  6.8, s:  1.7, h: 0.60, tf: 0.0, th: 0.86, fov: 46, dolly: [-1.4, 0.20, 0.06], hand: 0.42 },
    wheel:   { f: -0.9, s:  4.5, h: 0.52, tf: 0.7, th: 0.44, fov: 42, dolly: [0.9, -0.45, 0.03], hand: 0.30 },
    rear:    { f: -8.4, s: -1.5, h: 1.52, tf: 5.0, th: 1.02, fov: 58, dolly: [1.8, 0.5, 0.10], hand: 0.50 },
    front:   { f:  8.6, s: -0.6, h: 1.10, tf: 0.0, th: 0.94, fov: 44, dolly: [-2.0, 0.0, 0.02], hand: 0.40 },
  };

  class StoryManager {
    constructor(game) {
      this.g = game;
      this.save = StorySave.load();
      this.mode = 'none';
      this.t = 0;
      this.chapter = null;
      this.replayPrologue = false;
      this.replayOnly = false;
      this.marks = Object.create(null);
      this.currentShot = 'wide';
      this.currentSpeaker = null;
      this.extraRacers = [];
      this.standingSignature = '';
      this.raceFlags = Object.create(null);
      this.compactLeft = 0;
      this.compactDuration = 1;
      this.compactCooldown = 0;
      this.prevPlace = 2;
      this.prevBoost = false;
      this.wallHits = 0;
      this.lastWallHitAt = -99;
      this.finishOutcome = null;
      this.finishCallback = null;
      this.pendingRetryChapter = 0;
      /* ------------------------------------------- LOSING, IN ONE PLACE --
       *
       * `forcedLoss` is why this run is over when it did not end at the line:
       * the rival got there first, a director decided the player had been
       * beaten, a trial was not passed. It is a string so the post-race
       * conversation can say what happened, and it is falsy for a race that
       * simply finished.
       *
       * `canonicalEarned` is the opposite and exists for exactly one chapter.
       * ASHFALL ZERO ends in a scripted defeat - Ryker steals the line and the
       * R-IX is awarded - and that ending is the chapter FINISHING, not a run
       * going wrong. It used to be unconditional, so a player who was two
       * hundred metres down all night got the same scene, the same prototype
       * and no retry: the chapter could not be lost. The scene is now
       * something the player has to be in front to earn, and this is the flag
       * that says they did.
       *
       * Both describe ONE run and are cleared wherever a chapter begins. */
      this.forcedLoss = '';
      this.canonicalEarned = false;
      this.hubIndex = 0;
      // cinematic camera state
      this.shotKey = '';
      this.shotAge = 0;
      this.shotCut = true;
      this.shotEye = [0, 0, 0];
      this.shotTarget = [0, 0, 0];
      this.shotFov = 55;
      this.ui = this.bindDom();
      this.dialogue = new DialogueController(this);
      this.attachEvents();
    }

    bindDom() {
      const id = (n) => global.document.getElementById(n);
      return {
        root: id('storyRoot'), fade: id('storyFade'), letterbox: id('storyLetterbox'),
        titleCard: id('storyTitleCard'), kicker: id('storyKicker'), title: id('storyTitle'), subtitle: id('storySubtitle'),
        radio: id('storyRadio'), radioAvatar: id('storyRadioAvatar'), radioName: id('storyRadioName'), radioText: id('storyRadioText'),
        dialogue: id('storyDialogue'), portrait: id('storyPortrait'),
        nameplateName: id('storyNameplateName'), nameplateRole: id('storyNameplateRole'), text: id('storyText'),
        cont: id('storyContinue'),
        compact: id('storyCompact'), compactPortrait: id('storyCompactPortrait'), compactName: id('storyCompactName'),
        compactText: id('storyCompactText'), compactTimer: id('storyCompactTimer'),
        battle: id('storyBattle'), battlePlayer: id('battlePlayerImage'), battleRival: id('battleRivalImage'),
        battleChapter: id('battleChapter'), battleRivalName: id('battleRivalName'), battleTrack: id('battleTrack'), battleBrief: id('battleBrief'),
        hub: id('storyHub'), hubStatus: id('storyHubStatus'), hubActions: id('storyHubActions'), chapterList: id('storyChapterList'),
        hubRating: id('storyHubRating'), hubCleared: id('storyHubCleared'), hubLink: id('storyHubLink'),
        continuePrompt: id('storyContinuePrompt'), continueNext: id('storyContinueNext'), continueYes: id('storyContinueYes'), continueNo: id('storyContinueNo'),
        choice: id('storyChoice'), choiceKicker: id('storyChoiceKicker'),
        choiceQuestion: id('storyChoiceQuestion'), choiceDetail: id('storyChoiceDetail'),
        choiceEdge: id('storyChoiceEdge'), choiceOpen: id('storyChoiceOpen'),
        tutorial: id('storyTutorial'), tutorialText: id('storyTutorialText'), tutorialFill: id('storyTutorialFill'),
        waypoint: id('storyWaypoint'), waypointKicker: id('storyWaypointKicker'), waypointTitle: id('storyWaypointTitle'), waypointDistance: id('storyWaypointDistance'),
        raceMeta: id('storyRaceMeta'), raceChapter: id('storyRaceChapter'), raceTrack: id('storyRaceTrack'), raceRival: id('storyRaceRival'), standings: id('storyStandings'),
      };
    }

    attach() {
      if (!this.ui.root) return;
      if (this.g.menuItems && this.g.menuItems[0]) {
        this.g.menuItems[0].act = () => this.enterStory();
      }
      this.g.storySave = this.save;
      global.__SYNX_STORY__ = {
        manager: this,
        chapters: CHAPTERS.slice(1).map(c => ({ id: c.id, title: c.title, track: c.track, rival: c.rival })),
        saveKey: SAVE_KEY,
        cast: Object.keys(CAST),
      };
    }

    attachEvents() {
      if (!this.ui.root) return;
      /* THE WHOLE CARD ADVANCES.
         There used to be a SKIP VIEWED button inside it, which meant this
         handler had to work out whether the click had landed on the button
         before deciding what a click meant. With the button gone, a click
         anywhere on the card is the same as ENTER - which is what a player
         expects a dialogue card to do. K still skips a scene they have
         already read; it simply no longer takes up room on the card. */
      this.ui.dialogue.addEventListener('pointerdown', (e) => {
        e.preventDefault(); e.stopPropagation();
        /* Gated exactly as ENTER is. Without this a double click is two lines,
           and the click that DISMISSED the previous screen could land on the
           card that replaced it. */
        if (NR.Gate && !NR.Gate.open()) return;
        if (NR.Gate) NR.Gate.lock(120);
        this.dialogue.advance();
      });
      this.ui.choiceEdge.addEventListener('click', (e) => { e.preventDefault(); this.commitChoice('edge'); });
      this.ui.choiceOpen.addEventListener('click', (e) => { e.preventDefault(); this.commitChoice('open'); });
      this.ui.continueYes.addEventListener('click', (e) => { e.preventDefault(); this.chooseContinue(true); });
      this.ui.continueNo.addEventListener('click', (e) => { e.preventDefault(); this.chooseContinue(false); });
      global.addEventListener('keydown', (e) => this.onKey(e), true);
    }

    /* Hub navigation is a 2D grid of real buttons: arrows walk the tiles the
       way the eye expects, TAB is a linear fallback, ENTER commits. */
    hubButtons() { return Array.from(this.ui.hub.querySelectorAll('button')); }

    hubMove(dx, dy) {
      const buttons = this.hubButtons();
      if (!buttons.length) return;
      const cur = buttons.indexOf(global.document.activeElement);
      const from = cur >= 0 ? buttons[cur] : buttons[0];
      if (cur < 0) { from.focus(); return; }
      const a = from.getBoundingClientRect();
      const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
      let best = null, bestScore = Infinity;
      for (const b of buttons) {
        if (b === from) continue;
        const r = b.getBoundingClientRect();
        const bx = r.left + r.width / 2, by = r.top + r.height / 2;
        const along = (bx - ax) * dx + (by - ay) * dy;
        if (along <= 6) continue;
        const off = Math.abs((bx - ax) * dy - (by - ay) * dx);
        const score = along + off * 2.4;
        if (score < bestScore) { bestScore = score; best = b; }
      }
      if (!best) best = buttons[(cur + (dx + dy > 0 ? 1 : buttons.length - 1)) % buttons.length];
      best.focus();
      this.g.audio.uiMove();
    }

    onKey(e) {

      /* A press that arrived within a moment of this screen opening was

         meant for the screen before it. See NR.Gate in js/ui.js: without

         this, two quick taps on ENTER walk through three screens. */

      if (NR.Gate && !NR.Gate.open()) return;
      if (!this.isStoryInputMode()) return;
      /* ...and a committing key shuts the gate behind itself, now that this
         screen has established the key is for it. Moving between screens is
         covered by the state change; this is what stops a held ENTER
         skipping four lines of a cutscene in a third of a second. Arrows and
         TAB are deliberately not here: they move a selection rather than
         commit to it, and holding one is how a long list gets read. */
      if (NR.Gate && /^(enter| |escape|backspace)$/i.test(e.key)) NR.Gate.lock();
      const k = e.key.toLowerCase();
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      /* AUTO-REPEAT IS NOT A SECOND PRESS.
         The operating system sends a keydown about thirty times a second for a
         held key. NR.Gate's window is 190 ms, which does not stop that - it
         paces it at five a second, which is still faster than any of this can
         be read. A conversation advances on presses, so a repeat is swallowed
         here and the player has to lift the key. */
      if (e.repeat && this.dialogue.active) { stop(); return; }
      /* SKIPPING THE CREDITS. Handled here with everything else this screen
         listens for, rather than by polling g.input in the update - the story
         owns its own keyboard while it is up (see the branches below) and a
         second reader would take presses the card underneath was waiting for.
         Never prompted, always skippable: see updateEndingCredits. */
      if (this.mode === 'endingCredits'
          && (k === 'enter' || k === ' ' || k === 'escape')) {
        stop(); this.creditSkip = true; return;
      }
      if (this.dialogue.active && (k === 'enter' || k === ' ')) { stop(); this.dialogue.advance(); return; }
      if (this.dialogue.active && k === 'k') { stop(); this.dialogue.skip(); return; }
      if (this.mode === 'choice') {
        /* Two doors, no escape hatch. ESC does not close this card: a decision
           the campaign is going to remember for three chapters is not
           something to be dismissed by the key that means "go back". */
        const doors = [this.ui.choiceEdge, this.ui.choiceOpen];
        let d = Math.max(0, doors.indexOf(global.document.activeElement));
        if (k === 'arrowright' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowup' || k === 'tab') {
          stop(); d = (d + 1) % 2; doors[d].focus(); this.g.audio.uiMove();
        } else if (k === 'enter' || k === ' ') { stop(); doors[d].click(); }
        return;
      }
      if (this.mode === 'continuePrompt') {
        const buttons = [this.ui.continueYes, this.ui.continueNo];
        let i = Math.max(0, buttons.indexOf(global.document.activeElement));
        if (k === 'arrowright' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowup' || k === 'tab') {
          stop(); i = (i + 1) % 2; buttons[i].focus(); this.g.audio.uiMove();
        } else if (k === 'enter' || k === ' ') { stop(); buttons[i].click(); }
        else if (k === 'escape' || k === 'backspace') { stop(); this.chooseContinue(false); }
        return;
      }
      if (this.mode === 'hub') {
        if (k === 'arrowright') { stop(); this.hubMove(1, 0); }
        else if (k === 'arrowleft') { stop(); this.hubMove(-1, 0); }
        else if (k === 'arrowdown') { stop(); this.hubMove(0, 1); }
        else if (k === 'arrowup') { stop(); this.hubMove(0, -1); }
        else if (k === 'tab') {
          stop();
          const b = this.hubButtons();
          const i = Math.max(0, b.indexOf(global.document.activeElement));
          const n = b[(i + (e.shiftKey ? b.length - 1 : 1)) % b.length];
          if (n) { n.focus(); this.g.audio.uiMove(); }
        } else if (k === 'enter' || k === ' ') {
          stop();
          const a = global.document.activeElement;
          if (a && a.tagName === 'BUTTON') a.click();
        } else if (k === 'escape' || k === 'backspace') { stop(); this.returnToTitle(); }
        return;
      }
      if ((this.mode === 'battle' || this.mode === 'preRace' || this.mode === 'chapterTitle') && (k === 'enter' || k === ' ')) {
        stop(); this.t = 99; return;
      }
      if (this.replayPrologue && k === 'escape') { stop(); this.openHub(); }
    }

    isStoryInputMode() { return this.mode !== 'none' && this.mode !== 'race' && this.mode !== 'tutorial'; }
    isExclusive() { return this.mode !== 'none' && this.mode !== 'race'; }

    /* What should be playing right now, according to the story rather than
       according to `Game.state`.

       js/game.js re-picks the track whenever the audio context is unlocked,
       which is on every pointer and key event - and its own selector reads
       `state`, which during a conversation is 'story'. That is not 'menu', so
       it fell through to the race score and put it on over the cutscene. When
       the director is running the screen it is asked instead. */
    refreshMusic() {
      const a = this.g.audio;
      if (!a || !a.playTrack) return;
      /* Re-assert what is already on, rather than deriving it a second time.
         The director sets the track at every point that matters - the chapter
         card, each conversation, the moment a race starts, the Forge, the
         finale - so the honest answer to "what should be playing" is "the
         thing that already is". Deriving it again from `mode` would be a
         second opinion, and a second opinion is how this broke. */
      const KEY = { menu: 'menu', cutscene: 'cutscene', factory: 'factory',
        final: 'final', radio: 'race' };
      const want = KEY[a.intent];
      if (want) a.playTrack(want);
    }
    persist() { StorySave.write(this.save); }

    /* ------------------------------------------------------- the branch --
     *
     * Everything a path-aware scene is allowed to read, in one object, built
     * fresh every time a scene is resolved. A scene is a pure function of this
     * - it may not reach into the manager - which is what keeps the branch
     * auditable: `storyPaths` below replays every chapter down both paths and
     * asserts that neither drops a line.
     */
    storyCtx(extra) {
      const s = this.save;
      const resolve = clamp(s.resolve | 0, -3, 3);
      return Object.assign({
        resolve,
        path: pathOf(resolve),
        choices: s.choices || {},
        chapterId: this.chapter ? this.chapter.id : 0,
      }, extra || {});
    }

    /** A chapter's field, resolved against the path the player is on. */
    field(name, fallback) {
      if (!this.chapter) return fallback;
      return pick(this.chapter[name], this.storyCtx(), fallback);
    }

    /** Which ending the three decisions have earned. */
    endingId() { return (this.save.resolve | 0) > 0 ? 'edge' : 'open'; }

    /** The decision this chapter hands over on its way out, if any.
     *
     * ASKED EVERY TIME THE CHAPTER IS PLAYED, including on a replay. The
     * closing card tells the player the other ending is reachable from the
     * same seven chapters; that is only true if replaying the chapter a
     * decision belongs to lets them make it differently. */
    choiceAfter(id) {
      for (const key of Object.keys(CHOICES)) {
        if (CHOICES[key].after === id) return Object.assign({ id: key }, CHOICES[key]);
      }
      return null;
    }

    /* RESOLVE IS DERIVED, NOT ACCUMULATED.
       Summing it as decisions arrive is correct exactly once - the first time
       through - and drifts the moment a chapter is replayed and its decision
       is answered a second time. Recomputing from the decisions themselves
       means the number always says what the player has actually chosen. */
    recomputeResolve() {
      const made = this.save.choices || {};
      let total = 0;
      for (const key of Object.keys(CHOICES)) {
        const which = made[key];
        if (which === 'edge') total += CHOICES[key].weight || 1;
        else if (which === 'open') total -= CHOICES[key].weight || 1;
      }
      this.save.resolve = clamp(total, -3, 3);
      return this.save.resolve;
    }

    fire(key, fn) {
      if (this.marks[key]) return false;
      this.marks[key] = true;
      if (fn) fn();
      return true;
    }

    setRoot(on) {
      if (!this.ui.root) return;
      this.ui.root.setAttribute('aria-hidden', on ? 'false' : 'true');
    }

    setVoice(color) {
      if (!this.ui.root || this._voice === color) return;
      this._voice = color;
      this.ui.root.style.setProperty('--voice', color);
      const rgb = color.length === 7
        ? [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)]
        : [57, 230, 255];
      this.ui.root.style.setProperty('--voice-soft', 'rgba(' + rgb.join(',') + ',.20)');
    }

    pulseScan() {
      const el = this.ui.dialogue;
      el.classList.remove('scan');
      // reflow, so the animation restarts on a portrait that changes twice
      void el.offsetWidth;
      el.classList.add('scan');
    }

    setDialogueVisible(on) {
      this.ui.dialogue.classList.toggle('show', on);
      this.ui.dialogue.setAttribute('aria-hidden', on ? 'false' : 'true');
      global.document.body.classList.toggle('story-dialogue', on);
    }

    /* Give a control the keyboard, now and again in a moment. See showChoice. */
    focusSoon(el) {
      if (!el) return;
      try { el.focus(); } catch (e) { /* not laid out yet; the retry gets it */ }
      global.setTimeout(() => {
        if (el.isConnected === false) return;
        if (global.document.activeElement !== el) { try { el.focus(); } catch (e) { /* gone */ } }
      }, 0);
    }

    setLayer(el, on) {
      if (!el) return;
      el.classList.toggle('show', !!on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    }

    hideTransient() {
      for (const el of [this.ui.titleCard, this.ui.radio, this.ui.battle, this.ui.continuePrompt, this.ui.choice, this.ui.tutorial, this.ui.waypoint, this.ui.raceMeta]) this.setLayer(el, false);
      this.setDialogueVisible(false);
      this.dialogue.active = false;
      this.hideCompact();
    }

    showTitle(kicker, title, subtitle) {
      this.ui.kicker.textContent = kicker || '';
      this.ui.title.textContent = title || '';
      this.ui.subtitle.textContent = subtitle || '';
      this.setLayer(this.ui.titleCard, true);
    }

    showRadio(name, text, duration) {
      this.ui.radioName.textContent = name || 'SYNX GRID';
      this.ui.radioText.textContent = text || '';
      this.setLayer(this.ui.radio, true);
      const token = (this.radioToken || 0) + 1;
      this.radioToken = token;
      global.setTimeout(() => { if (this.radioToken === token) this.setLayer(this.ui.radio, false); }, (duration || 2.6) * 1000);
    }

    textBlip(speaker) {
      const a = this.g.audio;
      if (!a || !a.ctx || !a.sfx || a.ctx.state !== 'running') return;
      const ctx = a.ctx;
      const pitch = { RYKER: 132, KAEL: 168, NOVA: 212, PLAYER: 186, JAVAS: 150, RAPTOR: 96, GRID: 244, AURORA: 228, ANNOUNCER: 200, UNKNOWN: 236 }[speaker] || 200;
      try {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = speaker === 'RAPTOR' ? 'sawtooth' : 'square';
        osc.frequency.value = pitch + (Math.random() - 0.5) * 8;
        gain.gain.setValueAtTime(0.006, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.018);
        osc.connect(gain); gain.connect(a.sfx);
        osc.start(); osc.stop(ctx.currentTime + 0.02);
      } catch (e) { /* audio is decorative */ }
    }

    // ------------------------------------------------------------- flow ----

    enterStory() {
      this.g.audio.select();
      if (!this.save.hasSeenPrologue) this.startPrologue(false);
      else this.openHub();
    }

    openHub() {
      this.silenceCar();
      this.mode = 'hub';
      this.t = 0;
      this.chapter = null;
      this.pendingRetryChapter = 0;
      this.replayOnly = false;
      this.replayPrologue = false;
      this.g.state = 'story';
      this.g.cursorHiddenForRun = false;
      this.g.syncCursorVisibility();
      this.g.storyHideRival = true;
      this.g.storyRaptor = null;
      this.extraRacers.length = 0;
      this.g.storyExtraRacers = this.extraRacers;
      this.g.storyRacePlace = 0;
      this.g.storyRaceTotal = 0;
      this.g.storyRaceStandings = null;
      this.setRoot(true);
      this.hideTransient();
      this.setLayer(this.ui.hub, true);
      this.setLayer(this.ui.letterbox, false);
      this.ui.fade.style.opacity = '0';
      global.document.body.classList.add('story-hub');
      global.document.body.classList.remove('story-cinematic');
      this.buildHub();
      this.g.audio.playTrack('menu');
    }

    buildHub() {
      const done = new Set(this.save.completedChapters.map(Number));
      const highest = clamp(this.save.highestUnlockedChapter, 1, LAST_CHAPTER);
      const current = clamp(this.save.currentChapter, 1, LAST_CHAPTER);
      const finished = done.has(LAST_CHAPTER);

      this.ui.hubRating.textContent = RATINGS[clamp(done.size, 0, RATINGS.length - 1)];
      this.ui.hubCleared.textContent = done.size + ' / ' + LAST_CHAPTER;
      this.ui.hubLink.textContent = done.has(6) ? 'raceMode' : (done.has(3) ? 'DRIFT CAL.' : 'LOCKED');
      /* THE HUB SAYS WHICH ROAD THE PLAYER IS ON.
         Three decisions steer the campaign and every one of them is remembered
         for the rest of it, so the screen that owns the save has to show them
         - otherwise a branch the player cannot see is a branch they cannot
         decide they want to take differently. `brief` may be path-aware, so it
         is resolved rather than read. */
      const ctx = this.storyCtx();
      const decided = Object.keys(CHOICES)
        .filter(k => (this.save.choices || {})[k])
        .map(k => CHOICES[k][this.save.choices[k]].label);
      const trail = decided.length ? '  //  ' + decided.join(' · ') : '';
      if (finished) {
        const E = this.ending();
        const other = E.id === 'edge' ? ENDINGS.open : ENDINGS.edge;
        this.ui.hubStatus.textContent = 'Campaign complete - ' + E.title + '. ' + E.subtitle
          + ' The other road, ' + other.title + ', is reachable from the same seven chapters:'
          + ' replay and decide the other way.' + trail;
      } else {
        this.ui.hubStatus.textContent = 'Chapter ' + current + ' - ' + CHAPTERS[current].title + '. '
          + String(pick(CHAPTERS[current].brief, ctx, '')).replace(/\n/g, ' ') + trail;
      }

      /* Four actions, not five, and none of them duplicates another. REPLAY
         CUTSCENE used to open a chapter the tile grid already opens, and the
         Chapter 7 course build was a second door onto the arcade route list. */
      this.ui.hubActions.textContent = '';
      const action = (small, label, fn, primary) => {
        const b = global.document.createElement('button');
        b.type = 'button';
        b.className = 'story-action synx-cut' + (primary ? ' primary' : '');
        const s = global.document.createElement('small');
        const t = global.document.createElement('b');
        s.textContent = small; t.textContent = label;
        b.append(s, t);
        b.addEventListener('click', fn);
        this.ui.hubActions.appendChild(b);
        return b;
      };
      const first = action(finished ? 'NEW GAME PLUS' : 'LATEST SAVE',
        finished ? 'REPLAY CHAPTER 07' : 'CONTINUE STORY',
        () => this.startChapter(finished ? LAST_CHAPTER : current, {}), true);
      action('WELCOME TO THE NIGHT', 'REPLAY PROLOGUE', () => this.startPrologue(true));
      action('TUNE THE LINK', 'CONTROLS', () => { this.returnToTitle(); this.g.state = 'controls'; this.g.controlIndex = 0; });
      action('LEAVE STORY MODE', 'MAIN MENU', () => this.returnToTitle());

      this.ui.chapterList.textContent = '';
      for (let i = 1; i <= LAST_CHAPTER; i++) {
        const c = CHAPTERS[i];
        const unlocked = i <= highest;
        const cleared = done.has(i);
        const b = global.document.createElement('button');
        b.type = 'button';
        b.className = 'story-chapter synx-cut' + (unlocked ? '' : ' locked') + (i === current && !finished ? ' next' : '');
        if (!unlocked) b.setAttribute('aria-disabled', 'true');
        /* A FACE PER CHAPTER, NOT ONE FACE SEVEN TIMES.

           Every tile asked for the rival's `neutral` portrait, and three of
           the seven chapters have the same rival - so the hub was the same
           photograph of Ryker in three places, and a fourth in chapter 7,
           where the thing on the card is not even him. A wall of identical
           portraits reads as placeholder art whatever the art is.

           `cardFace` names which of a character's existing expressions the
           tile wears. No new art: every one of these is a sprite the pack
           already ships and the dialogue already uses, chosen to say what the
           chapter is - Ryker dismisses a rookie in 01, is furious by 04, and
           is enjoying himself far too much in 05. */
        const art = global.document.createElement('img');
        art.src = portraitOf(c.rival, c.cardFace || 'neutral', false);
        art.alt = '';
        /* ...AND THE LAST ONE IS NOT A DRIVER. See `corrupt` in the cast: the
           R-IX broadcasts on Ryker's channel wearing Ryker's face, and the
           tile says so rather than showing a seventh head-and-shoulders. */
        if (cast(c.rival).corrupt) b.classList.add('is-boss');
        const num = global.document.createElement('small');
        const title = global.document.createElement('b');
        const meta = global.document.createElement('span');
        const state = global.document.createElement('i');
        num.textContent = 'CHAPTER ' + String(i).padStart(2, '0');
        title.textContent = c.title;
        meta.textContent = cast(c.rival).name + ' // ' + c.track;
        state.textContent = cleared ? 'CLEARED - REPLAY' : (unlocked ? (i === current ? 'NEXT - PLAY' : 'PLAY') : 'LOCKED');
        b.append(art, num, title, meta, state);
        /* Hover and keyboard focus share the same active treatment. This is
           explicit rather than relying on a tiny transform alone, so each
           chapter remains unmistakably selectable over bright portrait art. */
        const setActive = (on) => b.classList.toggle('is-highlighted', on && unlocked);
        b.addEventListener('pointerenter', () => {
          setActive(true);
          /* ...AND THE KEYBOARD FOLLOWS THE POINTER.
             The hub commits with ENTER on the focused tile. Highlighting
             one tile while the keyboard sits on another is two selections
             on one screen, and the chapter that starts is the one the
             player was not looking at. preventScroll because the grid
             scrolls once the campaign is open. */
          if (unlocked && global.document.activeElement !== b) {
            try { b.focus({ preventScroll: true }); } catch (err) { b.focus(); }
          }
        });
        b.addEventListener('pointerleave', () => { if (global.document.activeElement !== b) setActive(false); });
        b.addEventListener('focus', () => setActive(true));
        b.addEventListener('blur', () => { if (!b.matches(':hover')) setActive(false); });
        b.addEventListener('click', () => {
          if (!unlocked) { this.g.audio.crash(0.2); return; }
          this.startChapter(i, { replayChapter: cleared });
        });
        this.ui.chapterList.appendChild(b);
      }
      /* Does the grid overflow? Only then does it want the scroll fade - see
         the note by #storyChapterList.is-scroll. Measured after a frame,
         because the tiles have only just been appended. */
      const list = this.ui.chapterList;
      const syncScroll = () => {
        if (!list || !list.isConnected) return;
        list.classList.toggle('is-scroll', list.scrollHeight - list.clientHeight > 4);
      };
      global.setTimeout(syncScroll, 0);
      if (list && !list.__synxScrollBound) {
        list.__synxScrollBound = true;
        global.addEventListener('resize', syncScroll);
      }
      global.setTimeout(() => first.focus(), 0);
    }

    returnToTitle() {
      this.closeStoryUi();
      this.mode = 'none';
      this.g.storyHideRival = false;
      this.g.toMenu();
    }

    closeStoryUi() {
      this.hideTransient();
      this.setLayer(this.ui.hub, false);
      this.setLayer(this.ui.letterbox, false);
      this.ui.fade.style.opacity = '0';
      this.setRoot(false);
      this.ui.root.classList.remove('rain');
      global.document.body.classList.remove('story-hub', 'story-cinematic', 'story-dialogue');
    }

    onMainMenu() {
      this.silenceCar();
      const hadStoryUi = this.mode !== 'none';
      this.mode = 'none';
      if (hadStoryUi) this.closeStoryUi();
      this.pendingRetryChapter = 0;
      this.chapter = null;
      this.g.storyHideRival = false;
      this.g.storyRaptor = null;
      this.extraRacers.length = 0;
      this.g.storyRacePlace = 0;
      this.g.storyRaceTotal = 0;
      this.g.storyRaceStandings = null;
    }

    // --------------------------------------------------------- prologue ----

    startPrologue(replay) {
      this.closeStoryUi();
      this.setRoot(true);
      this.mode = 'prologue';
      this.t = 0;
      this.marks = Object.create(null);
      this.replayPrologue = !!replay;
      this.replayOnly = false;
      this.g.state = 'story';
      this.g.storyHideRival = true;
      this.g.levelIndex = 3;
      this.g.applyLevel();
      this.setVehicle(this.g.car, 55200, 0, 0);
      this.g.distance = 55200;
      this.g.audio.playTrack(null);
      this.ui.fade.style.opacity = '1';
      this.setLayer(this.ui.letterbox, true);
      global.document.body.classList.add('story-cinematic');
      this.cutTo('prologue-black');
    }

    /* ------------------------------------------------------- the opening --
     *
     * WHAT THE PROLOGUE WAS MISSING WAS A REASON.
     *
     * It was fifteen seconds of city, four atmosphere lines and an anonymous
     * voice saying "heard you're fast". That is a premise, not a hook: the
     * player is nobody, wants nothing, and has been invited to a race by
     * somebody they have no reason to answer. The first thing the game says
     * about its own protagonist should not be that they were available.
     *
     * So the opening now gives the player three things before they touch the
     * throttle - a car that is not theirs, a name to find, and a voice that
     * knows both - and it plants the two lines the finale pays off: the roll
     * call that is one driver short, and "try keeping me in the frame".
     *
     * It is also about twice as long, and it is paced. The old scene ran four
     * radio cards in three and a half seconds; every beat here is given the
     * time it takes to read, and the dialogue that follows cannot be walked
     * through by a held ENTER any more - see the note above LINE_HOLD.
     */
    updatePrologue(dt) {
      this.baseTick(dt, this.t > 9.2);
      this.t += dt;
      const t = this.t;

      if (t < 1.2) {
        this.ui.fade.style.opacity = '1';
      } else if (t < 3.2) {
        this.ui.fade.style.opacity = '1';
        this.fire('location', () => this.showTitle('NEON CITY // EAST GRID', '23:47', 'ELEVEN MINUTES OF DARK'));
      } else if (t < 9.0) {
        this.setLayer(this.ui.titleCard, false);
        this.ui.fade.style.opacity = String(clamp(1 - (t - 3.2) / 0.9, 0.06, 1));
        this.shotKey = 'prologue-city';
        this.trackShot(55200 + (t - 3.2) * 150, 125, 155, -80, 420, 63);
        if (t > 3.6) this.fire('radio1', () => this.showRadio('CITY GRID', 'Eastern draw scheduled. Twenty-three forty-seven.', 2.4));
        if (t > 4.9) this.fire('radio2', () => this.showRadio('AURORA RELAY', 'Reactor cycle nominal. District load transferred.', 2.4));
        if (t > 6.2) this.fire('radio3', () => this.showRadio('VECTOR CONTROL', 'Vector district just went dark.', 2.3));
        /* The last two are the story. One says the night is unwatched, which
           is why anyone races; the other introduces the man the whole campaign
           is about, before he has said a word, by what he is doing with his
           evening. Both endings answer this card. */
        if (t > 7.4) this.fire('radio4', () => this.showRadio('SYNX GRID', "Then nobody's watching. Channels are live.", 2.4));
        if (t > 8.4) this.fire('radio5', () => this.showRadio('SYNX GRID', 'Open channel on Vector. Same one. Thirty-first night.', 2.6));
      } else if (t < 9.9) {
        this.ui.fade.style.opacity = String(clamp((t - 9.0) / 0.45, 0, 1));
        this.setLayer(this.ui.radio, false);
      } else {
        this.fire('garage', () => {
          this.g.levelIndex = 0;
          this.g.applyLevel();
          this.setVehicle(this.g.car, 80, -1.0, 0);
          this.g.distance = 80;
          this.g.audio.playTrack('race');
        });
        this.ui.fade.style.opacity = String(clamp(1 - (t - 9.9) / 0.75, 0, 1));
        if (t < 12.1) this.carShot('prologue-a', this.g.car, 'wheel');
        else if (t < 14.0) this.carShot('prologue-b', this.g.car, 'low');
        else if (t < 18.6) this.carShot('prologue-c', this.g.car, 'hero');
        else this.carShot('prologue-d', this.g.car, 'front');

        if (t > 13.9 && t < 17.1) this.fire('logo', () => this.showTitle('WELCOME TO THE NIGHT', 'SYNX', 'SYNTHWAVE eXTREME RACING'));
        /* WHO THE PLAYER IS, delivered without a word of dialogue: nobody at
           all. That is the whole of their side of the setup, and it is what
           makes the first chapter land - rank one has been calling an empty
           channel for a month, and the person who finally answers has never
           been on this road in their life. */
        if (t > 17.0) this.fire('note', () => this.showTitle('SYNX GRID // REGISTRATION',
          'NO DRIVER ID', 'GRID RATING: UNRANKED\nROUTES COMPLETED: NONE\nYOU HAVE NEVER BEEN ON THIS ROAD'));
        if (t > 21.4) this.setLayer(this.ui.titleCard, false);
        if (t > 22.0) this.fire('challenge', () => this.startPrologueDialogue());
      }
    }

    startPrologueDialogue() {
      this.mode = 'prologueDialogue';
      this.currentShot = 'player';
      this.currentSpeaker = 'GRID';
      /* The voice has no name here because it is hiding one. It is Ryker, and
         Chapter 7 is written so that the R-IX quotes his last line back at the
         player in his voice - which only lands if the player heard him say it
         first, from a card that would not give him a name. */
      this.dialogue.play([
        { speaker: 'GRID', expression: 'radio', text: 'SYNX GRID // OPEN CHANNEL\nUNREGISTERED VEHICLE - NO DRIVER ID', shot: 'sky' },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Somebody is on my channel.', shot: 'low', wait: 0.6, hold: 0.9 },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Thirty-one nights I have had this open. You are the first thing on it that is not the relay.', shot: 'wheel' },
        { speaker: 'PLAYER', expression: 'neutral', text: "I'm not registered.", shot: 'player' },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'I can see that. No ID, no rating, no route.', shot: 'closeup', hold: 0.9 },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Which makes you the only driver on this Grid I have never beaten.', shot: 'road', wait: 0.5, hold: 1.1 },
        { speaker: 'PLAYER', expression: 'focus', text: 'Who is this?', shot: 'player' },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Rank one. Nine years. Ask anybody - they all say the same thing about me.', shot: 'sky', hold: 0.9 },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Vector Run. Midnight. Vector to the seawall.', shot: 'road' },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Try keeping me in the frame.', shot: 'player', wait: 0.4, hold: 1.3 },
      ], {
        key: 'prologue_challenge',
        onLine: (line) => this.onDialogueLine(line),
        onDone: () => this.startTutorial(),
      });
    }

    updatePrologueDialogue(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
    }

    // --------------------------------------------------------- tutorial ----

    startTutorial() {
      this.save.hasSeenPrologue = true;
      if (this.save.unlockedTracks.indexOf('VECTOR RUN') < 0) this.save.unlockedTracks.push('VECTOR RUN');
      this.persist();
      this.mode = 'tutorial';
      this.t = 0;
      this.marks = Object.create(null);
      this.g.levelIndex = 0;
      this.g.applyLevel();
      this.g.startAt = 60;
      this.g.finishAt = this.g.levels[0].to;
      this.g.car.reset(60, 0);
      this.g.rival.reset(60, 0);
      this.g.rival.x += 100000;
      this.g.rival.z += 100000;
      this.g.distance = this.g.car.sTrack;
      this.g.state = 'story';
      this.g.storyHideRival = true;
      this.g.audio.playTrack('race');
      this.setLayer(this.ui.letterbox, false);
      global.document.body.classList.remove('story-cinematic');
      this.ui.fade.style.opacity = '0';
      this.setLayer(this.ui.waypoint, true);
      this.ui.waypointKicker.textContent = 'ROUTE LOCKED';
      this.ui.waypointTitle.textContent = 'VECTOR RUN';
      this.tutorialSteps = [
        { id: 'accelerate', label: 'W / ↑ - ACCELERATE', test: i => i.throttle > 0.25 },
        { id: 'steer', label: 'A / D - STEER', test: i => Math.abs(i.steer) > 0.25 },
        { id: 'brake', label: 'S / ↓ - BRAKE', test: i => i.brake > 0.25 },
        { id: 'boost', label: 'B - BOOST', test: i => i.boost },
        { id: 'drift', label: 'SPACE + A / D - DRIFT', test: i => i.ebrake && Math.abs(i.steer) > 0.25 },
      ];
      this.tutorialIndex = 0;
      this.tutorialHold = 0;
      this.updateTutorialCard();
      this.setLayer(this.ui.tutorial, true);
    }

    updateTutorialCard() {
      const step = this.tutorialSteps[this.tutorialIndex];
      if (!step) {
        this.ui.tutorialText.textContent = 'VECTOR RUN - KEEP MOVING';
        this.ui.tutorialFill.style.transform = 'scaleX(1)';
        return;
      }
      this.ui.tutorialText.textContent = step.label;
      this.ui.tutorialFill.style.transform =
        'scaleX(' + (this.tutorialIndex / this.tutorialSteps.length).toFixed(4) + ')';
    }

    updateTutorial(dt) {
      this.t += dt;
      const input = this.g.input.sample();
      this.tutorialTick(dt, input);
      this.dialogue.update(dt);
      this.updateCompact(dt);
      const remainingUnits = Math.max(0, 1800 - this.g.car.sTrack);
      // The invitation calls this urban approach 3.8 km. Keep that authored
      // navigation scale while the playable slice uses the shorter conversion.
      this.ui.waypointDistance.textContent = Math.max(0.1, 3.8 * remainingUnits / 1740).toFixed(1) + ' KM';

      const step = this.tutorialSteps[this.tutorialIndex];
      this.tutorialHold = Math.max(0, this.tutorialHold - dt);
      if (step && this.tutorialHold <= 0 && step.test(input)) {
        if (this.save.unlockedTutorialMechanics.indexOf(step.id) < 0) this.save.unlockedTutorialMechanics.push(step.id);
        this.tutorialIndex++;
        this.tutorialHold = 0.55;
        this.g.audio.checkpoint();
        this.persist();
        this.updateTutorialCard();
      }

      /* The approach to Vector is the only stretch of road in the game with
         nobody to race, so it is where the channel does the talking - and what
         it says is the reason the player is out here rather than a caption on
         the controls. */
      if (this.g.car.sTrack > 420) this.fire('tut1', () => this.showCompact('GRID', 'radio', 'Unregistered run detected on Vector. Nobody is coming.', 3.4));
      if (this.g.car.sTrack > 760) this.fire('tut2', () => this.showCompact('GRID', 'radio', 'Driver profile: no ID. Plate: archived March.', 3.2));
      if (this.g.car.sTrack > 1080) this.fire('tut3', () => this.showCompact('UNKNOWN', 'radio', 'Still with me? Good. Seawall is the line.', 3.0));
      if (this.g.car.sTrack > 1360) this.fire('tut4', () => this.showCompact('UNKNOWN', 'radio', 'Eleven months that car sat there. Nobody touched it.', 3.4));
      if (this.g.car.sTrack > 1600) this.fire('tut5', () => this.showCompact('UNKNOWN', 'radio', 'Whoever you are - you drive like he did.', 3.6));

      const learned = this.tutorialIndex >= this.tutorialSteps.length;
      if ((learned && this.g.car.sTrack >= 1780) || this.t > 70) {
        this.setLayer(this.ui.tutorial, false);
        this.setLayer(this.ui.waypoint, false);
        if (this.replayPrologue) this.openHub();
        else this.startChapter(1, { fromPrologue: true, arrivalS: this.g.car.sTrack });
      }
    }

    tutorialTick(dt, input) {
      const g = this.g;
      g.time += dt; g.scene.time = g.time;
      g.fade += (g.fadeTarget - g.fade) * Math.min(1, dt * 3);
      const wasBoost = g.car.boosting;
      g.car.update(dt, input, true);
      if (g.car.boosting && !wasBoost) g.audio.boostHit();
      if (g.car.lastHit) {
        g.car.lastHit = false;
        g.car.lastHitType = null;
        g.audio.crash(g.car.impact);
        g.shake = 0.25 + g.car.impact * 0.55;
        if (g.fx) g.fx.sparks(g.car, g.car.impact);
      }
      g.flash = Math.max(0, (g.flash || 0) - dt * .9);
      g.shake = Math.max(0, (g.shake || 0) - dt * 3.2);
      g.distance = g.car.sTrack;
      g.progress = clamp((g.distance - g.startAt) / Math.max(1, 1800 - g.startAt), 0, 1);
      g.updateAtmosphere(dt);
      g.updateCamera(dt);
      if (g.fx) g.fx.update(dt, g.car, true);
      g.audio.update(g.car, dt, true);
    }

    // ---------------------------------------------------------- chapters ---

    startChapter(id, opts) {
      opts = opts || {};
      const c = CHAPTERS[id];
      if (!c) return this.openHub();
      if (this.g.hideCursorForRun) this.g.hideCursorForRun();
      this.closeStoryUi();
      this.setRoot(true);
      this.mode = 'chapterTitle';
      this.t = 0;
      this.marks = Object.create(null);
      this.chapter = c;
      this.replayOnly = false;
      this.replayChapter = !!opts.replayChapter;
      this.replayPrologue = false;
      this.currentShot = 'wide';
      this.currentSpeaker = null;
      this.g.levelIndex = c.levelIndex;
      /* DIFFICULTY IS A CONSEQUENCE.
         Three chapters take theirs from the path: going it alone puts the next
         rival up a rung, bringing the crew leaves them where they are and pays
         you in information instead. It is the one place the story is allowed
         to reach into the race, and it reaches into exactly one number. */
      this.g.diffIndex = pick(c.diff, this.storyCtx(), 1);

      const arrival = !!opts.fromPrologue;
      const arrivalS = opts.arrivalS || this.g.car.sTrack;
      this.g.applyLevel();
      this.ui.root.classList.toggle('rain', id === 3);
      if (id === 3) {
        this.g.levelWet = .86;
        this.g.scene.wet = .86;
      } else if (id === 4) {
        this.g.scene.sunColor = [1.0, .43, .16];
        this.g.scene.ambInt = 1.42;
        this.g.levelWet = .34;
      } else if (id === 6) {
        this.g.scene.sunColor = [.34, .48, .58];
        this.g.scene.ambInt = .74;
        this.g.levelWet = .20;
      }
      if (arrival) {
        this.g.startAt = clamp(arrivalS, this.g.level.from + 30, this.g.level.to - 1000);
        this.g.finishAt = this.g.level.to;
        /* THE GRID, ON AN ARRIVAL.

           Chapter 1 opens with the player already rolling in off the prologue,
           so the car is carried over rather than reset - that is what makes it
           read as arriving somewhere instead of being placed there. But only
           its arc length was being carried, and its LATERAL was left at
           wherever the prologue's free drive happened to end: usually on the
           right of the road, which is Ryker's half of the grid. The two cars
           lined up on top of each other, and it looked correct again on a
           restart only because a restart goes through resetCar, which puts
           both of them where they belong.

           So the arrival is placed on its own half of the grid too. Placing
           rather than resetting is the point: the speed it arrived with is
           what the shot is of. */
        this.g.car.sTrack = this.g.startAt;
        this.g.car.maxS = this.g.startAt;
        this.g.car.vLong *= 0.2; this.g.car.vLat = 0; this.g.car.speed = Math.abs(this.g.car.vLong);
        this.g.car.placeLateral(this.g.startAt, -5.5);
        this.g.rival.reset(this.g.startAt, 5.5);
        this.g.driver.setLevel(this.g.difficulties[this.g.diffIndex] || 'MEDIUM');
        this.g.driver.reset();
      } else {
        this.g.resetCar();
      }
      this.g.driver.personality = c.personality;
      this.g.state = 'story';
      this.g.storyHideRival = false;
      this.g.raceOver = false;
      this.g.raceTime = 0;
      this.g.won = false;
      this.wallHits = 0;
      this.lastWallHitAt = -99;
      this.finishOutcome = null;
      this.finishFocusCar = null;
      this.finishCallback = null;
      this.pendingRetryChapter = 0;
      this.extraRacers.length = 0;
      if (c.pack) this.spawnInvitationalPack();
      this.g.storyExtraRacers = this.extraRacers;
      /* Chapter 7's rival IS the prototype. Hiding the street-car body and
         handing the same Vehicle to the Raptor kit means the boss drives real
         physics on the real racing line with the prototype's own skin. */
      if (c.finale) {
        this.g.storyHideRival = true;
        this.g.storyRaptor = this.g.rival;
        this.g.storyRaptorCharge = 0;
      } else {
        this.g.storyRaptor = null;
      }
      this.standingSignature = '';
      this.setLayer(this.ui.letterbox, true);
      this.ui.fade.style.opacity = '0';
      global.document.body.classList.add('story-cinematic');
      this.g.flash = Math.max(this.g.flash || 0, .12);
      this.g.audio.playTrack('cutscene');
      this.cutTo('chapter-establish');
      /* THE COLD OPEN COMES BEFORE THE TITLE.
         Every chapter used to put ten lines between the menu and the road,
         which is a conversation with a race stapled to the end of it. Two or
         three lines land first, over a moving car and before the card - the
         hook - and the title then arrives on top of a scene that has already
         started. A chapter with nothing to say up front simply goes straight
         to its card. */
      const cold = scene(c.coldOpen, this.storyCtx());
      if (cold.length && !opts.skipColdOpen) {
        this.mode = 'coldOpen';
        this.currentShot = 'road';
        this.dialogue.play(cold, {
          key: 'chapter_' + id + '_cold',
          onLine: (line) => this.onDialogueLine(line),
          onDone: () => this.showChapterTitle(),
        });
        return;
      }
      this.showChapterTitle();
    }

    showChapterTitle() {
      const c = this.chapter;
      if (!c) return this.openHub();
      this.mode = 'chapterTitle';
      this.t = 0;
      this.setDialogueVisible(false);
      this.showTitle('CHAPTER ' + String(c.id).padStart(2, '0'), c.title,
        cast(c.rival).name + ' // ' + c.track);
      this.g.flash = Math.max(this.g.flash || 0, .12);
      this.cutTo('chapter-establish');
    }

    updateColdOpen(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
    }

    updateChapterTitle(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      this.establishingShot(dt);
      if (this.t >= 2.6) {
        this.setLayer(this.ui.titleCard, false);
        this.startChapterDialogue();
      }
    }

    /* A conversation is not a race. baseTick hands the mixer `false` for
       every mode that is not one, but the transition INTO a cutscene happens
       on a frame where the throttle may still be down - so the car is cut off
       once, explicitly, wherever the screen stops being the road. */
    silenceCar() {
      if (this.g.audio && this.g.audio.silenceCar) this.g.audio.silenceCar();
      if (this.g.car) { this.g.car.engineLoad = 0; this.g.car.wheelSpinFx = 0; }
    }

    startChapterDialogue() {
      this.mode = 'chapterDialogue';
      this.currentShot = 'wide';
      this.dialogue.play(scene(this.chapter.intro, this.storyCtx()), {
        key: 'chapter_' + this.chapter.id + '_intro_' + this.storyCtx().path,
        onLine: (line) => this.onDialogueLine(line),
        onDone: () => this.startBattleCard(),
      });
    }

    updateChapterDialogue(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
    }

    startBattleCard() {
      const c = this.chapter;
      this.mode = 'battle';
      this.t = 0;
      this.ui.battleChapter.textContent = 'CHAPTER ' + String(c.id).padStart(2, '0') + ' // ' + c.title;
      this.ui.battleRivalName.textContent = cast(c.rival).name;
      this.ui.battleTrack.textContent = c.track;
      this.ui.battleBrief.textContent = pick(c.brief, this.storyCtx(), '');
      this.ui.battlePlayer.src = portraitOf('PLAYER', 'neutral', true);
      this.ui.battleRival.src = portraitOf(c.rival, 'neutral', true);
      // the same treatment the hub tile and the dialogue portrait get
      this.ui.battleRival.classList.toggle('is-boss', !!cast(c.rival).corrupt);
      this.setLayer(this.ui.battle, true);
      this.g.audio.select();
      this.g.audio.goBeep();
      this.g.flash = Math.max(this.g.flash || 0, .16);
      this.g.shake = Math.max(this.g.shake || 0, .30);
      this.cutTo('battle');
    }

    updateBattle(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      // The cards cover the frame, so this is only what the letterbox reveals
      // as they fly out: a slow lift off the grid.
      this.trackShot(this.g.startAt + 26, 20, 9 + this.t * 0.9, 16, 90, 54, 'battle-grid');
      if (this.t >= 4.4) {
        this.setLayer(this.ui.battle, false);
        this.mode = 'preRace';
        this.t = 0;
      }
    }

    updatePreRace(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      const rival = this.g.storyRaptor || this.g.rival;
      if (this.t < 1.15) this.carShot('pre-a', this.g.car, 'wheel');
      else if (this.t < 2.35) this.carShot('pre-b', rival, 'low');
      else if (this.t < 3.30) this.pairShot('pre-c', this.g.car, rival, 60);
      else this.carShot('pre-d', this.g.car, 'rear');

      if (this.t >= 4.0) this.startRaceTransition();
    }

    startRaceTransition() {
      this.mode = 'raceTransition';
      this.t = 0;
      this.g.state = 'countdown';
      this.g.countdown = 3.999;
      this.g.lastBeep = -1;
      this.g.raceTime = 0;
      this.transitionEye = Array.from(this.g.eye);
      this.transitionTarget = Array.from(this.g.target);
      this.transitionFov = this.g.fov;
      this.showRaceMeta();
      this.setLayer(this.ui.letterbox, true);
    }

    updateRaceTransition(dt) {
      const g = this.g;
      this.baseTick(dt, true);
      this.t += dt;
      g.countdown -= dt;
      const n = Math.ceil(g.countdown);
      if (n !== g.lastBeep && n >= 0) {
        g.lastBeep = n;
        if (n > 0) g.audio.countBeep(); else g.audio.goBeep();
      }

      g.updateCamera(dt);
      const chaseEye = Array.from(g.eye), chaseTarget = Array.from(g.target), chaseFov = g.fov;
      const f = smooth(clamp(this.t / 3.35, 0, 1));
      for (let i = 0; i < 3; i++) {
        g.eye[i] = mix(this.transitionEye[i], chaseEye[i], f);
        g.target[i] = mix(this.transitionTarget[i], chaseTarget[i], f);
      }
      g.fov = mix(this.transitionFov, chaseFov, f);
      if (this.t > 2.7) this.setLayer(this.ui.letterbox, false);
      if (g.countdown <= 0) {
        this.mode = 'race';
        g.state = 'racing';
        g.raceTime = 0;
        this.wallHits = 0;
        this.lastWallHitAt = -99;
        this.prevPlace = g.place || 2;
        this.prevBoost = false;
        this.compactCooldown = 1.5;
        this.raceFlags = Object.create(null);
        if (this.chapter && this.chapter.id === 6) this.g.audio.playTrack('factory');
        else if (this.chapter && this.chapter.id === 7) this.g.audio.playTrack('final');
        else this.g.audio.playTrack('race');
        global.document.body.classList.remove('story-cinematic');
      }
    }

    showRaceMeta() {
      /* Chapters 6 and 7 field their own objective card in this exact slot -
         one panel per corner, never two stacked on each other. */
      if (this.chapter && (this.chapter.factoryTrial || this.chapter.finale)) {
        this.setLayer(this.ui.raceMeta, false);
        this.updateRaceMeta();
        return;
      }
      const total = 2 + this.extraRacers.length;
      this.ui.raceChapter.textContent = 'CHAPTER ' + String(this.chapter.id).padStart(2, '0');
      this.ui.raceTrack.textContent = this.chapter.track;
      this.ui.raceRival.textContent = total === 4 ? 'GRID // 4 CARS' : 'RIVAL // ' + cast(this.chapter.rival).name;
      this.ui.raceMeta.classList.toggle('four-car', total === 4);
      this.updateRaceMeta();
      this.setLayer(this.ui.raceMeta, true);
    }

    afterNormalUpdate(dt) {
      /* THE ONE THING THAT STILL RUNS BEHIND A PAUSE, and it runs so that a
         line already on screen when ESC was pressed finishes its dwell and
         goes rather than being frozen mid-sentence for as long as the menu is
         open. Nothing below this line is allowed to START anything. */
      this.updateCompact(dt);
      if (this.mode !== 'race' || !this.chapter) return;
      if (!this.g.simulating) return;
      this.compactCooldown = Math.max(0, this.compactCooldown - dt);
      if (this.chapter.pack) this.updateInvitationalPack(dt);
      this.updateStoryAtmosphere();
      this.updateRaceMeta();
      this.rivalBanter();
      this.prevPlace = this.g.place || this.prevPlace;
      this.prevBoost = !!this.g.car.boosting;
    }

    raceEntrants() {
      const entrants = [
        { name: 'PLAYER', car: this.g.car, player: true },
        { name: this.chapter && this.chapter.pack ? 'RYKER' : (this.chapter ? this.chapter.rival : 'RIVAL'), car: this.g.rival },
      ];
      for (const e of this.extraRacers) entrants.push({ name: e.name, car: e.car, driver: e.driver });
      return entrants.filter(e => e.car);
    }

    rankedEntrants() {
      return this.raceEntrants().slice().sort((a, b) => {
        const gap = b.car.sTrack - a.car.sTrack;
        if (Math.abs(gap) > .35) return gap;
        if (a.player) return -1;
        if (b.player) return 1;
        return a.name.localeCompare(b.name);
      });
    }

    updateRaceMeta() {
      const ranked = this.rankedEntrants();
      const place = Math.max(1, ranked.findIndex(e => e.player) + 1);
      const total = ranked.length;
      this.g.place = place;
      this.g.storyRacePlace = place;
      this.g.storyRaceTotal = total;
      this.g.storyRaceStandings = ranked.map((e, i) => ({ name: e.name, place: i + 1, sTrack: e.car.sTrack }));
      if (ranked.length > 1) {
        const other = place === 1 ? ranked[1] : ranked[0];
        this.g.storyLeaderGap = Math.abs(this.g.car.sTrack - other.car.sTrack);
      } else this.g.storyLeaderGap = 0;
      /* Position and gap are NOT printed here. js/hud.js already draws both on
         the canvas at x 0.30 and this panel sits at x 0.02; showing them twice
         was the loudest duplication on the screen. This is the running order
         and the gap to each car, which the canvas does not show. */
      if (total > 2 && this.ui.standings) {
        const signature = ranked.map(e => e.name).join('|');
        if (signature !== this.standingSignature) {
          this.standingSignature = signature;
          this.ui.standings.replaceChildren();
          this._standingRows = ranked.map((e, i) => {
            const row = global.document.createElement('li');
            if (e.player) row.className = 'player';
            const rank = global.document.createElement('i');
            const name = global.document.createElement('strong');
            const gap = global.document.createElement('em');
            rank.textContent = ordinal(i + 1);
            name.textContent = cast(e.name).name;
            row.append(rank, name, gap);
            this.ui.standings.appendChild(row);
            return gap;
          });
        }
        if (this._standingRows) {
          const lead = ranked[0].car.sTrack;
          ranked.forEach((e, i) => {
            const cell = this._standingRows[i];
            if (!cell) return;
            const d = Math.round((lead - e.car.sTrack) * .733);
            uiText(cell, i === 0 ? 'LEAD' : '-' + (d > 999 ? '999' : d) + 'M');
          });
        }
      }
    }

    updateStoryAtmosphere() {
      const g = this.g;
      if (this.chapter.id === 3) { g.levelWet = .86; return; }
      if (this.chapter.id !== 4) return;
      const f = smooth(clamp(g.progress || 0, 0, 1));
      const night = g.level && g.level.palette ? g.level.palette : null;
      const sun = night && night.sun ? night.sun : [.42, .50, 1.0];
      g.scene.sunColor = [mix(1.0, sun[0], f), mix(.43, sun[1], f), mix(.16, sun[2], f)];
      g.scene.ambInt = mix(1.42, night && night.ambient !== undefined ? night.ambient : .86, f);
      g.levelWet = mix(.34, night && night.wet !== undefined ? night.wet : .58, f);
    }

    /* ------------------------------------------------ the race that talks --
     *
     * A CHAPTER USED TO BE TEN LINES, A RACE, AND TEN LINES.
     *
     * All of the writing was at the two ends, which is the shape of a visual
     * novel with a race stapled into the middle of it: for the four or five
     * minutes the player is actually DRIVING, the story stops. What little
     * there was sat behind a seven-second cooldown and a handful of triggers,
     * most of which could only fire once and several of which could not fire
     * at all because an earlier one had eaten the window.
     *
     * So the road talks now. Every line below is keyed to something the player
     * DID - took the lead, gave it back, hit four walls, boosted into a corner
     * they should have lifted for, ran clean for half a route - and the two
     * paths hear different halves of it: a crew that came with you calls the
     * corners, and a driver who came alone gets silence and a rival who has
     * noticed. That is the difference between difficulty and characterisation.
     */
    rivalBanter() {
      if (this.compactCooldown > 0 || this.compactLeft > 0) return;
      const g = this.g, c = this.chapter.id;
      const ctx = this.storyCtx();
      const open = ctx.path !== 'edge';
      const once = (key, speaker, expression, text, duration) => {
        if (this.raceFlags[key]) return false;
        this.raceFlags[key] = true;
        this.showCompact(speaker, expression, text, duration);
        /* Four seconds, not seven. The old gap was long enough that a line
           fired at a checkpoint could swallow the reaction to an overtake
           twenty metres later, which is the beat the player most wants
           answered. */
        this.compactCooldown = 4.0;
        return true;
      };
      /* WHAT THE CREW CAN SEE, and only on the path where the player has a
         crew. This is what OPEN buys instead of an easier rival: somebody
         telling you what is about to happen. */
      const spotter = (key, speaker, expression, text) => {
        if (!open) return false;
        return once(key, speaker, expression, text);
      };

      const wallRemark = (escalated) => {
        if (c === 1) return { speaker: 'RYKER', expression: escalated ? 'angry' : 'amused', text: escalated ? "The wall's got a cleaner line than you." : 'You racing me or the guardrail?' };
        if (c === 2) return { speaker: 'KAEL', expression: escalated ? 'shocked' : 'amused', text: escalated ? 'Okay - even I think that is too many walls.' : 'Four impacts! The barriers are winning!' };
        if (c === 3) return { speaker: 'NOVA', expression: 'calculating', text: escalated ? "You're not correcting any more. You're panicking." : 'Fourth wall. Stop steering after the mistake.' };
        if (c === 7) return { speaker: 'NOVA', expression: 'concerned', text: escalated ? 'Every impact is a data point. Stop feeding it.' : 'It logged that. Do not give it a pattern.' };
        return { speaker: escalated ? 'KAEL' : 'NOVA', expression: escalated ? 'shocked' : 'calculating', text: escalated ? 'The car is becoming a percussion instrument!' : 'Four impacts. Aurora is watching those too.' };
      };
      if (this.wallHits >= 7 && !this.raceFlags.wall_spree_2) {
        const line = wallRemark(true);
        return once('wall_spree_2', line.speaker, line.expression, line.text);
      }
      if (this.wallHits >= 4 && !this.raceFlags.wall_spree) {
        const line = wallRemark(false);
        return once('wall_spree', line.speaker, line.expression, line.text);
      }

      /* Reactions come before commentary, everywhere. A player who has just
         taken a place wants that answered more than they want the next
         scheduled remark. */
      const took = this.prevPlace > g.place;
      const lost = this.prevPlace < g.place;

      if (c === 1) {
        if (took) return once('overtake', 'RYKER', 'amused', "Hah. Now we're racing.");
        if (lost && g.progress > .30) return once('retake', 'RYKER', 'smug', 'There it is. That is the part everybody gets wrong.');
        if (g.rivalGap < -115 && g.progress > .08) return once('lead', 'RYKER', 'smug', 'You planning on racing tonight?');
        if (Math.abs(g.rivalGap) < 18 && g.progress > .18) return once('close', 'RYKER', 'neutral', '...Okay. Okay.');
        if (g.progress > .46 && g.place === 1) return once('like', 'RYKER', 'concerned', 'You take the seawall the way he did. Exactly the way he did.');
        if (g.progress > .78) return once('end1', 'RYKER', 'neutral', 'Whatever happens at that line - you asked me a question.');
      } else if (c === 2) {
        if (g.car.offroad) return once('offroad', 'KAEL', 'amused', 'YES! Nothing out here is recording that!');
        if (took) return once('pass', 'KAEL', 'amused', 'Where are you going? I love it.');
        if (g.progress > .12) return once('route', 'KAEL', 'adrenaline', 'Roads are suggestions!');
        if (g.progress > .40) return once('k2', 'KAEL', 'neutral', 'No cameras out here. No relay. Nothing goes to Aurora off this road.');
        if (g.progress > .68) return once('k3', 'KAEL', 'concerned', 'Four drivers, one a month. You think that is a coincidence?');
      } else if (c === 3) {
        if (!this.prevBoost && g.car.boosting && g.progress < .24) return once('early', 'NOVA', 'calculating', 'Too early.');
        if (this.raceFlags.early && lost) return once('why', 'NOVA', 'neutral', "That's why.");
        if (g.car.driftAmount > .72) return once('overdrift', 'NOVA', 'calculating', "You're throwing away the rear.");
        if (took) return once('nice', 'NOVA', 'smug', '...Nice.');
        if (spotter('n_help', 'NOVA', 'calm', 'Wet line is two metres in from dry. Take it earlier than it looks.')) return true;
        if (g.progress > .55) {
          return open
            ? once('n2', 'NOVA', 'calculating', 'Nine years they read him for. You give me a different answer every corner.')
            : once('n2e', 'NOVA', 'calculating', 'Every lap of this goes to Aurora. You decided that was acceptable.');
        }
      } else if (c === 4) {
        if (took && g.progress > .65) return once('finalpass', 'RYKER', 'amused', 'There you are.');
        if (took) return once('pass4', 'KAEL', 'amused', 'Televised! On camera! Do it again!');
        if (g.progress > .18) return once('pack', 'NOVA', 'calm', 'The pack is already breaking.');
        if (g.progress > .48 && g.place > 1) return once('ryker', 'RYKER', 'smug', 'Just like Vector. Only televised.');
        if (g.progress > .74) return once('audition', 'NOVA', 'concerned', 'Whoever crosses that line first gets in the R-IX tonight. Decide if you want that.');
      } else if (c === 5) {
        if (g.progress > .20) return once('ash1', 'NOVA', 'concerned', 'No crews on this route. Nothing behind you.');
        if (g.progress > .44) return once('ash3', 'RYKER', 'neutral', 'Do not back out of this one. Whatever happens.');
        if (g.progress > .62 && g.place === 1) return once('ash2', 'RYKER', 'angry', 'You are not taking this one.');
        if (g.progress > .86) return once('ash4', 'RYKER', 'concerned', "I'm sorry about the car.");
      } else if (c === 7) {
        if (took) return once('p2', 'RAPTOR', 'angry', 'Recalculating.');
        if (g.progress > .10) return once('p1', 'JAVAS', 'calculating', 'It is sampling you. Every corner you take twice, it owns.');
        if (spotter('p_help', 'NOVA', 'calm', 'It has your Mirage exits. Brake later than you want to through here.')) return true;
        if (g.progress > .30) {
          return open
            ? once('p_open1', 'JAVAS', 'calm', 'Link is holding. Profile five is loose - keep it guessing.')
            : once('p_edge1', 'JAVAS', 'calculating', 'Sync window is armed. I need you flat out and I need it soon.');
        }
        if (g.progress > .48) return once('p3', 'NOVA', 'calm', 'raceMode. Spend it where it thinks it knows you.');
        if (g.progress > .62 && g.place > 1) return once('p4', 'RAPTOR', 'smug', 'You always brake here.');
        if (g.progress > .70) {
          return open
            ? once('p_open2', 'JAVAS', 'concerned', 'Three out. Two. Do not converge now - not now.')
            : once('p_edge2', 'NOVA', 'concerned', 'Once he pushes it there is no taking it back. You know what is on there.');
        }
        if (g.progress > .88) return once('p5', 'RAPTOR', 'concerned', 'Why do you not drive the same way twice.');
      }
    }

    onPlayerWallHit(impact) {
      if (this.mode !== 'race' || !this.chapter || impact < .12) return;
      const now = this.g.raceTime || 0;
      if (now - this.lastWallHitAt < .75) return;
      this.lastWallHitAt = now;
      this.wallHits++;
    }

    showCompact(speaker, expression, text, duration) {
      const ui = this.ui, who = cast(speaker);
      ui.compactPortrait.src = portraitOf(speaker, expression || 'neutral', false);
      ui.compactPortrait.alt = who.name + ' portrait';
      ui.compactPortrait.classList.toggle('corrupt', !!who.corrupt);
      ui.compactName.textContent = who.name;
      ui.compactText.textContent = text;
      ui.compact.style.setProperty('--voice', who.voice);
      this.compactDuration = duration || clamp(2.35 + text.length / 27, 2.7, 5.2);
      this.compactLeft = this.compactDuration;
      ui.compactTimer.style.transform = 'scaleX(1)';
      this.setLayer(ui.compact, true);
    }

    updateCompact(dt) {
      /* A dialogue card is part of the road, not part of the interface. While
         a modal is up it is hidden outright rather than merely stopped: the
         pause panel is drawn in the middle of the frame and this sits at the
         top left of it, which is a menu with somebody talking over it. */
      const modal = this.g.state === 'paused' || this.g.state === 'finished';
      if (this.ui && this.ui.compact) {
        this.ui.compact.classList.toggle('story-muted', modal && this.compactLeft > 0);
      }
      if (this.compactLeft <= 0) return;
      this.compactLeft -= dt;
      this.ui.compactTimer.style.transform = 'scaleX(' + clamp(this.compactLeft / this.compactDuration, 0, 1) + ')';
      if (this.compactLeft <= 0) this.hideCompact();
    }

    hideCompact() { this.compactLeft = 0; this.setLayer(this.ui.compact, false); }

    // ------------------------------------------------------------ finish ---

    captureFinishOutcome() {
      const g = this.g;
      const ranked = this.rankedEntrants();
      const playerIndex = Math.max(0, ranked.findIndex(e => e.player));
      /* The base race authority knows Player and Ryker. At the Invitational,
         the complete four-car order is authoritative at the line. */
      if (this.chapter.pack && g.car.sTrack >= g.finishAt) g.won = playerIndex === 0;
      const opponent = g.won
        ? (ranked.find(e => !e.player) || ranked[0])
        : (ranked[0] && !ranked[0].player ? ranked[0] : ranked.find(e => !e.player));
      const gapUnits = opponent ? Math.abs(g.car.sTrack - opponent.car.sTrack) : 0;
      const gapMeters = gapUnits * .733;
      let category = 'close';
      if (gapMeters <= 10) category = 'photo';
      else if (gapMeters >= 999) category = 'clap';
      else if (gapMeters > 300) category = 'dominant';
      else if (gapMeters >= 200) category = 'landslide';
      const rounded = Math.max(1, Math.round(gapMeters));
      return {
        won: !!g.won,
        category,
        gapMeters,
        gapText: rounded === 1 ? '1 metre' : rounded + ' metres',
        opponentName: opponent ? opponent.name : this.chapter.rival,
        opponentCar: opponent ? opponent.car : g.rival,
        wallHits: this.wallHits,
      };
    }

    outcomeLeadIn(o) {
      const c = this.chapter.id;
      if (!o.won) {
        const speaker = this.chapter.pack ? o.opponentName : this.chapter.rival;
        const loss = {
          1: { photo: 'So close. You almost made me nervous.', close: 'You were right there. Still behind me.', landslide: 'Were you planning on racing tonight?', dominant: 'I stopped checking the mirror.', clap: 'That was not a race. You disappeared.' },
          2: { photo: 'SO CLOSE! One bad landing and you had me!', close: 'You nearly stole it on that last jump!', landslide: 'I left you the whole road and you still lost it!', dominant: 'I took the route you would not.', clap: 'HAHA! Did you stop for repairs back there?' },
          3: { photo: 'Close. One correction decided the race.', close: 'Your exits improved. Not enough.', landslide: 'You gave it away one mistake at a time.', dominant: 'The telemetry stopped calling it competitive.', clap: 'We need to discuss fundamentals.' },
          5: { photo: 'A car length. That is all you ever get from me.', close: 'Close. Close is not the seat.', landslide: 'You brought Vector pace to a caldera.', dominant: 'I stopped checking the mirror at the ridge.', clap: 'They are not going to want you after that.' },
          6: { photo: 'A tenth. The diagnostics line does not care about a tenth.', close: 'Nearly. The line still went to me.', landslide: 'You drove that like the car was already broken.', dominant: 'You were never in this cell with me.', clap: 'Go home. Come back with a chassis.' },
          7: { photo: 'One metre. I have your metre now.', close: 'I had that corner from you on Mirage.', landslide: 'Your line converged. That is all I needed.', dominant: 'I am you, driven correctly.', clap: 'Model closed. Thank you for the data.' },
        };
        if (this.chapter.pack) {
          const invitational = {
            RYKER: { photo: 'You were on my door. You were never getting through.', close: 'Close enough to watch me take the seat.', landslide: 'The Invitational broke you before I had to.', dominant: 'I stopped checking the mirror.', clap: 'The Grid expected a fight. So did I.' },
            KAEL: { photo: 'SO CLOSE! I thought you had me!', close: 'That finish was disgusting. I love it.', landslide: 'You picked the safe road. I picked the finish line.', dominant: 'I went somewhere you would not follow.', clap: 'Did you get lost? That is incredible!' },
            NOVA: { photo: 'Close. I left you one opening.', close: 'You adapted. Just a corner too late.', landslide: 'The field exposed every weak exit.', dominant: 'The race stopped being technical.', clap: 'That was a systems failure, not a bad run.' },
          };
          const voice = invitational[speaker] || invitational.RYKER;
          return [{ speaker, expression: o.category === 'photo' ? 'amused' : 'smug', text: voice[o.category], shot: 'rival' }];
        }
        const table = loss[c] || loss[1];
        return [{ speaker, expression: o.category === 'photo' ? 'amused' : 'smug', text: table[o.category], shot: 'rival' }];
      }

      const wins = {
        1: {
          photo: [{ speaker: 'RYKER', expression: 'shocked', text: 'Tch... That was too close.', shot: 'closeup' }],
          close: [{ speaker: 'RYKER', expression: 'neutral', text: 'You barely held it. Do not look so proud.', shot: 'rival' }],
          landslide: [{ speaker: 'RYKER', expression: 'angry', text: 'Do not say a word.', shot: 'closeup' }],
          dominant: [{ speaker: 'RYKER', expression: 'angry', text: 'I lost sight of you. That will not happen again.', shot: 'rival' }],
          clap: [{ speaker: 'RYKER', expression: 'shocked', text: 'What the hell was that...?', shot: 'closeup' }, { speaker: 'RYKER', expression: 'angry', text: 'Do not get comfortable.', shot: 'rival' }],
        },
        2: {
          photo: [{ speaker: 'KAEL', expression: 'amused', text: 'SO CLOSE! I could hear your engine beside me!', shot: 'closeup' }],
          close: [{ speaker: 'KAEL', expression: 'smug', text: 'That last jump nearly changed everything.', shot: 'rival' }],
          landslide: [{ speaker: 'KAEL', expression: 'shocked', text: 'Where the hell did you go?!', shot: 'closeup' }],
          dominant: [{ speaker: 'KAEL', expression: 'amused', text: 'I lost sight of you. On my own road.', shot: 'rival' }],
          clap: [{ speaker: 'KAEL', expression: 'adrenaline', text: 'HAHAHA! You destroyed me! Do it again!', shot: 'closeup' }],
        },
        3: {
          photo: [{ speaker: 'NOVA', expression: 'calculating', text: 'Close. One clean correction decided it.', shot: 'closeup' }],
          close: [{ speaker: 'NOVA', expression: 'neutral', text: 'Clean. Annoyingly clean.', shot: 'rival' }],
          landslide: [{ speaker: 'NOVA', expression: 'shocked', text: 'I underestimated your exit speed.', shot: 'closeup' }],
          dominant: [{ speaker: 'NOVA', expression: 'calculating', text: 'I ran the telemetry twice. Same answer.', shot: 'rival' }],
          clap: [{ speaker: 'NOVA', expression: 'shocked', text: 'That was not variance. You were simply faster.', shot: 'closeup' }],
        },
        4: {
          photo: [{ speaker: 'ANNOUNCER', expression: 'radio', text: 'BY A BREATH! THE INVITATIONAL IS DECIDED AT THE LINE!', shot: 'sky' }],
          close: [{ speaker: 'ANNOUNCER', expression: 'radio', text: 'THE ROOKIE HOLDS THE LINE! SUNSET ZERO IS THEIRS!', shot: 'sky' }],
          landslide: [{ speaker: 'ANNOUNCER', expression: 'radio', text: 'THE ROOKIE HAS BROKEN THE FIELD!', shot: 'sky' }],
          dominant: [{ speaker: 'ANNOUNCER', expression: 'radio', text: 'CLEAR ROAD BEHIND THE ROOKIE! NOBODY IS CLOSE!', shot: 'sky' }],
          clap: [{ speaker: 'ANNOUNCER', expression: 'radio', text: 'THIS IS NOT AN UPSET ANY MORE. IT IS A TAKEOVER!', shot: 'sky' }],
        },
        /* Chapter 7 used to report a prediction percentage here - a number the
           player never had a use for, and which is gone from the chapter
           entirely along with the panel that showed it. What is worth saying
           at that line is what the line itself means: the prototype was beaten
           on the deck it was built to be unbeatable on. */
        7: {
          photo: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON - DECIDED AT THE LINE\nAURORA R-IX: SECOND', shot: 'sky' }],
          close: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON - AURORA R-IX: SECOND', shot: 'sky' }],
          landslide: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON - THE PROTOTYPE NEVER HAD IT', shot: 'sky' }],
          dominant: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON - CLEAR ROAD BEHIND THE ROOKIE', shot: 'sky' }],
          clap: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON - AURORA\'S OWN DECK\nAND IT WAS NOT CLOSE', shot: 'sky' }],
        },
      };
      const table = wins[c];
      if (!table) return [];
      return table[o.category].slice();
    }

    wallAftermathLine(o) {
      if (o.wallHits < 4) return null;
      const c = this.chapter.id;
      if (c === 1) return { speaker: 'RYKER', expression: 'amused', text: 'You won. The body shop won harder.', shot: 'rival' };
      if (c === 2) return { speaker: 'KAEL', expression: 'amused', text: 'You hit half the city and it still drives. Beautiful.', shot: 'rival' };
      if (c === 3) return { speaker: 'NOVA', expression: 'calculating', text: 'The result does not make those impacts intelligent.', shot: 'rival' };
      if (c === 7) return { speaker: 'JAVAS', expression: 'calm', text: 'It recorded every one of those. Fortunately it cannot use them any more.', shot: 'over' };
      return { speaker: 'NOVA', expression: 'calculating', text: 'Aurora saw the pace. They also saw every barrier.', shot: 'over' };
    }

    buildPostDialogue() {
      const o = this.finishOutcome || this.captureFinishOutcome();
      /* A LOSS THAT DID NOT HAPPEN AT THE LINE gets its own lines, because
         the generic ones are written for somebody who was in the fight at the
         end. Being told "now you understand" for a race you were never in is
         the game not having noticed. */
      if (this.forcedLoss === 'JAVAS') {
        return [
          { speaker: 'JAVAS', expression: 'calm', text: 'Stop the car.', shot: 'rival', hold: 0.9 },
          { speaker: 'JAVAS', expression: 'calm', text: 'I am not fitting a driver link to somebody who cannot stay with a man who is not trying.', shot: 'closeup' },
          { speaker: 'PLAYER', expression: 'focus', text: 'The car is wrecked.', shot: 'player' },
          { speaker: 'JAVAS', expression: 'smug', text: 'So is mine. Mine is in front.', shot: 'rival', hold: 1.0 },
          { speaker: 'NOVA', expression: 'calm', text: 'He will run it again. He always runs it again.', shot: 'over' },
          { speaker: 'PLAYER', expression: 'focus', text: 'Again.', shot: 'player' },
        ];
      }
      const lead = this.outcomeLeadIn(o);
      const wall = this.wallAftermathLine(o);
      if (!o.won) {
        if (wall) lead.push(wall);
        lead.push({ speaker: 'PLAYER', expression: 'focus', text: 'Again.', shot: 'player' });
        lead.push({ speaker: o.opponentName, expression: 'smug', text: 'Now you understand.', shot: 'rival' });
        return lead;
      }
      if (wall) lead.push(wall);
      return lead.concat(scene(this.chapter.win, this.storyCtx()));
    }

    handleFinish(callback) {
      if (this.mode !== 'race' || !this.chapter) return false;
      /* Chapter 5's 40-second finale already tells the complete result: the
         player has the pace, Ryker steals the line with HUNT//REDLINE, and the
         R-IX is awarded. That loss is the chapter ending, not a retry state. */
      /* THE SCRIPTED DEFEAT IS A REWARD, AND HAS TO BE EARNED.

         ASHFALL ZERO ends with Ryker stealing the line and the R-IX being
         awarded. That is the chapter FINISHING - it leads to an epilogue
         rather than a retry - and it was unconditional: the director set
         `won = false` on its way into the final cinematic and played the same
         scene whether the player had led all night or been two hundred metres
         down since the caldera. The chapter could not be lost, and a player
         who was beaten was handed the prototype for it.

         It now requires `canonicalEarned`, which the director sets only when
         it actually runs HUNT//REDLINE - and it only runs that when the player
         is in front. Anything else is an ordinary loss and goes where every
         other lost race in this game goes: a word from the man who beat you,
         and the offer to go again. */
      if (this.chapter.canonicalLoss && this.canonicalEarned && !this.forcedLoss) {
        this.finishOutcome = this.captureFinishOutcome();
        this.finishCallback = null;
        this.g.state = 'story';
        this.g.cursorHiddenForRun = false;
        this.g.syncCursorVisibility();
        this.g.raceOver = true;
        this.setLayer(this.ui.raceMeta, false);
        this.setLayer(this.ui.letterbox, true);
        this.hideCompact();
        global.document.body.classList.add('story-cinematic');
        this.startCanonicalLossEpilogue();
        return true;
      }
      this.finishOutcome = this.captureFinishOutcome();
      this.finishCallback = callback;
      this.mode = 'finishRoll';
      this.t = 0;
      this.g.state = 'story';
      this.g.cursorHiddenForRun = false;
      this.g.syncCursorVisibility();
      this.g.audio.playTrack('cutscene');
      this.g.raceOver = true;
      this.finishPlayerS = this.g.car.sTrack;
      this.finishFocusCar = this.finishOutcome.opponentCar || this.g.rival;
      this.finishRivalS = this.finishFocusCar ? this.finishFocusCar.sTrack : this.finishPlayerS - 6;
      this.finishPlayerSpeed = Math.max(24, this.g.car.vLong);
      this.finishRivalSpeed = this.finishFocusCar ? Math.max(24, this.finishFocusCar.vLong) : this.finishPlayerSpeed * .96;
      this.setLayer(this.ui.raceMeta, false);
      this.setLayer(this.ui.letterbox, true);
      this.hideCompact();
      global.document.body.classList.add('story-cinematic');
      return true;
    }

    /* Ashfall's set piece hands back a driver who has been robbed. The beat
       that makes the whole campaign work is delivered here, before the chapter
       card, so the loss reads as somebody taking a bullet rather than as a
       scripted defeat with no explanation attached to it. */
    startCanonicalLossEpilogue() {
      this.mode = 'postDialogue';
      this.currentShot = 'rival';
      this.g.audio.playTrack('cutscene');
      this.dialogue.play([
        { speaker: 'AURORA', expression: 'radio', text: 'EXHIBITION RESULT CONFIRMED\nR-IX PROTOTYPE AND SEAT AWARDED - RYKER', shot: 'sky' },
        { speaker: 'PLAYER', expression: 'damaged', text: 'He hit me. On camera. In front of all of them.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'And they confirmed it in four seconds. They were not watching the race.', shot: 'over' },
        { speaker: 'RYKER', expression: 'damaged', text: '...', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Say something.', shot: 'player' },
        { speaker: 'RYKER', expression: 'concerned', text: 'They were never going to give you a car.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'What?', shot: 'player' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Nine years I wanted the seat. Two weeks and they wanted you.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'smug', text: 'So one of us was getting in that thing tonight.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'shocked', text: 'Ryker. Get out of the car.', shot: 'over' },
        { speaker: 'RYKER', expression: 'amused', text: 'Do not look so grateful. I still won.', shot: 'rival' },
        { speaker: 'AURORA', expression: 'radio', text: 'DRIVER LINK - HANDSHAKE ACCEPTED\nOPERATOR: RYKER', shot: 'sky' },
        { speaker: 'PLAYER', expression: 'shocked', text: 'RYKER...', shot: 'player' },
      ], {
        key: 'chapter_5_epilogue',
        onLine: (line) => this.onDialogueLine(line),
        onDone: () => this.completeChapter(),
      });
    }

    updateFinishRoll(dt) {
      const g = this.g;
      this.baseTick(dt, true);
      this.t += dt;
      const t = this.t;
      const move = (v, t2) => v * t2 * (1 - clamp(t2 / 9, 0, .62));
      this.setVehicle(g.car, this.finishPlayerS + move(this.finishPlayerSpeed, t), g.car.lateral || -3, Math.max(4, this.finishPlayerSpeed * (1 - t / 7)));
      if (this.finishFocusCar) this.setVehicle(this.finishFocusCar, this.finishRivalS + move(this.finishRivalSpeed, t), this.finishFocusCar.lateral || 3, Math.max(4, this.finishRivalSpeed * (1 - t / 7)));
      g.distance = g.car.sTrack;
      const other = this.finishFocusCar || g.rival;
      if (t < 1.15) this.carShot('finish-a', g.car, 'rear');
      else if (t < 2.35) this.pairShot('finish-b', g.car, other, 58);
      else this.carShot('finish-c', g.won ? g.car : other, 'hero');
      if (t > 2.55) this.fire('post', () => this.startPostDialogue());
    }

    startPostDialogue() {
      this.silenceCar();
      this.mode = 'postDialogue';
      this.currentShot = this.g.won ? 'wide' : 'rival';
      this.g.audio.playTrack('cutscene');
      const lines = this.buildPostDialogue();
      const outcome = this.finishOutcome;
      if (!lines.length) return this.g.won ? this.completeChapter() : this.finishAsLegacyLoss();
      this.dialogue.play(lines, {
        key: 'chapter_' + this.chapter.id + (this.g.won ? '_win_' : '_loss_') + outcome.category + (outcome.wallHits >= 4 ? '_walls' : '_clean'),
        onLine: (line) => this.onDialogueLine(line),
        onDone: () => {
          if (!this.g.won) return this.finishAsLegacyLoss();
          /* The finale's race conversation is the end of the RACE. The end of
             the CAMPAIGN is a scene of its own, and which one it is was
             decided three chapters ago. */
          if (this.chapter.finale) return this.startEnding();
          this.completeChapter();
        },
      });
    }

    // ------------------------------------------------------------ ending ---

    /* WHAT THE CAMPAIGN OWES THE PLAYER AT THE END, and used to skip.
     *
     * The old finish was a six-second crane under the words WELCOME TO THE
     * NIGHT and then the hub. Everything the seven chapters set up was left
     * where it was. So this is three movements, in the order an ending is
     * supposed to arrive in:
     *
     *   THE COST      what winning actually did, paid in front of the player
     *                 rather than reported. Both endings hurt here; they hurt
     *                 in different places.
     *   THE CODA      somewhere quiet, afterwards, with the people who are
     *                 left. It is set on Vector Run at midnight in both
     *                 endings, because that is where the prologue started and
     *                 the last image has to answer the first one.
     *   THE RECORD    three cards. What happened to Aurora, what happened to
     *                 the five drivers, and what the Grid looks like now.
     *
     * The two endings run the same three movements with different content, so
     * the second playthrough is a different story told in the same shape
     * rather than the same story with a different caption.
     */
    ending() { return ENDINGS[this.save.endingSeen || this.endingId()] || ENDINGS.open; }

    startEnding() {
      const E = ENDINGS[this.endingId()] || ENDINGS.open;
      this.endingData = E;
      this.save.endingSeen = E.id;
      this.persist();
      this.silenceCar();
      this.mode = 'endingTitle';
      this.t = 0;
      this.marks = Object.create(null);
      this.setDialogueVisible(false);
      this.setLayer(this.ui.letterbox, true);
      global.document.body.classList.add('story-cinematic');
      this.showTitle(E.kicker, E.title, E.subtitle);
      this.g.audio.playTrack('cutscene');
      this.g.flash = Math.max(this.g.flash || 0, .18);
      this.cutTo('ending-title');
    }

    updateEndingTitle(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      this.carShot('ending-title', this.g.car, 'hero');
      if (this.t >= 3.2) {
        this.setLayer(this.ui.titleCard, false);
        this.mode = 'endingDialogue';
        this.currentShot = 'two';
        this.dialogue.play(this.endingData.lines, {
          key: 'ending_' + this.endingData.id + '_lines',
          onLine: (line) => this.onDialogueLine(line),
          onDone: () => this.startEndingCoda(),
        });
      }
    }

    updateEndingDialogue(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
    }

    /* BACK TO WHERE IT STARTED. The prologue opens on Vector Run with eleven
       regulars on a channel that should have twelve; both codas are played on
       the same road so the roll call at the end lands against it. */
    startEndingCoda() {
      this.mode = 'endingCodaFade';
      this.t = 0;
      this.setDialogueVisible(false);
      this.ui.fade.style.opacity = '1';
      this.g.levelIndex = 0;
      this.g.applyLevel();
      this.g.storyRaptor = null;
      this.g.storyHideRival = false;
      this.setVehicle(this.g.car, 1180, -2.4, 26);
      if (this.g.rival) this.setVehicle(this.g.rival, 1164, 3.2, 26);
      this.g.distance = 1180;
      this.cutTo('coda');
    }

    updateEndingCodaFade(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      this.trackShot(this.g.car.sTrack + 30, 22, 15, 28, 180, 54, 'coda-in');
      this.ui.fade.style.opacity = String(clamp(1 - this.t / 1.1, 0, 1));
      if (this.t > 1.2) {
        this.mode = 'endingCoda';
        this.currentShot = 'road';
        this.dialogue.play(this.endingData.coda, {
          key: 'ending_' + this.endingData.id + '_coda',
          onLine: (line) => this.onDialogueLine(line),
          onDone: () => this.startEndingCards(),
        });
      }
    }

    updateEndingCoda(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
    }

    startEndingCards() {
      this.mode = 'endingCards';
      this.t = 0;
      this.cardIndex = -1;
      this.setDialogueVisible(false);
      this.setLayer(this.ui.letterbox, true);
    }

    updateEndingCards(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      // a long, slow lift away from the car, held under all three cards
      this.trackShot(this.g.car.sTrack + 50 + this.t * 16, 30, 16 + this.t * 2.4, 34, 260, 54, 'ending-cards');
      const cards = this.endingData.cards || [];
      const EACH = 3.6;
      const want = Math.min(cards.length, Math.floor(this.t / EACH));
      if (want !== this.cardIndex && want < cards.length) {
        this.cardIndex = want;
        const c = cards[want];
        this.showTitle(c[0], c[1], c[2]);
        this.g.audio.checkpoint();
      }
      if (this.t > cards.length * EACH + 0.6) {
        this.setLayer(this.ui.titleCard, false);
        this.startCredits();
      }
    }

    /* ...AND THEN WHO MADE IT. The ending cards have just faded; the camera is
       already lifting away and the letterbox is already down, so the credits
       inherit both rather than cutting to a screen of their own. */
    startCredits() {
      this.mode = 'endingCredits';
      this.t = 0;
      this.creditIndex = -1;
      this.creditSkip = false;
      this.setDialogueVisible(false);
      this.setLayer(this.ui.letterbox, true);
    }

    updateEndingCredits(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      // the same lift the ending cards are held under, carried on
      this.trackShot(this.g.car.sTrack + 50 + this.t * 16, 30, 16 + this.t * 2.4, 34, 260, 54, 'ending-cards');
      /* SKIPPABLE, NOT PROMPTED. A second run through does not need to read
         them again, and there is no way to offer that without also asking the
         first-time player whether they want the credits at all - which is the
         thing this deliberately does not do. `creditSkip` is set by the
         keydown handler above. */
      const want = this.creditSkip
        ? CREDITS.length
        : Math.min(CREDITS.length, Math.floor(this.t / CREDIT_HOLD));
      if (want !== this.creditIndex && want < CREDITS.length) {
        this.creditIndex = want;
        const c = CREDITS[want];
        this.showTitle(c[0], c[1], c[2]);
        this.g.audio.checkpoint();
      }
      if (this.creditSkip || this.t > CREDITS.length * CREDIT_HOLD + 0.8) {
        this.setLayer(this.ui.titleCard, false);
        this.completeChapter();
      }
    }

    updatePostDialogue(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
    }

    /* END THIS RUN AS A LOSS, FROM ANYWHERE.
     *
     * Every chapter can now be lost, and every chapter loses the same way:
     * the race ends, the rival is acknowledged, and the retry card comes up.
     * Directors call this instead of inventing their own idea of defeat -
     * which is what they were doing, and why two of them had none at all.
     *
     * It goes through `finish` rather than round it, so everything that
     * normally happens at the end of a race still happens: the autosave is
     * cleared, the music changes, the outcome is captured, the conversation
     * runs, and `wantsStoryRetry` is left true for the finish card. A loss
     * that skipped all of that would be a different kind of ending, and the
     * player would feel the difference without being able to name it.
     *
     * `reason` is one short word for what beat them - it picks the lines. */
    loseRace(reason) {
      const g = this.g;
      if (!this.chapter || g.raceOver || this.mode !== 'race') return false;
      this.forcedLoss = reason || 'BEATEN';
      g.won = false;
      g.finish();
      return true;
    }

    finishAsLegacyLoss() {
      const cb = this.finishCallback;
      this.finishCallback = null;
      this.pendingRetryChapter = this.chapter ? this.chapter.id : 0;
      this.mode = 'none';
      this.closeStoryUi();
      global.document.body.classList.remove('story-cinematic');
      if (cb) cb();
    }

    wantsStoryRetry() {
      return !!this.pendingRetryChapter || !!(this.chapter && this.mode === 'race');
    }

    retryChapterRace() {
      const id = this.pendingRetryChapter || (this.chapter && this.chapter.id);
      if (!id) return false;
      this.pendingRetryChapter = 0;
      // the run that was lost is over; this is a different one
      this.forcedLoss = '';
      this.canonicalEarned = false;
      this.finishCallback = null;
      /* A RETRY DOES NOT REPLAY THE COLD OPEN.
         The hook at the top of a chapter is for arriving at it; a player who
         has just lost the race wants the grid, not the scene that set it up.
         Without this the conversation would also still be live underneath the
         retry card - `startChapter` would have started it and the line below
         would have changed the mode out from under it, leaving a dialogue that
         ENTER still advanced and nothing ever finished. */
      this.startChapter(id, { skipColdOpen: true });
      this.mode = 'retryTitle';
      this.t = 0;
      this.showTitle('RETRY // CHAPTER ' + String(id).padStart(2, '0'), this.chapter.track, cast(this.chapter.rival).name + ' // GRID RESET');
      return true;
    }

    updateRetryTitle(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      this.pairShot('retry', this.g.car, this.g.storyRaptor || this.g.rival, 60);
      if (this.t >= 1.5) {
        this.setLayer(this.ui.titleCard, false);
        this.startRaceTransition();
      }
    }

    /* ------------------------------------- NOTHING IS CLEARED BY LOSING --
     *
     * This is the only door out of a chapter, and it did not have a lock on
     * it. Every director that finished its own scripted sequence called it
     * directly, so whether the player had actually beaten anybody was a
     * question each of them answered separately - and two of them did not
     * ask it at all. Chapter 5 could not be lost because its finale set
     * `won = false` and completed anyway; chapter 6 handed over the driver
     * link on the branch where the trial had been failed.
     *
     * So the door checks. A chapter completes when the player WON it, or
     * when it is the one chapter whose written ending is a defeat and that
     * ending was earned. Anything else is a lost race, and a lost race goes
     * where every lost race goes.
     *
     * It is a backstop rather than the mechanism: each chapter decides its
     * own result properly, above. What this stops is the NEXT one being
     * written without a losing condition and nobody noticing for a month.
     */
    completeChapter() {
      const earnedLoss = !!(this.chapter.canonicalLoss && this.canonicalEarned);
      if (!this.g.won && !earnedLoss) {
        if (global.console && global.console.warn) {
          global.console.warn('SYNX: chapter ' + this.chapter.id
            + ' tried to complete without being won - treating it as a loss');
        }
        if (!this.forcedLoss) this.forcedLoss = 'BEATEN';
        return this.finishAsLegacyLoss();
      }
      const id = this.chapter.id;
      this.finishCallback = null;
      this.pendingRetryChapter = 0;
      if (this.save.completedChapters.indexOf(id) < 0) this.save.completedChapters.push(id);
      this.save.highestUnlockedChapter = Math.max(this.save.highestUnlockedChapter, Math.min(LAST_CHAPTER, id + 1));
      this.save.currentChapter = Math.min(LAST_CHAPTER, id + 1);
      if (this.save.unlockedTracks.indexOf(this.chapter.track) < 0) this.save.unlockedTracks.push(this.chapter.track);
      if (id < LAST_CHAPTER && this.save.unlockedTracks.indexOf(CHAPTERS[id + 1].track) < 0) this.save.unlockedTracks.push(CHAPTERS[id + 1].track);
      if (id === 3 && this.save.unlockedTutorialMechanics.indexOf('advancedDriftCalibration') < 0) this.save.unlockedTutorialMechanics.push('advancedDriftCalibration');
      if (id === 6 && this.save.unlockedTutorialMechanics.indexOf('raceMode') < 0) this.save.unlockedTutorialMechanics.push('raceMode');
      this.persist();

      this.g.cleared[id - 1] = Math.max(this.g.cleared[id - 1] | 0, 1);
      try { global.NR.Save.setJSON(LEGACY_PROGRESS_KEY, this.g.cleared); } catch (e) { /* ignore */ }

      this.mode = 'completeCard';
      this.t = 0;
      this.setDialogueVisible(false);
      this.showTitle('CHAPTER ' + String(id).padStart(2, '0') + ' COMPLETE', this.field('rating', ''),
        id < LAST_CHAPTER ? 'NEXT // CHAPTER ' + String(id + 1).padStart(2, '0') + ' - ' + CHAPTERS[id + 1].title : 'WELCOME TO THE NIGHT');
      this.g.audio.playTrack('cutscene');
      this.g.audio.goBeep();
      this.cutTo('complete');
    }

    updateCompleteCard(dt) {
      this.baseTick(dt, false);
      this.t += dt;
      this.carShot('complete', this.g.car, 'hero');
      if (this.t > 3.4) this.afterCompleteCard();
    }

    /* A chapter that owns a fork asks it HERE - after its own ending has been
       paid off and before the next chapter is offered - so the decision is
       about what the player has just learned rather than a menu between two
       levels. Chapters without one go straight on. */
    afterCompleteCard() {
      const pending = this.chapter ? this.choiceAfter(this.chapter.id) : null;
      if (pending) return this.showChoice(pending);
      /* There is no chapter after the finale, so there is nothing to ask. The
         old flow offered CONTINUE? and then a six-second card; the closing
         card is the ending's own, and it names the road not taken. */
      if (this.chapter && this.chapter.finale) return this.showFinale();
      this.showContinuePrompt();
    }

    // ------------------------------------------------------------ forks ----

    showChoice(choice) {
      this.mode = 'choice';
      this.t = 0;
      this.pendingChoice = choice;
      this.g.cursorHiddenForRun = false;
      this.g.syncCursorVisibility();
      this.setLayer(this.ui.titleCard, false);
      this.setLayer(this.ui.letterbox, true);
      const paint = (btn, side) => {
        btn.querySelector('small').textContent = side.sub;
        btn.querySelector('b').textContent = side.label;
        btn.querySelector('em').textContent = side.tag;
      };
      this.ui.choiceKicker.textContent = choice.kicker;
      this.ui.choiceQuestion.textContent = choice.question;
      this.ui.choiceDetail.textContent = choice.detail;
      paint(this.ui.choiceEdge, choice.edge);
      paint(this.ui.choiceOpen, choice.open);
      this.setLayer(this.ui.choice, true);
      this.g.audio.select();
      this.g.flash = Math.max(this.g.flash || 0, .10);
      /* OPEN is focused first on purpose. The default under a player's thumb
         should be the one that costs them the initiative rather than the one
         that costs somebody else.

         Focused NOW and again on the next tick. A browser will refuse to
         focus an element it still considers hidden, and this one is revealed
         in the same statement - so the immediate call is the one that works
         when the layout is already up, and the deferred one is the fallback
         for the frame the panel is first painted on. Doing only the second is
         a card that is briefly not keyboard-reachable, which is exactly the
         window a player pressing ENTER through a cutscene lands in. */
      this.focusSoon(this.ui.choiceOpen);
    }

    updateChoice(dt) {
      this.baseTick(dt, false);
      this.t += dt;
      this.carShot('choice', this.g.car, 'hero');
    }

    commitChoice(which) {
      if (this.mode !== 'choice' || !this.pendingChoice) return;
      const choice = this.pendingChoice;
      this.pendingChoice = null;
      this.setLayer(this.ui.choice, false);
      this.g.audio.select();
      this.g.audio.goBeep();
      this.save.choices = this.save.choices || {};
      this.save.choices[choice.id] = which;
      this.recomputeResolve();
      this.persist();
      /* The answer is spoken back before the next chapter starts, so a
         decision is never only a menu press: somebody reacts to it. */
      const echo = choice[which].echo;
      if (echo && echo.length) {
        this.mode = 'postDialogue';
        this.currentShot = 'two';
        this.dialogue.play(echo, {
          key: 'choice_' + choice.id + '_' + which,
          onLine: (line) => this.onDialogueLine(line),
          onDone: () => this.showContinuePrompt(),
        });
        return;
      }
      this.showContinuePrompt();
    }

    showContinuePrompt() {
      this.mode = 'continuePrompt';
      this.t = 0;
      this.g.cursorHiddenForRun = false;
      this.g.syncCursorVisibility();
      this.setLayer(this.ui.titleCard, false);
      this.setLayer(this.ui.letterbox, true);
      const id = this.chapter.id;
      this.ui.continueNext.textContent = id < LAST_CHAPTER
        ? 'NEXT // CHAPTER ' + String(id + 1).padStart(2, '0') + ' - ' + CHAPTERS[id + 1].title
        : 'CAMPAIGN COMPLETE // EVERY CHAPTER REPLAYABLE';
      this.ui.continueYes.querySelector('b').textContent = id < LAST_CHAPTER ? 'YES' : 'CREDITS';
      this.ui.continueYes.querySelector('small').textContent = id < LAST_CHAPTER ? 'KEEP DRIVING' : 'SEE IT THROUGH';
      this.setLayer(this.ui.continuePrompt, true);
      this.focusSoon(this.ui.continueYes);
    }

    chooseContinue(yes) {
      if (this.mode !== 'continuePrompt') return;
      const id = this.chapter.id;
      this.setLayer(this.ui.continuePrompt, false);
      this.g.audio.select();
      if (!yes) { this.openHub(); return; }
      if (id >= LAST_CHAPTER) this.showFinale();
      else this.startChapter(id + 1, {});
    }

    updateContinuePrompt(dt) {
      this.baseTick(dt, false);
      this.t += dt;
      this.carShot('continue', this.g.car, 'hero');
    }

    /* THE LAST CARD, and it is the only place the game says out loud that
       there were two of these.
       Not a spoiler and not a checklist: it names the ending the player drove
       to and tells them the other one is reachable from the same seven
       chapters, which is the whole reason the decisions were worth making. */
    showFinale() {
      this.closeStoryUi();
      this.setRoot(true);
      this.mode = 'finaleCard';
      this.t = 0;
      this.g.state = 'story';
      this.setLayer(this.ui.letterbox, true);
      this.ui.fade.style.opacity = '.30';
      const E = this.ending();
      const other = E.id === 'edge' ? ENDINGS.open : ENDINGS.edge;
      this.showTitle('WELCOME TO THE NIGHT', E.title,
        'THE ROAD NOT TAKEN // ' + other.title
        + '\nREPLAY THE CAMPAIGN AND DECIDE THE OTHER WAY');
      this.g.audio.playTrack('cutscene');
      global.document.body.classList.add('story-cinematic');
      this.cutTo('finale');
    }

    updateFinaleCard(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      this.trackShot(this.g.car.sTrack + 40 + this.t * 24, 34, 20 + this.t * 1.6, 30, 220, 56, 'finale');
      if (this.t > 7.6) this.openHub();
    }

    // ------------------------------------------------------- pack racing ---

    spawnInvitationalPack() {
      const g = this.g;
      /* Player and Ryker occupy row one through the normal race authority.
         These are the only two additional cars: Nova and Kael, staggered on a
         clean second row so no body is born intersecting another body. */
      /* `station` is how far behind the car in front of it each one races.
         Nova is on Ryker and Kael is on Nova, so the order below the player is
         fixed without any of them being slow: Nova is quick enough to be in
         his mirrors the whole way, Kael is the one who turned up. */
      const grid = [
        { name: 'NOVA', offset: -12, lateral: -5.5, skill: 'HARD', personality: 'nova', station: 46 },
        { name: 'KAEL', offset: -12, lateral: 5.5, skill: 'HARD', personality: 'kael', station: 62 },
      ];
      this.extraRacers = grid.map(cfg => {
        const car = new NR.Vehicle(g.track);
        car.lift = g.car.lift;
        car.reset(g.startAt + cfg.offset, cfg.lateral);
        const driver = new NR.Driver(g.track, cfg.skill);
        driver.personality = cfg.personality;
        return { car, driver, name: cfg.name, station: cfg.station, _model: M4.make() };
      });
      g.storyExtraRacers = this.extraRacers;
    }

    updateInvitationalPack(dt) {
      const g = this.g;
      const allCars = [g.car, g.rival].concat(this.extraRacers.map(e => e.car));
      /* The order below the player. Each entrant holds station on the car in
         front of it - Nova on Ryker, Kael on Nova - so the invitational
         finishes the way the campaign after it says it did. Everything here is
         throttle and brake at the controller: nothing writes a position. */
      let front = g.rival;
      for (const e of this.extraRacers) {
        const ahead = allCars
          .filter(car => car !== e.car && car && car.sTrack >= e.car.sTrack - 2)
          .sort((a, b) => a.sTrack - b.sTrack)[0] || g.car;
        const want = (front ? front.sTrack : e.car.sTrack) - e.station;
        const err = want - e.car.sTrack;          // positive: it is behind station
        // behind: race for it. The pace lever only ever adds, never subtracts.
        e.driver.paceScale = clamp(1 + err / 340, 1, 1.26);
        const cmd = e.driver.drive(dt, e.car, {
          raceOn: g.state === 'racing', rivalS: ahead.sTrack,
          rivalX: ahead.x, rivalZ: ahead.z, finishAt: g.finishAt,
        });
        // Race for position. Only the driver may brake for traffic or corners.
        e.car.update(dt, cmd, g.state === 'racing');
        front = e.car;
      }
      this.resolveInvitationalCollisions();
      this.updateRaceMeta();
      if (!g.raceOver) {
        const winner = this.extraRacers.find(e => e.car.sTrack >= g.finishAt);
        if (winner && g.car.sTrack < g.finishAt && g.rival.sTrack < g.finishAt) {
          g.won = false;
          g.finish();
        }
      }
    }

    resolveInvitationalCollisions() {
      const g = this.g;
      const entrants = this.raceEntrants();
      let hardest = 0, impactCar = null;
      const touched = new Set();
      for (let i = 0; i < entrants.length; i++) {
        for (let j = i + 1; j < entrants.length; j++) {
          const hit = NR.collideCars(entrants[i].car, entrants[j].car);
          if (hit <= 0) continue;
          touched.add(entrants[i].car); touched.add(entrants[j].car);
          if (hit > hardest) {
            hardest = hit;
            impactCar = entrants[i].player ? entrants[i].car : (entrants[j].player ? entrants[j].car : entrants[i].car);
          }
        }
      }
      if (hardest > 2.2) {
        g.audio.crash(Math.min(1, hardest / 14));
        g.shake = Math.max(g.shake || 0, .25 + Math.min(.5, hardest / 20));
        if (g.fx && impactCar) g.fx.sparks(impactCar, Math.min(1, hardest / 14));
      }
      touched.forEach(car => { car.lastHit = false; car.lastHitType = null; });
    }

    // ------------------------------------------------------------ update ---

    update(dt) {
      this.updateCompact(dt);
      switch (this.mode) {
        case 'hub': this.updateHub(dt); break;
        case 'prologue': this.updatePrologue(dt); break;
        case 'prologueDialogue': this.updatePrologueDialogue(dt); break;
        case 'tutorial': this.updateTutorial(dt); break;
        case 'coldOpen': this.updateColdOpen(dt); break;
        case 'chapterTitle': this.updateChapterTitle(dt); break;
        case 'chapterDialogue': this.updateChapterDialogue(dt); break;
        case 'battle': this.updateBattle(dt); break;
        case 'preRace': this.updatePreRace(dt); break;
        case 'retryTitle': this.updateRetryTitle(dt); break;
        case 'raceTransition': this.updateRaceTransition(dt); break;
        case 'finishRoll': this.updateFinishRoll(dt); break;
        case 'postDialogue': this.updatePostDialogue(dt); break;
        case 'completeCard': this.updateCompleteCard(dt); break;
        case 'choice': this.updateChoice(dt); break;
        case 'endingTitle': this.updateEndingTitle(dt); break;
        case 'endingDialogue': this.updateEndingDialogue(dt); break;
        case 'endingCodaFade': this.updateEndingCodaFade(dt); break;
        case 'endingCoda': this.updateEndingCoda(dt); break;
        case 'endingCards': this.updateEndingCards(dt); break;
        case 'endingCredits': this.updateEndingCredits(dt); break;
        case 'continuePrompt': this.updateContinuePrompt(dt); break;
        case 'finaleCard': this.updateFinaleCard(dt); break;
        default: break;
      }
    }

    updateHub(dt) {
      const g = this.g;
      g.time += dt; g.scene.time = g.time;
      g.fade += (g.fadeTarget - g.fade) * Math.min(1, dt * 3);
      g.idleFlyby(dt);
      g.audio.update(g.car, dt, false);
    }

    /* How far the car should be pulled down right now.
     *
     * A cutscene is somebody talking, and the car has to get out of the way of
     * it. Not all the way to nothing, though: several shots are OF the car -
     * the chapter title over a rolling car, the grid before the lights - and a
     * scene that goes completely silent the moment the camera cuts reads as a
     * bug in the other direction. So the modes that are pure UI take it to
     * nothing, and the modes that still show the road keep a bed of it. */
    duckFor(mode) {
      switch (mode) {
        case 'none':
        case 'race':
        case 'tutorial':
          return 0;
        // full-screen cards: there is no road on screen at all
        case 'battle':
        case 'hub':
        case 'completeCard':
        case 'finaleCard':
        case 'continuePrompt':
        case 'retryTitle':
          return 1;
        // somebody is speaking over the road
        case 'chapterDialogue':
        case 'prologueDialogue':
        case 'postDialogue':
        case 'level6Special':
          return 0.92;
        // the car is the shot, but the scene still owns the mix
        default:
          return 0.72;
      }
    }

    baseTick(dt, engineActive) {
      const g = this.g;
      g.audio.setDuck(this.duckFor(this.mode));
      g.time += dt; g.scene.time = g.time;
      g.fade += (g.fadeTarget - g.fade) * Math.min(1, dt * 3);
      g.flash = Math.max(0, (g.flash || 0) - dt * .9);
      g.shake = Math.max(0, (g.shake || 0) - dt * 2.5);
      g.updateAtmosphere(dt);
      g.updateCamera(dt);
      if (g.fx) g.fx.update(dt, g.rival && !g.storyHideRival ? [g.car, g.rival] : g.car, false);
      g.audio.update(g.car, dt, !!engineActive);
      this.lastDt = dt;
    }

    setVehicle(car, s, lateral, speed) {
      if (!car || !this.g.track) return;
      s = clamp(s, 0, this.g.track.length - 2);
      const p = this.g.track.at(s, {});
      const rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      car.sTrack = s;
      /* A director placing a car is authoritative about where it now is, so
         the "furthest point reached" that walls off the road behind it has to
         move with it - otherwise a cinematic that puts the car back down the
         road leaves it against an invisible wall. */
      car.maxS = s;
      car.beached = 0; car.wrongWay = 0;
      car.lateral = lateral || 0;
      car.x = p.x + rx * car.lateral;
      car.z = p.z + rz * car.lateral;
      car.y = (p.y || 0) + (car.lift || 0);
      car.roadY = p.y || 0;
      /* ...and lying along the road rather than level to the world. Zeroing
         this was fine while every cinematic played out on a flat street and
         is not on the finale's deck, where the grade is the point. */
      const back = this.g.track.at(Math.max(0, s - 6), {});
      const ahead = this.g.track.at(Math.min(this.g.track.length - 2, s + 6), {});
      car.yaw = p.yaw; car.pitch = 0; car.roll = 0;
      car.roadPitch = -Math.atan2((ahead.y || 0) - (back.y || 0), 12);
      car.vLong = speed || 0; car.vLat = 0; car.speed = Math.abs(speed || 0);
      car.vx = Math.sin(p.yaw) * (speed || 0);
      car.vz = Math.cos(p.yaw) * (speed || 0);
      car.yawRate = 0; car.steer = 0; car.steerVisual = 0;
      car.bodySlip = 0; car.driftAmount = 0; car.drifting = false; car.boosting = false;
    }

    // ------------------------------------------------------- the camera ----

    /* A named mark. Changing the name is a CUT: the camera is teleported and
       the dolly clock restarts. Holding the name is a HOLD: the camera damps
       toward its (moving, dollying, breathing) mark. */
    cutTo(key) { this.shotKey = key; this.shotAge = 0; this.shotCut = true; }

    commitShot(key, eye, target, fov, hand) {
      const g = this.g;
      if (key !== this.shotKey) { this.shotKey = key; this.shotAge = 0; this.shotCut = true; }
      const dt = this.lastDt || 1 / 60;
      this.shotAge += dt;
      if (hand) {
        // A hand on the camera, not a shake: two slow incommensurate sines so
        // it never repeats inside a shot. This one is part of the mark, so it
        // is applied before the damping and reads as breathing.
        const t = g.time;
        eye[0] += Math.sin(t * 0.87) * 0.055 * hand + Math.sin(t * 2.13) * 0.022 * hand;
        eye[1] += Math.sin(t * 1.19 + 1.7) * 0.040 * hand;
        eye[2] += Math.cos(t * 0.73 + .4) * 0.055 * hand + Math.cos(t * 1.87) * 0.020 * hand;
      }
      if (this.shotCut) {
        this.shotCut = false;
        for (let i = 0; i < 3; i++) { this.shotEye[i] = eye[i]; this.shotTarget[i] = target[i]; }
        this.shotFov = fov;
      } else {
        for (let i = 0; i < 3; i++) {
          this.shotEye[i] = damp(this.shotEye[i], eye[i], 11, dt);
          this.shotTarget[i] = damp(this.shotTarget[i], target[i], 14, dt);
        }
        this.shotFov = damp(this.shotFov, fov, 6, dt);
      }
      /* Impact shake, applied AFTER the damping.
         js/game.js applies g.shake inside updateCamera, and every cinematic
         mark overwrites the eye that produces - so without this a hit during a
         set piece, or the versus sting, moved nothing at all. Damping it with
         the mark would not work either: it oscillates at ~31 Hz and an 11/s
         filter is a low-pass that would swallow it. Same buffet shape as the
         chase camera, added last. */
      const hit = g.shake || 0;
      let bx = 0, by = 0;
      if (hit > 0.001) {
        const t = g.time, k = hit * hit * 1.6;
        bx = (Math.sin(t * 31.0) + Math.sin(t * 47.0) * .45) * k;
        by = (Math.sin(t * 37.0 + 1.7) + Math.sin(t * 23.0) * .35) * k * .55;
      }
      g.eye[0] = this.shotEye[0] + bx;
      g.eye[1] = this.shotEye[1] + by;
      g.eye[2] = this.shotEye[2] + bx * .4;
      g.target[0] = this.shotTarget[0] - bx * .25;
      g.target[1] = this.shotTarget[1] + by * .35;
      g.target[2] = this.shotTarget[2];
      g.fov = this.shotFov + hit * 2.0;
    }

    /** A framing expressed in a car's own axes, with its dolly applied. */
    carShot(key, car, shot, fovBias) {
      if (!car) return;
      const S = CAR_SHOTS[shot] || CAR_SHOTS.hero;
      const age = key === this.shotKey ? this.shotAge : 0;
      const k = clamp(age / 4.2, 0, 1);
      const fx = Math.sin(car.yaw), fz = Math.cos(car.yaw);
      const rx = Math.cos(car.yaw), rz = -Math.sin(car.yaw);
      const f = S.f + S.dolly[0] * k, s = S.s + S.dolly[1] * k, h = S.h + S.dolly[2] * k;
      const eye = this.guardEye(
        [car.x + fx * f + rx * s, car.y + h, car.z + fz * f + rz * s], car.sTrack);
      const target = [car.x + fx * S.tf, car.y + S.th, car.z + fz * S.tf];
      this.commitShot(key, eye, target, (S.fov + (fovBias || 0)) - k * 1.6, S.hand);
    }

    /** Both subjects in one frame, from the flank, biased toward the speaker. */
    pairShot(key, a, b, fov) {
      const g = this.g;
      a = a || g.car; b = b || a;
      const cx = (a.x + b.x) * .5, cz = (a.z + b.z) * .5;
      const spread = Math.hypot(a.x - b.x, a.z - b.z);
      const yaw = a.yaw, fx = Math.sin(yaw), fz = Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const age = key === this.shotKey ? this.shotAge : 0;
      const k = clamp(age / 5, 0, 1);
      const back = 9.5 + spread * .22 + k * 2.2;
      const side = 9.5 + spread * .16 - k * 1.0;
      const base = ((a.y || 0) + (b.y || 0)) * .5;
      const eye = this.guardEye(
        [cx - fx * back + rx * side, base + 2.9 + k * .32, cz - fz * back + rz * side], a.sTrack);
      const target = [cx + fx * 2.0, base + 1.05, cz + fz * 2.0];
      this.commitShot(key, eye, target, (fov || 58) + spread * .10, 0.30);
    }

    /** Over the listener's shoulder onto the speaker. */
    overShot(key, listener, speaker) {
      if (!listener || !speaker) return this.carShot(key, speaker || listener, 'closeup');
      const dx = speaker.x - listener.x, dz = speaker.z - listener.z;
      const len = Math.max(0.001, Math.hypot(dx, dz));
      const ux = dx / len, uz = dz / len;
      // perpendicular, so the shoulder sits in the corner of frame
      const px = -uz, pz = ux;
      const age = key === this.shotKey ? this.shotAge : 0;
      const k = clamp(age / 4.5, 0, 1);
      const eye = this.guardEye([
        listener.x - ux * (2.4 + k * 0.8) + px * 1.9,
        listener.y + 1.62 + k * .05,
        listener.z - uz * (2.4 + k * 0.8) + pz * 1.9,
      ], listener.sTrack);
      const target = [speaker.x, speaker.y + 1.08, speaker.z];
      this.commitShot(key, eye, target, 40 - k * 1.4, 0.55);
    }

    /* Back-compatible names. The Level 5/6/7 directors address shots by the
       original vocabulary and by an absolute field of view; they are mapped
       onto the new marks rather than kept as a second camera path. */
    cameraCar(car, shot, fov) {
      const map = { frontLow: 'low', rearLow: 'rear', wheel: 'wheel', hero: 'hero', closeup: 'closeup', front: 'front' };
      const name = map[shot] || 'hero';
      this.carShot('legacy-' + name, car, name, fov === undefined ? 0 : fov - CAR_SHOTS[name].fov);
    }
    cameraPair(a, b, fov) { this.pairShot('legacy-pair', a, b, fov); }
    cameraBoth(fov) { this.pairShot('legacy-pair', this.g.car, this.g.storyRaptor || this.g.rival, fov); }
    cameraTrack(s, side, height, back, ahead, fov) { this.trackShot(s, side, height, back, ahead, fov, 'legacy-track'); }
    cameraConversation(shot) { if (shot) this.currentShot = shot; this.conversationShot(); }

    /* Nothing may be filmed from outside the world.
       A mark that lands past the barrier films the race through a wall, and a
       mark that lands under the deck films the piers. This pulls an eye back
       inside the road's envelope and above its surface, and it leaves genuine
       crane heights alone: once the lens is well clear of the scenery, being
       wide of the course is the shot. */
    guardEye(eye, hintS) {
      const T = this.g.track;
      if (!T || !T.project) return eye;
      const at = (s) => T.at(clamp(s, 0, T.length - 10), {});
      const from = hintS === undefined ? (this.g.car ? this.g.car.sTrack : 0) : hintS;
      let pr = T.project(eye[0], eye[2], from);
      /* THE LENS AND THE SUBJECT HAVE TO BE IN THE SAME ROOM.
         A `wide` mark stands twenty-six units behind its subject and a `sky`
         mark sixty. The routes carry tunnels over a kilometre long with a
         solid headwall across the whole road at each end, so a car twenty
         units inside one is filmed from outside it - and what fills the frame
         is masonry. Walk the eye along the road toward the subject until the
         two are on the same side of the portal, and stop a few units inside. */
      const subj = at(from);
      if (at(pr.sExact).tunnel !== subj.tunnel) {
        let a = pr.sExact, b = from;
        for (let i = 0; i < 14; i++) {
          const mid = (a + b) * 0.5;
          if (at(mid).tunnel === subj.tunnel) b = mid; else a = mid;
        }
        // b is the first sample on the subject's side; stand clear of the arch
        const want = b + Math.sign(from - b) * 9;
        const p2 = at(want);
        const lat = clamp(pr.lateral, -(T.outerHalf || 20), T.outerHalf || 20);
        eye[0] = p2.x + Math.cos(p2.yaw) * lat;
        eye[2] = p2.z + -Math.sin(p2.yaw) * lat;
        pr = T.project(eye[0], eye[2], want);
      }
      const road = at(pr.sExact);
      const roadY = road.y || 0;
      if (eye[1] < roadY + 0.75) eye[1] = roadY + 0.75;
      const above = eye[1] - roadY;
      const outer = T.outerHalf || 20;
      // inside a bore there is a ceiling as well as walls
      const cap = road.tunnel ? outer * 0.84 : outer - 1.6;
      if (road.tunnel && above > 15.5) eye[1] = roadY + 15.5;
      // ...and never so close to a portal that the arch is the shot

      const free = road.tunnel ? 0 : clamp((above - 30) / 16, 0, 1);
      const lim = cap + Math.max(0, Math.abs(pr.lateral) - cap) * free;
      if (Math.abs(pr.lateral) > lim) {
        const pull = (Math.abs(pr.lateral) - lim) * -Math.sign(pr.lateral || 1);
        eye[0] += Math.cos(pr.yaw) * pull;
        eye[2] += -Math.sin(pr.yaw) * pull;
      }
      return eye;
    }

    /** A mark relative to the road itself, for cranes and broadcast angles. */
    trackShot(s, side, height, back, ahead, fov, key) {
      const g = this.g, T = g.track;
      const sc = clamp(s, 0, T.length - 10);
      const p = T.at(sc, {});
      const roadY = p.y || 0;
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
      /* HEIGHT IS RELATIVE TO THE ROAD, not to sea level. Chapter 7 runs over
         plateaus twenty-six units up and through a trench eight down; an
         absolute mark authored for the flat districts puts the lens under the
         deck on either of them. */
      const outer = T.outerHalf || 20;
      const cap = p.tunnel ? outer * 0.84 : outer - 1.6;
      let h = Math.max(1.2, p.tunnel ? Math.min(height, 15.5) : height);
      const free = p.tunnel ? 0 : clamp((h - 30) / 16, 0, 1);
      let lat = side;
      if (Math.abs(lat) > cap) lat = Math.sign(lat) * (cap + (Math.abs(lat) - cap) * free);
      /* The analytic clamp above is done at `s`; the lens actually stands
         `back` units behind it, which on a corner is a different piece of road
         with a different barrier and possibly a tunnel. Guard where it lands,
         not where it was authored. */
      const eye = this.guardEye(
        [p.x + rx * lat - fx * back, roadY + h, p.z + rz * lat - fz * back], sc);
      /* ...and the camera looks down the ROAD, not down the tangent. Three
         hundred units of "ahead" through a corner is off the course and into
         the scenery beside it, which is how a broadcast angle ends up framing
         an empty lot while the cars go past behind the lens. */
      const look = T.at(clamp(sc + ahead, 0, T.length - 10), {});
      const target = [look.x, (look.y || 0) + Math.min(12, 3 + Math.abs(ahead) * 0.06), look.z];
      this.commitShot(key || this.shotKey || 'track', eye, target, fov || 60, 0.22);
    }

    establishingShot() {
      const t = this.t;
      const s = this.g.startAt + 26 + t * 7;
      this.trackShot(s, 30 - t * 1.4, 17 - t * 0.9, 24, 92, 56, 'chapter-establish');
    }

    /** The car a speaker is actually inside, or null for a voice on a channel. */
    carForSpeaker(speaker) {
      if (!speaker) return null;
      const who = cast(speaker);
      if (who.body === 'player') return this.g.car;
      if (who.body !== 'rival') return null;
      const extra = this.extraRacers.find(e => e.name === speaker);
      if (extra) return extra.car;
      if (this.chapter && this.chapter.rival === speaker) return this.g.rival;
      // Chapter 5 fields Ryker; the R-IX wearing him in Chapter 7 is the same
      // seat, so either identifier resolves to the rival body.
      if (this.chapter && this.chapter.finale && (speaker === 'RAPTOR' || speaker === 'RYKER')) return this.g.rival;
      if (this.chapter && this.chapter.pack && speaker === 'RYKER') return this.g.rival;
      // A rival who is present in the scene but is not this chapter's rival -
      // Nova standing at Ashfall, Ryker's wreck in the epilogue - has no body,
      // and must NOT borrow one.
      return null;
    }

    onDialogueLine(line) {
      this.currentShot = line.shot || null;
      this.currentSpeaker = line.speaker;
      // A cut per line: the shot key carries the line index so two consecutive
      // lines on the same framing still re-cut and restart the dolly.
      this.shotSerial = (this.shotSerial || 0) + 1;
    }

    /* Resolve a line's tag against who is actually on the road. This is the
       whole fix for the wrong-angle cutscenes: a tag never selects a car, it
       selects a RELATIONSHIP, and the relationship is resolved per line. */
    conversationShot() {
      const g = this.g;
      const speakerCar = this.carForSpeaker(this.currentSpeaker);
      const isPlayer = this.currentSpeaker === 'PLAYER';
      const other = speakerCar && speakerCar !== g.car ? speakerCar : (g.storyRaptor || g.rival);
      const key = 'dlg' + (this.shotSerial || 0);
      let tag = this.currentShot;
      if (!tag) tag = isPlayer ? 'player' : (speakerCar ? 'rival' : 'sky');

      switch (tag) {
        case 'player':
          return this.carShot(key, g.car, isPlayer ? 'closeup' : 'hero');
        case 'closeup':
          // A disembodied voice has nothing to close in on: hold the listener.
          return this.carShot(key, speakerCar || g.car, 'closeup');
        case 'rival':
          // The core repair. No body means no borrowed close-up.
          return speakerCar
            ? this.carShot(key, speakerCar, 'hero')
            : this.carShot(key, g.car, 'hero', 2);
        case 'over':
          return speakerCar && speakerCar !== g.car
            ? this.overShot(key, g.car, speakerCar)
            : this.carShot(key, g.car, 'closeup');
        case 'two':
          return this.pairShot(key, g.car, other, 58);
        case 'low':
          return this.carShot(key, speakerCar || g.car, 'low');
        case 'wheel':
          return this.carShot(key, speakerCar || g.car, 'wheel');
        case 'rear':
          return this.carShot(key, speakerCar || g.car, 'rear');
        case 'road':
          // Down the route, from just off the racing line.
          return this.trackShot(g.car.sTrack + 66, 15, 3.4, 12, 150, 62, key);
        case 'sky':
          // Broadcast: high, wide, looking down the road the voice is talking about.
          return this.trackShot(g.car.sTrack + 20, 24, 46, 60, 300, 52, key);
        case 'wide':
        default:
          return this.trackShot(g.car.sTrack + 8, 26, 13, 26, 110, 56, key);
      }
    }
  }

  NR.StoryManager = StoryManager;
  NR.campaignComplete = campaignComplete;
  NR.STORY_LAST_CHAPTER = LAST_CHAPTER;
  NR.STORY_CHAPTERS = CHAPTERS;
  NR.STORY_CAST = CAST;
  /* The branch, published so tools/check.py story can walk every chapter down
     both paths without having to win seven races to see the second one. A
     scene is a pure function of its context (see `storyCtx`), which is the
     property that makes that walk exhaustive rather than a sample. */
  NR.STORY_CHOICES = CHOICES;
  NR.STORY_ENDINGS = ENDINGS;
  NR.STORY_CREDITS = CREDITS;
  NR.STORY_SCENE = scene;
  NR.STORY_PICK = pick;
  NR.STORY_PATH_OF = pathOf;

  const GP = NR.Game.prototype;
  const oldLoad = GP.load;
  GP.load = async function () {
    await oldLoad.call(this);
    if (!this.story) {
      this.story = new StoryManager(this);
      this.story.attach();
    }
  };

  const oldUpdate = GP.update;
  GP.update = function (dt) {
    if (this.story && this.story.isExclusive()) {
      this.story.update(dt);
      return;
    }
    oldUpdate.call(this, dt);
    if (this.story) {
      // the story is not driving this frame, so whatever it ducked comes back
      this.audio.setDuck(0);
      this.story.afterNormalUpdate(dt);
    }
  };

  const oldFinish = GP.finish;
  GP.finish = function () {
    if (this.story && this.story.handleFinish(() => oldFinish.call(this))) return;
    oldFinish.call(this);
  };

  const oldBeginRace = GP.beginRace;
  GP.beginRace = function () {
    if (this.story && this.story.wantsStoryRetry && this.story.wantsStoryRetry()) {
      if (this.story.retryChapterRace()) return;
    }
    oldBeginRace.call(this);
  };

  const oldMenu = GP.toMenu;
  GP.toMenu = function () {
    oldMenu.call(this);
    if (this.story) this.story.onMainMenu();
  };
})(window);
