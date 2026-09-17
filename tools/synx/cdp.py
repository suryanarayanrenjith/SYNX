"""Talking to a Chromium, and serving web/ to it.

WHY A WEBSOCKET BY HAND
-----------------------
The DevTools protocol runs over a WebSocket, and Python has no client for one
in its standard library. Adding a dependency for it would mean the smoke test
needs a pip install before it can prove the game starts, which is exactly
backwards: this is the tool people reach for when something is already wrong.

What is actually needed is small. The handshake is an HTTP upgrade with a
base64 nonce; the framing is a two-byte header, an optional extended length, an
optional mask, and the payload. Every frame here is text and every frame the
browser sends is unmasked, so the awkward half of RFC 6455 is not reachable.
About a hundred lines, no dependency, and it does not have to be general.

WHAT IT DELIBERATELY DOES NOT DO. No permessage-deflate - the CDP traffic is
JSON over loopback and compressing it would only add a zlib window to keep. No
continuation frames on send: nothing here writes a message big enough to want
one. Received continuations ARE handled, because a screenshot comes back as one
very large frame and some builds split it.
"""
import base64
import http.server
import json
import mimetypes
import os
import pathlib
import shutil
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request

from . import paths

BROWSERS = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.json': 'application/json',
    '.bin': 'application/octet-stream', '.pak': 'application/octet-stream',
    '.ttf': 'font/ttf',
}


def find_browser():
    for b in BROWSERS:
        if pathlib.Path(b).exists():
            return b
    for name in ('msedge', 'google-chrome', 'chromium', 'chrome'):
        found = shutil.which(name)
        if found:
            return found
    return None


# ------------------------------------------------------------- websocket ---

class WebSocket:
    """One text-frame client, enough for the DevTools protocol."""

    def __init__(self, url, timeout=30):
        rest = url.split('://', 1)[1]
        hostport, _, path_ = rest.partition('/')
        host, _, port = hostport.partition(':')
        self.sock = socket.create_connection((host, int(port or 80)), timeout=timeout)
        self.sock.settimeout(timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        req = ('GET /%s HTTP/1.1\r\n'
               'Host: %s\r\n'
               'Upgrade: websocket\r\n'
               'Connection: Upgrade\r\n'
               'Sec-WebSocket-Key: %s\r\n'
               'Sec-WebSocket-Version: 13\r\n\r\n' % (path_, hostport, key))
        self.sock.sendall(req.encode())
        self._buf = b''
        head = self._read_until(b'\r\n\r\n')
        if b'101' not in head.split(b'\r\n')[0]:
            raise RuntimeError('devtools refused the upgrade: '
                               + head.split(b'\r\n')[0].decode('latin1'))

    def _read_until(self, marker):
        while marker not in self._buf:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError('the devtools socket closed')
            self._buf += chunk
        head, _, rest = self._buf.partition(marker)
        self._buf = rest
        return head + marker

    def _recv_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(max(65536, n - len(self._buf)))
            if not chunk:
                raise ConnectionError('the devtools socket closed')
            self._buf += chunk
        out, self._buf = self._buf[:n], self._buf[n:]
        return out

    def send(self, text):
        payload = text.encode('utf-8')
        # A client MUST mask. The mask is four random bytes XORed over the
        # payload; it exists to defeat proxy cache poisoning and is pure
        # ceremony over loopback, but a browser will close the socket without
        # it.
        mask = os.urandom(4)
        n = len(payload)
        head = bytearray([0x81])
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack('>H', n)
        else:
            head.append(0x80 | 127)
            head += struct.pack('>Q', n)
        head += mask
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(payload))
        self.sock.sendall(bytes(head) + masked)

    def recv(self):
        """One complete message, reassembling continuations."""
        chunks = []
        while True:
            b0, b1 = self._recv_exact(2)
            fin = b0 & 0x80
            opcode = b0 & 0x0f
            n = b1 & 0x7f
            if n == 126:
                n = struct.unpack('>H', self._recv_exact(2))[0]
            elif n == 127:
                n = struct.unpack('>Q', self._recv_exact(8))[0]
            if b1 & 0x80:                       # a server frame should not be masked
                key = self._recv_exact(4)
                data = bytes(c ^ key[i & 3] for i, c in enumerate(self._recv_exact(n)))
            else:
                data = self._recv_exact(n)
            if opcode == 0x8:
                raise ConnectionError('the devtools socket closed')
            if opcode == 0x9:                   # ping: answer it and carry on
                self.sock.sendall(b'\x8a' + bytes([0x80 | len(data)]) + os.urandom(4)
                                  + bytes(b ^ 0 for b in data))
                continue
            if opcode == 0xa:
                continue
            chunks.append(data)
            if fin:
                return b''.join(chunks)

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Session:
    """A CDP session: send a method, get its result."""

    def __init__(self, url, timeout=120):
        self.ws = WebSocket(url, timeout=timeout)
        self.next_id = 0
        self.events = []

    def send(self, method, params=None, timeout=None):
        self.next_id += 1
        want = self.next_id
        if timeout is not None:
            self.ws.sock.settimeout(timeout)
        self.ws.send(json.dumps({'id': want, 'method': method, 'params': params or {}}))
        while True:
            msg = json.loads(self.ws.recv().decode('utf-8'))
            if msg.get('id') != want:
                # an event, or a reply to something abandoned; keep the events
                if 'method' in msg:
                    self.events.append(msg)
                continue
            if 'error' in msg:
                raise RuntimeError('%s: %s' % (method, msg['error'].get('message')))
            return msg.get('result', {})

    def close(self):
        self.ws.close()


