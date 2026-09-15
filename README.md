# SYNX — Synthwave eXtreme Racing

A neon racer on a Rust simulation core, rendered in WebGL2 and shipped as a
single self-contained executable.

> **Open beta.** Expect bugs, rough edges and things that change between
> builds. Reports are welcome.

> **Photosensitivity warning.** This game contains rapidly flashing lights,
> high-contrast strobing and saturated neon throughout. A small number of
> people may experience seizures when exposed to certain flashing lights or
> patterns. If you or anyone in your family has an epileptic condition, consult
> a doctor before playing. The game shows this notice on every launch.

| | |
|---|---|
| **Website** | https://synx-racing.vercel.app/ |
| **Game** | https://github.com/suryanarayanrenjith/SYNX |
| **Server** | https://github.com/suryanarayanrenjith/synx-server |

Both repositories are private while the beta runs; the links will resolve once
they are opened up.

---

## What it is

A 173 km road cut into seven routes, raced against a rival that drives the same
physics you do. The seven routes are also a seven-chapter campaign. It opens on
a coastal highway at dusk and ends on an elevated neon expressway, by way of a
canyon, a mesa, a midnight city, an ash-choked volcanic basin and a factory
floor.

Everything is lit and composited in linear HDR, so the neon glows rather than
clipping to white. There is no build step for the front end — the browser
loads the same files the executable embeds.

## Running it

```sh
node tools/build.js            # the game
node tools/build.js --all      # ...with tests, checkers and a browser smoke run
node tools/build.js --run      # ...and launch it
```

That produces `target/release/synx[.exe]` — one file, no installer, no runtime
to fetch. The whole of `web/` is compiled into it.

For a browser session, serve `web/` over HTTP:

```sh
cd web && python3 -m http.server 8000
```

## Architecture

Three layers, and the boundary between them is the thing worth understanding.

**`crates/synx-core`** — the simulation, compiled to `wasm32-unknown-unknown`
and loaded by the page. Course generation, the four-wheel vehicle solver, the
rival's racing line and driver, the landscape distance field, mesh baking,
particles, and the multiplayer wire format. It has a hand-written C ABI and no
`wasm-bindgen`: everything crossing the boundary is a scalar or a block of
floats that JavaScript maps as a typed-array view straight onto linear memory,
so nothing is copied.

**`web/`** — the renderer and the game. WebGL2, one scene program, a canvas
HUD, and the level scripting. This is the half that decides *what* to draw;
the core decides where everything is.

**`crates/synx-rec`** — the recorder: a replay-buffer ring, a baseline JPEG
encoder and an AVI muxer, with no dependencies. Its own wasm module, loaded by
a Web Worker, so the encode runs on a thread that is not drawing the game and
the ring's memory is not the core's.

**`src-tauri`** — the desktop host. Owns the window, the launcher, the save
file and the crash report. Nothing about the game lives here.

The core runs in the *same process* as the renderer, which is why the boundary
is cheap. The host is a separate process and only sees the window.

## Controls

| | |
|---|---|
| Steer | `←` `→` / `A` `D` |
| Throttle, brake | `↑` `↓` / `W` `S` |
| Slide | `SPACE` — engage, hold; the wheel sets how deep |
| Boost | `SHIFT` |
| Camera | `C` |
| Pause | `ESC` |
| Recording on/off | `F8` — off until you ask |
| Save replay | `F9` — the last thirty seconds |
| Mark highlight | `F10` |

Gamepad and touch are supported; bindings are on the options screen.

## The launcher

Opens before the window exists, because three things cannot be changed
underneath a live webview: the graphics backend, the window mode and size, and
which display it opens on. Everything that *can* change live stays on the
in-game options screen.

Changing the renderer or vertical sync relaunches the process — both are baked
into the webview's command line when its environment is created, so a setting
that claimed to work without a restart would be a label for something that does
not happen.

## Tooling

