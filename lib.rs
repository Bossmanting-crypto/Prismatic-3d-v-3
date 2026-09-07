//! Prism 3D Viewer — native shell.
//!
//! The renderer is a normal web document running in WebView2. This side
//! owns the things a web document cannot do: reading arbitrary paths,
//! native dialogs and menus, and storing per-model annotations.
//!
//! Opening a model is deliberately plain: the shell reads the bytes and
//! passes them over the IPC channel as raw binary, and the frontend wraps
//! each one in a blob. No custom URI scheme, no cross-origin request, no
//! CSP entry — none of which have anything to do with reading a file off
//! a local disk, and all of which are ways for it to fail.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};

// ── which extensions we open, and which we drag along beside a model ──
const MODEL_EXT: &[&str] = &["glb", "gltf", "obj", "fbx", "stl", "ply", "3mf", "dae"];
const ASSET_EXT: &[&str] = &[
    "bin", "mtl", "png", "jpg", "jpeg", "webp", "bmp", "gif", "tga", "dds", "ktx2", "hdr", "exr",
];

const MAX_FILES: usize = 500;
const MAX_ASSET_BYTES: u64 = 400 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1500 * 1024 * 1024;

/// Tokens handed to the webview, resolved back to real paths when it fetches them.
#[derive(Default)]
pub struct FileRegistry(Mutex<HashMap<String, PathBuf>>);

#[derive(Serialize)]
pub struct AssetRef {
    name: String,
    token: String,
    size: u64,
}

#[derive(Serialize)]
pub struct ModelBundle {
    model: String,
    dir: String,
    size: u64,
    files: Vec<AssetRef>,
}

#[derive(Serialize)]
pub struct RecentItem {
    path: String,
    name: String,
    dir: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    default_name: String,
    filters: Vec<SaveFilter>,
}

#[derive(Deserialize)]
pub struct SaveFilter {
    name: String,
    extensions: Vec<String>,
}

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn base_name(p: &Path) -> String {
    p.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("model")
        .to_string()
}

// ─────────────────────────── storage ───────────────────────────

fn store_path(app: &AppHandle, file: &str) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join(file)
}

fn read_store(app: &AppHandle, file: &str) -> Map<String, Value> {
    std::fs::read_to_string(store_path(app, file))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_store(app: &AppHandle, file: &str, map: &Map<String, Value>) {
    if let Ok(text) = serde_json::to_string(map) {
        let _ = std::fs::write(store_path(app, file), text);
    }
}

fn push_recent(app: &AppHandle, path: &Path) {
    let mut list: Vec<String> = std::fs::read_to_string(store_path(app, "recent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default();

    let p = path.to_string_lossy().to_string();
    list.retain(|x| !x.eq_ignore_ascii_case(&p));
    list.insert(0, p);
    list.truncate(12);

    if let Ok(text) = serde_json::to_string(&list) {
        let _ = std::fs::write(store_path(app, "recent.json"), text);
    }
}

// ─────────────────────────── commands ───────────────────────────

/// Register a model and everything sitting beside it, returning handles.
/// The webview resolves textures by file name, so a flat list is enough —
/// no directory structure has to survive the trip.
#[tauri::command]
fn read_model(
    app: AppHandle,
    registry: State<'_, FileRegistry>,
    path: String,
) -> Result<ModelBundle, String> {
    let model_path = PathBuf::from(&path);
    let ext = ext_of(&model_path);
    if !MODEL_EXT.contains(&ext.as_str()) {
        return Err(format!("Prism does not read .{ext} files."));
    }
    let meta = std::fs::metadata(&model_path).map_err(|e| e.to_string())?;
    let dir = model_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let mut map = registry.0.lock().map_err(|_| "registry poisoned")?;
    map.clear();

    let mut files: Vec<AssetRef> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let mut counter: usize = 0;

    let mut register = |map: &mut HashMap<String, PathBuf>,
                        files: &mut Vec<AssetRef>,
                        counter: &mut usize,
                        p: &Path,
                        size: u64| {
        *counter += 1;
        let token = format!("f{counter}");
        map.insert(token.clone(), p.to_path_buf());
        files.push(AssetRef {
            name: base_name(p),
            token,
            size,
        });
    };

    register(&mut map, &mut files, &mut counter, &model_path, meta.len());
    seen.push(model_path.to_string_lossy().to_ascii_lowercase());
    let mut total = meta.len();

    // the model's own folder, then one level of subfolders (textures/, maps/…)
    let mut dirs = vec![dir.clone()];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                dirs.push(e.path());
            }
        }
    }

    for d in dirs {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            if files.len() >= MAX_FILES {
                break;
            }
            let p = e.path();
            if p.is_dir() || !ASSET_EXT.contains(&ext_of(&p).as_str()) {
                continue;
            }
            let key = p.to_string_lossy().to_ascii_lowercase();
            if seen.contains(&key) {
                continue;
            }
            let size = match std::fs::metadata(&p) {
                Ok(m) if m.len() <= MAX_ASSET_BYTES => m.len(),
                _ => continue,
            };
            if total + size > MAX_TOTAL_BYTES {
                continue;
            }
            total += size;
            seen.push(key);
            register(&mut map, &mut files, &mut counter, &p, size);
        }
    }

    drop(map);
    push_recent(&app, &model_path);

    Ok(ModelBundle {
        model: base_name(&model_path),
        dir: dir.to_string_lossy().to_string(),
        size: meta.len(),
        files,
    })
}

