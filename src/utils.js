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
  const finalBase =
    duplicateNamesSet && duplicateNamesSet.has(uniqueKey)
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
 * 解析用户粘贴的 Figma Team URL 或纯 Team ID
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

function isImportableFigmaFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  const ext = path.extname(filePath).toLowerCase();
  return IMPORTABLE_EXTENSIONS.has(ext);
}

function inferFigmaTitleFromPath(filePath) {
  const ext = path.extname(filePath);
  return path.basename(filePath, ext).trim() || 'Untitled';
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
  parseTeamIdInput,
  IMPORTABLE_EXTENSIONS,
  isImportableFigmaFile,
  inferFigmaTitleFromPath,
  sleep,
};
