#!/usr/bin/env python3
"""Everything that needs a browser or the desktop host.

    python tools/smoke.py                       the default 16-second run
    python tools/smoke.py --route 6 --seconds 24
    python tools/smoke.py --shot out.png        ...and save what it looked like
    python tools/smoke.py --page launcher.html  the other document
    python tools/smoke.py --probe layout        one of the named probes
    python tools/smoke.py launcher              PLAY, in the real host
    python tools/smoke.py display               which screen it opened on
    python tools/smoke.py profile --route 0     where a frame's CPU time goes

WHY
---
Everything in web/ is renderer code: a shader that will not compile, a uniform
that is not there, a texture the pack does not carry, a class that throws on
construction. None of it is reachable from `cargo test`, none of it shows up in
a parse check, and all of it fails at exactly the moment the player opens the
game. The only honest way to check it is to run it.

So this serves web/ over HTTP, opens it in headless Edge or Chrome with a
software WebGL2, drives it through the states a player would, and reads back
everything the page said: console errors, uncaught exceptions, failed requests,
the load timings, the draw-call census, and the gain the engine loop was
actually sitting at while the game was paused.

It is a SMOKE test. It proves the game starts, builds its world, compiles its
shaders, draws frames and survives being driven into a wall. It does not prove
the picture is right.

WHERE THE PAGE SCRIPTS LIVE
---------------------------
tools/probes/page/. They are injected into the document and run in the browser,
so they are JavaScript and always will be - and they are files rather than
strings inside this one, which means an editor highlights them, the shader
check can read them, and a syntax error in them is reported at a line number
that exists.

THE THREE THAT NEED THE REAL HOST
---------------------------------
`launcher`, `display` and `profile` drive target/release/synx rather than a
browser, because what they are about only exists there: the command that turns
the launcher's answers into a game window, which display that window lands on,
and what a frame costs on a real GPU. They are skipped, not failed, where they
cannot run - the debugging hook they attach to is a WebView2 mechanism.
"""
import argparse
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from synx import cdp, paths                                      # noqa: E402
from synx.report import C, heading                               # noqa: E402

PAGE_DIR = paths.PROBES / 'page'
# Where the host keeps the save and therefore any report. Mirrors
# `dirs_app_data` in main.rs; these checks are the one thing outside the host
# that needs to know.
APPDATA = (pathlib.Path(os.environ['APPDATA']) / 'com.synx.racing'
           if os.environ.get('APPDATA') else None)
HOST_PORT = 9333


def page_script(name):
    return (PAGE_DIR / name).read_text(encoding='utf-8')


# =============================================================== the smoke ===

