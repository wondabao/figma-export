const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { ElectronFigmaBrowser } = require('../src/electronBrowser');
const { FigmaScanner } = require('../src/scanner');
const { ElectronFigmaExporter } = require('../src/electronExporter');
const { ElectronFigmaImporter } = require('../src/electronImporter');
const { parseTeamIdInput, ensureDir, collectLocalImportFiles } = require('../src/utils');

let mainWindow = null;
let browserManager = null;
let scanner = null;
let exporter = null;
let importer = null;

let config = null;
let lastScanResult = null;
let lastImportTargets = null;
let importQueue = [];
let isScanning = false;
const logs = [];

function getConfigPath() {
  return path.join(app.getPath('userData'), 'exporter-config.json');
}

function loadConfig() {
  const defaultOutputDir = path.join(app.getPath('documents'), 'Figma Exports');
  const defaults = {
    outputDir: defaultOutputDir,
    extraTeamIds: [],
    includeDrafts: true,
    skipExported: true,
    silentExport: true,
    timeoutSec: 180,
    importTargetMode: 'drafts',
    importTeamId: '',
    importFolderId: '',
    importSkipExisting: true,
    importSilent: true,
    importTimeoutSec: 240,
  };
  const cfgPath = getConfigPath();
  if (!fs.existsSync(cfgPath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveConfig(cfg) {
  const cfgPath = getConfigPath();
  ensureDir(path.dirname(cfgPath));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function addLog(level, message) {
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level,
    message,
  };
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  console.log(`[${entry.time}] [${level.toUpperCase()}] ${message}`);
  sendToRenderer('event:log', entry);
}

function mergeIntoImportQueue(newItems) {
  const existingMap = new Map(importQueue.map((item) => [item.id, item]));
  let added = 0;
  for (const item of newItems) {
    if (!existingMap.has(item.id)) {
      importQueue.push(item);
      existingMap.set(item.id, item);
      added += 1;
    }
  }
  return added;
}

function initServices() {
  config = loadConfig();

  browserManager = new ElectronFigmaBrowser(addLog, (authState) => {
    sendToRenderer('event:auth_update', authState);
  });

  scanner = new FigmaScanner(browserManager, addLog, (progress) => {
    sendToRenderer('event:scan_progress', progress);
  });

  exporter = new ElectronFigmaExporter(browserManager, addLog, (progress) => {
    if (lastScanResult && progress.fileKey && progress.type === 'file_done') {
      const target = lastScanResult.files.find((f) => f.key === progress.fileKey);
      if (target) {
        if (progress.status === 'exported' || progress.status === 'skipped') {
          target.backupStatus = 'exported';
          if (progress.fileSize) target.fileSize = progress.fileSize;
          target.lastError = null;
        } else if (progress.status === 'failed') {
          target.backupStatus = 'failed';
          target.lastError = progress.error || '导出失败';
        }
      }
    }
    sendToRenderer('event:export_progress', progress);
  });

  importer = new ElectronFigmaImporter(browserManager, scanner, addLog, (progress) => {
    if (progress.fileId && progress.type === 'file_done') {
      const target = importQueue.find((f) => f.id === progress.fileId);
      if (target) {
        target.status = progress.status;
        target.destinationLabel = progress.destinationLabel || target.destinationLabel || null;
        target.error = progress.status === 'failed' ? progress.error || '导入失败' : null;
      }
    }
    sendToRenderer('event:import_progress', progress);
  });
}

function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    title: '',
    backgroundColor: '#f2f2f4',
    autoHideMenuBar: true,
    ...(isMac
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 20, y: 18 },
        }
      : {}),
    ...(isWin
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#f2f2f4',
            symbolColor: '#1c1c1e',
            height: 48,
          },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 阻止 HTML <title> 覆盖窗口标题，确保顶部交通信号灯栏不显示任何标题文字
  mainWindow.on('page-title-updated', (event) => {
    event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'public', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers() {
  ipcMain.handle('state:get', async () => {
    browserManager
      .checkAuthStatus()
      .then((auth) => {
        sendToRenderer('event:auth_update', {
          authenticated: auth.authenticated,
          user: auth.user,
        });
      })
      .catch(() => {});

    return {
      auth: {
        authenticated: Boolean(browserManager.user),
        user: browserManager.user,
      },
      config,
      isScanning,
      scanResult: lastScanResult,
      importTargets: lastImportTargets,
      importQueue,
      exportStatus: exporter.getStatus(),
      importStatus: importer.getStatus(),
      logs: logs.slice(-150),
      platform: process.platform,
      homeDir: app.getPath('home'),
    };
  });

  ipcMain.handle('auth:login', async () => {
    const status = await browserManager.openLoginWindow(mainWindow);
    return { ok: true, auth: { authenticated: status.authenticated, user: status.user } };
  });

  ipcMain.handle('auth:logout', async () => {
    if (exporter.isRunning || importer.isRunning) {
      throw new Error('当前有任务正在运行中，请先停止任务后再切换账号');
    }
    await browserManager.logoutAndResetProfile();
    lastScanResult = null;
    lastImportTargets = null;
    return { ok: true };
  });

  ipcMain.handle('scan:start', async (_event, opts = {}) => {
    if (isScanning) throw new Error('正在扫描中，请稍候...');
    if (exporter.isRunning || importer.isRunning) throw new Error('当前有导入/导出任务运行中，请稍后再试');

    isScanning = true;
    try {
      const includeDrafts =
        typeof opts.includeDrafts === 'boolean' ? opts.includeDrafts : config.includeDrafts;

      const result = await scanner.scanAll({
        outputDir: config.outputDir,
        extraTeamIds: config.extraTeamIds,
        includeDrafts,
      });
      lastScanResult = result;
      // 同步更新导入可用目标列表
      lastImportTargets = {
        user: result.user,
        draftsFolderId: result.user?.draftsFolderId || null,
        teams: result.teams
          .filter((t) => !t.isDrafts)
          .map((t) => ({
            id: t.id,
            name: t.name,
            orgName: t.orgName || null,
            folders: t.folders.map((f) => ({ id: f.id, name: f.name, teamId: t.id })),
          })),
      };
      return { ok: true, data: result, importTargets: lastImportTargets };
    } catch (err) {
      addLog('error', `扫描失败: ${err.message}`);
      throw err;
    } finally {
      isScanning = false;
    }
  });

  ipcMain.handle('teams:add', async (_event, input) => {
    const teamId = parseTeamIdInput(input);
    if (!teamId) {
      throw new Error('无法解析 Team ID，请粘贴包含 /team/数字 的 Figma 团队链接或纯数字 Team ID');
    }
    if (!config.extraTeamIds.includes(teamId)) {
      config.extraTeamIds.push(teamId);
      saveConfig(config);
      addLog('info', `已添加手动团队 ID: ${teamId}，点击扫描或刷新团队即可拉取`);
    }
    return { ok: true, teamId, extraTeamIds: config.extraTeamIds };
  });

  ipcMain.handle('teams:remove', async (_event, teamId) => {
    const idStr = String(teamId || '');
    config.extraTeamIds = config.extraTeamIds.filter((id) => id !== idStr);
    saveConfig(config);
    return { ok: true, extraTeamIds: config.extraTeamIds };
  });

  ipcMain.handle('settings:save', async (_event, body = {}) => {
    if (typeof body.outputDir === 'string' && body.outputDir.trim()) {
      config.outputDir = path.resolve(body.outputDir.trim());
    }
    if (typeof body.includeDrafts === 'boolean') config.includeDrafts = body.includeDrafts;
    if (typeof body.skipExported === 'boolean') config.skipExported = body.skipExported;
    if (typeof body.silentExport === 'boolean') config.silentExport = body.silentExport;
    if (typeof body.timeoutSec === 'number' && body.timeoutSec >= 30 && body.timeoutSec <= 1200) {
      config.timeoutSec = body.timeoutSec;
    }
    if (typeof body.importTargetMode === 'string') config.importTargetMode = body.importTargetMode;
    if (typeof body.importTeamId === 'string') config.importTeamId = body.importTeamId;
    if (typeof body.importFolderId === 'string') config.importFolderId = body.importFolderId;
    if (typeof body.importSkipExisting === 'boolean') config.importSkipExisting = body.importSkipExisting;
    if (typeof body.importSilent === 'boolean') config.importSilent = body.importSilent;
    if (
      typeof body.importTimeoutSec === 'number' &&
      body.importTimeoutSec >= 30 &&
      body.importTimeoutSec <= 1800
    ) {
      config.importTimeoutSec = body.importTimeoutSec;
    }
    saveConfig(config);
    return { ok: true, config };
  });

  ipcMain.handle('dialog:choose-dir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择 Figma 导出目录',
      defaultPath: config.outputDir,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { canceled: true };
    }
    config.outputDir = res.filePaths[0];
    saveConfig(config);
    return { canceled: false, dir: config.outputDir };
  });

  ipcMain.handle('shell:open-folder', async (_event, dir) => {
    const target = dir && dir.trim() ? path.resolve(dir.trim()) : config.outputDir;
    ensureDir(target);
    const errMsg = await shell.openPath(target);
    if (errMsg) throw new Error(errMsg);
    return { ok: true, dir: target };
  });

  // ========== 批量导出 IPC ==========
  ipcMain.handle('export:start', async (_event, body = {}) => {
    if (exporter.isRunning || importer.isRunning) {
      throw new Error('当前已有导入或导出任务正在运行中');
    }
    if (!lastScanResult || !Array.isArray(lastScanResult.files) || lastScanResult.files.length === 0) {
      throw new Error('请先扫描团队与设计文件');
    }

    const fileKeys = Array.isArray(body.fileKeys) ? body.fileKeys : null;
    const skipExported =
      typeof body.skipExported === 'boolean' ? body.skipExported : config.skipExported;
    const silentExport =
      typeof body.silentExport === 'boolean' ? body.silentExport : config.silentExport;
    const timeoutSec = typeof body.timeoutSec === 'number' ? body.timeoutSec : config.timeoutSec;
    const outputDir =
      typeof body.outputDir === 'string' && body.outputDir.trim()
        ? path.resolve(body.outputDir.trim())
        : config.outputDir;

    config.outputDir = outputDir;
    config.skipExported = skipExported;
    config.silentExport = silentExport;
    config.timeoutSec = timeoutSec;
    saveConfig(config);

    const selectedFiles = fileKeys
      ? lastScanResult.files.filter((f) => fileKeys.includes(f.key))
      : lastScanResult.files;

    if (selectedFiles.length === 0) {
      throw new Error('没有选中的文件可导出');
    }

    exporter
      .exportFiles({
        files: selectedFiles,
        allFilesForDupCheck: lastScanResult.files,
        outputDir,
        skipExported,
        silentExport,
        timeoutSec,
      })
      .catch((err) => {
        addLog('error', `批量导出异常终止: ${err.message}`);
      });

    return { ok: true, total: selectedFiles.length, outputDir };
  });

  ipcMain.handle('export:stop', async () => {
    exporter.requestStop();
    return { ok: true };
  });

  // ========== 批量导入 IPC ==========
  ipcMain.handle('import:pick-files', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择要导入 Figma 的设计文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Figma & Sketch 设计文件', extensions: ['fig', 'jam', 'deck', 'sketch'] },
      ],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { canceled: true, queue: importQueue, added: 0 };
    }
    const found = collectLocalImportFiles(res.filePaths);
    const added = mergeIntoImportQueue(found);
    addLog('info', `已添加 ${added} 个待导入文件（当前队列共 ${importQueue.length} 个）`);
    return { canceled: false, queue: importQueue, added };
  });

  ipcMain.handle('import:pick-folder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '选择包含设计文件的本地文件夹（自动递归扫描子目录）',
      defaultPath: config.outputDir,
      properties: ['openDirectory', 'multiSelections'],
    });
    if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
      return { canceled: true, queue: importQueue, added: 0 };
    }
    const found = collectLocalImportFiles(res.filePaths);
    const added = mergeIntoImportQueue(found);
    if (found.length === 0) {
      addLog('warn', '所选文件夹下未找到 .fig / .jam / .deck / .sketch 文件');
    } else {
      addLog('info', `从文件夹扫描并新增 ${added} 个待导入文件（当前队列共 ${importQueue.length} 个）`);
    }
    return { canceled: false, queue: importQueue, added, scannedCount: found.length };
  });

  ipcMain.handle('import:add-paths', async (_event, paths = []) => {
    const found = collectLocalImportFiles(paths);
    const added = mergeIntoImportQueue(found);
    if (added > 0) {
      addLog('info', `通过拖拽新增 ${added} 个待导入文件（当前队列共 ${importQueue.length} 个）`);
    }
    return { ok: true, queue: importQueue, added };
  });

  ipcMain.handle('import:remove-items', async (_event, ids = []) => {
    if (importer.isRunning) throw new Error('正在导入中，无法移除队列项');
    const removeSet = new Set(ids);
    importQueue = importQueue.filter((item) => !removeSet.has(item.id));
    return { ok: true, queue: importQueue };
  });

  ipcMain.handle('import:clear', async () => {
    if (importer.isRunning) throw new Error('正在导入中，无法清空队列');
    importQueue = [];
    return { ok: true, queue: importQueue };
  });

  ipcMain.handle('import:targets', async () => {
    addLog('info', '正在拉取可用于导入的团队与文件夹列表...');
    const targets = await scanner.listTargets({ extraTeamIds: config.extraTeamIds });
    lastImportTargets = targets;
    addLog('success', `已加载 ${targets.teams.length} 个团队的目标文件夹列表`);
    return { ok: true, targets };
  });

  ipcMain.handle('import:create-folder', async (_event, { teamId, folderName } = {}) => {
    const folder = await scanner.createFolder(teamId, folderName);
    if (lastImportTargets && Array.isArray(lastImportTargets.teams)) {
      const team = lastImportTargets.teams.find((t) => t.id === String(teamId));
      if (team && !team.folders.some((f) => f.id === folder.id)) {
        team.folders.push(folder);
      }
    }
    return { ok: true, folder, targets: lastImportTargets };
  });

  ipcMain.handle('import:start', async (_event, body = {}) => {
    if (exporter.isRunning || importer.isRunning) {
      throw new Error('当前已有导入或导出任务正在运行中');
    }
    if (importQueue.length === 0) {
      throw new Error('请先添加要导入的本地 .fig / .jam / .deck 文件');
    }

    const fileIds = Array.isArray(body.fileIds) ? body.fileIds : null;
    const selectedFiles = fileIds
      ? importQueue.filter((f) => fileIds.includes(f.id))
      : importQueue;

    if (selectedFiles.length === 0) {
      throw new Error('请至少勾选一个要导入的文件');
    }

    const targetConfig = body.targetConfig || { mode: 'drafts' };
    const skipExisting =
      typeof body.skipExisting === 'boolean' ? body.skipExisting : config.importSkipExisting;
    const silentImport =
      typeof body.silentImport === 'boolean' ? body.silentImport : config.importSilent;
    const timeoutSec =
      typeof body.timeoutSec === 'number' ? body.timeoutSec : config.importTimeoutSec;

    config.importTargetMode = targetConfig.mode || 'drafts';
    config.importTeamId = targetConfig.teamId || '';
    config.importFolderId = targetConfig.folderId || '';
    config.importSkipExisting = skipExisting;
    config.importSilent = silentImport;
    config.importTimeoutSec = timeoutSec;
    saveConfig(config);

    importer
      .importFiles({
        files: selectedFiles,
        targetConfig,
        skipExisting,
        silentImport,
        timeoutSec,
      })
      .catch((err) => {
        addLog('error', `批量导入异常终止: ${err.message}`);
      });

    return { ok: true, total: selectedFiles.length };
  });

  ipcMain.handle('import:stop', async () => {
    importer.requestStop();
    return { ok: true };
  });
}

app.whenReady().then(() => {
  initServices();
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  if (browserManager) {
    browserManager.closeWindows();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