Everything under `tools/` is Node with no dependencies.

| | |
|---|---|
| `build.js` | the whole build: core → wasm → host |
| `pack.js` | the asset archive (`--unpack`, `--list`, `--check`) |
| `smoke.js` | runs the game in headless Edge and reports what broke |
| `profile.js` | CPU profile of the real GPU build, by file and by function |
| `trimscene.js` | drops geometry from `scene.bin` that no frame draws |
| `shrinkpng.js` | lossless PNG recompression, pixel-verified |
| `checklauncher.js` | drives the release binary through PLAY |
| `checkdisplay.js` | proves the game opens on the display it was told to |
| `checkforge.js` | builds Aurora Forge's hall and drops a ray on its roof deck |
| `trimatlas.js` | erases atlas sprites nothing draws, and un-declares them |
| `checkdom.js`, `checkshaders.js`, `checksettings.js`, `checkupscale.js` | static checks |

`smoke.js --set <key>=<index>,...` drives any settings row and reports what the
renderer made of it. `checksettings.js` proves a row is READ; only a run proves
the value reached the other side of `applySettings`, which is the join that
fails silently. `--exercise` walks every row on every tab and reports the ones
that do nothing.

`smoke.js --probe <name>` runs a targeted investigation instead of a plain run:
`palms`, `forge6`, `jump`, `tiles`, `batch`, `fps`, `advisory`, `predator`,
`director`, `layout`, `ghost`, `coast`, `sink`, `options`, `multiplayer`.

Probes count **frames, not seconds** — the harness draws about one frame a
second on a software rasteriser, so wall-clock time says nothing about how far
the car has got.

## Asset pipeline

The pack is the source of truth. `assets-src/` is a scratch directory, not a
checked-in tree:

```sh
node tools/pack.js --unpack     # write assets-src/ out of the pack
# ...edit...
node tools/pack.js              # rebuild web/data/synx.pak
node tools/pack.js --check      # verify every entry byte for byte
```

`shrinkpng.js` re-encodes PNGs losslessly — per-row filter search plus level-9
deflate — and decodes every result back and compares it pixel for pixel before
writing. It does not quantise, reduce bit depth or drop channels.

## Recent work

**AURORA FORGE COULD BE LOST BUT NOT FINISHED LOSING.** If Javas got far enough
ahead the chapter put up TRIAL FAILED and stopped, for ever, with every key
still being read. Two faults on top of each other.

`loseChapter` handed the loss to `js/story.js`, which refuses one unless the
story is in its race mode — and the call sites that mattered (a rewind, the
ability cinematic, a conversation) had already put it in `level6Special`. The
handover was rejected, and it was rejected *silently*, because the code only
ever checked that the method **existed**. Nothing finished the run.

Then the director kept the frame. `js/chapters.js` patches `Game.update` *after*
`js/story.js` does, so its hook is the outer one — and the `lost` branch
returned `true` every frame, which meant `story.update` was never reached. The
loss sequence is driven entirely by `story.update`. The card came up and the
game stopped.

The card is a beat now: a second and a half, then the frame goes back and the
story runs the finish roll, Javas' line and the retry. The loss is also checked
for acceptance rather than assumed, and there is a fallback straight to the
retry when it is refused.

Three more in the same chapter, all the same shape — a failure that cost
nothing. Being **crushed in the sorting floor** called `rewind()` directly, so
that trial was the one with no budget on it while a missed handshake three doors
back cost the chapter. Being **read three times by the ghost model** rewound to
a checkpoint that reset the count, which is a loop with no exit but winning.
And a second crush at the same chute replayed the whole set piece **in silence**
— no impacts, no sparks, no UNIT SCRAPPED card — because its one-shot beat flags
were still set from the first. Javas also announces himself now before he is
gone: a run that ends the instant a number crosses a threshold nobody was shown
is a run that ends unfairly.

