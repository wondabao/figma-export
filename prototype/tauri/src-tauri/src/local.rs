use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{atomic::{AtomicU64, Ordering}, Mutex},
};
use tauri::{Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

static TEMP_ID: AtomicU64 = AtomicU64::new(0);
const MANIFEST: &str = "export-manifest.json";
const SETTINGS: &str = "exporter-config.json";

#[derive(Default)]
pub struct LocalFiles {
    pub selected: Mutex<HashSet<PathBuf>>,
}

pub fn error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn absolute(value: &Value) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.as_str().ok_or("缺少文件路径。")?);
    if !path.is_absolute() {
        return Err("请选择绝对文件路径。".into());
    }
    Ok(path)
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("无效的保存位置。")?).map_err(error)?;
    let id = TEMP_ID.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_extension(format!("json.{}.{id}.tmp", std::process::id()));
    fs::write(&temp, serde_json::to_vec_pretty(value).map_err(error)?).map_err(error)?;
    if let Err(err) = fs::rename(&temp, path) {
        let _ = fs::remove_file(temp);
        return Err(error(err));
    }
    Ok(())
}

fn name(path: &Path) -> String {
    path.file_name().unwrap_or_default().to_string_lossy().into_owned()
}

fn collect_file(path: &Path, root: Option<&Path>, manifest: &HashMap<PathBuf, Value>, seen: &mut HashSet<PathBuf>, items: &mut Vec<Value>) {
    let Ok(file) = fs::canonicalize(path) else { return; };
    let ext = file.extension().and_then(|ext| ext.to_str()).unwrap_or_default().to_ascii_lowercase();
    if !matches!(ext.as_str(), "fig" | "jam" | "deck" | "sketch") || seen.contains(&file) { return; }
    let Ok(info) = fs::metadata(&file) else { return; };
    if !info.is_file() || info.len() == 0 { return; }
    seen.insert(file.clone());
    let parent = path.parent().unwrap_or(path);
    let group = root.and_then(|root| parent.strip_prefix(root).ok());
    let components = group.map(|group| group.iter().map(|c| c.to_string_lossy().into_owned()).collect::<Vec<_>>()).unwrap_or_default();
    let (team, folder) = match components.as_slice() {
        [] => (String::new(), root.map(name).unwrap_or_else(|| name(parent))),
        [only] => (String::new(), only.clone()),
        [team, rest @ ..] => (team.clone(), rest.join(" - ")),
    };
    let record = manifest.get(&file);
    let file_name = name(path);
    let title = path.file_stem().and_then(|value| value.to_str()).unwrap_or("Untitled").trim();
    items.push(json!({
        "id": file, "localPath": file, "fileName": file_name,
        "title": record.and_then(|value| value["name"].as_str()).unwrap_or(title),
        "extension": format!(".{ext}"), "fileSize": info.len(),
        "suggestedTeam": record.and_then(|value| value["teamName"].as_str()).unwrap_or(&team),
        "suggestedFolder": record.and_then(|value| value["folderName"].as_str()).filter(|value| !value.is_empty()).unwrap_or(if folder.is_empty() { "Imported" } else { &folder }),
        "status": "pending", "error": null,
    }));
}

fn collect(paths: &[Value]) -> (HashSet<PathBuf>, Vec<Value>) {
    let mut seen = HashSet::new();
    let mut items = Vec::new();
    for path in paths {
        let Ok(path) = absolute(path) else { continue; };
        if !path.is_dir() {
            collect_file(&path, None, &HashMap::new(), &mut seen, &mut items);
            continue;
        }
        let mut manifest = HashMap::new();
        if let Some(Value::Object(records)) = read_json(&path.join(MANIFEST)).map(|value| value["files"].clone()) {
            for record in records.into_values() {
                if let Ok(location) = absolute(&record["localPath"]).and_then(|path| fs::canonicalize(path).map_err(error)) {
                    manifest.insert(location, record);
                }
            }
        }
        let mut directories = vec![path.clone()];
        while let Some(directory) = directories.pop() {
            let Ok(entries) = fs::read_dir(directory) else { continue; };
            let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
            entries.sort_by_key(fs::DirEntry::file_name);
            for entry in entries {
                if entry.file_name().to_string_lossy().starts_with('.') { continue; }
                let Ok(kind) = entry.file_type() else { continue; };
                if kind.is_dir() {
                    directories.push(entry.path());
                } else if kind.is_file() {
                    collect_file(&entry.path(), Some(&path), &manifest, &mut seen, &mut items);
                }
            }
        }
    }
    (seen, items)
}

