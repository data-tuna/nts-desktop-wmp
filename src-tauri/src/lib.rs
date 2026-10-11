// Skin code is untrusted, so it runs in its own webview ("skin"), a child of
// the main window drawn over the trusted page ("main"). No capability names
// the skin webview, so Tauri refuses every command from it, ours included
// (see build.rs). The two pages talk only through the `skin` protocol below;
// docs/decisions.md (ATA-107) has the message list.
use serde::Deserialize;
use tauri::http::{Method, Request, Response, StatusCode};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Url, WebviewBuilder,
    WebviewUrl,
};

const SKIN_PAGE: &str = include_str!("../../src/skin/stub.html");

/// What a skin may ask for. Anything else is refused before it reaches the
/// trusted page.
#[derive(Deserialize, serde::Serialize, Clone)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum FromSkin {
    Play,
    Stop,
    Volume {
        value: f64,
    },
    Balance {
        value: f64,
    },
    Seek {
        seconds: f64,
    },
    Eq {
        band: u8,
        gain: f64,
    },
    /// The pointer went down on the skin's body: move the window.
    Drag,
    /// The view's size, and its opaque area as `[x, y, width, height]` runs.
    Shape {
        width: u32,
        height: u32,
        rects: Vec<[u32; 4]>,
    },
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
    if from != "skin" {
        return status(StatusCode::FORBIDDEN);
    }
    let path = req.uri().path();
    match (req.method(), path) {
        (&Method::GET, "/") => Response::builder()
            .header("Content-Type", "text/html; charset=utf-8")
            .body(SKIN_PAGE.as_bytes().to_vec())
            .unwrap(),
        (&Method::GET, _) if path.starts_with("/files/") => skin_file(&path[7..]),
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

// ponytail: the spike serves one unpacked skin from NTS_WMP_SKIN_DIR. The
// engine (ATA-108) serves the cached .wmz instead.
fn skin_file(name: &str) -> Response<Vec<u8>> {
    let safe = !name.is_empty() && !name.contains(['/', '\\', ':']) && !name.contains("..");
    let dir = std::env::var_os("NTS_WMP_SKIN_DIR");
    match (safe, dir) {
        (true, Some(dir)) => match std::fs::read(std::path::Path::new(&dir).join(name)) {
            Ok(bytes) => Response::builder().body(bytes).unwrap(),
            Err(_) => status(StatusCode::NOT_FOUND),
        },
        _ => status(StatusCode::NOT_FOUND),
    }
}

fn handle(app: &AppHandle, msg: FromSkin) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    match msg {
        FromSkin::Drag => {
            #[cfg(windows)]
            shape::drag(&window);
        }
        FromSkin::Shape {
            width,
            height,
            rects,
        } => {
            if (1..=4096).contains(&width) && (1..=4096).contains(&height) {
                let _ = window.set_size(LogicalSize::new(width, height));
                #[cfg(windows)]
                shape::apply(&window, &rects);
            }
        }
        other => {
            let _ = app.emit_to(EventTarget::webview("main"), "skin", other);
        }
    }
}

#[cfg(windows)]
mod shape {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
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
    }
    const SM_SWAPBUTTON: i32 = 23;
    static DRAGGING: AtomicBool = AtomicBool::new(false);

    fn cursor() -> [i32; 2] {
        let mut p = [0; 2];
        unsafe { GetCursorPos(&mut p) };
        p
    }

    /// Moves the window with the pointer until the primary button is up.
    /// `start_dragging` (WM_NCLBUTTONDOWN) returned Ok but never moved the
    /// window: the skin webview holds the mouse capture. Following the cursor
    /// ourselves does not care who holds it.
    pub fn drag(window: &tauri::Window) {
        let Ok(origin) = window.outer_position() else {
            return;
        };
        if DRAGGING.swap(true, Ordering::SeqCst) {
            return;
        }
        let window = window.clone();
        let start = cursor();
        // VK_LBUTTON reads the physical left button; the primary one may be the right.
        let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0 {
            2
        } else {
            1
        };
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
    const RGN_OR: i32 = 2;

    /// Clips the window to the skin's opaque runs, given in CSS pixels.
    pub fn apply(window: &tauri::Window, rects: &[[u32; 4]]) {
        let (Ok(hwnd), Ok(scale)) = (window.hwnd(), window.scale_factor()) else {
            return;
        };
        let px = |v: u32| (v as f64 * scale).round() as i32;
        unsafe {
            let rgn = CreateRectRgn(0, 0, 0, 0);
            for &[x, y, w, h] in rects {
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
        .invoke_handler(tauri::generate_handler![skin_send])
        .register_uri_scheme_protocol("skin", |ctx, req| {
            skin_protocol(ctx.app_handle(), ctx.webview_label(), req)
        })
        .setup(|app| {
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
