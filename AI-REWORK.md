# Rival AI rework

The shared Rust driver now controls steering, braking and boost through one set of physical limits. Story chapters 1–6 select HARD; chapter 7 starts from IMPOSSIBLE. Free-roam difficulties retain distinct pace and reaction margins, but all have zero random driving mistakes.

## Problems found

- The old slip correction used the opposite sign to the vehicle's countersteering convention. Input conversion also ignored the extra steering lock supplied by the vehicle during recovery.
- Drift entry and exit could discard braking commands. Personalities, especially Predator, could force boost after the main driver decided it was unsafe.
- Gap-based skill balancing deliberately eased the driver when leading. Chapter 7 additionally requested less speed when the player boosted and removed a speed floor when the lead crossed a threshold.
- A passing offset and an obstacle hint could add together, missing the intended safe lane.
- Free roam increased the planner's grip without matching the car's actual tyres.
- JavaScript reset cleared its own flags but left Rust passing and recovery state alive.
- Chapter 7's continuously changing configuration rebuilt the entire course speed profile every frame.
- Chapter 4's extra racers had explicit station-keeping brakes that prevented them racing for position.

## Current controller

1. Retain the course's smoothed racing line and cache geometric corner limits.
2. Track a speed-dependent lookahead using direction of travel, slip correction and yaw damping. AI conversion and vehicle physics share the same steering-lock calculation.
3. Commit to a passing lane, retain it across lead changes, then return smoothly. An obstacle lane takes precedence. Slow for a predicted closing collision, never just for another car's proximity.
4. Preview the actual road curvature as well as the racing line. Account for an inside passing lane, surface grip, actual car grip and a reserve of steering authority. Brake over the necessary distance instead of braking twice through an already propagated speed profile.
5. Allow boost only when the chassis is settled and the speed envelope has room. Forced boost commitments and boss momentum acceleration respect braking and recovery.
6. Back out of a wall-facing stall with normal controls, then rejoin. Restart clears the complete driver state.

The stock player physics are unchanged apart from extracting the existing steering-lock formula into a shared helper. Free-roam R-IX retains its special-car tuning and receives bounded acceleration assistance; ordinary rivals still drive through their normal inputs. Chapter 7 retains its scripted momentum drive, hazards, story events and player raceMode counterplay.

## Research references

- [R. Craig Coulter, Implementation of the Pure Pursuit Path Tracking Algorithm, CMU-RI-TR-92-01](https://publications.ri.cmu.edu/implementation-of-the-pure-pursuit-path-tracking-algorithm): geometric lookahead path tracking and parameter sensitivity.
- [Craig Reynolds, Steering Behaviors for Autonomous Characters, GDC 1999](https://www.red3d.com/cwr/steer/gdc99/): predictive avoidance and separation of tactical choices, steering and locomotion.

These inform the design; the numerical margins were tuned against SYNX's own four-wheel solver and shipped road geometry.

## Verification

- 67 core Rust tests and 21 network tests passed, including new regressions for proximity, lead changes, boost arbitration, grip mismatch and restart state.
- `node tools/checkai.js --suite` runs all seven complete routes on every difficulty, repeats them with the real free-roam director, then runs the real chapter-7 tuning method and tactical fixtures. It uses the shipped WebAssembly module, JS bridge, road data and vehicle solver. All 57 full-route runs completed with zero detected wall contacts and zero off-road frames.
- Tactical fixtures cover a collision-free overtake of an actual slower car, obstacle-hint priority, restart equivalence, recovery from stops facing either wall, and chapter-7 pace continuity.
- Chapter 7 also completed full pursuit runs at 30 and 120 controller updates per second, with no wall contacts or off-road frames. Average speeds were 124.43 and 124.83 world units/s in the 800-unit-gap stress scenario.
- The existing settings, upscaler, shader and DOM checks passed.
- A headless Edge startup test loaded and rendered level 7 with no reported WebGL error. This was a startup/render smoke test, not a full interactive campaign playthrough.

Detailed results are in `target/ai-driver.json`, `target/ai-free.json`, `target/ai-boss.json`, `target/ai-boss-30hz.json`, `target/ai-boss-120hz.json` and `target/ai-suite.log`. The initial three-minute baseline is retained in `target/ai-before.json`.

The route benchmarks exercise the driving controller and mode tuning, not every interactive cinematic, moving hazard or possible player collision. The separate tactical test uses real car collisions; the long route runs use a moving reference rival to stress repeated lead changes. These checks establish measured behaviour, not a guarantee that every possible gameplay situation is flawless.

## Build and repeat

`node tools/build.js --test --check` rebuilds the WASM and executable, runs the Rust tests, the complete AI suite and existing static checks. The resulting game is `target/release/synx.exe`.

For a focused check, set `AI_MODE` to `driver`, `free`, `boss` or `tactics`; optionally set `AI_LEVEL` (1–7), `AI_DIFFICULTY`, `AI_HZ`, `AI_GAP`, `AI_SECONDS` and `AI_REPORT`, then run `node tools/checkai.js`. The full suite supplies its own repeatable frame rate, gap and duration.
