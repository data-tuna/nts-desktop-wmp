// Skin code is untrusted, so it runs in its own webview ("skin"), a child of
// the main window drawn over the trusted page ("main"). No capability names
// the skin webview, so Tauri refuses every command from it, ours included
// (see build.rs). The two pages talk only through the `skin` protocol below;
// docs/decisions.md (ATA-107) has the message list.
#[cfg(windows)]
mod loopback;
mod skins;

use serde::Deserialize;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::http::{HeaderValue, Method, Request, Response, StatusCode};
use tauri::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, PhysicalPosition,
    PhysicalRect, Url, WebviewBuilder, WebviewUrl, WebviewWindowBuilder, Window, Wry,
};
use tauri_plugin_updater::UpdaterExt;
use tauri_plugin_window_state::{AppHandleExt as _, StateFlags, WindowExt as _};

const SKIN_PAGE: &str = include_str!("../../src/skin/index.html");

/// The skin engine, built from src/skin/ by `npm run build:skin`. A debug
/// build reads it from disk on each load, so the engine can be rebuilt
/// without rebuilding the app; a release build carries it.
fn engine_js() -> Vec<u8> {
    #[cfg(debug_assertions)]
    return std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../dist-skin/engine.js"
    ))
    .unwrap_or_else(|_| b"document.body.textContent = 'run npm run build:skin'".to_vec());
    #[cfg(not(debug_assertions))]
    include_bytes!("../../dist-skin/engine.js").to_vec()
}

/// Sent with everything the skin protocol serves. Skins need no network and
/// no frames: only their own files, inline scripts and `jscript:` eval.
const SKIN_CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; \
    style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'none'; \
    object-src 'none'; base-uri 'none'; form-action 'none'";

/// What a skin may ask for. Anything else, extra fields included, is refused
/// before it reaches the trusted page. Every variant has braces: serde ignores
/// `deny_unknown_fields` on the unit variants of an internally tagged enum.
#[derive(Deserialize, serde::Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum FromSkin {
    Play {},
    Pause {},
    Stop {},
    Next {},
    Previous {},
    /// A click on a playlist row: play that item (ATA-113).
    Select {
        index: u32,
    },
    Volume {
        value: f64,
    },
    Balance {
        value: f64,
    },
    Mute {
        value: bool,
    },
    /// Seconds into a pick (ATA-165). Live streams ignore it.
    Seek {
        seconds: f64,
    },
    Eq {
        band: u8,
        gain: f64,
    },
    /// The pointer went down on the skin's body: move the window.
    Drag {},
    /// The view's size, and its opaque area as `[x, y, width, height]` runs.
    Shape {
        width: u32,
        height: u32,
        rects: Vec<[u32; 4]>,
    },
    /// `view.close()` and the skin's close button: quit.
    Close {},
    /// `view.minimize()` and the skin's minimize button.
    Minimize {},
    /// `player.launchURL(url)`: open a web page in the default browser.
    LaunchUrl {
        url: String,
    },
    /// A right click on the skin: open the skin picker (ATA-112).
    Picker {},
    /// Whether a visualisation is on screen, so wants analyser frames.
    Effects {
        on: bool,
    },
    /// A right click on a visualisation: the trusted page shows the menu of
    /// effects, `effect` checked (ATA-190).
    EffectsMenu {
        effect: u32,
    },
}

/// Trusted page to skin: play state, time, title, levels, and analyser
/// frames for the visualisation. The trusted page is the only caller (the
/// skin webview has no capability for this command).
#[tauri::command]
fn skin_send(app: AppHandle, msg: serde_json::Value) -> Result<(), String> {
    let skin = app.get_webview("skin").ok_or("no skin webview")?;
    // A JSON value is a valid JS expression, so this cannot inject code.
    skin.eval(format!(
        "window.dispatchEvent(new MessageEvent('message', {{ data: {msg} }}))"
    ))
    .map_err(|e| e.to_string())
}

/// The newest samples the app itself played, as little-endian f32, for the
/// visualisation during a pick (ATA-199). Empty where there is no loopback.
#[tauri::command]
fn pick_audio(rate: u32) -> tauri::ipc::Response {
    #[cfg(windows)]
    let samples = loopback::latest(rate.clamp(8_000, 192_000));
    #[cfg(not(windows))]
    let samples: Vec<f32> = Vec::new();
    tauri::ipc::Response::new(
        samples
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect::<Vec<u8>>(),
    )
}

fn is_skin_url(url: &Url) -> bool {
    // Windows serves custom protocols as http://<scheme>.localhost.
    url.scheme() == "skin" || url.host_str() == Some("skin.localhost")
}

fn status(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder().status(code).body(Vec::new()).unwrap()
}

fn skin_protocol(app: &AppHandle, from: &str, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let mut res = respond(app, from, req);
    res.headers_mut().insert(
        "Content-Security-Policy",
        HeaderValue::from_static(SKIN_CSP),
    );
    res
}

fn respond(app: &AppHandle, from: &str, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    if from == "preview" {
        return respond_preview(app, req);
    }
    if from != "skin" {
        return status(StatusCode::FORBIDDEN);
    }
    let path = req.uri().path();
    match (req.method(), path) {
        (&Method::GET, "/") => Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .body(SKIN_PAGE.as_bytes().to_vec())
            .unwrap(),
        (&Method::GET, "/engine.js") => Response::builder()
            .header("Content-Type", "text/javascript; charset=utf-8")
            .body(engine_js())
            .unwrap(),
        // Butterchurn and its presets, asked for the first time Milkdrop shows (ATA-167).
        (&Method::GET, "/milkdrop.js") => Response::builder()
            .header("Content-Type", "text/javascript; charset=utf-8")
            .body([MILKDROP_NOTICE.as_bytes(), BUTTERCHURN, b"\n", PRESETS].concat())
            .unwrap(),
        (&Method::GET, "/skin.wmz") => skin_file(),
        // The skin page asks for it when a skin will not load.
        (&Method::GET, "/house.wmz") => {
            skins::wear_house();
            Response::builder().body(HOUSE_SKIN.to_vec()).unwrap()
        }
        (&Method::POST, "/msg") => match serde_json::from_slice::<FromSkin>(req.body()) {
            Ok(msg) => {
                handle(app, msg);
                status(StatusCode::NO_CONTENT)
            }
            Err(_) => status(StatusCode::BAD_REQUEST),
        },
        _ => status(StatusCode::NOT_FOUND),
    }
}

