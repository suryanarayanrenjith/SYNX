"""PNG, without a dependency on a PNG library.

A reader, and a writer that searches the filter per row. Three tools need it -
the sheet shrinker, the atlas trimmer and the texture generator - and a second
copy of a codec is a second place for a bug in one of them.

WHAT IT DELIBERATELY DOES NOT DO. No palette reduction, no bit-depth
reduction, no dropping an alpha channel that happens to be opaque, no
quantisation. All of those change pixels or change what a shader can sample.

WHY THIS ONE WANTS NUMPY
------------------------
The largest sheet in the tree unpacks to twelve megabytes of samples, and the
encoder deflates SIX whole-image candidates of it to pick the smallest. That is
seventy-five million byte operations, which is nothing in C and several minutes
in a Python loop. Filtering for OUTPUT has no serial dependency - every term
comes from the unfiltered image - so all six candidates vectorise exactly.

Only the tools that touch pixels import this. `assets.py pack`, every check,
the smoke harness and the build itself run on a stock interpreter.
"""
import zlib

try:
    import numpy as np
except ImportError:                                   # pragma: no cover
    np = None

SIG = b'\x89PNG\r\n\x1a\n'
CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
COLOUR_TYPE = {1: 0, 3: 2, 4: 6}

# Chunks that can change how a pixel decodes. Everything else an exporter
# leaves behind - timestamps, editor comments, physical dimensions, embedded
# profiles - is bytes shipped to no purpose.
KEEP = ('IHDR', 'PLTE', 'tRNS')


def _need_numpy():
    if np is None:
        raise SystemExit(
            'This needs numpy.\n'
            '  python -m venv .venv && .venv/Scripts/pip install numpy\n'
            'Only the tools that touch pixels or samples do; the build and the'
            ' checks run on a stock interpreter.')


class Image:
    """Raw samples, plus everything needed to write them back."""

    def __init__(self, w, h, ch, pixels, chunks=None, ctype=None):
        self.w = w
        self.h = h
        self.ch = ch
        self.stride = w * ch
        self.pixels = pixels            # (h, w, ch) uint8
        self.chunks = chunks or []
        self.ctype = COLOUR_TYPE[ch] if ctype is None else ctype

    def copy(self):
        return Image(self.w, self.h, self.ch, self.pixels.copy(),
                     list(self.chunks), self.ctype)


def chunks(buf):
    """Split a PNG into its chunks."""
    if len(buf) < 8 or buf[:8] != SIG:
        raise ValueError('not a PNG')
    out = []
    p = 8
    while p + 8 <= len(buf):
        ln = int.from_bytes(buf[p:p + 4], 'big')
        kind = buf[p + 4:p + 8].decode('latin1')
        out.append((kind, bytes(buf[p + 8:p + 8 + ln])))
        p += 12 + ln
        if kind == 'IEND':
            break
    return out


def decode(buf):
    _need_numpy()
    cs = chunks(buf)
    ihdr = next((c for c in cs if c[0] == 'IHDR'), None)
    if ihdr is None:
        raise ValueError('no IHDR')
    d = ihdr[1]
    w = int.from_bytes(d[0:4], 'big')
    h = int.from_bytes(d[4:8], 'big')
    depth, ctype, interlace = d[8], d[9], d[12]
    if interlace:
        raise ValueError('interlaced')
    if depth != 8:
        raise ValueError('bit depth %d' % depth)
    ch = CHANNELS.get(ctype)
    if ch is None:
        raise ValueError('colour type %d' % ctype)

    raw = zlib.decompress(b''.join(c[1] for c in cs if c[0] == 'IDAT'))
    stride = w * ch
    if len(raw) < h * (stride + 1):
        raise ValueError('short IDAT')

    # One buffer for the whole picture, with a numpy view over the same bytes.
    # The two fast filters are array expressions on the view; the two serial
    # ones are a Python loop over the bytearray. Both write the same memory, so
    # nothing is copied between them.
    buf = bytearray(h * stride)
    view = np.ndarray((h, stride), dtype=np.uint8, buffer=buf)
    for y in range(h):
        f = raw[y * (stride + 1)]
        q = y * (stride + 1) + 1
        row = memoryview(raw)[q:q + stride]
        off = y * stride
        buf[off:off + stride] = row
        if f == 0:
            continue
        if f == 1:
            # Sub is a running total along each channel lane, which is cumsum
            lane = view[y].reshape(w, ch)
            lane[:] = np.cumsum(lane, axis=0, dtype=np.uint32).astype(np.uint8)
        elif f == 2:
            if y:
                view[y] += view[y - 1]
        elif f == 3 or f == 4:
            _serial(f, buf, off, stride, ch, y)
        else:
            raise ValueError('filter %d' % f)
    return Image(w, h, ch, view.reshape(h, w, ch), cs, ctype)


