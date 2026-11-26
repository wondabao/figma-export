const fs = require('fs');
const path = require('path');
const { BrowserWindow } = require('electron');
const { inferFigmaTitleFromPath, sleep } = require('./utils');

const IMPORT_BUTTON_SELECTOR = [
  '[data-testid*="import" i]',
  'button[aria-label*="Import" i]',
  'button[aria-label*="导入"]',
  'button[aria-label*="匯入"]',
  '[role="button"][aria-label*="Import" i]',
  '[role="button"][aria-label*="导入"]',
  '[data-tooltip*="import" i]',
  'button',
  '[role="button"]',
].join(', ');

const IMPORT_BUTTON_LABEL = /^(?:\+\s*)?(?:Import(?:\s+file)?|导入(?:文件)?|匯入(?:檔案)?)$/i;

const MODAL_SELECT_SELECTOR = [
  '[role="dialog"] button',
  '[role="dialog"] [role="button"]',
  '[role="dialog"] label',
  '[class*="modal" i] button',
  '[class*="modal" i] label',
  '[data-testid*="import" i] button',
].join(', ');

const MODAL_SELECT_LABEL = /(?:Select|Choose|from\s+your\s+computer|Import\s+from|选择文件|从电脑|電腦|浏览|\.fig)/i;

// 在页面中定位可见且未禁用的控件坐标
function locateVisibleControl(selector, labelSource, labelFlags) {
  const regex = labelSource ? new RegExp(labelSource, labelFlags || '') : null;
  let disabledFound = null;

  for (const el of document.querySelectorAll(selector)) {
    if (el.closest('[hidden], [aria-hidden="true"], [inert], [data-fpl-hidden="true"]')) continue;

    if (regex) {
      const candidates = [
        el.getAttribute('aria-label'),
        el.getAttribute('data-tooltip'),
        el.innerText || el.textContent,
      ];
      const matched = candidates.some((t) => regex.test((t || '').trim()));
      if (!matched) continue;
    }

    const rect = el.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2;
    const y = (rect.top + rect.bottom) / 2;
    if (!rect.width || !rect.height || x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
      continue;
    }

    if (el.closest('[disabled], [aria-disabled="true"]')) {
      if (getComputedStyle(el).visibility === 'visible') {
        disabledFound ??= { x, y, disabled: true };
      }
      continue;
    }

    const topEl = document.elementFromPoint(x, y);
    if (topEl && !el.contains(topEl) && !topEl.contains(el)) continue;

    return { x, y, disabled: false };
  }

  return disabledFound;
}

class ElectronFigmaImporter {
  constructor(browserManager, scanner, onLog = () => {}, onProgress = () => {}) {
    this.browser = browserManager;
    this.scanner = scanner;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.isRunning = false;
    this.stopRequested = false;
    this.currentStats = null;
    this.activeImportWindow = null;
  }