/// Milkdrop for the skin's visualisations (ATA-167), straight from npm. Each
/// preset's name credits its authors.
const BUTTERCHURN: &[u8] = include_bytes!("../../node_modules/butterchurn/lib/butterchurn.min.js");
const PRESETS: &[u8] =
    include_bytes!("../../node_modules/butterchurn-presets/lib/butterchurnPresetsMinimal.min.js");
const MILKDROP_NOTICE: &str =
    "/*! Butterchurn 2.6.7 and butterchurn-presets 2.4.7 (minimal pack).\n\
MIT License. Copyright (c) 2013-2018 Jordan Berg. The presets are by the\n\
MilkDrop authors their names credit.\n\n\
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and \
associated documentation files (the \"Software\"), to deal in the Software without restriction, \
including without limitation the rights to use, copy, modify, merge, publish, distribute, \
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is \
furnished to do so, subject to the following conditions:\n\n\
The above copyright notice and this permission notice shall be included in all copies or \
substantial portions of the Software.\n\n\
THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING \
BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND \
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, \
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT \
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */\n";

/// The house skin, built from skins/house/ by `npm run build:house`. It ships
/// in the binary, so the app has a skin with no network at all.
const HOUSE_SKIN: &[u8] = include_bytes!("../../skins/house/house.wmz");

/// How long the first paint waits for a skin still downloading before it
/// settles for the house skin. The download goes on into the cache.
const SKIN_WAIT: Duration = Duration::from_secs(8);

/// The .wmz named by NTS_WMP_SKIN (for testing a skin by hand), else the
/// skin worn now (skins.rs), else the house skin.
fn skin_file() -> Response<Vec<u8>> {
    let bytes = std::env::var_os("NTS_WMP_SKIN")
        .and_then(|path| {
            std::fs::read(&path)
                .inspect_err(|e| eprintln!("NTS_WMP_SKIN {path:?}: {e}; using the house skin"))
                .ok()
        })
        .or_else(|| skins::worn(SKIN_WAIT).map(|(_, bytes)| bytes.to_vec()))
        .unwrap_or_else(|| HOUSE_SKIN.to_vec());
    Response::builder().body(bytes).unwrap()
}

#[derive(serde::Serialize)]
struct SkinList {
    skins: Vec<PickerSkin>,
    /// The skin picked to wear on every launch; none for a random one.
    choice: Option<String>,
    /// The skin on the window now; none for the house skin.
    worn: Option<String>,
    /// Whether a skin is on its way.
    fetching: bool,
}

#[derive(serde::Serialize)]
struct PickerSkin {
    path: String,
    /// Its archive.org page, the credit.
    page: String,
    size: u64,
    cached: bool,
}

/// The picker's list: every skin marked as working.
#[tauri::command]
fn list_skins(app: AppHandle) -> SkinList {
    let (worn, fetching) = skins::status();
    SkinList {
        skins: skins::working()
            .map(|s| PickerSkin {
                path: s.path.clone(),
                page: skins::page(s).into(),
                size: s.size,
                cached: skins::is_cached(&app, s),
            })
            .collect(),
        choice: skins::choice(&app),
        worn: worn.map(|s| s.path.clone()),
        fetching,
    }
}

/// Wears `path` from now on, or with none a random skin each launch (and a
/// new one now). The skin webview reloads whatever happens: a skin that
/// fails gives the house skin, and the choice stays.
#[tauri::command]
async fn choose_skin(app: AppHandle, path: Option<String>) -> Result<(), String> {
    let skin = match &path {
        Some(p) => skins::find(p).ok_or_else(|| format!("{p} is not on the list"))?,
        None => skins::random().ok_or("no skins on the list")?,
    };
    skins::set_choice(&app, path)?;
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || skins::load(&app, skin)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(webview) = app.get_webview("skin") {
        let _ = webview.eval("location.reload()");
    }
    result
}

/// The picker's preview (ATA-193): the selected skin, drawn by the engine in
/// the `preview` webview, a child of the picker window that no capability
/// names, as the `skin` webview is. It runs the skin's scripts, but every
/// message it sends except its shape is dropped.
struct Preview {
    /// Bumped on each selection, so a late download is not shown.
    id: u64,
    bytes: Option<Arc<Vec<u8>>>,
    /// The pane to fit it in, `[x, y, width, height]` in CSS pixels.
    area: [f64; 4],
    /// The box around the skin's opaque runs, `[x, y, width, height]`, once
    /// drawn.
    size: Option<[u32; 4]>,
    /// Drawn, or given up on: what `preview_skin` waits for.
    done: Option<bool>,
}

static PREVIEW: Mutex<Preview> = Mutex::new(Preview {
    id: 0,
    bytes: None,
    area: [0.0; 4],
    size: None,
    done: None,
});
static PREVIEWED: Condvar = Condvar::new();

/// Shows the selected skin in the picker's pane: from the cache, or
/// downloaded into it (one skin per selection). Err means "No preview".
#[tauri::command]
async fn preview_skin(app: AppHandle, path: String) -> Result<(), String> {
    let skin = skins::find(&path).ok_or_else(|| format!("{path} is not on the list"))?;
    let id = {
        let mut p = PREVIEW.lock().unwrap();
        p.id += 1;
        p.bytes = None;
        p.size = None;
        p.done = None;
        p.id
    };
    if let Some(webview) = app.get_webview("preview") {
        let _ = webview.hide();
    }
    let bytes = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || skins::fetch(&app, skin)
    })
    .await
    .map_err(|e| e.to_string())??;
    {
        let mut p = PREVIEW.lock().unwrap();
        if p.id != id {
            return Err("another skin was selected".into());
        }
        p.bytes = Some(Arc::new(bytes));
    }
    // The id in the page's URL comes back as each request's Referer, so a
    // request from the page of an earlier selection is told apart.
    match app.get_webview("preview") {
        Some(webview) => webview.eval(format!("location.replace('/?preview={id}')")),
        None => {
            let picker = app.get_window("picker").ok_or("no picker")?;
            let builder = WebviewBuilder::new(
                "preview",
                WebviewUrl::CustomProtocol(
                    format!("skin://localhost/?preview={id}").parse().unwrap(),
                ),
            )
            .additional_browser_args(BROWSER_ARGS)
            .background_color(PREVIEW_BACKGROUND)
            .on_navigation(is_skin_url)
            .on_new_window(|_, _| NewWindowResponse::Deny);
            let webview = picker
                .add_child(
                    builder,
                    LogicalPosition::new(0.0, 0.0),
                    LogicalSize::new(1.0, 1.0),
                )
                .map_err(|e| e.to_string())?;
            webview.hide()
        }
    }
    .map_err(|e| e.to_string())?;
    let shown = tauri::async_runtime::spawn_blocking(move || {
        let (p, _) = PREVIEWED
            .wait_timeout_while(PREVIEW.lock().unwrap(), Duration::from_secs(10), |p| {
                p.id == id && p.done.is_none()
            })
            .unwrap();
        p.id == id && p.done == Some(true)
    })
    .await
    .map_err(|e| e.to_string())?;
    if shown {
        Ok(())
    } else {
        Err(format!("{path} did not draw"))
    }
}

