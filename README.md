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
python tools/build.py            # the game
python tools/build.py --all      # ...with tests, checkers and a browser smoke run
python tools/build.py --run      # ...and launch it
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
| Boost | `B` |
| Race mode | `R` — where a chapter has awarded it; outside the campaign it restarts the run |
| Camera | `C` |
| Pause | `ESC` — and `RESTART` is on the menu behind it |
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

Four programs, on a stock Python 3. There were twenty-three and they did the
same four things twenty-three ways.

| | |
|---|---|
| `build.py` | the whole build: core → wasm → host |
| `check.py` | every check that needs no browser — thirteen of them |
| `assets.py` | the archive, the sheets, the scene and the one-shots |
| `smoke.py` | the game in headless Edge, and the three checks that need the real host |

```sh
python tools/check.py                  # all of them
python tools/check.py colour car       # or a few
python tools/check.py --list           # what there is, and what each is for
```

| `check.py` | |
|---|---|
| `shaders` | a backtick inside GLSL closes the literal it lives in |
| `dom` | every `getElementById` against the markup that has to carry it |
| `settings` | a setting that silently does nothing is invisible everywhere |
| `upscale` | the reconstruction kernel, against known inputs |
| `colour` | every map decoded once, the grade with black still in it, nothing undithered |
| `car` | no two parts of the car share a plane at the same depth |
| `protocol` | the game's and the server's copies of the wire format |
| `story` | seven chapters, both paths, both endings, without driving any |
| `ramps` | the ramp you see against the ramp you hit |
| `forge` | Aurora Forge's hall, with rays dropped through its roof deck |
| `rec` | the capture path, which must never block the frame |
| `radio` | five stations, and a panel that asks rather than knows |
| `ai` | the rival, on every route, at every difficulty |

| `assets.py` | |
|---|---|
| `pack` `unpack` `check` `list` | the asset archive |
| `shrink` | lossless PNG recompression, pixel-verified |
| `atlas` | erases atlas sprites nothing draws, and un-declares them |
| `gentex` | generates the R-IX's surface maps and the shattered-glass sheet |
| `scene` | drops geometry from `scene.bin` that no frame draws |
| `sfx` | synthesises the landing one-shots |

| `smoke.py` | |
|---|---|
| *(default)* | runs the game in headless Edge and reports what broke |
| `launcher` | drives the release binary through PLAY |
| `display` | proves the game opens on the display it was told to |
| `profile` | CPU profile of the real GPU build, by file and by function |

**What needs what.** `build.py`, `check.py`, `smoke.py` and the archive half of
`assets.py` run on a stock interpreter with nothing installed. The commands that
touch pixels or samples — `shrink`, `atlas`, `gentex`, `sfx` — want `numpy`, and
`sfx` also wants `soundfile`; each says so if it is asked to run without them.

**Why some of it is still JavaScript.** Six of the thirteen checks are about
what the game's own code *does*: the story machine over thirty simulated
minutes, the ramp table against the solver it arms, the geometry a chapter
director builds, whether the recorder's worker gives its buffers back, how the
rival drives. The only honest way to ask is to run it, so `tools/probes/probe.js`
runs under Node and **measures**, and every rule about the measurements lives
in `check.py`. A probe holds no thresholds and no pass or fail. The browser
payload under `tools/probes/page/` is JavaScript for the same reason — it
runs in the browser.

