const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { ElectronFigmaBrowser } = require('../src/electronBrowser');
const { ElectronFigmaExporter } = require('../src/electronExporter');
const { ElectronFigmaImporter } = require('../src/electronImporter');
const { createAppController } = require('../src/appController');
const { ensureDir, loadManifest, saveManifest, collectLocalImportFiles } = require('../src/utils');

let mainWindow = null;
const configPath = () => path.join(app.getPath('userData'), 'exporter-config.json');
const controller = createAppController({
  app, ipcMain, dialog, shell, path,
  Browser: ElectronFigmaBrowser,
  Exporter: ElectronFigmaExporter,
  Importer: ElectronFigmaImporter,
  platform: process.platform,
  getMainWindow: () => mainWindow,
  sendToRenderer: (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
  },
  storage: {
    ensureDir, loadManifest, saveManifest, collectLocalImportFiles, exists: fs.existsSync,
    loadConfig: () => {
      try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
    },
    saveConfig: config => {
      ensureDir(path.dirname(configPath()));
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
    },
  },
});

function createMainWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 920,
    minHeight: 600,
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

app.whenReady().then(async () => {
  await controller.start();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('before-quit', () => {
  controller.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