/// The pane the picker keeps for the preview, in CSS pixels, whenever it
/// lays out.
#[tauri::command]
fn preview_area(app: AppHandle, x: f64, y: f64, width: f64, height: f64) {
    let size = {
        let mut p = PREVIEW.lock().unwrap();
        p.area = [x, y, width, height];
        p.size
    };
    if let Some(size) = size {
        place_preview(&app, size);
    }
}

/// The picker pane's colour, behind a skin's transparent parts.
const PREVIEW_BACKGROUND: tauri::webview::Color = tauri::webview::Color(58, 58, 58, 255);

/// Zooms the preview webview so the skin's opaque box fits the pane, never
/// past its own size, crops the view to that box, centres it, and shows it.
fn place_preview(app: &AppHandle, [left, top, width, height]: [u32; 4]) {
    let Some(webview) = app.get_webview("preview") else {
        return;
    };
    let [x, y, w, h] = PREVIEW.lock().unwrap().area;
    let zoom = (w / width as f64).min(h / height as f64).min(1.0);
    let (sw, sh) = (width as f64 * zoom, height as f64 * zoom);
    let _ = webview.set_zoom(zoom);
    let _ = webview.eval(format!(
        "document.body.style.margin = '-{top}px 0 0 -{left}px'"
    ));
    let _ = webview.set_size(LogicalSize::new(sw, sh));
    let _ = webview.set_position(LogicalPosition::new(x + (w - sw) / 2.0, y + (h - sh) / 2.0));
    let _ = webview.show();
}

/// The box around a shape's runs, `[x, y, width, height]`; none for no runs.
fn bounds(rects: &[[u32; 4]]) -> Option<[u32; 4]> {
    let left = rects.iter().map(|r| r[0]).min()?;
    let top = rects.iter().map(|r| r[1]).min()?;
    let right = rects.iter().map(|r| r[0] + r[2]).max()?;
    let bottom = rects.iter().map(|r| r[1] + r[3]).max()?;
    Some([left, top, right - left, bottom - top])
}

/// The selection a preview request comes from: the id in its page's URL.
fn preview_id(req: &Request<Vec<u8>>) -> Option<u64> {
    let page = Url::parse(req.headers().get("Referer")?.to_str().ok()?).ok()?;
    let id = page.query_pairs().find(|(k, _)| k == "preview")?.1;
    id.parse().ok()
}

/// The skin protocol for the preview webview: the engine, the selected
/// skin, and of its messages only the shape, which sizes the preview.
fn respond_preview(app: &AppHandle, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    // Only requests from the page of the current selection count.
    let current = |p: &Preview| preview_id(&req) == Some(p.id);
    let finish = |done: bool, size: Option<[u32; 4]>| {
        let mut p = PREVIEW.lock().unwrap();
        if current(&p) {
            p.size = size;
            p.done = Some(done);
            PREVIEWED.notify_all();
        }
    };
    match (req.method(), req.uri().path()) {
        (&Method::GET, "/") => Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .body(SKIN_PAGE.as_bytes().to_vec())
            .unwrap(),
        (&Method::GET, "/engine.js") => Response::builder()
            .header("Content-Type", "text/javascript; charset=utf-8")
            .body(engine_js())
            .unwrap(),
        (&Method::GET, "/skin.wmz") => {
            let p = PREVIEW.lock().unwrap();
            match p.bytes.clone().filter(|_| current(&p)) {
                Some(bytes) => Response::builder().body(bytes.to_vec()).unwrap(),
                None => status(StatusCode::NOT_FOUND),
            }
        }
        // The engine could not load the skin: no house skin here, no preview.
        (&Method::GET, "/house.wmz") => {
            finish(false, None);
            status(StatusCode::NOT_FOUND)
        }
        (&Method::POST, "/msg") => {
            if let Ok(FromSkin::Shape {
                width,
                height,
                rects,
            }) = serde_json::from_slice(req.body())
            {
                // Checked first: valid_shape keeps bounds' sums inside the view.
                if valid_shape(width, height, &rects) && current(&PREVIEW.lock().unwrap()) {
                    let size = bounds(&rects).unwrap_or([0, 0, width, height]);
                    finish(true, Some(size));
                    place_preview(app, size);
                }
            }
            status(StatusCode::NO_CONTENT)
        }
        _ => status(StatusCode::NOT_FOUND),
    }
}

/// The picker's links: a skin's archive.org page, and NTS's supporters page.
#[tauri::command]
fn open_link(url: String) -> Result<(), String> {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    let allowed = url.scheme() == "https"
        && match url.host_str() {
            Some("archive.org") => url.path().starts_with("/details/"),
            Some("www.nts.live") => url.path() == "/supporters",
            _ => false,
        };
    if !allowed {
        return Err(format!("not a link the picker opens: {url}"));
    }
    open_url(&url);
    Ok(())
}

/// Opens the skin picker.
fn open_picker(app: &AppHandle) {
    let built = WebviewWindowBuilder::new(app, "picker", WebviewUrl::App("picker.html".into()))
        .title("Skins - NTS Radio Bootleg Media Player")
        .inner_size(700.0, 520.0)
        .min_inner_size(560.0, 360.0)
        .additional_browser_args(BROWSER_ARGS)
        .build();
    if let Err(e) = built {
        eprintln!("cannot open the skin picker: {e}");
    }
}

