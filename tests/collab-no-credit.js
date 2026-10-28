// Verifies that two characters produce exactly one provider request. All Higgsfield calls are mocked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

process.env.CHARACTER_TEST_MODE = '1';
process.env.SESSION_SECRET = 'collab-local-test-secret';
process.env.OWNER_ACCESS_KEY = 'collab-local-owner-key';
process.env.HIGGSFIELD_OWNER_TOKEN = 'fake-local-token';
process.env.HIGGSFIELD_OWNER_REFRESH_TOKEN = 'fake-local-refresh';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-collab-test-'));
process.env.CHARACTER_DATA_DIR = path.join(dir, 'data');
process.env.CHARACTER_UPLOADS_DIR = path.join(dir, 'uploads');
fs.mkdirSync(process.env.CHARACTER_DATA_DIR);
fs.mkdirSync(process.env.CHARACTER_UPLOADS_DIR);
const img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zXcAAAAASUVORK5CYII=';
fs.writeFileSync(path.join(dir, 'data', 'characters.json'), JSON.stringify([
  { id: 'left', userId: 'owner', name: 'Esquerda', images: [{ id: 'img-left', url: img, useAsRef: true }] },
  { id: 'right', userId: 'owner', name: 'Direita', images: [{ id: 'img-right', url: img, useAsRef: true }] }
]));
fs.writeFileSync(path.join(dir, 'data', 'clips.json'), JSON.stringify([
  { id: 'clip', userId: 'owner', name: 'Duas pessoas.mp4', url: '/api/uploads/unused.mp4', info: { duration: 11 } },
  { id: 'long-clip', userId: 'owner', name: 'Vídeo longo.mp4', url: '/api/uploads/unused.mp4', info: { duration: 16 } }
]));
for (const name of ['jobs.json', 'projects.json', 'reference_images.json']) fs.writeFileSync(path.join(dir, 'data', name), '[]');
fs.writeFileSync(path.join(dir, 'data', 'sessions.json'), '{}');

let providerCalls = 0;
let costCalls = 0;
let submitted;
require('../higgsfieldCli').invoke = async (args, session, media) => {
  if (args[0] === 'generate' && args[1] === 'cost') {
    costCalls++;
    assert.equal(args[2], 'hf_mult_motion_control_flash');
    assert.equal(media.length, 3);
    return { credits: 32 };
  }
  providerCalls++;
  submitted = { args, mediaCount: media.length };
  return [crypto.randomUUID()];
};
require('axios').get = async url => url.endsWith('/balance') ? { data: { credits: 1000 } } : { data: { items: [] } };

const app = require('../server');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';
async function call(route, body) {
  const response = await fetch(base + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body)
  });
  cookie = /^character_session=[^;]+/.exec(response.headers.get('set-cookie') || '')?.[0] || cookie;
  return { status: response.status, data: await response.json() };
}

(async () => {
  try {
    assert.equal((await call('/api/auth/owner', { key: process.env.OWNER_ACCESS_KEY })).status, 200);
    const input = { characterIds: ['left', 'right'], clipIds: ['clip'], swapModels: ['hf-genjutsu-720p'],
      cast: [{ characterId: 'left', target: 'left' }, { characterId: 'right', target: 'right' }] };
    assert.equal((await call('/api/takes', { ...input, cast: null, expected_total_credits: 77 })).status, 409);
    assert.equal((await call('/api/takes', { ...input, clipIds: ['clip', 'other'], expected_total_credits: 77 })).status, 409);
    assert.equal(providerCalls, 0);
    const estimate = await call('/api/estimate', input);
    assert.equal(estimate.data.credits, 77);
    const response = await call('/api/takes', { ...input, expected_total_credits: estimate.data.credits });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.jobs.length, 1);
    assert.equal(response.data.jobs[0].input.cast.length, 2);
    assert.equal(providerCalls, 1);
    assert.equal(submitted.mediaCount, 3);
    assert.ok(submitted.args.join(' ').includes('@Image 1'));
    assert.ok(submitted.args.join(' ').includes('@Image 2'));
    const lite = { ...input, swapModels: ['hf-genjutsu-lite-720p'] };
    const liteEstimate = await call('/api/estimate', lite);
    assert.equal(liteEstimate.status, 200, JSON.stringify(liteEstimate.data));
    assert.equal(liteEstimate.data.credits, 32);
    const freeOnly = await call('/api/takes', { ...lite, freeOnly: true, expected_total_credits: 32 });
    assert.equal(freeOnly.status, 409);
    assert.equal(providerCalls, 1);
    const liteResponse = await call('/api/takes', { ...lite, expected_total_credits: 32 });
    assert.equal(liteResponse.status, 200, JSON.stringify(liteResponse.data));
    assert.equal(liteResponse.data.jobs.length, 1);
    assert.equal(liteResponse.data.jobs[0].price_credits, 32);
    assert.equal(submitted.args[2], 'hf_mult_motion_control_flash');
    assert.equal(providerCalls, 2);
    assert.equal(costCalls, 2);
    const invalidLite = await call('/api/estimate', { ...lite, clipIds: ['long-clip'] });
    assert.equal(invalidLite.status, 400);
    assert.equal(costCalls, 2);
    console.log('Two characters -> one provider request, one 77-credit quote (mocked; no credits spent).');
  } finally {
    server.close();
    const target = fs.realpathSync(dir);
    const tempRoot = fs.realpathSync(os.tmpdir());
    if (!target.startsWith(tempRoot + path.sep)) throw new Error('Refusing to remove a directory outside temporary files.');
    fs.rmSync(target, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