**The sorting floor's balers were built through the road.** The chamber floor
was a slab standing 1.1 above the tarmac and seventeen wide; the jaw plate was
centred on 1.1 with 2.2 of height on it — y=0..2.2, on the road, through the
car, in the mouth of all three bores at once — under a comment claiming it sat
at 1.1..4.5, which is what that number would have meant if it had been the
underside rather than the middle. Each machine also carried its own legs and ram
cylinders at a fixed offset from its own centre, which put four of them in the
bay *next door* at windscreen height, and three 18.4-wide roofs on top of each
other. None of it has a collider, so the car drove through all of it.

The floor is flush paint now, the frame is four shared columns on the two chute
walls and the two road edges under one roof, the shoes press between each bay's
*own* faces, and the jaw hangs clear and only reaches the floor when the trial
says it has a car. `tools/checkforge.js` samples a whole baler cycle and fails
if anything stands in a driveable bay below the roof of a car; it reports 49
problems on the geometry it replaced.

**The recorder does not touch the frame budget any more.** It was written to
run beside the renderer and that was the wrong place for all three of its
expensive parts. Saving a clip froze the game for seconds; recording at all
cost a stall every captured frame.

The encoder is still `crates/synx-rec` — a baseline JPEG encoder, an AVI muxer
and a ring with marks on it, no dependencies. What changed is where each piece
runs.

**The readback was synchronous.** `gl.readPixels` into a CPU array makes the
thread wait for the GPU to drain everything queued and then copies the
framebuffer back across the bus, thirty times a second, in the middle of the
frame. It reads into a **pixel pack buffer** now, which returns immediately
because the destination is on the card, and drops a `fenceSync` behind it. The
fence is polled with `clientWaitSync(sync, 0, 0)` — a *zero* timeout, which
asks and returns rather than waiting — and the pixels are collected a frame or
two later, which a replay does not care about and the game does. Three
readbacks may be in flight at once; if they all are, the frame is dropped
rather than queued, because a recorder that piles up work on a busy machine
makes a busy machine worse.

**The encode ran on the drawing thread.** A baseline JPEG of a 480p frame is a
few milliseconds of DCT and it was being spent thirty times a second on the
thread trying to produce a frame every seven. `crates/synx-rec` is its own wasm
module now, loaded by `web/js/recworker.js`, with its own heap — which also
stops the ring's ninety-odd megabytes growing the *core's* linear memory and
detaching every typed-array view the rest of the game holds over it. Frames
reach it as transferred `ArrayBuffer`s and every one is handed straight back to
be filled again, so nothing allocates per frame.

**The save went through JSON.** `Array.from(clip.bytes)` on a twenty-five
megabyte clip builds twenty-five *million* boxed JavaScript numbers, which
Tauri then serialised to a string about three times that size and parsed back
into bytes on the far side. That was the reported freeze, in its entirety. The
clip goes over as a **raw request body** now — `tauri::ipc::Request`, with the
label in a header, because the body is the file — so a save is a memcpy and a
write, and F9 does not drop a frame.

*Motion JPEG*, still, because every frame has to be independent. The buffer
throws the oldest frame away to make room; an inter-frame codec cannot survive
that, since frame 400 is described in terms of frame 399. Frames that stand
alone make the ring a plain queue, a highlight a slice of it, and stitching two
highlights together a concatenation rather than a transcode.

**It is off until you ask.** `F8` starts it, `F9` writes the last thirty
seconds, `F10` marks the moment — all three are rebindable rows on the CONTROLS
screen, and all three are global, so they answer on the title screen and inside
a cutscene as well as mid-race.

**And it chooses for itself.** Every captured frame carries a score the game
works out from what it already knows: speed against *this car's* ceiling — the
Forge rebuild changes what fast means halfway through chapter six — how close
the nearest rival is and how fast, air time, how far the car is sideways, boost,
and a decaying spike for an impact. At the end of a run `save_best` reads every
one of those scores, slides a window over them, and cuts the stretch that scored
highest. It sums a window rather than taking the peak on purpose: the loudest
single frame in this game is a collision, and a clip that opens on a car
stopping is not a highlight. The cut is then laid *around* the loudest frame
inside the winning stretch, seventy per cent of it before, because the approach
is what makes a moment readable. A player who presses F8 and nothing else gets
a file of their best moment without asking for one.

