use serde_json::{json, Value};
use std::{
    cmp::Ordering,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State, WebviewWindow};

const RELEASES_API: &str = "https://api.github.com/repos/wondabao/figma-export/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/wondabao/figma-export/releases/latest";
const GITHUB_REPO_PAGE: &str = "https://github.com/wondabao/figma-export";
const WEBSITE_PAGE: &str = "https://www.yypic.com";

#[derive(Clone, Default)]
struct ReadyPayload {
    latest_version: String,
    kind: String,
    target_path: PathBuf,
    #[cfg_attr(not(windows), allow(dead_code))]
    install_dir: PathBuf,
    staged_path: PathBuf,
    version_dir: PathBuf,
}

#[derive(Clone)]
struct UpdaterData {
    status: String,
    latest_version: Option<String>,
    available: bool,
    comparison: i32,
    can_install_in_place: bool,
    manual_reason: String,
    asset_name: String,
    asset_size: u64,
    asset_url: String,
    asset_digest: String,
    sums_url: String,
    percent: u64,
    transferred_bytes: u64,
    total_bytes: u64,
    error: String,
    target_kind: String,
    target_path: PathBuf,
    install_dir: PathBuf,
    ready: Option<ReadyPayload>,
}

impl Default for UpdaterData {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            latest_version: None,
            available: false,
            comparison: 0,
            can_install_in_place: false,
            manual_reason: String::new(),
            asset_name: String::new(),
            asset_size: 0,
            asset_url: String::new(),
            asset_digest: String::new(),
            sums_url: String::new(),
            percent: 0,
            transferred_bytes: 0,
            total_bytes: 0,
            error: String::new(),
            target_kind: String::new(),
            target_path: PathBuf::new(),
            install_dir: PathBuf::new(),
            ready: None,
        }
    }
}

pub struct AppUpdater {
    inner: Mutex<UpdaterData>,
    downloading: tokio::sync::Mutex<()>,
}

impl Default for AppUpdater {
    fn default() -> Self {
        Self {
            inner: Mutex::new(UpdaterData::default()),
            downloading: tokio::sync::Mutex::new(()),
        }
    }
}

fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn snapshot_json(d: &UpdaterData) -> Value {
    json!({
        "status": d.status,
        "currentVersion": current_version(),
        "latestVersion": d.latest_version,
        "available": d.available,
        "comparison": d.comparison,
        "canInstallInPlace": d.can_install_in_place,
        "manualReason": d.manual_reason,
        "assetName": d.asset_name,
        "assetSize": d.asset_size,
        "percent": d.percent,
        "transferredBytes": d.transferred_bytes,
        "totalBytes": d.total_bytes,
        "error": d.error,
    })
}

fn emit_state(window: &WebviewWindow, state: &AppUpdater) -> Value {
    let val = {
        let guard = state.inner.lock().unwrap();
        snapshot_json(&guard)
    };
    let _ = window.emit("app:update_state", &val);
    val
}