# ------------------------------------------------------------ the server ---

class Server:
    """web/ over HTTP, with scripts injected into every document.

    The injection is why this is not http.server.SimpleHTTPRequestHandler with
    a directory argument: the collector has to be the FIRST script on the page,
    before anything it is meant to catch can run.
    """

    def __init__(self, root, inject=None):
        self.root = pathlib.Path(root).resolve()
        self.inject = inject or (lambda name, html: html)
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *a):
                pass                                    # the harness has its own log

            def handle_one_request(self):
                # A headless browser drops keep-alive sockets whenever it feels
                # like it, and the default handler prints a full traceback for
                # each one. Those are not failures - they are a client hanging
                # up - and twenty of them buried the actual report.
                try:
                    super().handle_one_request()
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    self.close_connection = True

            def handle_error(self, *a):
                pass

            def do_GET(self):                           # noqa: N802
                from urllib.parse import unquote
                rel = unquote(self.path.split('?')[0]).lstrip('/')
                f = (outer.root / (rel or 'index.html')).resolve()
                if not str(f).startswith(str(outer.root)) or not f.is_file():
                    self.send_response(404)
                    self.send_header('content-length', '9')
                    self.end_headers()
                    self.wfile.write(b'not found')
                    return
                ext = f.suffix.lower()
                if ext == '.html':
                    body = outer.inject(f.name, f.read_text(encoding='utf-8')).encode('utf-8')
                else:
                    body = f.read_bytes()
                self.send_response(200)
                self.send_header('content-type',
                                 MIME.get(ext) or mimetypes.guess_type(f.name)[0]
                                 or 'application/octet-stream')
                self.send_header('content-length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()


# ----------------------------------------------------------- the browser ---

def sweep_profiles(prefix='synx-smoke-', older_than=3600):
    """Clear up after whichever earlier runs could not clear up after themselves.

    Every run makes a fresh browser profile in the system temp directory. One
    is sixty megabytes; a session that shoots a few dozen screenshots is a
    couple of gigabytes of litter, and the first anybody knows about it is a
    link step failing on a full disk - which is a long way from a test harness
    and is not where anyone would look.
    """
    tmp = pathlib.Path(tempfile.gettempdir())
    try:
        for d in tmp.iterdir():
            if not d.name.startswith(prefix) or not d.is_dir():
                continue
            try:
                if time.time() - d.stat().st_mtime < older_than:
                    continue                            # today's; leave it alone
                shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass                                    # in use, or gone already
    except OSError:
        pass


def launch(url, extra=(), prefix='synx-smoke-'):
    """A headless Chromium on a software WebGL2, and its profile directory."""
    browser = find_browser()
    if not browser:
        raise SystemExit('no Chromium-based browser found; cannot run this')
    sweep_profiles(prefix)
    profile = tempfile.mkdtemp(prefix=prefix)
    args = [browser, '--headless=new', '--remote-debugging-port=0',
            '--user-data-dir=' + profile,
            '--no-first-run', '--no-default-browser-check', '--disable-extensions',
            '--mute-audio', '--autoplay-policy=no-user-gesture-required',
            # software WebGL2: compiling the shaders somewhere is the whole point
            '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
            '--window-size=1280,720'] + list(extra) + [url]
    child = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    return child, profile, browser


def devtools_port(profile, tries=240):
    """The port the browser chose, out of the file it writes when it is up."""
    f = pathlib.Path(profile) / 'DevToolsActivePort'
    for _ in range(tries):
        try:
            # the browser writes this while we are watching for it, so a read
            # can land mid-write; that is not a failure
            if f.exists():
                line = f.read_text(encoding='utf-8').split('\n')[0].strip()
                if line:
                    return int(line)
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    raise RuntimeError('the browser never opened a debugging port')


def page_target(port, tries=80, want=None):
    for _ in range(tries):
        try:
            with urllib.request.urlopen('http://127.0.0.1:%d/json/list' % port, timeout=5) as r:
                targets = json.loads(r.read().decode('utf-8'))
            for t in targets:
                if t.get('type') != 'page' or not t.get('webSocketDebuggerUrl'):
                    continue
                if want and want not in (t.get('url') or ''):
                    continue
                return t
        except Exception:                               # noqa: BLE001 - not up yet
            pass
        time.sleep(0.25)
    raise RuntimeError('no page target')


def attach(url, extra=(), prefix='synx-smoke-', want=None):
    """Launch, find the page, and open a session on it."""
    child, profile, browser = launch(url, extra, prefix)
    port = devtools_port(profile)
    target = page_target(port, want=want)
    return child, profile, browser, Session(target['webSocketDebuggerUrl']), port


def shutdown(child, profile, session=None):
    if session:
        session.close()
    try:
        child.kill()
    except OSError:
        pass
    # Best effort, and quiet: the browser has just been signalled and may still
    # have a file or two open, and a screenshot that was taken is worth more
    # than a temp directory that was swept.
    shutil.rmtree(profile, ignore_errors=True)


# -------------------------------------------------------------- profiling ---

def profile_report(prof, limit=26):
    """Where the time went, by SELF time.

    A V8 profile is a call tree of nodes plus a flat list of sample ids, one
    per tick. Self time is therefore just how many ticks named each node, times
    the interval between them - no tree walking required, and it is the only
    number that says which function to go and change. Total time up a call tree
    tells you the frame is expensive, which you knew.
    """
    nodes = {n['id']: n for n in prof.get('nodes', [])}
    hits = {}
    samples = prof.get('samples') or []
    deltas = prof.get('timeDeltas') or []
    for i, sid in enumerate(samples):
        us = max(0, deltas[i]) if i < len(deltas) else 0
        hits[sid] = hits.get(sid, 0) + us
    rows, total = [], 0
    for sid, us in hits.items():
        n = nodes.get(sid)
        if not n:
            continue
        f = n.get('callFrame') or {}
        url = (f.get('url') or '').split('/')[-1] or '-'
        rows.append((us, '%s  %s:%d' % (f.get('functionName') or '(anonymous)', url,
                                        int(f.get('lineNumber') or 0) + 1)))
        total += us
    rows.sort(reverse=True)
    print('\n=== PROFILE ===  %d ms of samples' % (total / 1000))
    for us, label in rows[:limit]:
        print('  %8.1f ms  %5.1f%%  %s' % (us / 1000, us * 100.0 / max(1, total), label))
