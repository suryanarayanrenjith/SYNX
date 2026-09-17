/* SYNX - the asset pack.
 *
 * Every texture, sprite and sound lives in one file, data/synx.pak, built by
 * tools/assets.py. This resolves the paths the game already uses against it.
 *
 * WHY IT IS FASTER, NOT SLOWER
 * ----------------------------
 * The obvious worry about a pack is that it trades ninety-six small parallel
 * loads for one big serial one. It does, and that is the point: a request has
 * a fixed cost - a protocol round trip, a response object, a header parse -
 * that has nothing to do with how many bytes come back, and ninety-six of
 * those cost more than one transfer of the same forty-five megabytes. Inside
 * the desktop host the bytes are already in the executable's own memory, so
 * the transfer is a copy and the per-request overhead is nearly all of it.
 *
 * WHAT IT HANDS BACK
 * ------------------
 * A blob: URL per entry, created on first ask and remembered. Everything that
 * consumes an asset - `new Image()`, `new Audio()`, `fetch` - takes a URL, so
 * nothing downstream has to know where the bytes came from. When the pack is
 * missing, `url()` returns the original relative path unchanged and the game
 * loads from loose files exactly as it used to, which is what keeps
 * development working with no build step.
 *
 * MEMORY
 * ------
 * The archive is read once into an ArrayBuffer, sliced into blobs, and the
 * ArrayBuffer is then dropped. Blob storage is managed by the browser and can
 * be paged out; a forty-five megabyte ArrayBuffer held for the life of the
 * process cannot. `release()` also revokes the URLs, and is called once the
 * loading screen is done with them.
 */
