/* SYNX — the asset pack.
 *
 * Every texture, sprite and sound lives in one file, data/synx.pak, built by
 * tools/pack.js. This resolves the paths the game already uses against it.
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
     */
    load(url) {
      url = url || 'data/synx.pak';
      return fetch(url)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('no pack'))))
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