fn parse_semver(raw: &str) -> Result<([u64; 3], Vec<String>), String> {
    let trimmed = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    let without_build = trimmed.split('+').next().unwrap_or(trimmed);
    let (core, pre) = match without_build.split_once('-') {
        Some((c, p)) => (c, p.split('.').map(String::from).collect()),
        None => (without_build, Vec::new()),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3 {
        return Err("无法识别版本号".into());
    }
    let nums = [
        parts[0].parse::<u64>().map_err(|_| "无法识别版本号")?,
        parts[1].parse::<u64>().map_err(|_| "无法识别版本号")?,
        parts[2].parse::<u64>().map_err(|_| "无法识别版本号")?,
    ];
    Ok((nums, pre))
}

fn compare_versions(left: &str, right: &str) -> Result<i32, String> {
    let (ln, lp) = parse_semver(left)?;
    let (rn, rp) = parse_semver(right)?;
    for i in 0..3 {
        match ln[i].cmp(&rn[i]) {
            Ordering::Greater => return Ok(1),
            Ordering::Less => return Ok(-1),
            Ordering::Equal => {}
        }
    }
    if lp.is_empty() || rp.is_empty() {
        return Ok((lp.is_empty() as i32) - (rp.is_empty() as i32));
    }
    for i in 0..lp.len().max(rp.len()) {
        match (lp.get(i), rp.get(i)) {
            (None, Some(_)) => return Ok(-1),
            (Some(_), None) => return Ok(1),
            (Some(a), Some(b)) if a != b => {
                let an = a.parse::<u64>().ok();
                let bn = b.parse::<u64>().ok();
                let ord = match (an, bn) {
                    (Some(x), Some(y)) => x.cmp(&y),
                    (Some(_), None) => Ordering::Less,
                    (None, Some(_)) => Ordering::Greater,
                    (None, None) => a.cmp(b),
                };
                return Ok(if ord == Ordering::Greater { 1 } else { -1 });
            }
            _ => {}
        }
    }
    Ok(0)
}

fn inspect_install_target() -> (bool, String, String, PathBuf, PathBuf) {
    let Ok(exe) = std::env::current_exe() else {
        return (false, "无法定位当前运行程序路径，请前往发布页下载".into(), String::new(), PathBuf::new(), PathBuf::new());
    };

    #[cfg(target_os = "macos")]
    {
        let exe_str = exe.to_string_lossy();
        if let Some((app_prefix, _)) = exe_str.split_once(".app/Contents/MacOS/") {
            let app_bundle = PathBuf::from(format!("{app_prefix}.app"));
            if app_bundle.starts_with("/Volumes/") {
                return (
                    false,
                    "当前在只读磁盘映像中运行，请先拖入「应用程序」文件夹后再在线更新".into(),
                    String::new(),
                    PathBuf::new(),
                    PathBuf::new(),
                );
            }
            return (true, String::new(), "mac-app".into(), app_bundle, PathBuf::new());
        }
        return (
            false,
            "当前为开发运行模式，正式安装包支持应用内直接下载并重启更新".into(),
            String::new(),
            PathBuf::new(),
            PathBuf::new(),
        );
    }

    #[cfg(target_os = "windows")]
    {
        if cfg!(debug_assertions) {
            return (
                false,
                "当前为开发运行模式，正式安装包支持应用内直接下载并重启更新".into(),
                String::new(),
                PathBuf::new(),
                PathBuf::new(),
            );
        }
        let install_dir = exe.parent().unwrap_or_else(|| Path::new(".")).to_path_buf();
        return (true, String::new(), "win-nsis".into(), exe, install_dir);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = exe;
        (false, "当前系统请前往发布页手动下载安装包".into(), String::new(), PathBuf::new(), PathBuf::new())
    }
}

fn select_release_asset(assets: &[Value]) -> Option<&Value> {
    #[cfg(target_os = "macos")]
    {
        let arch_tags: &[&str] = if cfg!(target_arch = "aarch64") {
            &["-mac-arm64.dmg", "_aarch64.dmg", "arm64.dmg"]
        } else {
            &["-mac-x64.dmg", "_x64.dmg", "x64.dmg"]
        };
        for suffix in arch_tags {
            if let Some(found) = assets.iter().find(|a| {
                a["name"].as_str().map(|n| n.ends_with(suffix)).unwrap_or(false)
                    && a["browser_download_url"].as_str().is_some()
            }) {
                return Some(found);
            }
        }
        None
    }

    #[cfg(target_os = "windows")]
    {
        let arch_tags: &[&str] = if cfg!(target_arch = "aarch64") {
            &["-win-arm64-setup.exe", "_arm64-setup.exe", "-setup.exe"]
        } else {
            &["-win-x64-setup.exe", "_x64-setup.exe", "-setup.exe"]
        };
        for suffix in arch_tags {
            if let Some(found) = assets.iter().find(|a| {
                a["name"].as_str().map(|n| n.ends_with(suffix)).unwrap_or(false)
                    && a["browser_download_url"].as_str().is_some()
            }) {
                return Some(found);
            }
        }
        None
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = assets;
        None
    }
}

// Pure-Rust FIPS 180-4 SHA-256 implementation (zero extra crate bloat)
struct Sha256 {
    state: [u32; 8],
    buf: [u8; 64],
    buf_len: usize,
    total_len: u64,
}

impl Sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];

    fn new() -> Self {
        Self {
            state: [
                0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
            ],
            buf: [0u8; 64],
            buf_len: 0,
            total_len: 0,
        }
    }

    fn compress(state: &mut [u32; 8], block: &[u8; 64]) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = *state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h.wrapping_add(s1).wrapping_add(ch).wrapping_add(Self::K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    fn update(&mut self, mut data: &[u8]) {
        self.total_len = self.total_len.wrapping_add(data.len() as u64);
        if self.buf_len > 0 && self.buf_len + data.len() >= 64 {
            let take = 64 - self.buf_len;
            self.buf[self.buf_len..64].copy_from_slice(&data[..take]);
            let block = self.buf;
            Self::compress(&mut self.state, &block);
            self.buf_len = 0;
            data = &data[take..];
        }
        while data.len() >= 64 {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[..64]);
            Self::compress(&mut self.state, &block);
            data = &data[64..];
        }
        if !data.is_empty() {
            self.buf[self.buf_len..self.buf_len + data.len()].copy_from_slice(data);
            self.buf_len += data.len();
        }
    }

    fn finalize_hex(mut self) -> String {
        let bit_len = self.total_len.wrapping_mul(8);
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;
        if self.buf_len > 56 {
            for b in &mut self.buf[self.buf_len..64] {
                *b = 0;
            }
            let block = self.buf;
            Self::compress(&mut self.state, &block);
            self.buf_len = 0;
        }
        for b in &mut self.buf[self.buf_len..56] {
            *b = 0;
        }
        self.buf[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buf;
        Self::compress(&mut self.state, &block);

        let mut out = String::with_capacity(64);
        for word in self.state {
            out.push_str(&format!("{word:08x}"));
        }
        out
    }
}

