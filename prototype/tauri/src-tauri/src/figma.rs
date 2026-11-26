use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex as SyncMutex,
    },
    time::Duration,
};

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use tauri::{
    utils::config::BackgroundThrottlingPolicy,
    webview::{DownloadEvent, NewWindowResponse},
    AppHandle, Manager, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::{
    sync::{oneshot, Mutex},
    time::{sleep, timeout, Instant},
};

const FIGMA_ORIGIN: &str = "https://www.figma.com";
const FILES_PATH: &str = "/files";
const LOGIN_PATH: &str = "/login";
const FIGMA_SCRIPT: &str = include_str!("figma.js");
static CALL_ID: AtomicU64 = AtomicU64::new(1);

struct ActiveDownload {
    editor_path: String,
    temp_path: PathBuf,
    suggested_ext: Option<String>,
    source: Option<Url>,
    result: Option<bool>,
}

#[derive(Default)]
struct WorkState {
    last_fuid: Option<String>,
}

#[derive(Default)]
pub struct FigmaBrowser {
    work: Mutex<WorkState>,
    download: Arc<SyncMutex<Option<ActiveDownload>>>,
}

fn display_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn is_figma_origin(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("www.figma.com")
        && url.port_or_known_default() == Some(443)
}

fn is_allowed_navigation(url: &Url) -> bool {
    match url.scheme() {
        "https" => url.port_or_known_default() == Some(443),
        "blob" | "about" => true,
        _ => false,
    }
}

fn is_auth_flow_route(path: &str) -> bool {
    ["/login", "/signup", "/oauth", "/sso", "/password"]
        .iter()
        .any(|prefix| matches_route(path, prefix))
}

fn matches_route(current: &str, expected: &str) -> bool {
    current == expected
        || current
            .strip_prefix(expected)
            .is_some_and(|tail| tail.starts_with('/'))
}

fn drafts_route(path: &str) -> bool {
    if matches_route(path, "/files/drafts") {
        return true;
    }
    current_team(path)
        .is_some_and(|team| matches_route(path, &format!("/files/team/{team}/drafts")))
}

fn current_team(path: &str) -> Option<&str> {
    let rest = path.strip_prefix("/files/team/")?;
    let team = rest.split('/').next()?;
    (!team.is_empty() && team.bytes().all(|byte| byte.is_ascii_digit())).then_some(team)
}

fn extract_fuid(url: &Url) -> Option<String> {
    url.query_pairs()
        .find(|(k, _)| k == "fuid")
        .map(|(_, v)| v.into_owned())
}

fn navigate(view: &WebviewWindow, path: &str) -> Result<(), String> {
    let target = if path.starts_with("https://") {
        Url::parse(path).map_err(display_error)?
    } else {
        Url::parse(&format!("{FIGMA_ORIGIN}{path}")).map_err(display_error)?
    };
    view.navigate(target).map_err(display_error)
}

async fn evaluate(view: &WebviewWindow, script: String) -> Result<Value, String> {
    let (send, receive) = oneshot::channel::<String>();
    let send = SyncMutex::new(Some(send));
    view.eval_with_callback(script, move |value| {
        if let Ok(mut sender) = send.lock() {
            if let Some(sender) = sender.take() {
                let _ = sender.send(value);
            }
        }
    })
    .map_err(display_error)?;

    let raw = timeout(Duration::from_secs(8), receive)
        .await
        .map_err(|_| "系统 WebView 脚本执行超时。".to_owned())?
        .map_err(display_error)?;

    serde_json::from_str(&raw).map_err(|_| "系统 WebView 未返回可读的脚本结果。".into())
}

async fn call<T: DeserializeOwned>(
    view: &WebviewWindow,
    command: &str,
    args: Value,
    limit: Duration,
) -> Result<T, String> {
    let slot = CALL_ID.fetch_add(1, Ordering::Relaxed);
    let command_json = serde_json::to_string(command).map_err(display_error)?;
    let args_json = serde_json::to_string(&args).map_err(display_error)?;

    let start_script = format!(
        r#"(() => {{
      if (location.origin !== '{FIGMA_ORIGIN}') return false;
      const calls = globalThis.__figmaExportCalls ??= Object.create(null);
      ({FIGMA_SCRIPT})({command_json}, {args_json}).then(
        value => {{ calls[{slot}] = {{ value }}; }},
        error => {{ calls[{slot}] = {{ error: String(error && error.message ? error.message : error) }}; }}
      );
      return true;
    }})()"#
    );

    if evaluate(view, start_script).await? != Value::Bool(true) {
        return Err("Figma 页面尚未准备就绪或已离开预期地址。".into());
    }

    let poll_script = format!(
        r#"(() => {{
      if (location.origin !== '{FIGMA_ORIGIN}') return {{ error: 'Figma 页面已离开预期地址。' }};
      const calls = globalThis.__figmaExportCalls;
      if (!calls || !Object.hasOwn(calls, {slot})) return {{ pending: true }};
      const result = calls[{slot}];
      delete calls[{slot}];
      return result;
    }})()"#
    );

    let end = Instant::now() + limit;
    loop {
        let result = evaluate(view, poll_script.clone()).await?;
        if let Some(err_msg) = result["error"].as_str() {
            return Err(err_msg.into());
        }
        if let Some(val) = result.get("value") {
            return serde_json::from_value(val.clone()).map_err(display_error);
        }
        if Instant::now() >= end {
            return Err("等待 Figma 页面操作结果超时。".into());
        }
        sleep(Duration::from_millis(120)).await;
    }
}

