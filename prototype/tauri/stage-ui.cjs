const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const output = path.join(__dirname, 'generated-ui');
fs.mkdirSync(output, { recursive: true });
for (const asset of ['app.js', 'styles.css']) {
  fs.copyFileSync(path.join(root, 'public', asset), path.join(output, asset));
}
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const entry = '<script src="./app.js"></script>';
if (!html.includes(entry)) throw Error('The shared renderer entry script was not found');
fs.writeFileSync(path.join(output, 'index.html'), html.replace(entry, `<script src="./tauri-runtime.js"></script>\n  ${entry}`));

const modules = ['utils', 'scanner', 'electronExporter', 'electronImporter', 'appController'].map(name => {
  const source = fs.readFileSync(path.join(root, 'src', `${name}.js`), 'utf8');
  return `define(${JSON.stringify(`./${name}`)}, function(require, module) {\n${source}\n});`;
}).join('\n');
const bridge = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8');
fs.writeFileSync(path.join(output, 'tauri-runtime.js'), `(() => {\n${bridge}\n${modules}\n${preload}\nconnectNativeWindow();\n})();\n`);