def run_smoke(a):
    collector = page_script('collector.js')
    reporter = page_script('reporter.js')
    exerciser = page_script('exerciser.js')
    driver = page_script('driver.js')

    # The driver is one template with seventeen holes in it. Substituted by
    # name rather than by position, so adding a knob cannot silently shift
    # every argument after it - which is the failure mode the JavaScript this
    # replaces was one comma away from at all times.
    holes = {
        'route': a.route, 'hold': a.hold, 'freeroam': a.freeroam, 'preset': a.preset,
        'nocull': str(bool(a.nocull)).lower(), 'probe': a.probe, 'at': a.at,
        'look': a.look, 'nobake': str(bool(a.nobake)).lower(),
        'scale': a.scale, 'upscaler': a.upscaler, 'camera': a.cam, 'reel': a.reel,
        'park': a.park, 'steer': a.steer, 'press': a.press,
        'sets': json.dumps(a.sets),
    }
    missing = set(re.findall(r'\$\{(\w+)\}', driver)) - set(holes)
    if missing:
        raise SystemExit('tools/probes/page/driver.js wants %s, which nothing supplies'
                         % ', '.join(sorted(missing)))
    driver = re.sub(r'\$\{(\w+)\}', lambda m: str(holes[m.group(1)]), driver)

    def inject(name, html):
        # The collector goes on EVERY page - it is what reports console errors
        # and failed requests, and those matter just as much on the launcher.
        # The DRIVER does not: it closes over an NR.Game, so it goes only where
        # its anchor exists, and a page without one gets the small reporter.
        anchor = '<script src="js/pak.js'
        preamble = ('<script>window.__SMOKE_SERVER=%s;</script><script>%s</script>'
                    % (json.dumps(a.server), collector))
        if anchor in html:
            html = html.replace(anchor, preamble + '\n' + anchor)
            html = html.replace('</body>', '<script>%s</script>\n</body>' % driver)
        else:
            html = html.replace('</head>', preamble + '<script>%s</script>%s\n</head>'
                                % (reporter,
                                   ('<script>%s</script>' % exerciser) if a.exercise else ''))
        return html

    with cdp.Server(paths.WEB, inject) as server:
        # --probe clear needs the clearance audit switched on before the world
        # is built, and the only thing that runs that early is the collector -
        # so it is asked for in the address rather than set from a frame hook.
        url = ('http://127.0.0.1:%d/%s%s'
               % (server.port, a.page, '?clear=1' if a.probe == 'clear' else ''))
        print('serving web/ on ' + url)
        child = profile = session = None
        try:
            child, profile, browser, session, _ = cdp.attach(url)
            print('browser:      ' + browser)
            session.send('Runtime.enable')
            session.send('Page.enable')
            if a.profile:
                session.send('Profiler.enable')
                # a hundred microseconds: fine enough to separate two functions
                # in a draw loop, coarse enough not to be measuring the profiler
                session.send('Profiler.setSamplingInterval', {'interval': 100})
                session.send('Profiler.start')

            print('running for %gs ...' % a.seconds)
            time.sleep(a.seconds)

            cpu = None
            if a.profile:
                try:
                    cpu = session.send('Profiler.stop', timeout=240).get('profile')
                except RuntimeError as e:
                    print('profiler: %s' % e)

            out = session.send('Runtime.evaluate', {
                # AWAITED, because the exerciser has to be able to wait. Saving
                # on the launcher is a chain of promises - writes are serialised
                # so two clicks cannot interleave and lose one - so a checker
                # that snapshots storage the instant after a click reads the
                # value from BEFORE the write and calls a good row inert.
                'expression': 'Promise.resolve(window.__smokeReport ? window.__smokeReport()'
                              ' : {noreport:1}).then(function(r){return JSON.stringify(r);})',
                'returnByValue': True, 'awaitPromise': True,
            }, timeout=240)
            rep = json.loads((out.get('result') or {}).get('value') or '{}')

            if a.shot:
                _pose(session, a)
                img = session.send('Page.captureScreenshot', {'format': 'png'}, timeout=240)
                pathlib.Path(a.shot).write_bytes(base64.b64decode(img['data']))
                print('screenshot -> ' + a.shot)

            if cpu:
                cdp.profile_report(cpu)
            return _report(rep, a)
        except Exception as e:                                  # noqa: BLE001
            print('\nsmoke test failed: %s' % e, file=sys.stderr)
            if child and child.stderr:
                try:
                    child.kill()
                    tail = child.stderr.read().decode('utf-8', 'replace').strip().split('\n')
                    print('\n'.join(tail[-12:]), file=sys.stderr)
                except Exception:                               # noqa: BLE001
                    pass
            return 2
        finally:
            if child:
                cdp.shutdown(child, profile, session)