(function (global) {
  'use strict';

  const NR = global.NR = global.NR || {};

  const MAGIC = 'SYNXPAK1';

  const Pak = {
    /** name -> { o, l, t } from the archive's table of contents. */
    toc: null,
    /** name -> blob: URL, made on demand. */
    _urls: Object.create(null),
    _buf: null,
    loaded: false,
    bytes: 0,

    /**
     * Read the archive. Resolves either way: a missing pack is not an error,
     * it just means the game falls back to loose files.
     *
     * IT IS READ AS A STREAM, because it is forty-two megabytes and it is the
     * first third of the wait.
     *
     * `arrayBuffer()` hands back one promise that settles when the last byte
     * has arrived and says nothing at all before that, so the loading screen
     * had no way to know whether the archive was half in or had not started.
     * The reader gives a byte count per chunk, which is the only honest
     * progress in the whole boot - everything after it is work, and work can
     * only be estimated.
     *
     * `content-length` is the denominator when the transport sends one. The
     * desktop host serves this out of the executable's own memory over a
     * custom protocol and may not, so a missing length is not a failure: the
     * bar is driven against the size the pack is expected to be and the caller
     * is told the real byte count either way. A body that cannot be streamed
     * at all falls straight back to `arrayBuffer`, and the only thing lost is
     * the progress.
     */
    load(url, onProgress) {
      url = url || 'data/synx.pak';
      return fetch(url)
        .then(r => {
          if (!r.ok) throw new Error('no pack');
          if (!onProgress || !r.body || typeof r.body.getReader !== 'function') {
            return r.arrayBuffer();
          }
          const header = Number(r.headers.get('content-length') || 0);
          const total = header > 0 ? header : EXPECT_BYTES;
          return stream(r.body.getReader(), total, header > 0, onProgress);
        })
        .then(buf => {
          const head = new Uint8Array(buf, 0, 8);
          let magic = '';
          for (let i = 0; i < 8; i++) magic += String.fromCharCode(head[i]);
          if (magic !== MAGIC) throw new Error('data/synx.pak has the wrong magic');

          const tocLen = new DataView(buf).getUint32(8, true);
          const json = new TextDecoder().decode(new Uint8Array(buf, 12, tocLen));
          const list = JSON.parse(json);
          const base = 12 + tocLen;

          this.toc = Object.create(null);
          for (const e of list) this.toc[e.n] = { o: base + e.o, l: e.l, t: e.t };
          this._buf = buf;
          this.bytes = buf.byteLength;
          this.loaded = true;
          return true;
        })
        .catch(() => { this.loaded = false; return false; });
    },

    /** True when this path is in the archive. */
    has(rel) {
      return !!(this.toc && this.toc[normalise(rel)]);
    },

    /**
     * Resolve a relative asset path to something loadable.
     *
     * Returns a blob: URL when the pack has it, and the path unchanged when it
     * does not - so a caller never has to branch, and a half-built pack
     * degrades to loose files entry by entry rather than all at once.
     */
    url(rel) {
      const key = normalise(rel);
      if (!this.toc) return rel;
      const e = this.toc[key];
      if (!e) return rel;
      let u = this._urls[key];
      if (u) return u;
      const blob = new Blob([new Uint8Array(this._buf, e.o, e.l)], { type: e.t });
      u = URL.createObjectURL(blob);
      this._urls[key] = u;
      return u;
    },

    /**
     * Cut every remaining entry into a blob, then drop the archive buffer.
     *
     * NOT just the entries asked for so far. Most of the game's assets are
     * loaded lazily and long after boot: the mixer builds its graph on the
     * first user gesture, and a chapter's portraits arrive when that chapter
     * starts. Dropping the buffer while those were still only offsets left
     * them resolving to loose paths that the shipped build does not have -
     * a silent, much later failure, which is the worst kind.
     *
     * So everything is materialised here. The peak is brief: for a moment the
     * archive and its blobs both exist, and then the archive goes. What is
     * left is blob storage, which the browser manages and can page out, rather
     * than a forty-five megabyte ArrayBuffer that it cannot.
     */
    compact() {
      if (!this._buf) return 0;
      for (const k of Object.keys(this.toc)) {
        if (!this._urls[k]) this.url(k);
      }
      const freed = this._buf.byteLength;
      this._buf = null;
      return freed;
    },

    /**
     * The same thing, a few entries at a time.
     *
     * `compact` is one synchronous pass that copies forty-two megabytes out of
     * the archive into a hundred blobs, and it used to run at exactly the
     * worst moment: the frame the load finished, which is the frame the cold
     * open starts its closing move. The whole sequence therefore ended with a
     * stutter, on the one screen in the game whose entire job is to make a
     * wait look like a machine working.
     *
     * Nothing about the work changes - the same entries are cut and the
     * archive still goes - it is simply spread across a handful of frames,
     * with `yield` called between chunks so the needle keeps moving through
     * it. `yield` is NR.Boot.breathe; it is passed in rather than reached for
     * so this file keeps having no dependencies.
     */
    compactAsync(yieldFn) {
      if (!this._buf) return Promise.resolve(0);
      const keys = Object.keys(this.toc).filter(k => !this._urls[k]);
      const wait = yieldFn || (() => Promise.resolve());
      const CHUNK = 12;
      let at = 0;
      const step = () => {
        if (!this._buf) return Promise.resolve(0);
        const end = Math.min(keys.length, at + CHUNK);
        for (; at < end; at++) this.url(keys[at]);
        if (at < keys.length) return wait().then(step);
        const freed = this._buf.byteLength;
        this._buf = null;
        return Promise.resolve(freed);
      };
      return step();
    },

    /**
     * The raw bytes of an entry, as a view on the archive.
     *
     * For the things that are DATA rather than a resource with a URL - the
     * scene manifest and its eleven megabytes of vertices. Handing those over
     * as a blob would mean creating a copy and then fetching it back, so this
     * returns a view on bytes that are already in memory and the caller reads
     * them in place. Valid only until `compact`, which is why the scene is
     * loaded before it.
     *
     * Returns null when the entry is not in the archive, so the caller can
     * fall back to fetching a loose file.
     */
    buffer(rel) {
      const key = normalise(rel);
      if (!this.toc || !this._buf) return null;
      const e = this.toc[key];
      if (!e) return null;
      return this._buf.slice(e.o, e.o + e.l);
    },

    /** ...and as text, for the manifest. */
    text(rel) {
      const b = this.buffer(rel);
      return b === null ? null : new TextDecoder().decode(new Uint8Array(b));
    },

    /** Give back every blob URL. Only for teardown; the game never calls it. */
    release() {
      for (const k of Object.keys(this._urls)) URL.revokeObjectURL(this._urls[k]);
      this._urls = Object.create(null);
    },
  };

  /* What the pack is expected to weigh, for a transport that will not say.
     It is only ever a denominator for the bar: the bytes reported to the
     caller are always the real ones, and a pack that turns out to be bigger
     simply pins the bar at the end of the phase rather than reporting more
     than everything. Update it when the pack changes size by a lot; nothing
     breaks if it is stale, the bar is just less even. */
  const EXPECT_BYTES = 42.3 * 1048576;

  /* Pull the body down a chunk at a time, counting as it goes.
     The chunks are kept and joined once rather than copied into a
     pre-allocated buffer, because the length a server declares is the length
     of what it SENT - a transfer that was encoded on the way over does not
     match it, and writing into a buffer sized from that header is how you get
     an archive that is silently truncated. */
  function stream(reader, total, exact, onProgress) {
    const chunks = [];
    let got = 0;
    return new Promise((resolve, reject) => {
      const pump = () => reader.read().then(({ done, value }) => {
        if (done) {
          const out = new Uint8Array(got);
          let at = 0;
          for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
          chunks.length = 0;
          resolve(out.buffer);
          return;
        }
        chunks.push(value);
        got += value.length;
        try { onProgress(got, total, exact); } catch (e) { /* never let the bar break the load */ }
        pump();
      }).catch(reject);
      pump();
    });
  }

  /* The game writes paths a few different ways - with and without a leading
     slash, and with the cache-busting query the script tags use. The archive
     is keyed on the plain relative path. */
  function normalise(rel) {
    let s = String(rel);
    const q = s.indexOf('?');
    if (q >= 0) s = s.slice(0, q);
    if (s.charAt(0) === '/') s = s.slice(1);
    if (s.indexOf('./') === 0) s = s.slice(2);
    return s;
  }

  /**
   * Point the document's static images at the archive.
   *
   * They carry `data-src` rather than `src`, because a real `src` is fetched
   * while the document is still being parsed - long before the pack has
   * loaded - and the shipped build has no loose file for it to find. Deferring
   * the attribute is what turns three guaranteed 404s into three cache hits.
   */
  Pak.resolveDom = function resolveDom(root) {
    const doc = root || global.document;
    for (const el of doc.querySelectorAll('img[data-src]')) {
      const raw = el.getAttribute('data-src');
      if (!raw) continue;
      el.setAttribute('src', Pak.url(raw));
      el.removeAttribute('data-src');
    }
    // ...and anything that was given a loose path some other way
    for (const el of doc.querySelectorAll('img[src]')) {
      const raw = el.getAttribute('src');
      if (!raw || raw.indexOf('blob:') === 0 || raw.indexOf('data:') === 0) continue;
      const u = Pak.url(raw);
      if (u !== raw) el.setAttribute('src', u);
    }
  };

  NR.Pak = Pak;
})(window);
