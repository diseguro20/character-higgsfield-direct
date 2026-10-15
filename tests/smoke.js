const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

process.env.SESSION_SECRET = 'test-secret-only-never-use-in-production';
process.env.OWNER_ACCESS_KEY = 'test-owner-access-key';
process.env.HIGGSFIELD_OWNER_TOKEN = 'test-token';
process.env.HIGGSFIELD_OWNER_API_CREDENTIAL = 'owner-only-key:secret';
process.env.CHARACTER_TEST_MODE = '1';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'character-school-test-'));
process.env.CHARACTER_DATA_DIR = path.join(tempDir, 'data');
process.env.CHARACTER_UPLOADS_DIR = path.join(tempDir, 'uploads');
fs.mkdirSync(process.env.CHARACTER_DATA_DIR);
fs.mkdirSync(process.env.CHARACTER_UPLOADS_DIR);
const names = ['characters.json', 'clips.json', 'jobs.json', 'projects.json', 'reference_images.json', 'sessions.json'];
for (const name of names) fs.writeFileSync(path.join(process.env.CHARACTER_DATA_DIR, name), name === 'sessions.json' ? '{}' : '[]');
fs.writeFileSync(path.join(process.env.CHARACTER_DATA_DIR, 'clips.json'), JSON.stringify([{ id: 'clip_test', userId: 'owner', name: 'Teste', info: { duration: 8.2 } }]));

const app = require('../server.js');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
let cookie = '';

async function request(method, route, body, contentType = 'application/json') {
  const res = await fetch(base + route, {
    method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': contentType }) },
    body: body === undefined ? undefined : (contentType === 'application/json' ? JSON.stringify(body) : body),
    redirect: 'manual'
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return { status: res.status, body: await res.text() };
}

(async () => {
  let r = await request('GET', '/api/state');
  assert.equal(JSON.parse(r.body).auth, 'login');
  assert.equal(JSON.parse((await request('GET', '/api/state?owner=1')).body).auth, 'login');
  assert.equal((await request('GET', '/api/auth/owner')).status, 403);
  assert.equal((await request('POST', '/api/auth/owner', { key: 'test-owner-access-key' })).status, 200);
  r = await request('GET', '/api/state');
  assert.equal(JSON.parse(r.body).auth, 'ok');
  assert.ok(!r.body.includes('test-token'));
  assert.equal((await request('POST', '/api/takes', { characterIds: ['missing'], clipIds: ['missing'] })).status, 401);
  const leadSession = {
    id: 'lead-session', createdAt: new Date().toISOString(),
    user: { id: 'lead-1', email: 'lead@example.test', name: 'Lead', role: 'student' },
    higgsfield: { connected: true, status: 'active', email: 'lead@example.test', credits: 3 }
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(leadSession), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(payload).digest('base64url');
  const leadCookie = `character_session=${payload}.${signature}`;
  let leadResponse = await fetch(base + '/api/state', { headers: { Cookie: leadCookie } });
  let leadState = await leadResponse.json();
  assert.equal(leadState.me.user.email, 'lead@example.test');
  assert.equal(leadState.me.higgsfield.apiCredentialsConfigured, false);
  assert.ok(!JSON.stringify(leadState).includes('owner-only-key'));
  assert.deepEqual(leadState.clips, []);
  leadResponse = await fetch(base + '/api/clips/clip_test', {
    method: 'PATCH', headers: { Cookie: leadCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Invadido', userId: 'lead-1' })
  });
  assert.deepEqual(await leadResponse.json(), {});
  leadResponse = await fetch(base + '/api/takes', {
    method: 'POST', headers: { Cookie: leadCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterIds: ['missing'], clipIds: ['clip_test'] })
  });
  assert.equal(leadResponse.status, 401);
  assert.equal((await request('POST', '/api/higgsfield/api-credentials', { key: 'test-id:test-secret' })).status, 410);
  r = await request('GET', '/api/state');
  assert.ok(!r.body.includes('test-id:test-secret'));
  assert.equal(JSON.parse(r.body).me.higgsfield.apiCredentialsConfigured, false);
  r = await request('GET', '/api/me');
  assert.equal(JSON.parse(r.body).features.user_photo_characters, true);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/zXcAAAAASUVORK5CYII=', 'base64');
  assert.equal((await request('POST', '/api/uploads/prepare', { name: 'large.png', contentType: 'image/png', size: 5000000 })).status, 501);
  r = await request('POST', '/api/uploads?name=generic.png', png, 'application/octet-stream');
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.body).url.startsWith('data:image/png;base64,'));
  assert.equal((await request('GET', JSON.parse(r.body).path)).status, 200);
  r = await request('POST', '/api/reference-images?name=person.png', png, 'application/octet-stream');
  assert.equal(r.status, 200);
  const reference = JSON.parse(r.body).reference;
  assert.ok(reference.url.startsWith('data:image/png;base64,'));
  r = await request('POST', '/api/images', { prompt: 'portrait of a person', n: 1, referenceIds: [reference.id] });
  assert.equal(r.status, 200);
  const job = JSON.parse(r.body);
  assert.equal(job.outputs.imageUrls[0], reference.url);
  assert.ok(!r.body.includes('vector-1.webp'));
  r = await request('POST', '/api/images/save', { jobId: job.id, index: 0, name: 'Pessoa', makeCover: true });
  const character = JSON.parse(r.body);
  assert.equal(character.images[0].url, reference.url);
  assert.equal(character.cover, character.images[0].id);
  r = await request('POST', `/api/characters/${character.id}/images?name=side.png`, png, 'application/octet-stream');
  assert.equal(r.status, 200);
  const second = JSON.parse(r.body).images[1];
  assert.ok(second.url.startsWith('data:image/png;base64,'));
  assert.equal((await request('PATCH', `/api/characters/${character.id}/images/${second.id}`, { useAsRef: false, label: 'Perfil' })).status, 200);
  assert.equal((await request('PATCH', `/api/characters/${character.id}`, { cover: second.id })).status, 200);
  assert.equal((await request('DELETE', `/api/characters/${character.id}/images/${second.id}`)).status, 200);
  assert.equal((await request('POST', `/api/characters/${character.id}/views`, {})).status, 501);
  assert.equal((await request('POST', `/api/jobs/${job.id}/retry`, {})).status, 409);
  assert.equal(JSON.parse((await request('POST', '/api/estimate', { clipIds: ['clip_test'], swapModels: ['hf-genjutsu-720p'] })).body).credits, 63);
  assert.equal(JSON.parse((await request('POST', '/api/estimate', { clipIds: ['clip_test'], swapModels: ['hf-genjutsu-1080p'] })).body).credits, 180);
  assert.equal((await request('POST', '/api/estimate', { clipIds: ['missing'], swapModels: ['hf-genjutsu-720p'] })).status, 400);
  assert.equal((await request('POST', '/api/takes', { characterIds: [character.id], clipIds: ['missing'] })).status, 401);
  assert.equal((await request('DELETE', `/api/reference-images/${reference.id}`)).status, 200);
  assert.equal((await request('DELETE', `/api/characters/${character.id}`)).status, 200);
  console.log('Smoke HTTP: login, owner guard, state, me, photo reference, image choice/save, image CRUD, estimate and takes guard OK');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  server.close();
  if (tempDir.startsWith(os.tmpdir() + path.sep)) fs.rmSync(tempDir, { recursive: true, force: true });
});