Clips go where the platform says video goes: `%USERPROFILE%\Videos\SYNX`,
`~/Movies/SYNX`, or `$XDG_VIDEOS_DIR/SYNX` read from the environment and then
from `user-dirs.dirs`, falling back to the directory the save file already
lives in — which is somewhere the game has demonstrably been able to write.
Names are `SYNX-2026-09-15-190412-CLEAN LANDING.avi`; the label is rebuilt on
the Rust side rather than trusted, because a string from the page that reaches
a path is a string that gets checked on the far side of the boundary.

`cargo run -p synx-rec --release --example clip` writes a sample file, which is
the half of this the unit tests cannot prove — they check the round trip
against a decoder written beside them, and that checks that a real player opens
the result.

`node tools/checkrec.js` is the other half, and it exists because the parts
that were broken are exactly the parts a unit test cannot see. It runs the
worker against the real `synx_rec.wasm` over the real message protocol, and the
capture loop against a WebGL2 stub that **fails the run if anything asks it to
block** — a `readPixels` into CPU memory, a `clientWaitSync` with a timeout on
it, a `finish()`. It also checks that every pixel buffer comes back to be
reused and that a 144 Hz game against a 30 fps recorder starts about forty
readbacks a second rather than a hundred and forty.

**`pack.js --check` was not a check.** It built the archive first and then
verified the file it had just written, which is a tautology on a good day. On a
bad one it is a disaster: `assets-src/` is a scratch tree that is not checked
in, so it is routinely absent or half-populated, and running `--check` against
four files replaced a forty-two megabyte shipped archive with a three hundred
kilobyte one, reported "verified: all 4 entries match", and exited zero. It
verifies what is on disk now and writes nothing, and the *build* refuses to drop
entries that the existing pack has and `assets-src` does not — `--force` is
there for a deliberate removal.

**The tools stopped carrying three copies of a PNG codec.** `shrinkpng` had a
reader and a filter-searching writer, `gentex` had its own writer that put
filter 0 on every row, and `trimatlas` reached into `shrinkpng` for the first
one. They share `tools/lib/png.js` now, which also means `gentex`'s generated
sheets go through the per-row filter search — verified pixel-for-pixel identical
against what shipped. Nothing under `tools/` turned out to be dead: every file
is either run by `build.js --check`/`--smoke` or is the only source for
something in the pack.

**BROKEN CIRCUIT was the last chapter anybody could play.** Chapter 6 does
not end at a finish line - it ends when the blue reserve runs out on the
calibration run, about a kilometre short of one - so it never passes through
the two lines in `Game.update` that decide a race, and `won` was still false
from `resetCar` when Javas finished congratulating the player.

`completeChapter` has a door on it: a chapter completes when the player WON
it, or when it is the one chapter whose written ending is a defeat and that
defeat was earned. Chapter 6 is neither, so every successful run of the Forge
played its ending, logged "tried to complete without being won" to a console
nobody has open, and was recorded as a loss. Chapter 6 was never added to
`completedChapters`, NEON HORIZON was never unlocked, and the campaign stopped
there.

The door is right and stays; what was missing is the chapter answering it.
Chapter 5 already makes the opposite statement - `won = false` and
`canonicalEarned = true`, because its ending is a defeat that still completes -
and Chapter 6 now makes the plain one where the calibration is passed.

