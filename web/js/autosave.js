/* SYNX Synthwave eXtreme racing
 * Autosave: the run you are in the middle of, kept without being asked.
 *
 * WHAT WAS ALREADY SAVED, AND WHAT WAS NOT
 * ----------------------------------------
 * The campaign table, the settings and the records are all written the moment
 * they change - `NR.Save` coalesces those into one file write and the host
 * renames it into place atomically. None of that was the problem.
 *
 * What was not saved is the thing the player is actually doing. A Free Roam
 * tour is a hundred and twenty-seven kilometres; a chapter is twenty minutes
 * with checkpoints in it. Quit, lose power, or alt-F4 out of either and the
 * whole session was gone, because nothing wrote anything until it ended.
 *
 * WHAT THIS SAVES
 * ---------------
 * A snapshot small enough to write every few seconds and honest about what it
 * can restore:
 *
 *   A TOUR resumes exactly. Region, arc length, clock, score, the state of
 *   raceMode's cooldown - everything a tour is - so "RESUME TOUR" puts the car
 *   back on the road it was on.
 *
 *   A CHAPTER resumes at its last CHECKPOINT, which is the unit chapters are
 *   already built in: both directors implement a rewind to one, so this stores
 *   which one and lets the chapter's own code do the restoring. It does not
 *   pretend to serialise a set piece halfway through a falling slab.
 *
 * WHEN IT WRITES
 * --------------
 * On an interval while the wheels are turning, and immediately on the moments
 * that are worth not losing: a checkpoint, a region handover, a chapter
 * cleared, the pause menu opening, the window losing focus, and quitting.
 * Never mid-cutscene and never while a modal is up, because neither is a
 * moment a player would choose to be returned to.
 *
 * WHY IT IS NOT ONE MORE `Save.set` CALL SITE
 * -------------------------------------------
 * Because "every few seconds" and "the file is written atomically" are in
 * tension: writing a 40 KB document sixty times a minute is a lot of disk for
 * a racing game. The snapshot is compared against the last one written and
 * skipped when nothing meaningful moved, and `Save` coalesces whatever is
 * left, so a long run costs one write per interval and a parked car costs
 * none.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};
  const KEY = 'synx.autosave.v1';

  /* How often, while racing. Twelve seconds is about four hundred metres at
     touring speed - close enough that losing it is annoying rather than
     painful, far enough apart that the disk is not the bottleneck. */
  const INTERVAL = 12;
  const VERSION = 1;

  class Autosave {
    constructor(game) {
      this.g = game;
      this.timer = 0;
      this.lastSignature = '';
      this.lastAt = 0;
      this.lastKind = '';
      this.notify = 0;
    }

    /** The saved run, or null. Read by the menus. */
    static read() {
      try {
        const d = NR.Save && NR.Save.getJSON(KEY, null);
        if (!d || d.v !== VERSION) return null;
        return d;
      } catch (e) { return null; }
    }

    static clear() {
      try { if (NR.Save) NR.Save.remove(KEY); } catch (e) { /* nothing to do */ }
    }

    /* What the run is, right now.
     *
     * Returns null when there is nothing worth keeping - a menu, a cutscene, a
     * finished race, or a run that has barely started. "Barely started" is
     * deliberate: an autosave that puts the player forty metres past the line
     * they just crossed is worse than none, because it makes RESUME look
     * broken. */
    snapshot() {
      const g = this.g;
      if (!g || !g.car || !g.track) return null;
      if (g.state !== 'racing') return null;
      if (g.story && g.story.isExclusive && g.story.isExclusive()) return null;
      if (g.raceOver) return null;
      const travelled = (g.car.sTrack || 0) - (g.startAt || 0);
      if (travelled < 220) return null;

      const s = {
        v: VERSION,
        at: Date.now(),
        freeRoam: !!g.freeRoam,
        region: g.freeRoam ? (g.freeRoamRegion | 0) : (g.levelIndex | 0),
        level: g.levelIndex | 0,
        diff: g.diffIndex | 0,
        solo: !!g.soloRun,
        s: Math.round(g.car.sTrack || 0),
        lateral: +(g.car.lateral || 0).toFixed(2),
        speed: Math.round(g.car.speed || 0),
        boost: +(g.car.boost || 0).toFixed(3),
        raceTime: +(g.raceTime || 0).toFixed(2),
        score: g.score | 0,
        topSpeed: Math.round(g.topSpeedSeen || 0),
        chapter: 0,
        checkpoint: 0,
        name: (g.level && g.level.name) || 'SYNX',
      };
      /* A chapter resumes at its checkpoint, not at its metre. Both directors
         that own one publish the index they are on. */
      const st = g.story;
      if (!g.freeRoam && st && st.chapter && st.mode === 'race') {
        s.chapter = st.chapter.id | 0;
        const d7 = g.__level7Director, d6 = g.__level6Director;
        if (d7 && d7.isChapter && d7.isChapter()) s.checkpoint = d7.checkpointIndex | 0;
        else if (d6 && d6.isChapter && d6.isChapter() && d6.checkpoint) s.checkpoint = 1;
      }
      /* raceMode's cooldown is part of where the run is: resuming with it
         charged when it was spent forty metres ago is a free ability. */
      const m = g.freeRoamMode;
      if (m) { s.rmCool = Math.round(m.cooldown || 0); }
      return s;
    }

    /* Everything that decides whether this is a DIFFERENT moment from the last
       one written. Deliberately coarse: a car sitting still against a barrier
       must not write a file every twelve seconds for as long as it is left
       there. */
    signature(s) {
      return s.freeRoam + '|' + s.region + '|' + s.chapter + '|' + s.checkpoint +
        '|' + Math.round(s.s / 40) + '|' + Math.round(s.raceTime / 6) + '|' + s.score;
    }

    /** Write, if there is anything to write. `why` is for the toast. */
    save(why) {
      const s = this.snapshot();
      if (!s) return false;
      const sig = this.signature(s);
      if (sig === this.lastSignature) return false;
      this.lastSignature = sig;
      this.lastAt = s.at;
      this.lastKind = why || 'auto';
      try { NR.Save.setJSON(KEY, s); } catch (e) { return false; }
      /* Quietly. An autosave that announces itself in the middle of the frame
         every twelve seconds is an autosave the player learns to resent, so
         the interval one is a small mark on the instrument (see Hud.drawHud)
         and only a deliberate one - a checkpoint, a handover - says so. */
      if (why && why !== 'auto' && this.g.hud && this.g.hud.toast) {
        this.g.hud.toast('PROGRESS SAVED', '#5affc0');
      }
      this.notify = 1.6;
      return true;
    }

    /** ...and get it onto the disk now, for quitting. */
    flush(why) {
      this.save(why || 'flush');
      try { if (NR.Save && NR.Save.flush) NR.Save.flush(); } catch (e) { /* closing */ }
    }

    update(dt) {
      this.notify = Math.max(0, this.notify - dt);
      if (!this.g.simulating) return;
      this.timer += dt;
      if (this.timer < INTERVAL) return;
      this.timer = 0;
      this.save('auto');
    }

    /** A moment worth not losing. Resets the interval so the two do not stack. */
    mark(why) {
      this.timer = 0;
      this.save(why);
    }
  }

  Autosave.KEY = KEY;
  Autosave.INTERVAL = INTERVAL;
  NR.Autosave = Autosave;
})(window);