def _serial(f, buf, off, stride, ch, y):
    """Average and Paeth, which cannot vectorise and so are written to be read
    by the interpreter as cheaply as possible.

    Each sample's predictor needs the sample RECONSTRUCTED one pixel to its
    left, and the row above needs the row above that, so a Paeth image is
    serial in both axes - there is no array expression for it. What is left is
    to keep the loop body small: the three absolute differences are rewritten
    without the intermediate `p`, because |p-a| is |b-c|, |p-b| is |a-c| and
    |p-c| is |a+b-2c|, and the loop is over a bytearray rather than a numpy row
    so that each read is an interpreter-level integer and not a 0-d array.
    """
    up = off - stride
    if f == 3:
        if y:
            for x in range(ch):
                buf[off + x] = (buf[off + x] + (buf[up + x] >> 1)) & 255
            for x in range(ch, stride):
                buf[off + x] = (buf[off + x]
                                + ((buf[off + x - ch] + buf[up + x]) >> 1)) & 255
        else:
            for x in range(ch, stride):
                buf[off + x] = (buf[off + x] + (buf[off + x - ch] >> 1)) & 255
        return
    if not y:
        # with no row above, b and c are zero and Paeth always predicts `a`
        for x in range(ch, stride):
            buf[off + x] = (buf[off + x] + buf[off + x - ch]) & 255
        return
    for x in range(ch):
        buf[off + x] = (buf[off + x] + buf[up + x]) & 255
    for x in range(ch, stride):
        a = buf[off + x - ch]
        b = buf[up + x]
        c = buf[up + x - ch]
        pa = b - c
        if pa < 0:
            pa = -pa
        pb = a - c
        if pb < 0:
            pb = -pb
        pc = a + b - c - c
        if pc < 0:
            pc = -pc
        if pa <= pb and pa <= pc:
            pred = a
        elif pb <= pc:
            pred = b
        else:
            pred = c
        buf[off + x] = (buf[off + x] + pred) & 255


# ------------------------------------------------------------- encoding ---

def _filtered(im, f):
    """The whole image under one filter, as the bytes that follow the tag.

    Every term is a sample of the ORIGINAL image, so there is no recurrence
    here and the entire thing is four array expressions.
    """
    px = im.pixels.astype(np.int16)
    a = np.zeros_like(px)
    a[:, 1:] = px[:, :-1]                     # the pixel to the left
    b = np.zeros_like(px)
    b[1:] = px[:-1]                           # the pixel above
    c = np.zeros_like(px)
    c[1:, 1:] = px[:-1, :-1]                  # above-left
    if f == 0:
        sub = np.zeros_like(px)
    elif f == 1:
        sub = a
    elif f == 2:
        sub = b
    elif f == 3:
        sub = (a + b) >> 1
    else:
        p = a + b - c
        pa, pb, pc = np.abs(p - a), np.abs(p - b), np.abs(p - c)
        sub = np.where(np.logical_and(pa <= pb, pa <= pc), a,
                       np.where(pb <= pc, b, c))
    return ((px - sub) & 255).astype(np.uint8)


def _body(im, per_row):
    """Interleave the filter tag with each row's filtered bytes."""
    h, stride = im.h, im.stride
    out = np.empty((h, stride + 1), dtype=np.uint8)
    out[:, 0] = per_row[0]
    for f in range(5):
        rows = np.nonzero(per_row[0] == f)[0]
        if len(rows):
            out[rows, 1:] = per_row[1][f][rows].reshape(len(rows), stride)
    return out.tobytes()


def encode(im):
    """The smallest of six candidate filterings, deflated.

    Each of the five filters applied uniformly, plus the classic per-row
    heuristic. Uniform candidates matter: on a sheet that is mostly one colour,
    "none" or "up" everywhere compresses better than a per-row mixture, because
    a constant filter byte is itself part of the stream being deflated.
    """
    _need_numpy()
    planes = {f: _filtered(im, f) for f in range(5)}

    # the heuristic: the filter whose output has the smallest absolute sum,
    # treating bytes as signed. Cheap, and right most of the time.
    signed = np.stack([np.minimum(planes[f], 256 - planes[f].astype(np.int16))
                       .reshape(im.h, -1).sum(axis=1) for f in range(5)])
    signed[2, 0] = np.iinfo(np.int64).max if im.h else 0   # no row above row 0
    heuristic = signed.argmin(axis=0).astype(np.uint8)

    uniform = [np.zeros(im.h, np.uint8) + f for f in range(5)]
    uniform[2][0] = 0
    best = None
    for per_row in [heuristic] + uniform:
        # the same deflate settings the JavaScript encoder used, so a
        # re-encode of an untouched sheet is byte for byte what it was
        co = zlib.compressobj(9, zlib.DEFLATED, 15, 9)
        z = co.compress(_body(im, (per_row, planes))) + co.flush()
        if best is None or len(z) < len(best):
            best = z

    parts = [SIG]

    def put(kind, data):
        head = kind.encode('latin1')
        parts.append(len(data).to_bytes(4, 'big'))
        parts.append(head)
        parts.append(data)
        parts.append((zlib.crc32(head + data) & 0xffffffff).to_bytes(4, 'big'))

    wrote_ihdr = False
    for kind, data in im.chunks:
        if kind in KEEP:
            put(kind, data)
            wrote_ihdr = wrote_ihdr or kind == 'IHDR'
    if not wrote_ihdr:
        put('IHDR', _ihdr(im))
    put('IDAT', best)
    put('IEND', b'')
    return b''.join(parts)


def _ihdr(im):
    return (im.w.to_bytes(4, 'big') + im.h.to_bytes(4, 'big')
            + bytes([8, im.ctype, 0, 0, 0]))


def from_raw(w, h, ch, pixels):
    """An image from samples, for a caller with no source PNG to start from."""
    _need_numpy()
    if ch not in COLOUR_TYPE:
        raise ValueError('unsupported channel count %d' % ch)
    a = np.asarray(pixels, dtype=np.uint8).reshape(h, w, ch)
    return Image(w, h, ch, a)