async fn wait_for_document_ready(view: &WebviewWindow, limit: Duration) -> Result<String, String> {
    let script = format!(
        r#"(() => {{
      if (location.origin !== '{FIGMA_ORIGIN}') return 'external';
      if (document.readyState === 'loading' || !document.body) return 'loading';
      if (/^\/(?:login|signup|oauth|sso|password)(?:\/|$)/i.test(location.pathname)) return 'login';
      return 'ready';
    }})()"#
    );

    let end = Instant::now() + limit;
    while Instant::now() < end {
        if let Ok(val) = evaluate(view, script.clone()).await {
            match val.as_str() {
                Some("ready") => return Ok("ready".into()),
                Some("login") => return Ok("login".into()),
                _ => {}
            }
        }
        sleep(Duration::from_millis(250)).await;
    }
    Ok("timeout".into())
}

async fn ensure_figma_api_page(
    view: &WebviewWindow,
    work: &mut WorkState,
) -> Result<(), String> {
    let needs_nav = match view.url() {
        Ok(url) => !is_figma_origin(&url) || is_auth_flow_route(url.path()),
        Err(_) => true,
    };

    if needs_nav {
        navigate(view, "/files/recents-and-sharing")?;
    }

    let state = wait_for_document_ready(view, Duration::from_secs(20)).await?;
    if state == "login" {
        return Err("尚未登录 Figma，请先点击右上角「登录 Figma」完成登录".into());
    }
    if state != "ready" {
        return Err("加载 Figma 页面超时，请检查网络连接后重试".into());
    }

    if let Ok(url) = view.url() {
        if let Some(fuid) = extract_fuid(&url) {
            work.last_fuid = Some(fuid);
        }
    }
    Ok(())
}

async fn open_file_browser(view: &WebviewWindow, work: &mut WorkState) -> Result<Url, String> {
    let on_files = view
        .url()
        .is_ok_and(|u| is_figma_origin(&u) && matches_route(u.path(), FILES_PATH));
    if !on_files {
        navigate(view, "/files/recents-and-sharing")?;
    }
    let state = wait_for_document_ready(view, Duration::from_secs(25)).await?;
    if state == "login" {
        return Err("尚未登录 Figma，请先完成登录".into());
    }
    let current = view.url().map_err(display_error)?;
    if let Some(fuid) = extract_fuid(&current) {
        work.last_fuid = Some(fuid);
    }
    Ok(current)
}

