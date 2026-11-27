// Loaded before the shared renderer. Connects UI actions directly to Tauri 2 native commands.
const tauri = window.__TAURI__;
async function invokeTauri(cmd, payload) {
  try {
    return await tauri.core.invoke(cmd, payload);
  } catch (err) {
    throw err instanceof Error
      ? err
      : new Error(typeof err === 'string' ? err : err?.message || JSON.stringify(err));
  }
}
const disk = (action, args = {}) => invokeTauri('local_files', { action, args });
const nativeBrowser = (action, args = {}) => invokeTauri('figma_browser', { action, args });
const nativeUpdater = (action, args = {}) => invokeTauri('app_updater', { action, args });
const handlers = new Map();
const listeners = new Map();
const modules = new Map();
let paths;

function define(name, factory) {
  modules.set(name, { factory });
}

const localPath = {
  get sep() {
    return paths?.platform === 'win32' ? '\\' : '/';
  },
  join: (...parts) => localPath.resolve(parts.filter(Boolean).join('/')),
  resolve(value) {
    const separator = paths?.platform === 'win32' ? '\\' : '/';
    const normalized = String(value).replace(/\\/g, '/');
    const input = /^(?:[a-z]:\/|\/)/i.test(normalized) ? normalized : `${paths.home}/${normalized}`;
    const prefix = input.startsWith('//') ? '//' : input.match(/^[a-z]:\//i)?.[0] || '/';
    const segments = [];
    for (const part of input.replace(/\\/g, '/').slice(prefix.length).split('/')) {
      if (part === '..') segments.pop();
      else if (part && part !== '.') segments.push(part);
    }
    return (prefix + segments.join('/')).replaceAll('/', separator);
  },
  dirname(value) {
    const resolved = localPath.resolve(value);
    const separator = localPath.sep;
    const idx = resolved.lastIndexOf(separator);
    if (idx <= 0) return separator;
    return resolved.slice(0, idx);
  },
  basename(value, ext = '') {
    const base = String(value).split(/[\\/]/).pop() || '';
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
  },
  extname(value) {
    return /(?<!^)\.[^.]+$/.exec(localPath.basename(value))?.[0] || '';
  },
};

const storage = {
  loadConfig: () => disk('load_config'),
  saveConfig: (config) => disk('save_config', { config }),
  ensureDir: (p) => disk('ensure_dir', { path: p }),
  exists: (p) => disk('exists', { path: p }),
  loadManifest: (p) => disk('load_manifest', { path: p }),
  saveManifest: (p, manifest) => {
    manifest.updatedAt = new Date().toISOString();
    return disk('save_manifest', { path: p, manifest });
  },
  collectLocalImportFiles: (p) => disk('collect_files', { paths: p }),
};

async function invokeChannel(name, ...args) {
  await controllerReady;
  const handler = handlers.get(name);
  if (!handler) throw new Error(`未注册的应用操作 ${name}`);
  try {
    return await handler(...args);
  } catch (error) {
    throw new Error(error?.message || String(error));
  }
}

function subscribeChannel(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
}

function require(name) {
  if (name === 'path') return localPath;
  const item = modules.get(name);
  if (!item) throw new Error(`Missing shared module ${name}`);
  if (!item.module) {
    item.module = { exports: {} };
    item.factory(require, item.module);
  }
  return item.module.exports;
}

class SystemFigmaBrowser {
  constructor(onLog, onAuthUpdate) {
    this.onLog = onLog;
    this.onAuthUpdate = onAuthUpdate;
    this.user = null;
    this.loginCheck = null;
    this.loginPending = false;
  }

  async checkAuthStatus() {
    const result = await nativeBrowser('auth');
    this.user = result.user || null;
    return result;
  }

  fetchFigmaJson(p) {
    return nativeBrowser('request', { path: p, userId: this.user?.id });
  }

  mutateFigmaJson(p, method, payload) {
    return nativeBrowser('request', { path: p, method, payload, userId: this.user?.id });
  }

  discoverTeamsFromSidebarDom() {
    return nativeBrowser('discover_teams');
  }

  async openLoginWindow() {
    const current = await this.checkAuthStatus();
    if (current.authenticated) {
      await nativeBrowser('login', { alreadyAuthenticated: true });
      this.onAuthUpdate(current);
      this.onLog(
        'success',
        `已登录账号: ${current.user.name}${current.user.email ? ' (' + current.user.email + ')' : ''}`
      );
      return current;
    }

    await nativeBrowser('login', { alreadyAuthenticated: false });
    this.onLog('info', '请在弹出的 Figma 登录窗口中完成登录，登录成功后窗口将自动收起...');

    if (this.loginCheck) clearInterval(this.loginCheck);
    this.loginCheck = setInterval(async () => {
      if (this.loginPending) return;
      this.loginPending = true;
      try {
        const auth = await this.checkAuthStatus();
        if (auth.authenticated) {
          clearInterval(this.loginCheck);
          this.loginCheck = null;
          await nativeBrowser('hide_login');
          this.onAuthUpdate(auth);
          this.onLog(
            'success',
            `登录成功！当前账号: ${auth.user.name}${auth.user.email ? ' (' + auth.user.email + ')' : ''}`
          );
        } else if (auth.windowVisible === false) {
          clearInterval(this.loginCheck);
          this.loginCheck = null;
        }
      } catch (error) {
        this.onLog('warn', `检测登录状态失败：${error.message || error}`);
      } finally {
        this.loginPending = false;
      }
    }, 1500);

    return current;
  }

  async logoutAndResetProfile() {
    this.closeWindows();
    await nativeBrowser('logout');
    this.user = null;
    this.onLog('info', '已退出当前 Figma 账号并清除本地登录缓存');
    this.onAuthUpdate({ authenticated: false, user: null });
  }

  closeWindows() {
    if (this.loginCheck) {
      clearInterval(this.loginCheck);
      this.loginCheck = null;
    }
  }
}

const controllerReady = Promise.resolve().then(async () => {
  paths = await disk('paths');
  const { createAppController } = require('./appController');
  const { FigmaExporter } = require('./exporter');
  const { FigmaImporter } = require('./importer');
  const { inferFigmaTitleFromPath } = require('./utils');

  class Exporter extends FigmaExporter {
    exportSingleFile(file, targetPath, { timeoutSec, silentExport }) {
      return nativeBrowser('download', {
        editorUrl: this.buildFileUrl(file),
        targetPath,
        timeoutSec,
        silent: silentExport,
      });
    }
  }

  class Importer extends FigmaImporter {
    async importSingleFile(file, destination, existingKeys, { timeoutSec, silentImport }) {
      const title = (file.title || inferFigmaTitleFromPath(file.localPath)).trim();
      return nativeBrowser('upload', {
        localPath: file.localPath,
        fileName: file.fileName,
        destination,
        existingKeys: Array.from(existingKeys || []),
        title,
        timeoutSec,
        silent: silentImport,
      });
    }
  }

  const controller = createAppController({
    paths,
    path: localPath,
    platform: paths.platform,
    storage,
    registerHandler: (name, handler) => handlers.set(name, handler),
    chooseOpenDialog: (options) => disk('choose', { options }),
    openFolder: (p) => disk('open_folder', { path: p }),
    Browser: SystemFigmaBrowser,
    Exporter,
    Importer,
    emitEvent: (name, value) => {
      const snapshot = JSON.parse(JSON.stringify(value));
      for (const fn of listeners.get(name) || []) fn(snapshot);
    },
  });
  await controller.start();

  handlers.set('app:version', () => nativeUpdater('version'));
  handlers.set('app:check-update', () => nativeUpdater('check'));
  handlers.set('app:get-update-state', () => nativeUpdater('state'));
  handlers.set('app:download-update', () => nativeUpdater('download'));
  handlers.set('app:install-update', async () => {
    if (controller.isBusy()) {
      throw new Error('当前有扫描、导入或导出任务正在运行，请等待完成或停止任务后再重启更新');
    }
    controller.close();
    return nativeUpdater('install');
  });
  handlers.set('app:open-releases', () => nativeUpdater('open_url', { kind: 'releases' }));
  handlers.set('app:open-github', () => nativeUpdater('open_url', { kind: 'github' }));
  handlers.set('app:open-website', () => nativeUpdater('open_url', { kind: 'website' }));

  void tauri.event.listen('app:update_state', ({ payload }) => {
    for (const fn of listeners.get('event:update_state') || []) {
      fn(payload);
    }
  });
});

window.figmaExporter = {
  getState: () => invokeChannel('state:get'),
  getVersion: () => invokeChannel('app:version'),
  checkForUpdates: () => invokeChannel('app:check-update'),
  getUpdateState: () => invokeChannel('app:get-update-state'),
  downloadUpdate: () => invokeChannel('app:download-update'),
  installUpdate: () => invokeChannel('app:install-update'),
  openReleases: () => invokeChannel('app:open-releases'),
  openGithub: () => invokeChannel('app:open-github'),
  openWebsite: () => invokeChannel('app:open-website'),
  login: () => invokeChannel('auth:login'),
  logout: () => invokeChannel('auth:logout'),
  scan: (opts) => invokeChannel('scan:start', opts),
  addTeam: (input) => invokeChannel('teams:add', input),
  removeTeam: (teamId) => invokeChannel('teams:remove', teamId),
  saveSettings: (settings) => invokeChannel('settings:save', settings),
  chooseDir: () => invokeChannel('dialog:choose-dir'),
  openFolder: (dir) => invokeChannel('shell:open-folder', dir),

  // 批量导出
  startExport: (opts) => invokeChannel('export:start', opts),
  stopExport: () => invokeChannel('export:stop'),

  // 批量导入
  pickImportFiles: () => invokeChannel('import:pick-files'),
  pickImportFolder: () => invokeChannel('import:pick-folder'),
  addImportPaths: (p) => invokeChannel('import:add-paths', p),
  removeImportItems: (ids) => invokeChannel('import:remove-items', ids),
  clearImportQueue: () => invokeChannel('import:clear'),
  loadImportTargets: () => invokeChannel('import:targets'),
  createFigmaFolder: (opts) => invokeChannel('import:create-folder', opts),
  startImport: (opts) => invokeChannel('import:start', opts),
  stopImport: () => invokeChannel('import:stop'),

  // 实时事件订阅
  onLog: (cb) => subscribeChannel('event:log', cb),
  onAuthUpdate: (cb) => subscribeChannel('event:auth_update', cb),
  onScanProgress: (cb) => subscribeChannel('event:scan_progress', cb),
  onExportProgress: (cb) => subscribeChannel('event:export_progress', cb),
  onImportProgress: (cb) => subscribeChannel('event:import_progress', cb),
  onUpdateState: (cb) => subscribeChannel('event:update_state', cb),
};

function connectNativeWindow() {
  const dropzone = () => document.getElementById('importDropzone');
  const isImportActive = () => {
    const importCard = document.getElementById('importCenterCard');
    return Boolean(importCard && !importCard.classList.contains('hidden'));
  };

  void tauri.event.listen('tauri://drag-enter', () => {
    if (isImportActive()) dropzone()?.classList.add('drag-over');
  });
  void tauri.event.listen('tauri://drag-over', () => {
    if (isImportActive()) dropzone()?.classList.add('drag-over');
  });
  void tauri.event.listen('tauri://drag-leave', () => {
    dropzone()?.classList.remove('drag-over');
  });

  window.figmaExporter.onDroppedPaths = (callback) => {
    void tauri.event.listen('tauri://drag-drop', ({ payload }) => {
      dropzone()?.classList.remove('drag-over');
      callback(payload.paths || []);
    });
  };

  const header = document.querySelector('.window-topbar');
  if (header) {
    header.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('button, input, select, a, [role="menu"], .popover-menu')) return;
      const currentWin = tauri.window.getCurrentWindow();
      if (event.detail === 2) {
        void currentWin.toggleMaximize();
      } else {
        void currentWin.startDragging();
      }
    });
  }
}