/// Hand one registered file to the frontend as raw bytes.
///
/// This is deliberately boring. An earlier version served files over a
/// custom URI scheme, which meant the scheme differed per platform, the
/// request was cross-origin, and CSP had to allow it — three ways for a
/// local file read to fail for reasons that have nothing to do with the
/// file. `Response` sends the bytes straight through the IPC channel
/// without JSON-encoding them.
#[tauri::command]
fn read_asset(
    registry: State<'_, FileRegistry>,
    token: String,
) -> Result<tauri::ipc::Response, String> {
    let path = registry
        .0
        .lock()
        .map_err(|_| "registry unavailable".to_string())?
        .get(&token)
        .cloned()
        .ok_or_else(|| format!("unknown file handle {token}"))?;

    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.to_string_lossy()))?;

    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn pick_model(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Open a 3D model")
        .add_filter("All 3D models", MODEL_EXT)
        .add_filter("glTF", &["glb", "gltf"])
        .add_filter("Wavefront OBJ", &["obj"])
        .add_filter("Autodesk FBX", &["fbx"])
        .add_filter("Stereolithography", &["stl"])
        .add_filter("Polygon", &["ply"])
        .add_filter("3D Manufacturing", &["3mf"])
        .add_filter("Collada", &["dae"])
        .pick_file(move |f| {
            let _ = tx.send(f);
        });
    rx.await.ok().flatten().and_then(file_path_string)
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Open a folder containing a model")
        .pick_folder(move |f| {
            let _ = tx.send(f);
        });
    let dir = rx.await.ok().flatten().and_then(file_path_string)?;
    largest_model_in(Path::new(&dir), 0).map(|p| p.to_string_lossy().to_string())
}

fn largest_model_in(dir: &Path, depth: u8) -> Option<PathBuf> {
    if depth > 2 {
        return None;
    }
    let mut best: Option<(u64, PathBuf)> = None;
    let entries = std::fs::read_dir(dir).ok()?;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(found) = largest_model_in(&p, depth + 1) {
                let size = std::fs::metadata(&found).map(|m| m.len()).unwrap_or(0);
                if best.as_ref().map_or(true, |(b, _)| size > *b) {
                    best = Some((size, found));
                }
            }
        } else if MODEL_EXT.contains(&ext_of(&p).as_str()) {
            let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            if best.as_ref().map_or(true, |(b, _)| size > *b) {
                best = Some((size, p));
            }
        }
    }
    best.map(|(_, p)| p)
}

fn file_path_string(f: FilePath) -> Option<String> {
    match f {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        FilePath::Url(u) => u
            .to_file_path()
            .ok()
            .map(|p| p.to_string_lossy().to_string()),
    }
}

#[tauri::command]
async fn save_dialog(app: AppHandle, req: SaveRequest) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_file_name(&req.default_name);
    for f in &req.filters {
        let exts: Vec<&str> = f.extensions.iter().map(|s| s.as_str()).collect();
        builder = builder.add_filter(&f.name, &exts);
    }
    builder.save_file(move |f| {
        let _ = tx.send(f);
    });
    rx.await.ok().flatten().and_then(file_path_string)
}

/// Written in bounded chunks so a large export never has to exist
/// twice: once as a JS string and once as a Rust buffer.
#[tauri::command]
fn write_chunk(path: String, chunk: String, append: bool) -> Result<String, String> {
    use base64::Engine;
    use std::io::Write;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk.as_bytes())
        .map_err(|e| e.to_string())?;

    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&path)
        .map_err(|e| e.to_string())?;

    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(base_name(Path::new(&path)))
}