  requestStop() {
    if (this.isRunning) {
      this.stopRequested = true;
      this.onLog('warn', '收到停止导入请求，将在当前文件处理完毕后安全停止...');
    }
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      stopRequested: this.stopRequested,
      stats: this.currentStats,
    };
  }

  buildDestinationUrl({ isDrafts, teamId, folderId }) {
    if (isDrafts) {
      return 'https://www.figma.com/files/drafts';
    }
    if (teamId && folderId) {
      return `https://www.figma.com/files/team/${encodeURIComponent(teamId)}/project/${encodeURIComponent(folderId)}`;
    }
    return `https://www.figma.com/files/project/${encodeURIComponent(folderId)}`;
  }

  /**
   * 等待 Figma 文件浏览器（Drafts 或文件夹页）加载就绪
   */
  async waitForFileBrowserReady(win, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.stopRequested) throw new Error('USER_STOPPED');
      if (win.isDestroyed()) throw new Error('导入窗口被意外关闭');

      const state = await win.webContents.executeJavaScript(`
        (() => {
          const pathname = window.location.pathname || '';
          if (/^\\/(?:login|signup)(?:\\/|$)/.test(pathname)) {
            return { status: 'login_required' };
          }
          const bodyText = (document.body && document.body.innerText) || '';
          if (/Page not found|404|You don't have access|Request access|无权访问|请求访问权限/i.test(bodyText) && !document.querySelector('input[type="file"]')) {
            return { status: 'no_access', snippet: bodyText.slice(0, 120) };
          }
          const hasFileInput = Boolean(document.querySelector('input[type="file"]'));
          const hasImportBtn = Array.from(document.querySelectorAll('button, [role="button"], [data-testid*="import" i]')).some((b) => {
            const txt = (b.getAttribute('aria-label') || b.innerText || b.textContent || '').trim();
            return /^(?:\\+\\s*)?(?:Import|导入|匯入)/i.test(txt) || /import/i.test(b.getAttribute('data-testid') || '');
          });
          const hasBrowserShell = Boolean(
            document.querySelector('[data-testid*="file-browser" i], [class*="file_browser" i], main, nav')
          );
          if (hasFileInput || hasImportBtn || (hasBrowserShell && bodyText.length > 40)) {
            return { status: 'ready', hasFileInput, hasImportBtn };
          }
          return { status: 'loading' };
        })()
      `);

      if (state.status === 'login_required') {
        throw new Error('Figma 登录态已失效，请重新点击「登录 Figma」');
      }
      if (state.status === 'no_access') {
        throw new Error(`无法访问目标文件夹 (${state.snippet.replace(/\s+/g, ' ')})`);
      }
      if (state.status === 'ready') {
        await sleep(1000);
        return state;
      }
      await sleep(600);
    }
    throw new Error('Figma 文件夹页面加载超时');
  }

  async findControl(win, selector, labelRegex) {
    const args = JSON.stringify([
      selector,
      labelRegex ? labelRegex.source : null,
      labelRegex ? labelRegex.flags : null,
    ]);
    return await win.webContents.executeJavaScript(`(${locateVisibleControl})(...${args})`);
  }

  async clickAt(dbg, { x, y }) {
    await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
    await dbg.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1,
    });
  }

  /**
   * 尝试通过三种互补策略将本地 .fig/.jam/.deck/.sketch 文件注入 Figma 导入器
   */
  async feedFileToFigma(win, dbg, localPath, fileChooserState) {
    // 策略 1：点击页面上的「Import / 导入」按钮，拦截文件选择框
    const importBtn =
      (await this.findControl(win, '[data-testid*="import" i]', null)) ||
      (await this.findControl(win, IMPORT_BUTTON_SELECTOR, IMPORT_BUTTON_LABEL));

    if (importBtn && importBtn.disabled) {
      throw new Error('目标位置的「导入 (Import)」按钮处于禁用状态（可能没有该文件夹的编辑权限或团队已锁定）');
    }

    if (importBtn) {
      await this.clickAt(dbg, importBtn);
      for (let i = 0; i < 12; i++) {
        if (fileChooserState.provided) return 'chooser_button';
        await sleep(120);
      }

      // 如果点击 Import 打开了一个导入弹窗（"Select files from your computer"），继续点击弹窗内的选择按钮
      const modalBtn = await this.findControl(win, MODAL_SELECT_SELECTOR, MODAL_SELECT_LABEL);
      if (modalBtn && !modalBtn.disabled) {
        await this.clickAt(dbg, modalBtn);
        for (let i = 0; i < 12; i++) {
          if (fileChooserState.provided) return 'chooser_modal';
          await sleep(120);
        }
      }
    }

    // 策略 2：直接在 DOM 中查找 <input type="file"> 并通过 CDP DOM.setFileInputFiles 注入文件
    const doc = await dbg.sendCommand('DOM.getDocument', { depth: 1 });
    const { nodeIds } = await dbg.sendCommand('DOM.querySelectorAll', {
      nodeId: doc.root.nodeId,
      selector: 'input[type="file"]',
    });

    if (Array.isArray(nodeIds) && nodeIds.length > 0) {
      let targetNodeId = nodeIds[nodeIds.length - 1];
      for (const nid of nodeIds) {
        try {
          const { attributes } = await dbg.sendCommand('DOM.getAttributes', { nodeId: nid });
          if (Array.isArray(attributes)) {
            const acceptIdx = attributes.indexOf('accept');
            if (acceptIdx !== -1 && /\.fig/i.test(attributes[acceptIdx + 1] || '')) {
              targetNodeId = nid;
              break;
            }
          }
        } catch {
          // ignore
        }
      }

      await dbg.sendCommand('DOM.setFileInputFiles', {
        nodeId: targetNodeId,
        files: [localPath],
      });

      // 确保触发 input / change 事件通知前端框架
      await win.webContents.executeJavaScript(`
        (() => {
          const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
          for (const inp of inputs) {
            if (inp.files && inp.files.length > 0) {
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
        })()
      `);
      return 'dom_input';
    }

    // 策略 3：通过 Chromium 原生拖拽事件将文件直接拖入 Figma 文件列表区域
    const dropPoint = { x: 680, y: 420 };
    const dragData = {
      items: [],
      files: [localPath],
      dragOperationsMask: 1,
    };
    await dbg.sendCommand('Input.dispatchDragEvent', {
      type: 'dragEnter',
      x: dropPoint.x,
      y: dropPoint.y,
      data: dragData,
    });
    await dbg.sendCommand('Input.dispatchDragEvent', {
      type: 'dragOver',
      x: dropPoint.x,
      y: dropPoint.y,
      data: dragData,
    });
    await dbg.sendCommand('Input.dispatchDragEvent', {
      type: 'drop',
      x: dropPoint.x,
      y: dropPoint.y,
      data: dragData,
    });
    return 'drag_drop';
  }

  /**
   * 导入单个本地文件到指定的 Figma 草稿箱或团队文件夹
   */
  async importSingleFile(
    file,
    destination,
    existingKeys,
    { timeoutSec = 240, silentImport = true } = {}
  ) {
    if (!fs.existsSync(file.localPath)) {
      throw new Error(`本地文件不存在: ${file.localPath}`);
    }

    const ses = this.browser.getSession();
    const cleanUa = this.browser.getCleanUserAgent();

    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      show: !silentImport,
      title: `正在导入: ${file.fileName}`,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    this.activeImportWindow = win;
    win.webContents.setUserAgent(cleanUa);

    const dbg = win.webContents.debugger;
    const fileChooserState = { provided: false, error: null };
    let activeUploadRequests = 0;
    let sawUploadActivity = false;

    const onDebuggerMessage = async (_event, method, params) => {
      if (method === 'Page.fileChooserOpened') {
        try {
          if (params && params.backendNodeId) {
            await dbg.sendCommand('DOM.setFileInputFiles', {
              files: [file.localPath],
              backendNodeId: params.backendNodeId,
            });
            fileChooserState.provided = true;
          }
        } catch (err) {
          fileChooserState.error = err.message;
        }
      } else if (method === 'Network.requestWillBeSent') {
        const reqUrl = params?.request?.url || '';
        const reqMethod = (params?.request?.method || '').toUpperCase();
        if (
          (reqMethod === 'POST' || reqMethod === 'PUT') &&
          (/fig_import|import|upnode|upload|s3\.amazonaws\.com|storage\.googleapis\.com/i.test(reqUrl))
        ) {
          activeUploadRequests += 1;
          sawUploadActivity = true;
        }
      } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        if (activeUploadRequests > 0) {
          activeUploadRequests = Math.max(0, activeUploadRequests - 1);
        }
      }
    };

    try {
      const destUrl = this.buildDestinationUrl(destination);
      await win.loadURL(destUrl, { userAgent: cleanUa });

      // 如果 /files/team/:id/project/:fid 发生 404，回退到通用 /files/project/:fid
      if (!destination.isDrafts && destination.teamId && destination.folderId) {
        const bodyTxt = await win.webContents.executeJavaScript(
          `(document.body && document.body.innerText) || ''`
        );
        if (/Page not found|404/i.test(bodyTxt)) {
          await win.loadURL(
            `https://www.figma.com/files/project/${encodeURIComponent(destination.folderId)}`,
            { userAgent: cleanUa }
          );
        }
      }

      await this.waitForFileBrowserReady(win, 45000);

      dbg.attach('1.3');
      dbg.on('message', onDebuggerMessage);
      await dbg.sendCommand('DOM.enable');
      await dbg.sendCommand('Page.enable');
      await dbg.sendCommand('Network.enable');
      await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });

      const methodUsed = await this.feedFileToFigma(win, dbg, file.localPath, fileChooserState);
      if (fileChooserState.error) {
        throw new Error(`注入导入文件失败: ${fileChooserState.error}`);
      }
      this.onLog('info', `  ↳ 已提交上传 (${methodUsed})，等待 Figma 云端解析与落库...`);

      const startTime = Date.now();
      let lastFolderPoll = 0;
      let sawImportingUi = false;

      while (Date.now() - startTime < timeoutSec * 1000) {
        if (this.stopRequested) throw new Error('USER_STOPPED');
        if (win.isDestroyed()) throw new Error('导入窗口被意外关闭');

        await sleep(1000);

        // 1. 检查是否自动跳转进了新导入的文件编辑器页
        const currentUrl = win.webContents.getURL() || '';
        const editorMatch = currentUrl.match(
          /figma\.com\/(?:design|file|board|slides|site|buzz)\/([a-zA-Z0-9]+)/
        );
        if (editorMatch && (!existingKeys || !existingKeys.has(editorMatch[1]))) {
          return { importedKey: editorMatch[1] };
        }

        // 2. 检查页面弹窗 / 提示条状态（错误提示、正在导入中、Done 按钮）
        const uiState = await win.webContents.executeJavaScript(`
          (() => {
            const dialogs = Array.from(
              document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="alert"], [class*="modal" i], [class*="toast" i], [class*="notification" i]')
            );
            const dialogText = dialogs.map((d) => (d.innerText || d.textContent || '').trim()).join(' \\n ');

            // 检测明确错误提示
            if (/failed to import|couldn't import|unable to import|import failed|can't import|unsupported file|corrupted|导入失败|无法导入|不支持的文件/i.test(dialogText)) {
              return { status: 'error', message: dialogText.slice(0, 180) };
            }
            if (/team is locked|starter plan|maximum of \\d+ files|upgrade to professional|超出文件数量限制|团队已锁定/i.test(dialogText)) {
              return { status: 'error', message: '目标团队受套餐或锁定限制（如 Starter 免费团队限制文件数或教育团队已锁定），建议导入到「个人草稿箱 (Drafts)」或已升级的团队' };
            }

            const isImporting = /importing|uploading|正在导入|正在上传|匯入中/i.test(dialogText);

            // 检查是否有「Done / 完成」按钮（Figma 导入完成弹窗）
            for (const d of dialogs) {
              const txt = (d.innerText || d.textContent || '');
              if (/imported|导入完成|已导入|成功导入|匯入完成/i.test(txt) && !isImporting) {
                const btns = Array.from(d.querySelectorAll('button, [role="button"]'));
                for (const b of btns) {
                  const bt = (b.innerText || b.textContent || '').trim();
                  if (/^(?:Done|Close|OK|完成|关闭|確定|好)$/i.test(bt)) {
                    b.click();
                    return { status: 'done_modal' };
                  }
                }
                return { status: 'done_toast' };
              }
            }

            return { status: isImporting ? 'importing' : 'idle' };
          })()
        `);

        if (uiState.status === 'error') {
          throw new Error(uiState.message.replace(/\s+/g, ' ').trim());
        }
        if (uiState.status === 'importing') {
          sawImportingUi = true;
        }
        if (uiState.status === 'done_modal' || uiState.status === 'done_toast') {
          await sleep(800);
          return { importedKey: null };
        }

        // 3. 每隔 3 秒通过 Figma 文件夹 API 校验是否已出现新导入的文件（最权威的结果验证）
        if (
          destination.folderId &&
          !uiState.status.includes('importing') &&
          Date.now() - lastFolderPoll >= 3000 &&
          Date.now() - startTime >= 2500
        ) {
          lastFolderPoll = Date.now();
          const currentFiles = await this.scanner.fetchFolderFiles(
            destination.folderId,
            destination.teamId || 'drafts',
            destination.teamName || 'Drafts',
            destination.folderName || 'Drafts',
            Boolean(destination.isDrafts)
          );

          const expectedLower = (file.title || inferFigmaTitleFromPath(file.localPath))
            .trim()
            .toLowerCase();

          const newFile = currentFiles.find((f) => {
            if (existingKeys && existingKeys.has(f.key)) return false;
            return true;
          });

          if (newFile) {
            // 如果找到了新文件（优先确认名称匹配或已有上传活动），再短暂等待确保云端处理落盘
            const nameMatches = newFile.name.trim().toLowerCase().includes(expectedLower) ||
              expectedLower.includes(newFile.name.trim().toLowerCase());
            if (nameMatches || sawUploadActivity || sawImportingUi) {
              await sleep(600);
              return { importedKey: newFile.key, importedName: newFile.name };
            }
          }
        }
      }

      throw new Error(
        `导入等待超时 (${timeoutSec} 秒)，若文件较大可调大超时时间，或取消勾选「后台静默导入」观察页面提示`
      );
    } finally {
      dbg.removeListener('message', onDebuggerMessage);
      if (dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {
          // ignore
        }
      }
      this.activeImportWindow = null;
      if (!win.isDestroyed()) {
        win.destroy();
      }
    }
  }

  /**
   * 批量导入本地文件列表到 Figma
   * targetConfig:
   *   - mode: 'drafts' | 'folder' | 'structure'
   *   - teamId?: string
   *   - teamName?: string
   *   - folderId?: string
   *   - folderName?: string
   */
  async importFiles({
    files,
    targetConfig,
    skipExisting = true,
    silentImport = true,
    timeoutSec = 240,
    delayBetweenFilesMs = 1200,
  }) {
    if (this.isRunning) {
      throw new Error('当前已有导入任务正在运行中');
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('请先选择至少一个要导入的本地设计文件');
    }

    const mode = targetConfig?.mode || 'drafts';
    if (mode === 'folder' && (!targetConfig.teamId || !targetConfig.folderId)) {
      throw new Error('请选择要导入的目标团队与文件夹');
    }
    if (mode === 'structure' && !targetConfig.teamId) {
      throw new Error('按目录结构导入时，请先选择目标团队');
    }

    this.isRunning = true;
    this.stopRequested = false;

    let auth;
    try {
      auth = await this.browser.checkAuthStatus();
      if (!auth.authenticated) {
        throw new Error('Figma 尚未登录，请先点击右上角「登录 Figma」完成登录');
      }
    } catch (err) {
      this.isRunning = false;
      throw err;
    }

    const stats = {
      total: files.length,
      completed: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      startedAt: Date.now(),
      currentFile: null,
    };
    this.currentStats = stats;

    this.onLog(
      'info',
      `开始批量导入（${silentImport ? '后台静默模式' : '可视化窗口模式'}），共 ${files.length} 个本地文件`
    );
    this.onProgress({ type: 'import_start', stats });

    // 缓存每个目标文件夹下已有的文件集合（用于防重复跳过与新文件检测）
    const folderStateCache = new Map();
    // 缓存目标团队下的文件夹列表（用于 mode === 'structure' 自动匹配/创建文件夹）
    let teamFoldersCache = null;

    const getFolderState = async (dest) => {
      const cacheKey = dest.isDrafts ? `drafts:${dest.folderId || 'default'}` : `folder:${dest.folderId}`;
      if (folderStateCache.has(cacheKey)) {
        return folderStateCache.get(cacheKey);
      }
      const existingKeys = new Set();
      const existingNames = new Set();
      if (dest.folderId) {
        const list = await this.scanner.fetchFolderFiles(
          dest.folderId,
          dest.teamId || 'drafts',
          dest.teamName || 'Drafts',
          dest.folderName || 'Drafts',
          Boolean(dest.isDrafts)
        );
        for (const f of list) {
          existingKeys.add(f.key);
          existingNames.add(f.name.trim().toLowerCase());
        }
      }
      const entry = { existingKeys, existingNames };
      folderStateCache.set(cacheKey, entry);
      return entry;
    };

    const resolveDestinationForFile = async (file) => {
      if (mode === 'drafts') {
        return {
          isDrafts: true,
          teamId: null,
          teamName: '个人草稿箱 (Drafts)',
          folderId: auth.user.draftsFolderId || null,
          folderName: 'Drafts',
        };
      }

      if (mode === 'folder') {
        return {
          isDrafts: false,
          teamId: String(targetConfig.teamId),
          teamName: targetConfig.teamName || '指定团队',
          folderId: String(targetConfig.folderId),
          folderName: targetConfig.folderName || '指定文件夹',
        };
      }

      // mode === 'structure'：按本地子目录名在目标团队下匹配或自动新建同名文件夹
      const desiredFolderName = (file.suggestedFolder || 'Imported').trim();
      if (!teamFoldersCache) {
        teamFoldersCache = await this.scanner.fetchTeamFolders(targetConfig.teamId);
      }

      let matched = teamFoldersCache.find(
        (f) => f.name.trim().toLowerCase() === desiredFolderName.toLowerCase()
      );
      if (!matched) {
        matched = await this.scanner.createFolder(targetConfig.teamId, desiredFolderName);
        teamFoldersCache.push(matched);
      }

      return {
        isDrafts: false,
        teamId: String(targetConfig.teamId),
        teamName: targetConfig.teamName || '目标团队',
        folderId: String(matched.id),
        folderName: matched.name,
      };
    };

    try {
      for (let i = 0; i < files.length; i++) {
        if (this.stopRequested) {
          this.onLog('warn', `导入已停止（已处理 ${stats.completed}/${stats.total}）`);
          break;
        }

        const file = files[i];
        stats.currentFile = {
          index: i + 1,
          id: file.id,
          name: file.fileName,
          suggestedFolder: file.suggestedFolder,
        };

        try {
          const destination = await resolveDestinationForFile(file);
          const folderState = await getFolderState(destination);
          const expectedTitle = (file.title || inferFigmaTitleFromPath(file.localPath)).trim();

          if (skipExisting && folderState.existingNames.has(expectedTitle.toLowerCase())) {
            stats.skipped += 1;
            stats.completed += 1;
            this.onLog(
              'skip',
              `[${i + 1}/${files.length}] 跳过同名已存在文件: ${destination.teamName} / ${destination.folderName} / ${expectedTitle}`
            );
            this.onProgress({
              type: 'file_done',
              fileId: file.id,
              status: 'skipped',
              destinationLabel: `${destination.teamName} / ${destination.folderName}`,
              stats,
            });
            continue;
          }

          this.onLog(
            'info',
            `[${i + 1}/${files.length}] 正在导入: ${file.fileName} → ${destination.teamName} / ${destination.folderName}`
          );
          this.onProgress({
            type: 'file_start',
            fileId: file.id,
            destinationLabel: `${destination.teamName} / ${destination.folderName}`,
            stats,
          });

          const res = await this.importSingleFile(file, destination, folderState.existingKeys, {
            timeoutSec,
            silentImport,
          });

          if (res.importedKey) {
            folderState.existingKeys.add(res.importedKey);
          }
          folderState.existingNames.add(expectedTitle.toLowerCase());

          stats.imported += 1;
          stats.completed += 1;
          this.onLog(
            'success',
            `  ✓ 导入成功: ${file.fileName} → ${destination.teamName} / ${destination.folderName}`
          );
          this.onProgress({
            type: 'file_done',
            fileId: file.id,
            status: 'imported',
            importedKey: res.importedKey || null,
            destinationLabel: `${destination.teamName} / ${destination.folderName}`,
            stats,
          });
        } catch (err) {
          if (err.message === 'USER_STOPPED') {
            this.onLog('warn', `导入已被用户中断: ${file.fileName}`);
            break;
          }

          stats.failed += 1;
          stats.completed += 1;
          this.onLog('error', `  ✗ 导入失败 [${file.fileName}]: ${err.message}`);
          this.onProgress({
            type: 'file_done',
            fileId: file.id,
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
        type: 'import_finish',
        stopped: this.stopRequested,
        stats,
      });
      this.onLog(
        stats.failed > 0 ? 'warn' : 'success',
        `导入任务结束：成功 ${stats.imported}，跳过 ${stats.skipped}，失败 ${stats.failed}（总计 ${stats.total}）`
      );
      this.stopRequested = false;
    }

    return stats;
  }
}

module.exports = { ElectronFigmaImporter };