fn curl_binary() -> &'static str {
    if cfg!(windows) {
        "curl.exe"
    } else {
        "curl"
    }
}

fn curl_get_bytes(url: &str, accept: &str, timeout_secs: u64) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(curl_binary());
    cmd.args([
        "-sS",
        "-f",
        "-L",
        "--max-time",
        &timeout_secs.to_string(),
        "-H",
        &format!("Accept: {accept}"),
        "-H",
        "User-Agent: Figma-Export-Updater",
        url,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().map_err(|e| format!("无法调用网络组件: {e}"))?;
    if !output.status.success() {
        return Err("请求更新服务失败，请检查网络连接".into());
    }
    Ok(output.stdout)
}

fn parse_sha256_sums(text: &str, file_name: &str) -> Option<String> {
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.len() < 66 {
            continue;
        }
        let hex_part = &line[..64];
        if !hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let rest = line[64..].trim().trim_start_matches('*').trim();
        let base = Path::new(rest).file_name().and_then(|s| s.to_str()).unwrap_or(rest);
        if base == file_name {
            return Some(hex_part.to_ascii_lowercase());
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn stage_mac_dmg(dmg_path: &Path, version_dir: &Path, target_app_path: &Path) -> Result<PathBuf, String> {
    let mount_point = version_dir.join(format!("mnt-{}", std::process::id()));
    let app_base_name = target_app_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Figma Export.app");
    let staged_dir = version_dir.join("staged");
    let staged_app = staged_dir.join(app_base_name);

    let _ = fs::remove_dir_all(&staged_dir);
    fs::create_dir_all(&mount_point).map_err(|e| e.to_string())?;
    fs::create_dir_all(&staged_dir).map_err(|e| e.to_string())?;

    let attach = Command::new("/usr/bin/hdiutil")
        .args([
            "attach",
            "-nobrowse",
            "-readonly",
            "-noverify",
            "-noautoopen",
            "-mountpoint",
        ])
        .arg(&mount_point)
        .arg(dmg_path)
        .output()
        .map_err(|e| format!("挂载更新映像失败: {e}"))?;

    if !attach.status.success() {
        let _ = fs::remove_dir_all(&mount_point);
        return Err("挂载更新映像失败，请重新下载".into());
    }

    let result = (|| -> Result<(), String> {
        let entries = fs::read_dir(&mount_point).map_err(|e| e.to_string())?;
        let found_app = entries
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().and_then(|s| s.to_str()) == Some("app"))
            .ok_or_else(|| "更新映像中未找到应用包".to_string())?;

        let ditto = Command::new("/usr/bin/ditto")
            .arg(&found_app)
            .arg(&staged_app)
            .output()
            .map_err(|e| format!("复制更新文件失败: {e}"))?;
        if !ditto.status.success() {
            return Err("解压复制新版应用失败".into());
        }

        let _ = Command::new("/usr/bin/xattr")
            .args(["-cr"])
            .arg(&staged_app)
            .output();

        if !staged_app.join("Contents").join("MacOS").is_dir() {
            return Err("解压后的应用结构不完整".into());
        }
        Ok(())
    })();

    let _ = Command::new("/usr/bin/hdiutil")
        .args(["detach"])
        .arg(&mount_point)
        .arg("-force")
        .output();
    let _ = fs::remove_dir_all(&mount_point);

    result?;
    let _ = fs::remove_file(dmg_path);
    Ok(staged_app)
}

#[cfg(target_os = "macos")]
fn spawn_mac_updater(payload: &ReadyPayload) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let script_path = payload.version_dir.join("apply-update.sh");
    let script = r#"#!/bin/sh
PID="$1"
TARGET_APP="$2"
STAGED_APP="$3"
VERSION_DIR="$4"
BACKUP_APP="${TARGET_APP}.updating-backup"
PARENT_DIR="$(dirname "$TARGET_APP")"

i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 150 ]; do
  sleep 0.2
  i=$((i + 1))
done

swap_direct() {
  rm -rf "$BACKUP_APP"
  if mv "$TARGET_APP" "$BACKUP_APP" && mv "$STAGED_APP" "$TARGET_APP"; then
    rm -rf "$BACKUP_APP"
    xattr -cr "$TARGET_APP" 2>/dev/null || true
    return 0
  fi
  if [ ! -e "$TARGET_APP" ] && [ -e "$BACKUP_APP" ]; then
    mv "$BACKUP_APP" "$TARGET_APP" 2>/dev/null || true
  fi
  return 1
}

if [ -w "$PARENT_DIR" ] && [ -w "$TARGET_APP" ]; then
  swap_direct
else
  osascript - "$TARGET_APP" "$STAGED_APP" "$BACKUP_APP" <<'APPLESCRIPT'
on run argv
  set targetApp to item 1 of argv
  set stagedApp to item 2 of argv
  set backupApp to item 3 of argv
  set cmd to "rm -rf " & quoted form of backupApp & " && mv " & quoted form of targetApp & " " & quoted form of backupApp & " && mv " & quoted form of stagedApp & " " & quoted form of targetApp & " && rm -rf " & quoted form of backupApp & " && xattr -cr " & quoted form of targetApp
  do shell script cmd with administrator privileges
end run
APPLESCRIPT
fi

open -n "$TARGET_APP" >/dev/null 2>&1 &
rm -rf "$VERSION_DIR" >/dev/null 2>&1 &
"#;
    fs::write(&script_path, script).map_err(|e| e.to_string())?;
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;

    Command::new("/bin/sh")
        .arg(&script_path)
        .arg(std::process::id().to_string())
        .arg(&payload.target_path)
        .arg(&payload.staged_path)
        .arg(&payload.version_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动更新助手失败: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_win_updater(payload: &ReadyPayload) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let script_path = payload.version_dir.join("apply-update.ps1");
    let script = r#"param(
  [int]$TargetPid,
  [string]$InstallerPath,
  [string]$InstallDir,
  [string]$TargetExe,
  [string]$VersionDir
)
try { Wait-Process -Id $TargetPid -Timeout 30 -ErrorAction SilentlyContinue } catch {}
Start-Sleep -Milliseconds 500
Start-Process -FilePath $InstallerPath -ArgumentList "/S /D=$InstallDir" -Wait -WindowStyle Hidden
$exe = $TargetExe
if (!(Test-Path -LiteralPath $exe)) {
  $candidate = Join-Path $InstallDir 'Figma Export.exe'
  if (Test-Path -LiteralPath $candidate) {
    $exe = $candidate
  } else {
    $found = Get-ChildItem -LiteralPath $InstallDir -Filter '*.exe' -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike 'Uninstall*' } | Select-Object -First 1
    if ($found) { $exe = $found.FullName }
  }
}
if (Test-Path -LiteralPath $exe) {
  Start-Process -FilePath $exe
}
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $VersionDir -Recurse -Force -ErrorAction SilentlyContinue
"#;
    fs::write(&script_path, script).map_err(|e| e.to_string())?;

    Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&script_path)
        .arg(std::process::id().to_string())
        .arg(&payload.staged_path)
        .arg(&payload.install_dir)
        .arg(&payload.target_path)
        .arg(&payload.version_dir)
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动更新助手失败: {e}"))?;
    Ok(())
}

