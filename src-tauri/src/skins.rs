//! Where the skin comes from (ATA-112). Skins are `.wmz` files in the
//! archive.org item `windowsmediaplayerskinsarchive`; the app wears only those
//! `skins/compatible.json` marks as working, fetched here because archive.org
//! sends no CORS headers, and cached by md5 in the app's local data folder.
//! On launch: the skin the listener picked, or else a random one; at most one
//! download; the house skin whenever anything fails.
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::collections::hash_map::RandomState;
use std::fs;
use std::hash::BuildHasher;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};

const ITEM: &str = "windowsmediaplayerskinsarchive";
/// Room for a few dozen skins; the oldest go first.
const CACHE_CAP_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Skin {
    /// The file's path inside the archive.org item, `microsoft/Classic.wmz`.
    pub path: String,
    pub md5: String,
    pub size: u64,
    /// `works`, `partial` or `broken`, from tools/compat.mjs; `local` or
    /// `broken` (not a zip) for the local library.
    pub status: String,
}

pub fn list() -> &'static [Skin] {
    static LIST: OnceLock<Vec<Skin>> = OnceLock::new();
    LIST.get_or_init(|| {
        serde_json::from_str(include_str!("../../skins/compatible.json"))
            .expect("skins/compatible.json")
    })
}

pub fn working() -> impl Iterator<Item = &'static Skin> {
    list().iter().filter(|s| s.status == "works")
}

/// The local library (ATA-220, ATA-239): every `.wmz` in the folder the
/// listener chose in the picker, else in `skins/local/` under the app's data
/// folder, read each time the picker asks. Debug builds also read the
/// checkout's gitignored `skins/local/`. Unchecked, so not on the random draw.
pub fn local_dirs(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let dir = match chosen_folder(app) {
        Some(dir) => dir,
        None => {
            let dir = cache_dir(app)?.join("local");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            dir
        }
    };
    Ok(with_checkout(dir))
}

fn folder_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cache_dir(app)?.with_file_name("skin-folder.txt"))
}

fn chosen_folder(app: &AppHandle) -> Option<PathBuf> {
    let text = fs::read_to_string(folder_file(app).ok()?).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.into())
}

/// Keeps `dir` as the local library's folder.
pub fn set_folder(app: &AppHandle, dir: &Path) -> Result<(), String> {
    let text = dir.to_str().ok_or("the folder's name is not Unicode")?;
    fs::write(folder_file(app)?, text).map_err(|e| e.to_string())?;
    // The old folder's skins, until the new one is read.
    LOCAL.lock().unwrap().clear();
    Ok(())
}

fn with_checkout(dir: PathBuf) -> Vec<PathBuf> {
    let mut dirs = vec![dir];
    if cfg!(debug_assertions) {
        dirs.push(concat!(env!("CARGO_MANIFEST_DIR"), "/../skins/local").into());
    }
    dirs
}

/// The last scan. Each skin is leaked once, so it can be worn like a listed
/// one; a scan finds a few dozen at most.
static LOCAL: Mutex<Vec<&'static Skin>> = Mutex::new(Vec::new());

pub fn local() -> Vec<&'static Skin> {
    LOCAL.lock().unwrap().clone()
}

static SCANNING: AtomicBool = AtomicBool::new(false);

/// Scans on its own thread, unless a scan is running: an offline share
/// takes some 20 s to fail, and the picker's lists must not wait for it.
/// The result lands in `local()` for the picker's next poll.
pub fn rescan_local(app: &AppHandle) {
    if SCANNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        scan_local(&app);
        SCANNING.store(false, Ordering::SeqCst);
    });
}

pub fn scanning() -> bool {
    SCANNING.load(Ordering::SeqCst)
}

pub fn scan_local(app: &AppHandle) {
    let found = local_dirs(app).map(|d| local_in(&d)).unwrap_or_default();
    let mut list = LOCAL.lock().unwrap();
    *list = found
        .into_iter()
        .map(|s| {
            list.iter()
                .find(|o| ***o == s)
                .copied()
                .unwrap_or_else(|| Box::leak(Box::new(s)))
        })
        .collect();
}