#[tauri::command]
fn get_notes(app: AppHandle, kind: String, key: String) -> Option<Value> {
    let file = if kind == "views" {
        "views.json"
    } else {
        "labels.json"
    };
    read_store(&app, file).get(&key).cloned()
}

#[tauri::command]
fn set_notes(app: AppHandle, kind: String, key: String, list: Value) -> bool {
    let file = if kind == "views" {
        "views.json"
    } else {
        "labels.json"
    };
    let mut map = read_store(&app, file);
    let empty = list.as_array().map_or(true, |a| a.is_empty());
    if empty {
        map.remove(&key);
    } else {
        map.insert(key, list);
    }
    write_store(&app, file, &map);
    true
}

#[tauri::command]
fn recent_list(app: AppHandle) -> Vec<RecentItem> {
    std::fs::read_to_string(store_path(&app, "recent.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Vec<String>>(&t).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .map(|p| {
            let path = PathBuf::from(&p);
            RecentItem {
                name: base_name(&path),
                dir: path
                    .parent()
                    .map(|d| d.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: p,
            }
        })
        .collect()
}

#[tauri::command]
fn set_title(window: WebviewWindow, title: String) {
    let t = if title.is_empty() {
        "Prism 3D Viewer".to_string()
    } else {
        format!("{title} — Prism 3D Viewer")
    };
    let _ = window.set_title(&t);
}

#[tauri::command]
fn reveal(path: String) {
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &path;
    }
}

// ─────────────────────────── menu ───────────────────────────

