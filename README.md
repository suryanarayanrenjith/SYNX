<div align="center">
  <img src="web/favicon.png" alt="SYNX logo" width="128">
  <h1>SYNX</h1>
  <p><strong>Synthwave eXtreme Racing</strong></p>
  <p>A neon arcade racer with drifting, ramps, jumps, rival AI, and a Rust-powered simulation core.</p>

  <p>
    <a href="https://synx-racing.vercel.app/">Project website</a>
    &nbsp;&middot;&nbsp;
    <a href="https://github.com/suryanarayanrenjith/SYNX">Repository</a>
  </p>
</div>

<p align="center">
  <img src="https://github.com/user-attachments/assets/97d22c17-1ccd-4873-9e18-f04668b8cb9f" alt="SYNX gameplay: drifting and jumping from a ramp" width="900">
</p>

> **Open beta:** SYNX is actively being developed. Expect changes, rough edges,
> and occasional bugs between builds. Feedback and bug reports are welcome.

> **Photosensitivity warning:** SYNX contains rapidly flashing lights,
> high-contrast strobing, and saturated neon effects. If you or someone in your
> family has a photosensitive condition, consult a doctor before playing. The
> game displays this warning at launch.

## Overview

SYNX is a short, high-energy racing experience built around the feeling of
throwing a car into a corner, holding a slide, and launching off a ramp. The
game combines arcade accessibility with a four-wheel vehicle model, terrain
and ramp interaction, rival drivers, and a neon WebGL2 presentation.

The current game includes a seven-chapter campaign on a 173 km road, free roam,
replay recording, multiple graphics options, and an online multiplayer mode
backed by a separate server project. The campaign travels through coastal,
canyon, mesa, city, volcanic, industrial, and elevated neon environments.

## Features

- Drift-focused arcade driving with throttle, braking, steering, boost, and
  vehicle recovery.
- Ramps, jumps, landings, and surface-aware vehicle pitch.
- Rival AI that uses the same simulation foundation as the player's vehicle.
- Seven campaign chapters, free roam, and multiplayer modes.
- WebGL2 rendering with neon lighting, particles, reflections, and a canvas HUD.
- Keyboard, gamepad, and touch input support.
- Replay recording, the last-thirty-seconds save buffer, and highlight markers.
- A Tauri desktop build with a native launcher and persistent save data.
- A Rust simulation core compiled to WebAssembly, with no `wasm-bindgen` runtime
  dependency.

## Inspiration

SYNX is heavily inspired by *Power Drive 2000*, a stylized 1980s science-fiction
arcade racing game. That influence can be seen in SYNX's neon presentation,
retro-futurist atmosphere, and focus on immediate arcade driving. SYNX is an
independent project and is not affiliated with or endorsed by the creators of
*Power Drive 2000*.

For background, see the [Power Drive 2000 entry on IGDB](https://www.igdb.com/games/power-drive-2000).

## Play

### Project website

The public Vercel deployment is the SYNX landing page and project website. It
does **not** host the playable game:

**[Visit the SYNX website](https://synx-racing.vercel.app/)**

### Local frontend

For development and renderer checks, serve `web/` over HTTP. Opening
`index.html` directly is not supported because the frontend loads WebAssembly
and other game assets through a web server.

```sh
cd web
python -m http.server 8000
```

Then open <http://localhost:8000>. The supported player distribution is the
desktop build described below.

### Desktop build

The desktop host is built with Tauri and embeds the complete frontend. A
release build produces `target/release/synx.exe` on Windows and the equivalent
release binary for other supported desktop targets.

```sh
python tools/build.py
```

Build, run the Rust tests, execute the repository checks, and run browser smoke
tests with:

```sh
python tools/build.py --all
```

Build and launch the release binary with:

```sh
python tools/build.py --run
```

The optional installer path is available through:

```sh
python tools/build.py --bundle
```

## Requirements

- Python 3.
- Rust and Cargo with the `wasm32-unknown-unknown` target installed.
- A WebGL2-capable browser for local frontend development and smoke checks.
- Node.js is used by some JavaScript checks and is optional for a basic build.
- Tauri's desktop prerequisites are required for the native executable. On
  Windows, this includes WebView2 and the normal Rust desktop build tools.

Install the WebAssembly target once with:

```sh
rustup target add wasm32-unknown-unknown
```

The core build and asset archive tools do not require a JavaScript package
install. Optional image and audio asset commands may require `numpy` and
`soundfile`; the tools report missing optional dependencies when needed.

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
| [`tools`](tools) | Build, asset, check, smoke-test, and browser-probe tooling. |
| [`assets-src`](assets-src) | Local asset source directory generated from the shipped archive. |

The simulation core and recorder are compiled to WebAssembly. JavaScript maps
the core's linear memory through a small hand-written C ABI, while the desktop
host embeds the built `web/` directory into the application.

## Development commands

Run the Rust tests directly:

```sh
cargo test -p synx-core
cargo test -p synx-net
cargo test -p synx-rec
```

Run the repository's non-browser checks:

```sh
python tools/check.py
python tools/check.py --list
```

The checks cover shader and DOM consistency, settings, rendering data, car
geometry, multiplayer protocol compatibility, story flow, ramps, recording,
radio, and AI behavior. Browser-dependent checks are run through
`tools/smoke.py` and the `--all` build path.

## Asset pipeline

`web/data/synx.pak` is the shipped asset archive. `assets-src/` is a working
directory and can be reconstructed from that archive:

```sh
python tools/assets.py unpack
python tools/assets.py list
python tools/assets.py check
```

After editing source assets, rebuild the archive with:

```sh
python tools/assets.py pack
```

PNG optimisation, atlas cleanup, generated textures, scene processing, and
landing sound synthesis are available through the other `assets.py` commands.

## Related project

The multiplayer server is maintained separately:

**[SYNX multiplayer server](https://github.com/suryanarayanrenjith/synx-server)**

The client and server share the protocol implementation through
`crates/synx-net`; the server is not built by this repository's desktop build.

## Status

SYNX is currently in open beta and is under active development. The project is
usable, but compatibility, balance, visuals, and content may change as the
game evolves.

## Credits

Created by:

- [Suryanarayan Renjith](https://github.com/suryanarayanrenjith)
- [Shivansh Mukhia](https://github.com/smsolutionsva-byte)

## License

No license file is currently included in this repository. Please contact the
creators before redistributing the code or bundled assets.
