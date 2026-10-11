// Skin code is untrusted, so it runs in its own webview ("skin"), a child of
// the main window drawn over the trusted page ("main"). No capability names
// the skin webview, so Tauri refuses every command from it, ours included
// (see build.rs). The two pages talk only through the `skin` protocol below;
// docs/decisions.md (ATA-107) has the message list.
mod skins;

use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::http::{HeaderValue, Method, Request, Response, StatusCode};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, PhysicalPosition,
    PhysicalRect, Url, WebviewBuilder, WebviewUrl, WebviewWindowBuilder, Window, Wry,
};
use tauri_plugin_window_state::{StateFlags, WindowExt as _};

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
        .inner_size(380.0, 520.0)
        .min_inner_size(300.0, 300.0)
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
                let _ = window.set_size(LogicalSize::new(width, height));
                #[cfg(windows)]
                win32::apply(&window, rects);
                // A bigger skin can push a remembered position off screen.
                let _ = pull_on_screen(&window);
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

/// The SoundCloud credit for the pick playing: its uploader and track page.
#[derive(Deserialize, Clone, PartialEq)]
struct Credit {
    name: String,
    url: String,
}

/// The tray menu, and its credit entry, which is in the menu only while a
/// pick plays.
struct Tray {
    menu: Menu<Wry>,
    credit: MenuItem<Wry>,
}

static CREDIT: Mutex<Option<Credit>> = Mutex::new(None);

/// The credit's height, in CSS pixels.
const CREDIT_HEIGHT: u32 = 16;

/// What a pick's credit shows: "<uploader> on SoundCloud".
fn credit_text(credit: &Credit) -> String {
    if credit.name.is_empty() {
        "SoundCloud".into()
    } else {
        format!("{} on SoundCloud", credit.name)
    }
}

/// A pick's page is a soundcloud.com track page, and nothing else.
fn soundcloud_page(url: &str) -> bool {
    Url::parse(url).is_ok_and(|u| {
        u.scheme() == "https" && u.host_str() == Some("soundcloud.com") && u.path().len() > 1
    })
}

/// Windows keeps 127 UTF-16 units of a tray tooltip, and tray-icon copies a
/// longer one without its terminator. Cut on a character boundary. From the
/// Winamp app.
fn fit_tooltip(text: &str) -> String {
    let mut units = 0;
    text.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= 127
        })
        .collect()
}