/// A view of at most 4096 px a side, with runs that are non-empty, inside it,
/// and no more than a bitmap's row runs can need: ceil(width / 2) per row.
fn valid_shape(width: u32, height: u32, rects: &[[u32; 4]]) -> bool {
    let side = 1..=4096;
    let inside = |&[x, y, w, h]: &[u32; 4]| {
        w > 0
            && h > 0
            && x.checked_add(w).is_some_and(|r| r <= width)
            && y.checked_add(h).is_some_and(|b| b <= height)
    };
    side.contains(&width)
        && side.contains(&height)
        && rects.len() <= (height * width.div_ceil(2)) as usize
        && rects.iter().all(inside)
}

/// At most a day into a pick: no pick is longer, and nothing is before 0.
fn valid_seek(seconds: f64) -> bool {
    (0.0..=86_400.0).contains(&seconds)
}

/// Only http(s) URLs of a sane length, re-serialised by the URL parser, and
/// at most one every 3 s, so a skin cannot flood the desktop with tabs.
fn launchable(url: &str, now: Instant, last: &Mutex<Option<Instant>>) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.as_str().len() > 2048 {
        return None;
    }
    throttle(now, last).then_some(url)
}

/// Whether 3 s have passed since the last time this said yes.
fn throttle(now: Instant, last: &Mutex<Option<Instant>>) -> bool {
    let mut last = last.lock().unwrap();
    if last.is_some_and(|t| now.duration_since(t) < Duration::from_secs(3)) {
        return false;
    }
    *last = Some(now);
    true
}

static LAST_LAUNCH: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_PICKER: Mutex<Option<Instant>> = Mutex::new(None);

fn handle(app: &AppHandle, msg: FromSkin) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    match msg {
        FromSkin::Drag {} => {
            #[cfg(windows)]
            win32::drag(&window);
        }
        FromSkin::Shape {
            width,
            height,
            rects,
        } => {
            if valid_shape(width, height, &rects) {
                let resized = window
                    .inner_size()
                    .and_then(|s| Ok(s.to_logical::<u32>(window.scale_factor()?)))
                    .is_ok_and(|s| (s.width, s.height) != (width, height));
                let _ = window.set_size(LogicalSize::new(width, height));
                #[cfg(windows)]
                win32::apply(&window, rects);
                // A bigger skin can push a remembered position off screen. Only
                // on a new size: a mask change must not move a window the
                // listener parked partly off screen.
                if resized {
                    let _ = pull_on_screen(&window);
                }
            }
        }
        FromSkin::Close {} => {
            let _ = window.close();
        }
        FromSkin::Minimize {} => {
            let _ = window.minimize();
        }
        FromSkin::LaunchUrl { url } => {
            if let Some(url) = launchable(&url, Instant::now(), &LAST_LAUNCH) {
                open_url(&url);
            }
        }
        FromSkin::Picker {} => {
            // A skin can send this itself: never while the picker is open, so
            // it cannot keep taking the focus, and at most one every 3 s.
            if app.get_webview_window("picker").is_some() || !throttle(Instant::now(), &LAST_PICKER)
            {
                return;
            }
            // Building a window on the UI thread, where this handler runs, deadlocks.
            let app = app.clone();
            std::thread::spawn(move || open_picker(&app));
        }
        FromSkin::Seek { seconds } if !valid_seek(seconds) => {}
        other => {
            let _ = app.emit_to(EventTarget::webview("main"), "skin", other);
        }
    }
}

/// Brings the player back: a second launch, or a click on the tray icon.
fn show_player(app: &AppHandle) {
    if let Some(main) = app.get_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// The window-state plugin restores a saved position only when it is on a
/// monitor. If part of the window is still off every monitor's work area (a
/// monitor was unplugged, or the skin is bigger than the last one), pull it
/// into its monitor's work area. A window that is fully visible, even across
/// two monitors, stays where the user put it. From the Winamp app.
fn pull_on_screen(window: &Window) -> tauri::Result<()> {
    let position = window.outer_position()?;
    let size = window.outer_size()?;
    let areas: Vec<_> = window
        .available_monitors()?
        .iter()
        .map(|monitor| *monitor.work_area())
        .collect();
    if fully_visible(position, (size.width, size.height), &areas) {
        return Ok(());
    }
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    window.set_position(fit_into(
        position,
        (size.width, size.height),
        monitor.work_area(),
    ))
}

/// Whether every corner of the window lies in one of `areas`.
fn fully_visible(
    position: PhysicalPosition<i32>,
    (width, height): (u32, u32),
    areas: &[PhysicalRect<i32, u32>],
) -> bool {
    // The last pixel, not the edge one past it.
    let (right, bottom) = (
        position.x + width as i32 - 1,
        position.y + height as i32 - 1,
    );
    [
        (position.x, position.y),
        (right, position.y),
        (position.x, bottom),
        (right, bottom),
    ]
    .into_iter()
    .all(|(x, y)| {
        areas.iter().any(|area| {
            x >= area.position.x
                && x < area.position.x + area.size.width as i32
                && y >= area.position.y
                && y < area.position.y + area.size.height as i32
        })
    })
}

/// The nearest position to `position` that puts a window of `size` inside
/// `area`; its top-left corner if the window is bigger than the area.
fn fit_into(
    position: PhysicalPosition<i32>,
    (width, height): (u32, u32),
    area: &PhysicalRect<i32, u32>,
) -> PhysicalPosition<i32> {
    let (left, top) = (area.position.x, area.position.y);
    let right = left + area.size.width as i32;
    let bottom = top + area.size.height as i32;
    PhysicalPosition::new(
        position.x.min(right - width as i32).max(left),
        position.y.min(bottom - height as i32).max(top),
    )
}

/// The current show's or pick's aliases on nts.live (ATA-172).
#[derive(Deserialize)]
struct Page {
    show: String,
    episode: Option<String>,
}

/// The show's page on nts.live, or with an episode the episode's. Aliases
/// come from the NTS API: anything but a plain slug gives no page.
fn show_page(page: &Page) -> Option<Url> {
    let slug = |s: &str| {
        !s.is_empty()
            && s.len() <= 200
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    };
    if !slug(&page.show) || !page.episode.as_deref().is_none_or(slug) {
        return None;
    }
    let mut url = format!("https://www.nts.live/shows/{}", page.show);
    if let Some(episode) = &page.episode {
        url = format!("{url}/episodes/{episode}");
    }
    Url::parse(&url).ok()
}

/// The tray menu, its Mute, checked while muted, its two channels, checked
/// while current, its "Show on nts.live" entry, in the menu only while the
/// current show has a page.
struct Tray {
    menu: Menu<Wry>,
    mute: CheckMenuItem<Wry>,
    channels: [CheckMenuItem<Wry>; 2],
    show: MenuItem<Wry>,
}

impl Tray {
    /// Checks the current channel, or neither while a mixtape or pick plays.
    fn check(&self, channel: Option<usize>) {
        for (i, item) in self.channels.iter().enumerate() {
            let _ = item.set_checked(channel == Some(i));
        }
    }
}

static SHOW_PAGE: Mutex<Option<Url>> = Mutex::new(None);

/// Windows keeps 127 UTF-16 units of a tray tooltip, and tray-icon copies a
/// longer one without its terminator. Cut on a character boundary. From the
/// Winamp app.
fn fit_tooltip(text: &str, max: usize) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}

