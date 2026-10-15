const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = path.join(__dirname, '..', 'node_modules', '@higgsfield', 'cli', 'install.js');
const installed = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
if (installed.status !== 0) process.exit(installed.status || 1);

const vendor = path.join(__dirname, '..', 'vendor');
fs.mkdirSync(vendor, { recursive: true });
const extension = process.platform === 'win32' ? '.exe' : '';
for (const [name, source] of [
  ['hf', path.join(__dirname, '..', 'node_modules', '@higgsfield', 'cli', 'vendor', `hf${extension}`)],
  ['ffmpeg', require('@ffmpeg-installer/ffmpeg').path],
  ['ffprobe', require('@ffprobe-installer/ffprobe').path]
]) {
  const target = path.join(vendor, name + extension);
  fs.copyFileSync(source, target);
  if (process.platform !== 'win32') fs.chmodSync(target, 0o755);
}
