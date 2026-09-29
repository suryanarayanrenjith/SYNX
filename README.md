<div align="center">
  <img src="web/favicon.png" alt="SYNX logo" width="120">
  <h1>SYNX</h1>
  <p><strong>Synthwave eXtreme Racing</strong><br>
  A neon arcade racer about sliding a car through a corner and launching it off a ramp.</p>

  <p>
    <a href="https://github.com/suryanarayanrenjith/SYNX/releases/latest"><img alt="Latest beta" src="https://img.shields.io/github/v/release/suryanarayanrenjith/SYNX?include_prereleases&label=latest%20beta&color=ff2e88"></a>
    <img alt="Platforms" src="https://img.shields.io/badge/platforms-Windows%20%7C%20macOS%20%7C%20Linux-39e6ff">
  </p>

  <p>
    <a href="https://github.com/suryanarayanrenjith/SYNX/releases/latest"><b>Download</b></a>
    &nbsp;&middot;&nbsp;
    <a href="https://synx-racing.vercel.app/">Website</a>
    &nbsp;&middot;&nbsp;
    <a href="#install">Install</a>
    &nbsp;&middot;&nbsp;
    <a href="#controls">Controls</a>
  </p>
</div>

> [!WARNING]
> **Photosensitivity:** SYNX has rapidly flashing lights, strobing and saturated
> neon. If you or anyone in your family has a photosensitive condition, talk to
> a doctor before playing.

> [!NOTE]
> SYNX is in **open beta**. Every build is a beta, so expect rough edges -
> bug reports and feedback are very welcome.

https://github.com/user-attachments/assets/97d22c17-1ccd-4873-9e18-f04668b8cb9f

## What it is

Throw the car into a bend, hold the slide, hit the boost and fly off the next
ramp. SYNX is a short, loud, neon racing game with a real four-wheel car
underneath the arcade feel.

- **A seven-chapter story** along one 173 km road - coast, canyon, desert,
  city, volcano, factory and a neon skyway.
- **Free Roam** to drive the whole road at your own pace, and **online
  multiplayer**.
- **Drifting, ramps and jumps**, rival drivers, boost and a race mode.
- **Three cameras** - chase, driver's seat and drone.
- **Instant replays** - keep the last thirty seconds and save the best bits.
- **Keyboard, controller or touch**, with every key rebindable.
- **Runs on modest hardware** - it picks sensible settings on first launch and
  lowers the resolution on its own if a machine falls behind.

## Install

### One line

**macOS and Linux** - picks the right package for your system (`.dmg`,
`.deb`, `.rpm` or `.tar.gz`):

```sh
# download it
curl -fsSL https://synx-racing.vercel.app/get-synx.sh | sh

# download it and install it
curl -fsSL https://synx-racing.vercel.app/get-synx.sh | sh -s -- --install
```

**Windows** (PowerShell) - downloads the installer:

```powershell
irm https://synx-racing.vercel.app/get-synx.ps1 | iex
```

Prefer the portable zip? Run `$env:SYNX_FORMAT="portable"` first.

Both scripts check the download against the release's published checksums and
delete it if it does not match.

### Or download it yourself

