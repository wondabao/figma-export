(() => {
  const bridge = window.figmaExporter;

  const ICONS = {
    layers: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 12 12 17 22 12"/><polyline points="2 17 12 22 22 17"/></svg>`,
    doc: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
    users: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    folder: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    triangle: `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2.3 3.9a.65.65 0 0 1 .52-.26h6.36a.65.65 0 0 1 .52 1.04L6.52 8.92a.65.65 0 0 1-1.04 0L2.3 4.68a.65.65 0 0 1 0-.78Z"/></svg>`,
  };

  const state = {
    mode: 'export', // 'export' | 'import'
    homeDir: '',
    auth: { authenticated: false, user: null },
    config: {
      outputDir: '',
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
    },

    // 导出状态
    scanResult: null,
    activeWorkspaceFilter: '__all__', // '__all__' | '__failed__' | team.id
    selectedKeys: new Set(),
    isScanning: false,
    isExporting: false,
    activeExportKey: null,
    exportStats: null,
    allExpanded: true,
    collapsedTeams: new Set(),
    collapsedFolders: new Set(),

    // 导入状态
    importQueue: [],
    activeImportGroupFilter: '__all__', // '__all__' | '__failed__' | groupName
    selectedImportIds: new Set(),
    importTargets: null,
    isLoadingTargets: false,
    isImporting: false,
    activeImportId: null,
    importStats: null,
    collapsedImportGroups: new Set(),
  };

  const el = {
    // 顶部栏
    tabExport: document.getElementById('tabExport'),
    tabImport: document.getElementById('tabImport'),
    btnLoginTop: document.getElementById('btnLoginTop'),
    userMenuWrap: document.getElementById('userMenuWrap'),
    btnUserTrigger: document.getElementById('btnUserTrigger'),
    userAvatar: document.getElementById('userAvatar'),
    userNameText: document.getElementById('userNameText'),
    userEmailText: document.getElementById('userEmailText'),
    userDropdown: document.getElementById('userDropdown'),
    btnRecheckAuth: document.getElementById('btnRecheckAuth'),
    btnSwitchAccount: document.getElementById('btnSwitchAccount'),

    // 左侧导航栏
    sidebarBrandTitle: document.getElementById('sidebarBrandTitle'),
    navSectionLabel: document.getElementById('navSectionLabel'),
    btnHeaderAddTeam: document.getElementById('btnHeaderAddTeam'),
    workspaceNavList: document.getElementById('workspaceNavList'),
    navFooter: document.getElementById('navFooter'),
    btnNavAddFiles: document.getElementById('btnNavAddFiles'),

    // 中栏 A：导出
    exportCenterCard: document.getElementById('exportCenterCard'),
    btnScan: document.getElementById('btnScan'),
    scanIcon: document.getElementById('scanIcon'),
    searchInput: document.getElementById('searchInput'),
    btnExportFilterToggle: document.getElementById('btnExportFilterToggle'),
    exportFilterDot: document.getElementById('exportFilterDot'),
    exportFilterPopover: document.getElementById('exportFilterPopover'),
    typeFilter: document.getElementById('typeFilter'),
    statusFilter: document.getElementById('statusFilter'),
    btnResetExportFilters: document.getElementById('btnResetExportFilters'),
    btnToggleExpand: document.getElementById('btnToggleExpand'),
    expandBtnText: document.getElementById('expandBtnText'),
    exportTableHead: document.getElementById('exportTableHead'),
    exportMasterCb: document.getElementById('exportMasterCb'),
    treeContainer: document.getElementById('treeContainer'),
    exportCenterFooter: document.getElementById('exportCenterFooter'),
    selectionSummary: document.getElementById('selectionSummary'),
    btnClearOrSelectAll: document.getElementById('btnClearOrSelectAll'),

    // 中栏 B：导入
    importCenterCard: document.getElementById('importCenterCard'),
    importPickerActions: document.getElementById('importPickerActions'),
    btnPickImportFiles: document.getElementById('btnPickImportFiles'),
    btnPickImportFolder: document.getElementById('btnPickImportFolder'),
    importSearchInput: document.getElementById('importSearchInput'),
    btnImportFilterToggle: document.getElementById('btnImportFilterToggle'),
    importFilterDot: document.getElementById('importFilterDot'),
    importFilterPopover: document.getElementById('importFilterPopover'),
    importExtFilter: document.getElementById('importExtFilter'),
    importStatusFilter: document.getElementById('importStatusFilter'),
    btnResetImportFilters: document.getElementById('btnResetImportFilters'),
    btnClearImportQueue: document.getElementById('btnClearImportQueue'),
    importDropzone: document.getElementById('importDropzone'),
    importTableHead: document.getElementById('importTableHead'),
    importMasterCb: document.getElementById('importMasterCb'),
    importTreeContainer: document.getElementById('importTreeContainer'),
    importCenterFooter: document.getElementById('importCenterFooter'),
    importSelectionSummary: document.getElementById('importSelectionSummary'),
    btnImportClearOrSelectAll: document.getElementById('btnImportClearOrSelectAll'),

    // 右栏设置与进度
    exportSettingsCard: document.getElementById('exportSettingsCard'),
    outputDirDisplay: document.getElementById('outputDirDisplay'),
    btnOpenFolder: document.getElementById('btnOpenFolder'),
    btnChooseDir: document.getElementById('btnChooseDir'),
    optSkipExported: document.getElementById('optSkipExported'),
    optIncludeDrafts: document.getElementById('optIncludeDrafts'),
    optSilentExport: document.getElementById('optSilentExport'),
    optTimeoutSec: document.getElementById('optTimeoutSec'),

    importSettingsCard: document.getElementById('importSettingsCard'),
    btnRefreshTargets: document.getElementById('btnRefreshTargets'),
    importTargetMode: document.getElementById('importTargetMode'),
    importTeamField: document.getElementById('importTeamField'),
    importTeamSelect: document.getElementById('importTeamSelect'),
    importFolderField: document.getElementById('importFolderField'),
    importFolderSelect: document.getElementById('importFolderSelect'),
    btnNewFigmaFolder: document.getElementById('btnNewFigmaFolder'),
    optImportSkipExisting: document.getElementById('optImportSkipExisting'),
    optImportSilent: document.getElementById('optImportSilent'),
    optImportTimeoutSec: document.getElementById('optImportTimeoutSec'),

    settingsShellCard: document.getElementById('settingsShellCard'),
    idleCtaStack: document.getElementById('idleCtaStack'),
    progressCard: document.getElementById('progressCard'),
    progressTitle: document.getElementById('progressTitle'),
    progressPct: document.getElementById('progressPct'),
    progressFill: document.getElementById('progressFill'),
    progressMeta: document.getElementById('progressMeta'),
    cntSucceeded: document.getElementById('cntSucceeded'),
    cntSkipped: document.getElementById('cntSkipped'),
    cntFailed: document.getElementById('cntFailed'),
    btnPrimaryAction: document.getElementById('btnPrimaryAction'),
    btnStopAction: document.getElementById('btnStopAction'),
    btnRetryAction: document.getElementById('btnRetryAction'),

    // 底栏、日志抽屉、添加团队弹窗
    statusBarDot: document.getElementById('statusBarDot'),
    statusBarText: document.getElementById('statusBarText'),
    btnToggleLogDrawer: document.getElementById('btnToggleLogDrawer'),
    logDrawer: document.getElementById('logDrawer'),
    btnClearLogs: document.getElementById('btnClearLogs'),
    btnCloseLogDrawer: document.getElementById('btnCloseLogDrawer'),
    logConsole: document.getElementById('logConsole'),
    btnVersion: document.getElementById('btnVersion'),
    versionModal: document.getElementById('versionModal'),
    btnCloseVersion: document.getElementById('btnCloseVersion'),
    versionCurrent: document.getElementById('versionCurrent'),
    versionStatus: document.getElementById('versionStatus'),
    btnCheckUpdate: document.getElementById('btnCheckUpdate'),
    btnUpdateAction: document.getElementById('btnUpdateAction'),
    versionProgressWrap: document.getElementById('versionProgressWrap'),
    versionProgressFill: document.getElementById('versionProgressFill'),

    addTeamModal: document.getElementById('addTeamModal'),
    btnCloseTeamModal: document.getElementById('btnCloseTeamModal'),
    manualTeamInput: document.getElementById('manualTeamInput'),
    btnAddTeam: document.getElementById('btnAddTeam'),
    extraTeamsChips: document.getElementById('extraTeamsChips'),
  };

  function cleanError(err) {
    const raw = (err && err.message) || String(err || '未知错误');
    return raw.replace(/^Error:\s*/i, '');
  }

  let currentUpdateState = null;

  function renderUpdateUI(u) {
    if (!u) return;
    currentUpdateState = u;

    if (u.currentVersion) {
      el.btnVersion.textContent = `v${u.currentVersion}`;
      el.versionCurrent.textContent = `当前版本 v${u.currentVersion}`;
    }

    const hasUpdate = Boolean(u.available);
    el.btnVersion.classList.toggle('has-update', hasUpdate);
    if (u.status === 'downloaded') {
      el.btnVersion.title = `新版本 v${u.latestVersion} 已就绪，点击重启更新`;
    } else if (hasUpdate) {
      el.btnVersion.title = `发现新版本 v${u.latestVersion}`;
    } else {
      el.btnVersion.title = '查看版本与更新';
    }
    el.btnVersion.setAttribute('aria-label', el.btnVersion.title);

    const isProgressPhase =
      u.status === 'downloading' || u.status === 'verifying' || u.status === 'staging';
    el.versionProgressWrap.classList.toggle('hidden', !isProgressPhase);
    if (isProgressPhase) {
      el.versionProgressFill.style.width = `${Math.max(2, u.percent || 0)}%`;
    }

    switch (u.status) {
      case 'checking':
        el.versionStatus.textContent = '正在检查更新…';
        el.btnCheckUpdate.classList.remove('hidden');
        el.btnCheckUpdate.disabled = true;
        el.btnCheckUpdate.textContent = '检查更新';
        el.btnUpdateAction.classList.add('hidden');
        break;

      case 'up-to-date':
        el.versionStatus.textContent =
          u.comparison < 0 && u.latestVersion
            ? `最新发布版本为 v${u.latestVersion}`
            : '当前已是最新版本';
        el.btnCheckUpdate.classList.remove('hidden');
        el.btnCheckUpdate.disabled = false;
        el.btnCheckUpdate.textContent = '检查更新';
        el.btnUpdateAction.classList.add('hidden');
        break;

      case 'available':
        if (u.canInstallInPlace) {
          const sizeLabel = u.assetSize > 0 ? `（约 ${formatBytes(u.assetSize)}）` : '';
          el.versionStatus.textContent = `发现新版本 v${u.latestVersion}${sizeLabel}`;
          el.btnCheckUpdate.classList.add('hidden');
          el.btnUpdateAction.classList.remove('hidden');
          el.btnUpdateAction.disabled = false;
          el.btnUpdateAction.dataset.mode = 'download';
          el.btnUpdateAction.textContent = '立即更新';
        } else {
          el.versionStatus.textContent = `发现新版本 v${u.latestVersion} · ${u.manualReason || '请前往发布页下载'}`;
          el.btnCheckUpdate.classList.add('hidden');
          el.btnUpdateAction.classList.remove('hidden');
          el.btnUpdateAction.disabled = false;
          el.btnUpdateAction.dataset.mode = 'manual';
          el.btnUpdateAction.textContent = '前往下载';
        }
        break;

      case 'downloading': {
        const sizeProgress =
          u.totalBytes > 0
            ? `（${formatBytes(u.transferredBytes)} / ${formatBytes(u.totalBytes)}）`
            : `（${formatBytes(u.transferredBytes)}）`;
        el.versionStatus.textContent = `正在下载 v${u.latestVersion}… ${u.percent || 0}% ${sizeProgress}`;
        el.btnCheckUpdate.classList.add('hidden');
        el.btnUpdateAction.classList.remove('hidden');
        el.btnUpdateAction.disabled = true;
        el.btnUpdateAction.textContent = `下载中 ${u.percent || 0}%`;
        break;
      }

      case 'verifying':
        el.versionStatus.textContent = '正在校验安装包完整性…';
        el.btnCheckUpdate.classList.add('hidden');
        el.btnUpdateAction.classList.remove('hidden');
        el.btnUpdateAction.disabled = true;
        el.btnUpdateAction.textContent = '正在校验…';
        break;

      case 'staging':
        el.versionStatus.textContent = '正在解压并准备新版本…';
        el.btnCheckUpdate.classList.add('hidden');
        el.btnUpdateAction.classList.remove('hidden');
        el.btnUpdateAction.disabled = true;
        el.btnUpdateAction.textContent = '正在准备…';
        break;

      case 'downloaded':
        el.versionStatus.textContent = `新版本 v${u.latestVersion} 已就绪，重启即可完成更新`;
        el.btnCheckUpdate.classList.add('hidden');
        el.btnUpdateAction.classList.remove('hidden');
        el.btnUpdateAction.disabled = false;
        el.btnUpdateAction.dataset.mode = 'restart';
        el.btnUpdateAction.textContent = '立即重启';
        break;

      case 'error':
        el.versionStatus.textContent = u.error || '检查或下载更新失败，请重试。';
        if (hasUpdate && u.canInstallInPlace) {
          el.btnCheckUpdate.classList.add('hidden');
          el.btnUpdateAction.classList.remove('hidden');
          el.btnUpdateAction.disabled = false;
          el.btnUpdateAction.dataset.mode = 'download';
          el.btnUpdateAction.textContent = '重试更新';
        } else {
          el.btnCheckUpdate.classList.remove('hidden');
          el.btnCheckUpdate.disabled = false;
          el.btnCheckUpdate.textContent = '检查更新';
          el.btnUpdateAction.classList.add('hidden');
        }
        break;

      default:
        break;
    }
  }

  async function checkUpdates() {
    try {
      const result = await bridge.checkForUpdates();
      renderUpdateUI(result);
    } catch {
      if (!currentUpdateState || currentUpdateState.status !== 'error') {
        el.versionStatus.textContent = '检查更新失败，请检查网络后重试。';
        el.btnCheckUpdate.disabled = false;
      }
    }
  }

  el.btnVersion.addEventListener('click', () => {
    el.versionModal.showModal();
    el.btnCloseVersion.focus();
  });
  function closeVersionModal() {
    el.versionModal.close();
  }
  el.btnCloseVersion.addEventListener('click', closeVersionModal);
  el.versionModal.addEventListener('click', (event) => {
    if (event.target !== el.versionModal) return;
    const bounds = el.versionModal.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) closeVersionModal();
  });
  document.getElementById('btnOpenGithub').addEventListener('click', async () => {
    try {
      await bridge.openGithub();
    } catch {
      alert('无法打开默认浏览器。项目地址为 https://github.com/wondabao/figma-export');
    }
  });
  for (const button of el.versionModal.querySelectorAll('[data-policy]')) {
    button.addEventListener('click', () => {
      const reader = document.getElementById('policyReader');
      reader.title = button.firstChild.textContent.trim();
      reader.src = `./legal/${button.dataset.policy}.html`;
      document.getElementById('policyModal').showModal();
    });
  }
  document.getElementById('btnOpenWebsite').addEventListener('click', async () => {
    try {
      await bridge.openWebsite();
    } catch {
      alert('无法打开默认浏览器。官网地址为 https://www.yypic.com');
    }
  });
  el.btnCheckUpdate.addEventListener('click', checkUpdates);
  el.btnUpdateAction.addEventListener('click', async () => {
    const mode = el.btnUpdateAction.dataset.mode;
    if (mode === 'restart') {
      try {
        el.btnUpdateAction.disabled = true;
        el.btnUpdateAction.textContent = '正在重启…';
        await bridge.installUpdate();
      } catch (err) {
        el.btnUpdateAction.disabled = false;
        el.btnUpdateAction.textContent = '立即重启';
        alert(cleanError(err));
      }
      return;
    }
    if (mode === 'download') {
      try {
        await bridge.downloadUpdate();
      } catch {
        // 状态文案已由 event:update_state 更新
      }
      return;
    }
    try {
      await bridge.openReleases();
    } catch {
      el.versionStatus.textContent = '无法打开下载页面，请重试。';
    }
  });

  if (typeof bridge.onUpdateState === 'function') {
    bridge.onUpdateState((uState) => renderUpdateUI(uState));
  }

  bridge.getVersion().then((version) => {
    el.btnVersion.textContent = `v${version}`;
    el.versionCurrent.textContent = `当前版本 v${version}`;
  }).catch(() => {
    el.versionCurrent.textContent = '无法获取当前版本';
  });
  void checkUpdates();

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatShortPath(fullPath) {
    if (!fullPath) return '选择文件夹';
    if (state.homeDir && fullPath.startsWith(state.homeDir)) {
      return '~' + fullPath.slice(state.homeDir.length);
    }
    return fullPath;
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  function setStatusBar(kind, text) {
    el.statusBarDot.className = 'status-dot' + (kind ? ` ${kind}` : '');
    el.statusBarText.textContent = text;
  }

  function appendLog(entry) {
    const div = document.createElement('div');
    div.className = `log-line log-${entry.level || 'info'}`;
    div.innerHTML = `<span class="log-time">[${escapeHtml(entry.time)}]</span>${escapeHtml(entry.message)}`;
    el.logConsole.appendChild(div);
    el.logConsole.scrollTop = el.logConsole.scrollHeight;

    // 同步底部一行状态栏
    if (entry.level === 'error') {
      setStatusBar('warn', entry.message);
    } else if (entry.level === 'success') {
      setStatusBar('ok', entry.message);
    } else if (state.isScanning || state.isExporting || state.isImporting) {
      setStatusBar('busy', entry.message);
    }
  }

  // ==================== 顶部账号与弹窗控制 ====================
  function renderAuth() {
    if (state.auth.authenticated && state.auth.user) {
      el.btnLoginTop.classList.add('hidden');
      el.userMenuWrap.classList.remove('hidden');

      const name = state.auth.user.name || 'Figma';
      el.userNameText.textContent = name;
      el.userEmailText.textContent = state.auth.user.email || '已登录 Figma 账号';

      if (state.auth.user.imgUrl) {
        el.userAvatar.innerHTML = `<img src="${escapeHtml(state.auth.user.imgUrl)}" alt="" />`;
      } else {
        el.userAvatar.textContent = name.trim().charAt(0).toUpperCase() || 'F';
      }
    } else {
      el.btnLoginTop.classList.remove('hidden');
      el.userMenuWrap.classList.add('hidden');
      el.userDropdown.classList.add('hidden');
    }
  }

  function closeAllPopovers() {
    el.userDropdown.classList.add('hidden');
    el.exportFilterPopover.classList.add('hidden');
    el.importFilterPopover.classList.add('hidden');
  }

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#userMenuWrap')) {
      el.userDropdown.classList.add('hidden');
    }
    if (!e.target.closest('#btnExportFilterToggle') && !e.target.closest('#exportFilterPopover')) {
      el.exportFilterPopover.classList.add('hidden');
    }
    if (!e.target.closest('#btnImportFilterToggle') && !e.target.closest('#importFilterPopover')) {
      el.importFilterPopover.classList.add('hidden');
    }
  });

  el.btnUserTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    el.userDropdown.classList.toggle('hidden');
  });

  el.btnExportFilterToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    el.exportFilterPopover.classList.toggle('hidden');
  });

  el.btnImportFilterToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    el.importFilterPopover.classList.toggle('hidden');
  });

  el.btnToggleLogDrawer.addEventListener('click', () => {
    el.logDrawer.classList.toggle('hidden');
  });

  el.btnCloseLogDrawer.addEventListener('click', () => {
    el.logDrawer.classList.add('hidden');
  });

  // ==================== 模式切换 ====================
  function switchMode(newMode) {
    state.mode = newMode === 'import' ? 'import' : 'export';
    const isImport = state.mode === 'import';

    el.tabExport.classList.toggle('active', !isImport);
    el.tabExport.setAttribute('aria-selected', String(!isImport));
    el.tabImport.classList.toggle('active', isImport);
    el.tabImport.setAttribute('aria-selected', String(isImport));

    el.navSectionLabel.textContent = isImport ? '文件分组' : '工作空间';
    el.btnHeaderAddTeam.classList.toggle('hidden', isImport);
    el.navFooter.classList.toggle('hidden', !isImport);

    el.exportCenterCard.classList.toggle('hidden', isImport);
    el.exportSettingsCard.classList.toggle('hidden', isImport);
    el.importCenterCard.classList.toggle('hidden', !isImport);
    el.importSettingsCard.classList.toggle('hidden', !isImport);

    closeAllPopovers();
    renderAll();

    if (
      isImport &&
      state.auth.authenticated &&
      !state.importTargets &&
      !state.isLoadingTargets &&
      el.importTargetMode.value !== 'drafts'
    ) {
      refreshImportTargets(true);
    }
  }

  el.tabExport.addEventListener('click', () => switchMode('export'));
  el.tabImport.addEventListener('click', () => switchMode('import'));

  // ==================== 左栏工作空间导航渲染 ====================
  function renderSidebarNav() {
    if (state.mode === 'export') {
      const totalFiles = state.scanResult ? state.scanResult.files.length : 0;

      const navItems = [
        `<button class="nav-item ${state.activeWorkspaceFilter === '__all__' ? 'active' : ''}" data-ws-filter="__all__" type="button">
          <span class="nav-item-left">${ICONS.layers}<span class="nav-item-label">全部文件</span></span>
          <span class="nav-count">${totalFiles}</span>
        </button>`,
      ];

      if (state.scanResult && Array.isArray(state.scanResult.teams)) {
        for (const team of state.scanResult.teams) {
          const count = team.folders.reduce((sum, fl) => sum + fl.files.length, 0);
          const displayName = team.isDrafts ? '个人草稿' : team.name;
          const icon = team.isDrafts ? ICONS.doc : ICONS.users;
          const isActive = state.activeWorkspaceFilter === team.id;

          navItems.push(`
            <button class="nav-item ${isActive ? 'active' : ''}" data-ws-filter="${escapeHtml(team.id)}" type="button" title="${escapeHtml(displayName)}">
              <span class="nav-item-left">${icon}<span class="nav-item-label">${escapeHtml(displayName)}</span></span>
              <span class="nav-count">${count}</span>
            </button>
          `);
        }
      }

      el.workspaceNavList.innerHTML = navItems.join('');
    } else {
      // 导入模式左侧分组列表
      const totalFiles = state.importQueue.length;

      const groupCounts = new Map();
      for (const item of state.importQueue) {
        const g = item.suggestedFolder || 'Imported';
        groupCounts.set(g, (groupCounts.get(g) || 0) + 1);
      }

      const navItems = [
        `<button class="nav-item ${state.activeImportGroupFilter === '__all__' ? 'active' : ''}" data-imp-nav="__all__" type="button">
          <span class="nav-item-left">${ICONS.layers}<span class="nav-item-label">全部文件</span></span>
          <span class="nav-count">${totalFiles}</span>
        </button>`,
      ];

      for (const [gName, count] of groupCounts.entries()) {
        const isActive = state.activeImportGroupFilter === gName;
        navItems.push(`
          <button class="nav-item ${isActive ? 'active' : ''}" data-imp-nav="${escapeHtml(gName)}" type="button" title="${escapeHtml(gName)}">
            <span class="nav-item-left">${ICONS.folder}<span class="nav-item-label">${escapeHtml(gName)}</span></span>
            <span class="nav-count">${count}</span>
          </button>
        `);
      }

      el.workspaceNavList.innerHTML = navItems.join('');
    }
  }

  el.workspaceNavList.addEventListener('click', (e) => {
    const wsBtn = e.target.closest('[data-ws-filter]');
    if (wsBtn) {
      state.activeWorkspaceFilter = wsBtn.getAttribute('data-ws-filter');
      renderAll();
      return;
    }
    const impBtn = e.target.closest('[data-imp-nav]');
    if (impBtn) {
      state.activeImportGroupFilter = impBtn.getAttribute('data-imp-nav');
      renderAll();
    }
  });

  function openAddTeamModal() {
    renderExtraTeams();
    el.addTeamModal.classList.remove('hidden');
    el.manualTeamInput.focus();
  }

  el.btnHeaderAddTeam.addEventListener('click', () => {
    openAddTeamModal();
  });

  el.btnNavAddFiles.addEventListener('click', () => {
    el.btnPickImportFiles.click();
  });

  el.btnCloseTeamModal.addEventListener('click', () => {
    el.addTeamModal.classList.add('hidden');
  });

  el.addTeamModal.addEventListener('click', (e) => {
    if (e.target === el.addTeamModal) {
      el.addTeamModal.classList.add('hidden');
    }
  });

  // ==================== 批量导出树形表格 ====================
  function getFilteredExportFiles() {
    if (!state.scanResult) return [];
    const q = el.searchInput.value.trim().toLowerCase();
    const typeF = el.typeFilter.value;
    const statusF = el.statusFilter.value;
    const wsF = state.activeWorkspaceFilter;

    el.exportFilterDot.classList.toggle('hidden', typeF === 'all' && statusF === 'all');

    return state.scanResult.files.filter((f) => {
      if (wsF === '__failed__' && f.backupStatus !== 'failed') return false;
      if (wsF !== '__all__' && wsF !== '__failed__' && f.teamId !== wsF) return false;
      if (typeF !== 'all' && f.editorType !== typeF) return false;
      if (statusF === 'need_export' && f.backupStatus !== 'pending' && f.backupStatus !== 'outdated') return false;
      if (statusF === 'exported' && f.backupStatus !== 'exported') return false;
      if (statusF === 'failed' && f.backupStatus !== 'failed') return false;
      if (q) {
        const hay = `${f.teamName} ${f.folderName} ${f.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderExportStatusBadge(file) {
    if (state.activeExportKey === file.key) {
      return '<span class="status-badge badge-running">导出中</span>';
    }
    switch (file.backupStatus) {
      case 'exported':
        return '<span class="status-badge badge-exported">已备份</span>';
      case 'outdated':
        return '<span class="status-badge badge-outdated">有更新</span>';
      case 'failed':
        return `<span class="status-badge badge-failed" title="${escapeHtml(file.lastError || '导出失败')}">失败</span>`;
      default:
        return '<span class="status-badge badge-pending">待导出</span>';
    }
  }

  function renderExportSection() {
    el.outputDirDisplay.textContent = formatShortPath(state.config.outputDir);
    el.btnOpenFolder.title = `点击在系统中打开: ${state.config.outputDir || ''}`;

    el.scanIcon.classList.toggle('spinning', state.isScanning);
    el.btnScan.title = state.isScanning ? '扫描中...' : '重新扫描';
    el.btnScan.setAttribute('aria-label', el.btnScan.title);
    el.btnScan.disabled = state.isScanning || state.isExporting || state.isImporting;

    if (!state.scanResult) {
      el.exportTableHead.classList.add('hidden');
      el.exportCenterFooter.classList.add('hidden');
      el.exportMasterCb.checked = false;
      el.exportMasterCb.indeterminate = false;
      el.selectionSummary.textContent = '已选 0 个文件';
      el.btnClearOrSelectAll.textContent = '全选';

      el.treeContainer.innerHTML = `
        <div class="empty-box">
          ${ICONS.layers}
          <h3>${state.auth.authenticated ? '尚未扫描云端空间' : '欢迎使用 Figma Export'}</h3>
          <p class="export-formats">支持 <code>.fig</code>、<code>.jam</code>、<code>.deck</code> 文件导出。</p>
          ${
            state.auth.authenticated
              ? `<button class="empty-scan-btn" data-empty-scan="1" type="button" ${state.isScanning || state.isExporting || state.isImporting ? 'disabled' : ''}>
                   <svg class="${state.isScanning ? 'spinning' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                     <path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/>
                   </svg>
                   <span>${state.isScanning ? '扫描中...' : '开始扫描'}</span>
                 </button>`
              : `<p>第一步：点击顶部右上角「登录 Figma」完成登录；<br/>第二步：扫描拉取全部团队与文件夹。</p>`
          }
        </div>`;
      return;
    }

    const visibleList = getFilteredExportFiles();
    const visibleSet = new Set(visibleList.map((f) => f.key));
    const visibleSelectedCount = visibleList.filter((f) => state.selectedKeys.has(f.key)).length;

    el.exportTableHead.classList.toggle('hidden', visibleList.length === 0);
    el.exportCenterFooter.classList.toggle(
      'hidden',
      state.scanResult.files.length === 0 || (visibleList.length === 0 && state.selectedKeys.size === 0)
    );

    el.exportMasterCb.checked = visibleList.length > 0 && visibleSelectedCount === visibleList.length;
    el.exportMasterCb.indeterminate =
      visibleSelectedCount > 0 && visibleSelectedCount < visibleList.length;

    el.selectionSummary.textContent = `已选 ${state.selectedKeys.size} 个文件`;
    el.btnClearOrSelectAll.textContent = state.selectedKeys.size > 0 ? '清除选择' : '全选';
    el.expandBtnText.textContent = state.allExpanded ? '折叠全部' : '展开全部';

    if (visibleList.length === 0) {
      if (state.scanResult.files.length === 0) {
        el.treeContainer.innerHTML = `
          <div class="empty-box">
            ${ICONS.doc}
            <h3>未发现可导出的文件</h3>
            <p>当前账号下暂无可见团队文件或个人草稿。</p>
            <p class="empty-fallback-hint">若有未自动发现的企业公开或外部团队，可<button class="inline-link-btn" data-open-add-team="1" type="button">补充隐藏团队</button>后重新扫描。</p>
          </div>`;
        return;
      }
      el.treeContainer.innerHTML = `
        <div class="empty-box">
          ${ICONS.doc}
          <h3>没有匹配的文件</h3>
          <p>请切换左侧工作空间或调整搜索、筛选条件。</p>
        </div>`;
      return;
    }

    const rows = [];
    for (const team of state.scanResult.teams) {
      for (const folder of team.folders) {
        const vFiles = folder.files.filter((f) => visibleSet.has(f.key));
        if (vFiles.length === 0) continue;

        const selInFolder = vFiles.filter((f) => state.selectedKeys.has(f.key)).length;
        // 个人草稿单目录直接平铺展示文件，不显示顶层「个人草稿 / Drafts」行；团队项目保留「文件夹 → 文件」两级结构
        const skipFolderRow = Boolean(team.isDrafts && team.folders.length === 1);
        const folderKey = `${team.id}::${folder.id}`;
        const folderCollapsed = !skipFolderRow && state.collapsedFolders.has(folderKey);

        if (!skipFolderRow) {
          const folderChecked = selInFolder === vFiles.length;
          const folderIndet = selInFolder > 0 && selInFolder < vFiles.length;
          const folderTooltip = team.isDrafts ? folder.name : `${team.name} / ${folder.name}`;
          rows.push(`
            <div class="tree-row">
              <div class="col-check">
                <input type="checkbox" class="dark-cb folder-cb" data-folder-key="${escapeHtml(folderKey)}" ${folderChecked ? 'checked' : ''} data-indet="${folderIndet ? '1' : '0'}" />
              </div>
              <div class="name-cell indent-team" data-toggle-folder="${escapeHtml(folderKey)}" style="cursor:pointer;">
                <button class="disclosure-btn ${folderCollapsed ? 'collapsed' : ''}" type="button">${ICONS.triangle}</button>
                <span class="row-icon">${ICONS.folder}</span>
                <span class="row-title strong" title="${escapeHtml(folderTooltip)}">${escapeHtml(folder.name)}</span>
              </div>
              <div class="format-cell">—</div>
              <div class="status-cell">${vFiles.length} 个文件</div>
            </div>
          `);
        }

        if (folderCollapsed) continue;

        for (const file of vFiles) {
          const checked = state.selectedKeys.has(file.key);
          const isRunning = state.activeExportKey === file.key;
          const indentClass = skipFolderRow ? 'indent-team' : 'indent-import-file';
          rows.push(`
            <div class="tree-row ${isRunning ? 'row-running' : ''}">
              <div class="col-check">
                <input type="checkbox" class="dark-cb file-cb" data-file-key="${escapeHtml(file.key)}" ${checked ? 'checked' : ''} />
              </div>
              <div class="name-cell ${indentClass}">
                <span class="row-icon">${ICONS.doc}</span>
                <span class="row-title" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
              </div>
              <div class="format-cell">${escapeHtml(file.extension || '.fig')}</div>
              <div class="status-cell">${renderExportStatusBadge(file)}</div>
            </div>
          `);
        }
      }
    }

    el.treeContainer.innerHTML = rows.join('');
    el.treeContainer.querySelectorAll('input[data-indet="1"]').forEach((cb) => {
      cb.indeterminate = true;
    });
  }

  // ==================== 批量导入树形表格 ====================
  function getFilteredImportFiles() {
    const q = el.importSearchInput.value.trim().toLowerCase();
    const extF = el.importExtFilter.value;
    const statusF = el.importStatusFilter.value;
    const gFilter = state.activeImportGroupFilter;

    el.importFilterDot.classList.toggle('hidden', extF === 'all' && statusF === 'all');

    return state.importQueue.filter((item) => {
      const gName = item.suggestedFolder || 'Imported';
      if (gFilter === '__failed__' && item.status !== 'failed') return false;
      if (gFilter !== '__all__' && gFilter !== '__failed__' && gName !== gFilter) return false;
      if (extF !== 'all' && item.extension !== extF) return false;
      if (statusF === 'pending' && item.status !== 'pending') return false;
      if (statusF === 'imported' && item.status !== 'imported' && item.status !== 'skipped') return false;
      if (statusF === 'failed' && item.status !== 'failed') return false;
      if (q) {
        const hay = `${gName} ${item.fileName} ${item.localPath}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderImportStatusBadge(item) {
    if (state.activeImportId === item.id) {
      return '<span class="status-badge badge-running">导入中</span>';
    }
    switch (item.status) {
      case 'imported':
        return `<span class="status-badge badge-exported" title="${escapeHtml(item.destinationLabel || '已导入')}">已导入</span>`;
      case 'skipped':
        return `<span class="status-badge badge-outdated" title="目标位置已存在同名文件">已跳过</span>`;
      case 'failed':
        return `<span class="status-badge badge-failed" title="${escapeHtml(item.error || '导入失败')}">失败</span>`;
      default:
        return '<span class="status-badge badge-pending">待导入</span>';
    }
  }

  function renderImportSection() {
    const validIds = new Set(state.importQueue.map((f) => f.id));
    for (const id of Array.from(state.selectedImportIds)) {
      if (!validIds.has(id)) state.selectedImportIds.delete(id);
    }

    el.btnPickImportFiles.disabled = state.isImporting;
    el.btnPickImportFolder.disabled = state.isImporting;
    el.importPickerActions.classList.toggle('hidden', state.importQueue.length === 0);
    el.btnClearImportQueue.disabled = state.isImporting || state.importQueue.length === 0;

    const visibleList = getFilteredImportFiles();
    const visibleSelectedCount = visibleList.filter((i) => state.selectedImportIds.has(i.id)).length;

    el.importTableHead.classList.toggle('hidden', visibleList.length === 0);
    el.importCenterFooter.classList.toggle(
      'hidden',
      state.importQueue.length === 0 || (visibleList.length === 0 && state.selectedImportIds.size === 0)
    );

    el.importMasterCb.checked = visibleList.length > 0 && visibleSelectedCount === visibleList.length;
    el.importMasterCb.indeterminate =
      visibleSelectedCount > 0 && visibleSelectedCount < visibleList.length;

    el.importSelectionSummary.textContent = `已选 ${state.selectedImportIds.size} 个文件`;
    el.btnImportClearOrSelectAll.textContent = state.selectedImportIds.size > 0 ? '清除选择' : '全选';

    if (state.importQueue.length === 0) {
      el.importTreeContainer.innerHTML = `
        <div class="empty-box">
          ${ICONS.folder}
          <h3>拖拽设计文件或备份文件夹到这里</h3>
          <p>支持 <code>.fig</code>、<code>.jam</code>、<code>.deck</code>、<code>.sketch</code> 文件与备份目录。</p>
          <div class="empty-import-actions">
            <button class="pill-btn" type="button" data-pick-import="files" ${state.isImporting ? 'disabled' : ''}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>选择文件</span>
            </button>
            <button class="pill-btn" type="button" data-pick-import="folder" ${state.isImporting ? 'disabled' : ''}>
              ${ICONS.folder}<span>选择文件夹</span>
            </button>
          </div>
        </div>`;
      return;
    }

    if (visibleList.length === 0) {
      el.importTreeContainer.innerHTML = `
        <div class="empty-box">
          ${ICONS.doc}
          <h3>没有匹配的本地文件</h3>
          <p>请切换左侧分组或调整筛选条件。</p>
        </div>`;
      return;
    }

    const groupsMap = new Map();
    for (const item of visibleList) {
      const g = item.suggestedFolder || 'Imported';
      if (!groupsMap.has(g)) groupsMap.set(g, []);
      groupsMap.get(g).push(item);
    }

    const rows = [];
    for (const [gName, items] of groupsMap.entries()) {
      const collapsed = state.collapsedImportGroups.has(gName);
      const selCount = items.filter((i) => state.selectedImportIds.has(i.id)).length;
      const gChecked = selCount === items.length;
      const gIndet = selCount > 0 && selCount < items.length;

      rows.push(`
        <div class="tree-row ${state.activeImportGroupFilter === gName ? 'row-highlight' : ''}">
          <div class="col-check">
            <input type="checkbox" class="dark-cb imp-group-cb" data-imp-group="${escapeHtml(gName)}" ${gChecked ? 'checked' : ''} data-indet="${gIndet ? '1' : '0'}" />
          </div>
          <div class="name-cell indent-team" data-toggle-imp-group="${escapeHtml(gName)}" style="cursor:pointer;">
            <button class="disclosure-btn ${collapsed ? 'collapsed' : ''}" type="button">${ICONS.triangle}</button>
            <span class="row-icon">${ICONS.folder}</span>
            <span class="row-title strong">${escapeHtml(gName)}</span>
          </div>
          <div class="format-cell">—</div>
          <div class="status-cell">${items.length} 个文件</div>
        </div>
      `);

      if (collapsed) continue;

      for (const item of items) {
        const checked = state.selectedImportIds.has(item.id);
        const isRunning = state.activeImportId === item.id;
        rows.push(`
          <div class="tree-row ${isRunning ? 'row-running' : ''}">
            <div class="col-check">
              <input type="checkbox" class="dark-cb imp-file-cb" data-imp-id="${escapeHtml(item.id)}" ${checked ? 'checked' : ''} />
            </div>
            <div class="name-cell indent-import-file">
              <span class="row-icon">${ICONS.doc}</span>
              <span class="row-title" title="${escapeHtml(item.localPath)} (${escapeHtml(formatBytes(item.fileSize))})">${escapeHtml(item.fileName)}</span>
            </div>
            <div class="format-cell">${escapeHtml(item.extension)}</div>
            <div class="status-cell">
              ${renderImportStatusBadge(item)}
              <button class="row-remove-btn" data-remove-imp="${escapeHtml(item.id)}" title="移除" ${state.isImporting ? 'disabled' : ''}>×</button>
            </div>
          </div>
        `);
      }
    }

    el.importTreeContainer.innerHTML = rows.join('');
    el.importTreeContainer.querySelectorAll('input[data-indet="1"]').forEach((cb) => {
      cb.indeterminate = true;
    });
  }

  // ==================== 右下进度与主 CTA 渲染 ====================
  function renderProgressAndCTA() {
    const isImport = state.mode === 'import';
    const anyRunning = state.isExporting || state.isImporting;
    const busy = anyRunning || state.isScanning;

    el.settingsShellCard.classList.toggle('is-working', anyRunning);
    el.idleCtaStack.classList.toggle('hidden', anyRunning);
    el.progressCard.classList.toggle('hidden', !anyRunning);

    if (anyRunning) {
      const runningImport = state.isImporting;
      el.progressTitle.textContent = runningImport ? '导入进度' : '导出进度';
      el.btnStopAction.textContent = runningImport ? '停止导入' : '停止导出';

      const stats = runningImport ? state.importStats : state.exportStats;
      if (!stats) {
        el.progressPct.textContent = '0%';
        el.progressFill.style.width = '0%';
        el.progressMeta.textContent = runningImport ? '正在准备导入...' : '正在准备导出...';
        el.cntSucceeded.textContent = '0';
        el.cntSkipped.textContent = '0';
        el.cntFailed.textContent = '0';
      } else {
        const pct = stats.total > 0 ? Math.round((stats.completed / stats.total) * 100) : 0;
        el.progressPct.textContent = `${pct}%`;
        el.progressFill.style.width = `${pct}%`;
        el.cntSucceeded.textContent = (runningImport ? stats.imported : stats.exported) || 0;
        el.cntSkipped.textContent = stats.skipped || 0;
        el.cntFailed.textContent = stats.failed || 0;

        if (stats.currentFile) {
          el.progressMeta.textContent = runningImport
            ? `正在导入 (${stats.currentFile.index}/${stats.total}): ${stats.currentFile.name}`
            : `正在导出 (${stats.currentFile.index}/${stats.total}): ${stats.currentFile.name}`;
        } else {
          el.progressMeta.textContent = `已处理 ${stats.completed}/${stats.total} 个文件`;
        }
      }
      return;
    }

    if (!isImport) {
      const selCount = state.selectedKeys.size;
      const failedCount = state.scanResult
        ? state.scanResult.files.filter((f) => f.backupStatus === 'failed').length
        : 0;

      el.btnPrimaryAction.disabled = busy || selCount === 0;
      el.btnPrimaryAction.textContent = `导出 ${selCount} 个文件`;

      if (failedCount > 0) {
        el.btnRetryAction.classList.remove('hidden');
        el.btnRetryAction.textContent = `重试 ${failedCount} 个失败项`;
      } else {
        el.btnRetryAction.classList.add('hidden');
      }
    } else {
      const selCount = state.selectedImportIds.size;
      const failedCount = state.importQueue.filter((f) => f.status === 'failed').length;

      el.btnPrimaryAction.disabled = busy || selCount === 0;
      el.btnPrimaryAction.textContent = `导入 ${selCount} 个文件`;

      if (failedCount > 0) {
        el.btnRetryAction.classList.remove('hidden');
        el.btnRetryAction.textContent = `重试 ${failedCount} 个失败项`;
      } else {
        el.btnRetryAction.classList.add('hidden');
      }
    }
  }

  function renderAll() {
    renderAuth();
    renderSidebarNav();
    if (state.mode === 'export') {
      renderExportSection();
    } else {
      renderImportTargetsVisibility();
      renderImportSection();
    }
    renderProgressAndCTA();
  }

  // ==================== 补充团队弹窗与目标团队选择 ====================
  function renderExtraTeams() {
    const ids = state.config.extraTeamIds || [];
    if (el.btnHeaderAddTeam) {
      el.btnHeaderAddTeam.classList.toggle('has-extra', ids.length > 0);
      el.btnHeaderAddTeam.title =
        ids.length > 0 ? `补充隐藏团队（已添加 ${ids.length} 个）` : '补充隐藏团队';
    }
    if (ids.length === 0) {
      el.extraTeamsChips.innerHTML = '';
      return;
    }
    el.extraTeamsChips.innerHTML = ids
      .map(
        (id) =>
          `<span class="chip">Team ID: ${escapeHtml(id)} <button data-remove-team="${escapeHtml(id)}" title="移除" type="button">×</button></span>`
      )
      .join('');
  }

  function renderImportTargetsVisibility() {
    const mode = el.importTargetMode.value;
    el.importTeamField.classList.toggle('hidden', mode === 'drafts');
    el.importFolderField.classList.toggle('hidden', mode !== 'folder');
  }

  function populateImportTeamsSelect() {
    const teams = (state.importTargets && state.importTargets.teams) || [];
    if (teams.length === 0) {
      el.importTeamSelect.innerHTML = '<option value="">请点击右上角「↻ 刷新团队」</option>';
      el.importFolderSelect.innerHTML = '<option value="">请先选择团队</option>';
      return;
    }

    const preferredTeamId = state.config.importTeamId || teams[0].id;
    el.importTeamSelect.innerHTML = teams
      .map(
        (t) =>
          `<option value="${escapeHtml(t.id)}" ${t.id === preferredTeamId ? 'selected' : ''}>${escapeHtml(t.name)} (${t.folders.length})</option>`
      )
      .join('');

    populateImportFoldersSelect();
  }

  function populateImportFoldersSelect() {
    const teams = (state.importTargets && state.importTargets.teams) || [];
    const selectedTeamId = el.importTeamSelect.value;
    const team = teams.find((t) => t.id === selectedTeamId);

    if (!team) {
      el.importFolderSelect.innerHTML = '<option value="">请先选择团队</option>';
      return;
    }
    if (!team.folders || team.folders.length === 0) {
      el.importFolderSelect.innerHTML = '<option value="">暂无文件夹，请点「+ 新建」</option>';
      return;
    }

    const preferredFolderId = team.folders.some((f) => f.id === state.config.importFolderId)
      ? state.config.importFolderId
      : team.folders[0].id;

    el.importFolderSelect.innerHTML = team.folders
      .map(
        (f) =>
          `<option value="${escapeHtml(f.id)}" ${f.id === preferredFolderId ? 'selected' : ''}>${escapeHtml(f.name)}</option>`
      )
      .join('');
  }

  async function refreshImportTargets(silent = false) {
    if (state.isLoadingTargets) return;
    state.isLoadingTargets = true;
    el.btnRefreshTargets.disabled = true;
    el.btnRefreshTargets.textContent = '加载中...';
    try {
      const res = await bridge.loadImportTargets();
      state.importTargets = res.targets;
      if (res.targets && res.targets.user) {
        state.auth.authenticated = true;
        state.auth.user = res.targets.user;
      }
      populateImportTeamsSelect();
      renderAuth();
    } catch (err) {
      if (!silent) alert(`加载团队列表失败: ${cleanError(err)}`);
    } finally {
      state.isLoadingTargets = false;
      el.btnRefreshTargets.disabled = false;
      el.btnRefreshTargets.textContent = '↻ 刷新团队';
    }
  }

  // ==================== 事件绑定 ====================
  async function handleOpenLogin() {
    closeAllPopovers();
    try {
      el.btnLoginTop.disabled = true;
      await bridge.login();
    } catch (err) {
      alert(`打开登录失败: ${cleanError(err)}`);
    } finally {
      el.btnLoginTop.disabled = false;
    }
  }

  el.btnLoginTop.addEventListener('click', handleOpenLogin);
  el.btnRecheckAuth.addEventListener('click', handleOpenLogin);

  el.btnSwitchAccount.addEventListener('click', async () => {
    closeAllPopovers();
    if (!confirm('确定退出当前 Figma 账号并清除本地登录缓存吗？（不会删除已备份的本地设计文件）')) return;
    try {
      await bridge.logout();
      state.auth = { authenticated: false, user: null };
      state.scanResult = null;
      state.importTargets = null;
      state.selectedKeys.clear();
      populateImportTeamsSelect();
      setStatusBar('', '已退出账号');
      renderAll();
    } catch (err) {
      alert(cleanError(err));
    }
  });

  async function saveSettings() {
    try {
      const res = await bridge.saveSettings({
        outputDir: state.config.outputDir,
        skipExported: el.optSkipExported.checked,
        includeDrafts: el.optIncludeDrafts.checked,
        silentExport: el.optSilentExport.checked,
        timeoutSec: Number(el.optTimeoutSec.value) || 180,
        importTargetMode: el.importTargetMode.value,
        importTeamId: el.importTeamSelect.value || '',
        importFolderId: el.importFolderSelect.value || '',
        importSkipExisting: el.optImportSkipExisting.checked,
        importSilent: el.optImportSilent.checked,
        importTimeoutSec: Number(el.optImportTimeoutSec.value) || 240,
      });
      state.config = { ...state.config, ...res.config };
      renderExportSection();
    } catch {
      // ignore
    }
  }

  el.optSkipExported.addEventListener('change', saveSettings);
  el.optIncludeDrafts.addEventListener('change', saveSettings);
  el.optSilentExport.addEventListener('change', saveSettings);
  el.optTimeoutSec.addEventListener('change', saveSettings);
  el.optImportSkipExisting.addEventListener('change', saveSettings);
  el.optImportSilent.addEventListener('change', saveSettings);
  el.optImportTimeoutSec.addEventListener('change', saveSettings);

  el.btnChooseDir.addEventListener('click', async () => {
    try {
      const res = await bridge.chooseDir();
      if (!res.canceled && res.dir) {
        state.config.outputDir = res.dir;
        renderExportSection();
      }
    } catch (err) {
      alert(`选择文件夹失败: ${cleanError(err)}`);
    }
  });

  el.btnOpenFolder.addEventListener('click', async () => {
    try {
      await bridge.openFolder(state.config.outputDir);
    } catch (err) {
      alert(`打开文件夹失败: ${cleanError(err)}`);
    }
  });

  // 扫描云端
  el.btnScan.addEventListener('click', async () => {
    try {
      state.isScanning = true;
      setStatusBar('busy', '正在扫描所有团队、文件夹与草稿...');
      renderAll();

      const res = await bridge.scan({ includeDrafts: el.optIncludeDrafts.checked });
      state.scanResult = res.data;
      state.activeWorkspaceFilter = '__all__';
      if (res.importTargets) {
        state.importTargets = res.importTargets;
        populateImportTeamsSelect();
      }
      state.selectedKeys = new Set(res.data.files.map((f) => f.key));
      if (res.data.user) {
        state.auth.authenticated = true;
        state.auth.user = res.data.user;
      }
      setStatusBar('ok', `扫描完成 · 发现 ${res.data.files.length} 个文件`);
    } catch (err) {
      setStatusBar('warn', `扫描失败: ${cleanError(err)}`);
      alert(`扫描失败: ${cleanError(err)}`);
    } finally {
      state.isScanning = false;
      renderAll();
    }
  });

  // 补充团队
  el.btnAddTeam.addEventListener('click', async () => {
    const val = el.manualTeamInput.value.trim();
    if (!val) return;
    try {
      const res = await bridge.addTeam(val);
      state.config.extraTeamIds = res.extraTeamIds;
      el.manualTeamInput.value = '';
      renderExtraTeams();
    } catch (err) {
      alert(cleanError(err));
    }
  });

  el.manualTeamInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el.btnAddTeam.click();
  });

  el.extraTeamsChips.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-remove-team]');
    if (!btn) return;
    const teamId = btn.getAttribute('data-remove-team');
    const res = await bridge.removeTeam(teamId);
    state.config.extraTeamIds = res.extraTeamIds;
    renderExtraTeams();
  });

  // 导出筛选与展开
  el.searchInput.addEventListener('input', renderExportSection);
  el.typeFilter.addEventListener('change', renderExportSection);
  el.statusFilter.addEventListener('change', renderExportSection);

  el.btnResetExportFilters.addEventListener('click', () => {
    el.typeFilter.value = 'all';
    el.statusFilter.value = 'all';
    closeAllPopovers();
    renderExportSection();
  });

  el.btnToggleExpand.addEventListener('click', () => {
    if (!state.scanResult) return;
    state.allExpanded = !state.allExpanded;
    state.collapsedTeams.clear();
    state.collapsedFolders.clear();
    if (!state.allExpanded) {
      for (const t of state.scanResult.teams) {
        if (t.isDrafts && t.folders.length === 1) continue;
        for (const fl of t.folders) {
          state.collapsedFolders.add(`${t.id}::${fl.id}`);
        }
      }
    }
    renderExportSection();
  });

  el.exportMasterCb.addEventListener('change', () => {
    const visible = getFilteredExportFiles();
    if (el.exportMasterCb.checked) {
      for (const f of visible) state.selectedKeys.add(f.key);
    } else {
      for (const f of visible) state.selectedKeys.delete(f.key);
    }
    renderAll();
  });

  el.btnClearOrSelectAll.addEventListener('click', () => {
    if (!state.scanResult) return;
    if (state.selectedKeys.size > 0) {
      state.selectedKeys.clear();
    } else {
      for (const f of getFilteredExportFiles()) state.selectedKeys.add(f.key);
    }
    renderAll();
  });

  el.treeContainer.addEventListener('click', (e) => {
    const emptyScanBtn = e.target.closest('[data-empty-scan]');
    if (emptyScanBtn) {
      el.btnScan.click();
      return;
    }

    const openAddTeamBtn = e.target.closest('[data-open-add-team]');
    if (openAddTeamBtn) {
      openAddTeamModal();
      return;
    }

    const fileCb = e.target.closest('.file-cb');
    if (fileCb) {
      const key = fileCb.getAttribute('data-file-key');
      if (fileCb.checked) state.selectedKeys.add(key);
      else state.selectedKeys.delete(key);
      renderAll();
      return;
    }

    const folderCb = e.target.closest('.folder-cb');
    if (folderCb) {
      e.stopPropagation();
      const [teamId, folderId] = folderCb.getAttribute('data-folder-key').split('::');
      const visibleSet = new Set(getFilteredExportFiles().map((f) => f.key));
      const team = state.scanResult.teams.find((t) => t.id === teamId);
      const folder = team && team.folders.find((fl) => fl.id === folderId);
      if (folder) {
        for (const f of folder.files) {
          if (!visibleSet.has(f.key)) continue;
          if (folderCb.checked) state.selectedKeys.add(f.key);
          else state.selectedKeys.delete(f.key);
        }
      }
      renderAll();
      return;
    }

    const toggleFolder = e.target.closest('[data-toggle-folder]');
    if (toggleFolder) {
      const fk = toggleFolder.getAttribute('data-toggle-folder');
      if (state.collapsedFolders.has(fk)) state.collapsedFolders.delete(fk);
      else state.collapsedFolders.add(fk);
      renderExportSection();
    }
  });

  // ==================== 导入交互 ====================
  function applyUpdatedImportQueue(newQueue, autoSelectNew = true) {
    const prevIds = new Set(state.importQueue.map((i) => i.id));
    state.importQueue = Array.isArray(newQueue) ? newQueue : [];
    if (autoSelectNew) {
      for (const item of state.importQueue) {
        if (!prevIds.has(item.id)) state.selectedImportIds.add(item.id);
      }
    }
    renderAll();
  }

  el.btnPickImportFiles.addEventListener('click', async () => {
    try {
      const res = await bridge.pickImportFiles();
      if (!res.canceled) applyUpdatedImportQueue(res.queue, true);
    } catch (err) {
      alert(`选择文件失败: ${cleanError(err)}`);
    }
  });

  el.btnPickImportFolder.addEventListener('click', async () => {
    try {
      const res = await bridge.pickImportFolder();
      if (!res.canceled) applyUpdatedImportQueue(res.queue, true);
    } catch (err) {
      alert(`选择文件夹失败: ${cleanError(err)}`);
    }
  });

  el.btnClearImportQueue.addEventListener('click', async () => {
    try {
      const res = await bridge.clearImportQueue();
      state.selectedImportIds.clear();
      state.activeImportGroupFilter = '__all__';
      applyUpdatedImportQueue(res.queue, false);
    } catch (err) {
      alert(cleanError(err));
    }
  });

  ['dragenter', 'dragover'].forEach((evt) => {
    el.importDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!state.isImporting) el.importDropzone.classList.add('drag-over');
    });
  });

  ['dragleave', 'drop'].forEach((evt) => {
    el.importDropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.importDropzone.classList.remove('drag-over');
    });
  });

  async function addDroppedPaths(paths) {
    if (state.mode !== 'import' || state.isImporting || !paths.length) return;
    try {
      const res = await bridge.addImportPaths(paths);
      applyUpdatedImportQueue(res.queue, true);
    } catch (err) {
      alert(`添加拖拽文件失败: ${cleanError(err)}`);
    }
  }

  if (bridge.onDroppedPaths) bridge.onDroppedPaths(addDroppedPaths);

  el.importSearchInput.addEventListener('input', renderImportSection);
  el.importExtFilter.addEventListener('change', renderImportSection);
  el.importStatusFilter.addEventListener('change', renderImportSection);

  el.btnResetImportFilters.addEventListener('click', () => {
    el.importExtFilter.value = 'all';
    el.importStatusFilter.value = 'all';
    closeAllPopovers();
    renderImportSection();
  });

  el.importMasterCb.addEventListener('change', () => {
    const visible = getFilteredImportFiles();
    if (el.importMasterCb.checked) {
      for (const item of visible) state.selectedImportIds.add(item.id);
    } else {
      for (const item of visible) state.selectedImportIds.delete(item.id);
    }
    renderAll();
  });

  el.btnImportClearOrSelectAll.addEventListener('click', () => {
    if (state.selectedImportIds.size > 0) {
      state.selectedImportIds.clear();
    } else {
      for (const item of getFilteredImportFiles()) state.selectedImportIds.add(item.id);
    }
    renderAll();
  });

  el.importTreeContainer.addEventListener('click', async (e) => {
    const pickBtn = e.target.closest('[data-pick-import]');
    if (pickBtn) {
      if (pickBtn.dataset.pickImport === 'files') el.btnPickImportFiles.click();
      else el.btnPickImportFolder.click();
      return;
    }

    const rmBtn = e.target.closest('[data-remove-imp]');
    if (rmBtn) {
      e.stopPropagation();
      const id = rmBtn.getAttribute('data-remove-imp');
      try {
        const res = await bridge.removeImportItems([id]);
        state.selectedImportIds.delete(id);
        applyUpdatedImportQueue(res.queue, false);
      } catch (err) {
        alert(cleanError(err));
      }
      return;
    }

    const fileCb = e.target.closest('.imp-file-cb');
    if (fileCb) {
      const id = fileCb.getAttribute('data-imp-id');
      if (fileCb.checked) state.selectedImportIds.add(id);
      else state.selectedImportIds.delete(id);
      renderAll();
      return;
    }

    const groupCb = e.target.closest('.imp-group-cb');
    if (groupCb) {
      e.stopPropagation();
      const gName = groupCb.getAttribute('data-imp-group');
      for (const item of getFilteredImportFiles()) {
        if ((item.suggestedFolder || 'Imported') !== gName) continue;
        if (groupCb.checked) state.selectedImportIds.add(item.id);
        else state.selectedImportIds.delete(item.id);
      }
      renderAll();
      return;
    }

    const toggleGroup = e.target.closest('[data-toggle-imp-group]');
    if (toggleGroup) {
      const gName = toggleGroup.getAttribute('data-toggle-imp-group');
      if (state.collapsedImportGroups.has(gName)) state.collapsedImportGroups.delete(gName);
      else state.collapsedImportGroups.add(gName);
      renderImportSection();
    }
  });

  el.btnRefreshTargets.addEventListener('click', () => refreshImportTargets(false));

  el.importTargetMode.addEventListener('change', () => {
    renderImportTargetsVisibility();
    saveSettings();
    if (el.importTargetMode.value !== 'drafts' && !state.importTargets && state.auth.authenticated) {
      refreshImportTargets(true);
    }
  });

  el.importTeamSelect.addEventListener('change', () => {
    state.config.importTeamId = el.importTeamSelect.value;
    populateImportFoldersSelect();
    saveSettings();
  });

  el.importFolderSelect.addEventListener('change', () => {
    state.config.importFolderId = el.importFolderSelect.value;
    saveSettings();
  });

  el.btnNewFigmaFolder.addEventListener('click', async () => {
    const teamId = el.importTeamSelect.value;
    if (!teamId) {
      alert('请先选择目标团队（如未加载请点「↻ 刷新团队」）');
      return;
    }
    const name = prompt('请输入要在该团队下新建的文件夹名称：');
    if (!name || !name.trim()) return;
    try {
      el.btnNewFigmaFolder.disabled = true;
      const res = await bridge.createFigmaFolder({ teamId, folderName: name.trim() });
      if (res.targets) state.importTargets = res.targets;
      if (res.folder && res.folder.id) state.config.importFolderId = res.folder.id;
      populateImportFoldersSelect();
      saveSettings();
    } catch (err) {
      alert(`新建文件夹失败: ${cleanError(err)}`);
    } finally {
      el.btnNewFigmaFolder.disabled = false;
    }
  });

  // ==================== 主按钮（导出 / 导入 / 停止 / 重试） ====================
  async function startExport(fileKeys, skipExportedOverride) {
    try {
      state.isExporting = true;
      state.exportStats = {
        total: fileKeys.length,
        completed: 0,
        exported: 0,
        skipped: 0,
        failed: 0,
        currentFile: null,
      };
      renderAll();
      await bridge.startExport({
        fileKeys,
        outputDir: state.config.outputDir,
        skipExported:
          typeof skipExportedOverride === 'boolean'
            ? skipExportedOverride
            : el.optSkipExported.checked,
        silentExport: el.optSilentExport.checked,
        timeoutSec: Number(el.optTimeoutSec.value) || 180,
      });
    } catch (err) {
      state.isExporting = false;
      renderAll();
      alert(`启动导出失败: ${cleanError(err)}`);
    }
  }

  function buildTargetConfigFromUI() {
    const mode = el.importTargetMode.value;
    if (mode === 'drafts') return { mode: 'drafts' };

    const teams = (state.importTargets && state.importTargets.teams) || [];
    const teamId = el.importTeamSelect.value;
    const team = teams.find((t) => t.id === teamId);
    if (!teamId || !team) {
      throw new Error('请先点击「↻ 刷新团队」并选择目标团队');
    }
    if (mode === 'structure') {
      return { mode: 'structure', teamId: team.id, teamName: team.name };
    }
    const folderId = el.importFolderSelect.value;
    const folder = (team.folders || []).find((f) => f.id === folderId);
    if (!folderId || !folder) {
      throw new Error('请选择目标文件夹，或点击「+ 新建」创建新文件夹');
    }
    return {
      mode: 'folder',
      teamId: team.id,
      teamName: team.name,
      folderId: folder.id,
      folderName: folder.name,
    };
  }

  async function startImport(fileIds, skipExistingOverride) {
    let targetConfig;
    try {
      targetConfig = buildTargetConfigFromUI();
    } catch (err) {
      alert(err.message);
      return;
    }

    try {
      state.isImporting = true;
      state.importStats = {
        total: fileIds.length,
        completed: 0,
        imported: 0,
        skipped: 0,
        failed: 0,
        currentFile: null,
      };
      renderAll();
      await bridge.startImport({
        fileIds,
        targetConfig,
        skipExisting:
          typeof skipExistingOverride === 'boolean'
            ? skipExistingOverride
            : el.optImportSkipExisting.checked,
        silentImport: el.optImportSilent.checked,
        timeoutSec: Number(el.optImportTimeoutSec.value) || 240,
      });
    } catch (err) {
      state.isImporting = false;
      renderAll();
      alert(`启动导入失败: ${cleanError(err)}`);
    }
  }

  el.btnPrimaryAction.addEventListener('click', () => {
    if (state.mode === 'export') {
      const keys = Array.from(state.selectedKeys);
      if (keys.length > 0) startExport(keys);
    } else {
      const ids = Array.from(state.selectedImportIds);
      if (ids.length > 0) startImport(ids);
    }
  });

  el.btnStopAction.addEventListener('click', async () => {
    try {
      el.btnStopAction.disabled = true;
      if (state.isExporting) await bridge.stopExport();
      if (state.isImporting) await bridge.stopImport();
    } finally {
      el.btnStopAction.disabled = false;
    }
  });

  el.btnRetryAction.addEventListener('click', () => {
    if (state.mode === 'export') {
      if (!state.scanResult) return;
      const failedKeys = state.scanResult.files
        .filter((f) => f.backupStatus === 'failed')
        .map((f) => f.key);
      if (failedKeys.length > 0) startExport(failedKeys, false);
    } else {
      const failedIds = state.importQueue
        .filter((f) => f.status === 'failed')
        .map((f) => f.id);
      if (failedIds.length > 0) startImport(failedIds, false);
    }
  });

  el.btnClearLogs.addEventListener('click', () => {
    el.logConsole.innerHTML = '';
  });

  // ==================== 订阅主进程实时事件 ====================
  bridge.onLog((entry) => appendLog(entry));

  bridge.onAuthUpdate((data) => {
    state.auth = { ...state.auth, ...data };
    if (data.authenticated && data.user) {
      setStatusBar('ok', `已登录 ${data.user.name}`);
    }
    renderAuth();
    if (!state.scanResult && state.mode === 'export') renderExportSection();
  });

  bridge.onScanProgress((p) => {
    if (p && p.message) setStatusBar('busy', p.message);
  });

  bridge.onExportProgress((p) => {
    if (p.stats) state.exportStats = p.stats;

    if (p.type === 'export_start') {
      state.isExporting = true;
    } else if (p.type === 'file_start') {
      state.activeExportKey = p.fileKey;
    } else if (p.type === 'file_done') {
      if (state.activeExportKey === p.fileKey) state.activeExportKey = null;
      if (state.scanResult && p.fileKey) {
        const target = state.scanResult.files.find((f) => f.key === p.fileKey);
        if (target) {
          if (p.status === 'exported' || p.status === 'skipped') {
            target.backupStatus = 'exported';
            target.lastError = null;
          } else if (p.status === 'failed') {
            target.backupStatus = 'failed';
            target.lastError = p.error || '导出失败';
          }
        }
      }
    } else if (p.type === 'export_finish') {
      state.isExporting = false;
      state.activeExportKey = null;
      setStatusBar(
        p.stats && p.stats.failed > 0 ? 'warn' : 'ok',
        `导出完成 · 成功 ${p.stats?.exported || 0} · 跳过 ${p.stats?.skipped || 0} · 失败 ${p.stats?.failed || 0}`
      );
    }
    renderAll();
  });

  bridge.onImportProgress((p) => {
    if (p.stats) state.importStats = p.stats;

    if (p.type === 'import_start') {
      state.isImporting = true;
    } else if (p.type === 'file_start') {
      state.activeImportId = p.fileId;
    } else if (p.type === 'file_done') {
      if (state.activeImportId === p.fileId) state.activeImportId = null;
      const target = state.importQueue.find((f) => f.id === p.fileId);
      if (target) {
        target.status = p.status;
        target.destinationLabel = p.destinationLabel || target.destinationLabel || null;
        target.error = p.status === 'failed' ? p.error || '导入失败' : null;
      }
    } else if (p.type === 'import_finish') {
      state.isImporting = false;
      state.activeImportId = null;
      setStatusBar(
        p.stats && p.stats.failed > 0 ? 'warn' : 'ok',
        `导入完成 · 成功 ${p.stats?.imported || 0} · 跳过 ${p.stats?.skipped || 0} · 失败 ${p.stats?.failed || 0}`
      );
    }
    renderAll();
  });

  // ==================== 初始化 ====================
  async function init() {
    try {
      const data = await bridge.getState();
      state.homeDir = data.homeDir || '';
      state.auth = data.auth;
      state.config = { ...state.config, ...data.config };
      state.isScanning = data.isScanning;
      state.isExporting = Boolean(data.exportStatus && data.exportStatus.isRunning);
      state.isImporting = Boolean(data.importStatus && data.importStatus.isRunning);

      el.optSkipExported.checked = Boolean(state.config.skipExported);
      el.optIncludeDrafts.checked = Boolean(state.config.includeDrafts);
      el.optSilentExport.checked = state.config.silentExport !== false;
      el.optTimeoutSec.value = state.config.timeoutSec || 180;

      el.importTargetMode.value = state.config.importTargetMode || 'drafts';
      el.optImportSkipExisting.checked = state.config.importSkipExisting !== false;
      el.optImportSilent.checked = state.config.importSilent !== false;
      el.optImportTimeoutSec.value = state.config.importTimeoutSec || 240;

      if (data.scanResult) {
        state.scanResult = data.scanResult;
        state.selectedKeys = new Set(data.scanResult.files.map((f) => f.key));
        setStatusBar('ok', `扫描完成 · 发现 ${data.scanResult.files.length} 个文件`);
      }

      if (data.importTargets) {
        state.importTargets = data.importTargets;
        populateImportTeamsSelect();
      }

      if (Array.isArray(data.importQueue) && data.importQueue.length > 0) {
        state.importQueue = data.importQueue;
        state.selectedImportIds = new Set(data.importQueue.map((f) => f.id));
      }

      if (data.exportStatus && data.exportStatus.stats) {
        state.exportStats = data.exportStatus.stats;
      }
      if (data.importStatus && data.importStatus.stats) {
        state.importStats = data.importStatus.stats;
      }

      if (Array.isArray(data.logs)) {
        for (const entry of data.logs) appendLog(entry);
      }

      renderExtraTeams();
      renderAll();

      if (state.isImporting) {
        switchMode('import');
      }
    } catch (err) {
      setStatusBar('warn', `初始化失败: ${cleanError(err)}`);
    }
  }

  init();
})();
