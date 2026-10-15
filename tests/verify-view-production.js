// Manual paid integration test: one nano_banana_flash view, currently quoted at 1.5 Higgsfield credits.
// Creates and removes a synthetic character. Reads the owner key without printing it.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const base = 'https://character-higgsfield-direct.vercel.app';
const key = fs.readFileSync(path.join(os.homedir(), '.config', 'character-school', 'owner-access-key.txt'), 'utf8').trim();
let cookie = '';
async function call(method, route, body, type = 'application/json') {
  const response = await fetch(base + route, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': type }) },
    body: body === undefined ? undefined : type === 'application/json' ? JSON.stringify(body) : body
  });
  cookie = /^character_session=[^;]+/.exec(response.headers.get('set-cookie') || '')?.[0] || cookie;
  const data = await response.json();
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}: ${data.error || 'erro'}`);
  return data;
}

(async () => {
  let character;
  const jobs = [];
  try {
    await call('POST', '/api/auth/owner', { key });
    character = await call('POST', '/api/characters', { name: 'Teste temporário de vista' });
    const ffmpeg = require('@ffmpeg-installer/ffmpeg').path;
    const imagePath = path.join(os.tmpdir(), `view-test-${process.pid}.png`);
    try {
      const made = spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=512x512:rate=1', '-frames:v', '1', '-update', '1', '-y', imagePath], { encoding: 'utf8' });
      if (made.status !== 0) throw new Error(made.stderr);
      await call('POST', `/api/characters/${character.id}/images?name=synthetic.png`, fs.readFileSync(imagePath), 'image/png');
    } finally { if (fs.existsSync(imagePath)) fs.rmSync(imagePath); }
    const response = await call('POST', `/api/characters/${character.id}/views`, { roles: ['front'] });
    const job = response.jobs?.[0];
    if (!job?.providerRequestId || job.status !== 'running') throw new Error(`View was not submitted: ${job?.error || 'no job'}`);
    jobs.push(job.id);
    console.log('Production view submitted.');
    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 8000));
      const current = await call('GET', `/api/jobs/${job.id}/status`);
      if (current.status === 'done') {
        const state = await call('GET', '/api/state');
        const saved = state.characters.find(item => item.id === character.id)?.images.find(image => image.role === 'front');
        if (!saved?.url) throw new Error('View finished but image was not saved.');
        const imageResponse = await fetch(base + saved.url, { method: 'HEAD', headers: { Cookie: cookie } });
        if (!imageResponse.ok || !imageResponse.headers.get('content-type')?.startsWith('image/')) throw new Error('Saved view is not accessible.');
        console.log(`Production view completed and persisted: HTTP ${imageResponse.status}.`);
        return;
      }
      if (current.status === 'failed') throw new Error(`View failed: ${current.error || current.providerStatus}`);
    }
    throw new Error('View did not finish during the test window.');
  } finally {
    for (const id of jobs) await call('DELETE', `/api/jobs/${id}`).catch(() => {});
    if (character) await call('DELETE', `/api/characters/${character.id}`).catch(() => {});
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
