# SYNX Synthwave eXtreme racing

A neon sunset racer in the browser. WebGL2, no plugins, no build step.

A **160,000-unit** road, cut into seven routes, raced against a rival car
that drives the same physics you do. Those seven routes are also a
seven-chapter campaign — see **Story Mode** below. The original four routes are preserved exactly.
It starts on a coastal highway at dusk and the new fifth route carries Midnight City
through a shattered sunrise into an ash-choked volcanic inferno, by way of a walled canyon and a mesa under open
sky: barrier walls capped with neon, chevron rails, turn boards on every
corner, lit gantries overhead, ten tunnels, a skyline, and a sun sitting on the
horizon 48 km down the road. Everything is lit and composited in linear HDR, so
the neon actually glows instead of clipping to white - and the base under it
stays dark, because overexposure is not the same thing as light.

The car leaves twin neon trails off its tail lamps, burns tyre marks into the
road through a slide, and sits in a pool of its own underglow. The slide is a
controlled quantity: SPACE engages it, the wheel sets how deep, and it holds
where it is put.

## Multiplayer

Up to four cars, on any of the seven routes, over a link to a small Rust
server. It is the middle card behind START, between Story Mode and Free Roam,
and it is **not** gated on the campaign — finishing the story is what earns the
open road, but racing somebody else is a mode rather than a reward.

The netcode is Rust on both ends:

| | |
|---|---|
| `crates/synx-net` | the wire format — the byte layout, the quantisation, the proof of work, and the compile-time fingerprint the two halves check against each other. |
| `crates/synx-core/src/net.rs` | the client half: clock sync, an adaptive jitter buffer, Hermite interpolation, constant-turn-rate dead reckoning and error smoothing. Runs in WebAssembly; no per-frame allocation. |
| `web/js/net.js` | identity, waking, the handshake, the socket, the send tick. |
| `web/js/multiplayer.js` | the lobby screen and the race. |

A remote player is an ordinary `NR.Vehicle` that is never stepped: its pose is
written each frame by the interpolator, so the renderer, the headlight rig, the
tyre smoke and the collision resolver all work on it unchanged.

Point the game at a server from the lobby's **SERVER…** row, or with
`window.SYNX_SERVER`. The default is the public grid.

### Two repositories that agree without being one

The server is deployed from a repository of its own and the two meet only at a
URL. Each carries its own copy of the wire format — `crates/synx-net` here,
`protocol/` there — so **this repository builds on its own**, with no sibling
checkout to arrange.

What replaces the shared crate is a check rather than a convention.
`WIRE_FINGERPRINT` is a compile-time digest of the format's own shape: every
opcode, field width, flag bit and quantisation scale, folded together by a
`const fn`. Because it is derived from the constants instead of maintained
beside them, it cannot drift from the code it describes — change a scale
factor and the fingerprint changes in the same edit. The client sends it before
it sends a car, and a mismatch is refused with *update the game* rather than
discovered later as a vehicle sliding through a barrier at the wrong scale.

To work on both at once, clone the server in beside the game; the checkout is
gitignored.

```bash
git clone <game> SYNX && cd SYNX
git clone <server> synx-server     # optional, for working on both
```

### What the server checks, and what it does not

SYNX is open source and so is its server: clone it, run it, point the game at
it. That decides the shape of the front door, because there is no such thing as
"the official client" when anybody can build one — and a check that cannot
establish what it claims is worse than no check, since it makes a log look
reassuring while proving nothing.

So the door asks two questions, both of which it can actually answer:

- **Do we agree on the wire?** `WIRE_FINGERPRINT` is a compile-time digest of
  the format's own shape — every opcode, field width and quantisation scale —
  derived from the constants rather than maintained beside them. A build that
  would misread a byte is turned away with "update the game" rather than
  admitted to a race it would experience as cars sliding through barriers.
- **Where is this page from?** A browser sets `Origin` and will not let a
  script change it, so this stops another *website* adopting a server as free
  infrastructure. It is enforced on the WebSocket upgrade as well as the API,
  because CORS does not cover sockets. Against a native process it proves
  nothing, and nothing here pretends otherwise.

What actually keeps a public grid standing does not care which client is
talking: the physics validator (a hand-written client still cannot teleport or
outrun the envelope, and collects strikes when it tries), the registration
proof of work, the per-address rate limits and connection caps.

## Run it

```bash
python -m http.server 8000
# open http://localhost:8000
```

Needs a real HTTP server — the scene is loaded with `fetch`, which browsers
block on `file://`. Requires WebGL2.

The game boots straight to the title screen in a window. **It never takes
fullscreen on its own** — that is `F`, and only `F`. It used to grab the whole
screen on the first click or key press anywhere on the page, which fires while
you are still reading the title card, re-lays the canvas out mid-frame, and
leaves `ESC` (the pause key) as the only way back out.

## Controls

| Action | Keyboard | Controller |
| --- | --- | --- |
| Gas / Brake | `UP` / `DOWN` | `RT` / `LT` (analogue) |
| Steer | `LEFT` / `RIGHT` | left stick (analogue) |
| **Drift** | hold `SPACE` and steer into the corner | hold `B` or `LB` and steer |
| Boost | `B` | `A` or `RB` |
| Race mode / restart | `R` | `X` |
| Pause | `ESC` | `START` |
| Menus | arrows, `ENTER`, `ESC` | d-pad or stick, `A`, `B` |
| Fullscreen | `F` | — |

`SPACE` is a drift button, not a handbrake — see **The drift** below. How far
the wheel is turned sets how deep a slide it asks for, and steering back out of
the corner unwinds it; there is no opposite lock to find.

Reverse is deliberately awkward: it only engages after the brake has been held
at a standstill for a third of a second, so nothing you do at speed can flip
the car into it — and the start line is a hard wall, because there is no level
behind it.

### The controller

A pad is picked up the moment it is touched, and it drives **everything** —
not just the car. The menus, the mode terminal, the Story hub, the multiplayer
lobby and every dialogue answer to it, because the pad does not talk to any of
those screens: it synthesises the key each one already reads and dispatches it
on `window`, where all six of the game's keyboard listeners live. One bridge,
and anything added later gets controller support without knowing a controller
exists. It is suppressed while driving — the d-pad would otherwise arrive as
the arrow keys, which are the throttle — and during a rebind, where a nudged
stick would bind an arrow key to the handbrake.

Steering, throttle and braking are **analogue**: the stick's travel is put
through a deadzone that is rescaled rather than merely subtracted (so a large
deadzone does not cost you full lock) and then through a response curve that
spends more of the stick on small corrections. Both are settings, because the
right deadzone is a property of the pad in your hands rather than of the game.

The layout is fixed rather than rebindable. The standard mapping already tells
every player which button is which, a rebind screen for fifteen buttons is a
screen, and a pad whose face buttons had been swapped would make the diagram on
the CONTROLS page a lie. The keyboard is where rebinding lives.

**`CONTROLS` → `GAMEPAD` draws your controller, live.** Every stick moves,
every button lights, both triggers fill as they are squeezed. It is vector art
rather than a photograph for three reasons, and the third is the one that
matters: a bitmap would not stay sharp on a canvas that supersamples to twice
native, a photographed lump of grey plastic would look like a screenshot of a
different program — and a picture is dead. The question in a player's head on
that page is never "what does B do", it is "why is nothing happening", and a
drifting stick is visible there in a way no amount of labelling could describe.

## The renderer
## The renderer

The scene renders to a linear HDR buffer with a sampleable depth target and a
packed normal/roughness target, then runs a chain of passes over it.

| Stage | What it does |
| --- | --- |
| Scene | GGX specular, hemisphere ambient, image-based sky lighting, two projected headlights, sRGB decoded on sample, written unclamped to RGBA16F |
| Reflections | the sky cubemap, mipmapped and sampled by roughness — a cheap prefiltered environment map. This is what makes the bodywork read as metal: it reflects the actual sunset, horizon band and violet zenith |
| Screen-space reflections | a world-space march against the depth buffer, resolved with a separable blur. The road is damp all night and wetter under the tunnels, so it reflects the rails, the signage and the sunset |
| Headlights | two real spot cones with a hot inner angle, a soft cut-off, dip and toe-out, and inverse-square falloff. See **Lights** below |
| Taillights | a red source behind the tail panel that brightens with the brake pedal, washing the road behind the car and any barrier it is alongside |
| Ambient occlusion | world-space hemisphere sampling against the depth and normal targets, twelve taps on a rotated Vogel spiral, resolved with a separable blur and masked by luminance so it darkens ambient rather than neon |
| Clearcoat | a second, much sharper specular lobe over the car paint that does not take the base coat's colour - the difference between bodywork and bare metal |
| Aerial perspective | distance scatters the frame toward the sky colour in the view direction, on a squared ramp so the road under the car stays sharp while the far side of the level dissolves into the horizon |
| Sky | the shipped cubemap, plus a twinkling star field on a cell grid above the haze band, a three-lobe sun glow and a wash along the horizon |
| Volumetrics | 28-step raymarch against the depth buffer, Henyey-Greenstein forward scattering, fbm-modulated ground haze, dithered and then resolved, thickened inside tunnels, and lit by the headlight beams |
| God rays | a sky-only occlusion buffer radially blurred toward the sun, so the terrain and palms genuinely cut the shafts |
| Bloom | a six-level mip pyramid (13-tap Karis downsample, tent upsample) with the widest levels stretched sideways for an anamorphic streak |
| Neon weighting | the bloom prefilter scales by saturation, so coloured light blooms far wider than white highlights — a neon glow rather than generic over-exposure |
| Lens flare | ghosts sampled from the bloom buffer mirrored through the centre, plus a halo on the sun itself |
| Depth of field | a quarter-res blurred copy the composite fades toward past 320 units, so only the far field softens |
| Composite | ACES tonemap, violet-shadow / cyan-highlight grade, S-curve, saturation lift, radial speed blur, chromatic aberration, vignette, scanlines, grain |
| Temporal anti-aliasing | the projection is jittered a fraction of a pixel per frame on a Halton sequence and the history is reprojected through last frame's view-projection, clamped to the current pixel's neighbourhood. See **Resolving the image** below |
| Contact shadows | a soft ellipse pressed into the road under each car, darkening the ambient and the reflection. There is no single light to cast a shadow map from at night; what grounds a car is the sky and the neon being blocked by the body above the tarmac, which is an occlusion |
| Sharpen | contrast-adaptive, applied after the temporal resolve, with the grain and scanlines last so nothing averages them away |
| FXAA | a spatial fallback on the settings that do not run the temporal resolve |
| Particles | tyre smoke, barrier sparks, boost flame and speed dust, as additive camera-facing quads in one dynamic buffer |
| Neon trails | twin ribbons off the tail lamps, billboarded about their own length so they read as glowing tubes from any angle, plus the tyre marks a slide burns flat into the road. See **Trails** below |
| Everyone else's lamps | the same spot cones, for the other cars on the road. The shader knew about one pair of headlights - the player's - so a rival ten units up the road at midnight drove with two painted-on emissive rectangles and threw no light at all. The three nearest the camera get real beams and a tail source; each lamp arrives with its axis already dipped and toed on the CPU, and past its range the whole evaluation is a subtract, a dot and a compare |
| Drivers | somebody is in the car. The shipped model has a cabin, two seats, a dashboard and glass, and nothing sitting in any of it - so at every angle that sees through the windscreen, and in every cinematic the story director frames on a car, what is on screen is an empty shell being steered by nobody. Helmet, visor, shoulders, torso, both arms and the wheel they are holding, placed against the measured cabin, drawn with the car's own model matrix so they lean with the chassis, and given a livery per car so the rival is not the player in a different seat. The wheel turns with the rack |
| Road wheels | they turn. The car ships four wheels as twelve instances - a tyre and two rim faces per corner - each with a fixed placement matrix, and every one of them used to be drawn with that matrix and nothing else, so the wheels were welded solid at every speed. At eighty units a second a 0.45-unit wheel is turning about 178 rad/s, and the one part of a car whose motion the eye is actually calibrated for being motionless is most of why a car under power read as a prop being slid along the road. Each corner now turns about its own axle and the front pair steer with the **rack** rather than with the driver's hands, which are a different angle whenever the car is countersteering. The two axles carry separate angles, because they genuinely differ: the fronts lock under braking while the rears still turn, and the rears light up under power while the fronts only roll. A car the simulation does not step - a remote player in multiplayer, whose pose is written by the interpolator and whose solver state never advances - is detected and integrated from its speed instead, so it is not the only car on the grid with four welded wheels |
| The body light | a key light that exists only while the cars are drawn. At night there is no key light and both headlights point away from the car, so every term in the shader is correct and the answer is still a silhouette. See **Lighting a car at night** below |
| Underglow | a neon pool under each car, brightening on the brakes and swelling through a slide |
| Speed streaks | the bloom buffer smeared radially, so only what is already glowing draws itself past the lens — with the middle of the frame left alone, because that is where the player is looking |

### Lights

The headlights are real spot cones: an axis aimed a few degrees down and toed
out toward its own side, a hot inner angle, a soft outer cut-off and
inverse-square falloff. Measuring the angle to that axis is what makes the pool
an ellipse stretching away from the car and fading at its rim - the shape
headlights actually throw. The two cones overlap into one bright core near the
bumper and spread apart down the road, which is why the verges get lit as well
as the lane. A dipped beam also has a cut-off: it stops far more sharply above
the axis than below it, so the light stays on the road.

The same cone lights the volumetric march, so the shaft in the air and the pool
on the tarmac are one light rather than two guesses. The shipped beam texture,
`assets/textures/headlights.png`, rides on top of that as a radial profile: it
is a rendering of a real beam, and its internal structure is what stops the
shaft in fog looking like a smooth analytic wedge. It is at its best in the
tunnels.

One detail there is not obvious and cost a rendering session. The incidence
term cannot be the usual `dot(N, toLight)`: a lamp 0.8 units above a flat road
meets that road at a grazing angle, so thirty units out the cosine is already
under 0.02. That is physically true and useless. The beam axis carries the
incidence instead, with some of the real direction mixed in so walls and the
sides of objects still turn toward the light.

The taillights are a red source behind the tail panel. It brightens with the
brake pedal - and only with the pedal, since the engine braking of a lifted
throttle is not something a brake lamp knows about - and the car's own lamp
materials brighten with it. On the brakes, the red channel behind the car more
than doubles.

### Lighting a car at night

At night on an unlit road there is no key light. The sky is the light, the sky
is nearly black, and both headlights point *away* from the car. Every term in
the shader is doing its job correctly and the answer is still a silhouette:
measured from the chase camera, the bodywork came out **darker than the tarmac
it was standing on**. You could find the car only by its tail lamps.

Two things were wrong and one thing was missing.

- **Car paint is not a metal.** It shipped at 0.85 metalness, and a metal has
  no diffuse term at all — everything it shows you is a reflection of its
  surroundings. What car paint actually is: a metallic *flake* suspended in a
  coloured binder, under a clear lacquer. The flake scatters rather than
  mirrors, the binder is a dielectric and keeps its colour under any light, and
  the lacquer is a second, much sharper specular lobe on top — which the
  clearcoat term already models. The body runs at a quarter metalness with a
  full clear coat now; the rims, exhaust and grille stay at one, because those
  really are metal.
- **The paint had no colour to keep.** 26 % grey is a reflectance of 0.055 in
  linear terms. It is a deep violet pearl now, with a little emission of its
  own — which is not a cheat, it is what a candy coat over a metallic base does
  under neon: the flake catches light from every direction at once and the
  panel glows rather than reflecting a single highlight.
- **The hero car carries its own lighting rig.** Every racing game does this
  and none of them mention it. A fill over the camera's shoulder, so the panel
  facing the player is always the lit one, with a wrap term that keeps the
  shadow side off black and a tight lobe that puts a highlight down the
  shoulder line. It is tinted toward the route's own neon, so a car on the
  coast road and a car in the city are lit by the places they are in. It is not
  physical. It is the difference between a car and a hole in the picture.

### Trails

The trail is not a speed effect bolted on: it is *where the tail lamps have
been*, so it draws the line the car actually took — which is what makes a drift
legible from behind. It thickens and turns with the slide, goes white-blue on
reheat, and hardens on the brakes.

- **Billboarded about its own length.** The strip is offset along
  `cross(tangent, toCamera)`, so it keeps its width whatever angle it is seen
  from and reads as a tube rather than as a ribbon that vanishes edge-on. A
  trail curling away round a corner is at a different angle to the camera at
  each end of it, so the direction to the lens is computed per node rather than
  once per frame.
- **Nodes are dropped by distance, not by time.** A car at 200 km/h and a car
  at 40 km/h then lay down the same shape, and the trail does not bunch into a
  bright knot every time the player lifts off.