`python tools/smoke.py --set <key>=<index>,...` drives any settings row and
reports what the renderer made of it. `tools/check.py settings` proves a row is
READ; only a run proves the value reached the other side of `applySettings`,
which is the join that fails silently. `--exercise` walks every row on every tab
and reports the ones that do nothing. `--eval "<expression>"` runs one
expression immediately before `--shot`, which is how something that only exists
for three seconds gets photographed on a rasteriser drawing one frame a second.

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
python tools/assets.py unpack     # write assets-src/ out of the pack
# ...edit...
python tools/assets.py pack              # rebuild web/data/synx.pak
python tools/assets.py check      # verify every entry byte for byte
```

`python tools/assets.py shrink` re-encodes PNGs losslessly — per-row filter
search plus level-9 deflate — and decodes every result back and compares it
pixel for pixel before writing. It does not quantise, reduce bit depth or drop
channels.

## Recent work

**THE HEADLIGHT WAS THREE FAULTS, AND THE ONE THAT WAS REPORTED WAS THE SMALLEST.**
Reported: the light looks odd and sits above the bonnet. Measured off
`scene.bin` and the shipped sheets, because none of this is visible in a
screenshot as a cause:

- `HeadLightFlare` is two additive billboards, and each is **3.32 wide by 3.24
  deep by 0.74 tall** — reaching 1.5 units past a nose at z 3.35 and 1.1 past a
  flank at x 1.37, centred at y −0.22, which is the bonnet line. From any angle
  but head-on that is an additive haze lying across the front of the car and out
  into the air beside it. That was the reported fault.
- `LightFrontL` and `LightFrontR`, the quads you actually see, have **degenerate
  UVs**: all four vertices of each carry the same texture coordinate, spanning
  four ten-thousandths. The whole quad samples one texel — and the texture it
  samples, `light_front.png`, is a 1024×1024 image of one flat cream colour. So
  the car's headlamps were two plain white rectangles.
- and they were **clipped**. Measured against the tail at the same distance and
  preset, the emitters ran to a 99th-percentile luminance of 247 where the tail
  bar runs to 162 — half again as bright as anything on the back of the car,
  with no shape left in them at all.

`Lights.png` is a 256×128 atlas, and the tail lamp reads its red strip out of
it. Sitting in the same sheet, used by nothing, is a pair of **fluted headlamp
lenses with reflector detail**. So the two billboards are not deleted, they are
repurposed: their mesh is a unit quad with proper 0..1 UVs, so it is scaled to
lamp size, turned to face forward instead of lying flat, moved onto the lamps
and pointed at that lens — the right-hand one, mirrored for the left, which is
what a pair of headlamps is.

Two things had to be measured rather than guessed, and both were got wrong
first:

- **The lamp's centre is not its bounding box.** The emitter quad is tilted, so
  its box runs z 3.12..3.25 while the quad is centred at 3.170. Placing the lens
  at 3.30 put it a tenth too far forward, and because the camera looks down on
  the nose, a thing nearer the camera falls in the frame — so it rendered
  visibly *below* the lamp. It reads as a misplaced lens, not as a misplaced
  depth.
- **`gain` is not the brightness knob here.** The emissive branch is
  `albedo * emis * (1 + gain*4) * 5 * pulse`, and with a white albedo the five
  alone puts it past one: at gain zero it still comes out around three, which is
  three times clipped. The knob is `pulse`, which is exactly what the tail bar
  uses — it sits at 0.03 until the brakes come on. The lamps now measure 165 p99
  and 182 peak against the tail's 162 and 173, with nothing clipped.

The rival and the R-IX clone these parts, so they get the same lamp in their own
colour: cold blue for the rival, amber for the R-IX. The R-IX's arm used to
raise the gain to *at least* 0.9, which is the same clipping one livery over.

**AND THE RADIO WAS TOO TALL.** Three stacked rows in a 72-unit box, above a
dial 256 units across — a top-heavy pair. The panel had three hundred units of
*width* and was using 256 of them, so the level meter moved up beside the
station name and the tuner became the panel's own bottom rule instead of a row
of its own. **72 units to 48**, and the top edge came down from y −12 to −46.
It is centred on the dial now rather than sharing an edge with it.

The fifth station is `neon_pursuit` — **NEON PURSUIT** — because every other
name on the dial is two words and one entry twice as long as the rest reads as
a mistake.

**TWENTY-THREE PROGRAMS BECAME FOUR, AND ALL OF THEM PYTHON.** `tools/` had a
build script, thirteen checkers, six asset tools and a 5,400-line browser
harness, and between them they had thirteen ways of printing the same three
lines. The build could only tell them apart by exit code.

It is `build.py`, `check.py`, `assets.py` and `smoke.py` now, and the
consolidation is the point rather than the language: one report format, one
place every threshold lives, one `--list` that says what there is.

Two things did **not** move, and both for the same reason. Six of the checks
are about what the game's own JavaScript *does* — a Python reimplementation of
the story machine would pass happily while the real one was broken — so they
keep a probe under `tools/probes/` that runs the shipped code under Node and
writes down numbers, and every rule about those numbers is in `check.py`. The
harness's browser payload is JavaScript because it runs in the browser; it came
out of a 250 KB template literal into files an editor can highlight.

Everything was verified against the program it replaces rather than against
itself:

- the Python packer rebuilds `synx.pak` **byte for byte identical** to the one
  the JavaScript built;
- the PNG codec decodes all four filter types to the **same SHA-256** as the old
  one on every sheet in the tree, including a 4096×2048 one, and re-encodes
  0.42 MB smaller with the pixels unchanged;
- `gentex --force` regenerates all four generated sheets **pixel-identical**,
  which took finding two things the metrics could not tell me: the height fields
  are `Float32Array` on the JavaScript side, and `Math.hypot` is not
  `sqrt(a²+b²+c²)`;
- every check prints the same findings and the same numbers as its predecessor —
  the Forge's worst deck disagreement is still 0.080u at s=128842, the car's
  nine coincident part pairs are still the same nine at the same percentages.

The car check got faster on the way: it compared every triangle of one part
against every triangle of the other, which is four million pairs for the shell
against the lining. Bucketing centroids at the distance the inner loop was
already rejecting on takes it to about a second.

**THE RADIO HAD NO FACE.** Five full-length songs, an environment-aware
selector that cross-fades when the country under the car changes family, a
no-immediate-repeat rule — and nothing anywhere told the player any of it was
happening. There was no way to know what was playing, or that the music had
just changed because the scenery had.

There is a panel above the speedometer now, on the dial's own centre line and
to the dial's own width, so the two read as one instrument stack. It shows the
station, the title, eleven bars of the music's **own** spectrum from an analyser
on the music bus, and an FM dial with a tick per station and a needle on the one
that is playing. A chapter with a fixed score gets amber instead of cyan, its
route's name instead of a station, INTERNAL FEED instead of a frequency, and a
progress bar instead of a tuner — because it is not on the air, it is the
building you are driving through.

**AND EVERY PIECE OF MUSIC HAS A NAME NOW**, chosen from the recording rather
than from the filename. Each track was measured in a scratch venv — key by
chroma against the Krumhansl-Kessler profiles, tempo by autocorrelating a
spectral-flux onset envelope under a log-normal prior, brightness by spectral
centroid, and how alike its first and last six seconds are — and the notes
beside each entry in `js/audio.js` are those numbers, so a title can be argued
with rather than believed.

| | | |
|---|---|---|
| NEON OVERTURE | the title screen | A minor, 98 BPM, centroid 3536 Hz — half its energy above 2.5 kHz, the brightest thing in the pack |
| BETWEEN LIGHTS | conversations | D major, 145 BPM, and the only music here that never returns to where it started |
| FORGE CYCLE | Chapter 6 | A minor at 174 BPM — a machine tempo — and the widest stereo image in the game |
| REDLINE | Chapter 7 | A minor, 97 BPM, the *narrowest* image at 0.36 and the most weight in the mids |
| COASTLINE DRIVE | 90.1 | D major, 97 BPM, and it builds: the first thirty seconds sit at half the level of the rest |
| CANYON VELOCITY | 94.5 | A minor at 148 BPM, the fastest thing in the pack by fifty beats |
| ELECTRIC HORIZON | 101.7 | C major, 97 BPM, 19% of its energy above 6 kHz — the airiest of the five |
| MIDNIGHT CIRCUIT | 104.3 | F major, 92 BPM, and the most dynamic thing here at 17.5 dB of crest |
| NEON PURSUIT | 107.9 | **new** — F major at 97 BPM, so it shares a key with MIDNIGHT CIRCUIT and a tempo with the coast and the mesa |

The new station is filed with the night and the city on those two measurements
rather than on its name. It carries more bass than anything else on the dial —
21% below 150 Hz — and it is the best loop in the pack at 0.84, which matters,
because a Free Roam tour is a hundred and twenty-seven kilometres and can
outlast the playlist. Its fader sits at 1.05 against everything else's 1.25,
because its master is 1.7 dB hotter and a station that is audibly louder than
the one before it is the one thing a radio must not be.

`python tools/check.py radio` guards the four ways this goes wrong silently: a
file that is not in the pack (the element 404s, the mixer marks it broken, and
the station simply never comes on), two stations on one frequency, a frequency
outside the dial the panel draws, and an environment left with one usable song —
which makes the no-immediate-repeat rule unsatisfiable. It also fails if the
panel ever grows a copy of the table, or if the analyser gets connected onward
and mixes the music in twice.

**107.9 CAME OUT AS 07.9.** Measured off the alpha of `Digital_Italic.png`
rather than off its metrics table, because the table cannot say this: every
digit advances 43 units and every digit's ink is about 53 wide, so consecutive
glyphs overlap by ten. That is deliberate — the face is italic and an italic
seven-segment display leans the top of one digit over the bottom of the next —
and on the nine wide glyphs it is invisible. `1` has twenty-four units of ink,
hard against the right of its cell, so the same ten units of lean cover nine of
them, and what they cover is the only stroke the glyph has.

`digits()` takes an optional tracking now, and only the frequency passes one.
The shipped readouts are left exactly as they are: they sit inside boxes the
original interface sized for a monospaced run, and widening every one of them
would be a restyle wearing a bug fix's clothes. It is worth knowing that the lap
clock does this too, from the moment it passes one minute.

**THE CAR CLIMBED RAMPS WITHOUT TILTING.** The solver measured the ramp's slope
on every frame a car was on the structure, published it as `air_pitch` — and
then applied it **only inside the airborne branch**. On the ramp itself nothing
read it. The car rose with the surface and stayed dead level while it did, so
the bonnet drove into the slope. Six degrees on a coastal kicker; eighteen on
the blocked bore, which is the whole front of the car inside the ramp.

`pitch` could not simply be added to — it is the suspension's own state,
integrated from `pitch_v` and clamped to a tenth of a radian, less than half of
what the steepest ramp asks for — so the ramp has a field of its own and the
renderer adds the three: the suspension, the road's slope, and the structure
laid on it. `cargo test the_body_tilts_with_the_ramp` proves the solver sets
it; `checkramps` proves the renderer still adds it, and fails on any call site
that composes an orientation by hand.

The body is also **sat** on the ramp now rather than balanced on a point of it:
the profile is sampled across the whole car and the pose is the one that leaves
nothing under the surface. On a launch kicker that is worth six thousandths of
a unit and on the deck ramps rather more — the first version of this was my
guess at the bug, and the test I wrote for it passed on the unfixed code, which
is how the real cause got found.

**A JUMP ENDS IN A NOISE NOW.** `tools/mksfx.py` synthesises three takes of a
car coming back down — the tyre slap, the springs taking the weight, the scrub
as they find grip, and the shell settling after it — the same way every other
sound in this game is made, so nothing has to be licensed. A big drop is louder
and pitched down; a scruffy landing gets more of the scrub, because landing
sideways is supposed to sound worse than landing straight. The drop and the
quality are the solver's own numbers, the same ones the boost award and the
replay mark read.

**THE R-IX'S BACK END WAS THREE SLABS FLOATING BEHIND IT.** Measured off the
kit's own draw calls — the car is the rival, and getting a camera on it is most
of a day — against a tail at z −2.63: the wing reached −2.90, the diffuser
−3.14, the nozzles −2.85. Three full-width horizontal plates stacked in the air
behind the car, none of them touching it. From behind that is not a wing and a
diffuser, it is **two wings with a gap between them**, which is how it was
reported.

The exhausts were worse. A 0.317 ring at x 0.56 spans 0.24 to 0.88 and there
were diffuser strakes at 0.24 and 0.72 — the outer one *entirely inside* the
nozzle. And `ringHousing`, the shroud that makes an exhaust read as a hole in
something rather than a ring stuck on the back, was built in the constructor
and **never drawn once**.

So: the diffuser is pulled in under the car, the strakes moved into the
channels the nozzles leave between them, and the exhaust is three concentric
parts at three depths — shroud proud of the tail, ring recessed inside it, core
burning at the bottom of the bore. The wing is a real bi-plane with a slot and
endplates that close it, instead of one plane with a chrome bar buried inside
its chord doing nothing. Plus fender louvres, a second canard, wake vanes and
sill blades — the silhouette is what a chase camera actually sees, and for a
whole chapter it was a dark saloon with a wing on it.

**THE WINDOW LINING WAS A STICKER, AND STICKERS Z-FIGHT.** The trim around the
glass flickered against the paint outside it and the moulding inside it,
permanently, forty centimetres from the player's eye in the driving seat.

It is not a separate object. Measured off `scene.bin`: **506 of `TRIM_LINES`'s
718 triangles share a plane with the chassis to six decimal places**, and 130
share one with the interior. `TRIM` is 73% coincident with the chassis, 72%
with the interior and 73% with the side glass; `CAP` is 100% coincident with
the chassis. Seven parts occupying the same millimetre. Two surfaces at the
same depth have no correct answer — the rasteriser keeps whichever wins a
floating-point comparison, and the winner changes when the camera moves by a
thousandth of a unit.

A depth-buffer offset per part fixes it without touching a vertex, and
`python tools/check.py car` keeps it fixed: it measures the plane gaps the way the
bug was found and fails if any two parts that share a plane also share an
offset. It found `CAP` and `INTERIOR` on its first run, both of which I had
missed by eye.

**AND THE CABIN WAS LIT LIKE A BONNET.** The car carries a fill rig — a
synthetic key so the bodywork reads against a dark road — and it was being
applied to the inside of the cabin as enthusiastically as to the wings. The
first two attempts at this attenuated the sky ambient and the image-based
lighting and changed nothing, which is how the rig was found: with the
enclosure taken to zero the dash was still the same lavender. It sits at 39%
of the road's luminance now against 54% before. A room lit from outside has no
inside, and the binnacle and console had nothing to be brighter than.

The generated cockpit gained the things a cabin is actually made of — a
defroster along the cowl, a recessed screen, seams down the dash, a mirror on
the header, a five-point harness, a shifter, switchgear and door furniture.
The first placement put four vents on the dash's front face, which from that
seat cannot be seen at all: the top slab overhangs it completely.

**`R` COULD THROW AWAY A THIRTY-KILOMETRE RUN.** It is two keys wearing one hat
— RACE MODE where a chapter has awarded it, RESTART everywhere else — and
chapters one to five never award it, so in five of the seven the only thing it
could do was destroy an attempt that was going well. It sits one row above the
arrow keys. The restart half is off inside a chapter now; the pause menu still
has RESTART on it, and the start card stops promising one when the key will not
give it.

**AND THE BOOST METER NAMED THE WRONG KEY.** It said `SHIFT`. Boost has been
`B` for as long as the CONTROLS screen has existed, so the one place in the
game that tells a player which key to press was telling them the wrong one.
It reads the live binding now, as the CONTROLS rows do — so it is also right
for anybody who rebinds it. The README's table had the same error.

**THE FREE-ROAM WHITE OVERLAY WAS THE ASCENSION GATE, FIRED BY A CAR THAT NEVER
ARRIVED.** The air goes white and the fog closes as the tour crosses into NEON
HORIZON, and it is keyed on distance alone — but the last region's edge *is*
the gate, both at 132,000, so a tour that starts in the last region starts with
the car standing inside the boundary. Measured: the black point never fell
below `(77, 91, 104)` and the first-percentile luminance sat at 101 of 255 for
the whole run. It is `(1, 0, 2)` and 24 now.

**AND THE INTERFACE ENTERED TWO DIFFERENT WAYS.** A race with lights fades the
instruments up to a ghost while the countdown runs and reveals from there; a
race without lights — every chapter hands control straight into `racing`, and
so does a rewind — started its reveal *at* the ghost, putting the whole HUD on
screen at a quarter opacity in one frame. Same animation, two openings. The
free-roam handover card had the matching problem: the speedometer, the boost
meter and the rival readout stepped back for it and the clock, the DRIVETRAIN
scope, the flags and the record did not, because the dimming was threaded
through some draws and not others. It is one `destination-in` pass over the
finished cluster now, so nothing has to remember to opt in.

**THE SPEEDOMETER INTRO WAS LAID OUT TWICE.** The dial, its ring and the outro
stamp were positioned off the instrument; the wordmark, caption, rail and count
off the frame. Those agree at one aspect ratio. On a 2:1 window the stamp
landed at y=564 and the rail sat at y=565 — SYSTEMS NOMINAL printed straight
through the progress bar, with the caption of the same name a row above it. The
block is stacked from the bottom of the bezel in units of the dial's own radius
now, and the dial is height-limited a little tighter so the four lines under it
have somewhere to go. The tachometer also read `x1000 r/min` directly under a
four-digit readout of the actual crank speed — nine million revs a minute. The
multiplier belongs to the numerals on the scale, and now sits with them.

**THE PICTURE WAS NOT COLOUR-MANAGED, AND THE GRADE HAD NO BLACK IN IT.**
Measured over the world band of a night frame on NEON HORIZON: the blue
channel never once fell below 29 of 255, and **not one pixel in the frame was
within ten per cent of neutral** — no asphalt, no concrete, no sky. A route lit
entirely by neon whose every shadow is a lilac has nothing for the neon to be
brighter *than*.

Four things, three of them objectively wrong rather than a matter of taste.

**THE DECODE HAPPENED AFTER THE FILTERING.** Every colour map was uploaded as
plain `RGBA` and decoded with `pow(c, 2.2)` in the shader — on the value that
came *out* of the sampler. Bilinear taps and mip levels are averages, averaging
is linear arithmetic, and doing it to gamma-encoded bytes and decoding
afterwards is not the same answer. It is always too **dark**, because
`pow(x, 2.2)` is convex, and it compounds once per level. The decode lives in
the texture unit now — an sRGB internal format, which the hardware applies to
each texel *before* it filters — chosen per texture by whether the map is a
picture or data, and behind a capability probe, because `generateMipmap` on
sRGB has been refused by drivers for years.

**AND THE SKY WAS THE WORST PLACE FOR IT.** Its mip chain is not decoration:
`skyIrradiance` averages five taps of the *blurriest* level to stand in for
integrating the hemisphere, and every rough surface reads a high mip for its
reflection. Those levels are averages of averages, built out of gamma-encoded
bytes, each one landing further under the truth — so ambient light arrived too
dark and the scene ended up lit almost entirely by its own neon, taking that
neon's colour everywhere. That is most of what "unrealistic" meant.

**THE SPLIT TONE WAS A FLOOR, NOT A TINT.** `col * highs + shadows * (1 - col)`
returns the offset itself at `col = 0`, so `shadows` was the darkest colour the
game could produce anywhere. It multiplies now, weighted by where the pixel
sits on the ramp — the violet shadows and cyan highlights are still exactly
what this route is, but as a tint applied *to* the picture rather than a wash
laid *over* it. Each tint is also divided by its own luminance, because a tint
that is not normalised is an exposure change wearing a hue's clothes: the first
version had a luminance of 0.87, applied over most of the frame, and on the
storm route — where the whole picture sits under the shadow weight — it quietly
took a quarter of the highlight range off.

**AND THE SATURATION PUSH IS MEASURED.** Boosting chroma the obvious way drives
the weakest channel of a strongly tinted pixel below zero, and the clamp turns
that into a black hole with the wrong hue; the old code knew, and backed the
number down to hide it, which costs the colour everywhere to protect a few
pixels. The push now works out how far *this* pixel can go before its weakest
channel reaches zero and takes whichever is smaller. Hue and luminance are
preserved exactly and nothing clips to black.

Plus a **triangular-PDF dither of one least-significant bit** at both
quantisation points. Everything after the tonemapper is eight bits, a night sky
is a shallow gradient with about forty steps to cross the frame in, and the film
grain was covering the contouring — so turning grain off turned banding on.

Measured on the same frame afterwards: the road went from **0.0% to 3.9%**
near-neutral and its blue cast fell by a sixth; the black point reaches 0 again;
the storm route got its highlights back (99th percentile 84 → 100).

`python tools/check.py colour` keeps it that way. It reads the loader's *rule*
rather than a copy of its answer — the naming convention, the explicit list and
the shipped material table — and checks all forty texture bindings against it,
then checks that the grade still multiplies rather than lifts, that both tints
are luminance-neutral, that the saturation push is still headroom-limited, and
that nothing reaches eight bits undithered. It found four normal maps the first
hand-written list had missed, which is exactly the failure it exists for: an
sRGB-decoded normal map does not look broken, it looks like the lighting is
slightly wrong on one part.

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
says it has a car. `tools/check.py forge` samples a whole baler cycle and fails
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

`python tools/check.py rec` is the other half, and it exists because the parts
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
one. They share `tools/synx/png.py` now, which also means `gentex`'s generated
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

**And the checker could not see it.** `tools/check.py story` walks the whole
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

**`tools/check.py forge`** builds the hall for real through a GL stub and drops
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
80% smaller. `tools/assets.py atlas` derives the live set from `js/hud.js` rather
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
python tools/build.py --check            # static checks
python tools/build.py --smoke            # the game, in a real browser
```

## Licence

All rights reserved. Not for redistribution while the beta runs.