**And the checker could not see it.** `tools/checkstory.js` walks the whole
campaign down both paths, but it resolves every chapter the way the five
ordinary ones end: it sets `won` itself and calls `handleFinish`. That is
exactly the code path the two director-driven chapters do not take, so a
chapter that completes through its own door was invisible to it. It has a
phase for that now - every call to `completeChapter` from a director must sit
in a class that also declares a result - and the phase reads a comment-stripped
copy of the source, because the first version of it grepped the class body and
passed on the broken build: the comment explaining the fix contains the very
words it was looking for.

**Aurora Forge has a hole in its roof.** A kilometre of the production hall
has lost its roof and somebody has run a steel ramp up through it: the cars
climb out of the building at 128.8 km, drive a kilometre across the top of it,
and come back down a slope into the hall at 130.1. It is world geometry rather
than a chapter script, so the campaign and a Free Roam tour both get it, and
both cars take it — the rival is armed off the same table the player is, and a
remote car's height is already on the wire.

The solver could not do it. A ramp was a climb and a lip: past the lip the car
is unsupported, which is exactly right for the eight launch ramps and exactly
wrong for a structure it is meant to come back *down* off — the only way off an
eighteen-unit deck was an eighteen-unit drop. `Ramp` has a fourth mark now,
`s2..s3`, that eases the height back to the road with the wheels still on it,
and a ramp that has one smoothsteps its incline as well: a launch ramp wants
its steepest slope at the very top, because that is what throws the car, and a
ramp onto a deck has to arrive parallel to the thing it joins or the suspension
reads the join as an impact. `s3 == s2` is the old profile exactly, and the
regression test asserts that the crest ramp still launches.

**Emptying the hall is one rule, not thirty edits.** Nothing whose whole depth
sits above eight units is built inside the breach — the roof panels, the ridge,
the purlins, the crane rails, the conveyor, the ducts, the trays, the high
bays, and the gantry cranes that swing a body shell across the carriageway once
a bay. Everything that holds the building up reaches below that line and
stands. Doing it as a test inside `box` and `run` rather than as a list of call
sites is what makes it stay true: anything hung over this road later is cut
automatically, and a crane left standing under a section the car drives *over*
is a collision with something a kilometre up that nothing would have caught.

**And both mouths of the hall are a building now.** Aurora Forge used to simply
begin — nineteen kilometres of hall whose first bay was identical to its four
hundredth, so arriving read as the fog thinning rather than as going indoors.
There is a portal at each end: a head beam deep enough to throw a shadow, a
reveal set back inside it so the opening has a thickness, hazard banding down
both jambs, the company's name on the beam and a signal either side that is
green on the way in and red behind.

**`tools/checkforge.js`** builds the hall for real through a GL stub and drops
a ray down the centreline at a hundred stations. It caught two things a
screenshot would not have: the trestle's diagonal braces leaned seven and a
half units sideways and crossed the carriageway, one of them standing a unit
and a half proud of the running surface on the climb, and the chevrons were
laid four times as thick as road paint, so the surface the car stood on was a
fifth of a unit above the surface the solver had it on. The worst disagreement
between the drawn deck and the armed profile is eighty millimetres now.

**The speedometer was the wrong colour.** The drawn instrument that replaced
the sprite was a good rev counter and a bad SYNX one: a turned metal bezel,
white ticks, white numerals and a sweep that ran cyan to amber — which passes
through GREEN at half throttle, and green is the one hue this game never uses,
so the brightest object on the screen was the only thing on it that was not
part of the palette. The ramp is cyan into violet into magenta and only then
into the warning red; the bezel is two neon tubes with dark glass and the
game's own scanline wash between them; the numerals are ice rather than white;
the instrument is lit from inside by a wash in whatever colour it is reading;
and it carries the same corner ticks as every other panel in the game. The
scale also stopped colliding with itself: majors come off a ladder of round
numbers and the ladder is walked until the whole scale fits in eight labels, so
the rebuilt engine's dial reads 0–250 in fifties instead of printing "100 125"
as one word across the top.