- **The newest node is a tip that rides with the car**, so the trail stays
  welded to the bumper — and the distance test is against the last *anchored*
  node rather than against the tip. Measuring against the tip is measuring
  against something that moves with you: at 146 km/h the car covers 0.92 units
  a frame against a step of 1.1, the gap never once accumulated, no node was
  ever anchored, and the single tip aged out and took the whole trail with it.
  The player's trail was one dot; the rival's, sampled at a different speed,
  was nine.
- **A neon tube is not a gradient.** It is a very hot, very narrow core with a
  wide soft halo around it, and the ratio between the two is what separates
  *glowing* from *bright*: a linear falloff across the strip gives a flat bar,
  because after the tonemap the whole width clips to white together. Two lobes,
  one at a high power for the filament and one at a low power for the air
  around it, is what the bloom picks up as a coloured glow. Driven any harder,
  a red trail tonemaps to a white one — which is what the first version was.
- **Tyre marks are not billboarded.** They lie flat in the ground plane,
  because a mark burned into the road is a flat thing. Only a real slide burns
  one: not braking, and not being shoved into a wall.

### Resolving the image

The last thing between this and something that looks like a PC release was that
thin bright geometry crawled. The edge lines, the chevron rails and the tunnel
rings are one or two pixels wide against a dark road, and no spatial filter
fixes a one-pixel line that is a *slightly different* one-pixel line next
frame - FXAA can only guess from the pixels it has.

So the projection is jittered by a fraction of a pixel each frame on a
Halton(2,3) sequence, and the previous frame is reprojected through last
frame's view-projection using this frame's depth. Camera motion is therefore
exact, and over eight frames the renderer samples the whole pixel instead of
the same point in it. The history is clamped to the range the current pixel's
neighbourhood actually spans, which is what stops the cars smearing: history
the clamp had to fight is rejected rather than blended. A contrast-adaptive
sharpen afterwards puts back the bite the resolve costs.

Measured on a still frame with a static camera: **98 % fewer hard one-pixel
steps**, with mean brightness unchanged (59.97 to 59.93).

Two things that cost time and are worth writing down:

- **A texture unit left bound is a feedback loop waiting to happen.** The
  temporal pass bound the scene's depth texture to unit 2 and left it there.
  Unit 2 is where the scene shader's normal map lives, so the *next* frame's
  scene pass had an active sampler pointing at an attachment of the very
  framebuffer it was drawing into. Every frame after the first raised
  `INVALID_OPERATION`, reported by a draw call in a different file from the one
  that caused it. The post chain now keeps its depth on a unit the scene pass
  never touches, and every unit is released at the end of the frame.
- **A one-frame capture cannot see a temporal effect.** The harness draws
  several frames before capturing when the resolve is on, which is also how the
  feedback loop was found at all: it only appeared from frame one onward.

`tools/harness/frame.html?trace=gl` reports which pass raises a GL error, by
name and by frame, and the shader compiler's own message is now carried into
the exception rather than left in a console nobody can read headlessly.

## Level repairs

The level ships with faults that are invisible in the data and obvious on
screen. These are corrected at load time in `js/scene.js`, and every one has a
test in `tools/selftest.js`.

- **The right-hand guidance rail pointed backwards.** It shipped with its UVs
  rotated 180 degrees: the along-road coordinate negated *and* the
  cross-section listed bottom-to-top instead of top-to-bottom. The chevron
  sheet points toward `+u`, so on that rail every arrow pointed back at the
  driver. Mirroring both axes lines it up with the left rail, which was right.

- **Every tunnel mouth was a hole in the ground.** The neon portal was a
  two-sample ribbon hugging the bore, and `applyPalette` re-tinted it to 0.9 of
  the route's own cap colour with no gain at all. On Route 3 - violet cap, five
  kilometres of fog - you can just see it. On Routes 4 and 5, whose caps are
  blue-white and violet against seventeen hundred units of fog, the ring came
  out *dimmer than the lit concrete shell it was drawn over*, so the mouth was
  a pale dome with no arch on it. A tunnel mouth is a structure now, and the
  same one on all eighteen of them: a founded headwall with the bore cut
  radially out of it, a thick ring standing proud of the opening with a
  face-on band so it reads as a tube head-on, a hazard height-marker under the
  crown, and a lit sign board over the top with floodlights washing it. The
  portal still takes the route's hue - it just gets a floor under every channel,
  because the one job it has is being visible from half a kilometre back.

- **Every roadside billboard pointed somewhere else.** Measured against the
  road they stand beside, the four shipped boards faced 76, 54, 70 and 40
  degrees *across* the carriageway: all four were a bright edge on the approach
  and a picture for about a tenth of a second as you went past. Nothing was
  wrong with them when they were authored; the clusters have been slid sideways
  to clear a corridor that has since been squeezed, and nothing ever rotated
  them, so each one kept the heading the road had where it was placed. They are
  turned about their own poles to face oncoming traffic with a twenty-degree
  cant toward the road, and the whole cluster - pole, base, frame, sign, lip and
  the row of lamp notches - turns together.

- **The tunnel facades were drawn in front of the tunnels.** The level ships
  four `sunset_tunnel_ent` slabs — pale concrete several times wider than the
  bore — and they are composited over the generated neon portal, so Routes 1
  and 2 were the only two tunnels on the course with no arch lining on them:
  a grey wall with a hole in it, where every other tunnel has a lit ring you
  can aim at from half a kilometre back. Two of the four never stood at a mouth
  at all — one is buried mid-bore on Route 1, one sits a hundred and thirty
  units off the side of the road on Route 2 — which is what a loose object
  looks like when nobody has driven past it. All four are dropped.

- **The finish line stood in the middle of Route 2.** The level ships exactly
  one start/finish structure — two founded towers, a lit beam, three video
  screens and a chequered line painted across the road — and it stands at
  22.6 km. So Chapter 2 drove through a finish line, past its footings and out
  the other side with nine kilometres still to go, and the campaign's finale
  ended on a generated arch. It is moved as one rigid cluster to where the
  campaign actually ends, and fitted to the road it now stands on: NEON
  HORIZON's driving half-width is 30, so the two towers are translated outward
  until their inner faces clear it and the pieces that span the road are
  stretched laterally to meet them. Nothing is scaled vertically, so it keeps
  its own proportions instead of becoming a monument.

- **An overhead billboard had nothing holding it up.** Route 2's sign hangs
  over the mouth of a tunnel and its cluster never shipped a `bill_pole_base`:
  the pole starts twenty-two units in the air, so a fifty-metre screen floats
  above the portal on a stick. `fixupInstances` records any sign it finds in
  that state and the dressing builds the thing that carries it — two founded
  legs outside the barrier, a box truss across at the sign's own underside,
  diagonals into the corners, a maintenance walkway and floodlights washing the
  face, which is how a sign bridge is put together and reads as one at speed.

- **Three billboards were planted in the middle of the road.** Billboards ship
  as loose parts — pole, base, frame, sign and a row of notches — with no
  parent to move them by, and three of the six clusters had their pole inside
  the driving line. Parts are grouped by the pole they belong to and the whole
  cluster is slid sideways until the pole clears the barrier, which keeps each
  sign square to the road instead of scattering its pieces. The overhead gantry
  over the second tunnel mouth is left alone: its pole is above the traffic
  envelope, which is what a gantry is.

- **The road was a runway.** It shipped 90 units wide. Everything else in the
  game is SI - the car is 2.2 wide on a 3.7 m wheelbase - so that is a
  forty-car-wide expanse with no line to hold and barriers that are never in
  shot. The road surface, both guidance rails and both tunnel shells are
  squeezed to 40 at load time by finding each vertex's offset across the
  centreline and scaling it, and everything that hugs the road - the finish
  gantry, its line, the tunnel mouths - is brought in and scaled with it. What
  is further out is scenery and stays where it is.

- **The tunnels were a dark blue mask.** The shell is an opaque arc textured
  with a 2 %-grey bitmap and drawn unlit, so entering a tunnel filled the upper
  half of the frame with a flat dark slab. It is lit as real concrete now, and
  narrowing the road fixed its proportions for free: the same 19-unit arc over
  a 40-unit span is a proper bore rather than a lid. Inside, generated strip
  lights run the springline and a ring crosses every 42 units. The concrete
  facades that used to stand at each mouth - pale slabs several times wider
  than the bore, and the reason a tunnel read as a wall you were about to drive
  into - are gone, replaced by a neon portal arch that matches the opening.

- **The race ended four kilometres past the finish line.** The finish gantry
  stands at 22.6 km but the shipped centreline runs on to 26.9, and the rules
  ended the race at the end of the data. Each route carries its own finish
  arc-length now, with a lit gantry generated across the road at it.

- **You could reverse off the start line into the void.** Holding the brake
  flipped straight into reverse the instant the car stopped, and there is no
  level behind the line. Reverse now has to be asked for, and the start line is
  a wall.

- **There was nothing beside the road.** No barrier, no verge, just tarmac
  ending and terrain starting. A wall now runs down each shoulder with a neon
  cap along the top and the chevron rails standing on it, which masks the
  terrain beyond, gives the corners a silhouette to read against and gives the
  headlights something to sweep. A chevron turn board goes up on the outside of
  every real corner, placed from the centreline's own curvature rather than by
  hand, so the bends announce themselves from far enough back to lift off for.

- **A duplicated billboard cluster z-fought at the finish.** Two coincident
  sign quads, flickering against each other every frame. One is gone.

- **The world ended four kilometres before the road did.** The shipped terrain
  covers x -6260..2000, z -500..12234 — which is most of the shipped course and
  none of the rest of it. Past that the road ran between two hard black
  horizons with nothing beyond them. There is ground everywhere now, and a
  landscape wherever the shipped mesh does not already own it; the ridge
  amplitude fades to nothing inside the shipped mesh's footprint, so the two
  never grow out of each other.

- **The cockpit console was never drawn.** It belonged to the camera rig and
  sat inside the near plane; `js/hud.js` draws the same console in 2D. The
  geometry and its four textures are out of the build.

## The course

The original ships **one** track. `level2` is the only scene in the build with
track data in it — `TrackManager`, `TrackSpline`, `TrackSection-HIGHWAY`,
`TrackSection-TUNNEL` and the `Track1`/`Track2`/`Track3` pieces are all in there
and nowhere else. `level0` is the boot scene, `level1` the title, and `level3`
and `level4` are UI scenes carrying five and twelve strings between them.

That track is 26.9 km long, and 26.9 km cut four ways is four five-kilometre
sprints — ninety seconds each. A corner sequence, not a route.

So the road does not stop where the data does. `js/track.js` takes the shipped
centreline and **carries it on**. The original deterministic pass still ends at 80,000
units; Level 5 continues from that exact endpoint with a second deterministic pass to
112,000 units, so extending the course cannot reshape Routes 1-4:

- **Pieces, not noise.** Everything a course is made of is a constant curvature
  held for a length — a straight is curvature zero, a sweep is a long one at a
  big radius, a hairpin is a short one at a small radius. Building it all from
  one primitive is what lets the generator try a piece, measure it and throw it
  away with no special cases.
- **It cannot run into itself.** A uniform grid of every sample laid so far
  answers *is anything here* in constant time, and a piece whose trace comes
  within three hundred units of road it built kilometres ago is simply not
  used. Without that, the barriers interpenetrate and — much worse —
  `Track.project` cannot tell which of the two roads under the car is the one
  it is on. Measured on the shipped seed: **452 units** between the closest
  independent passes.
- **It opens outward.** A generator that picks each corner independently
  performs a random walk, and a random walk comes back: after forty kilometres
  it is threading between stretches of its own road, every candidate fails, and
  the course stops. Measured, it stopped at 58 km of the 80 asked for. A small
  constant curvature added to every piece turns the walk into a very slowly
  opening spiral whose radius grows faster than the road is wide — a
  five-kilometre radius, far too gentle to feel under a corner sequence built
  on top of it.
- **The seed is chosen, not arbitrary.** Two thirds of seeds run out of room
  somewhere in the fifties of kilometres. `0x5DD24D` lays the whole eighty,
  keeps 452 units between passes, and never asks for a corner under 184 units
  of radius. It is fixed, so the course is the same road for every player and
  for every test.

Nothing downstream knows or cares which half is which. The barriers, the neon,
the racing line, the speed profile, the scenery and the levels are all built
from the centreline.

## Routes

Seven of them. There is **no arcade route list**: the level picker and the
difficulty picker that used to sit behind START are gone. A route is entered
either by a **chapter** — `Game.enterRoute(level, diff)`, called by Story Mode
and by the capture harnesses — or by a **Free Roam** tour, which does not enter
a route at all and instead drives the whole course through every one of them in
turn. Each route is a long stretch of that course, and each is mostly a single
**zone** — the road changes country as it goes, and a zone owns the shape of
the ground, how close the walls come in, and whether there is a skyline out
there.

| # | Route | | | |
| --- | --- | --- | --- | --- |
| 01 | SUNSET MILE | 9.5 km | the coast road, wide and fast | cyan and magenta, sun still up |
| 02 | NEON CANYON | 13.9 km | walled in, both shipped tunnels | amber edges, cold blue caps |
| 03 | ELECTRIC MESA | 16.1 km | terraces, towers, nothing but sky | teal and violet, thin clear air |
| 04 | MIDNIGHT CITY | 19.0 km | the long way in, under the skyline | steel and deep blue, wettest road |
| 05 | ASHFALL ZERO | 23.2 km | midnight city -> broken city -> volcanic inferno | 3 interactive cinematic set pieces |
| 06 | AURORA FORGE | 14.1 km | a live production hall, closed course | six trials, a car crusher, `raceMode` |
| 07 | NEON HORIZON | 30.0 km | nine districts of Aurora's impossible high city | Skybreak, Ryker's trap run, the R-IX |

Those are real distances — world units are 0.733 m each. The first routes are
short sprints; the 30 km finale is deliberately a long-form race with local
checkpoints before and after its set pieces.

### Level 5 — ASHFALL ZERO

Level 5 is additive. `js/level5.js` wakes only for route index 4; Levels 1-4
keep the normal SYNX race flow. The old micro-cut system has been removed. ASHFALL
ZERO now contains only three large set pieces, and the first two are interactive:

- **RUN THE COLLAPSE — 6 s / 50 hits.** Mash Q to build enough speed to clear a
  falling tower. The final seconds intensify the shake, debris and impact clock.
  A win branches into a three-second escape shot while the building detonates
  behind the car; the destructive hinge remains spatially locked until the car
  is clear. A loss shows the structure landing on the car, reveals `FATALITY` at
  impact, then rewinds the race to the run-up before the tunnel.
- **ERUPTION GAUNTLET — ~20 s.** At the instant this begins, the midnight skybox
  and stars are bypassed and an ember-and-soot sky takes over. Random fiery
  projectiles arc toward the road while a falling W/A/S/D sequence controls real
  vehicle movement: W boosts, A/D cut laterally and S brakes short. A wrong or
  missed input lands the fireball, shows FATALITY and restarts the checkpoint.
- **HUNT//REDLINE — final 250 m / 40 s.** The director records the live order,
  gap and speed before either car crosses the line. Ryker's unsafe override then
  closes the real distance continuously, ends in the canonical rear-quarter ram,
  and destroys his old car after it steals the result. Aurora's prize platform
  follows with the AURORA R-IX RAPTOR: a separate near-black boss-car treatment
  with active aero, vector vents, predator optics and twin momentum-drive rings.
  The race clock remains frozen throughout the cinematic.

The set-piece autopilot only exists while the QTE is active. It advances the same
Vehicle objects along the actual SYNX track and returns them to normal physics with
coherent forward velocity, so the cinematic camera never leaves the hero car behind
to show an empty stretch of road.

Visually the route starts with Midnight City's cold wet palette, pushes through a
fractured skyline while dawn turns orange, and breaks into a dedicated hell country:
jagged road shelves over molten trenches, missing rail runs, lava fissures, basalt
spires and volcanoes with glowing crater falls. City towers and street furniture stop
at the transition. The palette shift is runtime-driven rather than a screen filter:
world emissives, ground, sky, fog, ambient light, sun colour and wetness all move together.
Level 5's opening city also gets a dedicated ring of distant stepped megatowers
and cyan window grids, used only as non-collision skyline scenery.


### Level 6 — AURORA FORGE

A live production hall, and the only route that is a closed course rather than
a road. `js/level6.js` layers six trials over the normal Vehicle, Driver,
camera and renderer; nothing here creates a second driving model.