fn open_safe_external(kind: &str) -> Result<(), String> {
    let url = match kind {
        "releases" => RELEASES_PAGE,
        "github" => GITHUB_REPO_PAGE,
        "website" => WEBSITE_PAGE,
        _ => return Err("未知的外部链接类型".into()),
    };

    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x08000000)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Command::new("xdg-open").arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn run_check(window: &WebviewWindow, state: &AppUpdater) -> Result<Value, String> {
    {
        let mut g = state.inner.lock().unwrap();
        if matches!(g.status.as_str(), "downloading" | "verifying" | "staging") {
            return Ok(snapshot_json(&g));
        }
        g.status = "checking".into();
        g.error.clear();
    }
    emit_state(window, state);

    let fetch_res = tauri::async_runtime::spawn_blocking(|| {
        let bytes = curl_get_bytes(RELEASES_API, "application/vnd.github+json", 15)?;
        serde_json::from_slice::<Value>(&bytes).map_err(|_| "解析版本信息失败".to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    let release = match fetch_res {
        Ok(val) => val,
        Err(err) => {
            let mut g = state.inner.lock().unwrap();
            g.status = "error".into();
            g.error = err.clone();
            drop(g);
            emit_state(window, state);
            return Err(err);
        }
    };

    let tag = release["tag_name"].as_str().unwrap_or_default();
    let latest_version = tag.strip_prefix('v').unwrap_or(tag).to_string();
    let comparison = match compare_versions(&latest_version, current_version()) {
        Ok(c) => c,
        Err(err) => {
            let mut g = state.inner.lock().unwrap();
            g.status = "error".into();
            g.error = err.clone();
            drop(g);
            emit_state(window, state);
            return Err(err);
        }
    };
    let available = comparison > 0;

    let assets = release["assets"].as_array().cloned().unwrap_or_default();
    let matched_asset = select_release_asset(&assets).cloned();
    let sums_url = assets
        .iter()
        .find(|a| a["name"].as_str() == Some("SHA256SUMS.txt"))
        .and_then(|a| a["browser_download_url"].as_str())
        .unwrap_or_default()
        .to_string();

    let (mut can_install, mut manual_reason, target_kind, target_path, install_dir) = inspect_install_target();
    if can_install && matched_asset.is_none() {
        can_install = false;
        manual_reason = "未找到匹配当前系统架构的安装包，请前往发布页下载".into();
    }

    {
        let mut g = state.inner.lock().unwrap();
        if let Some(ready) = &g.ready {
            if available && ready.latest_version == latest_version && ready.staged_path.exists() {
                g.status = "downloaded".into();
                g.latest_version = Some(latest_version);
                g.available = true;
                g.comparison = comparison;
                g.percent = 100;
                g.error.clear();
                drop(g);
                return Ok(emit_state(window, state));
            }
        }

        g.latest_version = Some(latest_version);
        g.available = available;
        g.comparison = comparison;
        g.can_install_in_place = can_install;
        g.manual_reason = manual_reason;
        g.target_kind = target_kind;
        g.target_path = target_path;
        g.install_dir = install_dir;
        g.sums_url = sums_url;
        if let Some(asset) = matched_asset {
            g.asset_name = asset["name"].as_str().unwrap_or_default().to_string();
            g.asset_size = asset["size"].as_u64().unwrap_or(0);
            g.asset_url = asset["browser_download_url"].as_str().unwrap_or_default().to_string();
            g.asset_digest = asset["digest"].as_str().unwrap_or_default().to_string();
            g.total_bytes = g.asset_size;
        } else {
            g.asset_name.clear();
            g.asset_size = 0;
            g.asset_url.clear();
            g.asset_digest.clear();
            g.total_bytes = 0;
        }
        g.transferred_bytes = 0;
        g.percent = 0;
        g.error.clear();
        g.status = if available { "available".into() } else { "up-to-date".into() };
    }

    Ok(emit_state(window, state))
}

#[tauri::command]
pub async fn app_updater(
    window: WebviewWindow,
    state: State<'_, AppUpdater>,
    action: String,
    args: Option<Value>,
) -> Result<Value, String> {
    super::local_window(&window)?;
    let args = args.unwrap_or(Value::Null);

    match action.as_str() {
        "version" => Ok(json!(current_version())),
        "state" => {
            let g = state.inner.lock().unwrap();
            Ok(snapshot_json(&g))
        }
        "open_url" => {
            let kind = args["kind"].as_str().unwrap_or_default();
            open_safe_external(kind)?;
            Ok(json!({ "ok": true }))
        }
        "check" => run_check(&window, &state).await,
        "download" => {
            let _dl_lock = state.downloading.lock().await;
            {
                let needs_check = {
                    let g = state.inner.lock().unwrap();
                    !g.available && g.latest_version.is_none()
                };
                if needs_check {
                    run_check(&window, &state).await?;
                }
            }

            let (latest_version, asset_name, asset_url, asset_size, asset_digest, sums_url, target_kind, target_path, install_dir) = {
                let g = state.inner.lock().unwrap();
                if !g.available {
                    return Err("当前已是最新版本".into());
                }
                if g.status == "downloaded" {
                    if let Some(ready) = &g.ready {
                        if ready.staged_path.exists() {
                            return Ok(snapshot_json(&g));
                        }
                    }
                }
                if !g.can_install_in_place || g.asset_url.is_empty() {
                    return Err(if g.manual_reason.is_empty() {
                        "当前环境不支持自动覆盖安装，请前往发布页下载".into()
                    } else {
                        g.manual_reason.clone()
                    });
                }
                (
                    g.latest_version.clone().unwrap_or_default(),
                    g.asset_name.clone(),
                    g.asset_url.clone(),
                    g.asset_size,
                    g.asset_digest.clone(),
                    g.sums_url.clone(),
                    g.target_kind.clone(),
                    g.target_path.clone(),
                    g.install_dir.clone(),
                )
            };

            let updater_root = window
                .app_handle()
                .path()
                .temp_dir()
                .map_err(|e| e.to_string())?
                .join("figma-export-updater");

            if let Ok(entries) = fs::read_dir(&updater_root) {
                for entry in entries.filter_map(Result::ok) {
                    if entry.file_name().to_string_lossy() != latest_version {
                        let _ = fs::remove_dir_all(entry.path());
                    }
                }
            }

            let version_dir = updater_root.join(&latest_version);
            fs::create_dir_all(&version_dir).map_err(|e| e.to_string())?;
            let dest_path = version_dir.join(&asset_name);
            let part_path = version_dir.join(format!("{asset_name}.part"));
            let _ = fs::remove_file(&part_path);

            {
                let mut g = state.inner.lock().unwrap();
                g.status = "downloading".into();
                g.percent = 0;
                g.transferred_bytes = 0;
                g.total_bytes = asset_size;
                g.error.clear();
            }
            emit_state(&window, &state);

            let win_clone = window.clone();
            let app_handle = window.app_handle().clone();
            let target_kind_bg = target_kind.clone();
            let target_path_bg = target_path.clone();
            let version_dir_bg = version_dir.clone();

            let download_result = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf, String> {
                let mut cmd = Command::new(curl_binary());
                cmd.args([
                    "-sS",
                    "-f",
                    "-L",
                    "-H",
                    "Accept: application/octet-stream,*/*",
                    "-H",
                    "User-Agent: Figma-Export-Updater",
                    &asset_url,
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x08000000);
                }

                let mut child = cmd.spawn().map_err(|e| format!("启动下载进程失败: {e}"))?;
                let mut stdout = child.stdout.take().ok_or("无法读取下载数据流")?;
                let mut out_file = File::create(&part_path).map_err(|e| format!("创建临时文件失败: {e}"))?;

                let mut hasher = Sha256::new();
                let mut buf = [0u8; 32 * 1024];
                let mut transferred = 0u64;
                let mut last_emit = Instant::now();

                loop {
                    let n = stdout.read(&mut buf).map_err(|e| format!("读取下载数据失败: {e}"))?;
                    if n == 0 {
                        break;
                    }
                    out_file.write_all(&buf[..n]).map_err(|e| format!("写入更新包失败: {e}"))?;
                    hasher.update(&buf[..n]);
                    transferred += n as u64;

                    if last_emit.elapsed() >= Duration::from_millis(100) {
                        last_emit = Instant::now();
                        let st = app_handle.state::<AppUpdater>();
                        {
                            let mut g = st.inner.lock().unwrap();
                            g.transferred_bytes = transferred;
                            if asset_size > 0 {
                                g.percent = ((transferred * 100) / asset_size).min(99);
                            }
                        }
                        emit_state(&win_clone, &st);
                    }
                }

                out_file.flush().map_err(|e| e.to_string())?;
                drop(out_file);

                let status = child.wait().map_err(|e| e.to_string())?;
                if !status.success() || transferred == 0 {
                    let _ = fs::remove_file(&part_path);
                    return Err("下载更新包中断，请检查网络后重试".into());
                }

                let st = app_handle.state::<AppUpdater>();
                {
                    let mut g = st.inner.lock().unwrap();
                    g.status = "verifying".into();
                    g.percent = 100;
                    g.transferred_bytes = transferred;
                    if g.total_bytes == 0 {
                        g.total_bytes = transferred;
                    }
                }
                emit_state(&win_clone, &st);

                let actual_sha = hasher.finalize_hex();
                let expected_sha = if let Some(hex) = asset_digest.strip_prefix("sha256:") {
                    let clean = hex.trim().to_ascii_lowercase();
                    if clean.len() == 64 { Some(clean) } else { None }
                } else if !sums_url.is_empty() {
                    curl_get_bytes(&sums_url, "text/plain,*/*", 15)
                        .ok()
                        .and_then(|b| String::from_utf8(b).ok())
                        .and_then(|txt| parse_sha256_sums(&txt, &asset_name))
                } else {
                    None
                };

                if let Some(expected) = expected_sha {
                    if actual_sha != expected {
                        let _ = fs::remove_file(&part_path);
                        return Err("更新包完整性校验未通过（SHA-256 不匹配），请重试".into());
                    }
                }

                let _ = fs::remove_file(&dest_path);
                fs::rename(&part_path, &dest_path).map_err(|e| e.to_string())?;

                #[cfg(target_os = "macos")]
                if target_kind_bg == "mac-app" {
                    {
                        let mut g = st.inner.lock().unwrap();
                        g.status = "staging".into();
                        g.percent = 100;
                    }
                    emit_state(&win_clone, &st);
                    return stage_mac_dmg(&dest_path, &version_dir_bg, &target_path_bg);
                }

                let _ = (&target_kind_bg, &target_path_bg);
                Ok(dest_path)
            })
            .await
            .map_err(|e| e.to_string())?;

            match download_result {
                Ok(staged_path) => {
                    let mut g = state.inner.lock().unwrap();
                    g.ready = Some(ReadyPayload {
                        latest_version,
                        kind: target_kind,
                        target_path,
                        install_dir,
                        staged_path,
                        version_dir: updater_root.join(g.latest_version.as_deref().unwrap_or_default()),
                    });
                    g.status = "downloaded".into();
                    g.percent = 100;
                    g.error.clear();
                    drop(g);
                    Ok(emit_state(&window, &state))
                }
                Err(err) => {
                    let mut g = state.inner.lock().unwrap();
                    g.ready = None;
                    g.status = "error".into();
                    g.error = err.clone();
                    drop(g);
                    emit_state(&window, &state);
                    Err(err)
                }
            }
        }
        "install" => {
            let payload = {
                let g = state.inner.lock().unwrap();
                match &g.ready {
                    Some(r) if r.staged_path.exists() => r.clone(),
                    _ => return Err("更新包尚未准备就绪，请重新下载更新".into()),
                }
            };

            #[cfg(target_os = "macos")]
            if payload.kind == "mac-app" {
                spawn_mac_updater(&payload)?;
            }

            #[cfg(target_os = "windows")]
            if payload.kind == "win-nsis" {
                spawn_win_updater(&payload)?;
            }

            let app_handle = window.app_handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(150)).await;
                app_handle.exit(0);
            });

            Ok(json!({ "ok": true }))
        }
        _ => Err("未知的更新操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_nist_vectors() {
        let mut h = Sha256::new();
        h.update(b"abc");
        assert_eq!(
            h.finalize_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn version_comparison_works() {
        assert_eq!(compare_versions("1.0.1", "1.0.0").unwrap(), 1);
        assert_eq!(compare_versions("1.0.0", "1.0.0").unwrap(), 0);
        assert_eq!(compare_versions("1.0.0-beta.1", "1.0.0").unwrap(), -1);
    }
}