/// The `.wmz` files at the top of each folder; a name in an earlier folder
/// hides the same name in a later one. A file that is not a zip is `broken`.
fn local_in(dirs: &[PathBuf]) -> Vec<Skin> {
    let mut skins: Vec<Skin> = Vec::new();
    for dir in dirs {
        for e in fs::read_dir(dir).into_iter().flatten().flatten() {
            let Ok(name) = e.file_name().into_string() else {
                continue;
            };
            let path = format!("local/{name}");
            if !name.to_lowercase().ends_with(".wmz") || skins.iter().any(|s| s.path == path) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let mut head = [0u8; 4];
            let zip = fs::File::open(e.path())
                .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head))
                .is_ok()
                && head == [b'P', b'K', 3, 4];
            skins.push(Skin {
                path,
                md5: String::new(),
                size: meta.len(),
                status: if zip { "local" } else { "broken" }.into(),
            });
        }
    }
    skins.sort_by_key(|s| s.path.to_lowercase());
    skins
}

pub fn find(path: &str) -> Option<&'static Skin> {
    working().chain(local()).find(|s| s.path == path)
}

pub fn random() -> Option<&'static Skin> {
    let n = working().count();
    // RandomState is seeded from the OS each time: random enough for a skin.
    let i = RandomState::new().hash_one(0u8) as usize;
    working().nth(i.checked_rem(n)?)
}

/// The archive.org page that credits the skin.
pub fn page(skin: &Skin) -> Url {
    item_url("https://archive.org/details", &skin.path)
}

fn item_url(base: &str, path: &str) -> Url {
    let mut url = Url::parse(base).unwrap();
    url.path_segments_mut()
        .unwrap()
        .push(ITEM)
        .extend(path.split('/'));
    url
}

/// `%LOCALAPPDATA%\com.datatuna.ntswmp\skins` on Windows. Skins live only
/// here, never in the repository or the installer (AGENTS.md, Invariants).
fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("skins");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn is_cached(app: &AppHandle, skin: &Skin) -> bool {
    cache_dir(app).is_ok_and(|d| d.join(format!("{}.wmz", skin.md5)).is_file())
}

fn md5_hex(bytes: &[u8]) -> String {
    Md5::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The md5s of the skins being fetched now.
static FETCHING: Mutex<Vec<String>> = Mutex::new(Vec::new());
static FETCHED: Condvar = Condvar::new();

/// One fetch per skin at a time: a preview and a pick of the same skin, or a
/// double click, download it once, and never write the same `.part` file.
/// Held for the fetch; a second caller waits, then finds the skin cached.
struct Claim(String);

impl Claim {
    fn new(md5: &str) -> Self {
        let mut busy = FETCHED
            .wait_while(FETCHING.lock().unwrap(), |busy| {
                busy.iter().any(|m| m == md5)
            })
            .unwrap();
        busy.push(md5.to_owned());
        Claim(md5.to_owned())
    }
}

impl Drop for Claim {
    fn drop(&mut self) {
        FETCHING.lock().unwrap().retain(|m| *m != self.0);
        FETCHED.notify_all();
    }
}

/// The skin's bytes from the cache, or downloaded into it. Either way they
/// must match the md5 the compatibility list was built from.
pub fn fetch(app: &AppHandle, skin: &Skin) -> Result<Vec<u8>, String> {
    if let Some(name) = skin.path.strip_prefix("local/") {
        if skin.status == "broken" {
            return Err(format!("{}: not a zip", skin.path));
        }
        let dir = local_dirs(app)?
            .into_iter()
            .find(|d| d.join(name).is_file())
            .ok_or_else(|| format!("{}: not found", skin.path))?;
        return fs::read(dir.join(name)).map_err(|e| format!("{}: {e}", skin.path));
    }
    let _claim = Claim::new(&skin.md5);
    let dir = cache_dir(app)?;
    let path = dir.join(format!("{}.wmz", skin.md5));
    if let Ok(bytes) = fs::read(&path) {
        if md5_hex(&bytes) == skin.md5 {
            // Touch it, so the cache keeps what is worn.
            let _ = fs::File::options()
                .write(true)
                .open(&path)
                .and_then(|f| f.set_modified(std::time::SystemTime::now()));
            return Ok(bytes);
        }
    }
    let bytes = download(skin)?;
    // Write then rename, so a crash never leaves a truncated skin behind.
    let partial = path.with_extension("part");
    fs::write(&partial, &bytes).map_err(|e| e.to_string())?;
    fs::rename(&partial, &path).map_err(|e| e.to_string())?;
    // The skin is saved either way; a failed prune only delays the cap.
    if let Err(e) = prune(&dir, CACHE_CAP_BYTES, &path) {
        eprintln!("could not prune the skin cache: {e}");
    }
    Ok(bytes)
}

/// archive.org now and then answers 500 for a file it serves a second
/// later, so a failed download is tried once more: still the same one skin.
fn download(skin: &Skin) -> Result<Vec<u8>, String> {
    download_once(skin).or_else(|e| {
        eprintln!("{e}; trying once more");
        std::thread::sleep(Duration::from_secs(1));
        download_once(skin)
    })
}

fn download_once(skin: &Skin) -> Result<Vec<u8>, String> {
    let url = item_url("https://archive.org/download", &skin.path);
    let tls = ureq::tls::TlsConfig::builder()
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier)
        .build();
    let agent = ureq::Agent::config_builder()
        .tls_config(tls)
        // A stalled connection gives up soon; a slow body gets two minutes.
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(15)))
        .timeout_global(Some(Duration::from_secs(120)))
        .user_agent(concat!("nts-desktop-wmp/", env!("CARGO_PKG_VERSION")))
        .build()
        .new_agent();
    let bytes = agent
        .get(url.as_str())
        .call()
        // ureq refuses a body that reaches its limit, so one byte over the size.
        .and_then(|mut res| {
            res.body_mut()
                .with_config()
                .limit(skin.size + 1)
                .read_to_vec()
        })
        .map_err(|e| format!("{}: {e}", skin.path))?;
    if md5_hex(&bytes) != skin.md5 {
        return Err(format!("{}: checksum mismatch", skin.path));
    }
    Ok(bytes)
}

