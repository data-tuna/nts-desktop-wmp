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
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager, Url};

const ITEM: &str = "windowsmediaplayerskinsarchive";
/// Room for a few dozen skins; the oldest go first.
const CACHE_CAP_BYTES: u64 = 100 * 1024 * 1024;

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Skin {
    /// The file's path inside the archive.org item, `microsoft/Classic.wmz`.
    pub path: String,
    pub md5: String,
    pub size: u64,
    /// `works`, `partial` or `broken`, from tools/compat.mjs.
    pub status: String,
}

pub fn list() -> &'static [Skin] {
    static LIST: OnceLock<Vec<Skin>> = OnceLock::new();
    LIST.get_or_init(|| {
        serde_json::from_str(include_str!("../../skins/compatible.json"))
            .expect("skins/compatible.json")
    })
}

fn working() -> impl Iterator<Item = &'static Skin> {
    list().iter().filter(|s| s.status == "works")
}

pub fn find(path: &str) -> Option<&'static Skin> {
    working().find(|s| s.path == path)
}

pub fn random() -> Option<&'static Skin> {
    let n = working().count();
    // RandomState is seeded from the OS each time: random enough for a skin.
    let i = RandomState::new().hash_one(0u8) as usize;
    working().nth(i.checked_rem(n)?)
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

/// The skin's bytes from the cache, or downloaded into it. Either way they
/// must match the md5 the compatibility list was built from.
pub fn fetch(app: &AppHandle, skin: &Skin) -> Result<Vec<u8>, String> {
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
    files.sort_by(|a, b| b.0.cmp(&a.0));
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

static WORN: Mutex<Worn> = Mutex::new(Worn::House);
static ARRIVED: Condvar = Condvar::new();

pub fn wear(worn: Worn) {
    *WORN.lock().unwrap() = worn;
    ARRIVED.notify_all();
}

/// What to draw, waiting up to `wait` for a skin still on its way. `None`
/// is the house skin.
pub fn worn(wait: Duration) -> Option<(&'static Skin, Arc<Vec<u8>>)> {
    let (worn, _) = ARRIVED
        .wait_timeout_while(WORN.lock().unwrap(), wait, |w| matches!(w, Worn::Fetching))
        .unwrap();
    match &*worn {
        Worn::Skin(skin, bytes) => Some((skin, bytes.clone())),
        _ => None,
    }
}

/// Fetches `skin` and wears it, or the house skin if that fails.
pub fn load(app: &AppHandle, skin: &'static Skin) -> Result<(), String> {
    wear(Worn::Fetching);
    let result = fetch(app, skin);
    match &result {
        Ok(bytes) => wear(Worn::Skin(skin, Arc::new(bytes.clone()))),
        Err(e) => {
            eprintln!("skin {e}; wearing the house skin");
            wear(Worn::House);
        }
    }
    result.map(|_| ())
}

/// On launch: the listener's skin, or a random one, fetched on its own
/// thread. A remembered skin no longer on the list gets the house skin, and
/// the choice stays.
pub fn start(app: &AppHandle) {
    let skin = match choice(app) {
        Some(path) => find(&path),
        None => random(),
    };
    if let Some(skin) = skin {
        wear(Worn::Fetching);
        let app = app.clone();
        std::thread::spawn(move || load(&app, skin));
    }
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