#[tauri::command]
pub async fn local_files(window: WebviewWindow, state: State<'_, LocalFiles>, action: String, args: Value) -> Result<Value, String> {
    super::local_window(&window)?;
    let host = window.app_handle();
    let directory = host.path();
    let settings = directory.app_data_dir().map_err(error)?.join(SETTINGS);
    match action.as_str() {
        "paths" => Ok(json!({
            "documents": directory.document_dir().map_err(error)?,
            "home": directory.home_dir().map_err(error)?,
            "platform": if cfg!(target_os = "macos") { "darwin" } else if cfg!(windows) { "win32" } else { "linux" },
        })),
        "load_config" => {
            let legacy = directory.data_dir().map_err(error)?.join("Figma 一键导出工具").join(SETTINGS);
            Ok(read_json(&settings).filter(Value::is_object).or_else(|| read_json(&legacy).filter(Value::is_object)).unwrap_or(Value::Object(Map::new())))
        }
        "save_config" => { write_json(&settings, &args["config"])?; Ok(Value::Null) }
        "ensure_dir" => { fs::create_dir_all(absolute(&args["path"])?).map_err(error)?; Ok(Value::Null) }
        "exists" => Ok(json!(absolute(&args["path"])?.is_file())),
        "load_manifest" => Ok(read_json(&absolute(&args["path"])?.join(MANIFEST)).filter(|value| value["files"].is_object()).unwrap_or_else(|| json!({"version": 1, "updatedAt": null, "files": {}}))),
        "save_manifest" => { write_json(&absolute(&args["path"])?.join(MANIFEST), &args["manifest"])?; Ok(Value::Null) }
        "open_folder" => {
            let path = absolute(&args["path"])?;
            let command = if cfg!(target_os = "macos") { "open" } else if cfg!(windows) { "explorer.exe" } else { "xdg-open" };
            Command::new(command).arg(path).spawn().map_err(error)?;
            Ok(json!(""))
        }
        "choose" => {
            let options = &args["options"];
            let properties = options["properties"].as_array().cloned().unwrap_or_default();
            let multi = properties.contains(&json!("multiSelections"));
            let folder = properties.contains(&json!("openDirectory"));
            let mut picker = host.dialog().file().set_parent(&window);
            if let Some(title) = options["title"].as_str() { picker = picker.set_title(title); }
            if let Ok(path) = absolute(&options["defaultPath"]) { picker = picker.set_directory(path); }
            if !folder { picker = picker.add_filter("Figma & Sketch", &["fig", "jam", "deck", "sketch"]); }
            let selection = tauri::async_runtime::spawn_blocking(move || match (folder, multi) {
                (true, true) => picker.blocking_pick_folders(),
                (true, false) => picker.blocking_pick_folder().map(|item| vec![item]),
                (false, true) => picker.blocking_pick_files(),
                (false, false) => picker.blocking_pick_file().map(|item| vec![item]),
            }).await.map_err(error)?;
            let file_paths = selection.unwrap_or_default().into_iter().filter_map(|item| item.into_path().ok()).collect::<Vec<_>>();
            Ok(json!({"canceled": file_paths.is_empty(), "filePaths": file_paths}))
        }
        "collect_files" => {
            let paths = args["paths"].as_array().cloned().unwrap_or_default();
            let (seen, items) = tauri::async_runtime::spawn_blocking(move || collect(&paths)).await.map_err(error)?;
            state.selected.lock().map_err(error)?.extend(seen);
            Ok(json!(items))
        }
        _ => Err("未知的本地文件操作。".into()),
    }
}
