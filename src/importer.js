const { inferFigmaTitleFromPath, sleep } = require('./utils');

class FigmaImporter {
  constructor(browserManager, scanner, onLog = () => {}, onProgress = () => {}) {
    this.browser = browserManager;
    this.scanner = scanner;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.isRunning = false;
    this.stopRequested = false;
    this.currentStats = null;
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

  async importSingleFile() {
    throw new Error('importSingleFile must be implemented by platform runtime');
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

    const folderStateCache = new Map();
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

module.exports = { FigmaImporter };
