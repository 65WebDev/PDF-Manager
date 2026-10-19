//! Android shell: the editor talks to the system through the Kotlin plugin
//! `PdfBridgePlugin` (gen/android/app/src/main/java/io/github/pdfmanager).
//!
//! - files sent to the app ("Open with", "Share" from another app) are copied
//!   into the cache by the plugin and opened from there like a desktop path;
//! - Save / Export go through the system file picker (Storage Access
//!   Framework), Share through the system share sheet, Print through the
//!   system print dialog;
//! - reading mode hides the status and navigation bars.
//!
//! The Android WebView cannot pass a request body to the app, so a file from
//! the editor arrives as base64 text, in chunks (`android_stage_chunk`), and
//! is put together in the cache before the plugin gets its path.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

use base64::Engine;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime, Wry};

const PLUGIN_PACKAGE: &str = "io.github.pdfmanager";
const PLUGIN_CLASS: &str = "PdfBridgePlugin";

struct Bridge(PluginHandle<Wry>);

/// Cache subfolder the editor's files are put together in.
const STAGE_DIR: &str = "pm-stage";
/// Cache subfolder a shared file is handed out from (FileProvider, see
/// res/xml/file_paths.xml).
const SHARE_DIR: &str = "pm-share";
/// Cache subfolder a file being printed waits in until the print job is done.
const PRINT_DIR: &str = "pm-print";

pub fn init() -> TauriPlugin<Wry> {
  Builder::new("pdfbridge")
    .setup(|app, api| {
      let handle = api.register_android_plugin(PLUGIN_PACKAGE, PLUGIN_CLASS)?;
      app.manage(Bridge(handle));
      Ok(())
    })
    .build()
}

async fn call<T: DeserializeOwned>(app: &AppHandle, command: &str, payload: Value) -> Result<T, String> {
  let bridge = app.state::<Bridge>();
  bridge
    .0
    .run_mobile_plugin_async::<T>(command, payload)
    .await
    .map_err(|e| e.to_string())
}

fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
  static DIR: OnceLock<PathBuf> = OnceLock::new();
  if let Some(dir) = DIR.get() {
    return Ok(dir.clone());
  }
  let dir = app
    .path()
    .app_cache_dir()
    .map_err(|e| format!("Папка кэша недоступна: {e}"))?;
  Ok(DIR.get_or_init(|| dir).clone())
}

fn cache_subdir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
  let dir = cache_dir(app)?.join(name);
  std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать {}: {e}", dir.display()))?;
  Ok(dir)
}

/// A token names one file being put together; it becomes a file name, so
/// only a short run of plain characters is accepted.
fn valid_token(token: &str) -> bool {
  !token.is_empty()
    && token.len() <= 64
    && token.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn staged_path(app: &AppHandle, token: &str) -> Result<PathBuf, String> {
  if !valid_token(token) {
    return Err("Неверный идентификатор файла".into());
  }
  Ok(cache_subdir(app, STAGE_DIR)?.join(token))
}

/// File name for the share sheet / print job: the document's own name with
/// path separators and characters Android file names reject taken out.
fn safe_file_name(name: &str, fallback: &str) -> String {
  let cleaned: String = name
    .trim()
    .chars()
    .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
    .collect();
  let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
  if cleaned.is_empty() {
    fallback.to_string()
  } else {
    cleaned
  }
}

#[derive(Deserialize)]
struct PathsResponse {
  paths: Vec<String>,
}

#[derive(Deserialize)]
struct UriResponse {
  uri: Option<String>,
}

/// Answer of a plugin command that reports nothing back.
type Empty = serde::de::IgnoredAny;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteTarget<'a> {
  uri: &'a str,
  path: String,
}

/// Files the app was asked to open ("Open with", a PDF shared to it), copied
/// into the cache by the plugin. Read with `read_local_file` like a desktop
/// path; asked for again whenever the app comes back to the front.
#[tauri::command]
pub async fn take_pending_open_files(app: AppHandle) -> Result<Vec<String>, String> {
  let res: PathsResponse = call(&app, "takeOpenedFiles", json!({})).await?;
  Ok(res.paths)
}

/// Appends one base64 chunk to the file being put together under `token`.
/// `offset` is where the chunk goes; 0 starts the file over, anything else
/// must be the current length (chunks are sent one after another).
#[tauri::command]
pub async fn android_stage_chunk(app: AppHandle, token: String, offset: u64, data: String) -> Result<(), String> {
  let path = staged_path(&app, &token)?;
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(data.as_bytes())
    .map_err(|e| format!("Повреждённые данные: {e}"))?;
  let mut file = if offset == 0 {
    std::fs::File::create(&path)
  } else {
    let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if len != offset {
      return Err("Части файла пришли не по порядку".into());
    }
    std::fs::OpenOptions::new().append(true).open(&path)
  }
  .map_err(|e| format!("Не удалось записать во временный файл: {e}"))?;
  file
    .write_all(&bytes)
    .map_err(|e| format!("Не удалось записать во временный файл: {e}"))
}

