const fs = require('fs');
const {
  computeDuplicateNameKeys,
  buildTargetFilePath,
  loadManifest,
  getExtensionForEditorType,
} = require('./utils');

function responseList(data, ...keys) {
  const meta = data?.meta ?? data;
  if (Array.isArray(meta)) return meta;
  return keys.map((key) => meta?.[key]).find(Array.isArray) ?? null;
}

function describeFailure(response) {
  if (response.ok) return '响应结构无法识别';
  return response.status ? `HTTP ${response.status}` : '请求失败';
}

class FigmaScanner {
  constructor(browserManager, onLog = () => {}, onProgress = () => {}) {
    this.browser = browserManager;
    this.onLog = onLog;
    this.onProgress = onProgress;
  }

  /**
   * 规范化单个 Figma 文件对象
   */
  normalizeFile(raw, teamId, teamName, folderId, folderName, isDraft = false) {
    if (!raw || !raw.key) return null;
    // 忽略回收站中的文件
    if (raw.trashed_at || raw.deleted_at) return null;

    const editorType = raw.editor_type || raw.editorType || 'design';
    return {
      key: String(raw.key),
      name: raw.name || 'Untitled',
      editorType,
      extension: getExtensionForEditorType(editorType),
      teamId: String(teamId),
      teamName: teamName || 'Unknown Team',
      folderId: String(folderId),
      folderName: folderName || 'Uncategorized',
      isDraft,
      updatedAt: raw.updated_at || raw.touched_at || raw.last_modified || null,
      thumbnailUrl: raw.thumbnail_url || null,
      url: raw.url || null,
    };
  }

  /**
   * 获取某个文件夹（Project / Drafts）下的全部文件，自动处理分页
   */
  async fetchFolderFiles(folderId, teamId, teamName, folderName, isDraft = false) {
    const filesMap = new Map();
    const addFiles = (items) => {
      for (const item of items) {
        const norm = this.normalizeFile(item, teamId, teamName, folderId, folderName, isDraft);
        if (norm) filesMap.set(norm.key, norm);
      }
    };

    const query = new URLSearchParams({
      folderId,
      sort_column: 'touched_at',
      sort_order: 'desc',
      fetch_only_trashed_with_folder_files: 'false',
      page_size: '100',
      file_type: '',
    });
    const folderPath = `/api/folders/${encodeURIComponent(folderId)}`;
    let nextUrl = `${folderPath}/paginated_files?${query}`;
    const visited = new Set();

    while (typeof nextUrl === 'string' && !visited.has(nextUrl)) {
      visited.add(nextUrl);
      const res = await this.browser.fetchFigmaJson(nextUrl);
      const list = res.ok ? responseList(res.data, 'files', 'rows') : null;
      if (!list) break;

      addFiles(list);
      const meta = res.data.meta ?? res.data;
      nextUrl = res.data.pagination?.next_page ?? meta.pagination?.next_page ?? meta.next_page ?? null;
    }

    if (nextUrl) {
      const res = await this.browser.fetchFigmaJson(
        `${folderPath}/files?fetch_only_trashed_with_folder_files=false`
      );
      const list = res.ok ? responseList(res.data, 'files', 'rows') : null;
      if (list) addFiles(list);
      else this.onLog('warn', `未能完整读取「${teamName} / ${folderName}」的文件列表`);
    }

    return Array.from(filesMap.values());
  }

  /**
   * 获取指定 Team 下的全部文件夹（Projects）
   */
  async fetchTeamFolders(teamId) {
    const teamPath = `/api/teams/${encodeURIComponent(teamId)}`;
    const endpoints = [
      `${teamPath}/folders`,
      `${teamPath}/projects`,
    ];

    const failures = [];
    for (const ep of endpoints) {
      const res = await this.browser.fetchFigmaJson(ep);
      const rawFolders = res.ok ? responseList(res.data, 'folder_rows', 'folders', 'projects') : null;

      if (rawFolders) {
        return rawFolders
          .filter((f) => f && f.id && !f.trashed_at && !f.deleted_at)
          .map((f) => ({
            id: String(f.id),
            name: f.path || f.name || `Folder ${f.id}`,
            teamId: String(teamId),
          }));
      }
      failures.push(describeFailure(res));
    }
    this.onLog('warn', `无法读取团队 ${teamId} 的文件夹列表（${failures.join(' / ')}）`);
    return [];
  }

