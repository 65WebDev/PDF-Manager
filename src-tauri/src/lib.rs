use std::path::{Path, PathBuf};
#[cfg(not(target_os = "android"))]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(target_os = "android"))]
use tauri::State;

#[cfg(target_os = "android")]
mod android;

/// PDF paths waiting to be opened by the web UI (cold start via file association).
#[cfg(not(target_os = "android"))]
struct PendingOpenFiles(Mutex<Vec<PathBuf>>);

fn is_pdf_path(path: &Path) -> bool {
  path
    .extension()
    .and_then(|e| e.to_str())
    .map(|e| e.eq_ignore_ascii_case("pdf"))
    .unwrap_or(false)
}

fn normalize_arg(raw: &str) -> String {
  let s = raw.trim();
  // Windows may wrap paths in quotes when launched via shell / Open with.
  let s = s.trim_matches('"').trim_matches('\'').trim();
  s.to_string()
}

/// Collect PDF paths from OS / shell arguments (skip flags and the exe name).
///
/// Important: do NOT feed bare Windows paths like `C:\file.pdf` to `Url::parse` —
/// the `C:` is treated as a URL scheme and the path was previously skipped.
#[cfg(not(target_os = "android"))]
fn collect_pdf_paths_from_args<I, S>(args: I) -> Vec<PathBuf>
where
  I: IntoIterator<Item = S>,
  S: AsRef<str>,
{
  let mut files = Vec::new();
  for maybe_file in args {
    let maybe_file = normalize_arg(maybe_file.as_ref());
    if maybe_file.is_empty() || maybe_file.starts_with('-') {
      continue;
    }

    // Only parse as URL when it really looks like one (file://...).
    if maybe_file.contains("://") {
      if let Ok(url) = url::Url::parse(&maybe_file) {
        if url.scheme() == "file" {
          if let Ok(path) = url.to_file_path() {
            if is_pdf_path(&path) {
              files.push(path);
            }
          }
        }
      }
      continue;
    }

    let path = PathBuf::from(&maybe_file);
    if is_pdf_path(&path) {
      files.push(path);
    }
  }
  files
}

#[cfg(desktop)]
fn focus_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// Maximize the main window (Windows “развернуть”), not exclusive fullscreen.
/// Left alone while it is full screen (reading mode): that ends on its own
/// and brings the window back as it was.
#[cfg(desktop)]
fn maximize_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    if !window.is_fullscreen().unwrap_or(false) {
      let _ = window.maximize();
    }
    let _ = window.set_focus();
  }
}

#[cfg(desktop)]
fn emit_open_files(app: &AppHandle, paths: &[PathBuf]) {
  if paths.is_empty() {
    return;
  }
  let payload: Vec<String> = paths
    .iter()
    .map(|p| p.to_string_lossy().into_owned())
    .collect();
  let _ = app.emit("open-files", payload);
}

/// Drain cold-start paths once the UI is ready.
/// (Android: `android::take_pending_open_files` — files sent to the app.)
#[cfg(not(target_os = "android"))]
#[tauri::command]
fn take_pending_open_files(state: State<'_, PendingOpenFiles>) -> Vec<String> {
  match state.0.lock() {
    Ok(mut guard) => guard
      .drain(..)
      .map(|p| p.to_string_lossy().into_owned())
      .collect(),
    Err(_) => Vec::new(),
  }
}

/// Maximize the main window when the UI opens a document (file picker / DnD / etc.).
/// Nothing to do on a phone: the app always fills the screen.
#[cfg(desktop)]
#[tauri::command]
fn maximize_main_window_cmd(app: AppHandle) {
  maximize_main_window(&app);
}

#[cfg(mobile)]
#[tauri::command]
fn maximize_main_window_cmd() {}

/// Reading mode: the main window covers the whole screen (no title bar, no
/// taskbar); leaving it returns the window to its previous state.
/// (Android: `android::set_main_window_fullscreen` hides the system bars.)
#[cfg(desktop)]
#[tauri::command]
fn set_main_window_fullscreen(app: AppHandle, fullscreen: bool) -> Result<(), String> {
  let window = app
    .get_webview_window("main")
    .ok_or_else(|| "Главное окно не найдено".to_string())?;
  window
    .set_fullscreen(fullscreen)
    .map_err(|e| format!("Полноэкранный режим: {e}"))?;
  let _ = window.set_focus();
  Ok(())
}

/// Read a local PDF for the embedded editor (file-association / Open with).
/// Sent back as raw bytes (an ArrayBuffer in the UI), not a JSON array of
/// numbers - several times smaller and faster to take apart for a big PDF.
#[tauri::command]
fn read_local_file(path: String) -> Result<tauri::ipc::Response, String> {
  let path = PathBuf::from(normalize_arg(&path));
  if !is_pdf_path(&path) {
    return Err("Разрешено открывать только файлы .pdf".into());
  }
  if !path.is_file() {
    return Err(format!("Файл не найден: {}", path.display()));
  }
  std::fs::read(&path)
    .map(tauri::ipc::Response::new)
    .map_err(|e| format!("Не удалось прочитать файл: {e}"))
}

/// Write bytes straight to a local path — used for regular Save on a
/// document opened from a known native path (file association / Explorer
/// drag-drop / second instance), so the UI can skip the save-location
/// dialog. Restricted to .pdf like read_local_file, and requires the parent
/// directory to already exist (this is meant to overwrite a file the user
/// already opened, not create arbitrary new paths/directories).
#[tauri::command]
fn write_local_file(path: String, data: Vec<u8>) -> Result<(), String> {
  let path = PathBuf::from(normalize_arg(&path));
  if !is_pdf_path(&path) {
    return Err("Разрешено сохранять только файлы .pdf".into());
  }
  match path.parent() {
    Some(dir) if dir.as_os_str().is_empty() || dir.is_dir() => {}
    _ => return Err(format!("Папка не найдена: {}", path.display())),
  }
  std::fs::write(&path, &data).map_err(|e| format!("Не удалось сохранить файл: {e}"))
}

