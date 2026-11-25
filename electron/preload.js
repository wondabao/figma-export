const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('figmaExporter', {
  getState: () => ipcRenderer.invoke('state:get'),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  scan: (opts) => ipcRenderer.invoke('scan:start', opts),
  addTeam: (input) => ipcRenderer.invoke('teams:add', input),
  removeTeam: (teamId) => ipcRenderer.invoke('teams:remove', teamId),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseDir: () => ipcRenderer.invoke('dialog:choose-dir'),
  openFolder: (dir) => ipcRenderer.invoke('shell:open-folder', dir),

  // 批量导出
  startExport: (opts) => ipcRenderer.invoke('export:start', opts),
  stopExport: () => ipcRenderer.invoke('export:stop'),

  // 批量导入
  pickImportFiles: () => ipcRenderer.invoke('import:pick-files'),
  pickImportFolder: () => ipcRenderer.invoke('import:pick-folder'),
  addImportPaths: (paths) => ipcRenderer.invoke('import:add-paths', paths),
  removeImportItems: (ids) => ipcRenderer.invoke('import:remove-items', ids),
  clearImportQueue: () => ipcRenderer.invoke('import:clear'),
  loadImportTargets: () => ipcRenderer.invoke('import:targets'),
  createFigmaFolder: (opts) => ipcRenderer.invoke('import:create-folder', opts),
  startImport: (opts) => ipcRenderer.invoke('import:start', opts),
  stopImport: () => ipcRenderer.invoke('import:stop'),
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // 实时事件订阅
  onLog: (cb) => ipcRenderer.on('event:log', (_e, data) => cb(data)),
  onAuthUpdate: (cb) => ipcRenderer.on('event:auth_update', (_e, data) => cb(data)),
  onScanProgress: (cb) => ipcRenderer.on('event:scan_progress', (_e, data) => cb(data)),
  onExportProgress: (cb) => ipcRenderer.on('event:export_progress', (_e, data) => cb(data)),
  onImportProgress: (cb) => ipcRenderer.on('event:import_progress', (_e, data) => cb(data)),
});