  async discoverTeams(auth, extraTeamIds) {
    const teams = new Map();
    const orgs = new Map();
    const addTeam = (team, org) => {
      if (!team?.id || team.trashed_at || team.deleted_at) return;
      const id = String(team.id);
      const existing = teams.get(id);
      const orgId = org?.id || team.org_id || existing?.orgId;
      teams.set(id, {
        id,
        name: team.name || existing?.name || `Team ${id}`,
        orgId: orgId ? String(orgId) : null,
        orgName: org?.name || existing?.orgName || null,
        ...(team.manual && { manual: true }),
      });
    };
    const addOrg = (org) => {
      if (org?.id && !org.deleted_at) orgs.set(String(org.id), org);
    };

    const session = auth.sessionMeta;
    if (Array.isArray(session?.teams)) session.teams.forEach((team) => addTeam(team));
    if (Array.isArray(session?.orgs)) session.orgs.forEach(addOrg);

    // Figma 的文件浏览器单独请求当前账号的 plans 和团队成员关系。
    const userId = auth.user.id;
    const [plans, memberships] = await Promise.all([
      this.browser.fetchFigmaJson('/api/user/plans'),
      userId && userId !== 'current'
        ? this.browser.fetchFigmaJson(`/api/user/${encodeURIComponent(userId)}/teams`)
        : null,
    ]);
    const planTeams = plans.ok ? responseList(plans.data, 'teams') : null;
    const planOrgs = plans.ok ? responseList(plans.data, 'orgs') : null;
    if (!planTeams && !planOrgs) {
      this.onLog('warn', `无法读取当前账号的方案列表（${describeFailure(plans)}）`);
    }
    for (const team of planTeams || []) addTeam(team);
    for (const org of planOrgs || []) addOrg(org);

    const memberTeams = memberships?.ok ? responseList(memberships.data, 'teams') : null;
    if (memberships && !memberTeams) {
      this.onLog('warn', `无法读取当前账号的团队列表（${describeFailure(memberships)}）`);
    }
    for (const team of memberTeams || []) addTeam(team);

    for (const org of orgs.values()) {
      this.onLog('info', `发现组织「${org.name || org.id}」，正在拉取组织内团队...`);
      const res = await this.browser.fetchFigmaJson(`/api/orgs/${encodeURIComponent(org.id)}/teams`);
      const list = res.ok ? responseList(res.data, 'teams') : null;
      if (!list) {
        this.onLog('warn', `无法读取组织「${org.name || org.id}」的团队列表（${describeFailure(res)}）`);
      }
      for (const team of list || []) addTeam(team, org);
    }

    if (teams.size === 0 && typeof this.browser.discoverTeamsFromSidebarDom === 'function') {
      for (const team of await this.browser.discoverTeamsFromSidebarDom()) addTeam(team);
    }

    for (const rawId of extraTeamIds) {
      const id = String(rawId).trim();
      if (!id || teams.has(id)) continue;
      const res = await this.browser.fetchFigmaJson(`/api/teams/${encodeURIComponent(id)}`);
      addTeam({ id, name: res.ok ? res.data?.meta?.name : null, manual: true });
    }

    return Array.from(teams.values());
  }

