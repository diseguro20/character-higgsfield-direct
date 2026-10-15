// Manual status check for the job created by verify-take-production.js.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.join(__dirname, '..');
const npx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const key = fs.readFileSync(path.join(os.homedir(), '.config', 'character-school', 'owner-access-key.txt'), 'utf8').trim();
const record = JSON.parse(fs.readFileSync(path.join(root, '.production-test-job.json'), 'utf8'));

function call(route, args = []) {
  const run = spawnSync(process.execPath, [npx, 'vercel', 'curl', route, '--', '--silent', '--show-error', '--dump-header', '-', ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (run.status !== 0) throw new Error((run.stderr || run.error?.message || '').slice(-300));
  const output = run.stdout.replace(/\r\n/g, '\n');
  const at = output.lastIndexOf('\n\n');
  if (at < 0) throw new Error('HTTP headers missing.');
  return { headers: output.slice(0, at), body: JSON.parse(output.slice(at + 2)) };
}
const login = call('/api/auth/owner', ['--request', 'POST', '--header', 'Content-Type: application/json', '--data', JSON.stringify({ key })]);
const cookie = /^set-cookie:\s*(character_session=[^;]+)/im.exec(login.headers)?.[1];
if (!cookie) throw new Error('Owner login failed.');
const job = call(`/api/jobs/${record.id}/status`, ['--header', `Cookie: ${cookie}`]).body;
if (job.error) throw new Error(job.error);
console.log(`Production take status: ${job.status}, provider: ${job.providerStatus}, video: ${!!job.outputs?.masterUrl}.`);
if (job.status === 'failed') process.exitCode = 1;
if (job.status === 'done') {
  if (!/^https:\/\//.test(job.outputs.masterUrl)) throw new Error('Video URL is not HTTPS.');
  fetch(job.outputs.masterUrl, { method: 'HEAD' }).then(response => {
    if (!response.ok) throw new Error(`Video URL returned HTTP ${response.status}.`);
    console.log(`Production video URL reachable: HTTP ${response.status}.`);
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
