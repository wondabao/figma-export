const { FigmaScanner } = require('./scanner');
const { parseTeamIdInput } = require('./utils');

function createAppController({
  paths,
  registerHandler,
  chooseOpenDialog,
  openFolder,
  path,
  storage,
  Browser,
  Exporter,
  Importer,
  emitEvent,
  platform,
}) {
  let browserManager = null;
  let scanner = null;
  let exporter = null;
  let importer = null;

  let config = null;
  let lastScanResult = null;
  let lastImportTargets = null;
  let importQueue = [];
  let isScanning = false;
  let startingTask = false;
  const logs = [];

  async function loadConfig() {
    const defaults = {
      outputDir: path.join(paths.documents, 'Figma Exports'),
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
      cachedUser: null,
    };
    return { ...defaults, ...(await storage.loadConfig()) };
  }

  async function saveConfig(cfg) {
    await storage.saveConfig(cfg);
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
    emitEvent('event:log', entry);
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

  async function syncCachedUser(authState) {
    const nextUser = authState && authState.authenticated && authState.user ? authState.user : null;
    const prevJson = JSON.stringify(config.cachedUser || null);
    const nextJson = JSON.stringify(nextUser);
    if (prevJson !== nextJson) {
      config.cachedUser = nextUser;
      try {
        await saveConfig(config);
      } catch {
        // ignore
      }
    }
  }

  async function initServices() {
    config = await loadConfig();

    browserManager = new Browser(addLog, (authState) => {
      void syncCachedUser(authState);
      emitEvent('event:auth_update', authState);
    });
    if (config.cachedUser) {
      browserManager.user = config.cachedUser;
    }

    scanner = new FigmaScanner(
      browserManager,
      addLog,
      (progress) => {
        emitEvent('event:scan_progress', progress);
      },
      storage
    );

    exporter = new Exporter(
      browserManager,
      addLog,
      (progress) => {
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
        emitEvent('event:export_progress', progress);
      },
      storage
    );

    importer = new Importer(browserManager, scanner, addLog, (progress) => {
      if (progress.fileId && progress.type === 'file_done') {
        const target = importQueue.find((f) => f.id === progress.fileId);
        if (target) {
          target.status = progress.status;
          target.destinationLabel = progress.destinationLabel || target.destinationLabel || null;
          target.error = progress.status === 'failed' ? progress.error || '导入失败' : null;
        }
      }
      emitEvent('event:import_progress', progress);
    });
  }

  function registerHandlers() {
    registerHandler('state:get', async () => {
      browserManager
        .checkAuthStatus()
        .then((auth) => {
          if (!auth.authenticated && auth.transient && config.cachedUser) {
            browserManager.user = config.cachedUser;
            return;
          }
          const authPayload = {
            authenticated: auth.authenticated,
            user: auth.user,
          };
          void syncCachedUser(authPayload);
          emitEvent('event:auth_update', authPayload);
        })
        .catch(() => {});

      const effectiveUser = browserManager.user || config.cachedUser || null;
      return {
        auth: {
          authenticated: Boolean(effectiveUser),
          user: effectiveUser,
        },
        config,
        isScanning,
        scanResult: lastScanResult,
        importTargets: lastImportTargets,
        importQueue,
        exportStatus: exporter.getStatus(),
        importStatus: importer.getStatus(),
        logs: logs.slice(-150),
        platform,
        homeDir: paths.home,
      };
    });

    registerHandler('auth:login', async () => {
      const status = await browserManager.openLoginWindow();
      return { ok: true, auth: { authenticated: status.authenticated, user: status.user } };
    });

    registerHandler('auth:logout', async () => {
      if (isScanning || exporter.isRunning || importer.isRunning || startingTask) {
        throw new Error('当前有任务正在运行中，请先停止任务后再切换账号');
      }
      await browserManager.logoutAndResetProfile();
      config.cachedUser = null;
      await saveConfig(config);
      lastScanResult = null;
      lastImportTargets = null;
      return { ok: true };
    });

    registerHandler('scan:start', async (opts = {}) => {
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

    registerHandler('teams:add', async (input) => {
      const teamId = parseTeamIdInput(input);
      if (!teamId) {
        throw new Error('无法解析 Team ID，请粘贴包含 /team/数字 的 Figma 团队链接或纯数字 Team ID');
      }
      if (!config.extraTeamIds.includes(teamId)) {
        config.extraTeamIds.push(teamId);
        await saveConfig(config);
        addLog('info', `已添加手动团队 ID: ${teamId}，点击扫描或刷新团队即可拉取`);
      }
      return { ok: true, teamId, extraTeamIds: config.extraTeamIds };
    });

    registerHandler('teams:remove', async (teamId) => {
      const idStr = String(teamId || '');
      config.extraTeamIds = config.extraTeamIds.filter((id) => id !== idStr);
      await saveConfig(config);
      return { ok: true, extraTeamIds: config.extraTeamIds };
    });

    registerHandler('settings:save', async (body = {}) => {
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
      await saveConfig(config);
      return { ok: true, config };
    });

    registerHandler('dialog:choose-dir', async () => {
      const res = await chooseOpenDialog({
        title: '选择 Figma 导出目录',
        defaultPath: config.outputDir,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true };
      }
      config.outputDir = res.filePaths[0];
      await saveConfig(config);
      return { canceled: false, dir: config.outputDir };
    });

    registerHandler('shell:open-folder', async (dir) => {
      const target = dir && dir.trim() ? path.resolve(dir.trim()) : config.outputDir;
      await storage.ensureDir(target);
      const errMsg = await openFolder(target);
      if (errMsg) throw new Error(errMsg);
      return { ok: true, dir: target };
    });

    registerHandler('export:start', async (body = {}) => {
      if (isScanning || exporter.isRunning || importer.isRunning || startingTask) {
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
      startingTask = true;
      try {
        await saveConfig(config);
      } catch (error) {
        startingTask = false;
        throw error;
      }

      const selectedFiles = fileKeys
        ? lastScanResult.files.filter((f) => fileKeys.includes(f.key))
        : lastScanResult.files;

      if (selectedFiles.length === 0) {
        startingTask = false;
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
      startingTask = false;

      return { ok: true, total: selectedFiles.length, outputDir };
    });

    registerHandler('export:stop', async () => {
      exporter.requestStop();
      return { ok: true };
    });

    registerHandler('import:pick-files', async () => {
      const res = await chooseOpenDialog({
        title: '选择要导入 Figma 的设计文件',
        properties: ['openFile', 'multiSelections'],
        filters: [
          { name: 'Figma & Sketch 设计文件', extensions: ['fig', 'jam', 'deck', 'sketch'] },
        ],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true, queue: importQueue, added: 0 };
      }
      const found = await storage.collectLocalImportFiles(res.filePaths);
      const added = mergeIntoImportQueue(found);
      addLog('info', `已添加 ${added} 个待导入文件（当前队列共 ${importQueue.length} 个）`);
      return { canceled: false, queue: importQueue, added };
    });

    registerHandler('import:pick-folder', async () => {
      const res = await chooseOpenDialog({
        title: '选择包含设计文件的本地文件夹（自动递归扫描子目录）',
        defaultPath: config.outputDir,
        properties: ['openDirectory', 'multiSelections'],
      });
      if (res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return { canceled: true, queue: importQueue, added: 0 };
      }
      const found = await storage.collectLocalImportFiles(res.filePaths);
      const added = mergeIntoImportQueue(found);
      if (found.length === 0) {
        addLog('warn', '所选文件夹下未找到 .fig / .jam / .deck / .sketch 文件');
      } else {
        addLog('info', `从文件夹扫描并新增 ${added} 个待导入文件（当前队列共 ${importQueue.length} 个）`);
      }
      return { canceled: false, queue: importQueue, added, scannedCount: found.length };
    });

    registerHandler('import:add-paths', async (inputPaths = []) => {
      const found = await storage.collectLocalImportFiles(inputPaths);
      const added = mergeIntoImportQueue(found);
      if (added > 0) {
        addLog('info', `通过拖拽新增 ${added} 个待导入文件（当前队列共 ${importQueue.length} 个）`);
      }
      return { ok: true, queue: importQueue, added };
    });

    registerHandler('import:remove-items', async (ids = []) => {
      if (importer.isRunning) throw new Error('正在导入中，无法移除队列项');
      const removeSet = new Set(ids);
      importQueue = importQueue.filter((item) => !removeSet.has(item.id));
      return { ok: true, queue: importQueue };
    });

    registerHandler('import:clear', async () => {
      if (importer.isRunning) throw new Error('正在导入中，无法清空队列');
      importQueue = [];
      return { ok: true, queue: importQueue };
    });

    registerHandler('import:targets', async () => {
      addLog('info', '正在拉取可用于导入的团队与文件夹列表...');
      const targets = await scanner.listTargets({ extraTeamIds: config.extraTeamIds });
      lastImportTargets = targets;
      addLog('success', `已加载 ${targets.teams.length} 个团队的目标文件夹列表`);
      return { ok: true, targets };
    });

    registerHandler('import:create-folder', async ({ teamId, folderName } = {}) => {
      const folder = await scanner.createFolder(teamId, folderName);
      if (lastImportTargets && Array.isArray(lastImportTargets.teams)) {
        const team = lastImportTargets.teams.find((t) => t.id === String(teamId));
        if (team && !team.folders.some((f) => f.id === folder.id)) {
          team.folders.push(folder);
        }
      }
      return { ok: true, folder, targets: lastImportTargets };
    });

    registerHandler('import:start', async (body = {}) => {
      if (isScanning || exporter.isRunning || importer.isRunning || startingTask) {
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
      startingTask = true;
      try {
        await saveConfig(config);
      } catch (error) {
        startingTask = false;
        throw error;
      }

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
      startingTask = false;

      return { ok: true, total: selectedFiles.length };
    });

    registerHandler('import:stop', async () => {
      importer.requestStop();
      return { ok: true };
    });
  }

  return {
    async start() {
      await initServices();
      registerHandlers();
    },
    isBusy() {
      return Boolean(isScanning || exporter?.isRunning || importer?.isRunning || startingTask);
    },
    close() {
      browserManager?.closeWindows();
    },
  };
}

module.exports = { createAppController };