| # | Trial | What it is |
| --- | --- | --- |
| 01 | **LIGHTNING CRASH** | Arc walls rise across the hall a tenth of a second after the car crosses 50 m of run-up, with one gap in each. A strike inverts the steering bus for five seconds; three ends the trial |
| 02 | **COGNITION PRESS** | Aurora's line controller will not release a machinery cell to a car it has not authenticated. Three glyphs, then four, then five, flashed on the cell's own board and replayed on `1`–`4` before the ram closes |
| 03 | **SORTING FLOOR** | The hall splits into three walled chutes. One of them feeds the baler, and **nothing tells you which** |
| 04 | **SCRAP LINE** | Four stamping presses straddling the road on their own beat, and a magnet on a traverse. Pure timing; the only telegraph a press needs is that you can see it working |
| 05 | **GHOST LINE** | Three scanning arches project the lane Aurora's model says the car will cross in, onto the road, as a car-sized outline. Be somewhere else |
| 06 | **CALIBRATION** | `raceMode`: 30 seconds active, 70 to cool, and a blue reserve that refills the boost bar once it empties, at +50 % velocity — and Javas's engine rebuild, which takes the car from 132 to a 200 mph ceiling |

The car is damaged and capped at 100 km/h through the first two trials, and the
cap lifts a little each time the chapter escalates.

#### The board is not wired to anything

The sorting floor used to name the live chute four separate times — a red pip on
the gantry board, red paint down the deck, a red plate at the chute mouth, and a
toast that spelled it out — so the trial was "look up, then steer", and nobody
ever looked at the factory they were driving through.

All three chutes now carry the same amber plate and the same deck paint. The
only thing in the hall that knows is the machine: the baler works its cycle down
the live chute, in plain view of anyone who looks past the end of their bonnet,
and it is a long way down a narrow corridor at a hundred km/h. The confirmation
comes at the mouth — a strobe and the interlock going over, twenty units after
the walls have closed either side of the car — which is too late to be a
warning, and is the point of it.

#### Every trial has a way back in

A blind choice is only fair if losing it costs a retry rather than the chapter,
which is how Chapter 5 already treats its collapsing tower and its lava field. A
one-in-three guess that costs eight minutes is not a trial, it is a punishment
for having played.

The Forge keeps a rewind point at the head of every trial and in front of every
gate — each cognition press and each sorting chute has its own — and a failure
puts the car back on it. The snapshot carries the trial's **state** as well as a
place on the road: how many presses have been authenticated, which chutes are
behind you, which arches are done, how many strikes are on the board. Without
that, a rewind into the middle of Trial 02 would come back with every question
already answered. The baler uses the same road: the fatality cutscene plays in
full, and then the car is back in front of the chute it got wrong.

#### What replaced the arithmetic

Trial 02 used to ask `99 × 6 = ?`, and two more like it. That is a quiz stapled
to a racing game: it tests something the chapter is not about, it is the same
difficulty at 30 km/h as at 130, and the answer is the same answer either way.
The handshake is the thing the chapter *is* about — Aurora authenticating a
driver — it gets longer at each cell, and replaying a five-glyph sequence at a
hundred on a damaged car is exactly the split attention the trial claims to
measure. The window is sized against the road: the sequence arms 640 units out,
and watching plus replaying it always fits inside that at the chapter's cap.

#### The baler

Trial 03 is the only thing in the campaign that does not end in a retry card.
Take the chute the board marked and the infeed jaws shut behind the car, the
side rams close, the platen comes down, and what is left is ejected onto the
stack — four beats over four seconds, from three marks inside the chute,
because a chute has walls and there is no camera position outside one that can
see into it. The car is genuinely flattened rather than cut away from: a
director sets `carSquash`, and the body scales with it in its own axes. The
driver is switched off for the duration, which is the only decent thing to do
about the fact that there is now a person in that cabin.

Which chute is live moves across the hall — right, then centre, then left — so
the third one cannot be taken on muscle memory from the first two, and it is
said four times over: on the overhead line-control board, as a red carpet down
the deck, at the chute mouth, and by the baler itself running its cycle in
plain view whether or not anybody drives into it.

#### The ghost line

Trial 05 is Chapter 7's confidence model, taught early and taught physically.
The arch reads the line the player has been driving, carries it forward, and
paints the answer on the road; crossing inside it fires the clamp, and being
somewhere else takes a point off the model. It is the same sentence the whole
campaign is built on, said with geometry instead of dialogue.

#### The hall

Two things were wrong with the factory, and the second is why the first could
not be patched. Every longitudinal member — the roof deck, the wall panelling,
the crane rails, the catwalks — was **one box 176 units long, drawn once per
180-unit bay**. That leaves a four-unit slot in the roof and in both walls once
a bay, with the landscape and the night sky visible through every one of them.
And a straight box does not follow a road that is turning: AURORA FORGE opens
with ten linked corners on a 150-unit radius, where the ends of a 176-unit box
are twenty-four units off the centreline they were placed against — so the wall
behind the player swung across the carriageway and took the roof with it.

The shell is built once now, as merged geometry walked along the actual
centreline and cut into chunks the way the world dressing is. Runs are extruded
cross-sections sampled by curvature, so they bend with the road and there is no
seam in nineteen kilometres; only the things that *move* are still drawn a
piece at a time, and there are about forty of those on screen rather than three
thousand. A frame submits around thirty batches for 465 000 indices of hall.

The other half of "half open" was light. Unlit concrete fifteen units over a
hall whose only sources were a cyan strip on the floor is black, and black
overhead is sky. There is a roof over it now and you can see what holds it up:
columns on a 90-unit pitch with founded bases and haunch brackets, trusses with
a real web, purlins across them, a folded deck rising to a glazed monitor along
the ridge, high-bay lamps hanging in it, and the services a working hall carries
— extract ducting, cable tray, sprinkler main, gantry cranes with a body shell
on the hoist, weld cells under extraction hoods, stamping presses with founded
bolsters and lit control cabinets, three-level racking, coil stock and the
stairs down off the catwalks.

The crane hoist used to swing a car-shaped object across the carriageway at car
height once a bay; it hangs clear of the corridor now. The presses used to be
an invisible black housing with a bright amber slab sliding inside it, which at
night is a red block floating beside the road with nothing under it.

### Level 7 — NEON HORIZON

Aurora's own validation deck, above the city, and the campaign finale: a
**thirty-kilometre** route in nine districts.

#### The arches

Every ring on the route used to be centred low enough that the lower limb of its
own ellipse came down through the carriageway: the Data Cathedral's lintels
crossed the road at knee height and the maze gates at the deck itself, so the car
drove **through** the thing that was supposed to be spanning it and the rings
read as decals hung in the air. `archRing()` derives each one instead — lifted
until its opening clears the road by `RING_CLEAR`, and stood on two columns that
meet the ellipse exactly where it crosses the deck edge. The bore lining through
the Data Cathedral tunnel is the one ring that still sits low, because it is
buried under the slab rather than spanning it.

`tools/selftest.js` walks every ring in the built world and fails if the annulus
band at the centreline lands anywhere inside the corridor.

#### The city

The route is an elevated expressway on piers over a city grade at y = -64.
Everything that is supposed to be standing on the ground is built down to it -
the first pass placed buildings relative to the *road*, so a tower beside a
flyover rode eighteen units into the air with it and every tower on the route
had open sky underneath.

Buildings are lit the way the shipped Midnight City skyline is lit, because a
tower is two surfaces and neither one alone is a building:

- **body** — no emissive texture, so the shader's mask falls back to the albedo
  and the whole mass glows its own colour. On its own: a flat slab of colour.
- **grid** — a shell half a unit proud of the body, masked by `sunset_grid.png`.
  That sheet averages 2/255, so on its own it lights the mullions and leaves the
  glass between them dead. On its own: a wireframe.

Together they are a coloured tower with its windows picked out. Six tints, two
densities, and the shell costs vertices rather than draw calls because every
building is merged per 1,800-unit chunk before it is ever submitted.

Depth is three tiers, each offset from the one in front so no sightline runs
clean through all three — a street wall you nearly touch at 84-130 units, a
middle distance at 158-304, and two staggered horizon rows out to 790 that sit
in each other's gaps. Under all of it runs a continuous podium band either side
of the deck, because the ground beside an elevated road is the first place a
void shows through.

Gone: eight giant rings hanging in the sky, four flat ring ramps out over the
city, and a row of wireframe palms. They were the loudest "this is a dev map"
objects on the route — enormous, unfounded, and attached to nothing a player
could name. The parallel transport strata and their cross-spans, which used to
be ribbons of road hanging in mid-air, now stand on the same kind of hammerhead
bent the main deck does.

#### The wall across the road

Worth naming, because nothing catches it by reading the arithmetic. The route's
skybridges were authored as `FLOOR + 66`. That was thirty-two units over the
deck while the city grade was -34, and two units over the tarmac once the grade
moved to -64 to give the towers somewhere to stand. Every 2,860 units of a
fifty-kilometre route carried a 168-unit lit wall straight across the
carriageway, with the road disappearing behind it.

Overhead structure is now measured **up from the road**, and `Level7World`
records anything it places inside the driving corridor - 30 units either side,
from just above the surface to twelve up - by name. `selftest.js` asserts that
list is empty.

#### The set pieces

Dormant is a **waiting** state, not a scenery state: on a Free Roam tour the
wrecking balls and their masts, the oil, the drop barriers and the phantoms are
all sitting on a road where nothing will ever arm them, so they come off. The
retracting deck panels stay — a dormant one of those *is* the glass floor over
the Skybreak span, and taking it away leaves a hole in the road.


Three verbs, and they are the same three in all three events. The first pass
fielded six different mechanics — retracting glass, a swinging mass, oil, spike
beds, dropping barriers, and a "false route" that failed the player for being
in a lane indistinguishable from the safe one — and every one of them ended in
the same full checkpoint rewind. Six rules is not a set piece, it is a quiz.

| Verb | Is | Costs |
| --- | --- | --- |
| **AVOID** | a solid object: the wrecking mass, the barrier drop | a heavy hit - speed, spin, and a point of confidence to the R-IX. The race carries on |
| **SLIDE** | oil film | grip, for a few seconds. No failure |
| **FALL** | the glass span retracting | the only rewind on the route, and only where there genuinely is no road underneath |

Every one telegraphs identically: a red hatched carpet down the lane to leave,
a cyan one down the lane to take, and chevrons between them, all laid on the
road far enough ahead to be read at speed — plus a live line on the HUD naming
the verb, the mechanic, the direction and the distance in metres, held there
from the moment the hazard arms until it is behind the car. The banner used to
fire once, four hundred units out, and fade after two seconds; after that the
player was looking at two coloured stripes with no way of knowing which of the
five mechanics they belonged to.

Three of these did not do what they showed, which is worse than any of them
being unfair:

- **The wrecking mass swings**, and only the renderer knew. It was drawn at
  `lane + sin(age × 2.4) × 8` and collided against `lane`, so the object on
  screen and the object being hit were up to eight units apart — a quarter of
  the carriageway. You could drive under the mass and be counted clear, or go
  round it and be hit by it. There is one lane now, written once and read by
  the draw, the collision and the telegraph.
- **The glass panel** was drawn at -16, 0 or +16 depending on which side of the
  road its lane was, while the fall is scored against the lane itself. For
  every panel but the middle one those are five and a half units apart: the
  hole in the road was not where the road opened.
- **A hazard the player outran did not exist.** The promotion to `active` only
  happens while they are still approaching, and only an active hazard is ever
  triggered, so at high speed a frame could step from "too far to arm" to
  "already past it" and the trap silently did not happen.

The wrecking mass and the barrier also carry a beacon now. Bare gunmetal
against wet tarmac at night is the same colour as the road it is hanging over,
so the object the whole set piece is about was the last thing in the frame the
player could see.

#### The sensor gates

The nine arches through PREDATOR MAZE were nine decorations. Each one now hangs
a curtain of light across the deck with one authored gap cut in it — the Forge's
arc walls transplanted onto a road being crossed at a hundred and thirty. It
arms 190 units out so it can be read, the gap is marked on the tarmac in front
of it, and taking the light rather than the gap costs the **steering** for
three quarters of a second, which on this deck is the whole of the next corner.
It buys the model a point of certainty, because being where it expected you is
what certainty is. The gaps are authored, not random, so a retry is a retry of
the same maze.

#### The trap run

For the first half of the route Ryker is not racing for position, he is
herding. Every trap in DEAD AHEAD is one he drops in *front* of himself, and a
trap the player has already driven past is a cutscene rather than a hazard. So
while it runs he asks for a third more terminal speed than usual, spends his
reserve, and says so on the channel; the objective line reads `SURVIVE THE TRAP
RUN` until the last oil film is behind them, and then `THE ROAD AHEAD IS OPEN`.

There was a hard floor on the gap here — twenty-six units the R-IX would not
give up — and it is gone, because it was the worst thing in the chapter.
Holding a car's arc length every frame overrides the physics that is supposed
to be driving it: the steering still runs, the position does not answer it, and
the lateral offset the clamp preserves walks outward until the car is scraping
a barrier. It did exactly what it said and read as a tow rope. If a player is
genuinely better than the trap run they get past it, which is the difference
between a boss and a barrier.

#### The R-IX

**Confidence is a lever, not a switch.** The first pass took the driver away
with the prediction: at zero confidence the R-IX reacted in a quarter of a
second and drove at four fifths of its own skill — slower than Nova — so a
player who drove unpredictably did not merely stop being predicted, they
stopped being followed, and a thirty-kilometre finale was decided in its first
ninety seconds. What confidence moves between now is *a full HARD driver* and
*something past the top of the ladder*. Every axis still gets worse without it;
none of them gets worse than the hardest driver the game otherwise has.

**And a ceiling that can close a lead.** `PRED_TOP` was 118 units a second
against a rebuilt player car that tops out at **122** — the boss could not
catch a synchronised player by arithmetic, never mind by driving, so the gap
did not stabilise, it grew. The ceiling now lifts with the pursuit (+46 by 300 m
back) and again once the lead is genuinely lost (+34 more between 500 m and
1.2 km), and drops straight back the moment the R-IX is the one in front. It
buys a chase and never a lead it did not drive for.

**One number, not five timers.** There used to be a *counter-attack*: once the
player had held the lead for 3.4 seconds the R-IX spent a scripted 11-second
burst worth a quarter more pace and fifty units of extra ceiling, then sat in a
17-second cooldown where nothing could provoke him at all. Beside it sat a
second burst answering raceMode, on its own timer and its own cooldown.

Two overlapping state machines, five timers, and a boss whose behaviour
depended on which of them happened to be running — so the same overtake
produced a savage answer, a mild one, or none, and none of it was legible from
the driving seat. Worse, being inside a cooldown made him **passive at exactly
the moment the player had just taken the lead**, which is the opposite of a
predator.

Both are gone. `pressure` is a single scalar: it rises while the player is in
front, faster the further in front they are, and bleeds off only once the R-IX
is genuinely clear again. Everything he does is a continuous function of it,
and it is a *term in the hunt curve* rather than a mode bolted beside it — so
there is no state in which two systems disagree about how fast he should be
going. He answers on the frame he is passed, and he keeps answering for as long
as he is behind.

It is sized so the counterplay stays the counterplay, and the numbers are
asserted rather than felt (`--probe predator`):

| | units/s |
|---|---|
| his ceiling, unprovoked | 118.0 |
| his ceiling, fully provoked | 129.0 |
| player, Forge engine | 95.9 |
| player, engine + boost | 100.3 |
| player, sync window | 132.9 |

Boost does not shake him off — 100 against 129 is a car that arrives back on
your gearbox. The sync window does, by about four units a second, which over a
window is the hundred metres the chapter's notes always claimed it was worth.
The build fails if either inequality stops holding.

**And a leak that made him look broken.** `driver.laneHint` is an *absolute
lateral* a director lends the shared driver so its car can see hardware the
track does not know about — Chapter 6's live walls, its saws, its sorting
chutes. Chapter 6 cleared it in its own teardown and **nothing else ever did**,
so any route into another chapter that skipped that teardown left the Forge's
lane function installed. Chapter 7's R-IX then asked it where to be and got
Chapter 6's answers: gate gaps, and the ±13 to ±14 that keeps a car clear of a
saw. Those are at the edge of the road, and they switch on and off as the
lookahead sweeps track positions belonging to a different chapter — so the boss
drove from one edge of the circuit to the other and back, over and over, while
making perfectly ordinary forward progress. Every frame of it was "clean".

It is returned in `Driver.reset` now, which every race start already calls, and
`--probe director` fails the build if anything survives one.



It is its own car. `RaptorKit` used to reskin the player's coupe and stack boxes
on it, which is the opposite of what the chapter is about — and the reveal
camera framed a grey slab with neon stickers. The body is a **lofted shell**
now: a closed section with a shoulder in it, resampled through a Catmull-Rom
and swept through thirteen stations, with the normals averaged across every
seam. That is the whole difference between a slab and a shape — the tumblehome
in the glasshouse and the haunch over the wheels are the section, not the
panels.