**559 KB of atlas nobody draws.** `speed`, `boost_bar`, `boost_bar_border`,
`turbo`, `mph` and `CAT` are what the drawn speedometer, boost meter and
DRIVETRAIN readout replaced, and `Digital_Italic` and `Wooden Atlas` are a
duplicate of a file that ships loose and a sheet from the game this one was
built out of. They are rectangles inside two sheets that also carry the
countdown numerals and the chequered flag, so the sheets stay and the AREA is
what comes back: erased to transparent black, `GUI_HUD_Console.png` deflates
80% smaller. `tools/trimatlas.js` derives the live set from `js/hud.js` rather
than carrying a list — a hard-coded one is wrong the first time somebody draws
a sprite again, and the failure is a hole in a sheet rather than an error — and
drops the dead entries from `data/game_data.js` so a rectangle that has been
erased cannot still be addressed.

**The window was hidden for the whole of the load.** The host creates its
window invisible and reveals it when the page says it has drawn, because a
native window that appears white and then paints looks broken in a way a
browser tab never does. The call that said so was at the *end* of the boot
chain — after the pack, the core, the shaders, the course and the dressing —
so a direct launch gave the player ten seconds of no window at all and then a
game. That is the whole of the "it takes ages to start" report: it did not
take any longer than it does now, it was simply invisible while it did it, and
every frame of the cold open covering that wait was drawn where nobody could
see it. The first frame of `js/ignition.js` makes the call.

**The loading screen stopped moving whenever anything was loading.** Every
heavy pass of `Scene.load` — the two geometry repairs, the course build, the
draw lists, the dressing — is synchronous, and the cold open's tachometer is
drawn by `requestAnimationFrame`, which runs on exactly the thread those
passes are blocking. `NR.Boot.breathe` yields between them: a frame, and then
the task after it, which is the point at which the browser has actually
painted. It is capped at thirty-two milliseconds so a machine that cannot
produce a frame is not made slower for being prettier. Releasing the archive
into blobs — one synchronous copy of forty-two megabytes, which used to land
on the exact frame the cold open began its closing move — is spread over a few
frames the same way, and nothing waits for it.

**The bar is one number now.** Four files each know a quarter of how far the
boot has got and none of them can see the others, so none of them could ever
say "sixty per cent" and mean it — the old bar was the scene loader's own
fraction, which sits at zero for the whole archive read and then races.
`js/boot.js` declares the phases and the share of the wait each is worth;
every file reports only its own fraction of its own phase. The archive is the
one part with a real denominator, so `js/pak.js` reads the body as a stream and
counts bytes rather than waiting on one `arrayBuffer()` promise that says
nothing until the last byte.

**The cold open cannot be skipped.** It used to come down on the first key,
click or pad button. Skipping it did not skip a byte of the load — it only
removed the one thing on screen saying the machine was working and handed the
rest of the wait to a safety notice that then had to type over a busy thread,
which is the stutter the screen exists to have fixed. Input is still *taken*,
swallowed at the capture phase so nothing behind it can be pressed through a
screen the player cannot see past; it simply does not end it. The instrument
is cached into one offscreen square and blitted, because re-rasterising
forty-one ticks and eleven numerals sixty times a second on the thread that is
building the course is exactly the cost this screen should not have. Ends on
an outro rather than a cut.

**The speedometer was a picture of a speedometer.** Two atlas sprites: one at
7% opacity underneath, and the same 180×102 bitmap over it with `drawImage`'s
source rectangle clipped to the fraction of top speed the car was doing — so
the "needle" is a hard vertical edge travelling through the artwork, the
numbers on the face are painted into the texture, and the scale cannot
re-draw itself when the car's ceiling changes, which it does twice over the
campaign. It is drawn now: the scale re-derives from the ceiling the solver
will actually enforce, rounded up to a whole major so it ends on a labelled
tick; the needle has mass; the shift lights over the bezel read the same 0..1
the DRIVETRAIN rev bar does; the run's fastest is left on the scale. The face
is cached per size, scale, unit and glow setting.

