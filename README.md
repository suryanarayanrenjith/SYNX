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

> **Open beta:** SYNX is actively being developed. Expect changes, rough edges,
> and occasional bugs between builds. Feedback and bug reports are welcome.

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
- Three camera views — chase, driver, and drone — that the camera *travels*
  between rather than cutting, so `C` reads as a zoom in or out.
- WebGL2 rendering with neon lighting, particles, reflections, and a canvas HUD.
- Keyboard, gamepad, and touch input, with rebindable keys the interface reads
  back rather than assumes.
- Replay recording, the last-thirty-seconds save buffer, and highlight markers.
- A Tauri desktop build with a native launcher and persistent save data.
- A Rust simulation core compiled to WebAssembly, with no `wasm-bindgen`
  runtime dependency.

## Inspiration

SYNX is heavily inspired by *Power Drive 2000*, a stylized 1980s
science-fiction arcade racing game. That influence shows in SYNX's neon
presentation, retro-futurist atmosphere, and focus on immediate arcade driving.
SYNX is an independent project and is not affiliated with or endorsed by the
creators of *Power Drive 2000*.

For background, see the [Power Drive 2000 entry on IGDB](https://www.igdb.com/games/power-drive-2000).

## Download

Every push to `main` builds all four platforms and replaces the rolling
**[nightly release](https://github.com/suryanarayanrenjith/SYNX/releases/tag/nightly)**.
Tagged versions are published to
**[releases/latest](https://github.com/suryanarayanrenjith/SYNX/releases/latest)**.

| Platform | File |
| --- | --- |
| Windows | `-windows-x86_64-setup.exe`, or `-portable.zip` to run without installing |
| Linux | `-linux-x86_64.deb`, `.rpm`, or `.tar.gz` for any other distribution |
| macOS (Apple silicon) | `-macos-apple-silicon.dmg` |
| macOS (Intel) | `-macos-intel.dmg` |

`SHA256SUMS.txt` covers every file in the release.

The builds are not code-signed. Windows SmartScreen prompts once (**More info →
Run anyway**); macOS refuses a double-click, so open the app from the
right-click menu the first time, or run
`xattr -dr com.apple.quarantine /Applications/SYNX.app`. The Linux packages are
built on Debian 12 and need glibc 2.36 or newer and a WebKitGTK 4.1 runtime.

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
python tools/build.py --all       # ...with tests, checks and browser smoke tests
python tools/build.py --run       # ...and launch it
```

To produce the installers and packages a release carries:

```sh
python tools/build.py --target x86_64-pc-windows-msvc --bundles nsis
python tools/release.py --target x86_64-pc-windows-msvc
```

`build.py` needs a Tauri CLI for the bundle step
(`npm i -g @tauri-apps/cli@^2` or `cargo install tauri-cli --version "^2"`).
`release.py` renames what the bundler produced, builds the portable archive,
and writes the checksums into `dist/`.

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

| Action | Keyboard |
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

These are defaults. Every row is rebindable from the CONTROLS screen, and the
interface reads the live bindings — the boost meter, the race-mode readout and
the pre-race card name the key you actually have bound.

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
| [`tools`](tools) | Build, release, asset, check, smoke-test, and browser-probe tooling. |
| [`.github/workflows`](.github/workflows) | The release pipeline: four platforms, built and published on every push. |
| [`assets-src`](assets-src) | Local asset source directory generated from the shipped archive. |

The simulation core and recorder are compiled to WebAssembly. JavaScript maps
the core's linear memory through a small hand-written C ABI, while the desktop
host embeds the built `web/` directory into the application.

## Development commands

```sh
cargo test --workspace --release        # the Rust unit tests
python tools/check.py                   # the non-browser checks
python tools/check.py --list            # ...and what they are
python tools/build.py --test --check --no-host
```

The checks cover shader and DOM consistency, settings, rendering data, car
geometry, multiplayer protocol compatibility, story flow, ramps, recording,
radio, and AI behavior. Browser-dependent checks run through `tools/smoke.py`
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

SYNX is in open beta and under active development. The project is usable, but
compatibility, balance, visuals, and content may change as the game evolves.

## Credits

Created by:

- [Suryanarayan Renjith](https://github.com/suryanarayanrenjith)
- [Shivansh Mukhia](https://github.com/smsolutionsva-byte)

## License

No license file is currently included in this repository. Please contact the
creators before redistributing the code or bundled assets.