It is authored around the donor car's own axles — front 1.83, rear −1.88, 0.48
of tyre, contact patch at −1.05 — so the wheels it borrows sit *in* its arches
rather than near them, and the arch stations put their widest point at tyre-top
height so the wheels stand proud of the bodywork the way a hypercar's do. Over
that: a deep pearl with a clearcoat lobe that does not take the base colour
(which is what puts the sky and the neon on the shoulder line), an exposed
carbon floor under the paint line, a tinted canopy as its own shell, a swan-neck
wing with endplates, a diffuser with fins, mirrors, and a red C-line running
from the roof rail down into the side intake. The same car is what Chapter 7
races.

Every other car on the Grid, the player's included, charges a reserve and spends
it. The prototype does not: **synchronised drive is its idle state**, which is
the whole reason Chapter 6 exists and the reason plain boost barely dents it
here. Its reserve never empties and it runs a permanent raceMode envelope.

It also drives on its own personality — the sixth in `js/ai.js`, and the only
one that is not a person. Chapter 3's Nova is the benchmark: a full HARD driver,
a tenth of a second of reaction, and the discipline to refuse an input on a car
that is not settled. She is a very good driver. This is not a driver.

| | Nova, Chapter 3 | R-IX at 100 % | R-IX at 0 % |
| --- | --- | --- | --- |
| Reaction | 0.10 s | **0.05 s** | 0.24 s |
| Slide | 0.70 of committed slides held | **1.00** | 0.74 |
| Tyre | 0.95 of it | **0.985** | 0.88 |
| Mistakes | none | none | none |
| Dynamic balancing | ±0.06 of skill | **none** | none |

Nova declines to rotate a car that does not need rotating; the prototype
rotates everything, because it is not managing risk, it is minimising a lap
time it has already computed. Nova lifts when the chassis is loaded; this does
not. Nova overtakes when a gap appears; this **shuts the gap the player is
moving toward before they reach it**, because two samples of their lateral is a
velocity and a velocity is a place they will be.

None of that is where the boss lives, though. The lever that makes a driver
quick is the pace it asks for, and the hunt is one function of the gap:

- **a ceiling** — and this is the one that matters most. The prototype used to
  reach 123 units a second, which is *past* the player's own synchronised cap of
  120.8: nothing the player owns could out-run it in a straight line, so the one
  counter the chapter hands them did not work. It tops out at 104 — above a
  boosting player, comfortably under raceMode — which is what makes boost feel
  like a nudge and raceMode feel like an answer;
- **almost no thrust** — squaring the wanted speed gave it 2.4× a stock car's
  drive, and at the speed a corner exit happens at that is not a faster car, it
  is a car with no rear grip. It gets a third more torque at full hunt and no
  more; everything else is a target the driver aims at or an injection clamped
  to what the corner allows, neither of which can break traction;
- **base** — it is always quicker than the player's ordinary pace, so sitting
  still is never an option;
- **hunt** — the further ahead the player gets, the harder it comes back. A
  lead it has decided to close, closes: the first pass closed one at about
  eight units a second, which over the twelve seconds a raceMode window is
  worth is a tenth of the lead, and the harness measured exactly that — nought
  per cent taken back. It is a predator or it is a difficulty slider;
- **match** — the player's ordinary boost is answered exactly, which is why a
  full burn buys about ten metres and no more;
- **give** — the player's raceMode is the one thing it cannot answer, and that
  window is deliberately worth about sixty metres rather than five hundred. It
  answers it *late and partly*, with a sync burst of its own worth about a
  third of the window on a long cooldown, because something that cannot be
  answered at all is something a player spends on a timer rather than at a
  moment;
- **ease** — and it genuinely backs off when it is the one out in front. A ten
  per cent give-up over nine hundred metres is not easing off, it is running
  away: at a kilometre and a half ahead the old model still asked for 1.24 of a
  stock car's terminal speed, so a player who lost the opening exchange never
  saw the R-IX again and the finale was decided in its first minute.

Everything above scales with confidence, which is read off the player's own
driving and sampled every 110 units of road. Repeating a line feeds it; varying
the line, sliding the car, feinting the speed, switching sides and spending
raceMode starve it. Reading a projection in the Predator Maze instead of
driving into it takes eleven points off it in one go. Driven end to end by a
harness, that is a thirty-kilometre race decided by about two hundred metres.

And Ryker talks. The taunt is not on a timer — it fires when the player has
actually spent two full seconds of boost and the gap has not moved, which is
the exact moment the lesson lands, and never more than about twice a minute.
Spending raceMode shuts him up, because that is the answer.

### What is out there

The shipped level has terrain over x -6260..2000, z -500..12234 and nothing
else, so the last four kilometres of the shipped course and every kilometre
past it ran along a road with a hard black horizon a hundred metres to either
side. `buildLandscape()` fills that in: a verge everywhere, and a landscape
wherever the shipped mesh does not already own the ground, from one strip of
cross-sections laid every hundred and twenty units.

| Zone | Ground |
| --- | --- |
| Coast | dunes and a distant hill line, under the shipped palms |
| Canyon | walls that close in over the barrier — the road is a slot |
| Mesa | terraces with flat tops at discrete heights, cut by canyons |
| City | flat ground under a skyline of lit curtain-wall towers |
| Ruins | fractured tower silhouettes and broken urban terrain as daylight arrives |
| Volcanic | ash-country, glowing lava seams and giant cratered volcano silhouettes |

On top of that, everywhere: a lit post every ninety units, a neon gantry across
the road every four hundred and thirty, a chevron board on the outside of every
real corner, and a finish gantry at the end of each route.

Two things make a course this long affordable.

**Chunks.** Every batch is cut into two-kilometre pieces tagged with the
stretch of road it covers, and a frame draws the few the camera can see. The
whole world is 334 000 indices in 394 chunks; a frame submits **17 000 to
45 000 of them, in 16 to 42 draw calls** — five to fourteen per cent.

**Decimation.** A barrier does not need a vertex every six units. The emitter
lays a cross-section down when it has either travelled far enough or turned far
enough, so straights cost a quarter of what corners do and nothing looks any
different.

**Unlocking.** Route 1 is open at all three difficulties. Every route after it
offers exactly the difficulties you have already beaten the rival at on the one
before: win on EASY and the next route opens on EASY only; win on MEDIUM and it
opens EASY and MEDIUM; HARD opens all three. Progress lives in `localStorage`
and the route list shows the length of each road, which settings it offers, and
which you have already taken.


## Story Mode

`START` opens the **driver terminal** (below), and the first of its two cards
opens the campaign. It is a director sitting above the game rather than a
second game: `js/story.js` owns the save, the cast, the
seven chapters and the shot language, and Vehicle, Driver, camera, renderer,
route and race-result authority all stay exactly where they were.

### The spine

Aurora Motorworks is finishing an autonomous chassis, the **R-IX**, on telemetry
harvested off every illegal run on the SYNX Grid. The model cannot close,
because it has never been able to predict one driver.

| # | Chapter | Route | Rival | What it turns on |
| --- | --- | --- | --- | --- |
| 01 | FIRST BLOOD | VECTOR RUN | Ryker | The Grid's number one is bored. Beating him puts an Aurora relay on your telemetry |
| 02 | NO BRAKES | THE SPINE | Kael | Kael races the gaps between the routes because the routes are recorded. He is right |
| 03 | QUEEN OF NEON | MIRAGE CIRCUIT | Nova | Aurora's former test driver names the R-IX programme, and what the last of its data is for |
| 04 | THE GOLDEN RUN | SUNSET ZERO | four cars | The Midnight Invitational is a casting call and every entrant knows it |
| 05 | ASHFALL ZERO | ASHFALL ZERO | Ryker | The Exhibition. Ryker takes the line, the prototype and the seat — and tells you why |
| 06 | BROKEN CIRCUIT | AURORA FORGE | Javas | The engineer who designed the driver link runs you through a live factory. `raceMode` |
| 07 | PREDATOR | NEON HORIZON | the R-IX | Aurora's own test deck, against a machine wearing your rival |

Chapter 5 is a **canonical loss** — the 40-second `HUNT//REDLINE` set piece is
the ending of that chapter, not a retry state. It used to simply take the
result away with no explanation attached; the epilogue now gives it one, which
is what turns the whole campaign from a ladder into an arc.

Every other chapter can be lost and retried, and the post-race dialogue is
written per outcome: the margin at the line is bucketed into five categories
(photo / close / landslide / dominant / clap) and each rival has their own line
for each, plus a separate acknowledgement if you arrived having hit four walls.

### The shot language

Cutscene cameras used to be a switch over four names that pointed at `g.rival`
whenever it could not identify a speaker. On any chapter where the speaker had
no car in the scene — the network relay, the Aurora broadcast, Nova and Kael
during Chapter 5's two-car Exhibition — that meant every one of their lines was
framed on Ryker's bonnet.

A shot tag now selects a **relationship**, not a car, and the relationship is
resolved per line from three facts: who is speaking, whether that speaker has a
body on the road, and who they are speaking to.

| Tag | Frames |
| --- | --- |
| `player` / `closeup` | the player, or a tight three-quarter on the speaker |
| `rival` | the speaker's own car — and if they have no car, a reaction on the player, never a borrowed close-up |
| `over` | over the listener's shoulder onto the speaker |
| `two` | both cars from the flank, framed off how far apart they are |
| `low` / `wheel` / `rear` | nose-level, wheel-level and chase framings on the speaker |
| `road` | down the route, from just off the racing line |
| `sky` | a broadcast crane — where every disembodied voice goes |

`CAST[speaker].body` is what enforces it: `null` means the character is a voice
on a channel and can never be given somebody else's car. The self-test asserts
that no disembodied speaker resolves to a vehicle.

**Every mark is measured from the road, and every mark has to land inside the
world.** Those are two separate rules and both of them were broken.

A mark is authored as an offset — so many units up, so many to the side, so far
behind. That is only a mark if the thing it is measured from is the road, and
the height was measured from sea level. On the flat districts the two are the
same number, so it survived six chapters. Chapter 7's route is not flat: it
climbs onto plateaus twenty-six units up and drops through a trench eight down,
and a `wide` shot authored at "thirteen units up" put the lens thirteen units
*under* a deck that was twenty-six in the air — inside the piers, filming the
underside of the level. Height is now `road.y + h`.

The side offset had no bound at all. The establishing crane stands thirty units
off the centre line; Levels 1-6 are eighteen units of road inside a barrier at
twenty. Every chapter opened on a shot taken from outside the world, looking at
the grid through a wall — and inside the Aurora Forge hall, from outside the
building. `guardEye` projects the resolved eye back onto the road and pulls it
inside the barrier, under a tunnel crown, and above the surface it is filming.
It relaxes with height, so a genuine crane a hundred and fifty units up keeps
its distance and only the marks that are *in the scenery* get moved.

And the look-at point followed the tangent: `target = p + forward * ahead`.
Three hundred units of lookahead down a four-hundred-unit-radius corner leaves
the course by more than a hundred units, so the broadcast angles framed the lot
beside the road while the cars went past behind the lens. The camera now looks
at the road sample that far along the route.

And the lens has to be **in the same room as its subject**. A `wide` mark stands
twenty-six units behind the car and a `sky` mark sixty; the routes carry tunnels
over a kilometre long with a solid headwall across the whole road at each end.
Put the car twenty units inside one and the camera is outside it, and what the
lens is looking at is masonry — a big flat unlit quad across half the frame with
the scene somewhere behind it. That is the "random black artifact" in cutscenes:
it is a tunnel portal, seen from the wrong side. A mark whose subject disagrees
with it about being in a tunnel now walks along the road toward that subject
until they agree, and stops a few units the right side of the arch.

`tools/cameratest.js` drives the real shot language over a synthetic route with
a straight, a corner, a plateau, a trench and two tunnels in it, and asserts
that not one of the 1,300-odd marks it can produce lands outside the world.

On top of the resolver, every mark carries a dolly and a little handheld, and
the camera damps toward it rather than snapping. Changing the shot key is a
**cut** — the camera teleports and the dolly clock restarts. Holding it is a
**hold** — the camera trails its (moving, dollying, breathing) mark. That is
the difference between a cutscene that reads as directed and one that reads as
a series of teleports.

### The interface

Story Mode is DOM, so the portraits stay sharp while the HDR render, bloom and
motion blur carry on underneath. It is built out of the same four primitives
the canvas HUD draws with, so the two read as one machine:

| Class | Is |
| --- | --- |
| `.synx-cut` | `hud.panel()` — corner taken out of the top-left and bottom-right, scanline wash inside, single-pixel neon edge with its own bloom |
| `.synx-tick` | `hud.brackets()` — the four corner Ls |
| `.synx-chrome` | `hud.chrome()` — the airbrushed 80s ramp, with its cut lines sized per line box so a wrapped headline gets a whole ramp on each line instead of one slice of it |
| `.synx-neon` | `hud.neon()` — wide halo, tight halo, white core |

The palette tokens live on `:root` and come straight from the constants at the
top of `js/hud.js`; there is no second palette. `--voice` carries the current
speaker's colour into the dialogue edge, nameplate, top rail, caret, voice
trace and portrait wash, so who is talking is readable before a glyph is typed.

Two structural repairs are worth naming, because both were visible in every
screenshot:

- **The portrait and the nameplate are siblings of the dialogue panel, not
  children of it.** The shell is clipped to its cut corners, and anything
  inside a clipped box that tries to break its frame is sliced off — which is
  what happened to the nameplate. Kept outside, the bust rises clear of the
  panel and the nameplate straddles its top edge.
- **The portrait frame matches the source art.** The busts are 156–244 px wide
  at roughly 2:3. Cover-cropping them into a landscape slot ate the face;
  letterboxing them into one left the speaker floating in a gutter.

### Screen budget

`js/hud.js` and the story layer share one screen. The canvas owns the top rail,
the two shoulder readouts and the whole bottom band; everything the story draws
is anchored into the two flanks between them:

| Slot | Holds |
| --- | --- |
| left flank, below the progress rail | the chapter dossier, or Chapter 6's trial card, or Chapter 7's confidence readout — one panel, swapped by the chapter director |
| left flank, mid | in-race rival banter |
| right flank, below the score | route waypoint, `raceMode` meter, R-IX meter |
| centre, above the letterbox | dialogue |

The dossier deliberately does **not** print position and gap. The canvas HUD
already draws both, and printing `2ND / 4` twice on one screen was the loudest
piece of duplication in the mode. What it shows instead is the running order
and the gap to each car, which the canvas does not have.

`tools/harness/storytest.html` asserts this: it turns on every in-race layer at
once and fails if any of them overlaps a canvas instrument band or another
layer.


## The driver terminal

The title screen is three rows: `START`, `CONTROLS` and `QUIT`. `START` is a **door**, not
a mode — behind it are two cards and one decision.

| Card | |
| --- | --- |
| STORY MODE | the campaign. Reads the save and offers to start it, continue it at the chapter you are on, or replay it |
| MULTIPLAYER | up to four cars on any of the seven routes. Deliberately **not** gated: finishing the story is what earns the open road, but racing somebody else is a mode, not a reward |
| FREE ROAM | the open route — **locked until the campaign is finished** |

That arrangement replaced two earlier ones, both of which were the same mistake
in a different place: Free Roam as a third row on the title screen, and Free
Roam as an eighth tile at the end of the Story hub's chapter grid. A mode
advertised from inside another mode is a mode in the wrong place, and having it
in both was worse. There is exactly one door now.

### The way out is a button

All three selection screens — the terminal, Free Roam and the multiplayer
lobby — used to end in a line of grey key hints, one of which said `ESC`. That
is a legend, not a control: it cannot be clicked, it cannot be tabbed to, it is
invisible to a pad, and on the terminal it was the **only** way back to the
title at all.

The footer of each is a control bar now: a real `←` button on the left, the key
hints demoted to the right where they belong. The button's label names its
actual destination and is kept in step with the `ESC` row beside it, because
two labels for one action that disagree with each other are worse than one
label. In the lobby it is wired to the same handler `ESC` is, so that one press
inside a room leaves the *room* rather than the whole link.

It is deliberately the quietest thing on any of these screens — low contrast
until hovered or focused — because it must never compete with the cards above
it. On hover the arrow moves and the button does not: a control that jumps
under the cursor is a control that gets mis-clicked.

`tools/smoke.js --hold modes|freeroam|multiplayer` exists because of this. The
three screens are ordinary DOM panels that no racing run ever opens, which is
exactly how the terminal came to ship with no way back to the title.