async fn wait_for_pathname_contains(
    view: &WebviewWindow,
    needle: &str,
    limit: Duration,
) -> Result<bool, String> {
    let needle_json = serde_json::to_string(needle).map_err(display_error)?;
    let script = format!(
        r#"(() => {{
      if (location.origin !== '{FIGMA_ORIGIN}') return 'loading';
      if (/^\/(?:login|signup)(?:\/|$)/i.test(location.pathname)) return 'login';
      if (!location.pathname.includes({needle_json})) return 'loading';
      if (document.readyState !== 'complete' || !document.body) return 'loading';
      const mounted = document.querySelectorAll('button, a, input, [role="button"]').length > 3;
      return mounted ? 'ready' : 'loading';
    }})()"#
    );

    let end = Instant::now() + limit;
    while Instant::now() < end {
        if let Ok(val) = evaluate(view, script.clone()).await {
            match val.as_str() {
                Some("ready") => return Ok(true),
                Some("login") => return Err("Figma 登录态已失效，请重新登录".into()),
                _ => {}
            }
        }
        sleep(Duration::from_millis(300)).await;
    }
    Ok(false)
}

async fn open_drafts_page(view: &WebviewWindow, work: &mut WorkState) -> Result<(), String> {
    let browser_url = open_file_browser(view, work).await?;
    if drafts_route(browser_url.path())
        && wait_for_pathname_contains(view, "/drafts", Duration::from_secs(15)).await?
    {
        return Ok(());
    }

    // 优先在侧边栏直接点击 Drafts / 草稿（SPA 路由切换最快且保留当前可用计划上下文）
    let click_drafts = r#"(() => {
      if (location.origin !== 'https://www.figma.com') return false;
      for (const el of document.querySelectorAll('a, button, [role="button"]')) {
        const href = el.getAttribute('href') || '';
        const label = (el.getAttribute('aria-label') || el.textContent || '').trim();
        if ((href.includes('/drafts') || /^(Drafts|草稿|个人草稿|草稿箱)$/i.test(label)) && el.getClientRects().length) {
          el.click();
          return true;
        }
      }
      return false;
    })()"#;

    if evaluate(view, click_drafts.into()).await.ok() == Some(Value::Bool(true))
        && wait_for_pathname_contains(view, "/drafts", Duration::from_secs(12)).await?
    {
        return Ok(());
    }

    if let Some(team) = current_team(browser_url.path()) {
        let mut target = browser_url.clone();
        let route = format!("/files/team/{team}/drafts");
        target.set_path(&route);
        target.set_query(None);
        if let Some(ref fuid) = work.last_fuid {
            target.query_pairs_mut().append_pair("fuid", fuid);
        }
        view.navigate(target).map_err(display_error)?;
        if wait_for_pathname_contains(view, "/drafts", Duration::from_secs(18)).await? {
            return Ok(());
        }
    }

    navigate(view, "/files/drafts")?;
    let _ = wait_for_pathname_contains(view, "/drafts", Duration::from_secs(18)).await?;
    Ok(())
}

async fn open_project_folder_page(
    view: &WebviewWindow,
    work: &WorkState,
    team_id: Option<&str>,
    folder_id: &str,
) -> Result<(), String> {
    let expected_needle = format!("/project/{folder_id}");
    let already_there = view
        .url()
        .is_ok_and(|u| is_figma_origin(&u) && u.path().contains(&expected_needle));

    if already_there
        && wait_for_pathname_contains(view, &expected_needle, Duration::from_secs(10)).await?
    {
        return Ok(());
    }

    let primary_path = match team_id.filter(|s| !s.is_empty()) {
        Some(tid) => format!("/files/team/{tid}/project/{folder_id}"),
        None => format!("/files/project/{folder_id}"),
    };

    let mut target = Url::parse(&format!("{FIGMA_ORIGIN}{primary_path}")).map_err(display_error)?;
    if let Some(ref fuid) = work.last_fuid {
        target.query_pairs_mut().append_pair("fuid", fuid);
    }
    view.navigate(target).map_err(display_error)?;
    let _ = wait_for_pathname_contains(view, "/project/", Duration::from_secs(20)).await?;

    if team_id.is_some() {
        let is_404 = evaluate(
            view,
            r#"Boolean(/Page not found|404/i.test((document.body && document.body.innerText) || ''))"#
                .into(),
        )
        .await
        .unwrap_or(Value::Bool(false))
            == Value::Bool(true);

        if is_404 {
            let mut fallback = Url::parse(&format!("{FIGMA_ORIGIN}/files/project/{folder_id}"))
                .map_err(display_error)?;
            if let Some(ref fuid) = work.last_fuid {
                fallback.query_pairs_mut().append_pair("fuid", fuid);
            }
            view.navigate(fallback).map_err(display_error)?;
            let _ = wait_for_pathname_contains(view, "/project/", Duration::from_secs(20)).await?;
        }
    }

    Ok(())
}