def _pose(session, a):
    """THE POSE GOES ON LAST.

    --steer and --press are pinned every tick, but the game runs its own loop
    and the frame on screen when the run ends may be one it drew after the pin.
    Setting them immediately before the capture and drawing once makes the
    photograph the pose that was asked for rather than whichever frame won.

    PINNED, NOT POKED. Writing the value and drawing once loses a race with the
    page's own loop: the capture is a round trip away, and any frame the game
    draws in between is an unpinned one. Redefining the property so the game's
    own writes are swallowed makes the pose hold for every frame from here on.
    """
    if a.eval:
        # ONE EXPRESSION, IMMEDIATELY BEFORE THE SHUTTER.
        #
        # Some of what the interface does is transient by design - a banner
        # that lives five seconds, an announcement that lives three - and on a
        # software rasteriser the harness draws about one frame a second, so a
        # run long enough to get past one of those is a run that has finished.
        # This is how a state that exists for a moment gets photographed at
        # all, without a flag in the game for every one of them.
        session.send('Runtime.evaluate', {'expression': a.eval, 'returnByValue': True})
    if not (a.steer or a.press or a.freelook):
        if a.eval:
            session.send('Runtime.evaluate',
                         {'expression': 'try{window.__nr&&window.__nr.draw(1/60);}catch(e){}',
                          'returnByValue': True})
        return
    yaw, _, pitch = (a.freelook or '').partition(',')
    bits = ['(function(){var g=window.__nr;if(!g||!g.car)return 0;',
            'function pin(o,k,v){try{Object.defineProperty(o,k,',
            '{get:function(){return v;},set:function(){},configurable:true});}',
            'catch(e){o[k]=v;}}']
    if a.freelook:
        bits.append('pin(g,"lookYaw",%g);pin(g,"lookPitch",%g);'
                    % (float(yaw or 0), float(pitch or 0)))
    if a.steer:
        bits.append('pin(g.car,"steer",%g);pin(g.car,"steerVisual",%g);'
                    % (float(a.steer), float(a.steer)))
    if a.press:
        bits.append('pin(g,"boostPress",%g);' % float(a.press))
    bits.append('try{g.draw(1/60);}catch(e){}return 1;})()')
    session.send('Runtime.evaluate', {'expression': ''.join(bits), 'returnByValue': True})


def _report(rep, a):
    heading('SMOKE')
    bad = 0
    is_game = a.page == 'index.html'
    # A PAGE THAT NEVER ATTACHED IS NOT A GAME THAT FAILED, and the two used to
    # print identically: every field undefined and a game that did not reach a
    # running state. Say which it is - they are fixed in different places.
    if rep.get('noreport'):
        print('  the collector never attached to the page - no report to read', file=sys.stderr)
    elif not rep.get('driver') and is_game:
        print('  the collector is there but the DRIVER script never ran', file=sys.stderr)

    print('  page         ' + a.page)
    if is_game:
        print('  started      %s' % bool(rep.get('started')))
        print('  scene ready  %s' % bool(rep.get('sceneReady')))
        print('  state        %s' % rep.get('state'))
        print('  frames       %s' % rep.get('frames'))
        print('  gl error     %s' % (rep.get('glError') or 'none'))
        print('  draw calls   %s   (frustum rejected %s)' % (rep.get('draws'), rep.get('culled')))
    if rep.get('textures'):
        print('  textures     %s' % rep['textures'])
    if rep.get('load'):
        print('  load (ms)    ' + '  '.join('%s=%s' % (k, v) for k, v in rep['load'].items()))
    if rep.get('level7'):
        print('  level7       ' + json.dumps(rep['level7']))
    if rep.get('rivalLine'):
        rl = rep['rivalLine']
        print('  rival line   %s units wide, %s units/s of lateral travel  (%s frames)'
              % (rl['span'], rl['perSec'], rl['frames']))
        # A racing line wanders. A car chattering between the edges does not.
        # Forty units a second is far above any line and far below the hundreds
        # a full-width oscillation produces.
        #
        # (The JavaScript this replaces incremented its problem count HERE,
        # four statements before that counter was declared - so the one route
        # that could have tripped it would have thrown a ReferenceError instead
        # of reporting an oscillating rival.)
        if rl['perSec'] > 40:
            print('  the rival is not driving a line - it is oscillating', file=sys.stderr)
            bad += 1
    for n in rep.get('notes') or []:
        print('  note         %s' % n)
    for w in rep.get('warnings') or []:
        print('  warn         %s' % w)

    for e in rep.get('net') or []:
        print('  NET   %s' % e, file=sys.stderr)
        bad += 1
    for e in rep.get('errors') or []:
        print('  ERROR %s' % e, file=sys.stderr)
        bad += 1

    # A page with no NR.Game on it is not a broken game, it is a different
    # document. The launcher is DOM: no scene, no frames, no draw calls, and
    # reporting those as failures would make the one command that covers it
    # always fail.
    if is_game:
        if not rep.get('started') or not rep.get('sceneReady'):
            print('  the game did not reach a running state', file=sys.stderr)
            bad += 1
        if not rep.get('frames'):
            print('  no frames were drawn', file=sys.stderr)
            bad += 1
    elif rep.get('dom'):
        ex = rep.get('exercise')
        if ex:
            for e in ex.get('errors') or []:
                print('  EXERCISE %s' % e, file=sys.stderr)
                bad += 1
            print('  tabs         ' + '  '.join('%s(%s)' % (t['tab'], t['rows'])
                                                for t in ex['tabs']))
            dead = 0
            for r in ex['rows']:
                if not (r.get('atEnd') or (r.get('saved') and r.get('redrew'))):
                    dead += 1
                    print('  INERT  %s / %s  (saved=%s redrew=%s)'
                          % (r['tab'], r['label'], r.get('saved'), r.get('redrew')),
                          file=sys.stderr)
            print('  exercised    %d row(s), %d inert' % (len(ex['rows']), dead))
            bad += dead
        # What the page actually built, so a launcher that renders nothing is a
        # failure rather than a clean run with an empty screenshot.
        print('  controls     %s row(s), %s tab(s)' % (rep['dom']['rows'], rep['dom']['tabs']))
        if not rep['dom']['rows']:
            print('  the page built no controls', file=sys.stderr)
            bad += 1
    else:
        print('  the page reported nothing at all', file=sys.stderr)
        bad += 1

    print(('\n%d PROBLEM(S)' % bad) if bad else '\nclean')
    return 1 if bad else 0


