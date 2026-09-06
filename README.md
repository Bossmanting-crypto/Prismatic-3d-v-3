# Prism 3D Viewer

A Windows desktop app for opening, inspecting, measuring, annotating and converting
3D models. Reads GLB, glTF, OBJ, FBX, STL, PLY, 3MF and DAE.

Built on **Tauri 2**: a small Rust shell around WebView2, with the viewer itself running
as WebGL 2. Nothing is uploaded, and after the one-time build the app never touches the
network.

---

## Why this stack

WebView2 is Chromium, so it renders through the same ANGLE to Direct3D 11 path a browser
uses. That matters because two things this app leans on have no cheap native equivalent:
`backdrop-filter` for the glass panels, and a full WebGL 2 post-processing chain for the
lens. A C++ build with Assimp and ImGui would start faster and ship smaller, but both of
those would have to be rebuilt from scratch.

What Tauri buys over an Electron build of the same thing:

| | Electron | Tauri 2 |
| --- | --- | --- |
| Installer | ~90 MB | ~8-12 MB |
| Installed size | ~250 MB | ~15 MB |
| Bundled browser | Yes, its own Chromium | No, uses the system WebView2 |
| Memory at idle | Higher, two Node runtimes | Lower, one Rust process |
| Rendering | Chromium | The same Chromium |

Model files are **streamed, not copied**. The shell registers a `model://` protocol and
hands the webview URLs; the loaders read straight off disk. A 300 MB scene is never
duplicated in memory, which the Electron version could not avoid.

---

## Build it

You need, once:

- [Node.js 18+](https://nodejs.org)
- [Rust](https://rustup.rs) 1.77 or newer
- Visual Studio Build Tools with the **Desktop development with C++** workload

Then:

```bat
npm install
npm run dev      :: run it
npm run build    :: produce the installer
```

Or just double-click **`build.bat`**, which checks the toolchain versions first and
opens the output folder when it finishes.

The installer lands in `src-tauri\target\release\bundle\nsis\`. It registers the
eight model extensions, so double-clicking a `.glb` in Explorer opens Prism.

After `npm install` the network is never used again. three.js is vendored into the
package at build time, the Draco and Basis decoders load from local files, and there is
no remote URL anywhere in the shipped source.

**WebView2** ships with Windows 11 and reaches almost every Windows 10 machine through
Edge. The installer is configured with `downloadBootstrapper`, so on the rare machine
without it, it is fetched during install. To make the installer fully self-contained
instead, change `webviewInstallMode` in `src-tauri/tauri.conf.json` to
`embedBootstrapper` or `offlineInstaller`.

The build is unsigned, so first launch shows SmartScreen. Choose **More info -> Run
anyway**, or add a `certificateThumbprint` under `bundle.windows`.

### Building on GitHub instead

`.github/workflows/build.yml` builds the installer on a Windows runner, so you do not
need Rust or Build Tools locally. It runs on every push to `main`, on pull requests, and
on demand from the Actions tab.

- A fast Linux job syntax-checks the renderer and proves the three.js import graph still
  resolves, before spending Windows minutes.
- The Windows job builds and attaches the installer as a downloadable artifact, kept for
  30 days.
- Pushing a tag such as `v1.0.0` also publishes a GitHub Release with the installer
  attached.

The Rust dependency build is cached, so the first run takes about ten minutes and later
ones under two.

If your repository has the project in a subfolder, change `PROJECT_DIR` at the top of the
workflow from `.` to that folder name.

---

## Using it

Open from **File -> Open model** (`Ctrl+O`), drag a file onto the window, or
double-click a model in Explorer. Textures and `.bin` buffers beside the file are picked
up automatically, including one level of subfolders.

### Getting around

| | |
| --- | --- |
| Orbit / pan / zoom | Left-drag / right-drag / scroll |
| Re-centre on a point | Double-click a surface |
| Walk through | Camera -> Walk through, then W A S D, E and Q, Shift to sprint |
| Fit to model | `F` |
| Axis views | `Shift`+`1`-`6` |
| Saved views | `1`-`9`, `0`, `-`, `=` |
| Cycle stage / lens | `B` / `L` |
| Label a part | `A` |
| Measure | `M` |

### Labels

Press `A` and click any surface. A label drops with a leader line back to the point you
clicked, the way a cutaway diagram works: the line points, so the box never covers what
it names. Drag a label to reposition it. Click it to read its note, then **Edit** to give
it a paragraph.

Labels bind to the mesh under the click, so they follow that part under animation and
hide when you hide it. Labels behind geometry dim. Everything is saved against the
model's path and reloads with the file.

### Views

Seven standard views are laid down on first open. `Ctrl+D` saves the current camera;
`Ctrl+Shift+D` saves a view of the part selected in the scene tree and remembers which
part it belongs to. Twelve fit, one per key.

### Stages and lens

Nine stages, each a complete rig -- sky gradient, key/fill/rim lights, exposure, fog and
ground treatment. **Atmosphere** is the default: drifting motes, a shaft of light and a
deep vignette. The motes are real 3D points that parallax as you orbit, animated in the
vertex shader so 760 of them cost two uniform writes a frame. The light shafts are a
screen-space layer.

The lens is a real post chain: render to a floating-point buffer, bloom, then smear
bright areas along fixed axes with the spectrum walking outward along each smear, then
composite over a chromatically split frame. Six presets from **Off** to **Overdrive**,
with an Amount slider to sit anywhere between two of them. Antialiasing moves to a 4x
multisampled off-screen target when it is on; the status bar shows the real per-frame
draw count.

### Measuring and converting

`M`, then click two points. `Shift` snaps to the nearest vertex. Set **Model unit** to
match how the file was authored and every reading follows, including the bounding
dimensions, surface area and volume. Volume assumes a closed mesh.

Export to GLB, glTF, OBJ, STL or PLY. Display modes never leak into the file.

Screenshots render at up to 4x and redraw the labels and light shafts onto the image,
since both are browser layers rather than 3D objects.

---

## Layout

```
index.html        Markup and styling
bridge.js         The only file that knows it is running under Tauri
app.js            The viewer: scene, loaders, stages, views, labels, tools
lens.js           Post-processing: bloom, prismatic streaks, chromatic split
atmosphere.js     The drifting mote field
hud-pad.js        Draws the instrument deck and sky gradients to canvas
scripts/vendor.mjs Copies exactly the three.js files the app imports
src-tauri/        Rust shell: protocol, dialogs, menus, persistence
```

Two notes for anyone modifying it:

**The renderer knows nothing about Tauri.** It talks to `window.prism`, which `bridge.js`
implements. Swapping the shell again means rewriting one file.

**Vendoring follows the import graph.** `scripts/vendor.mjs` walks the real ES module
imports rather than a hand-kept list -- the first version used a list, dropped
`ktx-parse`, and KTX2Loader failed to resolve at load time. It ships 37 modules, about
4 MB, instead of the ~35 MB `examples/jsm` folder.

---

## Licence

MIT for this application. three.js, Tauri and Rust are all permissively licensed.
