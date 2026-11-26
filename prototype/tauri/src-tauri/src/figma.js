async function figmaAction(action, args) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const origin = 'https://www.figma.com';
  if (location.origin !== origin) throw Error('Figma 页面已离开预期地址。');

  function formatUser(u) {
    if (!u || (!u.id && !u.email && !u.handle)) return null;
    return {
      id: String(u.id || 'current'),
      name: u.handle || u.name || u.email || 'Figma User',
      email: u.email || '',
      imgUrl: u.img_url || '',
      draftsFolderId: u.drafts_folder_id ? String(u.drafts_folder_id) : null,
    };
  }

  async function figmaFetch(path, { method = 'GET', payload, userId, timeoutMs = 25000 } = {}) {
    const url = new URL(path, origin);
    if (url.origin !== origin || !url.pathname.startsWith('/api/')) {
      return { ok: false, status: 0, error: '无效的 Figma API 地址' };
    }
    const pageUser = window.INITIAL_OPTIONS?.user_data || window.INITIAL_OPTIONS?.initial_state?.user;
    const resolvedUid =
      userId && userId !== 'current'
        ? String(userId)
        : pageUser?.id
          ? String(pageUser.id)
          : null;

    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
    };
    if (payload !== undefined) headers['Content-Type'] = 'application/json';
    if (resolvedUid) headers['X-Figma-User-ID'] = resolvedUid;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url.href, {
        method,
        mode: 'same-origin',
        credentials: 'same-origin',
        headers,
        body: payload !== undefined ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return {
        ok: response.ok,
        status: response.status,
        data,
        rawSnippet: data ? null : text.slice(0, 200),
      };
    } catch (err) {
      return {
        ok: false,
        status: 0,
        error: err && err.message ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkAuth() {
    if (/^\/(?:login|signup|oauth|sso|password)(?:\/|$)/i.test(location.pathname)) {
      return { authenticated: false, user: null };
    }
    const pageUser = window.INITIAL_OPTIONS?.user_data || window.INITIAL_OPTIONS?.initial_state?.user;

    const sessionRes = await figmaFetch('/api/session/state', { userId: pageUser?.id, timeoutMs: 12000 });
    if (sessionRes.ok && sessionRes.data?.meta?.user) {
      const user = formatUser(sessionRes.data.meta.user);
      if (user) {
        return { authenticated: true, user, sessionMeta: sessionRes.data.meta };
      }
    }

    const stateRes = await figmaFetch('/api/user/state?redact=org_billing_data', {
      userId: pageUser?.id,
      timeoutMs: 12000,
    });
    const fallbackMeta = stateRes.ok ? stateRes.data?.meta : null;
    const fallbackRaw = fallbackMeta?.user || (fallbackMeta?.id ? fallbackMeta : null);
    if (fallbackRaw) {
      const user = formatUser(fallbackRaw);
      if (user) {
        return { authenticated: true, user, sessionMeta: fallbackMeta };
      }
    }

    const formattedPageUser = formatUser(pageUser);
    if (formattedPageUser) {
      return { authenticated: true, user: formattedPageUser };
    }

    return { authenticated: false, user: null };
  }

  function discoverTeams() {
    const found = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/files/team/"], a[href*="/team/"]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/team\/(\d+)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        const name = (a.textContent || '').trim();
        found.push({ id: m[1], name: name || `Team ${m[1]}` });
      }
    }
    return found;
  }

  function findVisibleControl(selector, labelRegex) {
    let disabledMatch = null;
    for (const el of document.querySelectorAll(selector)) {
      if (el.closest('[hidden], [aria-hidden="true"], [inert], [data-fpl-hidden="true"]')) continue;
      if (getComputedStyle(el).visibility !== 'visible') continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;

      if (labelRegex) {
        const texts = [
          el.getAttribute('aria-label'),
          el.getAttribute('data-tooltip'),
          el.innerText || el.textContent,
        ];
        if (!texts.some(t => labelRegex.test((t || '').trim()))) continue;
      }

      if (el.closest('[disabled], [aria-disabled="true"]') || /disabled/i.test(el.className || '')) {
        disabledMatch ??= { el, disabled: true };
        continue;
      }
      return { el, disabled: false };
    }
    return disabledMatch;
  }

  async function waitForControl(selector, labelRegex, limitMs) {
    const end = Date.now() + limitMs;
    while (Date.now() < end) {
      const found = findVisibleControl(selector, labelRegex);
      if (found) return found;
      await delay(130);
    }
    return null;
  }

  function dispatchClick(el) {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerType: 'mouse', isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function editorState() {
    const pathname = window.location.pathname || '';
    if (/^(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/(?:community|communaute|comunidad)(?:\/|$)/i.test(pathname)) {
      return { status: 'community_page' };
    }
    if (/^\/(?:login|signup)(?:\/|$)/.test(pathname)) {
      return { status: 'login_required' };
    }
    const bodyText = (document.body && document.body.innerText) || '';
    if (
      /File not found|404|Request access|You don't have access|找不到文件|请求访问权限/i.test(bodyText) &&
      !document.querySelector('canvas')
    ) {
      return { status: 'no_access', snippet: bodyText.slice(0, 120) };
    }

    const mainMenuSel = [
      '[data-testid="toggle-menu-button"]',
      '[aria-label="Main menu" i]',
      '[aria-label="主菜单"]',
      '[aria-label="主選單"]',
      'button[data-tooltip="main-menu"]',
      '[data-testid="filename"]',
      '[class*="toolbar"]',
    ].join(', ');

    const hasCanvas = Boolean(document.querySelector('canvas'));
    const hasMenu = Boolean(document.querySelector(mainMenuSel));
    const loadingBar = document.querySelector('[class*="progress_bar"], [data-testid="loading-screen"]');

    if (hasCanvas && hasMenu && !loadingBar) {
      return { status: 'ready' };
    }
    return { status: 'loading', hasCanvas };
  }

  async function triggerExport() {
    const mainMenuSel = [
      '[data-testid="toggle-menu-button"]',
      '[aria-label="Main menu" i]',
      '[aria-label="主菜单"]',
      '[aria-label="主選單"]',
      'button[data-tooltip="main-menu"]',
    ].join(', ');
    const menuItemsSel = '[role="menuitem"], [data-testid^="dropdown-option-"]';
    const fileLabel = /^(?:File|文件|檔案)$/i;
    const saveLabel = /^(?:Save\s+local\s+copy|保存本地(?:副本|拷贝)|儲存本[機地]副本)(?=$|[\s.…(（])/i;

    // 策略 1：主菜单 -> File / 文件 -> Save local copy / 保存本地副本
    const menuCtrl = await waitForControl(mainMenuSel, null, 4000);
    let menuOutcome = 'menu_missing';

    if (menuCtrl && !menuCtrl.disabled) {
      dispatchClick(menuCtrl.el);
      const fileCtrl = await waitForControl(menuItemsSel, fileLabel, 2500);
      if (fileCtrl && !fileCtrl.disabled) {
        dispatchClick(fileCtrl.el);
        const saveCtrl = await waitForControl(menuItemsSel, saveLabel, 3000);
        if (saveCtrl) {
          if (saveCtrl.disabled) return { status: 'disabled' };
          dispatchClick(saveCtrl.el);
          return { status: 'clicked' };
        }
        menuOutcome = 'save_missing';
      } else {
        menuOutcome = 'file_menu_missing';
      }
    }

    // 策略 2：通过快捷命令面板 (Quick Actions: Cmd/Ctrl + K 或 /) 搜索保存本地副本
    const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
    const shortcuts = [
      { key: 'k', code: 'KeyK', keyCode: 75 },
      { key: '/', code: 'Slash', keyCode: 191 },
      { key: 'p', code: 'KeyP', keyCode: 80 },
    ];
    const actionsInputSel = [
      'input[data-testid="quick-actions-search-input"]',
      '[data-testid="quick-actions"] input',
      '[data-testid="quick-actions-v2"] input',
      '[class*="quick_actions"] input',
      'input[placeholder*="Search" i]',
      'input[placeholder*="搜索"]',
    ].join(', ');
    const actionsResultsSel = [
      '[role="option"]',
      menuItemsSel,
      '[data-testid="quick-actions-v2"] button',
      '[data-testid="quick-actions"] [tabindex]',
      '[class*="quick_actions"] div',
    ].join(', ');

    for (const sc of shortcuts) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
      await delay(120);
      const kbInit = {
        key: sc.key,
        code: sc.code,
        keyCode: sc.keyCode,
        which: sc.keyCode,
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      };
      window.dispatchEvent(new KeyboardEvent('keydown', kbInit));
      document.dispatchEvent(new KeyboardEvent('keydown', kbInit));

      const inputCtrl = await waitForControl(actionsInputSel, null, 1000);
      if (!inputCtrl || inputCtrl.disabled) continue;

      const inputEl = inputCtrl.el;
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

      for (const query of ['Save local copy', '保存本地副本', '儲存本機副本']) {
        inputEl.focus();
        if (nativeSetter) nativeSetter.call(inputEl, query);
        else inputEl.value = query;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

        const resultCtrl = await waitForControl(actionsResultsSel, saveLabel, 1000);
        if (!resultCtrl) continue;
        if (resultCtrl.disabled) return { status: 'disabled' };
        dispatchClick(resultCtrl.el);
        return { status: 'clicked' };
      }
      break;
    }

    return { status: menuOutcome };
  }

  function browserState() {
    const pathname = window.location.pathname || '';
    if (/^\/(?:login|signup)(?:\/|$)/.test(pathname)) {
      return { status: 'login_required' };
    }
    const bodyText = (document.body && document.body.innerText) || '';
    if (
      /Page not found|404|You don't have access|Request access|无权访问|请求访问权限/i.test(bodyText) &&
      !document.querySelector('input[type="file"]')
    ) {
      return { status: 'no_access', snippet: bodyText.slice(0, 120) };
    }
    const hasFileInput = Boolean(document.querySelector('input[type="file"]'));
    const hasImportBtn = Array.from(
      document.querySelectorAll('button, [role="button"], [data-testid*="import" i]')
    ).some(b => {
      const txt = (b.getAttribute('aria-label') || b.innerText || b.textContent || '').trim();
      return /^(?:\+\s*)?(?:Import|导入|匯入)/i.test(txt) || /import/i.test(b.getAttribute('data-testid') || '');
    });
    const hasBrowserShell = Boolean(
      document.querySelector('[data-testid*="file-browser" i], [class*="file_browser" i], main, nav')
    );

    if (hasFileInput || hasImportBtn || (hasBrowserShell && bodyText.length > 40)) {
      return { status: 'ready', hasFileInput, hasImportBtn };
    }
    return { status: 'loading' };
  }

  function findImportFileInput() {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]:not([disabled])'));
    return (
      inputs.find(inp => /(?:\.fig\b|\.jam\b|\.deck\b|\.sketch\b)/i.test(inp.accept || '')) ||
      inputs.find(inp => !inp.accept || inp.accept === '*/*') ||
      inputs[inputs.length - 1] ||
      null
    );
  }

  async function submitUpload(payload) {
    const fileName = String(payload?.fileName || 'Import.fig');
    const chunks = globalThis.__figmaExportUpload;
    delete globalThis.__figmaExportUpload;
    if (!Array.isArray(chunks) || chunks.length === 0) {
      throw Error('待导入文件内容未完整载入内存。');
    }

    // 等待页面 document.body 稳定挂载
    const waitEnd = Date.now() + 8000;
    while (Date.now() < waitEnd && (!document.body || document.readyState !== 'complete')) {
      await delay(150);
    }
    if (!document.body) {
      throw Error('Figma 目标页面尚未完成加载，请重试。');
    }

    const fileObj = new File(chunks, fileName, { type: 'application/octet-stream' });
    const transfer = new DataTransfer();
    transfer.items.add(fileObj);

    // 1. 先检查 DOM 中是否已有现成的 <input type="file">
    let input = findImportFileInput();
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 'dom_file_input';
    }

    // 2. 拦截脱离 DOM 的动态 input.click() 及 showOpenFilePicker（阻止弹出系统文件框并直接喂入文件）
    let interceptedInput = null;
    let pickerIntercepted = false;
    const origInputClick = HTMLInputElement.prototype.click;
    const origShowOpenFilePicker = window.showOpenFilePicker;

    HTMLInputElement.prototype.click = function (...clickArgs) {
      if (this && this.type === 'file') {
        interceptedInput = this;
        return;
      }
      return origInputClick.apply(this, clickArgs);
    };

    if (typeof origShowOpenFilePicker === 'function') {
      window.showOpenFilePicker = async () => {
        pickerIntercepted = true;
        return [
          {
            kind: 'file',
            name: fileName,
            getFile: async () => fileObj,
          },
        ];
      };
    }

    try {
      const importBtn =
        findVisibleControl('[data-testid*="import" i]', null) ||
        findVisibleControl(
          'button, [role="button"], [aria-label*="Import" i], [aria-label*="导入"], [data-tooltip*="import" i]',
          /^(?:\+\s*)?(?:Import(?:\s+files?)?|导入(?:文件)?|匯入(?:檔案)?)$/i
        );

      if (importBtn) {
        if (importBtn.disabled) {
          throw Error('目标位置的「导入 (Import)」按钮处于禁用状态，请检查是否有编辑权限或当前计划是否已锁定。');
        }
        dispatchClick(importBtn.el);
        await delay(550);

        if (!interceptedInput && !pickerIntercepted) {
          input = findImportFileInput();
          if (!input) {
            const modalBtn = findVisibleControl(
              '[role="dialog"] button, [role="dialog"] [role="button"], [role="dialog"] label, [class*="modal" i] button, [class*="modal" i] label',
              /(?:Select|Choose|from\s+your\s+computer|Import\s+from|选择文件|从电脑|電腦|浏览|\.fig)/i
            );
            if (modalBtn && !modalBtn.disabled) {
              dispatchClick(modalBtn.el);
              await delay(550);
              input = findImportFileInput();
            }
          }
        }
      }
    } finally {
      HTMLInputElement.prototype.click = origInputClick;
      if (typeof origShowOpenFilePicker === 'function') {
        window.showOpenFilePicker = origShowOpenFilePicker;
      }
    }

    if (pickerIntercepted) {
      return 'file_picker_api';
    }

    const finalInput = interceptedInput || input || findImportFileInput();
    if (finalInput) {
      finalInput.files = transfer.files;
      finalInput.dispatchEvent(new Event('input', { bubbles: true }));
      finalInput.dispatchEvent(new Event('change', { bubbles: true }));
      return 'intercepted_input';
    }

    // 检查页面是否因为教育/团队计划锁定而不显示导入控件
    const pageBodyText = (document.body && document.body.innerText) || '';
    if (/Your team is locked|Your education status has expired|团队已锁定|教育资格已过期/i.test(pageBodyText)) {
      throw Error('当前所在的 Figma 空间处于锁定状态（如教育资格过期或团队锁定），无法导入新文件，请切换到可编辑团队的文件夹重试。');
    }

    // 3. 兜底：向文件列表容器派发原生 DragEvent('drop')
    const dropTarget =
      document.querySelector('[data-testid*="file-browser" i], [class*="file_browser" i], main') ||
      document.body ||
      document.documentElement;
    if (!dropTarget) {
      throw Error('未找到可接收导入文件的页面容器。');
    }

    for (const evtName of ['dragenter', 'dragover', 'drop']) {
      dropTarget.dispatchEvent(
        new DragEvent(evtName, {
          dataTransfer: transfer,
          bubbles: true,
          cancelable: true,
        })
      );
      await delay(80);
    }
    return 'drag_drop';
  }

  function checkImportUi() {
    const dialogs = Array.from(
      document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="alert"], [class*="modal" i], [class*="toast" i], [class*="notification" i]'
      )
    );
    const dialogText = dialogs.map(d => (d.innerText || d.textContent || '').trim()).join(' \n ');

    if (
      /failed to import|couldn't import|unable to import|import failed|can't import|unsupported file|corrupted|导入失败|无法导入|不支持的文件/i.test(
        dialogText
      )
    ) {
      return { status: 'error', message: dialogText.replace(/\s+/g, ' ').trim().slice(0, 180) };
    }
    if (
      /team is locked|education status has expired|starter plan|maximum of \d+ files|upgrade to professional|超出文件数量限制|团队已锁定|教育资格已过期/i.test(
        dialogText
      )
    ) {
      return {
        status: 'error',
        message:
          '目标团队受套餐或锁定限制（如 Starter 免费团队文件数上限或教育团队已锁定），建议导入到「个人草稿箱 (Drafts)」或可编辑团队',
      };
    }

    const isImporting = /importing|uploading|正在导入|正在上传|匯入中/i.test(dialogText);

    for (const d of dialogs) {
      const txt = d.innerText || d.textContent || '';
      if (/imported|导入完成|已导入|成功导入|匯入完成/i.test(txt) && !isImporting) {
        const btns = Array.from(d.querySelectorAll('button, [role="button"]'));
        for (const b of btns) {
          const bt = (b.innerText || b.textContent || '').trim();
          if (/^(?:Done|Close|OK|完成|关闭|確定|好)$/i.test(bt)) {
            b.click();
            return { status: 'done' };
          }
        }
        return { status: 'done' };
      }
    }

    return { status: isImporting ? 'importing' : 'idle' };
  }

  async function pollFolderFiles(opts) {
    const folderId = opts?.folderId ? String(opts.folderId) : null;
    const isDrafts = Boolean(opts?.isDrafts);
    const files = [];

    const extract = payload => {
      const meta = payload?.meta ?? payload;
      const arr = Array.isArray(meta)
        ? meta
        : [meta?.files, meta?.rows, meta?.drafts].find(Array.isArray) || [];
      for (const f of arr) {
        if (f && f.key && !f.trashed_at && !f.deleted_at) {
          files.push({ key: String(f.key), name: String(f.name || 'Untitled') });
        }
      }
    };

    if (folderId) {
      const q = new URLSearchParams({
        folderId,
        sort_column: 'touched_at',
        sort_order: 'desc',
        fetch_only_trashed_with_folder_files: 'false',
        page_size: '50',
        file_type: '',
      });
      const res = await figmaFetch(`/api/folders/${encodeURIComponent(folderId)}/paginated_files?${q}`, {
        timeoutMs: 12000,
      });
      if (res.ok && res.data) extract(res.data);
    }

    if (files.length === 0 && isDrafts) {
      const res = await figmaFetch('/api/user/drafts', { timeoutMs: 12000 });
      if (res.ok && res.data) extract(res.data);
    }

    return files;
  }

  switch (action) {
    case 'auth':
      return checkAuth();
    case 'request':
      return figmaFetch(args?.path || '', {
        method: args?.method || 'GET',
        payload: args?.payload,
        userId: args?.userId,
      });
    case 'discoverTeams':
      return discoverTeams();
    case 'editorState':
      return editorState();
    case 'triggerExport':
      return triggerExport();
    case 'browserState':
      return browserState();
    case 'resetUpload':
      globalThis.__figmaExportUpload = [];
      return true;
    case 'uploadChunk':
      if (!Array.isArray(globalThis.__figmaExportUpload)) {
        globalThis.__figmaExportUpload = [];
      }
      globalThis.__figmaExportUpload.push(Uint8Array.from(atob(args), c => c.charCodeAt(0)));
      return true;
    case 'clearUpload':
      delete globalThis.__figmaExportUpload;
      return true;
    case 'submitUpload':
      return submitUpload(args);
    case 'checkImportUi':
      return checkImportUi();
    case 'pollFolderFiles':
      return pollFolderFiles(args);
    default:
      throw Error(`未知的 Figma 页面操作: ${action}`);
  }
}