/// Deletes the oldest `.wmz` files in `dir` until the rest fit in `cap`
/// bytes. Never deletes `keep`, the skin just written. From the Winamp app.
fn prune(dir: &Path, cap: u64, keep: &Path) -> std::io::Result<()> {
    let mut files = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        if meta.is_file() && entry.path().extension().is_some_and(|ext| ext == "wmz") {
            files.push((meta.modified()?, meta.len(), entry.path()));
        }
    }
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    let mut total = 0;
    for (_, len, path) in files {
        total += len;
        if total > cap && path != keep {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

fn choice_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(cache_dir(app)?.with_file_name("skin.json"))
}

#[derive(Deserialize, Serialize, Default)]
struct Choice {
    /// The skin picked in the picker; none means a random one each launch.
    skin: Option<String>,
}

pub fn choice(app: &AppHandle) -> Option<String> {
    let text = fs::read_to_string(choice_file(app).ok()?).ok()?;
    serde_json::from_str::<Choice>(&text).ok()?.skin
}

pub fn set_choice(app: &AppHandle, skin: Option<String>) -> Result<(), String> {
    let text = serde_json::to_string(&Choice { skin }).unwrap();
    fs::write(choice_file(app)?, text).map_err(|e| e.to_string())
}

/// What the skin webview draws: a skin on its way, a skin, or the house skin.
#[derive(Clone)]
pub enum Worn {
    Fetching,
    Skin(&'static Skin, Arc<Vec<u8>>),
    House,
}

/// `fetch` numbers each fetch, so only the latest one is worn: a launch
/// download that lands after a pick, or after the first paint gave up on
/// it, goes into the cache and nowhere else.
struct State {
    worn: Worn,
    fetch: u64,
}

static STATE: Mutex<State> = Mutex::new(State {
    worn: Worn::House,
    fetch: 0,
});
static ARRIVED: Condvar = Condvar::new();

fn begin() -> u64 {
    let mut state = STATE.lock().unwrap();
    state.fetch += 1;
    state.worn = Worn::Fetching;
    state.fetch
}

fn finish(fetch: u64, worn: Worn) {
    let mut state = STATE.lock().unwrap();
    if state.fetch == fetch {
        state.worn = worn;
        ARRIVED.notify_all();
    }
}

/// The skin webview drew the house skin, whatever was on its way.
pub fn wear_house() {
    let mut state = STATE.lock().unwrap();
    state.fetch += 1;
    state.worn = Worn::House;
}

/// What to draw, waiting up to `wait` for a skin still on its way, then
/// giving up on it. `None` is the house skin.
pub fn worn(wait: Duration) -> Option<(&'static Skin, Arc<Vec<u8>>)> {
    let (mut state, _) = ARRIVED
        .wait_timeout_while(STATE.lock().unwrap(), wait, |s| {
            matches!(s.worn, Worn::Fetching)
        })
        .unwrap();
    if matches!(state.worn, Worn::Fetching) {
        state.fetch += 1;
        state.worn = Worn::House;
    }
    match &state.worn {
        Worn::Skin(skin, bytes) => Some((skin, bytes.clone())),
        _ => None,
    }
}

/// The skin on the window now, for the picker: `None` for the house skin,
/// and whether another is on its way.
pub fn status() -> (Option<&'static Skin>, bool) {
    match STATE.lock().unwrap().worn {
        Worn::Skin(skin, _) => (Some(skin), false),
        Worn::Fetching => (None, true),
        Worn::House => (None, false),
    }
}

/// Fetches `skin` and wears it, or the house skin if that fails.
pub fn load(app: &AppHandle, skin: &'static Skin) -> Result<(), String> {
    fetch_and_wear(app, skin, begin())
}

fn fetch_and_wear(app: &AppHandle, skin: &'static Skin, id: u64) -> Result<(), String> {
    let result = fetch(app, skin);
    match &result {
        Ok(bytes) => finish(id, Worn::Skin(skin, Arc::new(bytes.clone()))),
        Err(e) => {
            eprintln!("skin {e}; wearing the house skin");
            finish(id, Worn::House);
        }
    }
    result.map(|_| ())
}

/// The skin to wear on launch. A remembered skin no longer on the list gets
/// the house skin, and the choice stays. A local one that is missing gets a
/// random skin: a build from another checkout, or the installed app sharing
/// `skin.json`, will never find it (ATA-220).
fn launch_skin(choice: Option<String>) -> Option<&'static Skin> {
    match choice {
        Some(path) if path.starts_with("local/") => find(&path).or_else(random),
        Some(path) => find(&path),
        None => random(),
    }
}

/// On launch: the listener's skin, or a random one, fetched on its own
/// thread. A remembered skin no longer on the list gets the house skin, and
/// the choice stays.
/// The local folder is read there too, and only for a kept local skin: it
/// may be a share that is offline.
pub fn start(app: &AppHandle) {
    let id = begin();
    let app = app.clone();
    std::thread::spawn(move || {
        let choice = choice(&app);
        if choice.as_deref().is_some_and(|c| c.starts_with("local/")) {
            scan_local(&app);
        }
        match launch_skin(choice) {
            Some(skin) => drop(fetch_and_wear(&app, skin, id)),
            None => finish(id, Worn::House),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn the_list_parses_and_has_working_skins() {
        assert!(working().count() > 0);
        assert!(list().iter().all(|s| s.md5.len() == 32));
        let picks: std::collections::HashSet<_> =
            (0..50).map(|_| &random().unwrap().path).collect();
        assert!(picks.len() > 1);
    }

    #[test]
    fn urls_encode_the_path() {
        assert_eq!(
            item_url("https://archive.org/download", "HortonLantzMarocco/YIL!OMA2K.wmz").as_str(),
            "https://archive.org/download/windowsmediaplayerskinsarchive/HortonLantzMarocco/YIL!OMA2K.wmz"
        );
        assert_eq!(
            item_url("https://archive.org/details", "EMI parlophone/Gorillaz.wmz").as_str(),
            "https://archive.org/details/windowsmediaplayerskinsarchive/EMI%20parlophone/Gorillaz.wmz"
        );
        assert_eq!(
            item_url("https://archive.org/details", "a/b#c?.wmz").as_str(),
            "https://archive.org/details/windowsmediaplayerskinsarchive/a/b%23c%3F.wmz"
        );
    }

    #[test]
    fn only_the_latest_fetch_is_worn() {
        let skin = &list()[0];
        let bytes = Arc::new(vec![1u8]);
        let launch = begin();
        let pick = begin();
        finish(pick, Worn::Skin(skin, bytes.clone()));
        // The launch download lands after the pick: it is not worn.
        finish(launch, Worn::House);
        assert!(worn(Duration::ZERO).is_some());
        // The first paint gives up on a fetch; its late result is not worn.
        let slow = begin();
        assert!(worn(Duration::from_millis(10)).is_none());
        finish(slow, Worn::Skin(skin, bytes));
        assert!(worn(Duration::ZERO).is_none());
    }

    #[test]
    fn a_second_fetch_of_a_skin_waits_for_the_first() {
        let first = Claim::new("a");
        let other = Claim::new("b");
        let waiter = std::thread::spawn(|| {
            let _second = Claim::new("a");
            SystemTime::now()
        });
        std::thread::sleep(Duration::from_millis(100));
        let released = SystemTime::now();
        drop(first);
        assert!(waiter.join().unwrap() >= released);
        drop(other);
    }

    #[test]
    fn the_local_library_lists_its_wmz_files() {
        let tmp = std::env::temp_dir().join(format!("nts-wmp-local-{}", std::process::id()));
        let (app, checkout) = (tmp.join("app"), tmp.join("checkout"));
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&checkout).unwrap();
        // An empty folder lists nothing.
        assert!(local_in(std::slice::from_ref(&app)).is_empty());
        let zip = b"PK\x03\x04 rest";
        fs::write(app.join("b.wmz"), zip).unwrap();
        fs::write(app.join("A.WMZ"), zip).unwrap();
        fs::write(app.join("notes.txt"), zip).unwrap();
        fs::write(app.join("html.wmz"), b"<html>").unwrap();
        fs::write(app.join("empty.wmz"), b"").unwrap();
        fs::write(checkout.join("b.wmz"), b"not a zip").unwrap();
        fs::write(checkout.join("c.wmz"), zip).unwrap();
        let found: Vec<_> = local_in(&[app, checkout])
            .into_iter()
            .map(|s| (s.path, s.status))
            .collect();
        fs::remove_dir_all(&tmp).unwrap();
        let want = [
            ("local/A.WMZ", "local"),
            // The app's folder comes first, so its b.wmz hides the checkout's.
            ("local/b.wmz", "local"),
            ("local/c.wmz", "local"),
            ("local/empty.wmz", "broken"),
            ("local/html.wmz", "broken"),
        ];
        assert_eq!(found, want.map(|(p, s)| (p.to_string(), s.to_string())));
        // A missing folder lists nothing either.
        assert!(local_in(&[tmp]).is_empty());
    }

    #[test]
    fn only_debug_builds_read_the_checkout() {
        let dirs = with_checkout("app".into());
        assert_eq!(dirs[0], PathBuf::from("app"));
        assert_eq!(dirs.len(), if cfg!(debug_assertions) { 2 } else { 1 });
    }

    #[test]
    fn a_missing_local_choice_gets_a_random_skin() {
        assert!(launch_skin(Some("local/not there.wmz".into())).is_some());
        assert!(launch_skin(Some("microsoft/not there.wmz".into())).is_none());
    }

    #[test]
    fn md5_is_lowercase_hex() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
    }

    #[test]
    fn prune_deletes_oldest_past_the_cap_but_keeps_the_new_skin() {
        let dir = std::env::temp_dir().join(format!("nts-wmp-prune-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let now = SystemTime::now();
        // a is newest, d oldest; each is 10 bytes.
        for (i, name) in ["a", "b", "c", "d"].iter().enumerate() {
            let path = dir.join(format!("{name}.wmz"));
            fs::write(&path, [0u8; 10]).unwrap();
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(now - Duration::from_secs(60 * i as u64))
                .unwrap();
        }
        fs::write(dir.join("notes.txt"), [0u8; 100]).unwrap();
        prune(&dir, 20, &dir.join("d.wmz")).unwrap();
        let mut left: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(left, ["a.wmz", "b.wmz", "d.wmz", "notes.txt"]);
    }
}

/// Reaches archive.org: `cargo test -- --ignored`.
#[cfg(test)]
mod net {
    #[test]
    #[ignore]
    fn downloads_one() {
        let s = super::list()
            .iter()
            .find(|s| s.path == "microsoft/Goo.wmz")
            .unwrap();
        let b = super::download(s).unwrap();
        assert_eq!(b.len() as u64, s.size);
    }
}