Grab the newest build from the
**[releases page](https://github.com/suryanarayanrenjith/SYNX/releases/latest)**:

| System | File |
| --- | --- |
| Windows | `…-windows-x86_64-setup.exe`, or `…-portable.zip` to run without installing |
| macOS (Apple silicon) | `…-macos-apple-silicon.dmg` |
| macOS (Intel) | `…-macos-intel.dmg` |
| Linux | `…-linux-x86_64.deb`, `.rpm`, or `.tar.gz` |

### First launch

The builds are not code-signed yet, so your system will ask once:

- **Windows:** on the SmartScreen prompt choose **More info**, then **Run anyway**.
- **macOS:** right-click the app and choose **Open** the first time
  (or run `xattr -dr com.apple.quarantine /Applications/SYNX.app`).
- **Linux:** needs a WebKitGTK 4.1 runtime (installed with most desktops).

## Controls

| Action | Keyboard | Controller |
| --- | --- | --- |
| Steer | `←` `→` or `A` `D` | Left stick |
| Accelerate / brake | `↑` `↓` or `W` `S` | `RT` / `LT` |
| Drift | Hold `Space` | `B` or `LB` |
| Boost | `B` | `A` or `RB` |
| Race mode | `R` | `X` |
| Change camera | `C` | - |
| Pause | `Esc` | `Start` |
| Replays: record / save / mark | `F8` / `F9` / `F10` | - |

Everything can be rebound from **Controls** in the main menu, and a connected
controller works on every screen of the game.

## Tips for smoother play

- On the launcher, **Graphics → Preset** is the biggest single change;
  **Render scale** below Native is the next.
- Leave **Adaptive resolution** on - it only lowers the resolution when your
  machine actually needs it.
- **Benchmark** on the launcher measures your machine and suggests settings.
- **Linux laptops with NVIDIA + Intel graphics:** with NVIDIA's driver
  installed, SYNX now runs on the NVIDIA GPU automatically. If the window ever
  stays black, start it with `SYNX_PRIME=0` to go back to the default GPU.

## Credits

Created by [Suryanarayan Renjith](https://github.com/suryanarayanrenjith) and
[Shivansh Mukhia](https://github.com/smsolutionsva-byte).

The multiplayer server lives in its own repository:
[synx-server](https://github.com/suryanarayanrenjith/synx-server).

### Where it comes from

SYNX is a rebuild of *Power Drive 2000*, an unreleased 1980s-style arcade racer
by Megacom Games that was funded on Kickstarter in 2015 but only ever shipped a
Windows pre-alpha demo
([itch.io](https://megacomgames.itch.io/power-drive-2000-pre-alpha-demo),
[Internet Archive](https://archive.org/details/power-drive-2000-v-0.06)).

**The art is not original.** The car, road, tunnels, billboards, gantry, sky,
course layout and many textures come from that demo and have been converted
into this project's formats. Everything around them is new: the driving and
physics, the rival AI, the renderer, the interface, the story, the audio, the
multiplayer, the replays, the desktop app and the tools.

SYNX is an independent, non-commercial fan project. It is not affiliated with
or endorsed by Megacom Games, and makes no claim to *Power Drive 2000* or its
assets, which belong to their owner.

<details>
<summary><b>For developers</b></summary>

<br>

The simulation core is Rust compiled to WebAssembly, the game is WebGL2 and
JavaScript in [`web/`](web), and the desktop app is a Tauri host in
[`src-tauri/`](src-tauri).

You need Python 3 and Rust with the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`), plus Tauri's desktop
prerequisites for the native app.

```sh
python tools/build.py          # build the game
python tools/build.py --run    # ...and launch it
python tools/build.py --all    # with tests, checks and browser smoke tests
python tools/check.py --list   # the non-browser checks
```

To try the frontend in a browser, serve `web/` over HTTP
(`cd web && python -m http.server 8000`) - opening `index.html` directly will
not load the WebAssembly.

| Path | What is in it |
| --- | --- |
| [`crates/synx-core`](crates/synx-core) | Course, vehicle physics, terrain, particles, rival AI and the WebAssembly ABI |
| [`crates/synx-net`](crates/synx-net) | Multiplayer wire format shared with the server |
| [`crates/synx-rec`](crates/synx-rec) | Replay ring and video encoding |
| [`web`](web) | Renderer, HUD, game modes, story, audio |
| [`src-tauri`](src-tauri) | Desktop host, launcher, saves and diagnostics |
| [`tools`](tools) | Build, release, asset, check and smoke-test tooling |

Every push to `main` builds all four platforms and publishes a new beta, with a
`SHA256SUMS.txt` covering every file.

</details>

## License

No license file is included yet. See [Where it comes from](#where-it-comes-from)
for the status of the art.
