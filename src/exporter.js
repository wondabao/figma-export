const path = require('path');
const {
  computeDuplicateNameKeys,
  buildTargetFilePath,
  getUrlPrefixForEditorType,
  sleep,
} = require('./utils');

class FigmaExporter {
  constructor(
    browserManager,
    onLog = () => {},
    onProgress = () => {},
    storage = {
      ensureDir: async () => {},
      loadManifest: async () => ({ files: {} }),
      saveManifest: async () => {},
      exists: async () => false,
    }
  ) {
    this.browser = browserManager;
    this.onLog = onLog;
    this.onProgress = onProgress;
    this.storage = storage;
    this.isRunning = false;
    this.stopRequested = false;
    this.currentStats = null;
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

  async exportSingleFile() {
    throw new Error('exportSingleFile must be implemented by platform runtime');
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
              (prev && prev.localPath && (await this.storage.exists(prev.localPath))) ||
              (await this.storage.exists(targetPath));

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

module.exports = { FigmaExporter };
