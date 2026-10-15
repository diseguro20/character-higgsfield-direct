// Manual paid integration test. Uses 4 synthetic seconds (expected quote: 28 credits).
// Reads the local owner key without displaying it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;

const root = path.join(__dirname, '..');
const npx = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js');
const key = fs.readFileSync(path.join(os.homedir(), '.config', 'character-school', 'owner-access-key.txt'), 'utf8').trim();
let cookie = '';
function call(route, args = []) {
  const result = spawnSync(process.execPath, [npx, 'vercel', 'curl', route, '--', '--silent', '--show-error', '--dump-header', '-',
    ...(cookie ? ['--header', `Cookie: ${cookie}`] : []), ...args], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Request failed: ${(result.stderr || result.error?.message || '').slice(-300)}`);
  const normalized = result.stdout.replace(/\r\n/g, '\n');
  const at = normalized.lastIndexOf('\n\n');
  if (at < 0) throw new Error('HTTP response missing');
  const headers = normalized.slice(0, at);
  cookie = /^set-cookie:\s*(character_session=[^;]+)/im.exec(headers)?.[1] || cookie;
  const body = JSON.parse(normalized.slice(at + 2));
  if (body.error) throw new Error(body.error);
  return body;
}
const json = (route, body) => call(route, ['--request', 'POST', '--header', 'Content-Type: application/json', '--data', JSON.stringify(body)]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-live-take-'));
try {
  const image = path.join(dir, 'person.png');
  const video = path.join(dir, 'clip.mp4');
  for (const args of [
    ['-f', 'lavfi', '-i', 'color=c=red:s=512x512', '-frames:v', '1', '-update', '1', '-y', image],
    ['-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=24', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video]
  ]) {
    const made = spawnSync(ffmpeg, ['-loglevel', 'error', ...args], { encoding: 'utf8' });
    if (made.status !== 0) throw new Error(made.stderr);
  }
  json('/api/auth/owner', { key });
  const character = json('/api/characters', { name: 'Teste Genjutsu OAuth' });
  const photo = call(`/api/characters/${character.id}/images?name=person.png`, ['--request', 'POST', '--header', 'Content-Type: image/png', '--data-binary', `@${image}`]);
  if (!photo.images?.length) throw new Error('Photo upload failed');
  console.log('Production character photo uploaded.');
  const clip = call('/api/clips?name=clip.mp4', ['--request', 'POST', '--header', 'Content-Type: video/mp4', '--data-binary', `@${video}`]);
  if (!clip.id) throw new Error('Video upload failed');
  console.log(`Production clip uploaded: ${clip.info?.duration}s.`);
  const quote = json('/api/estimate', { clipIds: [clip.id], swapModels: ['hf-genjutsu-720p'] });
  if (quote.credits !== 28) throw new Error(`Expected 28 credits for test media; got ${quote.credits}.`);
  const submitted = json('/api/takes', { characterIds: [character.id], clipIds: [clip.id], swapModels: ['hf-genjutsu-720p'] });
  const job = submitted.jobs?.[0];
  if (!job?.providerRequestId || job.status !== 'running') throw new Error('Genjutsu job not submitted.');
  console.log(`Production Genjutsu submitted: ${job.id} / ${job.providerRequestId}.`);
  fs.writeFileSync(path.join(root, '.production-test-job.json'), JSON.stringify({ id: job.id, characterId: character.id, clipId: clip.id }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
