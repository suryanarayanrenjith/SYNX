<div align="center">
  <img src="web/favicon.png" alt="SYNX logo" width="128">
  <h1>SYNX</h1>
  <p><strong>Synthwave eXtreme Racing</strong></p>
  <p>A neon arcade racer with drifting, ramps, jumps, rival AI, and a Rust-powered simulation core.</p>

  <p>
    <a href="https://github.com/suryanarayanrenjith/SYNX/releases/latest">Download</a>
    &nbsp;&middot;&nbsp;
    <a href="https://synx-racing.vercel.app/">Project website</a>
    &nbsp;&middot;&nbsp;
    <a href="https://github.com/suryanarayanrenjith/SYNX">Repository</a>
  </p>
</div>

> **Open beta:** SYNX is under active development and every build is a beta.
> Expect changes, rough edges, and bugs. Feedback and bug reports are welcome.

> **Photosensitivity warning:** SYNX contains rapidly flashing lights,
> high-contrast strobing, and saturated neon effects. If you or someone in your
> family has a photosensitive condition, consult a doctor before playing. The
> game displays this warning at launch.

## Gameplay

 https://github.com/user-attachments/assets/97d22c17-1ccd-4873-9e18-f04668b8cb9f

## Overview

SYNX is a short, high-energy racing experience built around throwing a car into
a corner, holding a slide, and launching off a ramp. It combines arcade
accessibility with a four-wheel vehicle model, terrain and ramp interaction,
rival drivers, and a neon WebGL2 presentation.

The game includes a seven-chapter campaign on a 173 km road, free roam, replay
recording, multiple graphics options, and online multiplayer backed by a
separate server project. The campaign travels through coastal, canyon, mesa,
city, volcanic, industrial, and elevated neon environments.

## Features

- Drift-focused arcade driving with throttle, braking, steering, boost, and
  vehicle recovery.
- Ramps, jumps, landings, and surface-aware vehicle pitch.
- Rival AI that uses the same simulation foundation as the player's vehicle.
- Seven campaign chapters, free roam, and multiplayer modes.
- Three camera views, chase, driver and drone, that the camera travels between
  rather than cutting, so pressing `C` reads as a zoom in or out.
- WebGL2 rendering with neon lighting, particles, reflections, and a canvas HUD.
- Keyboard, gamepad, and touch input. Keys are rebindable and the interface
  reads the live bindings back instead of assuming the defaults.
- Replay recording, the last-thirty-seconds save buffer, and highlight markers.
- A Tauri desktop build with a native launcher and persistent save data.
- A Rust simulation core compiled to WebAssembly, with no `wasm-bindgen`
  runtime dependency.

## Download

Every push to `main` builds all four platforms and publishes a new beta. The
newest one is always the highlighted release:

**[Download the latest beta](https://github.com/suryanarayanrenjith/SYNX/releases/latest)**

| Platform | File |
| --- | --- |
| Windows | `-windows-x86_64-setup.exe`, or `-portable.zip` to run without installing |
| Linux | `-linux-x86_64.deb`, `.rpm`, or `.tar.gz` for any other distribution |
| macOS (Apple silicon) | `-macos-apple-silicon.dmg` |
| macOS (Intel) | `-macos-intel.dmg` |

`SHA256SUMS.txt` covers every file in the release.

Versions increment by one patch per release: 1.0.1, 1.0.2, and so on. The
number is assigned by the release workflow rather than committed to the tree,
so a local build reports the floor in `src-tauri/tauri.conf.json` instead of
the newest published build.

Nothing is code-signed. Windows SmartScreen prompts once: choose **More info**,
then **Run anyway**. macOS refuses a double-click, so open the app from the
right-click menu the first time, or run
`xattr -dr com.apple.quarantine /Applications/SYNX.app`. The Linux packages are
built on Debian 12 and need glibc 2.36 or newer and a WebKitGTK 4.1 runtime.

## Inspiration and provenance

SYNX is built on *Power Drive 2000*, an unreleased 1980s science-fiction arcade
racer by Megacom Games. It was made by reverse-engineering that game: the
handling model, the drift behaviour, the ramp and landing rules, the rival
driver, the camera work, and the chapter structure were all studied and then
rebuilt from scratch, in Rust and JavaScript, against a different engine.

**The art is not original.** The player vehicle, the road and tunnel geometry,
the roadside billboards, the start gantry, the sky, the course centreline the
173 km road is extended from, and a large share of the textures were extracted
from the *Power Drive 2000* pre-alpha demo and converted into this project's
own formats in `web/data/scene.bin` and `web/data/synx.pak`. The original mesh,
material and texture names are still visible in `web/data/scene.json`. That is
deliberate.

What is original is the engineering around it: the simulation core, the rival
AI, the WebGL2 renderer, the HUD and cockpit, the story and chapter scripting,
the audio mixer, the multiplayer protocol, the replay recorder, the desktop
host, and the build and release tooling.

*Power Drive 2000* was funded on Kickstarter in 2015. The campaign ran from
4 May to 3 June, asked for CA$45,000, and finished with CA$52,114 from
1,960 backers. Megacom Games pitched it as "not just a racing game, it's an
action game with a car that talks", set in "a 1980's style sci-fi world with an
eclectic mix of environments and a variety of unique gameplay modes", with
Windows, macOS and Linux releases promised. The only thing that ever shipped
was a Windows pre-alpha demo, version 0.06, which is still on
[itch.io](https://megacomgames.itch.io/power-drive-2000-pre-alpha-demo) and
[archived at the Internet Archive](https://archive.org/details/power-drive-2000-v-0.06).
The full game was never released and the Kickstarter page has not been updated
since 2017.

SYNX is an independent, non-commercial project. It is not affiliated with,
authorised by, or endorsed by Megacom Games, and no claim is made to any right
in *Power Drive 2000* or its assets, which remain the property of their owner.

For background, see the
[Power Drive 2000 entry on IGDB](https://www.igdb.com/games/power-drive-2000)
and the
[original Kickstarter campaign](https://www.kickstarter.com/projects/1420158244/power-drive-2000).

## Play

### Project website

The public Vercel deployment is the SYNX landing page and project website. It
does **not** host the playable game:
**[synx-racing.vercel.app](https://synx-racing.vercel.app/)**

### Local frontend

For development and renderer checks, serve `web/` over HTTP. Opening
`index.html` directly is not supported because the frontend loads WebAssembly
and other game assets through a web server.

```sh
cd web
python -m http.server 8000
```

Then open <http://localhost:8000>. The supported player distribution is the
desktop build.

### Desktop build

The desktop host is built with Tauri and embeds the complete frontend. A
release build produces `target/release/synx.exe` on Windows and the equivalent
binary on other desktop targets.

```sh
python tools/build.py             # the game
python tools/build.py --all       # with tests, checks and browser smoke tests
python tools/build.py --run       # and launch it
```

To produce the installers and packages a release carries:

```sh
python tools/build.py --target x86_64-pc-windows-msvc --bundles nsis
python tools/release.py --target x86_64-pc-windows-msvc
```

The bundle step needs a Tauri CLI (`npm i -g @tauri-apps/cli@^2` or
`cargo install tauri-cli --version "^2"`). `release.py` renames what the
bundler produced, builds the portable archive, and writes the checksums into
`dist/`.

## Requirements

- Python 3.
- Rust and Cargo with the `wasm32-unknown-unknown` target
  (`rustup target add wasm32-unknown-unknown`).
- A WebGL2-capable browser for local frontend development and smoke checks.
- Node.js for the JavaScript checks; optional for a basic build.
- Tauri's desktop prerequisites for the native executable. On Windows that
  means WebView2 and the normal Rust desktop build tools.

Optional image and audio asset commands may require `numpy` and `soundfile`;
the tools report missing optional dependencies when needed.

## Controls

| Action | Default |
| --- | --- |
| Steer | `Left` / `Right` or `A` / `D` |
| Throttle / brake | `Up` / `Down` or `W` / `S` |
| Slide / drift | Hold `Space` |
| Boost | `B` |
| Race mode | `R` |
| Camera | `C` |
| Pause | `Esc` |
| Start/stop recording | `F8` |
| Save replay | `F9` |
| Mark highlight | `F10` |

Every row is rebindable from the CONTROLS screen, and the interface reads the
live bindings: the boost meter, the race-mode readout, the pre-race card and
the chapter prompts all name the key you actually have bound. Clearing a row
unbinds it, and the interface says so rather than falling back to the default.

Gamepad and touch controls are also supported. Bindings and graphics settings
are available from the launcher and options screens.

## Project structure

| Path | Purpose |
| --- | --- |
| [`crates/synx-core`](crates/synx-core) | Course generation, vehicle physics, terrain, meshes, particles, rival AI, and the WebAssembly ABI. |
| [`crates/synx-net`](crates/synx-net) | Shared multiplayer wire format, quantisation, and protocol layout. |
| [`crates/synx-rec`](crates/synx-rec) | Replay ring, JPEG encoding, and AVI recording module used by a Web Worker. |
| [`web`](web) | WebGL2 renderer, HUD, game modes, story scripting, audio, and browser entry points. |
| [`src-tauri`](src-tauri) | Tauri desktop host, launcher, settings, save data, and crash diagnostics. |
| [`tools`](tools) | Build, release, version, asset, check, smoke-test, and browser-probe tooling. |
| [`.github/workflows`](.github/workflows) | The release pipeline: four platforms, built and published on every push. |
| [`assets-src`](assets-src) | Local asset source directory generated from the shipped archive. |

The simulation core and recorder are compiled to WebAssembly. JavaScript maps
the core's linear memory through a small hand-written C ABI, while the desktop
host embeds the built `web/` directory into the application.

## Development commands

```sh
cargo test --workspace --release        # the Rust unit tests
python tools/check.py                   # the non-browser checks
python tools/check.py --list            # and what each one is
python tools/build.py --test --check --no-host
python tools/version.py                 # the version in the tree
```

The checks cover shader and DOM consistency, settings, rendering data, car
geometry, multiplayer protocol compatibility, story flow, ramps, recording,
radio, and AI behaviour. Browser-dependent checks run through `tools/smoke.py`
and the `--all` build path.

## Asset pipeline

`web/data/synx.pak` is the shipped asset archive. `assets-src/` is a working
directory and can be reconstructed from it:

```sh
python tools/assets.py unpack
python tools/assets.py list
python tools/assets.py check
python tools/assets.py pack             # after editing source assets
```

PNG optimisation, atlas cleanup, generated textures, scene processing, landing
sound synthesis, and the macOS icon set are available through the other
`assets.py` commands.

## Related project

The multiplayer server is maintained separately:
**[SYNX multiplayer server](https://github.com/suryanarayanrenjith/synx-server)**

The client and server share the protocol implementation through
`crates/synx-net`; the server is not built by this repository's desktop build.

## Status

SYNX is in open beta and under active development. Every published build is a
beta. The project is usable, but compatibility, balance, visuals, and content
may change as the game evolves.

## Credits

Created by:

- [Suryanarayan Renjith](https://github.com/suryanarayanrenjith)
- [Shivansh Mukhia](https://github.com/smsolutionsva-byte)

## License

No license file is currently included in this repository.
See
[Inspiration and provenance](#inspiration-and-provenance).
