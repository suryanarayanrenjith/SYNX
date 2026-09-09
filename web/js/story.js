/* SYNX Story Mode — WELCOME TO THE NIGHT
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
     Seven chapters with one spine running through them: Aurora Motorworks is
     finishing an autonomous chassis on telemetry stolen off the Grid, and the
     model cannot close because the player is the one line it has never been
     able to predict. Every rival is somewhere on that thread - Ryker gets
     recruited by it, Kael is the first to notice it, Nova helped build it,
     Javas designed the link at its centre, and the R-IX is what it becomes. */
  const CHAPTERS = [
    null,
    {
      id: 1, title: 'FIRST BLOOD', track: 'VECTOR RUN', rival: 'RYKER',
      levelIndex: 0, personality: 'ryker', diff: 1,
      rating: 'UNRANKED → ROOKIE',
      brief: 'THE VOICE ON THE OPEN CHANNEL WANTS ONE RUN.\nHE IS RANKED FIRST AND HE IS BORED.',
      intro: [
        { speaker: 'RYKER', expression: 'smug', text: "So you're the one who answered.", shot: 'over' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'You called the whole channel.', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'I called the whole channel for a month.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Nobody comes to Vector any more. They watch the replays and go home.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'smug', text: "Eleven minutes of dark a night, and everyone's decided that's my eleven minutes.", shot: 'two' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Then hand it over.', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'There it is.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'smug', text: "One run. Vector to the seawall.\nTry keeping me in the frame.", shot: 'rival' },
      ],
      win: [
        { speaker: 'GRID', expression: 'radio', text: 'GRID RATING UPDATED\nUNRANKED → ROOKIE', shot: 'sky' },
        { speaker: 'RYKER', expression: 'concerned', text: '...', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Again.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'You just lost.', shot: 'player' },
        { speaker: 'RYKER', expression: 'smug', text: 'Exactly. Nobody has done that in nine months.', shot: 'rival' },
        { speaker: 'GRID', expression: 'radio', text: 'EXTERNAL RELAY // TELEMETRY REQUEST\nAURORA MOTORWORKS — GRANTED', shot: 'sky' },
        { speaker: 'RYKER', expression: 'neutral', text: '...Huh.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'What was that?', shot: 'player' },
        { speaker: 'RYKER', expression: 'smug', text: "Somebody watching. Get used to it - that's what winning buys you.", shot: 'two' },
      ],
    },
    {
      id: 2, title: 'NO BRAKES', track: 'THE SPINE', rival: 'KAEL',
      levelIndex: 1, personality: 'kael', diff: 1,
      rating: 'ROOKIE → STREET',
      brief: 'KAEL RACES THE GAPS BETWEEN THE ROUTES.\nHE HAS A REASON, AND NOBODY BELIEVES IT.',
      intro: [
        { speaker: 'GRID', expression: 'radio', text: 'CHANNEL 7 // 4,200 LISTENING', shot: 'sky' },
        { speaker: 'KAEL', expression: 'amused', text: 'You beat Ryker on Vector.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'On a surveyed route.', shot: 'player' },
        { speaker: 'KAEL', expression: 'smug', text: 'Right. Surveyed. Lit. Timed to the hundredth.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'adrenaline', text: 'Every metre of Vector is a camera. That is the whole reason people race it.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'So race somewhere else.', shot: 'player' },
        { speaker: 'KAEL', expression: 'amused', text: 'THANK you.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'adrenaline', text: 'The Spine. Service road, freight ramps, whatever is holding up the overpass this week.', shot: 'road' },
        { speaker: 'PLAYER', expression: 'surprised', text: "Half of that isn't road.", shot: 'player' },
        { speaker: 'KAEL', expression: 'amused', text: 'Exactly. Nothing out there is recording.', shot: 'two' },
      ],
      win: [
        { speaker: 'KAEL', expression: 'damaged', text: '...', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'amused', text: 'HAHAHAHA! You took the ramp!', shot: 'rival' },
        { speaker: 'KAEL', expression: 'smug', text: 'Okay. You are actually fun.', shot: 'closeup' },
        { speaker: 'GRID', expression: 'radio', text: 'AURORA MOTORWORKS\nDRIVER PROFILE FLAGGED — TIER 2', shot: 'sky' },
        { speaker: 'KAEL', expression: 'concerned', text: 'There it is.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'neutral', text: "It's a sponsor ping.", shot: 'player' },
        { speaker: 'KAEL', expression: 'neutral', text: 'Sure. Marchetti got one. Tier 2. Took the invitation.', shot: 'rival' },
        { speaker: 'KAEL', expression: 'concerned', text: 'Nobody has seen him on the Grid since March.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'adrenaline', text: 'Four before him. Same ping, same month, gone.', shot: 'two' },
        { speaker: 'PLAYER', expression: 'focus', text: '...And you race where nothing records.', shot: 'player' },
        { speaker: 'KAEL', expression: 'smug', text: 'Now you get it.', shot: 'rival' },
      ],
    },
    {
      id: 3, title: 'QUEEN OF NEON', track: 'MIRAGE CIRCUIT', rival: 'NOVA',
      levelIndex: 2, personality: 'nova', diff: 2,
      rating: 'STREET → VECTOR',
      brief: 'NOVA VEYRA DROVE FOR AURORA FOR SIX YEARS.\nSHE WANTS TO SEE WHAT THEY FLAGGED.',
      intro: [
        { speaker: 'NOVA', expression: 'calm', text: 'Mirage. In this weather. On purpose.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'You picked it.', shot: 'player' },
        { speaker: 'NOVA', expression: 'calculating', text: 'I picked it because wet Mirage is the only route on the Grid where being fast is not enough.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'neutral', text: 'Kael told you about the pings.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'He did.', shot: 'player' },
        { speaker: 'NOVA', expression: 'calm', text: 'He is right, and he is missing the point.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: "They are not scouting drivers. They are finishing a car.", shot: 'rival' },
        { speaker: 'NOVA', expression: 'neutral', text: 'R-IX. Six years of my hands on the handling model, and the last piece was never mine.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'You built it.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'I built half of it. Then I read what the other half was for, and I left.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'smug', text: 'Now. Are you actually fast, or just unpredictable enough to be interesting to them?', shot: 'two' },
      ],
      win: [
        { speaker: 'NOVA', expression: 'calculating', text: "You're abusing the rear differential.", shot: 'over' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'I won.', shot: 'player' },
        { speaker: 'NOVA', expression: 'neutral', text: 'You won because you are never twice in the same place.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: 'Every driver on this Grid converges on one line. Six laps and I can drive theirs better than they can.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'concerned', text: 'You do not converge. I have three corners of you and none of them agree.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: "That's a compliment?", shot: 'player' },
        { speaker: 'NOVA', expression: 'neutral', text: 'It is a warning. That is exactly the data their model is missing.', shot: 'rival' },
        { speaker: 'GRID', expression: 'radio', text: 'AURORA MOTORWORKS\nMIDNIGHT INVITATIONAL — ENTRY CONFIRMED', shot: 'sky' },
        { speaker: 'NOVA', expression: 'calm', text: 'And there is the invitation.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Then I should not go.', shot: 'player' },
        { speaker: 'NOVA', expression: 'smug', text: "They already have you. Going is the only way to see what they built.", shot: 'two' },
      ],
    },
    {
      id: 4, title: 'THE GOLDEN RUN', track: 'SUNSET ZERO', rival: 'RYKER',
      levelIndex: 3, personality: 'ryker', diff: 1, pack: true,
      rating: 'VECTOR → INVITATIONAL',
      brief: 'FOUR CARS. SANCTIONED. TELEVISED.\nEVERYONE KNOWS IT IS A CASTING CALL.',
      intro: [
        { speaker: 'ANNOUNCER', expression: 'radio', text: 'Sunset Zero. Four entrants. Aurora Motorworks presents the Midnight Invitational.', shot: 'sky' },
        { speaker: 'ANNOUNCER', expression: 'radio', text: 'The winner takes the Exhibition seat.', shot: 'wide' },
        { speaker: 'KAEL', expression: 'amused', text: 'Legal race. Lit road. Cameras on every post.', shot: 'rival' },
        { speaker: 'KAEL', expression: 'smug', text: 'I hate everything about tonight and I would not miss it.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: "It's not a race, it's an audition. They will take whoever wins.", shot: 'rival' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Good.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'concerned', text: 'Ryker.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'smug', text: "I've been on this Grid nine years, Nova. Nine.", shot: 'closeup' },
        { speaker: 'RYKER', expression: 'angry', text: 'They flagged a rookie in two weeks and they have never once looked at me.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: "You want them to take you.", shot: 'player' },
        { speaker: 'RYKER', expression: 'neutral', text: "Don't expect me to wait for the pack.", shot: 'two' },
      ],
      win: [
        { speaker: 'ANNOUNCER', expression: 'radio', text: 'The Exhibition seat goes to the rookie.', shot: 'sky' },
        { speaker: 'RYKER', expression: 'neutral', text: 'You know what I hate about you?', shot: 'over' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'Long list?', shot: 'player' },
        { speaker: 'RYKER', expression: 'angry', text: 'Every time I get faster...', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'smug', text: '...you do too. Nine years, and you did it in fourteen days.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'neutral', text: 'See you at the Exhibition.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: "He's planning something.", shot: 'rival' },
        { speaker: 'KAEL', expression: 'amused', text: 'Obviously. He was smiling.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'concerned', text: 'Ryker does not smile after he loses.', shot: 'closeup' },
        { speaker: 'KAEL', expression: 'smug', text: '...Okay, that one got me.', shot: 'two' },
      ],
    },
    {
      id: 5, title: 'ASHFALL ZERO', track: 'ASHFALL ZERO', rival: 'RYKER',
      levelIndex: 4, personality: 'ryker', diff: 1,
      canonicalLoss: true,
      rating: 'RESULT STOLEN // R-IX REVEALED',
      brief: 'THE EXHIBITION. NO CREWS, NO BARRIERS.\nTHE PRIZE IS THE CAR THEY BUILT FROM YOU.',
      intro: [
        { speaker: 'AURORA', expression: 'radio', text: 'AURORA EXHIBITION — ASHFALL ZERO\nEAST CITY THROUGH THE CALDERA. NO SAFETY CREWS ON ROUTE.', shot: 'sky' },
        { speaker: 'AURORA', expression: 'radio', text: 'PRIZE OF RECORD: R-IX PROTOTYPE AND THE AURORA SEAT ATTACHED TO IT.', shot: 'wide' },
        { speaker: 'NOVA', expression: 'calculating', text: "There it is in writing. They're not hiding it any more.", shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'They put the car up as the prize.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'Because the car is not the prize. Whoever wins gets in it. That is the point.', shot: 'over' },
        { speaker: 'RYKER', expression: 'neutral', text: 'You took every road that led here.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'neutral', text: 'You sound like you rehearsed that.', shot: 'player' },
        { speaker: 'RYKER', expression: 'angry', text: "You're not taking this one.", shot: 'rival' },
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
      intro: [
        { speaker: 'NOVA', expression: 'calm', text: "Stop watching the replay.", shot: 'over' },
        { speaker: 'PLAYER', expression: 'damaged', text: "I didn't lose that race.", shot: 'player' },
        { speaker: 'NOVA', expression: 'neutral', text: 'I know. Everyone watching knows.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'damaged', text: 'Then why does it feel like I did?', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: 'Because your car is in three diagnostic bays and Ryker is eleven days inside theirs.', shot: 'over' },
        { speaker: 'NOVA', expression: 'smug', text: 'Come on. There is one person left who knows what they turned on.', shot: 'road' },
        { speaker: 'JAVAS', expression: 'calm', text: 'Nova brings me a driver and half a car.', shot: 'rival' },
        { speaker: 'NOVA', expression: 'smug', text: 'The useful half.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'You worked for Aurora.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'calculating', text: 'I designed the driver link. Twelve years of it.', shot: 'closeup' },
        { speaker: 'JAVAS', expression: 'calm', text: 'Then they pointed it the other way round, and I walked out through that door.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'The other way round.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'smug', text: 'In this factory, everything is a test. Survive mine and I will explain what that means.', shot: 'two' },
      ],
      win: [],
    },
    {
      id: 7, title: 'PREDATOR', track: 'NEON HORIZON', rival: 'RAPTOR',
      levelIndex: 6, personality: 'ryker', diff: 2,
      finale: true,
      rating: 'VECTOR → NIGHT',
      brief: 'AURORA’S OWN TEST ROUTE, ABOVE THE CITY.\nIT IS LEARNING YOU IN REAL TIME.',
      intro: [
        { speaker: 'JAVAS', expression: 'calculating', text: 'Neon Horizon. Aurora built this deck to validate the R-IX. Nobody has ever raced it.', shot: 'sky' },
        { speaker: 'NOVA', expression: 'calm', text: 'It answered your channel request in four seconds.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Then he wants this too.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'concerned', text: 'Careful with that word.', shot: 'over' },
        { speaker: 'RAPTOR', expression: 'smug', text: 'So you came all the way up here.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'Ryker.', shot: 'player' },
        { speaker: 'RAPTOR', expression: 'smug', text: 'One run. Try keeping me in the frame.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'shocked', text: '...He said that to me on Vector. Word for word.', shot: 'player' },
        { speaker: 'NOVA', expression: 'concerned', text: 'It has eleven days of him. It uses his lines because they worked.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'It has fourteen days of you too. Every route, every corner, every mistake.', shot: 'over' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Not every corner.', shot: 'player' },
        { speaker: 'JAVAS', expression: 'smug', text: 'No. Not one of them twice.', shot: 'closeup' },
        { speaker: 'NOVA', expression: 'calculating', text: 'Thirty seconds of raceMode. Spend them where the model is certain.', shot: 'over' },
        { speaker: 'RAPTOR', expression: 'angry', text: 'I can hear that channel.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'focus', text: 'Good.', shot: 'two' },
      ],
      win: [
        { speaker: 'GRID', expression: 'radio', text: 'AURORA DRIVER LINK // SYNC LOST\nR-IX — OPERATOR RELEASED', shot: 'sky' },
        { speaker: 'RAPTOR', expression: 'damaged', text: 'Th— that is not— recalculating—', shot: 'rival' },
        { speaker: 'RAPTOR', expression: 'angry', text: 'The line was correct. The line was CORRECT—', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'focus', text: 'It was. That was the problem.', shot: 'player' },
        { speaker: 'NOVA', expression: 'calculating', text: 'It only ever had one answer. You never gave it the same question.', shot: 'over' },
        { speaker: 'RYKER', expression: 'damaged', text: '...', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'concerned', text: 'Eleven days.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'surprised', text: 'Ryker?', shot: 'player' },
        { speaker: 'RYKER', expression: 'neutral', text: 'Own channel. Own voice. First time in eleven days.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'concerned', text: 'They were never going to give you a car. You were the car.', shot: 'rival' },
        { speaker: 'RYKER', expression: 'smug', text: 'So I took the seat at Ashfall so they would take me instead.', shot: 'closeup' },
        { speaker: 'PLAYER', expression: 'shocked', text: 'You threw the Exhibition to get in front of me.', shot: 'player' },
        { speaker: 'RYKER', expression: 'amused', text: 'I WON the Exhibition. Do not rewrite my results.', shot: 'closeup' },
        { speaker: 'RYKER', expression: 'neutral', text: '...You took your time coming to get me.', shot: 'rival' },
        { speaker: 'KAEL', expression: 'amused', text: 'HE IS ALIVE! I am putting this on every channel.', shot: 'sky' },
        { speaker: 'NOVA', expression: 'smug', text: 'Javas. The model.', shot: 'over' },
        { speaker: 'JAVAS', expression: 'calm', text: 'Gone. It converged on a driver who does not exist.', shot: 'over' },
        { speaker: 'GRID', expression: 'radio', text: 'GRID RATING UPDATED\nVECTOR → NIGHT', shot: 'sky' },
        { speaker: 'RYKER', expression: 'smug', text: 'Vector Run. Midnight. Bring all of them.', shot: 'rival' },
        { speaker: 'PLAYER', expression: 'smirk', text: 'Try keeping me in the frame.', shot: 'two' },
      ],
    },
  ];

  /* Grid rating by chapters cleared - the hub dossier reads from this. */
  const RATINGS = ['UNRANKED', 'ROOKIE', 'STREET', 'VECTOR', 'INVITATIONAL', 'EXHIBITION', 'SYNCHRONIZED', 'NIGHT'];

  class StorySave {
    static fresh() {
      return {
        version: 2,
        hasSeenPrologue: false,
        currentChapter: 1,
        highestUnlockedChapter: 1,
        completedChapters: [],
        unlockedTracks: [],
        unlockedTutorialMechanics: [],
        seenDialogues: {},
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
      } catch (e) { /* corrupt save: a fresh story is safe */ }
      return base;
    }

    static write(data) {
      try { global.NR.Save.setJSON(SAVE_KEY, data); }
      catch (e) { /* private mode still gets a playable in-memory campaign */ }
    }
  }

  class DialogueController {
    constructor(story) {
      this.story = story;
      this.active = false;
      this.lines = [];
      this.index = 0;
      this.visible = 0;
      this.delay = 0;
      this.cps = 40;
      this.finishedLine = false;
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
      this.key = opts.key || null;
      this.onDone = opts.onDone || null;
      this.onLine = opts.onLine || null;
      this.cps = opts.cps || 40;
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
      this.delay = first ? 0.10 : 0.05;
      this.finishedLine = false;
      this.lastBlip = 0;
      if (this.onLine) this.onLine(line, this.index);
    }

    update(dt) {
      if (!this.active) return;
      const line = this.lines[this.index];
      if (!line || this.finishedLine) return;
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
          else if (ch === '—' || ch === '…') this.delay += 0.16;
          if (/[^\s.,!?—…]/.test(ch) && i - this.lastBlip >= 3) {
            this.lastBlip = i;
            this.story.textBlip(line.speaker);
          }
        }
      }
      uiText(this.story.ui.text, line.text.slice(0, Math.floor(this.visible)));
      if (this.visible >= line.text.length) this.finishLine();
    }

    finishLine() {
      const line = this.lines[this.index];
      if (!line) return;
      this.visible = line.text.length;
      uiText(this.story.ui.text, line.text);
      this.finishedLine = true;
      this.story.ui.dialogue.classList.remove('typing');
      this.story.ui.cont.classList.add('show');
    }

    advance() {
      if (!this.active) return;
      if (!this.finishedLine) { this.finishLine(); return; }
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
        e.preventDefault(); e.stopPropagation(); this.dialogue.advance();
      });
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
      if (this.dialogue.active && (k === 'enter' || k === ' ')) { stop(); this.dialogue.advance(); return; }
      if (this.dialogue.active && k === 'k') { stop(); this.dialogue.skip(); return; }
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

    setLayer(el, on) {
      if (!el) return;
      el.classList.toggle('show', !!on);
      el.setAttribute('aria-hidden', on ? 'false' : 'true');
    }

    hideTransient() {
      for (const el of [this.ui.titleCard, this.ui.radio, this.ui.battle, this.ui.continuePrompt, this.ui.tutorial, this.ui.waypoint, this.ui.raceMeta]) this.setLayer(el, false);
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
      this.ui.hubStatus.textContent = finished
        ? 'Campaign complete. The R-IX model never closed, Ryker is back on his own channel, and the Grid is yours. Every chapter can be replayed.'
        : 'Chapter ' + current + ' — ' + CHAPTERS[current].title + '. ' + CHAPTERS[current].brief.replace(/\n/g, ' ');

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
        const art = global.document.createElement('img');
        art.src = portraitOf(c.rival, 'neutral', false);
        art.alt = '';
        const num = global.document.createElement('small');
        const title = global.document.createElement('b');
        const meta = global.document.createElement('span');
        const state = global.document.createElement('i');
        num.textContent = 'CHAPTER ' + String(i).padStart(2, '0');
        title.textContent = c.title;
        meta.textContent = cast(c.rival).name + ' // ' + c.track;
        state.textContent = cleared ? 'CLEARED — REPLAY' : (unlocked ? (i === current ? 'NEXT — PLAY' : 'PLAY') : 'LOCKED');
        b.append(art, num, title, meta, state);
        /* Hover and keyboard focus share the same active treatment. This is
           explicit rather than relying on a tiny transform alone, so each
           chapter remains unmistakably selectable over bright portrait art. */
        const setActive = (on) => b.classList.toggle('is-highlighted', on && unlocked);
        b.addEventListener('pointerenter', () => setActive(true));
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

    /** Every chapter cleared. What Free Roam is gated on. */
    isCampaignComplete() {
      return campaignComplete(this.save);
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

    updatePrologue(dt) {
      this.baseTick(dt, this.t > 8.4);
      this.t += dt;
      const t = this.t;

      if (t < 1.0) {
        this.ui.fade.style.opacity = '1';
      } else if (t < 2.65) {
        this.ui.fade.style.opacity = '1';
        this.fire('location', () => this.showTitle('NEON CITY // EAST GRID', '23:47', 'ELEVEN MINUTES OF DARK'));
      } else if (t < 7.8) {
        this.setLayer(this.ui.titleCard, false);
        this.ui.fade.style.opacity = String(clamp(1 - (t - 2.65) / 0.9, 0.06, 1));
        this.shotKey = 'prologue-city';
        this.trackShot(55200 + (t - 2.65) * 150, 125, 155, -80, 420, 63);
        if (t > 3.1) this.fire('radio1', () => this.showRadio('CITY GRID', 'Eastern draw scheduled. Twenty-three forty-seven.', 2.2));
        if (t > 4.3) this.fire('radio2', () => this.showRadio('AURORA RELAY', 'Reactor cycle nominal. District load transferred.', 2.2));
        if (t > 5.45) this.fire('radio3', () => this.showRadio('VECTOR CONTROL', 'Vector district just went dark.', 2.1));
        if (t > 6.55) this.fire('radio4', () => this.showRadio('SYNX GRID', "Then nobody's watching. Channels are live.", 2.3));
      } else if (t < 8.65) {
        this.ui.fade.style.opacity = String(clamp((t - 7.8) / 0.45, 0, 1));
        this.setLayer(this.ui.radio, false);
      } else {
        this.fire('garage', () => {
          this.g.levelIndex = 0;
          this.g.applyLevel();
          this.setVehicle(this.g.car, 80, -1.0, 0);
          this.g.distance = 80;
          this.g.audio.playTrack('race');
        });
        this.ui.fade.style.opacity = String(clamp(1 - (t - 8.65) / 0.75, 0, 1));
        if (t < 10.7) this.carShot('prologue-a', this.g.car, 'wheel');
        else if (t < 12.45) this.carShot('prologue-b', this.g.car, 'low');
        else this.carShot('prologue-c', this.g.car, 'hero');

        if (t > 12.4 && t < 15.5) this.fire('logo', () => this.showTitle('WELCOME TO THE NIGHT', 'SYNX', 'SYNTHWAVE eXTREME RACING'));
        if (t > 15.3) this.setLayer(this.ui.titleCard, false);
        if (t > 15.75) this.fire('challenge', () => this.startPrologueDialogue());
      }
    }

    startPrologueDialogue() {
      this.mode = 'prologueDialogue';
      this.currentShot = 'player';
      this.currentSpeaker = 'UNKNOWN';
      this.dialogue.play([
        { speaker: 'UNKNOWN', expression: 'radio', text: "Open channel. Anyone still listening.", shot: 'player' },
        { speaker: 'UNKNOWN', expression: 'radio', text: "Heard you're fast.", shot: 'closeup' },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Vector Run. Midnight.', shot: 'road' },
        { speaker: 'UNKNOWN', expression: 'radio', text: 'Try keeping up.', shot: 'player' },
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
        { id: 'accelerate', label: 'W / ↑ — ACCELERATE', test: i => i.throttle > 0.25 },
        { id: 'steer', label: 'A / D — STEER', test: i => Math.abs(i.steer) > 0.25 },
        { id: 'brake', label: 'S / ↓ — BRAKE', test: i => i.brake > 0.25 },
        { id: 'boost', label: 'B — BOOST', test: i => i.boost },
        { id: 'drift', label: 'SPACE + A / D — DRIFT', test: i => i.ebrake && Math.abs(i.steer) > 0.25 },
      ];
      this.tutorialIndex = 0;
      this.tutorialHold = 0;
      this.updateTutorialCard();
      this.setLayer(this.ui.tutorial, true);
    }

    updateTutorialCard() {
      const step = this.tutorialSteps[this.tutorialIndex];
      if (!step) {
        this.ui.tutorialText.textContent = 'VECTOR RUN — KEEP MOVING';
        this.ui.tutorialFill.style.width = '100%';
        return;
      }
      this.ui.tutorialText.textContent = step.label;
      this.ui.tutorialFill.style.width = ((this.tutorialIndex / this.tutorialSteps.length) * 100) + '%';
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

      if (this.g.car.sTrack > 420) this.fire('tut1', () => this.showCompact('GRID', 'radio', 'Unregistered run detected on Vector. Nobody is coming.', 3.4));
      if (this.g.car.sTrack > 760) this.fire('tut2', () => this.showCompact('GRID', 'radio', 'Driver profile: no ID. Grid rating: unranked.', 3.0));
      if (this.g.car.sTrack > 1080) this.fire('tut3', () => this.showCompact('UNKNOWN', 'radio', "Still with me? Good. Seawall's the line.", 3.0));
      if (this.g.car.sTrack > 1360) this.fire('tut4', () => this.showCompact('GRID', 'radio', 'Three thousand on the channel. Make it eight.', 3.4));

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
      this.g.diffIndex = c.diff === undefined ? 1 : c.diff;

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
      this.showTitle('CHAPTER ' + String(id).padStart(2, '0'), c.title, cast(c.rival).name + ' // ' + c.track);
      this.g.flash = Math.max(this.g.flash || 0, .12);
      this.g.audio.playTrack('cutscene');
      this.cutTo('chapter-establish');
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
      this.dialogue.play(this.chapter.intro, {
        key: 'chapter_' + this.chapter.id + '_intro',
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
      this.ui.battleBrief.textContent = c.brief || '';
      this.ui.battlePlayer.src = portraitOf('PLAYER', 'neutral', true);
      this.ui.battleRival.src = portraitOf(c.rival, 'neutral', true);
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

    rivalBanter() {
      if (this.compactCooldown > 0 || this.compactLeft > 0) return;
      const g = this.g, c = this.chapter.id;
      const once = (key, speaker, expression, text, duration) => {
        if (this.raceFlags[key]) return false;
        this.raceFlags[key] = true;
        this.showCompact(speaker, expression, text, duration);
        this.compactCooldown = 7.0;
        return true;
      };

      const wallRemark = (escalated) => {
        if (c === 1) return { speaker: 'RYKER', expression: escalated ? 'angry' : 'amused', text: escalated ? "The wall's got a cleaner line than you." : 'You racing me or the guardrail?' };
        if (c === 2) return { speaker: 'KAEL', expression: escalated ? 'shocked' : 'amused', text: escalated ? 'Okay — even I think that is too many walls.' : 'Four impacts! The barriers are winning!' };
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

      if (c === 1) {
        if (g.rivalGap < -115 && g.progress > .08) return once('lead', 'RYKER', 'smug', 'You planning on racing tonight?');
        if (this.prevPlace === 2 && g.place === 1) return once('overtake', 'RYKER', 'amused', "Hah. Now we're racing.");
        if (Math.abs(g.rivalGap) < 18 && g.progress > .18) return once('close', 'RYKER', 'neutral', '...Okay. Okay.');
      } else if (c === 2) {
        if (g.progress > .12) return once('route', 'KAEL', 'adrenaline', 'Roads are suggestions!');
        if (g.car.offroad) return once('offroad', 'KAEL', 'amused', 'YES! Nothing out here is recording that!');
        if (this.prevPlace === 2 && g.place === 1) return once('pass', 'KAEL', 'amused', 'Where are you going? I love it.');
      } else if (c === 3) {
        if (!this.prevBoost && g.car.boosting && g.progress < .24) return once('early', 'NOVA', 'calculating', 'Too early.');
        if (this.raceFlags.early && this.prevPlace === 1 && g.place === 2) return once('why', 'NOVA', 'neutral', "That's why.");
        if (g.car.driftAmount > .72) return once('overdrift', 'NOVA', 'calculating', "You're throwing away the rear.");
        if (this.prevPlace === 2 && g.place === 1) return once('nice', 'NOVA', 'smug', '...Nice.');
      } else if (c === 4) {
        if (g.progress > .18) return once('pack', 'NOVA', 'calm', 'The pack is already breaking.');
        if (g.progress > .48 && g.place === 2) return once('ryker', 'RYKER', 'smug', 'Just like Vector. Only televised.');
        if (this.prevPlace === 2 && g.place === 1 && g.progress > .65) return once('finalpass', 'RYKER', 'amused', 'There you are.');
      } else if (c === 5) {
        if (g.progress > .20) return once('ash1', 'NOVA', 'concerned', 'No crews on this route. Nothing behind you.');
        if (g.progress > .55 && g.place === 1) return once('ash2', 'RYKER', 'angry', 'You are not taking this one.');
      } else if (c === 7) {
        if (g.progress > .10) return once('p1', 'JAVAS', 'calculating', 'It is sampling you. Every corner you take twice, it owns.');
        if (this.prevPlace === 2 && g.place === 1) return once('p2', 'RAPTOR', 'angry', 'Recalculating.');
        if (g.progress > .45) return once('p3', 'NOVA', 'calm', 'raceMode. Spend it where it thinks it knows you.');
        if (g.progress > .72 && g.place === 2) return once('p4', 'RAPTOR', 'smug', 'You always brake here.');
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
          photo: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON — DECIDED AT THE LINE\nAURORA R-IX: SECOND', shot: 'sky' }],
          close: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON — AURORA R-IX: SECOND', shot: 'sky' }],
          landslide: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON — THE PROTOTYPE NEVER HAD IT', shot: 'sky' }],
          dominant: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON — CLEAR ROAD BEHIND THE ROOKIE', shot: 'sky' }],
          clap: [{ speaker: 'GRID', expression: 'radio', text: 'NEON HORIZON — AURORA’S OWN DECK\nAND IT WAS NOT CLOSE', shot: 'sky' }],
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
      const lead = this.outcomeLeadIn(o);
      const wall = this.wallAftermathLine(o);
      if (!o.won) {
        if (wall) lead.push(wall);
        lead.push({ speaker: 'PLAYER', expression: 'focus', text: 'Again.', shot: 'player' });
        lead.push({ speaker: o.opponentName, expression: 'smug', text: 'Now you understand.', shot: 'rival' });
        return lead;
      }
      if (wall) lead.push(wall);
      return lead.concat(this.chapter.win || []);
    }

    handleFinish(callback) {
      if (this.mode !== 'race' || !this.chapter) return false;
      /* Chapter 5's 40-second finale already tells the complete result: the
         player has the pace, Ryker steals the line with HUNT//REDLINE, and the
         R-IX is awarded. That loss is the chapter ending, not a retry state. */
      if (this.chapter.canonicalLoss) {
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
        { speaker: 'AURORA', expression: 'radio', text: 'EXHIBITION RESULT CONFIRMED\nR-IX PROTOTYPE AND SEAT AWARDED — RYKER', shot: 'sky' },
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
        { speaker: 'AURORA', expression: 'radio', text: 'DRIVER LINK — HANDSHAKE ACCEPTED\nOPERATOR: RYKER', shot: 'sky' },
        { speaker: 'PLAYER', expression: 'shocked', text: 'RYKER —', shot: 'player' },
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
          if (this.g.won) this.completeChapter();
          else this.finishAsLegacyLoss();
        },
      });
    }

    updatePostDialogue(dt) {
      this.baseTick(dt, true);
      this.conversationShot(dt);
      this.dialogue.update(dt);
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
      this.finishCallback = null;
      this.startChapter(id, {});
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

    completeChapter() {
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
      this.showTitle('CHAPTER ' + String(id).padStart(2, '0') + ' COMPLETE', this.chapter.rating,
        id < LAST_CHAPTER ? 'NEXT // CHAPTER ' + String(id + 1).padStart(2, '0') + ' — ' + CHAPTERS[id + 1].title : 'WELCOME TO THE NIGHT');
      this.g.audio.playTrack('cutscene');
      this.g.audio.goBeep();
      this.cutTo('complete');
    }

    updateCompleteCard(dt) {
      this.baseTick(dt, false);
      this.t += dt;
      this.carShot('complete', this.g.car, 'hero');
      if (this.t > 3.4) this.showContinuePrompt();
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
        ? 'NEXT // CHAPTER ' + String(id + 1).padStart(2, '0') + ' — ' + CHAPTERS[id + 1].title
        : 'CAMPAIGN COMPLETE // EVERY CHAPTER REPLAYABLE';
      this.ui.continueYes.querySelector('b').textContent = id < LAST_CHAPTER ? 'YES' : 'CREDITS';
      this.ui.continueYes.querySelector('small').textContent = id < LAST_CHAPTER ? 'KEEP DRIVING' : 'SEE IT THROUGH';
      this.setLayer(this.ui.continuePrompt, true);
      global.setTimeout(() => this.ui.continueYes.focus(), 0);
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

    showFinale() {
      this.closeStoryUi();
      this.setRoot(true);
      this.mode = 'finaleCard';
      this.t = 0;
      this.g.state = 'story';
      this.setLayer(this.ui.letterbox, true);
      this.ui.fade.style.opacity = '.30';
      this.showTitle('SYNX GRID // RATING: NIGHT', 'WELCOME TO THE NIGHT', 'THE CHANNELS ARE STILL OPEN');
      this.g.audio.playTrack('cutscene');
      global.document.body.classList.add('story-cinematic');
      this.cutTo('finale');
    }

    updateFinaleCard(dt) {
      this.baseTick(dt, true);
      this.t += dt;
      this.trackShot(this.g.car.sTrack + 40 + this.t * 24, 34, 20 + this.t * 1.6, 30, 220, 56, 'finale');
      if (this.t > 6.2) this.openHub();
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
        /* Ahead of station: ease out of it. There is a dead band and a speed
           floor on this, because at the line every one of them is behind where
           its station will eventually be and braking a stationary car off the
           grid is not racing. */
        if (err < -14 && e.car.vLong > 20) {
          const over = Math.min(1, (-err - 14) / 90);
          cmd.throttle *= 1 - over * 0.88;
          cmd.brake = Math.max(cmd.brake, over * 0.30);
          cmd.boost = false;
        }
        /* ...and it does not go past the car it is racing for position with.
           This is the only hard edge, it is a lift rather than a hold, and at
           the closing speeds station keeping produces it is never reached. */
        if (front && e.car.sTrack > front.sTrack - 5) {
          cmd.throttle = 0;
          cmd.brake = Math.max(cmd.brake, 0.55);
          cmd.boost = false;
        }
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
        case 'chapterTitle': this.updateChapterTitle(dt); break;
        case 'chapterDialogue': this.updateChapterDialogue(dt); break;
        case 'battle': this.updateBattle(dt); break;
        case 'preRace': this.updatePreRace(dt); break;
        case 'retryTitle': this.updateRetryTitle(dt); break;
        case 'raceTransition': this.updateRaceTransition(dt); break;
        case 'finishRoll': this.updateFinishRoll(dt); break;
        case 'postDialogue': this.updatePostDialogue(dt); break;
        case 'completeCard': this.updateCompleteCard(dt); break;
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