**The boost meter was three more sprites, and four renderers.** A 512×64
border and fill stretched across a third of the frame, plus a hand-rolled
segmented bar drawn over the top of them for raceMode's blue reserve, because
the shipped atlas bakes its fuel segments red and a tint cannot remove red.
One meter with four readings now — live, latched, full, part — with the latch
threshold marked on the bar, because a reserve that will not fire until it is
a third full is a rule the player could otherwise only learn by being refused.

**The music started under the wrong screen.** The title theme is deliberately
held through the cold open and the photosensitivity notice so it can begin
*with* the opening shot. Three things were stopping it. A track asked to start
from the top while it was still buffering came back, on `canplay`, as a track
asked to carry on from wherever it was — and on a cold cache that is exactly
when the cue lands. A cue and a cross-fade were the same 1.6 seconds, so the
first bar and a half happened under a fader on its way up. And a player who
skipped the opening released nothing at all, because the only path that
released the hold was the veil lifting. The opening also waits a beat — capped
— for the element to be able to play and for the context to be running, since
a suspended context consumes the stream silently and hands back a song several
seconds in.

**The road is lit by the things standing over it.** Every glowing object in
the world was emissive geometry and nothing else: the lamp face was a bright
quad, the gantry a bright bar, and the only reason the tarmac underneath was
not black is that the car's own headlights were on it. What a player reads as
a street light is not the lamp — it is the POOL, the ellipse on the road that
slides past as you drive — and there was none, so the frame was a great deal
of glow standing over a road none of it touched, and the bloom was doing all
the work. `worldLamps` in the scene shader takes the nearest six as real
local sources. A street lamp and a gantry are the same light with different
extent, so both are LINE lights — a centre, an axis and a half-length, where a
lamp is the case with zero length: a point light at the middle of a forty-unit
neon run would put a hot spot on the centre line and leave both verges dark.
Positions are harvested by the emitters that place the geometry, because the
only thing that knows where a lamp ended up is the code that put it there.

**The grade.** With the road genuinely lit, the glow no longer has to carry
the picture, and it was carrying far too much of it. The bloom threshold was
1.30 — low enough that lit tarmac, barrier steel and the fog itself were over
the line — so the glow was not coming off the neon, it was coming off
everything, and nothing could stand out from a wash that was the whole frame.
Threshold, bloom amount, the saturated-neon weight and the anamorphic stretch
all come down together; NEON BOOST on HIGH is the old picture exactly, for
anyone who wants it.

**The redundant-uniform filter.** The state filter in `js/game.js` deliberately
declined to cache uniforms, on the grounds that they "are mostly matrices that
change every frame anyway". The call pattern says otherwise: `Scene.bind`
uploads about sixty uniforms and runs **seven** times a frame — once for the
main view and once for each of the reflection probe's six faces — and exactly
two of those sixty differ between the seven. The other fifty-eight are the
ambient, the sun, the fog, the headlights, the rival lamps, the cascade
matrices and the probe box, restated identically six times over. `js/gl.js`
now filters them, keyed on the uniform location, which identifies a program and
a slot together because a location belongs to exactly one program. Compared by
value and never by reference, because `uModel` is handed the same scratch
matrix on consecutive draws with different contents in it.

**Per-frame allocation.** `Scene.renderProbe` rebuilt a six-entry table of
direction/up pairs — nineteen arrays — three 4x4 matrices and the projection
itself on every frame, then three more vectors per face inside its own loop.
`M4.lookAt` allocated four `Float32Array(3)` on each of its fifteen-odd calls a
frame. `DriverFigure.draw` built three objects per rig part per car per pass —
the note above `viewAt` is about exactly that loop, and the fix had been applied
to the matrix views but not to the descriptors. `setHeadlights` rebuilt six
vectors, `setRivalLights` allocated a list and sorted it to pick three, and
`sunDirection` allocated twice on each of its nine calls a frame. All of it is
scratch that lives as long as the thing that owns it now.