The lock is read off the story save, through `NR.campaignComplete()`, and not
off a `StoryManager` — the terminal is painted before a chapter has ever been
entered, and a save is the only thing that actually remembers. A sealed card
keeps a silhouette of its artwork, carries a drawn padlock, says what would
open it (`LOCKED — FINISH THE STORY (3 / 7)`), and refuses with a shake and the
impact sound rather than by doing nothing. `js/freeroam.js` re-checks the same
gate at its own door, so nothing holding a reference to that screen can walk
past it.

## Free Roam

The second card. It is the other thing the course has always been able to do
and had never been asked for: **one drive down the whole road**, from the
seawall at arc length 60 to the last gantry at 173,000 — 126.8 km, all seven
regions, no chapter, no cutscene and no loading screen between any of them, and
it is what finishing the campaign is for.

Nothing underneath had to change for that, because the seven routes were never
seven courses. They are seven stretches of one centreline, and the only thing a
route really owns is its **look**: a palette, a fog range, a sun bearing, a road
width, and — for the last two — a world of its own.

### What you drive it in

Chapter 6 rebuilds the engine and Javas hands over `raceMode` with it, and Free
Roam does not open until the campaign is finished — so on the open road both are
simply yours. `R` synchronises the drive: thirty seconds, a seventy-second
cooldown, and a blue reserve that refills once when the normal one runs dry.
Those are `js/level6.js`'s own numbers, so the ability behaves identically in
both places; what a tour does not get is the chapter's letterbox and dialogue
around it.

The rival is given the same car out of the same workshop, and then **pace rather
than a bigger engine** — a pursuit term squared so that being alongside costs
nothing, plus a small answer to the drive the player is holding, all scaled by
the difficulty chosen on the card. A rival still running the stock envelope
against a rebuilt car is not a rival, it is scenery going past more slowly.

Two flags a tour owns — `raceModeAvailable` and `blockQuickRestart` — are
cleared by both chapter directors whenever they reset, including on the frame
they are first constructed, which is a frame a tour cannot predict. Rather than
chase every one of those the run re-states what is true about itself once a
frame, in `assertFreeRoamRun()`.

### The seam

A handover is not a swap. Over the 1,250 units before each boundary (about
fourteen seconds at cruising speed) every part of the look a route owns is
interpolated into the next route's, so by the time the boundary is crossed the
picture is already the new region's and the crossing itself changes nothing that
can be seen. `Game.updateFreeRoamRegion` runs the handover and
`applyFreeRoamLook` does the blend, on the same twelve-a-second clock
`js/level5.js` moves Ashfall through its dawn on — `Scene.setPalette` walks every
dressing material, so it is not a per-frame call.

| Blended | Why it has to be |
| --- | --- |
| every palette vector — edge, cap, post, sign, ground, grid, arch, tower, fog tint, sun | the neon, the country and the key light are what make a route a place |
| sky dim, ambient, fog range, wetness | a route that is 1,350 units of fog next to one that is 3,300 is a wall of haze if it arrives at once |
| the crash barrier | routes 6 and 7 override it with powder-coated steel and the other five leave it out; naming the default is what lets it fade rather than snap |
| road half-width | Neon Horizon is a 64-unit deck and everything before it is a 40-unit road, so the corridor the barriers resolve against opens up rather than stepping |
| the sun's bearing | interpolated the short way round the compass, so two routes facing opposite ways do not spin it through 300° |

A key only one route carries is **held** rather than faded out: Ashfall's
volcanic rock and its lava exist nowhere else, and fading `lava` to black would
put the fire out halfway through a shot of it.

`tools/selftest.js` walks the whole road in 200-unit steps and fails if any one
step carries more than a fifth of a handover — a cut would carry all of it.

### The two built worlds

Aurora Forge and Neon Horizon build geometry of their own, and each gets it
exactly where it belongs and nowhere else.

* The **Forge hall** is nineteen kilometres of merged steel. It is built up
  front, under the controls card, rather than in the middle of a run, and it
  stands whenever the car is inside Aurora Forge. What does *not* come with it
  is the trial hardware — the arc gates, the chute walls, the presses, the
  magnet and the hauler belong to the test, and a closed sorting gate across the
  road with no rule behind it is just a wall.
* **Neon Horizon** culls the generated country outright, because its raised deck
  cannot coexist with ground built to the shipped landscape's shape — and that
  country is batched into 1,600-unit world tiles with no arc length on them, so
  there is no frame on which the exchange can be made and not be seen.

  Two things make it invisible anyway. Each tile is asked once which stretch of
  road is nearest to it, and only the ones the elevated route claims are
  dropped, so the country **behind** the car survives the handover instead of
  vanishing with everything else. And the boundary itself is **staged**: over
  the last 260 units visibility collapses to a fog range of 300 and the glare
  comes up with it, the exchange happens at the bottom of that, and the deck
  opens out of the light on the other side. Driving up into a bank of haze and
  coming out above a megacity is a thing that happened to you; a city appearing
  on one frame is a thing that happened to the renderer.

  The Forge hall is the same problem with an easier answer: it draws about a
  kilometre and a half up the road, so it is switched on by **where the camera
  is** rather than by which region owns it — which is also why the menu backdrop
  is the factory after Chapter 6 has been played, and was bare road before.

The region edges are the routes' own start arc lengths, with two exceptions: the
hall is generated from 112,000 and the deck from 132,000, so those two seams sit
on the geometry rather than eighty units inside it.

### What a tour is not

The chapter directors stand down. Ashfall's collapse and eruption are hung off
`g.progress`, which on a tour is progress through 126.8 km rather than through
Ashfall, so `Level5Director.isLevel5()` returns false for a tour and the route is
driven as scenery. The Forge trial and the R-IX prediction model were already
gated on a chapter being active and need no change.

A tour also keeps its own books: its own best time, written only for a **full**
tour, and no campaign progress at all — a run down the open road is not a
chapter result.

### The screen

`js/freeroam.js` owns the open-route picker and nothing else; the run lives in
`js/game.js`. The picker is built out of the same cut-corner panels, corner
ticks and Orbitron the Story hub is built from, and navigates the same way. What
it does not borrow is the hub's artwork — a region has no face to put on a card.
Each tile is painted from the route's **own palette**, read out of `Game.levels`
and tonemapped so the brightest channel normalises to 1 and the hue survives: a
tile is a swatch of the place it opens.

| | |
| --- | --- |
| GRAND TOUR | the full 126.8 km, from the seawall |
| REGION 01–07 | get on at that route and drive to the horizon from there |
| OPPONENT | `NONE` by default — this is an open route, not a duel — or the campaign's own Driver at `EASY`/`MEDIUM`/`HARD` |

While the picker is up the game is not driving: it takes the tick, flies the
idle camera down the road behind the panel, and hands `update()` back when it
closes — the same arrangement the terminal and the Story hub use.
`tools/harness/freeroamprobe.html?show=freeroam|modes&done=0..7` screenshots the
picker and both states of the terminal without a renderer behind them;
`tools/harness/freeroame2e.html` drives the shipping `index.html` through the
whole flow — the lock, the campaign that lifts it, and all six handovers taken
by actually moving the car across them.

## The rival

You are not driving alone. A second car lines up beside you and races you to
the gantry, and it is not on rails: **it drives a real `Vehicle`** - the same
class, the same tyres, the same gearbox, the same barriers - by producing the
same six inputs a player produces. Everything it does has to survive the
physics, which is why it can be out-braked, and why it can lose the back end if
it asks for too much.

`js/ai.js` follows the standard racing-AI stack:

1. **A racing line**, built once at load. The line is a lateral offset per
   centreline sample, relaxed toward minimum curvature inside a corridor: at
   each pass every point is nudged along its own lateral axis in the direction
   that straightens the path through it, then clamped back inside the road. Run
   enough times, that *is* the geometric racing line - wide in, apex, wide out -
   and it falls out without anyone having to say which way a corner goes.
2. **A speed profile** over that line. Grip-limited speed everywhere
   (`v = sqrt(a_lat / k)`), then a backward pass so every point is also slow
   enough to have braked down to whatever comes next
   (`v[i] = min(v[i], sqrt(v[i+1]^2 + 2·a·ds))`), then a forward pass so it is
   not faster than the engine could have got it there. The backward pass is what
   creates braking points: the rival lifts because a corner four hundred units
   away is not takeable at this speed, not because a trigger volume told it to.
3. **Pure-pursuit steering** to a speed-dependent lookahead point:
   `delta = atan(2·L·sin(alpha) / d)`. Stable, needs no per-corner tuning, and
   it produces the smooth entry-apex-exit arc a hand-written proportional
   controller never quite manages. Counter-steer against the body slip angle on
   top, which is what lets it hold a slide instead of spinning out of one.
4. **Tactics**: boost saved for stretches that are open far enough ahead to use
   the speed (and spent desperately when a long way behind), deliberate
   handbrake rotation where a corner is genuinely tighter than the tyres can
   carry it through, an overtaking line that picks whichever side of you has
   more road, and a recovery that reverses *aimed at the track* rather than
   flailing.
5. **Dynamic competition balancing**, bounded by difficulty. Skill is nudged
   toward a positional target relative to you; the car is never touched. A
   rival that gets its pace from a bigger engine stops feeling like a driver.


### Four ways it drove into a wall

All four are pre-existing, and all four were found by driving the finale's boss
for three hundred seconds with a harness rather than by reading the code. Two
of them are in the personality layer, which is the handful of lines that
override a controller output the rest of the driver has just spent a frame
computing:

**A throttle floor that ignores the brake.** Ryker's `throttle = max(throttle,
0.72)` runs *after* the speed controller has decided the corner ahead needs the
brake, so on the approach to anything tight he was on the throttle and the
brake at once. He has driven like that in Chapters 1, 4, 5 and 7.

**A forced handbrake on a gentle curve.** `|lagSteer| > 0.30` sounds like a
corner and is not: the lag filter's own steady state amplifies the steering it
is fed by about a third, so a quarter-turn of lock reads as more than a third.
NEON HORIZON is gently curved from end to end, so the R-IX had the handbrake
pulled for the entire route — measured, **ninety-six per cent of the finale
spent scraping a barrier at twenty-two degrees of slip**, with a quarter of the
frames under 45 units a second. That is what "it moves slowly and drives into
the left wall" is, from the inside. Rotation belongs to the drift state
machine, which is what decides whether a corner is worth a slide; the R-IX's
`driftSkill` is 1.00, so when there is one it takes it and does not get it
wrong.

**Avoidance could aim past the barrier.** `avoid` and the lane hint are both
lateral offsets from the *racing line*, and the racing line is not the centre
of the road: on a corner exit it is already against the outside edge, so adding
a full half-width of avoidance to it aims the car at a point outside the track.
On NEON HORIZON's sixty-unit deck that is a request to move twenty-five units
sideways at a hundred units a second, which is not a move, it is a spin. The
bias is now clamped in absolute lateral terms against the same corridor the
physics uses, and the avoidance offset itself is capped at three car widths —
which is what an overtake actually is.

**Beached was the only kind of trouble it recognised.** `stuck` counted a car
that had *stopped*, so a car sliding from barrier to barrier at thirty units a
second — which is exactly what a badly upset high-grip driver does — was never
recovered at all. The finale's boss did it for three minutes of a five-minute
simulation, pinned against the edge at 139 km with the throttle wide open and
its target speed still reading a hundred and five. Out of control is now also:
off the road, and going nowhere near the speed this driver has just decided it
should be doing here.

### The slide

A rival that only ever turns the wheel understeers through every corner, and
what that reads as from the other car is not a driver being careful, it is a
slower car. Every rival in the game now drifts, and a drift is a commitment
made before the corner arrives:

| | |
| --- | --- |
| `entry` | handbrake on, steering into the corner, until the rear steps out to the angle that was asked for |
| `hold` | handbrake off. The angle is held on the throttle against a counter-steer **target** rather than against zero - the whole difference between holding a drift and catching one |
| `exit` | the target is walked back to zero as the corner opens, so the car unwinds instead of snapping straight |

The gate is the corner's **radius**, not a demand figure that scales with the
driver's own grip. Gating on demand made the clumsiest car slide the most - low
grip raises the demand for the same corner - and made a fast sweeper look like a
hairpin to anyone still carrying entry speed. HARD commits below about 88 units
of radius, EASY below 62.

Difficulty decides three separate things, which is what keeps the rivals feeling
different rather than differently fast:

| | EASY | MEDIUM | HARD |
| --- | --- | --- | --- |
| corners it will slide | radius < 62 | < 74 | < 88 |
| angle it asks for | 55 % of the ceiling | 73 % | 87 % |
| **commitments that go wrong** | **31 %** | **20 %** | **10 %** |

A mistake is one of three, weighted toward the cheap end: `bail` (loses its
nerve halfway and straightens up into the understeer it was trying to avoid),
`late` (gets on the handbrake a fifth of a second too late and runs wide), or
`over` (asks for too much angle and spends the corner fighting it). A mistake
also costs the driver its composure - the next corner is taken flat rather than
compounding the error.

Two things stop this being a liability. A **spin guard** abandons any slide that
runs past the angle the car can be recovered from, so one bad commitment cannot
end a rival's race; and a slide is never a substitute for braking, so a corner
that still needs speed taking out gets the brake back and carries the angle on
trail brake instead.

It is adaptive: chasing makes a driver braver and leading makes it tidy, so the
same rival slides more corners coming back at you than defending a lead.

Measured over the 13 km reference route, with zero barrier contacts on every
setting: **EASY 236 s, MEDIUM 215 s, HARD 201 s.**

### The ladder

Four rungs, and every one of them is a **driver** rather than a car — skill,
how much of the tyre it will use, how fast it reacts, and how often it gets one
wrong. Nothing on this table touches the vehicle, which is why a rival that
beats you is a rival that drove better.

| | skill | tyre | reaction | drift | mistakes | means to be |
| --- | --- | --- | --- | --- | --- | --- |
| EASY | 0.58 | 0.80 | 0.28 s | 0.25 | 0.035/s | 55 units back |
| MEDIUM | 0.82 | 0.90 | 0.14 s | 0.58 | 0.008/s | 15 units up |
| HARD | 0.95 | 0.962 | 0.075 s | 0.80 | none | 60 units up |
| IMPOSSIBLE | 1.00 | 0.982 | 0.055 s | 0.95 | none | 140 units up |

**The skill column is the width of the ladder**, and it used to be too narrow
to feel. `skill` feeds both terms that separate two drivers on open road — the
straight-line pace they ask for, and the margin they leave under it — so a
column running 0.72 / 0.90 / 0.97 produced three difficulties that finished in
the same second. Measured over two minutes of the shipped course, the old
ladder ran **71.1 / 74.6 / 76.6** units per second, with HARD within half a per
cent of the R-IX: one difficulty with three labels on it.

Widening the column, and the two terms it feeds with it, gives
**64.9 / 71.5 / 75.8** — EASY to MEDIUM is now a tenth, MEDIUM to HARD a
sixteenth, and the whole ladder spans 17 % instead of 8 %.
`the_ladder_is_actually_a_ladder` asserts that daylight so it cannot quietly
close again.

The gaps are deliberately uneven. EASY to MEDIUM is the widest because that is
where a new player is; HARD to the R-IX is the narrowest because HARD already
asks for very nearly everything the stock car has, and the prototype's real
margin comes from its momentum drive rather than from its driver — which is why
Free Roam's top opponent gets a small slice of that envelope rather than an
impossible driver.

Two things every rung got that none of them had:

* **Boost is measured, not rolled.** The old model threw dice every frame,
  which on average put the reserve down in the wrong place — boost into a
  corner, arrive too fast, brake, hand the time straight back. It now asks how
  much open road is actually in front of the car (relative to what the car is
  already doing, not against a fixed number) and commits to the length of it,
  lifting before the corner rather than in it. A weaker driver still wastes some.
* **A tow.** Close enough behind and roughly in line, a car is running in the
  hole the one in front punched in the air: a few per cent on a straight,
  nothing through a corner. It is what makes a chase *stick* instead of
  settling into a fixed gap.

A defensive line was tried twice — cover the chaser's lateral, and move to the
side it has committed to — and both shapes are positive feedback: the leader
reads a car sitting in its own mirror, moves over, reads it again from the new
position, and walks itself into the barrier. Neither shipped.

### Difficulty

| | EASY | MEDIUM | HARD |
| --- | --- | --- | --- |
| Base skill | 0.60 | 0.80 | 0.97 |
| Tyre it will use | 72 % | 85.5 % | 95 % |
| Reaction lag | 0.34 s | 0.20 s | 0.10 s |
| Boost judgement | poor | good | optimal |
| Will rotate a corner | rarely | sometimes | often |
| Mistakes | frequent | occasional | none |
| Balancing allowance | ±0.30 | ±0.18 | ±0.06 |
| Route 4, 19.0 km | 393 s | 356 s | 335 s |

Those lap times are measured, not claimed: `selftest.js` sends each difficulty
round every route unaided and asserts that it finishes, stays on the road, and
is faster than the setting below it.

HARD deliberately does **not** run at 100 % of the tyre. A driver with no margin
for a bump, a kerb or a rival's line spends the race in the barrier, which is
slower, not faster - at 98.5 % it could not complete a lap at all. It runs where
a quick driver runs, a few percent back from the edge.

The approach follows Game AI Pro's racing-architecture and rubber-banding
chapters and the *Pure* post-mortem's skills / dynamic-competition-balancing
model. See **Sources** at the bottom.

### Javas rebuilds the engine

The chapter's own text says the player brought a damaged street coupe through a
whole production line, and then the only thing that changed was thirty seconds
of a multiplier — underneath it, the same 132 mph street block that started the
game. The engineer who designed the driver link, standing in his own factory,
now rebuilds the car, and `raceMode` and the new engine are the same gift.

`fitEngine('swap')` is three numbers on the vehicle rather than a second drive
model: the ceiling the boost and raceMode multipliers apply to (80.6 → 88 units
a second, 132 → 144 mph), a hard cap on everything at 122 (**200 mph**), and
twenty per cent more drive torque so the car reaches them rather than merely
being allowed to.

| | mph |
| --- | --- |
| Street engine | 132 |
| Rebuilt | 144 |
| Rebuilt + raceMode | 177 |
| Rebuilt + raceMode + reserve | **200** |

It is fitted at the calibration run — the first metre the player drives on it —
and it lives on the car rather than in `reset()`, so a rewind inside Chapter 6
or a checkpoint in Chapter 7 cannot un-fit an engine that was given in a
cutscene. Replaying Chapter 6 from the top starts on the street block again and
earns it in the same place.

### Ryker stops racing you and starts removing you

Everything the R-IX did was about the racing line — it shut the door on where
the player was going, it bought grip and thrust for a lead it had decided to
close, it answered raceMode with a burst of its own. None of it was about the
fact that there is another car on that line. It never touched anybody.

### It stays that way: the shoulder is gone

There was, for a while, a shoulder. Two triggers — the player putting a nose in
the R-IX's lane, or the R-IX coming past *through* them — each handing the
driver an absolute lateral to steer AT, plus an asymmetric settlement so that
the car which committed to the move was braced and the car leaned on was not.

**It has been removed entirely, along with the `ram` knob it was driven by.**
It could not be made stable, and the reason is worth recording, because the
obvious repair is the one that was already tried.

The first version wrote the overtaking controller's own state from the
personality block, a frame after that value had been consumed — two controllers
owning one number, one pulling it toward zero and the other pushing it at the
player. Giving the shoulder its own term fixed that ownership fight, and the
car still weaved, because ownership was never the fault. **The frame was.**

The shove was computed as `player_lateral − own_lateral`: a correction relative
to where the car is *now*. Every other steering term is an offset from the
racing line at the lookahead point. So the error nulled itself — aim at the
player, reach the player, the error goes to zero, so the bias goes to zero, so
the aim point snaps back to the racing line, so the car steers away, and the
error is full-sized again. A self-nulling error expressed in the wrong frame is
a limit cycle, and no damping constant removes one; it only sets the period.
That is the finale's R-IX dashing left and right across the deck instead of
racing down it, and it is why it appeared only after the two cars had been near
each other for a while.

Re-expressing it in the line's frame would have stopped the oscillation and
left a car that steers into another car on purpose, which the collision
resolver and the recovery controller then spend the rest of the race arguing
over. So the behaviour is gone rather than retuned. The R-IX is frightening
because it drives well.

The same audit found the *general* controller doing a milder version of the
same thing, and that one affected every difficulty in every mode: it chose
which side to overtake on every frame from `sign(their lateral)`, with no dead
band and no hysteresis. A car being followed anywhere near the centreline flips
that sign whenever it drifts across, so the chaser's set point snapped between
the two edges of the road. A pass is a **decision** now — the side is chosen
once, when the move starts, and held until the move is over, with separate
capture and release distances so a rival sitting on the boundary cannot toggle
it. Measured against a deliberately weaving car in front, lateral travel fell
from **27 units to 2.4**, and the driver got slightly *faster*, because it had
stopped spending energy going sideways.

And the model moved up to meet the rebuilt engine. He tops out at 118 units a
second — 193 mph — against the player's 200: he now **catches** a synchronised
player who is not also spending the reserve, and cannot live with one who is.
A rival topping out at 170 could have been walked away from in a straight line
by anybody who had finished Chapter 6, which is the opposite of what the finale
is for.

### Ryker's car is the game's car

The R-IX was hand-built twice — a box loft, then a Catmull-Rom section loft
with a glasshouse and surface-mounted trim — and both times it read as a prop
parked next to the game rather than a car in it. The reason is structural, not
a number that needed another nudge: **a car modelled from scratch beside a car
that shipped with the game is made of different stuff.** Different section
language, different paint response, different glass, its own idea of where a
pillar goes. Trim on top does not close that gap, because the gap is the trim —
the second rebuild ended with a two-and-a-half-unit "roof panel" drawn straight
over the canopy, which is why the finale's boss car had no windows.

The renderer already had the answer and had been using it for six chapters.
`buildRivalCar()` takes the one car mesh in the level and re-skins every
material on it, so Ryker's street car is unmistakably not the player's without a
second model. The R-IX now takes a **third livery** off the same shell —
graphite pearl under a full clearcoat, everything that was bright plate taken
down to dark titanium, Ryker's amber through the trim and the optics — and
keeps by hand only the parts that are actually the R-IX: the aero kit, the
momentum rings in the diffuser, the predator optics, the sill charge line.

That fixes the windscreen by construction (it is the game's windscreen), the
empty cabin by construction (it is the game's interior, with a driver in it),
and "it does not match the other cars" by construction.

One number was worth its own note: the livery first went out at **metalness
0.90**, which is a mirror. A body with an albedo of 0.05 and a metal lobe that
strong shows the sky and nothing else — white against Chapter 5's sunset,
neon-coloured against Chapter 7. The renderer's own comment on the rival's
paint says exactly this ("paint, not chrome … the difference between a car and
a silhouette"), and the rival is at 0.28. On a dark car the gloss is the
clearcoat's job; the base coat stays dielectric.

### The rival's car

There is one car mesh in the level, so the rival is the same geometry wearing
its own materials - and it gets the more expensive-looking build: black chrome
over a cold blue pearl instead of your warm violet, lit trim lines down the
flanks, white-blue lamps, darker glass, and gunmetal rims and exhaust rather
than bright plate.

The materials are *cloned*, not shared. The shader caches smoothness,
metalness and clearcoat on the material object, so a shared one would carry the
rival's finish back onto your own car.

## Handling

`js/vehicle.js` is a **four-wheel simulation**, not a bicycle model with a
paint job.

- **Four wheels, four springs.** The body is a sprung mass with heave, pitch
  and roll as genuine degrees of freedom. Each corner has its own spring,
  separate bump and rebound damping, and an anti-roll bar. The vertical load a
  tyre gets is whatever its own spring is pushing with that instant, so dive,
  squat and lean are the *cause* of load transfer rather than a cosmetic layer
  on top of it. Hold a corner and the outside wheels carry 2.4x the load of the
  inside ones, because the car is actually leaning on them.
- **Each wheel has an angular velocity.** Engine torque spins it up, the road
  spins it back, and the difference is a slip ratio. Wheelspin, lockup and the
  moment traction returns are events the solver produces rather than states it
  is told about. The handbrake stops the rear wheels dead while the fronts keep
  turning, because that is what a handbrake does.
- **Tyres are Pacejka-shaped in both slip angle and slip ratio**, combined
  through a friction ellipse, with load sensitivity referenced to each wheel's
  own static load and a relaxation length so forces build over distance
  travelled instead of snapping into existence.
- **Collisions are impulses at the contact corner.** Restitution along the wall
  normal, Coulomb-clamped friction along its face, and because the contact
  point is off the centre of mass the same equation that stops a square hit
  spins a glancing one. A brush along the barrier costs a little speed;
  catching it with a corner at 200 km/h puts the car into a 3 rad/s spin,
  unsettles the springs and scrubs the wheels.
- **The drivetrain is a drivetrain**: a torque curve, seven ratios, automatic
  shifts with a 120 ms cut, a slipping clutch off the line, engine braking
  through the gearbox, and aerodynamic downforce.

### The drift

Free tyres plus a yaw damper is a car that either grips or spins, and the
interesting thing — a long, held, controllable slide — lives in a band a few
degrees wide between them that nobody can find at 200 km/h on a keyboard.
Measured on the old model: a handbrake turn went from 11 to 78 degrees of body
slip in three quarters of a second and then hit the wall, and a committed
power-on corner spiralled to 89. Both are spins. Neither is a drift. And
because the tyre screech and the smoke were driven off the *magnitude* of the
slip ratio, a hard stop — where a braked wheel has just as large a slip ratio
as a spinning one — read as a slide too.

So the slide angle is a **controlled quantity** rather than an emergent one.
`SPACE` engages the controller; how far the wheel is turned *into* the corner
sets how deep a slide is asked for. The law is the kinematic one, differentiated
exactly rather than for small angles:

```
beta_dot = (u*Fy - v*Fx) / (m * V^2) - r
```

so the yaw rate that *holds* a slide is exactly the rate the lateral tyre force
is already curving the path at. Servo `r` onto that, plus a proportional term
on the angle error, and the car sits at whatever angle it was asked for. In the
steady state the correction is zero — the tyres are carrying the angle
themselves and the assist is only there for the transient, which is why it does
not feel like being driven on rails, and why a slide still runs wide if it is
asked for more angle than the rears can hold at that speed.

Measured, entering at 170 km/h and held for three seconds:

| Steering | Slide held | Speed kept |
| --- | --- | --- |
| 0.35 | 11.9° | 98 % |
| 0.70 | 25.1° | 87 % |
| 1.00 | 35.8° | 80 % |

- **The angle holds**: 0.8° of variation over a second and a half. A controller
  that rings is a controller you cannot place.
- **It can be flicked**: full lock one way to full lock the other takes the car
  from −36° through zero to +35°, with no opposite lock to find.
- **It comes back**: one second after release, 0.3°.
- **Below the speed floor there is no drift to be had** — 11 world units per
  second, about 30 km/h.

Three things that mattered:

- **Engagement and depth are different things**, and conflating them is what
  made a half-turn of the wheel produce no slide at all: the steering scaled
  the angle asked for *and* the authority the controller had to hold it with,
  so a 35 % input asked for five degrees and then had a third of the strength
  needed to keep it. It settled at under one. `SPACE` engages, fully; the wheel
  sets how far.
- **The small-angle form of `beta_dot` is wrong by enough to matter.** Past
  thirty degrees it hands the servo the wrong target, and a servo with the
  wrong target does not fail gently: it drives the car round. A right-hand
  drift settled at +78° — a spin — while the controller was asking for −38.
- **The rear has to be given back.** Entering a slide needs the rear to let go
  once, which is a short pull of the handbrake and not a permanent one. Held
  on, it is a brake: a measured drift lost 120 km/h in a quarter of a second
  and the car stopped sideways instead of carrying the corner. The pulse lasts
  a third of a second.

The spin guard is always on and independent of the controller: past the limit
the correction stops holding the angle and starts taking it away, so the car
can be thrown a very long way sideways — by a kerb, by the other car, by asking
for too much — and still comes back pointing forwards. Nothing caps the yaw
rate directly; a cap is what made a spin wind up to it and stay there.

**Stopping the car does not skid.** Measured over a 200-0 km/h stop: drift
0.000, wheelspin 0.000, scrape 0.000. Smoke now reads the *signed* slip ratio,
so a wheel spinning up makes it and a wheel being braked does not. The only
thing that screeches and throws sparks is the barrier, and it reads the speed
*along* the wall as well as the speed into it, because a brush at 200 km/h
scrubs hard even when the closing speed is small.

Boost is thrust at the centre of mass rather than extra crank torque. Putting
2.4x the torque through two driven wheels does not accelerate a car, it lights
the rears up - and past the peak of the slip curve that is *less* force. The
one version of boost that actually gets faster when you press it is the one
that does not have to go through the contact patch.

Steering lock is speed-sensitive by design. The tyre curve peaks near 10 deg of
slip, so handing the player all 30 at speed pushes the front axle past its peak
and spins the car - which is what a real car does. The available lock is
instead whatever produces a target lateral acceleration, `delta ~= L*a/v^2`:
full lock at parking speed, a couple of degrees at 250 km/h. The front wheels
also run Ackermann, so the inner one turns more tightly than the outer.

It solves at a fixed 240 Hz. `tools/physicstest.js` measures the result:

| | |
| --- | --- |
| 0-100 km/h | 5.3 s |
| Top speed | 213 km/h |
| 160-0 km/h | 96 m |
| Steady-state cornering | 1.23 g |
| Body roll at the limit | 1.4 deg |
| Load transfer in a corner | 2.4x outside / inside |
| Handbrake | rear wheels locked, 0.84 rad of rear slip |
| Frame-rate spread, 60 vs 30 fps | 1.4 km/h over 10 s |

### The gearbox reads the road, not the wheels

`gearbox()` derives engine speed from the driven wheels and shifts on it, which
is right until a wheel breaks traction — and then it is meaningless, because a
spinning wheel turns at whatever the engine will turn it. Hold the throttle
against a barrier and the old box saw eight thousand rpm, upshifted, saw it
again, and rowed itself into **seventh at a standstill**. That is the gear
jumping around "randomly" when the car is stuck: it was tracking wheelspin.

Real gearboxes shift on engine speed too, but the schedule is against the
*output* shaft, and no box on earth takes top gear at zero miles an hour. So
the gear is chosen from the rolling speed of a wheel at the car's actual road
speed, and:

- the tacho still reads the real wheels, so a burnout still screams — that is
  the only cue the player has that the tyres are gone;
- a shift has a dwell after it, so the box cannot hunt on a boundary;
- a gear is only taken if the revs land somewhere sensible **in the destination
  ratio**, checked rather than assumed;
- a car a cutscene has dropped in at eighty units a second in first takes the
  right gear on the next frame instead of rowing up through six of them;
- and burying the throttle at part speed kicks down.

The bench asserts all five, including that a car held stationary at full
throttle for six seconds never leaves first while its tacho sits above idle.

### Three things a car could do that a car should not

- **Boost forever.** The only gate on the reservoir was "more than 0.02 left",
  and it refills at 0.133 a second — so a tenth of a second after it empties
  there is 0.02 in it again and a held key re-engages. The bar shimmered just
  above zero and the car boosted continuously; the whole reserve was free to
  anyone who never let go of B. The reservoir now **latches** when it is spent
  and unlatches only at `BOOST_ARM` — a burn's worth back in it — and the HUD
  reads CHARGING with a percentage while it is locked, because a rule the
  player cannot see is indistinguishable from the boost being broken. Holding
  the key flat out for thirty seconds now buys 33 % duty, which is exactly the
  refill rate and not a unit more.
- **Beach itself on the verge.** Off the road the car took a flat 5,200 N of
  drag — three and a half metres per second squared applied to a car that is
  not moving. Nose a barrier at low speed and there was nothing the throttle
  could do about it. The drag is tapered to nothing at a standstill, so the
  verge costs speed instead of forbidding motion; the road edge carries a
  hand's width of tolerance so that brushing a wall is a scrape rather than an
  OFF ROAD card; and a car that is off the road, stopped and staying stopped is
  eased back toward the tarmac after a second.
- **Drive the course backwards.** The start line was a wall, because there is
  no level behind it. Nothing else was, so a player could brake to a stop,
  engage reverse and drive the whole route back the way they came. `maxS` is
  the furthest the car has got and it may give up `BACKTRACK` of it — fifty
  five units, more than enough to reverse out of a barrier and get pointed the
  right way again — and no more. Past that the road behind is the same hold the
  start line uses: the car is stopped, not teleported. A car facing back down
  the route gets a WRONG WAY card, so meeting that wall reads as a rule rather
  than as the game being stuck.

### Three things in there that each cost a session

- **The wheel-spin integrator has to be semi-implicit.** A tyre is stiff. An
  explicit step lets the road torque overshoot the rolling condition and the
  wheel then rings about it, which averages out to *less* drive force than the
  true equilibrium - so the car ends up slower the harder the tyre grips.
  Linearising the tyre about its current slip and solving for the new wheel
  speed removes the overshoot completely, and took 0-100 from 6.8 s to 3.3 s
  without touching a single tuning number.
- **The brake is a torque, not a subtraction from wheel speed.** Decrementing
  omega directly makes the brake infinitely strong: the wheel simply locks, the
  slip ratio pins at -1, and the stopping distance stops depending on the
  brakes at all. As a torque it finds an equilibrium against the tyre, and
  lockup happens only when it genuinely out-torques the contact patch.
- **The steering lock was 27 % short, in units.** The available lock is
  whatever produces a target lateral acceleration, `delta ~= L·a/v^2` - but
  that only works if `a` and `v` are in the same units, and they were not: the
  target was in m/s^2 while the speed came out of the solver in world units per
  second. On a course where a seventh of the corners are under 200 units of
  radius, that is the difference between making the bend and not.

- **An anti-roll bar loads the compressed side.** It pushes back on whichever
  side has travelled further, so that side gains load and the other loses it.
  Adding it to the lighter side instead inverts the whole load distribution: a
  right-hand corner then puts the weight on the inside wheels and the car leans
  out of the bend. The bench catches that now.

Engine speed is evaluated inside the solver, not once a frame. Reading it in
the frame loop left it eight sub-steps stale at 30 fps and four at 60, which is
a torque difference - and that was why the model used to reach two different
speeds depending on the refresh rate.

## Why every neon in the game had a white core

ACES is a per-channel curve. Compressing each channel on its own is what makes
it filmic, and it is also what makes it desaturate: feed it a pink tube at six
times white and the red channel saturates first, green and blue catch up, and
the middle of the tube comes out **white with a pink fringe**. Every strip
light, every portal ring and every sign in the game was a white smear with a
coloured edge — which is exactly the "cheaply made" read, because a real neon
tube is most saturated where it is brightest, not least.

The composite now uses a hue-preserving rolloff: tonemap the **luminance**,
keep the pixel's own chroma, and normalise rather than clamp so nothing clips
to white. Doing only that loses the knee the rest of the frame needs, so the
two are mixed by how far into the highlights the pixel already is — shadows and
midtones stay pure ACES, the top of the range keeps its colour. The saturation
push afterwards came down from 1.52 to 1.42, because it no longer has to fight
the tonemap for colour it already has.

The tunnel arches got structure to go with it. Two smooth concentric tubes on a
flat headwall is a decal of an arch; the same light broken into **cassettes** —
short lit fittings around the crown with dark reveals between them, each
standing proud of the wall with a return into it — is an arch.

## NEON HORIZON was lit like a light box

The four city facade materials carried emissives at or near 1.0 with gains
around a half, `noFog`, and eighty-four per cent alpha — so every block on the
route was a saturated orange, lime, magenta or cyan panel emitting at full
strength right up to the lens, with nothing between it and the camera, and
three of the four pulsing. The result is a frame with no shadow in it anywhere
and no depth cue except size: the road, the car and the rival were all being
out-shouted by the scenery, which is why the chapter was hard to *read* as well
as hard to look at.

Facades are lit surfaces, not lamps. Their gains came down to roughly half,
their emissives stepped back toward their own base tone, and their alpha came
down so the block behind actually reads as behind. The route keeps its palette
— it is still a neon city — and gets its contrast back. It also takes an
exposure trim of its own, because even correctly weighted, a city built
entirely out of light is brighter than a coast road, and what reads as
spectacular for ten seconds reads as unplayable over thirty kilometres.

## ASHFALL ZERO's ruins were the city with a jagged roofline

Fourteen and a half kilometres of Chapter 5 — nearly half of it — is authored as
`ruins`, and the towers there came out of the same sweep, in the same material,
as the working skyline forty kilometres back: full window grids, lit floor by
lit floor, on buildings whose only difference was that the four corners stopped
at different heights. A skyline with every light on is not a ruin.

The ruins now have their own sweep and their own material — ash-grey concrete
with a dead emissive — and they **lean**, which no intact building does. Two or
three floors per block are still holding a light and no more, because power
that mostly is not there is the strongest single read of "a city died here", and
the slabs that came off the towers lie in the middens between them.

## The run

The clock is still the clock — but a road this long needs something to chase
in the middle of it.

- **Drift bank.** Holding a slide banks points; landing it pays out and steps
  the multiplier up, to a maximum of ×8.
- **Clean running.** Twelve seconds without touching a barrier also steps the
  multiplier. Hitting one resets it.
- **Checkpoints.** Five splits across each route, each one topping the boost
  up by a third, so the run has a rhythm rather than one long boost drought.
- **The finish card** shows the time, the personal best, the score, the top
  speed reached and every split, so a retry has something to beat piece by
  piece.

The HUD carries a progress rail with the checkpoints ticked on it and the
distance still to go, a rev counter under the gear that shows where the shift
points are, and the score and multiplier top right.

## One gearbox, one gear readout

The gear was on screen twice: `GEAR 5` in the corner of the scope panel, and a
big lit **5** with its own rev bar under the speedometer. Two readouts of one
number, in two sizes, in two corners, is not thoroughness — it is a HUD that
looks unfinished.

The scope panel is the drivetrain instrument: it is drawn from engine speed,
load and wheelspin, so the gearbox belongs to it. The gear moved there as a lit
numeral that flashes on the shift, the rev counter runs along the panel's own
floor with the upshift point marked on it, and the speedometer went back to
being a speedometer.

The panel is also no longer called **C.A.T.** — an acronym inherited from the
atlas sprite it replaced, which named nothing in this game. It says
`DRIVETRAIN`, which is what it reads.

## The lights are the event

The countdown was drawn on top of a HUD at full strength, and its own first
frame at each digit faded up from zero — so the one thing the player is supposed
to be looking at was the faintest thing on the screen, surrounded by a
speedometer, a score, a clock, a turbo bar and a drivetrain panel all reading at
a hundred per cent about a car that is not moving.

The instruments are now held back to a quarter while the lights run and come up
over three quarters of a second once the race is live, which is a much better
reveal than having been there the whole time. It is done by multiplying the
finished HUD's alpha — `destination-in` with a flat fill scales what is already
on the canvas, and the canvas at that point is the HUD and nothing else — rather
than by threading an opacity through forty draw calls. The 3D is a different
canvas underneath and is not touched.

## A cutscene owns the music

`go`, in `Game.bind()`, unlocks the audio context on the first interaction and
then re-picks the track — and it is bound to **every** pointer and key event,
not only the first. `onMusic()` chooses from `state`, and during a conversation
the state is `'story'`, which is not `'menu'`, so it fell straight through to
the race selector: clicking through a cutscene started the race score over it,
and clicking again restarted it.

The story director is the authority whenever it is running the screen, so it is
asked rather than guessed at — and it answers by re-asserting whatever is
already on rather than deriving the answer a second time from `mode`. A second
opinion is how this broke.

## The Forge was lit by lines a kilometre long

Five of the hall's members were lit **and continuous**: the wall fascia, the
crane rails, both floor-lamp strips, the catwalk toe-boards and handrails, and
the ridge. On a straight they converge to the vanishing point and read as wall
lighting; through one of the opening snake's hundred-and-fifty-unit corners they
sweep across the whole frame as long bright bars going nowhere. Nothing in a
factory is lit like that.

A factory is lit by **fittings**, at intervals, with dark between them. The lit
strips became luminaires on a sixteen-unit spacing, the crane rails stopped
glowing because a crane rail is a piece of steel, the hazard banding became
paint, and the ridge became a rooflight. A hall lit by fittings has shadow in
it, and shadow was what was missing.

Every material in the hall also shipped with `tex: null, nrm: null`, so a wall,
a press housing, a saw and a battery stack were untextured constant-colour boxes
with one specular lobe each — which is most of why it read as blocky however
many boxes were in it. Fourteen of them now carry the normal map the renderer
already loads, with per-material tiling.

## The rain was two rulers

Two `repeating-linear-gradient` sheets, each an unbroken line every forty-odd
pixels, at 101° and 105° — four degrees apart, so they read as one — drawn edge
to edge over the sky, the road and the HUD at a constant brightness. Every
streak the same length as every other streak, which is to say as long as the
screen, and all of them exactly parallel: a screen-door pattern with a slow pan
on it.

Rain is made of drops. Each sheet is now chopped into dashes by a mask running
across the streaks, the three sheets sit at 96°, 103° and 107° and run at three
different speeds, they are animated on `background-position` per layer so near
and far can move at different rates inside one element, the far sheet is dimmer
and slightly blurred, and all of it fades out into the horizon instead of lying
at full strength across the sky.

## The launcher

The game opens a **launcher** before it opens the road, and every setting that
is about the PICTURE lives there. The screen behind `ESC` in the game is
`CONTROLS`, and it is about your hands.

That line is not arbitrary. A graphics setting is chosen once, against a
machine, by someone deciding what their hardware can do — and several of them
genuinely cannot be applied to a webview that already holds a GPU context, so a
screen offering all of them and honouring only some was lying about the rest.
The renderer row used to say *"takes effect on restart"*, which is a control
that does not work wearing a label that admits it. A control binding is the
opposite: discovered while playing, changed because something felt wrong in a
corner, and it has to take effect on the next corner.

| Tab | Rows |
| --- | --- |
| DISPLAY | window mode (windowed / borderless / fullscreen), monitor, window size, renderer (hardware / software), vertical sync, frame limit, always-on-top |
| GRAPHICS | render scale, upscaler, preset, shadows, ambient occlusion, neon glow, volumetric fog, wet reflections, speed blur, colour, sharpness, CRT filter |
| AUDIO | music, sound effects |

`web/js/settings.js` declares every row once — label, values, default and hint
— and both screens render from it. Neither carries its own copy, so they cannot
disagree about what a setting is called or what it defaults to, and
`tools/checksettings.js` fails the build if a row is unreachable, unread, or
has a default outside its own list.

### One window, two pages

The launcher and the game are the **same window**. It opens at `launcher.html`,
and PLAY reshapes that window to the chosen mode and navigates it to
`index.html`.

This is not a style choice. The first version built a second window from inside
the `launch_game` command, and it did not work: a Tauri command runs on a
worker thread, window creation has to reach the platform's event loop, and
building a window from off the main thread is the kind of thing that works on
one machine and silently does nothing on the next — which is exactly how it
failed. Reshaping a window that already exists needs no such trip, and the one
part that does (the resize) is marshalled through `run_on_main_thread`. It is
also fewer moving parts: no hidden window to reveal, no ordering problem
between closing one and showing the other, and nothing left holding a GPU
context after the player has moved on.

Two details worth stating, because both are the kind of thing a launcher
usually gets wrong:

- **It creates no GPU context.** The background is CSS. A launcher that spins
  up WebGL to look impressive is a launcher that fails to open on precisely the
  machine whose owner came to it to select the software renderer.
- **It touches no network.** Orbitron is loaded from `web/fonts/`, not a font
  CDN. A desktop game whose settings screen needs an internet connection is a
  settings screen that does not open on a train.

The renderer is the one row that costs a restart, because WebView2 caches a
single environment per process and the first window created fixes it. Rather
than have the row quietly not work, changing it relaunches the process with
`--play`, so the player lands in the game rather than back on the launcher.

`tools/checklauncher.js` drives the **real release binary**: it starts it,
attaches to the webview, waits for the launcher, presses PLAY and checks the
window actually becomes the game. A browser cannot test that half, and that
half is the one that was broken.

### Saving

Every row saves as you change it; **SAVE** (or `CTRL+S`) is what lets you *see*
that it has, and is the one place a write failure can be reported at the moment
it happens rather than being discovered on the next launch. PLAY saves too, and
waits for the write before it starts the game — so what you are looking at is
what the game begins with.

Writes are **chained, not fired**. A save is four round trips to the host — store
the window answers, read the whole save back, merge the game settings in, write
it out — and a click can arrive in the middle of any of them. Two overlapping
saves both read the file *before* either wrote it, so the second one's merge is
built on stale content and the first one's change is silently gone; a player
holding an arrow key on a volume row is exactly that case. Each write now waits
for the one before it, and the chain is the promise itself, which is the
smallest correct mutex there is — there is no lock to forget to release.

### When it will not start

**A run that works leaves nothing behind.** No log file, no folder of
yesterday's sessions. A game that writes a trace on every start is a game whose
logs nobody reads, and the one that matters is buried under fifty that do not.
Everything is collected in memory and thrown away at exit.

A report is written only when there is a reason, and then the launcher shows a
band with the path in it — selectable, because a player asked for their log is a
player who needs to copy where it is — plus buttons to open or dismiss it.

Three things can trigger one:

- **The front end says it could not start.** `main.js`'s fatal path hands the
  host the WebGL vendor and renderer strings, which are usually the whole
  answer: the difference between "ANGLE" and "ANGLE (NVIDIA GeForce RTX 3060
  Direct3D11)" is the difference between a report that identifies a driver and
  one that does not.
- **The host panics.** A hook writes the same report instead of printing to a
  console nobody is looking at.
- **The previous run died without saying anything.** This is the case that
  matters, and the hard one: a graphics driver that takes the process down
  leaves no panic to hook and no chance to write. So the risky step — creating
  the webview — leaves a **breadcrumb** naming itself, which is deleted when it
  returns. A breadcrumb still present at the next startup means the last run
  died inside that step, and *that* is when the report gets written, with the
  step named.

PLAY also runs a **preflight**: a throwaway canvas is asked for a WebGL2
context and its vendor and renderer are read. If there is no context the game is
not started and the report says to try SOFTWARE; if the context is a software
rasteriser the player did not choose — SwiftShader, llvmpipe, WARP — it says so
rather than letting them conclude the game is broken. It never vetoes a launch
on its own opinion: it exists to explain a failure, not to pre-empt one.

A report names the OS and its version, the CPU count, the memory, the WebView2
or WebKit version, the graphics path, every monitor with its scale factor, the
relevant environment (and *only* the relevant environment — dumping everything
into a file a player may post publicly is how paths and tokens end up on a
forum), a timestamped trace of how far the launch got, and what to try next.

## Controls (in game)

`CONTROLS` on the title screen, or `ESC` → the same screen. Three pages, and
all of them are about input — everything about the picture is on the launcher.

| Tab | What is on it |
| --- | --- |
| KEYBOARD | every action, rebindable; `ENTER` listens for the next key, `←` clears, `R` resets them all |
| GAMEPAD | the live controller diagram, and four settings: on/off, stick deadzone, steer response, vibration |
| MOUSE | free look, sensitivity, invert Y, smoothing |

The screen closes with **SAVE AND BACK** at the bottom, not with `ESC`.

### Are you sure?

`QUIT` asks. It ends the process, and on the title screen it sits one row below
`CONTROLS`, which is a single mis-hit away from a campaign.

The confirmation is a **state**, not a flag on the menu, for the same reason the
pause card is one: the screen underneath has to stop reading the keyboard. A
confirmation the arrow keys walk straight past is not a confirmation. `NO` is
index 0 and is where the selection starts, because a dialogue that opens on
`YES` turns a mis-hit `ENTER` into exactly the action it exists to prevent.

## Audio

`theme.ogg` loops under the title and the controls screen. On the road, four
full-length Vorbis Ogg songs form a dynamic radio for the coast, canyon, mesa
and city environments. A song plays through before the radio chooses a
compatible non-repeating follow-up; crossing into a different environment
mid-song triggers a 1.6-second cross-fade to that environment's station track.
All music streams from `<audio>` elements routed through the WebAudio mixer,
because decoding the songs whole would cost tens of megabytes of RAM.

Engine sound follows the drivetrain rather than road speed, so it drops on
every shift.

## Seeing what it looks like

`tools/harness/` drives the real `Game` object in a headless browser. Serve
`web/` and load them over HTTP.

- `tools/harness/frame.html?s=200&what=both` renders one frame and puts it in
  the DOM as a data URL, so `--dump-dom` can retrieve it (headless
  `--screenshot` deadlocks on a requestAnimationFrame loop). It also reports
  any GL error the frame raised — a frame that raises one has a bug in it
  whatever it happens to look like.

  `?warm=14&drive=1.4&steer=1&space=1` is the one that matters most. A still
  capture with a static camera cannot see anything temporal: the temporal
  resolve has no motion to reproject, the trails have nowhere to have been, and
  a post pass that only misbehaves while the camera is moving never gets the
  chance. That drives `update()` and `draw()` together with input held down,
  exactly as the browser does, so what comes out is a frame from a car that has
  actually been driven there — warm up in a straight line first, because
  steering into a barrier from a standstill measures the barrier.

  Useful parameters:

  | Parameter | Effect |
  | --- | --- |
  | `s=` | arc length along the course; `-1` for the title screen |
  | `what=game\|hud\|both` | which layer to capture |
  | `state=` | force a game state (`options`, `countdown`, `finished`, …) |
  | `q=LOW\|MEDIUM\|HIGH\|ULTRA` | render at that quality level |
  | `off=ssr,vol,dof,god,bloom,head` | isolate one pass by turning others off |
  | `fx=1` | run the particle system so smoke, sparks and flame show |
  | `cam=x,y,z` | frame the car from a chosen offset |
  | `warm=` / `drive=` | run the **real** update+draw loop for that many seconds, with input held. `steer=`, `brake=1`, `space=1`, `boost=1`, `nogas=1` |
  | `only=sky\|raw` | skip post-processing |
  | `hudboxes=1` | outline every HUD widget |
  | `dbg=1..4` | albedo / ambient / diffuse / env debug output |

- `tools/harness/audiocheck.html` fetches every clip the game asks for and
  reports its container, MIME type and size, decoding each one where the
  browser can. Headless browsers usually have no audio backend, so most decodes
  time out there and it falls back to reporting delivery — enough to have
  caught a 24-bit-WAV-named-`.ogg` bug.
- `tools/harness/idprobe.html?s=200` renders each drawable part in a unique
  flat colour, reads the buffer back and reports which parts own which pixels.

There is no offline software rasteriser. There used to be: it indexed geometry
differently from the browser, so it agreed with broken data and actively hid
the worst bug in the project. Measuring real GPU pixels is the only check worth
keeping.

## Bugs this went through

Each of these was invisible from the code alone.

- **Mesh-local indices in a shared buffer.** Every mesh lives in one vertex
  buffer behind one VAO, and WebGL2's `drawElements` takes only a byte offset
  into the index buffer — it has no `baseVertex`. Indices written per-mesh made
  the whole scene vertex soup: the id probe measured the car's wheel rim
  covering 66 % of the screen because it was drawing terrain. Indices are
  global; `selftest.js` asserts every submesh's indices fall inside its own
  mesh's vertex range.

- **The camera was invented, not read.** The scene's camera is fov 70, near 1,
  far 50000, and world instances were being culled past 6000 units on their
  origin. The sun is a single quad 48 km down the track, so it was culled out
  of every frame — the scene's defining element simply never drew. Culling now
  measures to the near edge of the bounding sphere.

- **The road looked untextured.** Not a missing texture: a lighting failure.
  Sky irradiance was a single cubemap lookup along the normal, but this skybox
  is stylised — its +Y face is black and effectively all its energy sits in a
  thin horizon band. A flat road sampling straight up came back black, so its
  diffuse term landed at ~0.002 while its specular reflection sat at ~0.03.
  Irradiance is now a five-tap hemisphere approximation.

- **The whole world was mirrored.** The source is left-handed (+X right, +Y up,
  +Z forward) but `gluLookAt` and the standard projection are right-handed, so
  +X came out on the *left* of the screen. That inverted every steering input,
  mirrored the track's corners and reversed triangle winding. `M4` now builds a
  left-handed projection.

- **The car handled like a bicycle**, because it was a *kinematic* single-track
  model: yaw rate read straight off the steering geometry, sideways velocity
  just damped away. Replaced with the dynamic model above.

- **The aerial perspective erased the sunset.** Fading everything by distance
  is right for terrain and wrong for the sky: the sun quad stands 48 km out and
  the haze dome wraps the whole level, so both were scrubbed out of the frame.
  They are flagged to skip the distance term.

- **The volumetric stippled the horizon.** The march is dithered and
  fbm-modulated at half res, and upscaling it straight into the composite left
  visible noise along the skyline where the ray length is longest. It is
  resolved with the same two-tap blur the reflections use.

- **`drawBuffers([BACK])` on a user framebuffer.** Legal only on the default
  framebuffer; the scene target was still bound. The harness now reports
  `gl.getError()` after every captured frame.

- **The speed readout tinted the speedometer too.** Recolouring the bitmap font
  with a `source-atop` fill paints through everything already drawn under that
  rectangle. The tint happens in an offscreen buffer.

- **Fog.** Fog is off in this level, but the renderer was blending everything
  past 1200 units into purple, turning the frame into a flat wall.

- **A palm forest standing in the road.** The palms are one baked mesh for the
  whole map. Triangles inside the road corridor are removed, and `selftest.js`
  sweeps the course asserting nothing is within 6 units of the chase camera.

- **Back-face culling** was measured, not guessed: the generated road is
  CCW-front while the imported meshes disagree, so culling either way loses
  part of the scene. It is off.

- **A CSS specificity trap.** `#fatal { display: grid }` beat
  `.hidden { display: none }`, so a 95 %-opaque overlay covered the page and
  ate every click while showing an empty message.

