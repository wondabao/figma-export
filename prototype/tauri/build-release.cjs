const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tauriRoot = __dirname;
const repoRoot = path.resolve(__dirname, '../..');
const distDir = path.join(repoRoot, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const version = pkg.version;

const args = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const rustTarget = targetIdx >= 0 ? args[targetIdx + 1] : '';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const bundleType = isMac ? 'dmg' : isWin ? 'nsis' : 'appimage';

const tauriArgs = ['tauri', 'build', '--bundles', bundleType];
if (rustTarget) {
  tauriArgs.push('--target', rustTarget);
}

const npxCmd = isWin ? 'npx.cmd' : 'npx';
const res = spawnSync(npxCmd, tauriArgs, {
  cwd: tauriRoot,
  stdio: 'inherit',
  shell: isWin,
});
if (res.status !== 0) {
  process.exit(res.status || 1);
}

const targetBase = rustTarget
  ? path.join(tauriRoot, 'src-tauri', 'target', rustTarget, 'release', 'bundle')
  : path.join(tauriRoot, 'src-tauri', 'target', 'release', 'bundle');

fs.mkdirSync(distDir, { recursive: true });

if (isMac) {
  const dmgDir = path.join(targetBase, 'dmg');
  const dmgFile = fs.readdirSync(dmgDir).find((f) => f.endsWith('.dmg'));
  if (!dmgFile) {
    throw new Error(`未在 ${dmgDir} 找到生成的 .dmg 文件`);
  }
  const arch =
    rustTarget === 'x86_64-apple-darwin'
      ? 'x64'
      : rustTarget === 'aarch64-apple-darwin'
        ? 'arm64'
        : process.arch === 'arm64'
          ? 'arm64'
          : 'x64';
  const outPath = path.join(distDir, `${pkg.name}-${version}-mac-${arch}.dmg`);
  fs.copyFileSync(path.join(dmgDir, dmgFile), outPath);
  console.log(`Copied DMG installer -> ${outPath}`);
} else if (isWin) {
  const nsisDir = path.join(targetBase, 'nsis');
  const exeFile = fs.readdirSync(nsisDir).find((f) => f.endsWith('-setup.exe') || f.endsWith('.exe'));
  if (!exeFile) {
    throw new Error(`未在 ${nsisDir} 找到生成的 .exe 安装包`);
  }
  const arch = rustTarget === 'aarch64-pc-windows-msvc' ? 'arm64' : 'x64';
  const outPath = path.join(distDir, `${pkg.name}-${version}-win-${arch}-setup.exe`);
  fs.copyFileSync(path.join(nsisDir, exeFile), outPath);
  console.log(`Copied NSIS installer -> ${outPath}`);
}
