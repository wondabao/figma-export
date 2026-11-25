const { BrowserWindow, session } = require('electron');
const { sleep } = require('./utils');

const FIGMA_PARTITION = 'persist:figma';

function buildCleanChromeUserAgent(rawUa) {
  // 去掉 Electron/x.y.z 和应用名，避免 Google SSO / Figma 拦截登录
  const cleaned = (rawUa || '')
    .replace(/\s*Electron\/[^\s]+/gi, '')
    .replace(/\s*figma-(?:export|bulk-exporter)\/[^\s]+/gi, '')
    .trim();
  return (
    cleaned ||
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36'
  );
}

class ElectronFigmaBrowser {
  constructor(onLog = () => {}, onAuthUpdate = () => {}) {
    this.onLog = onLog;
    this.onAuthUpdate = onAuthUpdate;
    this.apiWindow = null;
    this.loginWindow = null;
    this.user = null;
    this.pollTimer = null;
  }

  getSession() {
    const ses = session.fromPartition(FIGMA_PARTITION);
    const cleanUa = buildCleanChromeUserAgent(ses.getUserAgent());
    ses.setUserAgent(cleanUa);
    return ses;
  }

  getCleanUserAgent() {
    return this.getSession().getUserAgent();
  }

  /**
   * 确保存在一个隐藏的后台 Figma 页面，用于执行同源 Web API 请求
   */
  async ensureApiWindow(targetUrl = 'https://www.figma.com/files/recents-and-sharing') {
    const ses = this.getSession();

    if (!this.apiWindow || this.apiWindow.isDestroyed()) {
      this.apiWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        show: false,
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });
      this.apiWindow.webContents.setUserAgent(this.getCleanUserAgent());
      this.apiWindow.on('closed', () => {
        this.apiWindow = null;
      });
    }

    const currentUrl = this.apiWindow.webContents.getURL();
    if (!currentUrl || !currentUrl.startsWith('https://www.figma.com')) {
      await this.apiWindow.loadURL(targetUrl, {
        userAgent: this.getCleanUserAgent(),
      });
    }
    return this.apiWindow;
  }

  /**
   * 获取当前可用于同源 API 请求的 Figma 窗口（优先复用已打开且在 figma.com 的登录窗口）
   */
  async getActiveFigmaWindow(targetUrl = 'https://www.figma.com/files/recents-and-sharing') {
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      const loginUrl = this.loginWindow.webContents.getURL() || '';
      if (loginUrl.startsWith('https://www.figma.com') && !loginUrl.includes('/login')) {
        return this.loginWindow;
      }
    }
    return await this.ensureApiWindow(targetUrl);
  }

  /**
   * 在已登录的 Figma 页面中，以当前账号发出同源 JSON 请求。
   */
  async fetchFigmaJson(apiPath) {
    const origin = 'https://www.figma.com';
    const url = new URL(apiPath, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) {
      return { ok: false, status: 0, error: '无效的 Figma API 地址' };
    }

    const cachedUserId = this.user?.id === 'current' ? null : this.user?.id ?? null;
    const script = `
      (async () => {
        try {
          const userId = window.INITIAL_OPTIONS?.user_data?.id ||
            ${JSON.stringify(cachedUserId)};
          const res = await fetch(${JSON.stringify(url.href)}, {
            method: 'GET',
            mode: 'same-origin',
            credentials: 'same-origin',
            headers: {
              'Accept': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              ...(userId ? { 'X-Figma-User-ID': String(userId) } : {})
            }
          });
          const text = await res.text();
          let data = null;
          try { data = JSON.parse(text); } catch {}
          return { ok: res.ok, status: res.status, data, rawSnippet: data ? null : text.slice(0, 200) };
        } catch (err) {
          return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
        }
      })()
    `;
    try {
      const win = await this.getActiveFigmaWindow();
      return await win.webContents.executeJavaScript(script, true);
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  /**
   * 在已登录的 Figma 页面同源上下文中发送写操作请求（如新建文件夹 POST /api/folders）
   */
  async mutateFigmaJson(apiPath, method = 'POST', payload = {}) {
    const origin = 'https://www.figma.com';
    const url = new URL(apiPath, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) {
      return { ok: false, status: 0, error: '无效的 Figma API 地址' };
    }

    const cachedUserId = this.user?.id === 'current' ? null : this.user?.id ?? null;
    const script = `
      (async () => {
        try {
          const userId = window.INITIAL_OPTIONS?.user_data?.id ||
            ${JSON.stringify(cachedUserId)};
          const res = await fetch(${JSON.stringify(url.href)}, {
            method: ${JSON.stringify(method)},
            mode: 'same-origin',
            credentials: 'same-origin',
            headers: {
              'Accept': 'application/json',
              'Content-Type': 'application/json',
              'X-Requested-With': 'XMLHttpRequest',
              ...(userId ? { 'X-Figma-User-ID': String(userId) } : {})
            },
            body: JSON.stringify(${JSON.stringify(payload)})
          });
          const text = await res.text();
          let data = null;
          try { data = JSON.parse(text); } catch {}
          return { ok: res.ok, status: res.status, data, rawSnippet: data ? null : text.slice(0, 200) };
        } catch (err) {
          return { ok: false, status: 0, error: err && err.message ? err.message : String(err) };
        }
      })()
    `;
    try {
      const win = await this.getActiveFigmaWindow();
      return await win.webContents.executeJavaScript(script, true);
    } catch (err) {
      return { ok: false, status: 0, error: err.message };
    }
  }

  /**
   * 尝试直接从已加载的 Figma /files 页面的 window.INITIAL_OPTIONS 提取用户信息
   */
  async extractUserFromWindow(win) {
    if (!win || win.isDestroyed()) return null;
    try {
      const user = await win.webContents.executeJavaScript(`
        (() => {
          const opts = window.INITIAL_OPTIONS || {};
          const u = opts.user_data || (opts.initial_state && opts.initial_state.user) || null;
          if (u && (u.id || u.email || u.handle)) {
            return {
              id: String(u.id || ''),
              name: u.handle || u.name || u.email || 'Figma User',
              email: u.email || '',
              imgUrl: u.img_url || '',
              draftsFolderId: u.drafts_folder_id ? String(u.drafts_folder_id) : null
            };
          }
          return null;
        })()
      `);
      return user;
    } catch {
      return null;
    }
  }

  /**
   * 从 Figma 侧边栏 DOM 额外提取团队 ID（作为 API 发现的补充）
   */
  async discoverTeamsFromSidebarDom() {
    try {
      const win = await this.ensureApiWindow('https://www.figma.com/files/recents-and-sharing');
      await sleep(1200);
      const domTeams = await win.webContents.executeJavaScript(`
        (() => {
          const found = [];
          const links = document.querySelectorAll('a[href*="/files/team/"], a[href*="/team/"]');
          for (const a of links) {
            const href = a.getAttribute('href') || '';
            const m = href.match(/\\/team\\/(\\d+)/);
            if (m) {
              const name = (a.textContent || '').trim();
              found.push({ id: m[1], name: name || ('Team ' + m[1]) });
            }
          }
          return found;
        })()
      `);
      return Array.isArray(domTeams) ? domTeams : [];
    } catch {
      return [];
    }
  }

  /**
   * 检查当前内置会话是否已登录 Figma
   */
  async checkAuthStatus() {
    try {
      const ses = this.getSession();
      const cookies = await ses.cookies.get({ domain: 'figma.com' });
      const hasAuthCookie =
        cookies &&
        cookies.some((c) => /authn|session/i.test(c.name) && c.value && c.value.length > 5);

      if (!cookies || cookies.length === 0) {
        this.user = null;
        return { authenticated: false, user: null };
      }

      const win = await this.getActiveFigmaWindow();

      // 1. 优先尝试 /api/session/state（包含 user + teams + orgs）
      const res = await this.fetchFigmaJson('/api/session/state');
      if (res.ok && res.data && res.data.meta && res.data.meta.user) {
        const u = res.data.meta.user;
        this.user = {
          id: String(u.id),
          name: u.handle || u.name || u.email || 'Figma User',
          email: u.email || '',
          imgUrl: u.img_url || '',
          draftsFolderId: u.drafts_folder_id ? String(u.drafts_folder_id) : null,
        };
        return {
          authenticated: true,
          user: this.user,
          sessionMeta: res.data.meta,
        };
      }

      // 2. 备用接口 /api/user/state
      const fallback = await this.fetchFigmaJson('/api/user/state?redact=org_billing_data');
      const fallbackMeta = fallback.ok ? fallback.data?.meta : null;
      const fallbackUser = fallbackMeta?.user || fallbackMeta;
      if (fallbackUser?.id) {
        const u = fallbackUser;
        this.user = {
          id: String(u.id),
          name: u.handle || u.name || u.email || 'Figma User',
          email: u.email || '',
          imgUrl: u.img_url || '',
          draftsFolderId: u.drafts_folder_id ? String(u.drafts_folder_id) : null,
        };
        return { authenticated: true, user: this.user, sessionMeta: fallbackMeta };
      }

      // 3. 直接从 Figma 页面全局变量 window.INITIAL_OPTIONS 提取用户信息
      const pageUser = await this.extractUserFromWindow(win);
      if (pageUser) {
        this.user = pageUser;
        return { authenticated: true, user: this.user };
      }

      // 4. 兜底：若页面已跳转到 /files 且存在登录 Cookie
      const currentUrl = (win && !win.isDestroyed() && win.webContents.getURL()) || '';
      if (hasAuthCookie && currentUrl.startsWith('https://www.figma.com/files')) {
        this.user = {
          id: 'current',
          name: 'Figma 已登录账号',
          email: '',
          imgUrl: '',
          draftsFolderId: null,
        };
        return { authenticated: true, user: this.user };
      }

      this.user = null;
      return { authenticated: false, user: null };
    } catch (err) {
      this.onLog('warn', `检测登录状态时出错: ${err.message}`);
      return { authenticated: false, user: null, error: err.message };
    }
  }

  /**
   * 打开应用内嵌的 Figma 登录窗口（不依赖任何外部浏览器），登录成功后自动关闭窗口
   */
  async openLoginWindow(parentWindow = null) {
    // 先检查是否其实已经登录
    const existing = await this.checkAuthStatus();
    if (existing.authenticated) {
      this.onLog('success', `已登录账号: ${existing.user.name}${existing.user.email ? ' (' + existing.user.email + ')' : ''}`);
      this.onAuthUpdate({ authenticated: true, user: existing.user });
      return existing;
    }

    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.focus();
      return existing;
    }

    const ses = this.getSession();
    this.loginWindow = new BrowserWindow({
      width: 540,
      height: 740,
      title: '登录 Figma 账号',
      parent: parentWindow || undefined,
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    const cleanUa = this.getCleanUserAgent();
    this.loginWindow.webContents.setUserAgent(cleanUa);

    // 允许 Google SSO 等 OAuth 弹窗在同一 session 下正常打开
    this.loginWindow.webContents.setWindowOpenHandler(() => {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          autoHideMenuBar: true,
          webPreferences: {
            session: ses,
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      };
    });

    let checkingLogin = false;
    const tryFinishLogin = async () => {
      if (checkingLogin || !this.loginWindow || this.loginWindow.isDestroyed()) return;
      const url = this.loginWindow.webContents.getURL() || '';
      if (!url.startsWith('https://www.figma.com/files')) return;

      checkingLogin = true;
      try {
        const status = await this.checkAuthStatus();
        if (status.authenticated) {
          if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
          this.onLog(
            'success',
            `登录成功！当前账号: ${status.user.name}${status.user.email ? ' (' + status.user.email + ')' : ''}`
          );
          this.onAuthUpdate({ authenticated: true, user: status.user });
          if (this.loginWindow && !this.loginWindow.isDestroyed()) {
            this.loginWindow.close();
          }
        }
      } finally {
        checkingLogin = false;
      }
    };

    this.loginWindow.webContents.on('did-navigate', () => {
      setTimeout(tryFinishLogin, 600);
    });
    this.loginWindow.webContents.on('did-navigate-in-page', () => {
      setTimeout(tryFinishLogin, 600);
    });

    this.loginWindow.on('closed', () => {
      this.loginWindow = null;
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    });

    await this.loginWindow.loadURL('https://www.figma.com/login', {
      userAgent: cleanUa,
    });
    this.onLog('info', '请在软件内弹出的登录窗口中登录您的 Figma 账号，登录完成后将自动关闭窗口...');

    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(tryFinishLogin, 1200);

    return existing;
  }

  /**
   * 清除内置会话缓存（切换账号）
   */
  async logoutAndResetProfile() {
    this.closeWindows();
    const ses = this.getSession();
    await ses.clearStorageData();
    await ses.clearCache();
    this.user = null;
    this.onLog('info', '已退出当前 Figma 账号并清除本地登录缓存');
    this.onAuthUpdate({ authenticated: false, user: null });
  }

  closeWindows() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.loginWindow && !this.loginWindow.isDestroyed()) {
      this.loginWindow.close();
      this.loginWindow = null;
    }
    if (this.apiWindow && !this.apiWindow.isDestroyed()) {
      this.apiWindow.close();
      this.apiWindow = null;
    }
  }
}

module.exports = { ElectronFigmaBrowser, FIGMA_PARTITION };
