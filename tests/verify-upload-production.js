// Read-only Higgsfield test: uploads a synthetic video to production, then removes its clip record.
// This never calls a generation endpoint or consumes Higgsfield credits.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const base = 'https://character-higgsfield-direct.vercel.app';
const key = fs.readFileSync(path.join(os.homedir(), '.config', 'character-school', 'owner-access-key.txt'), 'utf8').trim();
const file = path.join(os.tmpdir(), 'character-upload-diagnostic.mp4');
let cookie = '';
async function api(method, route, body) {
  const response = await fetch(base + route, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000)
  });
  cookie = /^character_session=[^;]+/.exec(response.headers.get('set-cookie') || '')?.[0] || cookie;
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${data.error || 'erro'}`);
  return data;
}
(async () => {
  let clip;
  try {
    await api('POST', '/api/auth/owner', { key });
    const buffer = fs.readFileSync(file);
    const prepared = await api('POST', '/api/uploads/prepare', { name: path.basename(file), contentType: 'video/mp4', size: buffer.length });
    const sent = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'Content-Type': prepared.contentType }, body: buffer, signal: AbortSignal.timeout(120000) });
    if (!sent.ok) throw new Error(`Blob PUT: HTTP ${sent.status}: ${(await sent.text()).slice(0, 300)}`);
    console.log(`Direct Blob PUT OK (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`);
    clip = await api('POST', '/api/clips', { uploadName: prepared.uploadName, name: path.basename(file) });
    if (!clip?.id || Math.abs(clip.info?.duration - 4) > 0.2) throw new Error(`Clip metadata invalid: ${clip?.info?.duration}`);
    console.log(`Production video upload OK: ${clip.info.duration}s.`);
  } finally {
    if (clip?.id) await api('DELETE', `/api/clips/${clip.id}`).catch(() => {});
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
