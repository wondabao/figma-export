const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const {
  computeDuplicateNameKeys,
  buildTargetFilePath,
  ensureDir,
  loadManifest,
  saveManifest,
  getUrlPrefixForEditorType,
  sleep,
} = require('./utils');

const MAIN_MENU_BUTTON = [
  '[data-testid="toggle-menu-button"]',
  '[aria-label="Main menu" i]',
  '[aria-label="主菜单"]',
  '[aria-label="主選單"]',
  'button[data-tooltip="main-menu"]',
].join(', ');
const MENU_ITEMS = '[role="menuitem"], [data-testid^="dropdown-option-"]';
const FILE_LABEL = /^(?:File|文件|檔案)$/i;
const SAVE_LABEL = /^(?:Save\s+local\s+copy|保存本地(?:副本|拷贝)|儲存本[機地]副本)(?=$|[\s.…(（])/i;
const ACTIONS_INPUT = [
  'input[data-testid="quick-actions-search-input"]',
  '[data-testid="quick-actions"] input',
  '[data-testid="quick-actions-v2"] input',
  '[class*="quick_actions"] input',
].join(', ');
const ACTIONS_RESULTS = [
  '[role="option"]',
  MENU_ITEMS,
  '[data-testid="quick-actions-v2"] button',
  '[data-testid="quick-actions"] [tabindex]',
].join(', ');
const EXPORT_ERRORS = {
  disabled: 'Figma 显示「保存本地副本」不可用，请检查当前账号的复制和导出权限',
  menu_missing: '未能打开 Figma 主菜单，请关闭「后台静默导出」后重试并查看编辑器界面',
  file_menu_missing: '已打开 Figma 主菜单，但未找到「文件」子菜单',
  save_missing: 'Figma「文件」菜单未显示「保存本地副本」，请检查文件的复制和导出权限',
};

// 在编辑器中定位当前可交互的控件，坐标供 Chromium 输入事件使用。
function findControl(selector, label, prepareInput) {
  const matchesLabel = label && new RegExp(label.source, label.flags);
  let disabledControl = null;
  for (const element of document.querySelectorAll(selector)) {
    if (element.closest('[hidden], [aria-hidden="true"], [inert], [data-fpl-hidden="true"]')) continue;
    if (matchesLabel && ![
      element.getAttribute('aria-label'),
      element.innerText || element.textContent,
    ].some((text) => matchesLabel.test(text?.trim() || ''))) continue;

    const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
    const x = (left + right) / 2;
    const y = (top + bottom) / 2;
    if (!width || !height || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) continue;
    if (element.closest('[disabled], [aria-disabled="true"]')) {
      if (getComputedStyle(element).visibility === 'visible') disabledControl ??= { x, y, disabled: true };
      continue;
    }
    if (!element.contains(document.elementFromPoint(x, y))) continue;
    if (prepareInput) {
      if (element.readOnly) continue;
      element.focus();
      if (document.activeElement !== element) continue;
      element.select();
    }
    return { x, y, disabled: false };
  }
  return disabledControl;
}

class ElectronFigmaExporter {
  constructor(browserManager, onLog = () => {}, onProgress = () => {}, storage = { ensureDir, loadManifest, saveManifest, exists: fs.existsSync }) {
    this.browser = browserManager;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.storage = storage;
    this.isRunning = false;
    this.stopRequested = false;
    this.currentStats = null;
    this.activeExportWindow = null;
  }

  requestStop() {
    if (this.isRunning) {
      this.stopRequested = true;
      this.onLog('warn', '收到停止请求，将在当前文件处理完毕后安全停止...');
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      stopRequested: this.stopRequested,
      stats: this.currentStats,
    };
  }

  buildFileUrl(file) {
    const prefix = getUrlPrefixForEditorType(file.editorType);
    return `https://www.figma.com/${prefix}/${file.key}`;
  }

  /**
   * 等待 Figma 编辑器加载完成（画布与工具栏就绪）
   */
  async waitForEditorReady(win, timeoutMs = 60000) {
    const start = Date.now();
    const editorControls = MAIN_MENU_BUTTON + ', [data-testid="filename"], [class*="toolbar"]';
    while (Date.now() - start < timeoutMs) {
      if (this.stopRequested) throw new Error('USER_STOPPED');
      if (win.isDestroyed()) throw new Error('导出窗口被意外关闭');

      const state = await win.webContents.executeJavaScript(`
        (() => {
          const pathname = window.location.pathname;
          if (/^(?:\\/[a-z]{2}(?:-[a-z]{2})?)?\\/(?:community|communaute|comunidad)(?:\\/|$)/i.test(pathname)) {
            return { status: 'community_page' };
          }
          if (/^\\/(?:login|signup)(?:\\/|$)/.test(pathname)) return { status: 'login_required' };
          const bodyText = (document.body && document.body.innerText) || '';
          if (
            /File not found|404|Request access|You don't have access|找不到文件|请求访问权限/i.test(bodyText) &&
            !document.querySelector('canvas')
          ) {
            return { status: 'no_access', snippet: bodyText.slice(0, 120) };
          }
          const hasCanvas = Boolean(document.querySelector('canvas'));
          const hasMenu = Boolean(document.querySelector(${JSON.stringify(editorControls)}));
          const loadingBar = document.querySelector('[class*="progress_bar"], [data-testid="loading-screen"]');
          if (hasCanvas && hasMenu && !loadingBar) {
            return { status: 'ready' };
          }
          return { status: 'loading' };
        })()
      `);

      if (state.status === 'community_page') {
        throw new Error('Figma 打开的是 Community 资源页。请在文件列表中选择已复制到账号的设计文件。');
      }
      if (state.status === 'login_required') {
        throw new Error('Figma 要求重新登录后才能打开文件');
      }
      if (state.status === 'no_access') {
        throw new Error(`无权访问或文件不存在 (${state.snippet.replace(/\s+/g, ' ')})`);
      }
      if (state.status === 'ready') {
        await sleep(1600);
        return;
      }
      await sleep(700);
    }

    const hasCanvas = await win.webContents.executeJavaScript(`Boolean(document.querySelector('canvas'))`);
    if (!hasCanvas) {
      throw new Error('编辑器加载超时（未检测到画布）');
    }
  }

  async waitForControl(win, selector, { label, prepareInput = false, timeoutMs = 1800 } = {}) {
    const args = JSON.stringify([selector, label && { source: label.source, flags: label.flags }, prepareInput]);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const control = await win.webContents.executeJavaScript(`(${findControl})(...${args})`);
      if (control) return control;
      if (Date.now() >= deadline) return null;
      await sleep(120);
    }
  }

  async clickControl(input, { x, y }) {
    await input.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    for (const type of ['mousePressed', 'mouseReleased']) {
      await input.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
  }

  async sendShortcut(input, key, code, windowsVirtualKeyCode, modifiers = 0) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await input.sendCommand('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers });
    }
  }

  async triggerSaveViaMainMenu(win, input) {
    const menu = await this.waitForControl(win, MAIN_MENU_BUTTON);
    if (!menu || menu.disabled) return 'menu_missing';
    await this.clickControl(input, menu);

    const fileMenu = await this.waitForControl(win, MENU_ITEMS, { label: FILE_LABEL });
    if (!fileMenu || fileMenu.disabled) {
      const opened = await this.waitForControl(win, '[data-testid="main-menu"], [role="menu"]', { timeoutMs: 0 });
      return opened ? 'file_menu_missing' : 'menu_missing';
    }
    await this.clickControl(input, fileMenu);

    const save = await this.waitForControl(win, MENU_ITEMS, { label: SAVE_LABEL, timeoutMs: 2800 });
    if (!save) return 'save_missing';
    if (save.disabled) return 'disabled';
    await this.clickControl(input, save);
    return 'clicked';
  }

  async triggerSaveViaQuickActions(win, input) {
    const modifiers = process.platform === 'darwin' ? 4 : 2; // Chromium 的 Meta / Ctrl 掩码
    const shortcuts = [['k', 'KeyK', 75], ['/', 'Slash', 191], ['p', 'KeyP', 80]];
    for (const [key, code, keyCode] of shortcuts) {
      await this.sendShortcut(input, 'Escape', 'Escape', 27);
      await this.sendShortcut(input, key, code, keyCode, modifiers);

      const queryInput = await this.waitForControl(win, ACTIONS_INPUT, { timeoutMs: 1200 });
      if (!queryInput || queryInput.disabled) continue;
      for (const query of ['Save local copy', '保存本地副本', '儲存本機副本']) {
        const focused = await this.waitForControl(win, ACTIONS_INPUT, { prepareInput: true, timeoutMs: 450 });
        if (!focused || focused.disabled) break;
        await input.sendCommand('Input.insertText', { text: query });
        const save = await this.waitForControl(win, ACTIONS_RESULTS, { label: SAVE_LABEL, timeoutMs: 950 });
        if (!save) continue;
        if (save.disabled) return 'disabled';
        await this.clickControl(input, save);
        return 'clicked';
      }
      // 命令面板已经打开，其他快捷键会打开同一个面板。
      break;
    }
    return 'save_missing';
  }

  async triggerSave(win) {
    const input = win.webContents.debugger;
    // 向导出页发送完整的指针与键盘事件，后台窗口也能接收。
    input.attach('1.3');
    try {
      const menuStatus = await this.triggerSaveViaMainMenu(win, input);
      if (menuStatus === 'clicked' || menuStatus === 'disabled') return menuStatus;
      this.onLog('info', '  ↳ 主菜单未触发保存，尝试通过 Figma 命令面板导出');
      const actionsStatus = await this.triggerSaveViaQuickActions(win, input);
      return actionsStatus === 'save_missing' ? menuStatus : actionsStatus;
    } finally {
      if (input.isAttached()) input.detach();
    }
  }

  /**
   * 导出单个文件：使用 Electron 原生 will-download 拦截下载并精准保存到目标目录
   */
  async exportSingleFile(file, targetPath, { timeoutSec = 180, silentExport = true } = {}) {
    const ses = this.browser.getSession();
    const cleanUa = this.browser.getCleanUserAgent();

    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      show: !silentExport,
      title: `正在导出: ${file.name}`,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    this.activeExportWindow = win;
    win.webContents.setUserAgent(cleanUa);

    let downloadHandler = null;
    let timeoutHandle = null;

    try {
      const fileUrl = this.buildFileUrl(file);
      await win.loadURL(fileUrl, { userAgent: cleanUa });
      await this.waitForEditorReady(win, 60000);

      // 提前挂载 Electron 原生 will-download 监听
      const downloadPromise = new Promise((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`导出等待下载超时 (${timeoutSec} 秒)`));
        }, timeoutSec * 1000);

        downloadHandler = (event, item, webContents) => {
          if (webContents.id !== win.webContents.id) return;

          const suggestedName = item.getFilename() || '';
          const suggestedExt = path.extname(suggestedName);
          let finalPath = targetPath;
          if (
            suggestedExt &&
            suggestedExt.toLowerCase() !== path.extname(targetPath).toLowerCase()
          ) {
            finalPath = targetPath.slice(0, -path.extname(targetPath).length) + suggestedExt;
          }

          ensureDir(path.dirname(finalPath));
          const tmpPath = `${finalPath}.downloading`;
          item.setSavePath(tmpPath);

          item.once('done', (e, state) => {
            clearTimeout(timeoutHandle);
            if (state === 'completed') {
              try {
                const stat = fs.statSync(tmpPath);
                if (!stat || stat.size === 0) {
                  fs.unlinkSync(tmpPath);
                  reject(new Error('下载的文件大小为 0 字节'));
                  return;
                }
                fs.renameSync(tmpPath, finalPath);
                resolve({ localPath: finalPath, fileSize: stat.size });
              } catch (fsErr) {
                reject(fsErr);
              }
            } else {
              try {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
              } catch {
                // ignore
              }
              reject(new Error(`下载未完成 (${state})`));
            }
          });
        };

        ses.on('will-download', downloadHandler);
      });
      // 菜单处理期间下载可能先失败。最终仍由 await 把下载错误交给导出队列。
      downloadPromise.catch(() => {});

      const status = await this.triggerSave(win);
      if (status !== 'clicked') throw new Error(EXPORT_ERRORS[status]);
      return await downloadPromise;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (downloadHandler) ses.removeListener('will-download', downloadHandler);
      this.activeExportWindow = null;
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  /**
   * 批量导出所选文件（支持断点续传、增量备份、后台静默导出与失败重试）
   */
  async exportFiles({
    files,
    allFilesForDupCheck,
    outputDir,
    skipExported = true,
    silentExport = true,
    timeoutSec = 180,
    delayBetweenFilesMs = 1000,
  }) {
    if (this.isRunning) {
      throw new Error('当前已有导出任务正在运行中');
    }
    if (!files || files.length === 0) {
      throw new Error('请至少选择一个要导出的文件');
    }

    this.isRunning = true;
    this.stopRequested = false;

    try {
      const auth = await this.browser.checkAuthStatus();
      if (!auth.authenticated) {
        throw new Error('Figma 尚未登录，请先点击「登录 Figma」完成登录');
      }

      await this.storage.ensureDir(outputDir);
      const manifest = await this.storage.loadManifest(outputDir);
      const dupSet = computeDuplicateNameKeys(allFilesForDupCheck || files);

    const stats = {
      total: files.length,
      completed: 0,
      exported: 0,
      skipped: 0,
      failed: 0,
      startedAt: Date.now(),
      currentFile: null,
      outputDir,
    };
    this.currentStats = stats;

    this.onLog(
      'info',
      `开始批量导出（${silentExport ? '后台静默模式' : '可视化窗口模式'}），共 ${files.length} 个文件，目标目录: ${outputDir}`
    );
    this.onProgress({ type: 'export_start', stats });

    try {
      for (let i = 0; i < files.length; i++) {
        if (this.stopRequested) {
          this.onLog('warn', `导出已停止（已处理 ${stats.completed}/${stats.total}）`);
          break;
        }

        const file = files[i];
        const targetPath = buildTargetFilePath(outputDir, file, dupSet);
        stats.currentFile = {
          index: i + 1,
          key: file.key,
          name: file.name,
          teamName: file.teamName,
          folderName: file.folderName,
        };

        if (skipExported) {
          const prev = manifest.files[file.key];
          const existsOnDisk =
            (prev && prev.localPath && await this.storage.exists(prev.localPath)) ||
            await this.storage.exists(targetPath);

          const isUnchanged =
            !prev ||
            !file.updatedAt ||
            !prev.remoteUpdatedAt ||
            file.updatedAt === prev.remoteUpdatedAt;

          if (existsOnDisk && (!prev || prev.status === 'exported') && isUnchanged) {
            stats.skipped += 1;
            stats.completed += 1;
            this.onLog(
              'skip',
              `[${i + 1}/${files.length}] 跳过已备份: ${file.teamName} / ${file.folderName} / ${file.name}`
            );
            this.onProgress({
              type: 'file_done',
              fileKey: file.key,
              status: 'skipped',
              stats,
            });
            continue;
          }
        }

        this.onLog(
          'info',
          `[${i + 1}/${files.length}] 正在导出: ${file.teamName} / ${file.folderName} / ${file.name}`
        );
        this.onProgress({ type: 'file_start', fileKey: file.key, stats });

        try {
          const { localPath, fileSize } = await this.exportSingleFile(file, targetPath, {
            timeoutSec,
            silentExport,
          });
          const sizeMB = (fileSize / (1024 * 1024)).toFixed(2);

          manifest.files[file.key] = {
            key: file.key,
            name: file.name,
            teamId: file.teamId,
            teamName: file.teamName,
            folderId: file.folderId,
            folderName: file.folderName,
            editorType: file.editorType,
            remoteUpdatedAt: file.updatedAt || null,
            localPath,
            fileSize,
            status: 'exported',
            exportedAt: new Date().toISOString(),
            error: null,
          };
          await this.storage.saveManifest(outputDir, manifest);

          stats.exported += 1;
          stats.completed += 1;
          this.onLog('success', `  ✓ 导出成功 (${sizeMB} MB): ${path.basename(localPath)}`);
          this.onProgress({
            type: 'file_done',
            fileKey: file.key,
            status: 'exported',
            fileSize,
            localPath,
            stats,
          });
        } catch (err) {
          if (err.message === 'USER_STOPPED') {
            this.onLog('warn', `导出已被用户中断: ${file.name}`);
            break;
          }

          manifest.files[file.key] = {
            key: file.key,
            name: file.name,
            teamId: file.teamId,
            teamName: file.teamName,
            folderId: file.folderId,
            folderName: file.folderName,
            editorType: file.editorType,
            remoteUpdatedAt: file.updatedAt || null,
            localPath: targetPath,
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: err.message,
          };
          await this.storage.saveManifest(outputDir, manifest);

          stats.failed += 1;
          stats.completed += 1;
          this.onLog('error', `  ✗ 导出失败 [${file.name}]: ${err.message}`);
          this.onProgress({
            type: 'file_done',
            fileKey: file.key,
            status: 'failed',
            error: err.message,
            stats,
          });
        }

        if (delayBetweenFilesMs > 0 && i < files.length - 1 && !this.stopRequested) {
          await sleep(delayBetweenFilesMs);
        }
      }
    } finally {
      stats.currentFile = null;
      stats.finishedAt = Date.now();
      this.isRunning = false;
      this.onProgress({
        type: 'export_finish',
        stopped: this.stopRequested,
        stats,
      });
      this.onLog(
        stats.failed > 0 ? 'warn' : 'success',
        `导出任务结束：成功 ${stats.exported}，跳过 ${stats.skipped}，失败 ${stats.failed}（总计 ${stats.total}）`
      );
      this.stopRequested = false;
    }

    return stats;
    } catch (earlyErr) {
      this.isRunning = false;
      this.stopRequested = false;
      throw earlyErr;
    }
  }
}

module.exports = { ElectronFigmaExporter };