- **The route you had not played yet was unplayable.** Every menu branch ends
  by flying the idle camera down the road, and the difficulty screen called
  `beginRace()` and then *fell through to it*. The flyby teleports the car to
  arc length ~0.9 — the head of the whole course — while `resetCar` has just
  placed it, and its `sTrack`, at the chosen route's start ten kilometres away.
  Next frame `Track.project` searched ±120 samples around a hint that was
  nowhere near the car, reported a lateral offset of **2135 units**, and the
  barrier resolver slammed the car sideways into a wall on a different stretch
  of road at 45 degrees. It never showed up on RETRY, because the finish card
  does not fly the camera — so it was exactly "the first time you start the
  next level". The flyby only runs now if the branch it belongs to is still the
  state the frame is in, `Track.project` sanity-checks its own window and falls
  back to a full sweep when the hint is not describing this car any more, and
  `selftest.js` asserts the car entering a route is on the road it was put on.

- **The drivetrain panel was a black box on the road.** It shipped as an atlas
  sprite, and the sprite is a 512×142 bitmap with an alpha channel that is 255
  *everywhere* and a mean colour of (20, 50, 52). Drawn over the tarmac at a
  fifth of the screen width, that is a large, hard-edged, low-resolution black
  rectangle with a waveform baked into it that never moves. In the original it
  was one cell of a full-width dashboard console, where an opaque panel is
  exactly right; on its own over open road it was the most obviously broken
  thing on the screen. It is drawn rather than blitted now — a translucent
  instrument with a real trace in it, built from the drivetrain, so it is an
  instrument showing something rather than a picture of one.

