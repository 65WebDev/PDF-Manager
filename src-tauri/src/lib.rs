use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

/// PDF paths waiting to be opened by the web UI (cold start via file association).
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

fn focus_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
  }
}

/// Maximize the main window (Windows “развернуть”), not exclusive fullscreen.
fn maximize_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.maximize();
    let _ = window.set_focus();
  }
}

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
#[tauri::command]
fn maximize_main_window_cmd(app: AppHandle) {
  maximize_main_window(&app);
}

/// Read a local PDF for the embedded editor (file-association / Open with).
#[tauri::command]
fn read_local_file(path: String) -> Result<Vec<u8>, String> {
  let path = PathBuf::from(normalize_arg(&path));
  if !is_pdf_path(&path) {
    return Err("Разрешено открывать только файлы .pdf".into());
  }
  if !path.is_file() {
    return Err(format!("Файл не найден: {}", path.display()));
  }
  std::fs::read(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // argv[0] is the executable; the rest may include PDF paths from the shell.
  let startup_files = collect_pdf_paths_from_args(std::env::args().skip(1));

  tauri::Builder::default()
    .manage(PendingOpenFiles(Mutex::new(startup_files)))
    .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
      // Second instance: focus the running app and forward any PDF paths.
      focus_main_window(&app);
      let paths = collect_pdf_paths_from_args(args.iter().skip(1).map(String::as_str));
      if !paths.is_empty() {
        maximize_main_window(&app);
        emit_open_files(&app, &paths);
      }
    }))
    .invoke_handler(tauri::generate_handler![
      take_pending_open_files,
      read_local_file,
      write_local_file,
      fetch_url_text,
      maximize_main_window_cmd
    ])
    .setup(move |app| {
      // Always start maximized (Windows "развернуть"), not just when opened
      // via a PDF file association — a plain launch from the shortcut/Start
      // menu used to open windowed at the tauri.conf.json default size.
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

#[cfg(test)]
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
  fn file_url_is_collected() {
    let paths = collect_pdf_paths_from_args(["file:///C:/temp/x.pdf"]);
    assert_eq!(paths.len(), 1);
  }
}
