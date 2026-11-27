#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod figma;
mod local;
mod updater;

use figma::FigmaBrowser;
use local::LocalFiles;
use updater::AppUpdater;
use std::time::Duration;
use tauri::{webview::PageLoadEvent, Manager, WebviewWindow, WindowEvent};

const WEBVIEW_SMOKE: &str = r#"(() => {
  const input = document.createElement('input');
  input.type = 'file';
  const transfer = new DataTransfer();
  transfer.items.add(new File(['fig'], 'smoke.fig'));
  input.files = transfer.files;
  const domOk = input.files[0]?.name === 'smoke.fig'
    && input.files[0]?.size === 3
    && typeof window.__TAURI__?.core?.invoke === 'function'
    && typeof window.figmaExporter?.getState === 'function'
    && Boolean(document.getElementById('tabExport'))
    && Boolean(document.getElementById('tabImport'))
    && Boolean(document.getElementById('treeContainer'));
  if (!domOk) return false;
  window.figmaExporter.getState().then(
    state => { globalThis.__smokeStateOk = Boolean(state && state.config && state.homeDir); },
    () => { globalThis.__smokeStateOk = false; }
  );
  return true;
})()"#;

pub fn local_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("仅应用主窗口可执行本地操作。".into());
    }
    Ok(())
}

fn main() {
    let smoke = std::env::args().any(|arg| arg == "--smoke-test");
    let login = !smoke && std::env::args().any(|arg| arg == "--login");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LocalFiles::default())
        .manage(FigmaBrowser::default())
        .manage(AppUpdater::default())
        .setup(move |app| {
            if let Some(main_win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main_win.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Destroyed) {
                        app_handle.exit(0);
                    }
                });
            }

            if smoke {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(20)).await;
                    app_handle.exit(2);
                });
            }

            if login {
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(main_win) = app_handle.get_webview_window("main") {
                        let state = app_handle.state::<FigmaBrowser>();
                        let _ = figma::figma_browser(
                            main_win,
                            state,
                            "login".into(),
                            serde_json::json!({ "alreadyAuthenticated": false }),
                        )
                        .await;
                    }
                });
            }

            Ok(())
        })
        .on_page_load(move |webview, payload| {
            if webview.label() == "main" && payload.event() == PageLoadEvent::Finished {
                if smoke {
                    let app_handle = webview.app_handle().clone();
                    let result = webview.eval_with_callback(WEBVIEW_SMOKE, move |value| {
                        app_handle.exit(if value == "true" { 0 } else { 1 });
                    });
                    if result.is_err() {
                        webview.app_handle().exit(1);
                    }
                } else {
                    let win = webview.window();
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            local::local_files,
            figma::figma_browser,
            updater::app_updater
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Figma Export Tauri application");
}
