# Figma Export — Tauri 2.0 桌面端

基于 **Tauri 2.0 + 系统原生 WebView（macOS WKWebView / Windows WebView2）** 重构的跨平台桌面应用，与原版 Electron 应用共享**完全一致的 UI 界面、状态机与批量导出/导入交互逻辑**，安装包体积从 ~100 MiB 缩减至 ~2 MiB。

## 架构说明

- **UI 与业务控制层共享**：通过 `stage-ui.cjs` 自动组合根目录的 `public/`（`index.html`、`styles.css`、`app.js`）、`src/`（`appController.js`、`scanner.js`、`electronExporter.js`、`electronImporter.js`、`utils.js`）及 `bridge.js`。
- **Rust 原生后端（`src-tauri/src/`）**：
  - `local.rs`（`local_files` 命令）：负责配置文件读写、`export-manifest.json` 断点续传清单、系统原生文件/文件夹选择框、本地待导入设计文件递归扫描及打开系统目录。
  - `figma.rs` + `figma.js`（`figma_browser` 命令）：管理独立持久化的 Figma 系统 WebView 会话，支持应用内登录（兼容 Google SSO / SAML）、同源 API 请求、全团队与草稿扫描、静默/可视模式 `.fig` / `.jam` / `.deck` 下载拦截，以及无体积上限的分块流式批量导入还原。
  - `main.rs`：窗口生命周期、无标题交通信号灯一体化顶栏与 `--smoke-test` 自检。

## 开发运行

在仓库根目录直接运行：
```bash
npm run tauri:dev
```
或在本目录（`prototype/tauri`）下运行：
```bash
npm run dev
```

## 打包构建（按需执行）

| 平台 | 构建命令 | 产物目录 |
| --- | --- | --- |
| macOS | `npm run build -- --bundles dmg` | `src-tauri/target/release/bundle/dmg/` |
| Windows | `npm run build -- --bundles nsis` | `src-tauri/target/release/bundle/nsis/` |
