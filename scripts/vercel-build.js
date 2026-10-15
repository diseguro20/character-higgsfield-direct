const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const installer = path.join(__dirname, '..', 'node_modules', '@higgsfield', 'cli', 'install.js');
const installed = spawnSync(process.execPath, [installer], { stdio: 'inherit' });
if (installed.status !== 0) process.exit(installed.status || 1);

if (process.platform !== 'win32') {
  fs.chmodSync(require('@ffmpeg-installer/ffmpeg').path, 0o755);
  fs.chmodSync(require('@ffprobe-installer/ffprobe').path, 0o755);
}
