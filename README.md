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