fn export_error_message(code: &str) -> String {
    match code {
        "disabled" => "Figma 显示「保存本地副本」不可用，请检查当前账号的复制和导出权限".into(),
        "menu_missing" => "未能打开 Figma 主菜单，可取消勾选「后台静默导出」后重试查看编辑器界面".into(),
        "file_menu_missing" => "已打开 Figma 主菜单，但未找到「文件」子菜单".into(),
        "save_missing" => "Figma「文件」菜单未显示「保存本地副本」，请检查文件的复制和导出权限".into(),
        other => format!("触发导出失败 ({other})"),
    }
}

impl FigmaBrowser {
    fn remote(&self, app: &AppHandle) -> Result<WebviewWindow, String> {
        if let Some(window) = app.get_webview_window("figma") {
            return Ok(window);
        }

        let download = self.download.clone();
        let initial_url = Url::parse(&format!("{FIGMA_ORIGIN}{FILES_PATH}")).map_err(display_error)?;

        let window = WebviewWindowBuilder::new(app, "figma", WebviewUrl::External(initial_url))
            .title("Figma")
            .inner_size(880.0, 640.0)
            .center()
            .visible(false)
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .on_navigation(is_allowed_navigation)
            .on_new_window(|url, _| {
                if is_allowed_navigation(&url) {
                    NewWindowResponse::Allow
                } else {
                    NewWindowResponse::Deny
                }
            })
            .on_download(move |webview, event| {
                let Ok(mut state) = download.lock() else {
                    return false;
                };
                let Some(active) = state.as_mut() else {
                    return false;
                };
                match event {
                    DownloadEvent::Requested { url, destination } => {
                        let current = webview.url().ok();
                        if active.source.is_some()
                            || !matches!(url.scheme(), "https" | "blob")
                            || !current.is_some_and(|u| {
                                is_figma_origin(&u) && matches_route(u.path(), &active.editor_path)
                            })
                        {
                            return false;
                        }
                        if let Some(ext) = destination.extension().and_then(|e| e.to_str()) {
                            if !ext.is_empty() {
                                active.suggested_ext = Some(format!(".{ext}"));
                            }
                        }
                        active.source = Some(url);
                        destination.clone_from(&active.temp_path);
                    }
                    DownloadEvent::Finished { url, success, .. }
                        if active.source.as_ref() == Some(&url) =>
                    {
                        active.result = Some(success);
                    }
                    _ => {}
                }
                true
            })
            .build()
            .map_err(display_error)?;

        // 用户关闭登录/预览窗口时仅隐藏，保留 WebView 会话供后台导出与导入复用
        let closing = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = closing.hide();
            }
        });

        Ok(window)
    }

    async fn wait_for_download(&self, timeout_sec: u64) -> Result<Option<String>, String> {
        let end = Instant::now() + Duration::from_secs(timeout_sec);
        loop {
            let (started, outcome, suggested_ext) = {
                let state = self.download.lock().map_err(display_error)?;
                let active = state.as_ref().ok_or("下载状态已重置。")?;
                (active.source.is_some(), active.result, active.suggested_ext.clone())
            };
            match outcome {
                Some(true) => return Ok(suggested_ext),
                Some(false) => return Err("系统 WebView 报告文件下载失败。".into()),
                None if Instant::now() >= end => {
                    return Err(if started {
                        format!("导出下载等待超时 ({timeout_sec} 秒)")
                    } else {
                        "触发保存本地副本后未收到下载事件，请检查文件导出权限".into()
                    });
                }
                None => sleep(Duration::from_millis(250)).await,
            }
        }
    }

    async fn handle_auth(&self, app: &AppHandle) -> Result<Value, String> {
        let mut work = self.work.lock().await;
        let view = self.remote(app)?;
        let visible = view.is_visible().unwrap_or(false);

        if let Ok(url) = view.url() {
            if !is_figma_origin(&url) {
                // 如果窗口正处于可见登录状态（如正在跳转 Google SSO / 企业单点登录），绝不打断导航
                if visible {
                    return Ok(json!({
                        "authenticated": false,
                        "user": null,
                        "windowVisible": true,
                    }));
                }
                navigate(&view, FILES_PATH)?;
            } else if is_auth_flow_route(url.path()) {
                return Ok(json!({
                    "authenticated": false,
                    "user": null,
                    "windowVisible": visible,
                }));
            }
        } else if !visible {
            navigate(&view, FILES_PATH)?;
        }

        let doc_state = wait_for_document_ready(&view, Duration::from_secs(12)).await?;
        if doc_state != "ready" {
            return Ok(json!({
                "authenticated": false,
                "user": null,
                "windowVisible": view.is_visible().unwrap_or(false),
            }));
        }

        if let Ok(url) = view.url() {
            if let Some(fuid) = extract_fuid(&url) {
                work.last_fuid = Some(fuid);
            }
        }

        let mut auth = call::<Value>(&view, "auth", Value::Null, Duration::from_secs(15))
            .await
            .unwrap_or_else(|_| json!({ "authenticated": false, "user": null }));

        if let Some(obj) = auth.as_object_mut() {
            obj.insert(
                "windowVisible".into(),
                Value::Bool(view.is_visible().unwrap_or(false)),
            );
        }
        Ok(auth)
    }

    async fn handle_login(&self, app: &AppHandle, args: &Value) -> Result<Value, String> {
        let _work = self.work.lock().await;
        let view = self.remote(app)?;
        let already_auth = args["alreadyAuthenticated"].as_bool().unwrap_or(false);

        if already_auth {
            let on_files = view
                .url()
                .is_ok_and(|u| is_figma_origin(&u) && matches_route(u.path(), FILES_PATH));
            if !on_files {
                navigate(&view, FILES_PATH)?;
            }
        } else {
            let on_login_or_oauth = view
                .url()
                .is_ok_and(|u| !is_figma_origin(&u) || is_auth_flow_route(u.path()));
            if !on_login_or_oauth {
                navigate(&view, LOGIN_PATH)?;
            }
        }

        view.show().map_err(display_error)?;
        view.set_focus().map_err(display_error)?;
        Ok(json!({ "ok": true }))
    }

    async fn handle_logout(&self, app: &AppHandle) -> Result<Value, String> {
        let mut work = self.work.lock().await;
        work.last_fuid = None;
        let view = self.remote(app)?;
        let _ = view.hide();
        view.clear_all_browsing_data().map_err(display_error)?;
        navigate(&view, LOGIN_PATH)?;
        Ok(json!({ "ok": true }))
    }

    async fn handle_request(&self, app: &AppHandle, args: Value) -> Result<Value, String> {
        let mut work = self.work.lock().await;
        let view = self.remote(app)?;
        ensure_figma_api_page(&view, &mut work).await?;
        call(&view, "request", args, Duration::from_secs(30)).await
    }

    async fn handle_discover_teams(&self, app: &AppHandle) -> Result<Value, String> {
        let mut work = self.work.lock().await;
        let view = self.remote(app)?;
        if open_file_browser(&view, &mut work).await.is_err() {
            return Ok(json!([]));
        }
        sleep(Duration::from_millis(800)).await;
        Ok(call::<Value>(&view, "discoverTeams", Value::Null, Duration::from_secs(10))
            .await
            .unwrap_or_else(|_| json!([])))
    }

    async fn handle_download(&self, app: &AppHandle, args: Value) -> Result<Value, String> {
        let work = self.work.lock().await;
        let editor_url_str = args["editorUrl"].as_str().ok_or("缺少文件编辑器链接。")?;
        let target_str = args["targetPath"].as_str().ok_or("缺少本地保存路径。")?;
        let target_path = PathBuf::from(target_str);
        if !target_path.is_absolute() {
            return Err("导出目标路径必须为绝对路径。".into());
        }
        let timeout_sec = args["timeoutSec"].as_u64().unwrap_or(180).clamp(30, 1200);
        let silent = args["silent"].as_bool().unwrap_or(true);

        let mut parsed_url = Url::parse(editor_url_str).map_err(display_error)?;
        if !is_figma_origin(&parsed_url) {
            return Err("无效的 Figma 文件地址。".into());
        }
        let editor_path = parsed_url.path().to_owned();
        if let Some(ref fuid) = work.last_fuid {
            if extract_fuid(&parsed_url).is_none() {
                parsed_url.query_pairs_mut().append_pair("fuid", fuid);
            }
        }

        let parent = target_path.parent().ok_or("无效的导出父目录。")?;
        fs::create_dir_all(parent).map_err(display_error)?;
        let temp_path = PathBuf::from(format!("{}.downloading", target_path.display()));
        let _ = fs::remove_file(&temp_path);

        let view = self.remote(app)?;
        if silent {
            let _ = view.hide();
        } else {
            let _ = view.show();
        }

        view.navigate(parsed_url).map_err(display_error)?;

        // 等待 Figma 编辑器画布与主菜单加载完成
        let ready_deadline = Instant::now() + Duration::from_secs(60);
        let mut editor_ready = false;
        while Instant::now() < ready_deadline {
            sleep(Duration::from_millis(650)).await;
            let Ok(state) =
                call::<Value>(&view, "editorState", Value::Null, Duration::from_secs(8)).await
            else {
                continue;
            };
            match state["status"].as_str() {
                Some("ready") => {
                    sleep(Duration::from_millis(1400)).await;
                    editor_ready = true;
                    break;
                }
                Some("community_page") => {
                    return Err("Figma 打开的是 Community 资源页，请在文件列表中选择已复制到账号的设计文件".into());
                }
                Some("login_required") => {
                    return Err("Figma 要求重新登录后才能打开该文件".into());
                }
                Some("no_access") => {
                    let snippet = state["snippet"].as_str().unwrap_or("").replace('\n', " ");
                    return Err(format!("无权访问或文件不存在 ({snippet})"));
                }
                _ => {}
            }
        }

        if !editor_ready {
            let has_canvas = evaluate(&view, "Boolean(document.querySelector('canvas'))".into())
                .await
                .unwrap_or(Value::Bool(false))
                == Value::Bool(true);
            if !has_canvas {
                return Err("编辑器加载超时（未检测到画布）".into());
            }
        }

        *self.download.lock().map_err(display_error)? = Some(ActiveDownload {
            editor_path,
            temp_path: temp_path.clone(),
            suggested_ext: None,
            source: None,
            result: None,
        });

        let outcome = async {
            let trigger_res =
                call::<Value>(&view, "triggerExport", Value::Null, Duration::from_secs(20)).await?;
            let status = trigger_res["status"].as_str().unwrap_or("menu_missing");
            if status != "clicked" {
                return Err(export_error_message(status));
            }
            self.wait_for_download(timeout_sec).await
        }
        .await;

        *self.download.lock().map_err(display_error)? = None;

        let suggested_ext = match outcome {
            Ok(ext) => ext,
            Err(err) => {
                let _ = fs::remove_file(&temp_path);
                if !silent {
                    let _ = view.hide();
                }
                return Err(err);
            }
        };

        let meta = fs::metadata(&temp_path).map_err(display_error)?;
        let bytes = meta.len();
        if bytes == 0 {
            let _ = fs::remove_file(&temp_path);
            return Err("下载的文件大小为 0 字节".into());
        }

        let mut final_path = target_path.clone();
        if let Some(sug_ext) = suggested_ext {
            let cur_ext = target_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| format!(".{s}"))
                .unwrap_or_default();
            if !sug_ext.eq_ignore_ascii_case(&cur_ext) {
                let stem = target_path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Untitled");
                final_path = parent.join(format!("{stem}{sug_ext}"));
            }
        }

        fs::rename(&temp_path, &final_path).map_err(|err| {
            let _ = fs::remove_file(&temp_path);
            display_error(err)
        })?;

        if !silent {
            let _ = view.hide();
        }

        Ok(json!({
            "localPath": final_path,
            "fileSize": bytes,
        }))
    }

    async fn handle_upload(&self, app: &AppHandle, args: Value) -> Result<Value, String> {
        let mut work = self.work.lock().await;
        let local_str = args["localPath"].as_str().ok_or("缺少待导入文件路径。")?;
        let local_path = PathBuf::from(local_str);
        if !local_path.is_absolute() || !local_path.is_file() {
            return Err(format!("本地文件不存在: {local_str}"));
        }

        let ext = local_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if !matches!(ext.as_str(), "fig" | "jam" | "deck" | "sketch") {
            return Err(format!("不支持导入的文件后缀: .{ext}"));
        }

        let file_meta = fs::metadata(&local_path).map_err(display_error)?;
        let total_bytes = file_meta.len();
        if total_bytes == 0 {
            return Err("本地文件大小为 0 字节，无法导入。".into());
        }

        let file_name = args["fileName"]
            .as_str()
            .map(ToOwned::to_owned)
            .or_else(|| local_path.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| format!("Import.{ext}"));
        let expected_title = args["title"]
            .as_str()
            .unwrap_or_else(|| Path::new(&file_name).file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled"))
            .trim()
            .to_lowercase();

        let destination = &args["destination"];
        let is_drafts = destination["isDrafts"].as_bool().unwrap_or(true);
        let team_id = destination["teamId"].as_str();
        let folder_id = destination["folderId"].as_str();

        let existing_keys: HashSet<String> = args["existingKeys"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_default();

        let timeout_sec = args["timeoutSec"].as_u64().unwrap_or(240).clamp(30, 1800);
        let silent = args["silent"].as_bool().unwrap_or(true);

        let view = self.remote(app)?;
        if silent {
            let _ = view.hide();
        } else {
            let _ = view.show();
        }

        if is_drafts {
            open_drafts_page(&view, &mut work).await?;
        } else {
            let fid = folder_id.ok_or("缺少目标文件夹 ID。")?;
            open_project_folder_page(&view, &work, team_id, fid).await?;
        }

        // 等待文件浏览器加载就绪
        let ready_deadline = Instant::now() + Duration::from_secs(35);
        let mut browser_ready = false;
        while Instant::now() < ready_deadline {
            if let Ok(bs) =
                call::<Value>(&view, "browserState", Value::Null, Duration::from_secs(6)).await
            {
                match bs["status"].as_str() {
                    Some("ready") => {
                        sleep(Duration::from_millis(800)).await;
                        browser_ready = true;
                        break;
                    }
                    Some("login_required") => {
                        return Err("Figma 登录态已失效，请重新登录".into());
                    }
                    Some("no_access") => {
                        let snippet = bs["snippet"].as_str().unwrap_or("");
                        return Err(format!("无法访问目标文件夹 ({snippet})"));
                    }
                    _ => {}
                }
            }
            sleep(Duration::from_millis(500)).await;
        }

        if !browser_ready {
            return Err("目标文件夹页面加载超时".into());
        }

        // 分块流式读取文件进入 WebView 并触发导入
        let upload_result: Result<(), String> = async {
            call::<Value>(&view, "resetUpload", Value::Null, Duration::from_secs(5)).await?;
            let mut file = fs::File::open(&local_path).map_err(display_error)?;
            let mut buf = vec![0u8; 512 * 1024];
            let mut read_total = 0u64;

            loop {
                let n = file.read(&mut buf).map_err(display_error)?;
                if n == 0 {
                    break;
                }
                read_total += n as u64;
                let encoded = json!(STANDARD.encode(&buf[..n]));
                call::<Value>(&view, "uploadChunk", encoded, Duration::from_secs(10)).await?;
            }

            if read_total != total_bytes {
                return Err("读取本地文件时字节数不一致，文件可能在导入期间被修改。".into());
            }

            call::<Value>(
                &view,
                "submitUpload",
                json!({ "fileName": file_name }),
                Duration::from_secs(20),
            )
            .await?;
            Ok(())
        }
        .await;

        if let Err(err) = upload_result {
            let _ = call::<Value>(&view, "clearUpload", Value::Null, Duration::from_secs(3)).await;
            if !silent {
                let _ = view.hide();
            }
            return Err(err);
        }

        // 轮询等待导入完成（检查编辑器跳转、完成弹窗、错误提示与文件夹 API 落盘校验）
        let start = Instant::now();
        let deadline = start + Duration::from_secs(timeout_sec);
        let mut last_api_poll = Instant::now() - Duration::from_secs(10);
        let mut saw_importing = false;

        while Instant::now() < deadline {
            sleep(Duration::from_millis(1000)).await;

            // 1. 检查是否自动跳转进了新导入的文件编辑器页
            if let Ok(cur_url) = view.url() {
                if is_figma_origin(&cur_url) {
                    let segs: Vec<&str> = cur_url.path().trim_start_matches('/').split('/').collect();
                    if segs.len() >= 2
                        && matches!(segs[0], "design" | "file" | "board" | "slides" | "site" | "buzz")
                    {
                        let key = segs[1];
                        if !key.is_empty() && !existing_keys.contains(key) {
                            if !silent {
                                let _ = view.hide();
                            }
                            return Ok(json!({ "importedKey": key }));
                        }
                    }
                }
            }

            // 2. 检查页面弹窗状态
            let mut currently_importing = false;
            if let Ok(ui) =
                call::<Value>(&view, "checkImportUi", Value::Null, Duration::from_secs(6)).await
            {
                match ui["status"].as_str() {
                    Some("error") => {
                        if !silent {
                            let _ = view.hide();
                        }
                        return Err(ui["message"]
                            .as_str()
                            .unwrap_or("Figma 报告文件导入失败")
                            .to_owned());
                    }
                    Some("importing") => {
                        currently_importing = true;
                        saw_importing = true;
                    }
                    Some("done") => {
                        sleep(Duration::from_millis(700)).await;
                        if !silent {
                            let _ = view.hide();
                        }
                        return Ok(json!({ "importedKey": null }));
                    }
                    _ => {}
                }
            }

            // 3. 每隔 3 秒通过 Figma 文件夹 API 核对是否已出现新文件 Key
            if !currently_importing
                && start.elapsed() >= Duration::from_millis(2500)
                && last_api_poll.elapsed() >= Duration::from_secs(3)
            {
                last_api_poll = Instant::now();
                if let Ok(files_val) = call::<Value>(
                    &view,
                    "pollFolderFiles",
                    json!({
                        "folderId": folder_id,
                        "isDrafts": is_drafts,
                    }),
                    Duration::from_secs(12),
                )
                .await
                {
                    if let Some(arr) = files_val.as_array() {
                        for item in arr {
                            let Some(k) = item["key"].as_str() else { continue };
                            if existing_keys.contains(k) {
                                continue;
                            }
                            let name_str = item["name"].as_str().unwrap_or("");
                            let name_lower = name_str.trim().to_lowercase();
                            let name_matches = !expected_title.is_empty()
                                && (name_lower.contains(&expected_title)
                                    || expected_title.contains(&name_lower));
                            if name_matches || saw_importing {
                                sleep(Duration::from_millis(500)).await;
                                if !silent {
                                    let _ = view.hide();
                                }
                                return Ok(json!({
                                    "importedKey": k,
                                    "importedName": name_str,
                                }));
                            }
                        }
                    }
                }
            }
        }

        if !silent {
            let _ = view.hide();
        }
        Err(format!(
            "导入等待超时 ({timeout_sec} 秒)，若文件较大可调大超时时间，或取消勾选「后台静默导入」观察页面提示"
        ))
    }
}

#[tauri::command]
pub async fn figma_browser(
    window: WebviewWindow,
    state: State<'_, FigmaBrowser>,
    action: String,
    args: Value,
) -> Result<Value, String> {
    super::local_window(&window)?;
    let app = window.app_handle();
    match action.as_str() {
        "hide_login" => {
            if let Some(view) = app.get_webview_window("figma") {
                let _ = view.hide();
            }
            Ok(json!({ "ok": true }))
        }
        "auth" => state.handle_auth(app).await,
        "login" => state.handle_login(app, &args).await,
        "logout" => state.handle_logout(app).await,
        "request" => state.handle_request(app, args).await,
        "discover_teams" => state.handle_discover_teams(app).await,
        "download" => state.handle_download(app, args).await,
        "upload" => state.handle_upload(app, args).await,
        _ => Err(format!("未知的浏览器操作: {action}")),
    }
}