/// The trusted page, whenever what plays changes: its title for the tray's
/// tooltip, and a pick's credit, or none. While a pick plays the app draws
/// the credit itself, above the skin, in a webview of its own: a skin's code
/// cannot hide it, and a skin with no title text still shows it.
#[tauri::command]
async fn now_playing(app: AppHandle, title: String, credit: Option<Credit>) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(fit_tooltip(&title)));
    }
    if credit.as_ref().is_some_and(|c| !soundcloud_page(&c.url)) {
        return Err("not a SoundCloud page".into());
    }
    // Swapped before any UI work, which waits on the UI thread, where
    // credit() may be waiting on this lock.
    let had = {
        let mut current = CREDIT.lock().unwrap();
        if *current == credit {
            return Ok(());
        }
        std::mem::replace(&mut *current, credit.clone()).is_some()
    };
    let tray = app.state::<Tray>();
    let window = app.get_window("main").ok_or("no main window")?;
    match &credit {
        Some(c) => {
            tray.credit
                .set_text(credit_text(c))
                .map_err(|e| e.to_string())?;
            if !had {
                let _ = tray.menu.insert(&tray.credit, 5);
            }
            // As wide as the window while it lays out; credit_size narrows it.
            let width = window
                .inner_size()
                .map_err(|e| e.to_string())?
                .to_logical::<f64>(window.scale_factor().map_err(|e| e.to_string())?)
                .width;
            let size = LogicalSize::new(width, CREDIT_HEIGHT as f64);
            match app.get_webview("credit") {
                Some(webview) => {
                    let _ = webview.set_size(size);
                    let _ = webview.eval("render()");
                }
                None => {
                    let builder =
                        WebviewBuilder::new("credit", WebviewUrl::App("credit.html".into()))
                            .additional_browser_args(BROWSER_ARGS)
                            .on_navigation(|url| url.path() == "/credit.html")
                            .on_new_window(|_, _| NewWindowResponse::Deny);
                    window
                        .add_child(builder, LogicalPosition::new(0.0, 0.0), size)
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        None => {
            let _ = tray.menu.remove(&tray.credit);
            if let Some(webview) = app.get_webview("credit") {
                let _ = webview.close();
            }
            #[cfg(windows)]
            win32::set_credit(&window, None);
        }
    }
    Ok(())
}

/// The credit page asks what to show.
#[tauri::command]
fn credit() -> Option<String> {
    CREDIT.lock().unwrap().as_ref().map(credit_text)
}

/// The credit page's width once laid out, in CSS pixels: the credit webview
/// takes that size, and the window's shape gains its rectangle.
#[tauri::command]
fn credit_size(app: AppHandle, width: u32) -> Result<(), String> {
    let window = app.get_window("main").ok_or("no main window")?;
    let webview = app.get_webview("credit").ok_or("no credit")?;
    let width = width.clamp(1, 4096);
    webview
        .set_size(LogicalSize::new(width, CREDIT_HEIGHT))
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    win32::set_credit(&window, Some([0, 0, width, CREDIT_HEIGHT]));
    #[cfg(not(windows))]
    let _ = window;
    Ok(())
}

/// A click on the credit, or on its tray entry: the pick's SoundCloud page.
#[tauri::command]
fn open_credit() {
    if let Some(credit) = CREDIT.lock().unwrap().as_ref() {
        if let Ok(url) = Url::parse(&credit.url) {
            open_url(&url);
        }
    }
}

/// The tray icon: play, stop, the two channels, the pick's credit while one
/// plays, and quit. A left click brings the player forward.
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str| MenuItem::with_id(app, id, text, true, None::<&str>);
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(
        app,
        &[
            &item("play", "Play")?,
            &item("stop", "Stop")?,
            &sep()?,
            &item("nts1", "NTS 1")?,
            &item("nts2", "NTS 2")?,
            // The credit goes here, at 5, while a pick plays.
            &sep()?,
            &item("quit", "Quit")?,
        ],
    )?;
    let credit = item("credit", "SoundCloud")?;
    app.manage(Tray {
        menu: menu.clone(),
        credit,
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
        "credit" => open_credit(),
        // main.ts plays, stops and switches.
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
    use tauri::PhysicalPosition;
    type Hrgn = *mut c_void;
    #[link(name = "gdi32")]
    extern "system" {
        fn CreateRectRgn(x1: i32, y1: i32, x2: i32, y2: i32) -> Hrgn;
        fn CombineRgn(dst: Hrgn, a: Hrgn, b: Hrgn, mode: i32) -> i32;
        fn DeleteObject(obj: *mut c_void) -> i32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowRgn(hwnd: *mut c_void, rgn: Hrgn, redraw: i32) -> i32;
        fn GetCursorPos(p: *mut [i32; 2]) -> i32;
        fn GetAsyncKeyState(key: i32) -> i16;
        fn GetSystemMetrics(index: i32) -> i32;
        fn GetForegroundWindow() -> *mut c_void;
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

    /// The credit's rectangle while a pick plays, kept in the shape.
    static CREDIT: Mutex<Option<[u32; 4]>> = Mutex::new(None);

    /// Clips the window to the skin's opaque runs, given in CSS pixels.
    pub fn apply(window: &tauri::Window, rects: Vec<[u32; 4]>) {
        *SHAPE.lock().unwrap() = rects;
        reapply(window);
    }

    /// Adds the credit's rectangle to the shape, or with none takes it out.
    pub fn set_credit(window: &tauri::Window, rect: Option<[u32; 4]>) {
        *CREDIT.lock().unwrap() = rect;
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
            for &[x, y, w, h] in rects.iter().chain(CREDIT.lock().unwrap().iter()) {
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
        .invoke_handler(tauri::generate_handler![
            skin_send,
            list_skins,
            choose_skin,
            open_link,
            now_playing,
            credit,
            credit_size,
            open_credit
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
                for webview in window.webviews() {
                    let _ = if hide { webview.hide() } else { webview.show() };
                }
            }
        })
        .setup(|app| {
            skins::start(app.handle());
            build_tray(app.handle())?;
            let window = app.get_window("main").expect("main window");
            window.restore_state(StateFlags::POSITION)?;
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
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        assert_eq!(fit_tooltip("NTS 1 - Show"), "NTS 1 - Show");
        assert_eq!(fit_tooltip(&"a".repeat(200)).len(), 127);
        assert_eq!(fit_tooltip(&"\u{1F4FB}".repeat(64)).chars().count(), 63);
    }

    #[test]
    fn credit_opens_only_soundcloud_pages() {
        assert!(soundcloud_page("https://soundcloud.com/user-1/a-mix"));
        assert!(!soundcloud_page("https://soundcloud.com/"));
        assert!(!soundcloud_page("http://soundcloud.com/user-1/a-mix"));
        assert!(!soundcloud_page("https://soundcloud.com.evil.example/a"));
        assert!(!soundcloud_page("file:///C:/Windows/System32/calc.exe"));
        let credit = |name: &str| Credit {
            name: name.into(),
            url: String::new(),
        };
        assert_eq!(
            credit_text(&credit("NTS Latest")),
            "NTS Latest on SoundCloud"
        );
        assert_eq!(credit_text(&credit("")), "SoundCloud");
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
        // The trusted page still gets the bare form.
        let play = serde_json::to_string(&FromSkin::Play {}).unwrap();
        assert_eq!(play, r#"{"type":"play"}"#);
    }
}