# ========================================================== the real host ===

class Host:
    """The release binary, with its webview opened for debugging."""

    def __init__(self):
        self.child = None

    def __enter__(self):
        env = dict(os.environ)
        env['SYNX_DEBUG_PORT'] = str(HOST_PORT)
        self.child = subprocess.Popen([str(paths.EXE)], env=env,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return self

    def __exit__(self, *exc):
        try:
            if paths.WINDOWS:
                subprocess.run(['taskkill', '/PID', str(self.child.pid), '/T', '/F'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                self.child.kill()
        except Exception:                                       # noqa: BLE001
            pass

    def wait_for(self, pattern, tries=60):
        """WAIT FOR THE PAGE, NOT JUST FOR THE PORT.

        WebView2 opens its debugging endpoint as soon as the environment is
        created, which is BEFORE the window has navigated anywhere - so the
        first listing usually shows about:blank. Taking that first answer as
        final made this fail about one run in three, which is worse than not
        having it: a check that fails at random teaches people to re-run it
        rather than to read it.
        """
        import urllib.request
        saw_port = False
        targets = []
        for _ in range(tries):
            time.sleep(0.5)
            try:
                with urllib.request.urlopen(
                        'http://127.0.0.1:%d/json/list' % HOST_PORT, timeout=2) as r:
                    targets = json.loads(r.read().decode('utf-8'))
                saw_port = True
            except Exception:                                   # noqa: BLE001
                continue
            for t in targets:
                if t.get('type') == 'page' and re.search(pattern, t.get('url') or ''):
                    return t, saw_port, targets
        return None, saw_port, targets


def _eval(session, expr):
    r = session.send('Runtime.evaluate',
                     {'expression': expr, 'returnByValue': True, 'awaitPromise': True},
                     timeout=120)
    if r.get('exceptionDetails'):
        ex = r['exceptionDetails'].get('exception') or {}
        raise RuntimeError(ex.get('description') or 'threw')
    return (r.get('result') or {}).get('value')


def _host_skip(why):
    print('  skipped: ' + why)
    return 0


def _host_ready():
    if not paths.EXE.exists():
        return 'no release binary - run the build first'
    if not paths.WINDOWS:
        return ('the debugging hook is a WebView2 mechanism; WebKitGTK uses a'
                ' different one')
    return None


def run_launcher(a):
    """The launcher, driven in the real desktop host.

    PLAY did not work, and nothing in the tree could have told us. The launcher
    renders under a plain web server and every one of its rows saves correctly
    there, so the browser run was green throughout. What was broken was the
    half that only exists in the desktop host: the command that turns the
    answers into a game window.
    """
    heading('Launcher - desktop host')
    why = _host_ready()
    if why:
        return _host_skip(why)
    bad = []
    ok = lambda m: print('  ok   ' + m)                          # noqa: E731

    with Host() as host:
        page, saw_port, targets = host.wait_for(r'launcher\.html')
        if not saw_port:
            return _host_skip('the webview did not open a debug port (no display?)')
        if not page:
            print('  the host never navigated to launcher.html - last saw: '
                  + ', '.join(t.get('url') or '?' for t in targets), file=sys.stderr)
            return 1
        ok('the host opened launcher.html')

        session = cdp.Session(page['webSocketDebuggerUrl'])
        try:
            session.send('Runtime.enable')
            rows = 0
            for _ in range(30):
                time.sleep(0.4)
                rows = _eval(session, 'document.querySelectorAll("#rows .row").length')
                if rows:
                    break
            if not rows:
                bad.append('the launcher built no rows in the host')
            else:
                ok('the launcher built %d rows from launcher_view' % rows)

            mons = json.loads(_eval(session,
                'JSON.stringify((window.__SYNX_LAUNCHER__ || {}).monitors || [])') or '[]')
            if not mons:
                bad.append('no monitors came back from the host')
            else:
                ok('the host reported %d monitor(s): %s'
                   % (len(mons), ', '.join('%sx%s' % (m['width'], m['height']) for m in mons)))

            # A setting has to survive a round trip through the Rust save file.
            # Checked on rows the HOST actually reads: an earlier version
            # asserted `fps_cap`, which round-tripped perfectly and meant
            # nothing, because launcher_store writes the object verbatim and no
            # code anywhere consumed that field.
            saved = _eval(session,
                '(async () => { const t = window.__TAURI__.core.invoke;'
                ' await t("launcher_store", { settings: { mode: "windowed", width: 1280,'
                ' height: 720, monitor: 1, gpu: true, always_on_top: false, vsync: false } });'
                ' const s = await t("save_load");'
                ' return JSON.stringify(s["synx.launcher.v1"] || null); })()')
            back = json.loads(saved or 'null')
            if not back or back.get('vsync') is not False or back.get('monitor') != 1 \
                    or back.get('mode') != 'windowed':
                bad.append('a launcher setting did not survive the save file: %s' % saved)
            else:
                ok('settings round-trip through the save file')

            # CHANGING A SETTING MUST NOT MOVE THE LIST. Every row change
            # rebuilds the list, because a row can enable or grey out another
            # one. The rebuild used to empty the container and force the scroll
            # to zero, so setting anything below the fold in GRAPHICS threw the
            # player back to the top of the longest tab in the launcher.
            sc = json.loads(_eval(session, '\n'.join([
                "(() => {",
                "  const tabs = Array.from(document.querySelectorAll('#tabs .tab'));",
                "  const g = tabs.find((t) => /GRAPH/i.test(t.textContent));",
                "  if (!g) return JSON.stringify({ why: 'no graphics tab' });",
                "  g.click();",
                "  const host = document.getElementById('rows');",
                "  host.scrollTop = host.scrollHeight;",
                "  const top = host.scrollTop;",
                "  if (top < 1) return JSON.stringify({ why: 'the tab does not scroll here' });",
                "  const rows = Array.from(host.querySelectorAll('.row'));",
                "  const last = rows.reverse().find((r) => {",
                "    const b = r.querySelectorAll('button');",
                "    return b.length > 1 && (!b[0].disabled || !b[1].disabled);",
                "  });",
                "  if (!last) return JSON.stringify({ why: 'no changeable row at the bottom' });",
                "  const key = last.dataset.key;",
                "  const b = last.querySelectorAll('button');",
                "  (b[0].disabled ? b[1] : b[0]).click();",
                "  return JSON.stringify({ key: key, before: top, after: host.scrollTop,",
                "    max: host.scrollHeight - host.clientHeight });",
                "})()"])) or '{}')
            if sc.get('why'):
                ok('scroll check skipped: ' + sc['why'])
            elif abs(sc['after'] - sc['before']) > 8:
                bad.append('changing "%s" moved the list from %d to %d - the view jumps on'
                           ' every change' % (sc['key'], round(sc['before']), round(sc['after'])))
            else:
                ok('changing a row leaves the list where it was (%d of %d)'
                   % (round(sc['after']), round(sc['max'])))

            # THE LOGGING, WHICH ONLY EXISTS WHEN IT IS NEEDED. The contract is
            # precise and easy to get backwards: a run that works must leave
            # NOTHING on disk, and a run that fails must leave a file whose
            # path the player is shown. Both halves, in that order, because a
            # logger that always writes passes the second test on its own.
            report_path = APPDATA / 'synx-launch-report.txt' if APPDATA else None
            if report_path and report_path.exists():
                bad.append('a report exists after a clean start - logs are being written'
                           ' when nothing is wrong')
            else:
                ok('a clean start wrote no log')

            written = _eval(session,
                '(async () => window.__TAURI__.core.invoke("diag_report", {'
                ' reason: "synthetic failure raised by tools/smoke.py",'
                ' details: { stage: "self test", graphics: { webgl2: false } } }))()')
            if not written:
                bad.append('a failure did not produce a report at all')
            elif not pathlib.Path(written).exists():
                bad.append('the host returned a report path that does not exist: ' + written)
            else:
                text = pathlib.Path(written).read_text(encoding='utf-8', errors='replace')
                wants = ['WHAT WENT WRONG', 'THIS MACHINE', 'webview', 'graphics',
                         'WHAT HAPPENED, IN ORDER', 'WHAT TO TRY', 'synthetic failure']
                missing = [w for w in wants if w not in text]
                if missing:
                    bad.append('the report is missing: ' + ', '.join(missing))
                else:
                    ok('a failure wrote a report that names the machine and what to try')
                seen = _eval(session,
                             '(async () => window.__TAURI__.core.invoke("diag_previous"))()')
                if seen != written:
                    bad.append('diag_previous did not report the file just written')
                else:
                    ok('the launcher finds the report on the next start')
                if a.show:
                    print('\n--- the report ---\n%s\n--- end ---' % text)
                _eval(session, '(async () => window.__TAURI__.core.invoke("diag_clear"))()')
                if pathlib.Path(written).exists():
                    bad.append('the report could not be dismissed')
                else:
                    ok('the report can be dismissed once it has been read')

            # ...and PLAY has to actually take the window to the game
            _eval(session, 'document.getElementById("play").click()')
            session.close()
            page, _, targets = host.wait_for(r'index\.html', tries=30)
            if page:
                ok('PLAY navigated the window to the game')
            else:
                bad.append('PLAY did not reach the game - the window is still at: '
                           + (', '.join(t.get('url') or '?' for t in targets) or 'unknown'))
        except Exception as e:                                  # noqa: BLE001
            bad.append('the driver failed: %s' % e)
        finally:
            try:
                session.close()
            except Exception:                                   # noqa: BLE001
                pass

    for b in bad:
        print('  %s%s%s' % (C.red, b, C.off), file=sys.stderr)
    if bad:
        print('\n%d PROBLEM(S) launching the game' % len(bad), file=sys.stderr)
        return 1
    print('\nthe launcher opens, saves, and starts the game')
    return 0


def _monitor_at(mons, x, y):
    """Which monitor rectangle contains a point. -1 for none."""
    for i, m in enumerate(mons):
        if m['x'] <= x < m['x'] + m['width'] and m['y'] <= y < m['y'] + m['height']:
            return i
    return -1


def run_display(a):
    """Does the game open on the display the launcher was told to use?

    Reported: choosing a display in the launcher does nothing. The launcher
    check could not have caught it - it proves PLAY navigates the window, which
    is a question about a URL; where the window ENDED UP is a question about
    the desktop, and nothing was asking it.

    From inside the webview, window.screenX is the window's position in VIRTUAL
    DESKTOP coordinates, which is the same space the host's monitor list is in.
    So "which display is it on" is decidable without a screenshot and without
    any platform API.
    """
    heading('Launcher - which display')
    why = _host_ready()
    if why:
        return _host_skip(why)
    bad = []
    # Target the display the launcher is NOT on, or the test proves nothing.
    # Monitor 1 is the second one the host listed; on a two-screen desktop the
    # launcher opens on the primary, so 1 is the one worth asking for.
    want = 1
    for mode in ([a.mode] if a.mode else ['windowed', 'borderless', 'fullscreen']):
        with Host() as host:
            page, saw_port, _ = host.wait_for(r'launcher\.html')
            if not saw_port:
                return _host_skip('the webview did not open a debug port (no display?)')
            if not page:
                bad.append(mode + ': the host never reached launcher.html')
                continue
            session = cdp.Session(page['webSocketDebuggerUrl'])
            try:
                session.send('Runtime.enable')
                for _ in range(30):
                    time.sleep(0.4)
                    if _eval(session, 'document.querySelectorAll("#rows .row").length'):
                        break
                mons = json.loads(_eval(session,
                    'JSON.stringify((window.__SYNX_LAUNCHER__ || {}).monitors || [])') or '[]')
                if len(mons) < 2:
                    session.close()
                    return _host_skip('only one display on this machine')
                if 'x' not in mons[0]:
                    bad.append('launcher_view does not report monitor positions, so'
                               ' nothing can check this')
                    session.close()
                    continue
                # where the launcher itself is, so a pass cannot be an accident
                # of it already being on the target screen
                at0 = json.loads(_eval(session,
                                       'JSON.stringify([window.screenX, window.screenY])'))
                launcher_on = _monitor_at(mons, at0[0] + 40, at0[1] + 40)

                # `launch_game` TAKES THE SETTINGS. Storing them and clicking
                # PLAY does not work: the button sends the launcher's own
                # in-memory answers, which overwrite whatever was written a
                # moment earlier - so a test through the button tests the
                # defaults. Fired, not awaited: launch_game navigates the
                # window as its last act, which destroys the execution context
                # the await is living in.
                _eval(session,
                      'window.__TAURI__.core.invoke("launch_game", { settings: {'
                      ' mode: "%s", width: 1280, height: 720, monitor: %d,'
                      ' gpu: true, always_on_top: false, vsync: true } })'
                      '.catch(function(){}), "sent"' % (mode, want))
                session.close()

                page, _, _ = host.wait_for(r'index\.html', tries=40)
                if not page:
                    bad.append(mode + ': PLAY never reached the game')
                    continue
                s2 = cdp.Session(page['webSocketDebuggerUrl'])
                s2.send('Runtime.enable')
                # let the window settle: the reshape is marshalled onto the
                # main thread
                time.sleep(2.5)
                box = json.loads(_eval(s2, 'JSON.stringify([window.screenX, window.screenY,'
                                           ' window.outerWidth, window.outerHeight])'))
                s2.close()
                got = _monitor_at(mons, box[0] + max(1, box[2]) / 2,
                                  box[1] + max(1, box[3]) / 2)
                line = ('%-11s asked for %d, opened on %s   (launcher was on %d, window at'
                        ' %d,%d %dx%d)' % (mode, want, 'nowhere' if got < 0 else got,
                                           launcher_on, box[0], box[1], box[2], box[3]))
                if got == want:
                    print('  ok   ' + line)
                else:
                    bad.append(line)
            except Exception as e:                              # noqa: BLE001
                bad.append('%s: the driver failed: %s' % (mode, e))
            finally:
                try:
                    session.close()
                except Exception:                               # noqa: BLE001
                    pass
    print('')
    for b in bad:
        print('  %sWRONG DISPLAY  %s%s' % (C.red, b, C.off), file=sys.stderr)
    if bad:
        print('\n%d PROBLEM(S)' % len(bad), file=sys.stderr)
        return 1
    print('the game opens on the display the launcher was told to use')
    return 0


def run_profile(a):
    """Where a frame's CPU time actually goes, in the real desktop host.

    The browser harness runs on a software rasteriser, where the GPU is so slow
    that every profile is a picture of SwiftShader and nothing else - so it
    cannot answer this even in principle. This drives the release binary, which
    uses the real GPU.
    """
    heading('Frame profile - desktop host')
    why = _host_ready()
    if why:
        return _host_skip(why)
    with Host() as host:
        page, saw_port, _ = host.wait_for(r'index\.html|launcher\.html')
        if not saw_port:
            return _host_skip('the webview did not open a debug port (no display?)')
        if not page:
            print('  the host never opened a page', file=sys.stderr)
            return 1
        session = cdp.Session(page['webSocketDebuggerUrl'])
        try:
            session.send('Runtime.enable')
            if 'launcher.html' in (page.get('url') or ''):
                _eval(session, 'document.getElementById("play").click()')
                page, _, _ = host.wait_for(r'index\.html', tries=40)
                if not page:
                    print('  PLAY never reached the game', file=sys.stderr)
                    return 1
                session.close()
                session = cdp.Session(page['webSocketDebuggerUrl'])
                session.send('Runtime.enable')
            # Drive into a race the way the browser harness does, then sample.
            _eval(session, '(function(){var g=window.__nr;if(!g)return 0;'
                           'try{g.levelIndex=%d;g.start&&g.start();}catch(e){}return 1;})()'
                  % a.route)
            session.send('Profiler.enable')
            session.send('Profiler.setSamplingInterval', {'interval': 100})
            session.send('Profiler.start')
            print('sampling for %gs ...' % a.seconds)
            time.sleep(a.seconds)
            prof = session.send('Profiler.stop', timeout=240).get('profile')
            cdp.profile_report(prof)
            return 0
        except Exception as e:                                  # noqa: BLE001
            print('\nprofile failed: %s' % e, file=sys.stderr)
            return 2
        finally:
            try:
                session.close()
            except Exception:                                   # noqa: BLE001
                pass


# =================================================================== main ===

def parse_sets(text):
    """--set neonBoost=4,hudGlow=0

    The settings check proves every row is READ by the game. It cannot prove
    the value reached the renderer - that is the join on the far side of
    applySettings, and it is the one that silently breaks. This is how a row
    that is not the preset gets driven, and read back, at all.
    """
    out = {}
    for pair in (text or '').split(','):
        if not pair:
            continue
        k, _, v = pair.partition('=')
        if k and v:
            out[k.strip()] = int(v)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(prog='smoke.py', description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('command', nargs='?', default='smoke',
                    choices=['smoke', 'launcher', 'display', 'profile'])
    ap.add_argument('--seconds', type=float, default=16)
    ap.add_argument('--route', type=int, default=6)
    ap.add_argument('--preset', type=int, default=0,
                    help='0 LOW .. 3 ULTRA; the draw-call census is only meaningful'
                         ' next to the preset it was taken at')
    ap.add_argument('--page', default='index.html')
    ap.add_argument('--shot', default=None)
    ap.add_argument('--hold', default='', help='stop on a screen and leave it there')
    ap.add_argument('--freeroam', default='')
    ap.add_argument('--probe', default='')
    ap.add_argument('--at', default='', help='park the car at one arc length')
    ap.add_argument('--park', default='')
    ap.add_argument('--reel', default='')
    ap.add_argument('--look', default='')
    ap.add_argument('--freelook', default='', help='"<yaw>,<pitch>" in radians')
    ap.add_argument('--steer', default='')
    ap.add_argument('--press', default='')
    ap.add_argument('--cam', default='', help='0 chase, 1 driver, 2 drone')
    ap.add_argument('--scale', type=int, default=-1)
    ap.add_argument('--upscaler', type=int, default=-1)
    ap.add_argument('--set', dest='sets_raw', default='')
    ap.add_argument('--server', default='http://127.0.0.1:18080')
    ap.add_argument('--nocull', action='store_true')
    ap.add_argument('--nobake', action='store_true')
    ap.add_argument('--exercise', action='store_true',
                    help='walk every control on a DOM page and report inert rows')
    ap.add_argument('--profile', action='store_true')
    ap.add_argument('--eval', default='',
                    help='an expression run immediately before --shot, for'
                         ' photographing something transient')
    ap.add_argument('--show', action='store_true', help='launcher: print the report')
    ap.add_argument('--mode', default='', help='display: one window mode only')
    a = ap.parse_args(argv)
    a.sets = parse_sets(a.sets_raw)
    # `profile` as a command samples for eight seconds by default, not sixteen
    if a.command == 'profile' and '--seconds' not in (argv or sys.argv):
        a.seconds = 8
    return {'smoke': run_smoke, 'launcher': run_launcher,
            'display': run_display, 'profile': run_profile}[a.command](a)


if __name__ == '__main__':
    sys.exit(main())
