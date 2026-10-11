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
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder,
    WebviewUrl, WebviewWindowBuilder,
};

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
}

/// Trusted page to skin: play state, time, title, levels. The trusted page is
/// the only caller (the skin webview has no capability for this command).
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
        (&Method::GET, "/house.wmz") => Response::builder().body(HOUSE_SKIN.to_vec()).unwrap(),
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
}

#[derive(serde::Serialize)]
struct PickerSkin {
    path: String,
    size: u64,
    cached: bool,
}

/// The picker's list: every skin marked as working.
#[tauri::command]
fn list_skins(app: AppHandle) -> SkinList {
    SkinList {
        skins: skins::list()
            .iter()
            .filter(|s| s.status == "works")
            .map(|s| PickerSkin {
                path: s.path.clone(),
                size: s.size,
                cached: skins::is_cached(&app, s),
            })
            .collect(),
        choice: skins::choice(&app),
        worn: skins::worn(Duration::ZERO).map(|(s, _)| s.path.clone()),
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

/// Opens the skin picker, or brings it to the front.
fn open_picker(app: &AppHandle) {
    if let Some(picker) = app.get_webview_window("picker") {
        let _ = picker.unminimize();
        let _ = picker.set_focus();
        return;
    }
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
    let mut last = last.lock().unwrap();
    if last.is_some_and(|t| now.duration_since(t) < Duration::from_secs(3)) {
        return None;
    }
    *last = Some(now);
    Some(url)
}

static LAST_LAUNCH: Mutex<Option<Instant>> = Mutex::new(None);

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
            // Building a window on the UI thread, where this handler runs, deadlocks.
            let app = app.clone();
            std::thread::spawn(move || open_picker(&app));
        }
        other => {
            let _ = app.emit_to(EventTarget::webview("main"), "skin", other);
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
        .invoke_handler(tauri::generate_handler![
            skin_send,
            list_skins,
            choose_skin,
            open_link
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
        .on_window_event(|_window, _event| {
            // A new monitor scale resizes the window but leaves its region in
            // the old device pixels.
            #[cfg(windows)]
            if let tauri::WindowEvent::ScaleFactorChanged { .. } = _event {
                win32::reapply(_window);
            }
        })
        .setup(|app| {
            skins::start(app.handle());
            let window = app.get_window("main").expect("main window");
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

const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

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
        // The trusted page still gets the bare form.
        let play = serde_json::to_string(&FromSkin::Play {}).unwrap();
        assert_eq!(play, r#"{"type":"play"}"#);
    }
}