/// Fetch a small text URL for the About update check (bypasses WebView CORS).
#[tauri::command]
async fn fetch_url_text(url: String) -> Result<String, String> {
  let url = url.trim().to_string();
  if !(url.starts_with("https://") || url.starts_with("http://")) {
    return Err("Разрешены только HTTP(S) URL".into());
  }
  let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(12))
    .build()
    .map_err(|e| format!("HTTP-клиент: {e}"))?;
  let resp = client
    .get(&url)
    .header(reqwest::header::USER_AGENT, "PDF-Manager-Desktop")
    .send()
    .await
    .map_err(|e| format!("Сеть: {e}"))?;
  if !resp.status().is_success() {
    return Err(format!("HTTP {}", resp.status()));
  }
  resp.text().await.map_err(|e| format!("Чтение ответа: {e}"))
}

/// Only https:// links leave the app (About box: download page, repository).
fn parse_external_url(url: &str) -> Result<url::Url, String> {
  let parsed = url::Url::parse(url.trim()).map_err(|e| format!("Неверный адрес: {e}"))?;
  if parsed.scheme() != "https" {
    return Err("Разрешены только HTTPS-ссылки".into());
  }
  Ok(parsed)
}

/// Open an https:// link in the system browser — the About box's download
/// page of a newer release and the repository link (target=_blank does not
/// leave the WebView on its own).
/// (Android: `android::open_external_url` hands it to the system.)
#[cfg(desktop)]
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let parsed = parse_external_url(&url)?;
  let target = parsed.as_str();
  #[cfg(target_os = "windows")]
  let spawned = std::process::Command::new("rundll32")
    .args(["url.dll,FileProtocolHandler", target])
    .spawn();
  #[cfg(target_os = "macos")]
  let spawned = std::process::Command::new("open").arg(target).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let spawned = std::process::Command::new("xdg-open").arg(target).spawn();
  spawned
    .map(|_| ())
    .map_err(|e| format!("Не удалось открыть ссылку: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default();

  // argv[0] is the executable; the rest may include PDF paths from the shell.
  #[cfg(desktop)]
  let builder = builder
    .manage(PendingOpenFiles(Mutex::new(collect_pdf_paths_from_args(
      std::env::args().skip(1),
    ))))
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      // Second instance: focus the running app and forward any PDF paths.
      focus_main_window(app);
      let paths = collect_pdf_paths_from_args(args.iter().skip(1).map(String::as_str));
      if !paths.is_empty() {
        maximize_main_window(app);
        emit_open_files(app, &paths);
      }
    }));

  // Android: files come in as intents ("Open with", "Share"), and saving,
  // sharing and printing go through the system - see android.rs.
  #[cfg(target_os = "android")]
  let builder = builder.plugin(android::init());

  builder
    .invoke_handler(tauri::generate_handler![
      #[cfg(not(target_os = "android"))]
      take_pending_open_files,
      #[cfg(target_os = "android")]
      android::take_pending_open_files,
      read_local_file,
      write_local_file,
      fetch_url_text,
      #[cfg(desktop)]
      open_external_url,
      #[cfg(target_os = "android")]
      android::open_external_url,
      maximize_main_window_cmd,
      #[cfg(desktop)]
      set_main_window_fullscreen,
      #[cfg(target_os = "android")]
      android::set_main_window_fullscreen,
      #[cfg(target_os = "android")]
      android::android_stage_chunk,
      #[cfg(target_os = "android")]
      android::android_pick_save_target,
      #[cfg(target_os = "android")]
      android::android_pick_folder,
      #[cfg(target_os = "android")]
      android::android_write_target,
      #[cfg(target_os = "android")]
      android::android_write_into_folder,
      #[cfg(target_os = "android")]
      android::android_discard_target,
      #[cfg(target_os = "android")]
      android::android_share_file,
      #[cfg(target_os = "android")]
      android::android_print_file
    ])
    .setup(move |app| {
      // Always start maximized (Windows "развернуть"), not just when opened
      // via a PDF file association — a plain launch from the shortcut/Start
      // menu used to open windowed at the tauri.conf.json default size.
      #[cfg(desktop)]
      maximize_main_window(app.handle());
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(all(test, desktop))]
mod tests {
  use super::*;

  #[test]
  fn windows_drive_path_is_collected() {
    let paths = collect_pdf_paths_from_args([r"C:\Users\UJIN\Documents\report.pdf"]);
    assert_eq!(paths.len(), 1);
    assert!(paths[0].to_string_lossy().ends_with("report.pdf"));
  }

  #[test]
  fn quoted_windows_path_is_collected() {
    let paths = collect_pdf_paths_from_args([r#""D:\docs\a b.pdf""#]);
    assert_eq!(paths.len(), 1);
  }

  #[test]
  fn open_external_url_rejects_non_https() {
    assert!(open_external_url("http://example.com".into()).is_err());
    assert!(open_external_url("file:///etc/passwd".into()).is_err());
    assert!(open_external_url("not a url".into()).is_err());
  }

  #[test]
  fn file_url_is_collected() {
    let paths = collect_pdf_paths_from_args(["file:///C:/temp/x.pdf"]);
    assert_eq!(paths.len(), 1);
  }
}
