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

/// Collect PDF paths from OS / shell arguments (skip flags and the exe name).
fn collect_pdf_paths_from_args<I, S>(args: I) -> Vec<PathBuf>
where
  I: IntoIterator<Item = S>,
  S: AsRef<str>,
{
  let mut files = Vec::new();
  for maybe_file in args {
    let maybe_file = maybe_file.as_ref().trim();
    if maybe_file.is_empty() || maybe_file.starts_with('-') {
      continue;
    }
    if let Ok(url) = url::Url::parse(maybe_file) {
      if url.scheme() == "file" {
        if let Ok(path) = url.to_file_path() {
          if is_pdf_path(&path) {
            files.push(path);
          }
        }
      }
      continue;
    }
    let path = PathBuf::from(maybe_file);
    if is_pdf_path(&path) {
      files.push(path);
    }
  }
  files
}

fn focus_main_window(app: &AppHandle) {
  if let Some(window) = app.get_webview_window("main") {
    let _ = window.unminimize();
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

/// Read a local PDF for the embedded editor (file-association / Open with).
#[tauri::command]
fn read_local_file(path: String) -> Result<Vec<u8>, String> {
  let path = PathBuf::from(path);
  if !is_pdf_path(&path) {
    return Err("Разрешено открывать только файлы .pdf".into());
  }
  if !path.is_file() {
    return Err(format!("Файл не найден: {}", path.display()));
  }
  std::fs::read(&path).map_err(|e| format!("Не удалось прочитать файл: {e}"))
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
        emit_open_files(&app, &paths);
      }
    }))
    .invoke_handler(tauri::generate_handler![
      take_pending_open_files,
      read_local_file
    ])
    .setup(|app| {
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
