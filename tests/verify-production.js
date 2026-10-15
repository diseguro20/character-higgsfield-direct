// Manual production check. Reads the local owner key, but never prints it or the session cookie.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ownerKey = fs.readFileSync(path.join(os.homedir(), '.config', 'character-school', 'owner-access-key.txt'), 'utf8').trim();
function call(route, extra = []) {
  const npx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
  const result = spawnSync(process.execPath, [npx, 'vercel', 'curl', route, '--', '--silent', '--show-error', '--dump-header', '-', ...extra], {
    cwd: path.join(os.homedir(), 'Downloads', 'CLONE_app_charactersschool_com_1791837845545'),
    encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) throw new Error(`vercel curl failed: ${(result.stderr || result.error?.message || '').slice(-300)}`);
  const split = result.stdout.lastIndexOf('\r\n\r\n');
  const normalized = split < 0 ? result.stdout.replace(/\r\n/g, '\n') : result.stdout;
  const at = split < 0 ? normalized.lastIndexOf('\n\n') : split;
  if (at < 0) throw new Error('HTTP headers missing');
  const headers = normalized.slice(0, at);
  const body = normalized.slice(at + (split < 0 ? 2 : 4));
  return { headers, body: JSON.parse(body) };
}

const anonymous = call('/api/state');
if (anonymous.body.auth !== 'login') throw new Error('Anonymous visitors are not gated.');
const login = call('/api/auth/owner', ['--request', 'POST', '--header', 'Content-Type: application/json', '--data', JSON.stringify({ key: ownerKey })]);
const cookie = /^set-cookie:\s*(character_session=[^;]+)/im.exec(login.headers)?.[1];
if (!cookie || !login.body.ok) throw new Error('Owner login failed.');
const status = call('/api/higgsfield/cli-status', ['--header', `Cookie: ${cookie}`]);
if (!status.body.ready || !Number.isFinite(Number(status.body.credits))) throw new Error(`CLI status failed: ${JSON.stringify(status.body)}`);
console.log(`Production anonymous gate + owner OAuth CLI OK: ${status.body.credits} credits.`);
const start = call('/api/auth/higgsfield/start', ['--request', 'POST', '--header', 'Content-Type: application/json', '--data', '{}']);
const authorization = new URL(start.body.login?.authorizeUrl || '');
if (authorization.hostname !== 'clerk.higgsfield.ai') throw new Error('Higgsfield OAuth start did not return Clerk URL.');
if (authorization.searchParams.get('redirect_uri') !== 'http://localhost:8765/callback') throw new Error('Higgsfield CLI callback is not registered.');
fetch(authorization, { redirect: 'manual' }).then(async response => {
  const body = await response.text();
  if (/invalid.redirect|redirect.uri.*(invalid|unauthori|mismatch)/i.test(body)) throw new Error('Higgsfield rejected the OAuth redirect URI.');
  const location = response.headers.get('location');
  const next = location ? new URL(location, authorization) : null;
  if (next?.searchParams.has('error')) throw new Error(`Higgsfield OAuth error: ${next.searchParams.get('error')}`);
  console.log(`Higgsfield OAuth authorization endpoint reachable: HTTP ${response.status}, next ${next?.hostname || 'none'}${next?.pathname || ''}.`);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