  /**
   * 扫描当前登录账号下所有可见团队、组织团队、草稿箱和全部文件夹中的文件
   */
  async scanAll({ outputDir, extraTeamIds = [], includeDrafts = true } = {}) {
    const auth = await this.browser.checkAuthStatus({ openIfClosed: true });
    if (!auth.authenticated) {
      throw new Error('尚未登录 Figma，请先点击「打开浏览器登录 Figma」完成登录');
    }

    this.onLog('info', `开始扫描账号 ${auth.user.name} 下的所有团队与文件夹...`);
    this.onProgress({ phase: 'discovering_teams', message: '正在获取团队与组织列表...' });

    const teamList = await this.discoverTeams(auth, extraTeamIds);
    if (teamList.length === 0) {
      this.onLog('warn', '未发现任何 Figma 团队。可以通过「补充团队」添加团队链接后重新扫描。');
    }
    const teamsResult = [];
    const allFiles = [];

    // 扫描个人草稿箱 (Drafts)
    if (includeDrafts) {
      this.onProgress({ phase: 'scanning_drafts', message: '正在扫描个人草稿 (Drafts)...' });
      const draftFilesMap = new Map();
      const draftsFolderId = auth.user.draftsFolderId;

      if (draftsFolderId) {
        const files = await this.fetchFolderFiles(
          draftsFolderId,
          'drafts',
          'Drafts (个人草稿)',
          'Drafts',
          true
        );
        for (const f of files) draftFilesMap.set(f.key, f);
      }

      // 备用草稿接口
      if (draftFilesMap.size === 0) {
        const res = await this.browser.fetchFigmaJson('/api/user/drafts');
        if (res.ok && res.data) {
          const list = responseList(res.data, 'files') || [];
          for (const item of list) {
            const norm = this.normalizeFile(
              item,
              'drafts',
              'Drafts (个人草稿)',
              draftsFolderId || 'drafts',
              'Drafts',
              true
            );
            if (norm) draftFilesMap.set(norm.key, norm);
          }
        }
      }

      const draftFiles = Array.from(draftFilesMap.values());
      if (draftFiles.length > 0) {
        teamsResult.push({
          id: 'drafts',
          name: 'Drafts (个人草稿)',
          isDrafts: true,
          folders: [
            {
              id: draftsFolderId || 'drafts',
              name: 'Drafts',
              files: draftFiles,
            },
          ],
        });
        allFiles.push(...draftFiles);
        this.onLog('info', `个人草稿 (Drafts): 发现 ${draftFiles.length} 个文件`);
      }
    }

    // 逐个扫描团队下的文件夹与文件
    this.onLog('info', `共发现 ${teamList.length} 个团队，开始扫描各团队文件夹...`);

    for (let i = 0; i < teamList.length; i++) {
      const team = teamList[i];
      this.onProgress({
        phase: 'scanning_teams',
        current: i + 1,
        total: teamList.length,
        message: `正在扫描团队 (${i + 1}/${teamList.length}): ${team.name}`,
      });

      const folders = await this.fetchTeamFolders(team.id);
      const folderResults = [];
      let teamFileCount = 0;

      for (const folder of folders) {
        const files = await this.fetchFolderFiles(
          folder.id,
          team.id,
          team.name,
          folder.name,
          false
        );
        teamFileCount += files.length;
        folderResults.push({
          id: folder.id,
          name: folder.name,
          files,
        });
        allFiles.push(...files);
      }

      teamsResult.push({
        id: team.id,
        name: team.name,
        orgName: team.orgName || null,
        isDrafts: false,
        folders: folderResults,
      });

      this.onLog(
        'info',
        `团队「${team.name}」: ${folders.length} 个文件夹，共 ${teamFileCount} 个文件`
      );
    }

    // 结合本地 export-manifest.json 标注每个文件的导出状态
    const manifest = outputDir ? loadManifest(outputDir) : { files: {} };
    const dupSet = computeDuplicateNameKeys(allFiles);

    for (const file of allFiles) {
      const targetPath = outputDir
        ? buildTargetFilePath(outputDir, file, dupSet)
        : null;
      file.targetPath = targetPath;

      const record = manifest.files[file.key];
      if (record && record.status === 'exported' && record.localPath && fs.existsSync(record.localPath)) {
        if (file.updatedAt && record.remoteUpdatedAt && file.updatedAt !== record.remoteUpdatedAt) {
          file.backupStatus = 'outdated';
        } else {
          file.backupStatus = 'exported';
        }
        file.lastExportedAt = record.exportedAt || null;
        file.fileSize = record.fileSize || null;
      } else if (record && record.status === 'failed') {
        file.backupStatus = 'failed';
        file.lastError = record.error || null;
      } else if (targetPath && fs.existsSync(targetPath)) {
        file.backupStatus = 'exported';
      } else {
        file.backupStatus = 'pending';
      }
    }

    const summary = {
      teamCount: teamsResult.length,
      folderCount: teamsResult.reduce((acc, t) => acc + t.folders.length, 0),
      fileCount: allFiles.length,
      exportedCount: allFiles.filter((f) => f.backupStatus === 'exported').length,
      outdatedCount: allFiles.filter((f) => f.backupStatus === 'outdated').length,
      pendingCount: allFiles.filter((f) => f.backupStatus === 'pending').length,
      failedCount: allFiles.filter((f) => f.backupStatus === 'failed').length,
    };

    this.onLog(
      'success',
      `扫描完成！共 ${summary.teamCount} 个团队/草稿箱，${summary.folderCount} 个文件夹，${summary.fileCount} 个设计文件。`
    );

    return {
      scannedAt: new Date().toISOString(),
      user: auth.user,
      summary,
      teams: teamsResult,
      files: allFiles,
    };
  }

