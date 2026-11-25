const fs = require('fs');
const path = require('path');

/**
 * 将团队名、文件夹名、文件名清理为安全的 macOS / Windows 文件系统名称
 */
function sanitizeName(name, fallback = 'Untitled') {
  if (!name || typeof name !== 'string') return fallback;
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
  if (!cleaned) return fallback;
  // 限制单段名称长度，避免路径过长
  return cleaned.slice(0, 120);
}

/**
 * 根据 Figma 文件的 editor_type 返回对应的本地导出后缀
 */
function getExtensionForEditorType(editorType) {
  switch ((editorType || 'design').toLowerCase()) {
    case 'whiteboard':
    case 'figjam':
      return '.jam';
    case 'slides':
      return '.deck';
    case 'sites':
      return '.site';
    case 'buzz':
      return '.buzz';
    case 'design':
    default:
      return '.fig';
  }
}

/**
 * 根据 Figma 文件的 editor_type 返回对应的 URL 路径前缀
 */
function getUrlPrefixForEditorType(editorType) {
  switch ((editorType || 'design').toLowerCase()) {
    case 'whiteboard':
    case 'figjam':
      return 'board';
    case 'slides':
      return 'slides';
    case 'sites':
      return 'site';
    case 'buzz':
      return 'buzz';
    case 'design':
    default:
      return 'design';
  }
}

/**
 * 生成不冲突的目标路径，支持同文件夹下重名文件自动追加短 key
 */
function buildTargetFilePath(outputDir, file, duplicateNamesSet) {
  const teamDir = sanitizeName(file.teamName, 'Unknown Team');
  const folderDir = sanitizeName(file.folderName, 'Uncategorized');
  const baseName = sanitizeName(file.name, file.key);
  const ext = getExtensionForEditorType(file.editorType);

  const uniqueKey = `${teamDir}::${folderDir}::${baseName.toLowerCase()}`;
  const finalBase = duplicateNamesSet && duplicateNamesSet.has(uniqueKey)
    ? `${baseName}_${file.key.slice(0, 6)}`
    : baseName;

  return path.join(outputDir, teamDir, folderDir, `${finalBase}${ext}`);
}

/**
 * 计算同一 Team + Folder 下是否有重名文件
 */
function computeDuplicateNameKeys(files) {
  const counts = new Map();
  for (const f of files) {
    const teamDir = sanitizeName(f.teamName, 'Unknown Team');
    const folderDir = sanitizeName(f.folderName, 'Uncategorized');
    const baseName = sanitizeName(f.name, f.key).toLowerCase();
    const key = `${teamDir}::${folderDir}::${baseName}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const dups = new Set();
  for (const [k, c] of counts.entries()) {
    if (c > 1) dups.add(k);
  }
  return dups;
}

/**
 * 确保目录存在
 */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * 读取/保存导出清单 export-manifest.json（用于断点续传和增量备份）
 */
function getManifestPath(outputDir) {
  return path.join(outputDir, 'export-manifest.json');
}

function loadManifest(outputDir) {
  const manifestPath = getManifestPath(outputDir);
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, updatedAt: null, files: {} };
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.files) {
      return { version: 1, updatedAt: null, files: {} };
    }
    return parsed;
  } catch {
    return { version: 1, updatedAt: null, files: {} };
  }
}

function saveManifest(outputDir, manifest) {
  ensureDir(outputDir);
  manifest.updatedAt = new Date().toISOString();
  const manifestPath = getManifestPath(outputDir);
  const tmpPath = `${manifestPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.renameSync(tmpPath, manifestPath);
}

/**
 * 解析用户粘贴的 Figma Team URL 或纯 Team ID
 * 支持:
 *   https://www.figma.com/files/team/1234567890/...
 *   https://www.figma.com/files/123/team/1234567890/...
 *   1234567890
 */
function parseTeamIdInput(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/team\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d{5,}$/.test(trimmed)) return trimmed;
  return null;
}

const IMPORTABLE_EXTENSIONS = new Set(['.fig', '.jam', '.deck', '.sketch']);

/**
 * 判断文件后缀是否为可导入 Figma 的设计文件
 */
function isImportableFigmaFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return IMPORTABLE_EXTENSIONS.has(ext);
}

/**
 * 从本地文件名推导导入到 Figma 后的预期文件标题（去掉后缀，以及可选的导出防重名短后缀）
 */
function inferFigmaTitleFromPath(filePath) {
  const ext = path.extname(filePath);
  return path.basename(filePath, ext).trim() || 'Untitled';
}

/**
 * 扫描本地文件/文件夹列表，递归收集全部可导入的设计文件，并推断建议的文件夹名
 */
function collectLocalImportFiles(inputPaths) {
  const results = [];
  const seenPaths = new Set();

  function addSingleFile(fullPath, rootDir = null, manifestMap = null) {
    const resolved = path.resolve(fullPath);
    if (seenPaths.has(resolved)) return;
    if (!isImportableFigmaFile(resolved)) return;
    let stat;
    try {
      stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size === 0) return;
    } catch {
      return;
    }

    seenPaths.add(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const manifestEntry = manifestMap ? manifestMap.get(resolved) : null;

    let suggestedFolder = '';
    let suggestedTeam = '';
    if (manifestEntry) {
      suggestedFolder = manifestEntry.folderName || '';
      suggestedTeam = manifestEntry.teamName || '';
    } else if (rootDir) {
      const relDir = path.relative(rootDir, path.dirname(resolved));
      if (!relDir || relDir === '.') {
        suggestedFolder = path.basename(rootDir);
      } else {
        const parts = relDir.split(path.sep).filter(Boolean);
        if (parts.length >= 2) {
          suggestedTeam = parts[0];
          suggestedFolder = parts.slice(1).join(' - ');
        } else {
          suggestedFolder = parts[0];
        }
      }
    } else {
      suggestedFolder = path.basename(path.dirname(resolved));
    }

    results.push({
      id: resolved,
      localPath: resolved,
      fileName: path.basename(resolved),
      title: manifestEntry?.name || inferFigmaTitleFromPath(resolved),
      extension: ext,
      fileSize: stat.size,
      suggestedTeam,
      suggestedFolder: suggestedFolder || 'Imported',
      status: 'pending',
      error: null,
    });
  }

  function walkDir(dirPath, rootDir, manifestMap) {
    let entries;
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walkDir(full, rootDir, manifestMap);
      } else if (entry.isFile()) {
        addSingleFile(full, rootDir, manifestMap);
      }
    }
  }

  for (const rawPath of inputPaths || []) {
    if (!rawPath || typeof rawPath !== 'string') continue;
    const resolved = path.resolve(rawPath);
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // 如果目录下存在 export-manifest.json，利用其元数据还原原始文件夹名称
      const manifestMap = new Map();
      const manifest = loadManifest(resolved);
      for (const rec of Object.values(manifest.files || {})) {
        if (rec && rec.localPath) {
          manifestMap.set(path.resolve(rec.localPath), rec);
        }
      }
      walkDir(resolved, resolved, manifestMap);
    } else if (stat.isFile()) {
      addSingleFile(resolved, null, null);
    }
  }

  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  sanitizeName,
  getExtensionForEditorType,
  getUrlPrefixForEditorType,
  buildTargetFilePath,
  computeDuplicateNameKeys,
  ensureDir,
  getManifestPath,
  loadManifest,
  saveManifest,
  parseTeamIdInput,
  IMPORTABLE_EXTENSIONS,
  isImportableFigmaFile,
  inferFigmaTitleFromPath,
  collectLocalImportFiles,
  sleep,
};