**The emitters in the core.** `particles.rs`. `integrate` and `build` moved
first because they walked every particle; what stayed behind was the half that
decides things. The arithmetic in that half was never the cost — the allocation
was. Every one of the four continuous emitters produced its particles by
building an eighteen-field JavaScript object for `spawn` to read back out and
drop, at a few thousand a second with the boost lit. It is one call per car per
frame now. The rates and constants are transcribed line for line; what is
deliberately different is the random *sequence*, because `Math.random` does not
exist on that side and the distribution is the only property any of these
emitters relied on.

**The HUD.** Setting `shadowBlur` and filling anything makes the 2D context
rasterise the shape, blur it in a scratch surface and composite the result —
per call, over a canvas the size of the window times the device pixel ratio.
This file did it forty-three times a frame, and assigning `font` parsed a CSS
shorthand on every label. Both are answered once now, and the blur radius is
scaled by a row the player owns, so the interface can be drawn flat and sharp
on a machine that is short of CPU rather than GPU.

**Graphics rows.** Ten of them, and every one but the two the paragraphs above
are about defaults to exactly what the game shipped with. ROAD LIGHTING is the
new one: whether the lamps and the gantry neon cast light or only glow. NEON BOOST is the term in the threshold pass that weights
saturated light over white light — the one number that decides how neon the
game looks, for one multiply on a quarter-resolution pass — and its top two
settings also split the two widest glow levels into their colours at the skirt,
the way an anamorphic lens does. ANAMORPHIC STREAK and LENS FLARE were the
preset's and are now taste. GLOW QUALITY offers a four-tap dual filter in place
of the thirteen-tap one. DRAW DISTANCE, REFLECTION UPDATE, SHADOW DISTANCE and
PARTICLE DENSITY scale how much work each pass is given rather than switching
the pass off, which is a different trade: a pass that is off is a feature the
player has lost.

**Airborne physics.** The solver was road-locked — a car's height was the
road's elevation plus its spring travel, so there was no state in which it
could be anywhere the road was not. `Ramp` adds an arc-length window with a
height profile; wheel loads go to zero in flight, which is the whole of "no
grip in the air" because every tyre force is `mu * load * f(slip)`. Chapter 7
has a three-ramp stunt course scored on how straight the car lands.

**Level fixes.** The palms are regenerated rather than repaired — the shipped
crown matrix put the frond cluster 9.6 units sideways and 16.6 below the top of
its own trunk, and all 112 instances were pinned at a constant height against a
landscape that reaches 340 units. Chapter 6's sorting floor has a baler on all
three chutes, so the silhouette no longer answers the question the trial is
asking. Chapter 7's hazard telegraph covers the deck with one narrow slot cut
out of it, rather than two stripes on a lot of empty tarmac.

**Rival AI.** The overtaking controller committed to a side to pass on and then
released and re-armed that commitment every time the lead changed hands — which
on a route whose design keeps the cars level meant the side flipped every few
seconds and the car chased it across the road. The window is the one the race
is in now, either car order, with a slew limit as a backstop.

**Earlier.** `Scene.drawPart` caches material state; it used to upload eighteen
uniforms unconditionally on every draw, which at 792 draws a frame was about
fourteen thousand redundant GL calls. VAO binds are memoised at the GL method
itself rather than at the twenty-odd call sites, so no caller can desync the
cache. Item draws are sorted by material where blending allows it — opaque is
depth-decided and additive commutes; alpha keeps road order. Ring instances are
merged like cubes, which they never were.

## Tests

```sh
cargo test -p synx-core --release      # simulation, AI, physics, wire format
cargo test -p synx --release           # launcher, save file, platform flags
node tools/build.js --check            # static checks
node tools/build.js --smoke            # the game, in a real browser
```

## Licence

All rights reserved. Not for redistribution while the beta runs.