  /**
   * 快速列出当前账号可用于「批量导入」的目标团队与文件夹列表（无需遍历所有文件，秒级返回）
   */
  async listTargets({ extraTeamIds = [] } = {}) {
    const auth = await this.browser.checkAuthStatus();
    if (!auth.authenticated) {
      throw new Error('尚未登录 Figma，请先点击右上角「登录 Figma」完成登录');
    }

    const teamList = await this.discoverTeams(auth, extraTeamIds);
    const teamsWithFolders = [];

    for (const team of teamList) {
      const folders = await this.fetchTeamFolders(team.id);
      teamsWithFolders.push({
        id: team.id,
        name: team.name,
        orgName: team.orgName || null,
        folders,
      });
    }

    return {
      user: auth.user,
      draftsFolderId: auth.user.draftsFolderId || null,
      teams: teamsWithFolders,
    };
  }

  /**
   * 在指定团队下新建文件夹（Project），用于按本地目录结构导入时自动创建同名文件夹
   */
  async createFolder(teamId, folderName) {
    const cleanName = String(folderName || '').trim();
    if (!teamId || !cleanName) {
      throw new Error('团队 ID 和文件夹名称不能为空');
    }

    // 先检查是否已经存在同名文件夹（忽略大小写）
    const existing = await this.fetchTeamFolders(teamId);
    const matched = existing.find(
      (f) => f.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (matched) return matched;

    const payloads = [
      ['/api/folders', { team_id: String(teamId), path: cleanName }],
      ['/api/folders', { team_id: String(teamId), name: cleanName, path: cleanName }],
      [`/api/teams/${encodeURIComponent(teamId)}/folders`, { path: cleanName, name: cleanName }],
    ];

    let lastErr = '';
    for (const [ep, body] of payloads) {
      const res = await this.browser.mutateFigmaJson(ep, 'POST', body);
      if (res.ok && res.data) {
        const meta = res.data.meta ?? res.data;
        const folderObj = meta.folder || meta;
        if (folderObj && folderObj.id) {
          const created = {
            id: String(folderObj.id),
            name: folderObj.path || folderObj.name || cleanName,
            teamId: String(teamId),
          };
          this.onLog('success', `已在团队下自动创建文件夹「${created.name}」`);
          return created;
        }
      }
      lastErr = res.data?.message || res.data?.error || (res.status ? `HTTP ${res.status}` : res.error || '');
    }

    // 再次拉取文件夹列表确认是否已创建成功
    const refreshed = await this.fetchTeamFolders(teamId);
    const afterMatch = refreshed.find(
      (f) => f.name.trim().toLowerCase() === cleanName.toLowerCase()
    );
    if (afterMatch) return afterMatch;

    throw new Error(
      `无法在目标团队新建文件夹「${cleanName}」${lastErr ? ` (${lastErr})` : '，请检查是否有该团队的新建项目权限或团队是否已锁定'}`
    );
  }
}

module.exports = { FigmaScanner };