/// The tray's tooltip: the title, and while muted " (muted)", which a long
/// title never cuts off (ATA-194).
fn tooltip(title: &str, mute: bool) -> String {
    const MUTED: &str = " (muted)";
    if mute {
        fit_tooltip(title, 127 - MUTED.len()) + MUTED
    } else {
        fit_tooltip(title, 127)
    }
}

/// The trusted page, whenever what plays or the mute changes: its title for
/// the tray's tooltip, the mute and the channel to check in the tray, the
/// show's or pick's aliases on nts.live.
#[tauri::command]
async fn now_playing(
    app: AppHandle,
    title: String,
    mute: bool,
    channel: Option<usize>,
    page: Option<Page>,
) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(tooltip(&title, mute)));
    }
    let tray = app.state::<Tray>();
    let _ = tray.mute.set_checked(mute);
    tray.check(channel);
    // Without a page (a mixtape, the live API down) the entry leaves the menu.
    let page = page.as_ref().and_then(show_page);
    let shown = page.is_some();
    let had_page = std::mem::replace(&mut *SHOW_PAGE.lock().unwrap(), page).is_some();
    if shown && !had_page {
        let _ = tray.menu.insert(&tray.show, 6);
    } else if had_page && !shown {
        let _ = tray.menu.remove(&tray.show);
    }
    Ok(())
}

/// The tray icon: play, stop, mute, the two channels, the show's page while
/// it has one, and quit. A left click brings the player forward.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let channel = |id: &str, text: &str| {
        CheckMenuItem::with_id(app, id, text, true, id == "nts1", None::<&str>)
    };
    let sep = || PredefinedMenuItem::separator(app);
    let channels = [channel("nts1", "NTS 1")?, channel("nts2", "NTS 2")?];
    // Checked or not by now_playing, from the trusted page's settings.
    let mute = CheckMenuItem::with_id(app, "mute", "Mute", true, false, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &item("play", "Play")?,
            &item("stop", "Stop")?,
            &mute,
            &sep()?,
            &channels[0],
            &channels[1],
            // "Show on nts.live" goes here, at 6, while the show has a page.
            &sep()?,
            &item("quit", "Quit")?,
        ],
    )?;
    let show = item("show", "Show on nts.live")?;
    app.manage(Tray {
        menu: menu.clone(),
        mute,
        channels,
        show,
    });
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("NTS Radio Bootleg Media Player")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_tray_menu)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_player(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn on_tray_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "quit" => app.exit(0),
        "show" => {
            // Cloned so the lock is not held while the browser starts.
            let page = SHOW_PAGE.lock().unwrap().clone();
            if let Some(url) = page {
                open_url(&url);
            }
        }
        // Windows flips a check item's mark on every click; main.ts plays the
        // clicked channel, so that one is checked, even if it already was.
        id @ ("nts1" | "nts2") => {
            app.state::<Tray>().check(Some((id == "nts2") as usize));
            let _ = app.emit_to(EventTarget::webview("main"), "tray", id);
        }
        // main.ts plays, stops, mutes and switches. Windows flips Mute's mark
        // itself; now_playing then sets it from the setting.
        id => {
            let _ = app.emit_to(EventTarget::webview("main"), "tray", id);
        }
    }
}

#[cfg(windows)]
fn open_url(url: &Url) {
    win32::open(url.as_str());
}