/// System "Save as" dialog. Returns the new document's address, or None when
/// the user backs out. The document is created empty; `android_write_target`
/// fills it, `android_discard_target` removes it if the file could not be made.
#[tauri::command]
pub async fn android_pick_save_target(app: AppHandle, name: String, mime: String) -> Result<Option<String>, String> {
  let res: UriResponse = call(&app, "pickSaveTarget", json!({ "name": name, "mime": mime })).await?;
  Ok(res.uri)
}

/// System folder picker (Save / Export by pages). None when the user backs out.
#[tauri::command]
pub async fn android_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
  let res: UriResponse = call(&app, "pickFolder", json!({})).await?;
  Ok(res.uri)
}

/// Writes the file put together under `token` into a document picked with
/// `android_pick_save_target`.
#[tauri::command]
pub async fn android_write_target(app: AppHandle, uri: String, token: String) -> Result<(), String> {
  let path = staged_path(&app, &token)?;
  let res: Result<Empty, String> = call(
    &app,
    "writeTarget",
    serde_json::to_value(WriteTarget { uri: &uri, path: path.to_string_lossy().into_owned() })
      .map_err(|e| e.to_string())?,
  )
  .await;
  let _ = std::fs::remove_file(&path);
  res.map(|_| ())
}

/// Writes the file put together under `token` as a new file `name` in a
/// folder picked with `android_pick_folder`.
#[tauri::command]
pub async fn android_write_into_folder(
  app: AppHandle,
  folder: String,
  name: String,
  mime: String,
  token: String,
) -> Result<(), String> {
  let path = staged_path(&app, &token)?;
  let res: Result<Empty, String> = call(
    &app,
    "writeIntoFolder",
    json!({ "folder": folder, "name": name, "mime": mime, "path": path.to_string_lossy() }),
  )
  .await;
  let _ = std::fs::remove_file(&path);
  res.map(|_| ())
}

/// Removes a document created by `android_pick_save_target` that was never
/// filled (building the file failed after the location had been picked).
#[tauri::command]
pub async fn android_discard_target(app: AppHandle, uri: String) -> Result<(), String> {
  let _: Empty = call(&app, "discardTarget", json!({ "uri": uri })).await?;
  Ok(())
}

/// Moves a staged file into a cache subfolder under the name it should
/// carry (what the receiving app or the print queue shows), clearing what
/// an earlier share/print left there.
fn move_staged(app: &AppHandle, token: &str, subdir: &str, name: &str) -> Result<PathBuf, String> {
  let from = staged_path(app, token)?;
  let dir = cache_dir(app)?.join(subdir).join(token);
  let _ = std::fs::remove_dir_all(cache_dir(app)?.join(subdir));
  std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать {}: {e}", dir.display()))?;
  let to = dir.join(safe_file_name(name, "document.pdf"));
  std::fs::rename(&from, &to).map_err(|e| format!("Не удалось подготовить файл: {e}"))?;
  Ok(to)
}

/// System share sheet for the file put together under `token`.
#[tauri::command]
pub async fn android_share_file(app: AppHandle, token: String, name: String, mime: String) -> Result<(), String> {
  let path = move_staged(&app, &token, SHARE_DIR, &name)?;
  let _: Empty = call(
    &app,
    "shareFile",
    json!({ "path": path.to_string_lossy(), "mime": mime }),
  )
  .await?;
  Ok(())
}

/// System print dialog for the PDF put together under `token`.
#[tauri::command]
pub async fn android_print_file(app: AppHandle, token: String, name: String) -> Result<(), String> {
  let path = move_staged(&app, &token, PRINT_DIR, &name)?;
  let _: Empty = call(
    &app,
    "printFile",
    json!({ "path": path.to_string_lossy(), "name": safe_file_name(&name, "document.pdf") }),
  )
  .await?;
  Ok(())
}

/// Links of the UI (About box, links in a PDF): handed to the system -
/// browser, mail app or dialer.
#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
  let parsed = crate::parse_external_url(&url)?;
  let _: Empty = call(&app, "openUrl", json!({ "url": parsed.as_str() })).await?;
  Ok(())
}

/// The same from the navigation guard (lib.rs), which runs on the UI thread
/// and must not wait for the plugin there. `url` is already checked.
pub fn open_url_detached(app: AppHandle, url: String) {
  tauri::async_runtime::spawn(async move {
    if let Err(e) = call::<Empty>(&app, "openUrl", json!({ "url": url })).await {
      log::warn!("openUrl: {e}");
    }
  });
}

/// Reading mode: the status and navigation bars are hidden (a swipe from the
/// edge shows them for a moment) and come back when it ends.
#[tauri::command]
pub async fn set_main_window_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
  let _: Empty = call(&app, "setFullscreen", json!({ "fullscreen": fullscreen })).await?;
  Ok(())
}