- **The speed blur was undone by the pass after it.** The radial blur
  accumulated six taps into the working colour, and then the chromatic
  aberration *overwrote* `scene.r` and `scene.b` with single unblurred samples.
  Two of the three channels never smeared at all, so "speed blur" was a green
  ghost with a sharp magenta image sitting on top of it — which is why turning
  it on read as a colour fringe rather than as speed. They are one loop now,
  which is also what a real lens does: the smear and the dispersion are the
  same optical path.

- **The saturation lift drove channels negative.** `mix(vec3(lum), col, 1.52)`
  is what makes the neon sing, and on anything strongly tinted it takes the
  weakest channel below zero. A negative channel clamps to black, so a magenta
  sign lost its green and turned into a hole.

- **The modals were sharing the screen with the instruments.** The finish card
  and the pause menu were drawn *over* `drawHud`, so the speedometer, the
  score, the clock and the drivetrain panel sat around their edges at a quarter
  opacity — close enough to read, far enough from anything to look like a
  mistake. A modal replaces the instruments now. The options hint was also
  authored at y = -326 under a panel whose bottom edge is at -323: three units
  outside it, straight through the border, at every resolution. Hints are
  placed from the panel's own geometry now, which is what makes that
  impossible rather than merely fixed.

## Layout

```
web/
  index.html                 markup
  css/style.css
  data/scene.json            meshes, materials, instances, skybox, centreline
  data/scene.bin             11 MB of vertex + index data
  data/game_data.js          HUD layout + atlas rects, bitmap font, UI strings
  js/gl.js                   maths + WebGL2 helpers
  js/scene.js                loads, repairs, generates and draws the world
  js/track.js                builds the course, and queries it
  js/vehicle.js              car model
  js/ai.js                   the rival driver
  js/fx.js                   neon trails, tyre marks, particles
  js/hud.js                  HUD, menus and the finish card
  js/audio.js                mixer, engine note, music
  js/game.js                 loop, camera, race rules, post chain
  js/story.js                campaign, cast, dialogue, cutscene cameras
  js/level5.js               ASHFALL ZERO set pieces and the R-IX kit
  js/level6.js               AURORA FORGE trials and raceMode
  js/level7.js               NEON HORIZON scenery and the PREDATOR director
  js/main.js                 bootstrap
  assets/textures/           game textures and the six skybox faces
  assets/audio/              20 clips, including the menu theme and four radio songs
  tools/
    physicstest.js           vehicle bench (80 checks)
    selftest.js              drives the real Game and the 30 km finale headlessly (261 checks)
    shadercheck.js           GLSL + markup lint (95 checks)
    chapter7test.js          finale data, state machines, hazards, the shoulder (78 checks)
    cameratest.js            the cutscene shot language against a synthetic route (15 checks)
    shotserver.py            serves web/ and accepts captured frames back
    harness/frame.html       one real frame, for headless capture
    harness/storytest.html   drives the whole campaign in a real browser
    harness/uiprobe.html     every DOM interface layer, for screenshot review
    harness/uiprobe.js       the copy the probe fills those layers with
    harness/idprobe.html     per-part coverage, measured from the id buffer
    harness/audiocheck.html  clip delivery and decoding
```

## Building it

One command, and it needs Rust (with the `wasm32-unknown-unknown` target) and
Node. Nothing else — no npm install, no bundler, no build step for the web
side, which is plain ES2020 served as-is.

```bash
rustup target add wasm32-unknown-unknown
node tools/build.js                 # -> target/release/synx[.exe]
```

That produces one self-contained executable with the whole of `web/` compiled
into it: scripts, shaders, textures, audio, the scene, and the WebAssembly
core. There is nothing to install beside it and no server to start first.

| Flag | What it adds |
|---|---|
| `--test` | the Rust unit tests for the core and the wire format |
| `--check` | the static checkers: shader literals, DOM lookups, wire protocol |
| `--smoke` | the whole game in a real browser, on two routes and every menu |
| `--all` | all three of the above |
| `--bundle` | an installer under `target/release/bundle` (needs `cargo-tauri`) |
| `--run` | launch it when the build finishes |

It replaced `build.ps1` and its `build.cmd` shim, which were Windows-only for
no reason the game shares — everything under `tools/` is already Node, and
Node was already required for the checkers and the smoke test.

## Tests

`cargo test` covers the simulation, which is the half that can be checked
without a screen:

```bash
cargo test -p synx-core --release    # course, meshing, vehicle, driver
cargo test -p synx-net --release     # the wire format
```

Among them, three that exist because of specific bugs rather than for
coverage:

- **`a_rival_alongside_does_not_make_the_driver_weave`** — drives a rival
  alongside a car that is *weaving*, and fails if the driver travels more than
  eight units across the road answering it. The overtaking controller used to
  pick its side every frame from the sign of the other car's lateral, which is
  a bang-bang controller: the same test measured 27 units of travel before the
  side became a committed decision, and 2.4 after.
- **`the_ladder_is_actually_a_ladder`** — asserts daylight between EASY,
  MEDIUM, HARD and the R-IX over two minutes of the real course. The shipped
  ladder passed the old "HARD beats EASY" test while being, in practice, one
  difficulty with three names on it.
- **`speed_profile_can_always_brake_in_time`** — every point on the speed
  profile must be slow enough to have braked down to whatever comes next,
  which is the property that makes braking points emergent rather than
  scripted.

Everything under `web/` is renderer code, and none of it is reachable from
`cargo test`: a shader that will not compile, a uniform that is not there, a
texture the pack does not carry or a class that throws are all invisible to a
parse check and all fatal the moment a player opens the game. The only honest
way to check that half is to run it.

```bash
node tools/checksettings.js          # the schema against the code that reads it
node tools/checkupscale.js           # the reconstruction kernel, numerically
node tools/checkshaders.js           # GLSL literals are well formed
node tools/checkdom.js               # every getElementById resolves, on every page
node tools/checklauncher.js          # the real .exe: open it, press PLAY, reach the game
                                     #   ...and that a clean start writes no log,
                                     #   while a failure writes one that names the machine
node tools/smoke.js --seconds 24     # the whole game, in headless Edge/Chrome
```

Three of those exist because of bugs that shipped and could not be seen:

- **`checksettings.js`** — a setting that silently does nothing looks exactly
  like one that works. When the graphics rows moved to the launcher the option
  lookup kept searching the rows the in-game screen *drew*; it returned null
  for the preset, the caller fell back to `HIGH`, and LOW rendered shadows,
  reflections and volumetrics. Nothing threw.
- **`checkupscale.js`** — the upscaler's bugs are invisible in a screenshot and
  obvious in the arithmetic. It caught two: a positive-only window that
  returned a one-texel line at 0.37 where plain bilinear left it at 0.75, and a
  transposed anisotropy that sharpened *across* edges instead of along them.
- **`checklauncher.js`** — PLAY did not work, and nothing in the tree could
  have told us: the launcher renders perfectly under a plain web server, so the
  browser smoke test was green throughout. What was broken existed only in the
  desktop host. This drives the release binary itself.

`tools/smoke.js` serves `web/` over HTTP, opens it with a software WebGL2
stack, drives it through the states a player would — title, a race on a chosen
route, a crash into the barrier, a pause, a resume — and reads back everything
the page said: console errors, uncaught exceptions, failed requests, load
timings and the draw-call census. Useful flags:

| Flag | What it does |
|---|---|
| `--route N` | which of the seven routes to race |
| `--preset 0..3` | quality; `0` is what the software stack can actually manage |
| `--hold modes\|freeroam\|multiplayer\|menu\|pause` | stop on a screen and stay there |
| `--freeroam N` | drive the open route against opponent `N` instead of a chapter |
| `--probe layout` | assert no two interface bands are drawn on the same line |
| `--probe options` | walk every page of the controls screen and rebind a key |
| `--page launcher.html` | drive the launcher instead of the game (`#graphics` opens a tab) |
| `--exercise` | click every control on a DOM page and fail any that saves nothing |
| `--scale N --upscaler N` | pick the render scale and reconstruction, to compare them |
| `--hold controls:1` | stop on the controls screen, on that tab |
| `--probe director` | assert nothing leaks from one chapter's director into the next |
| `--probe predator` | assert Chapter 7's boss answers boost and does not answer raceMode |
| `--shot out.png` | save what it looked like |

Every smoke run also asserts that **the preset was actually applied** — the
renderer's own flags are compared against what the chosen preset asked for.
That is the invariant the schema check cannot see and the screenshot cannot
show, and it is the one that was broken.

`--hold` exists because the three selection screens are ordinary DOM panels
that no racing run ever opens — which is how the mode terminal shipped with no
way back to the title except `ESC`.

`tools/checkprotocol.js` compares this repository's copy of the wire format
against the server's. It needs the server checked out beside this one and is
skipped by `tools/build.js` when it is not there, because this repository is
meant to build on its own.

### Harnesses this document still mentions, which are not in the tree

Sections further down refer to `tools/selftest.js`, `tools/physicstest.js`,
`tools/shadercheck.js`, `tools/chapter7test.js`, `tools/cameratest.js` and the
browser pages under `tools/harness/`. **None of those files are in this
checkout.** `tools/` contains exactly `build.js`, `checkdom.js`,
`checklauncher.js`, `checkprotocol.js`, `checksettings.js`, `checkshaders.js`,
`checkupscale.js`, `gentex.js`, `pack.js` and `smoke.js`.

The prose around them is left as written because it documents real invariants —
what the world builder guarantees, what the course generator may not do, what
the shot language is allowed to frame — and those are still true of the code
even though nothing is currently asserting them on every build. Read those
passages as a specification, not as a list of checks that run.

Anything named above is therefore either to be restored or to be pruned out of
this document; it should not be left reading as coverage that exists.

## Sources

The rival's architecture follows published work rather than being invented:

- [An Architecture Overview for AI in Racing Games](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter38_An_Architecture_Overview_for_AI_in_Racing_Games.pdf)
  - Game AI Pro, on the racing-line / drive-controller / tactics split.
- [A Rubber-Banding System for Gameplay and Race Management](https://www.gameaipro.com/GameAIPro/GameAIPro_Chapter42_A_Rubber-Banding_System_for_Gameplay_and_Race_Management.pdf)
  - Game AI Pro, on adjusting driver skill rather than vehicle performance.
- [The Pure Advantage: Advanced Racing Game AI](https://www.gamedeveloper.com/design/the-pure-advantage-advanced-racing-game-ai)
  - the skills framework and dynamic competition balancing against positional
    targets, with bounded modification per difficulty.

## Licensing

The art and audio under `assets/` and the geometry under `data/` come from a
commercial arcade racer and belong to its original rights holders, not to this
project. Renaming things does not change that. Clear the rights before putting
this on a public site.