#[cfg(not(windows))]
fn open_url(url: &Url) {
    // macOS; Linux has no build yet.
    let _ = std::process::Command::new("open").arg(url.as_str()).spawn();
}

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;
    use std::time::Duration;
    use tauri::{Emitter, EventTarget, PhysicalPosition};
    type Hrgn = *mut c_void;
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> Hrgn;
        fn CombineRgn(dst: Hrgn, a: Hrgn, b: Hrgn, mode: i32) -> i32;
        fn DeleteObject(obj: *mut c_void) -> i32;
    }
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmGetWindowAttribute(
            hwnd: *mut c_void,
            attr: u32,
            value: *mut c_void,
            size: u32,
        ) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: *mut c_void, rgn: Hrgn, redraw: i32) -> i32;
        fn GetCursorPos(p: *mut [i32; 2]) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
        fn GetWindow(hwnd: *mut c_void, cmd: u32) -> *mut c_void;
        fn IsWindowVisible(hwnd: *mut c_void) -> i32;
        fn IsIconic(hwnd: *mut c_void) -> i32;
        fn GetWindowLongW(hwnd: *mut c_void, index: i32) -> i32;
        fn GetLayeredWindowAttributes(
            hwnd: *mut c_void,
            key: *mut u32,
            alpha: *mut u8,
            flags: *mut u32,
        ) -> i32;
        fn GetWindowRgnBox(hwnd: *mut c_void, rect: *mut [i32; 4]) -> i32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteW(
            hwnd: *mut c_void,
            op: *const u16,
            file: *const u16,
            params: *const u16,
            dir: *const u16,
            show: i32,
        ) -> *mut c_void;
    }
    const SW_SHOWNORMAL: i32 = 1;

    /// Opens an http(s) URL in the default browser.
    pub fn open(url: &str) {
        let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
        let (op, file) = (wide("open"), wide(url));
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                op.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        };
    }
    const SM_SWAPBUTTON: i32 = 23;
    const RGN_OR: i32 = 2;
    static DRAGGING: AtomicBool = AtomicBool::new(false);
    /// The last shape, so it can be redone when the window changes monitor scale.
    static SHAPE: Mutex<Vec<[u32; 4]>> = Mutex::new(Vec::new());

    fn cursor() -> [i32; 2] {
        let mut p = [0; 2];
        unsafe { GetCursorPos(&mut p) };
        p
    }

    /// Moves the window with the pointer until the primary button is up.
    /// `start_dragging` (WM_NCLBUTTONDOWN) returned Ok but never moved the
    /// window: the skin webview holds the mouse capture. Following the cursor
    /// ourselves does not care who holds it.
    ///
    /// The button state is system-wide, so a skin could send `drag` while the
    /// user holds the button in another app. Start only while our window is
    /// in front, under the pointer, with the button down.
    pub fn drag(window: &tauri::Window) {
        let (Ok(hwnd), Ok(origin), Ok(size)) =
            (window.hwnd(), window.outer_position(), window.outer_size())
        else {
            return;
        };
        let start = cursor();
        let over = (origin.x..origin.x + size.width as i32).contains(&start[0])
            && (origin.y..origin.y + size.height as i32).contains(&start[1]);
        let front = unsafe { GetForegroundWindow() } == hwnd.0;
        // VK_LBUTTON reads the physical left button; the primary one may be the right.
        let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
            2
        } else {
            1
        };
        let down = unsafe { GetAsyncKeyState(button) } < 0;
        if !(over && front && down) || DRAGGING.swap(true, Ordering::SeqCst) {
            return;
        }
        let window = window.clone();
        std::thread::spawn(move || {
            while unsafe { GetAsyncKeyState(button) } < 0 {
                let [x, y] = cursor();
                let _ = window.set_position(PhysicalPosition::new(
                    origin.x + x - start[0],
                    origin.y + y - start[1],
                ));
                std::thread::sleep(Duration::from_millis(8));
            }
            DRAGGING.store(false, Ordering::SeqCst);
        });
    }

    const GW_HWNDPREV: u32 = 3;
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_LAYERED: i32 = 0x80000;
    const WS_EX_TRANSPARENT: i32 = 0x20;
    const LWA_COLORKEY: u32 = 1;
    const LWA_ALPHA: u32 = 2;
    const DWMWA_EXTENDED_FRAME_BOUNDS: u32 = 9;
    const DWMWA_CLOAKED: u32 = 14;
    const RGN_DIFF: i32 = 4;
    const NULLREGION: i32 = 1;

    /// The window's visible rectangle on screen, as a region, without the
    /// invisible resize borders `GetWindowRect` counts. None if DWM cannot say.
    unsafe fn visible_rgn(hwnd: *mut c_void) -> Option<Hrgn> {
        let mut r = [0i32; 4];
        let ok =
            DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, r.as_mut_ptr().cast(), 16);
        (ok == 0).then(|| CreateRectRgn(r[0], r[1], r[2], r[3]))
    }

    /// Whether a window hides what is behind it. When in doubt it does not:
    /// translucent, colour-keyed, click-through, shaped and cloaked windows
    /// (another virtual desktop, the shell's invisible ones) let ours show.
    unsafe fn opaque(hwnd: *mut c_void) -> bool {
        if IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
            return false;
        }
        let mut cloaked = 0u32;
        let cloak_ok =
            DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, (&mut cloaked as *mut u32).cast(), 4);
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
        let (mut key, mut alpha, mut flags) = (0, 0, 0);
        let layered_ok = ex & WS_EX_LAYERED == 0
            || (GetLayeredWindowAttributes(hwnd, &mut key, &mut alpha, &mut flags) != 0
                && flags & LWA_COLORKEY == 0
                && (flags & LWA_ALPHA == 0 || alpha == 255));
        cloak_ok == 0
            && cloaked == 0
            && ex & WS_EX_TRANSPARENT == 0
            && layered_ok
            && GetWindowRgnBox(hwnd, &mut [0; 4]) == 0
    }

    /// Whether the windows above ours, together, hide all of it.
    fn covered(hwnd: *mut c_void) -> bool {
        unsafe {
            let Some(rest) = visible_rgn(hwnd) else {
                return false;
            };
            let mut remaining = 0;
            let mut above = GetWindow(hwnd, GW_HWNDPREV);
            while !above.is_null() && remaining != NULLREGION {
                if opaque(above) {
                    if let Some(over) = visible_rgn(above) {
                        remaining = CombineRgn(rest, rest, over, RGN_DIFF);
                        DeleteObject(over);
                    }
                }
                above = GetWindow(above, GW_HWNDPREV);
            }
            DeleteObject(rest);
            remaining == NULLREGION
        }
    }

    /// Tells the trusted page whenever the player becomes covered or shown
    /// again, so it sends no visualisation frames nobody can see. Windows
    /// sends no message for that, so this looks four times a second.
    pub fn watch_cover(window: tauri::Window) {
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        // A raw pointer is not Send; the handle stays valid as long as the app.
        let hwnd = hwnd.0 as isize;
        std::thread::spawn(move || {
            let mut was = false;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let now = covered(hwnd as *mut c_void);
                if now != was {
                    was = now;
                    let _ = window.emit_to(EventTarget::webview("main"), "covered", now);
                }
            }
        });
    }

    /// Clips the window to the skin's opaque runs, given in CSS pixels.
    pub fn apply(window: &tauri::Window, rects: Vec<[u32; 4]>) {
        *SHAPE.lock().unwrap() = rects;
        reapply(window);
    }

    /// Sets the last shape as the window region, at the current scale.
    pub fn reapply(window: &tauri::Window) {
        let (Ok(hwnd), Ok(scale)) = (window.hwnd(), window.scale_factor()) else {
            return;
        };
        let rects = SHAPE.lock().unwrap();
        if rects.is_empty() {
            return;
        }
        let px = |v: u32| (v as f64 * scale).round() as i32;
        unsafe {
            let rgn = CreateRectRgn(0, 0, 0, 0);
            for &[x, y, w, h] in rects.iter() {
                let r = CreateRectRgn(px(x), px(y), px(x + w), px(y + h));
                CombineRgn(rgn, rgn, r, RGN_OR);
                DeleteObject(r);
            }
            // The window owns the region from here; do not delete it.
            SetWindowRgn(hwnd.0, rgn, 1);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // First, so a second launch hands over and exits before anything else
        // runs. The lock is named after the identifier, so the Winamp app
        // (com.datatuna.ntswinamp) has its own.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_player(app)
        }))
        // The position only: the skin sets the size. Restored in setup, so it
        // can be pulled back on screen first.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::POSITION)
                .with_denylist(&["picker"])
                .skip_initial_state("main")
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            skin_send,
            list_skins,
            choose_skin,
            preview_skin,
            preview_area,
            open_link,
            now_playing,
            pick_audio,
        ])
        .register_asynchronous_uri_scheme_protocol("skin", |ctx, req, responder| {
            let (app, from) = (ctx.app_handle().clone(), ctx.webview_label().to_owned());
            // The skin may still be downloading: wait for it off the UI thread.
            if req.uri().path() == "/skin.wmz" {
                std::thread::spawn(move || responder.respond(skin_protocol(&app, &from, req)));
            } else {
                responder.respond(skin_protocol(&app, &from, req));
            }
        })
        .on_window_event(|window, event| {
            // Closing the player quits, picker and all.
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    window.app_handle().exit(0);
                }
                // The preview webview went with the picker; so does its skin.
                if window.label() == "picker" {
                    PREVIEW.lock().unwrap().bytes = None;
                }
            }
            // A new monitor scale resizes the window but leaves its region in
            // the old device pixels.
            #[cfg(windows)]
            if let tauri::WindowEvent::ScaleFactorChanged { .. } = event {
                win32::reapply(window);
            }
            // WebView2 is not told when the window is minimised, so both
            // pages would go on drawing, the visualisation included. Hidden,
            // they stop until it is restored; the audio plays on.
            if let tauri::WindowEvent::Resized(_) = event {
                let hide = window.is_minimized().unwrap_or(false);
                // The preview shows only once the selected skin has drawn.
                let drawn = PREVIEW.lock().unwrap().done == Some(true);
                for webview in window.webviews() {
                    let _ = if hide || (webview.label() == "preview" && !drawn) {
                        webview.hide()
                    } else {
                        webview.show()
                    };
                }
            }
        })
        .setup(|app| {
            skins::start(app.handle());
            build_tray(app.handle())?;
            let window = app.get_window("main").expect("main window");
            window.restore_state(StateFlags::POSITION)?;
            #[cfg(windows)]
            win32::watch_cover(window.clone());
            pull_on_screen(&window)?;
            let size = window
                .inner_size()?
                .to_logical::<f64>(window.scale_factor()?);
            let skin = WebviewBuilder::new(
                "skin",
                WebviewUrl::CustomProtocol("skin://localhost/".parse()?),
            )
            // Must match tauri.conf.json: WebView2 refuses a second webview
            // whose browser arguments differ from the first one's.
            .additional_browser_args(BROWSER_ARGS)
            .auto_resize()
            // The skin stays on its own origin and opens nothing.
            .on_navigation(is_skin_url)
            .on_new_window(|_, _| NewWindowResponse::Deny);
            window.add_child(skin, LogicalPosition::new(0.0, 0.0), size)?;
            // A dev build would otherwise replace itself with the release.
            if !cfg!(debug_assertions) {
                let app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Offline or no release yet: play on, try next launch.
                    if let Err(error) = update(app).await {
                        eprintln!("update check failed: {error}");
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Installs a newer GitHub release, if there is one, and restarts into it.
/// On Windows the installer closes the app itself, so the stream drops for
/// the few seconds the install takes.
async fn update(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        // The installer ends the app without the exit that saves the position.
        if let Err(error) = app.save_window_state(StateFlags::POSITION) {
            eprintln!("could not save the window position: {error}");
        }
        update.download_and_install(|_, _| {}, || {}).await?;
        app.restart();
    }
    Ok(())
}

const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --enable-features=HardwareMediaKeyHandling";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_runs_must_fit_the_view() {
        assert!(valid_shape(200, 200, &[[0, 0, 200, 1], [10, 199, 5, 1]]));
        assert!(!valid_shape(200, 200, &[[u32::MAX, 0, 2, 1]]));
        assert!(!valid_shape(200, 200, &[[199, 0, 2, 1]]));
        assert!(!valid_shape(200, 200, &[[0, 0, 0, 1]]));
        assert!(!valid_shape(0, 200, &[]));
        assert!(!valid_shape(4, 4, &[[0, 0, 1, 1]; 9]));
        // One 3 px row, opaque-clear-opaque: two runs.
        assert!(valid_shape(3, 1, &[[0, 0, 1, 1], [2, 0, 1, 1]]));
        assert!(!valid_shape(3, 1, &[[0, 0, 1, 1]; 3]));
    }

    #[test]
    fn preview_box_and_selection() {
        assert_eq!(bounds(&[]), None);
        assert_eq!(bounds(&[[10, 5, 20, 1], [4, 6, 2, 3]]), Some([4, 5, 26, 4]));
        let req = |referer: &str| {
            Request::builder()
                .header("Referer", referer)
                .body(Vec::new())
                .unwrap()
        };
        assert_eq!(
            preview_id(&req("http://skin.localhost/?preview=7")),
            Some(7)
        );
        assert_eq!(preview_id(&req("http://skin.localhost/?preview")), None);
        assert_eq!(preview_id(&req("http://skin.localhost/")), None);
        assert_eq!(preview_id(&Request::new(Vec::new())), None);
    }

    #[test]
    fn seek_stays_within_a_day() {
        assert!(valid_seek(0.0));
        assert!(valid_seek(7080.0));
        assert!(!valid_seek(-1.0));
        assert!(!valid_seek(86_401.0));
        assert!(!valid_seek(f64::NAN));
        assert!(!valid_seek(f64::INFINITY));
    }

    #[test]
    fn launch_only_http_and_not_too_often() {
        let last = Mutex::new(None);
        let t = Instant::now();
        assert!(launchable("file:///C:/Windows/System32/calc.exe", t, &last).is_none());
        assert!(launchable("javascript:alert(1)", t, &last).is_none());
        assert!(launchable("ms-settings:", t, &last).is_none());
        assert!(launchable(&format!("https://a.example/{}", "x".repeat(3000)), t, &last).is_none());
        assert!(launchable("https://www.nts.live/supporters", t, &last).is_some());
        assert!(launchable(
            "http://www.mediabay.com/",
            t + Duration::from_secs(1),
            &last
        )
        .is_none());
        assert!(launchable(
            "http://www.mediabay.com/",
            t + Duration::from_secs(4),
            &last
        )
        .is_some());
    }

    #[test]
    fn fit_into_pulls_an_off_screen_window_onto_the_work_area() {
        let area = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(1920, 1032),
        };
        let fit = |x, y| fit_into(PhysicalPosition::new(x, y), (321, 268), &area);
        assert_eq!(fit(100, 100), PhysicalPosition::new(100, 100));
        assert_eq!(fit(-50, -200), PhysicalPosition::new(0, 0));
        assert_eq!(fit(1800, 900), PhysicalPosition::new(1599, 764));
    }

    #[test]
    fn fully_visible_allows_spanning_two_monitors_but_not_off_screen() {
        let left = PhysicalRect {
            position: PhysicalPosition::new(-1920, 0),
            size: tauri::PhysicalSize::new(1920, 1032),
        };
        let right = PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(1920, 1032),
        };
        let visible =
            |x, y, areas: &[_]| fully_visible(PhysicalPosition::new(x, y), (321, 268), areas);
        assert!(visible(100, 100, &[right]));
        assert!(visible(-100, 100, &[left, right]));
        assert!(!visible(-100, 100, &[right]));
        assert!(!visible(5000, 5000, &[left, right]));
    }

    #[test]
    fn fit_tooltip_keeps_127_utf16_units_on_a_char_boundary() {
        assert_eq!(fit_tooltip("NTS 1 - Show", 127), "NTS 1 - Show");
        assert_eq!(fit_tooltip(&"a".repeat(200), 127).len(), 127);
        assert_eq!(
            fit_tooltip(&"\u{1F4FB}".repeat(64), 127).chars().count(),
            63
        );
    }

    #[test]
    fn a_muted_tooltip_says_so_however_long_the_title() {
        assert_eq!(tooltip("NTS 1: Show", false), "NTS 1: Show");
        assert_eq!(tooltip("NTS 1: Show", true), "NTS 1: Show (muted)");
        let long = tooltip(&"a".repeat(200), true);
        assert_eq!(long.len(), 127);
        assert!(long.ends_with(" (muted)"));
    }

    #[test]
    fn show_pages_from_aliases() {
        let page = |show: &str, episode: Option<&str>| {
            show_page(&Page {
                show: show.into(),
                episode: episode.map(Into::into),
            })
            .map(String::from)
        };
        assert_eq!(
            page("touching-bass", None).as_deref(),
            Some("https://www.nts.live/shows/touching-bass")
        );
        assert_eq!(
            page("milkweed", Some("milkweed-7th-october-2026")).as_deref(),
            Some("https://www.nts.live/shows/milkweed/episodes/milkweed-7th-october-2026")
        );
        for bad in [
            "",
            "../supporters",
            "a/b",
            "a?b",
            "a#b",
            "a b",
            "%2e%2e",
            "é",
        ] {
            assert_eq!(page(bad, None), None, "{bad}");
            assert_eq!(page("milkweed", Some(bad)), None, "{bad}");
        }
        assert_eq!(page(&"a".repeat(201), None), None);
    }

    #[test]
    fn messages_refuse_unknown_fields() {
        let parse = |s: &str| serde_json::from_str::<FromSkin>(s).ok();
        assert_eq!(parse(r#"{"type":"play"}"#), Some(FromSkin::Play {}));
        assert_eq!(parse(r#"{"type":"drag"}"#), Some(FromSkin::Drag {}));
        assert_eq!(parse(r#"{"type":"play","evil":1}"#), None);
        assert_eq!(parse(r#"{"type":"stop","evil":1}"#), None);
        assert_eq!(parse(r#"{"type":"drag","evil":1}"#), None);
        assert_eq!(parse(r#"{"type":"volume","value":0.5,"evil":1}"#), None);
        assert_eq!(parse(r#"{"type":"bogus"}"#), None);
        assert_eq!(parse(r#"{"type":"next"}"#), Some(FromSkin::Next {}));
        assert_eq!(
            parse(r#"{"type":"select","index":3}"#),
            Some(FromSkin::Select { index: 3 })
        );
        assert_eq!(parse(r#"{"type":"select","index":-1}"#), None);
        assert_eq!(parse(r#"{"type":"select","index":3,"evil":1}"#), None);
        assert_eq!(
            parse(r#"{"type":"mute","value":true}"#),
            Some(FromSkin::Mute { value: true })
        );
        assert_eq!(parse(r#"{"type":"mute","value":1}"#), None);
        assert_eq!(parse(r#"{"type":"close"}"#), Some(FromSkin::Close {}));
        assert_eq!(parse(r#"{"type":"picker"}"#), Some(FromSkin::Picker {}));
        assert_eq!(parse(r#"{"type":"minimize","evil":1}"#), None);
        assert_eq!(
            parse(r#"{"type":"launchUrl","url":"https://www.nts.live/"}"#),
            Some(FromSkin::LaunchUrl {
                url: "https://www.nts.live/".into()
            })
        );
        assert_eq!(
            parse(r#"{"type":"effects","on":true}"#),
            Some(FromSkin::Effects { on: true })
        );
        assert_eq!(parse(r#"{"type":"effects","on":"yes"}"#), None);
        assert_eq!(
            parse(r#"{"type":"effectsMenu","effect":4}"#),
            Some(FromSkin::EffectsMenu { effect: 4 })
        );
        assert_eq!(parse(r#"{"type":"effectsMenu","effect":-1}"#), None);
        assert_eq!(
            parse(r#"{"type":"seek","seconds":600.5}"#),
            Some(FromSkin::Seek { seconds: 600.5 })
        );
        assert_eq!(parse(r#"{"type":"seek","seconds":"600"}"#), None);
        assert_eq!(parse(r#"{"type":"seek","seconds":1,"evil":1}"#), None);
        assert_eq!(parse(r#"{"type":"seek","seconds":NaN}"#), None);
        // The trusted page still gets the bare form.
        let play = serde_json::to_string(&FromSkin::Play {}).unwrap();
        assert_eq!(play, r#"{"type":"play"}"#);
    }
}