/// Menu ids carry their payload as `group:value`, which keeps the
/// renderer's existing command handler unchanged.
fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let mi = |id: &str, label: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::new(label).id(id);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let file = SubmenuBuilder::new(app, "File")
        .item(&mi("open", "Open model…", Some("CmdOrCtrl+O"))?)
        .item(&mi(
            "open-folder",
            "Open folder…",
            Some("CmdOrCtrl+Shift+O"),
        )?)
        .separator()
        .item(&mi("screenshot", "Save screenshot…", Some("CmdOrCtrl+P"))?)
        .item(&mi("export:glb", "Convert and save as GLB", None)?)
        .item(&mi("export:gltf", "Convert and save as glTF", None)?)
        .item(&mi("export:obj", "Convert and save as OBJ", None)?)
        .item(&mi("export:stl", "Convert and save as STL", None)?)
        .item(&mi("export:ply", "Convert and save as PLY", None)?)
        .separator()
        .item(&mi("close-model", "Close model", Some("CmdOrCtrl+W"))?)
        .item(&PredefinedMenuItem::quit(app, Some("Exit"))?)
        .build()?;

    let stage = SubmenuBuilder::new(app, "Stage")
        .item(&mi("env:atmos", "Atmosphere", None)?)
        .item(&mi("env:hangar", "Hangar deck", None)?)
        .item(&mi("env:void", "Black void", None)?)
        .item(&mi("env:studio", "Studio sweep", None)?)
        .item(&mi("env:blueprint", "Blueprint", None)?)
        .item(&mi("env:dusk", "Dusk horizon", None)?)
        .item(&mi("env:overcast", "Overcast", None)?)
        .item(&mi("env:envmap", "Environment map", None)?)
        .item(&mi("env:custom", "Flat colour", None)?)
        .separator()
        .item(&mi("cycle-stage", "Next stage", Some("B"))?)
        .build()?;

    let lens = SubmenuBuilder::new(app, "Lens")
        .item(&mi("lens:off", "Off", None)?)
        .item(&mi("lens:clean", "Clean glass", None)?)
        .item(&mi("lens:cinematic", "Cinematic", None)?)
        .item(&mi("lens:anamorph", "Anamorphic", None)?)
        .item(&mi("lens:pursuit", "Pursuit", None)?)
        .item(&mi("lens:overdrive", "Overdrive", None)?)
        .separator()
        .item(&mi("cycle-lens", "Next lens", Some("L"))?)
        .build()?;

    let ground = SubmenuBuilder::new(app, "Ground")
        .item(&mi("ground:pad", "Instrument deck", None)?)
        .item(&mi("ground:grid", "Grid", Some("CmdOrCtrl+G"))?)
        .item(&mi("ground:shadow", "Shadow only", None)?)
        .item(&mi("ground:none", "Nothing", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&mi("shading:shaded", "Shaded", Some("CmdOrCtrl+1"))?)
        .item(&mi("shading:wire", "Wireframe", Some("CmdOrCtrl+2"))?)
        .item(&mi(
            "shading:both",
            "Shaded + wireframe",
            Some("CmdOrCtrl+3"),
        )?)
        .item(&mi("shading:clay", "Clay", Some("CmdOrCtrl+4"))?)
        .item(&mi("shading:normals", "Normals", Some("CmdOrCtrl+5"))?)
        .item(&mi("shading:uv", "UV check", Some("CmdOrCtrl+6"))?)
        .separator()
        .item(&stage)
        .item(&lens)
        .item(&ground)
        .separator()
        .item(&mi("toggle:cAxes", "Axis marker", None)?)
        .item(&mi("toggle:cParticles", "Drifting motes", None)?)
        .item(&mi("toggle:cRays", "Light shafts", None)?)
        .item(&mi("toggle:cVignette", "Vignette", None)?)
        .item(&mi("toggle-panel", "Side panel", Some("CmdOrCtrl+B"))?)
        .separator()
        .item(&PredefinedMenuItem::fullscreen(app, Some("Full screen"))?)
        .build()?;

    let camera = SubmenuBuilder::new(app, "Camera")
        .item(&mi("view:fit", "Fit to model", Some("F"))?)
        .separator()
        .item(&mi("view:front", "Front", Some("Shift+1"))?)
        .item(&mi("view:back", "Back", Some("Shift+2"))?)
        .item(&mi("view:left", "Left", Some("Shift+3"))?)
        .item(&mi("view:right", "Right", Some("Shift+4"))?)
        .item(&mi("view:top", "Top", Some("Shift+5"))?)
        .item(&mi("view:bottom", "Bottom", Some("Shift+6"))?)
        .item(&mi("view:iso", "Isometric", None)?)
        .separator()
        .item(&mi("nav:orbit", "Orbit", None)?)
        .item(&mi("nav:fps", "Walk through", None)?)
        .separator()
        .item(&mi("proj:persp", "Perspective", None)?)
        .item(&mi("proj:ortho", "Orthographic", None)?)
        .build()?;

    let tools = SubmenuBuilder::new(app, "Tools")
        .item(&mi("annotate", "Label a part", Some("A"))?)
        .item(&mi("clear-labels", "Remove all labels", None)?)
        .separator()
        .item(&mi("add-view", "Save current view", Some("CmdOrCtrl+D"))?)
        .item(&mi(
            "add-part-view",
            "Save view of selected part",
            Some("CmdOrCtrl+Shift+D"),
        )?)
        .item(&mi("std-views", "Restore the standard set", None)?)
        .separator()
        .item(&mi("measure", "Measure distances", Some("M"))?)
        .item(&mi("clear-measure", "Clear measurements", None)?)
        .item(&mi("show-all", "Show every object", None)?)
        .build()?;

    let help = SubmenuBuilder::new(app, "Help")
        .item(&mi("help", "Keyboard shortcuts", Some("F1"))?)
        .item(&mi("about", "About Prism", None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&file, &view, &camera, &tools, &help])
        .build()
}

fn emit_command(app: &AppHandle, id: &str) {
    let (name, value) = match id.split_once(':') {
        Some((a, b)) => (a, Some(b.to_string())),
        None => (id, None),
    };
    let _ = app.emit("command", serde_json::json!({ "id": name, "value": value }));
}

// ─────────────────────────── entry point ───────────────────────────

fn first_model_arg(args: &[String]) -> Option<String> {
    args.iter()
        .skip(1)
        .find(|a| !a.starts_with('-') && MODEL_EXT.contains(&ext_of(Path::new(a)).as_str()))
        .cloned()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance has to be registered first, and dialog must be
        // registered at all: app.dialog() reads managed state and panics
        // without it.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
                let _ = w.unminimize();
            }
            if let Some(p) = first_model_arg(&argv) {
                let _ = app.emit("open-path", p);
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(FileRegistry::default())
        .invoke_handler(tauri::generate_handler![
            read_model,
            read_asset,
            pick_model,
            pick_folder,
            save_dialog,
            write_chunk,
            get_notes,
            set_notes,
            recent_list,
            set_title,
            reveal
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            app.set_menu(menu)?;

            app.on_menu_event(move |app, event| {
                emit_command(app, event.id().as_ref());
            });

            // a model passed on the command line, e.g. from a double-click in Explorer
            if let Some(p) = first_model_arg(&std::env::args().collect::<Vec<_>>()) {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(900));
                    let _ = h.emit("open-path", p);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to start Prism");
}
