const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const admin = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { createBlobStorage } = require('../blobStorage');

require('dotenv').config({ path: '.env.production.local' });

async function main() {
  if (!process.env.BLOB_READ_WRITE_TOKEN || !process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    throw new Error('Credenciais de integração ausentes.');
  }
  admin.initializeApp({ credential: admin.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)) });
  const name = `integration_${crypto.randomUUID()}.txt`;
  const file = createBlobStorage(getFirestore()).file(`uploads/${name}`);
  const direct = createBlobStorage(getFirestore()).file(`uploads/direct_${crypto.randomUUID()}.png`);
  const body = Buffer.from('character-school-integration');
  try {
    await file.save(body, { contentType: 'text/plain', metadata: { metadata: { userId: 'integration' } } });
    const [metadata] = await file.getMetadata();
    assert.equal(Number(metadata.size), body.length);
    assert.equal(metadata.metadata.userId, 'integration');
    assert.deepEqual((await file.download())[0], body);
    const [url] = await file.getSignedUrl({ action: 'read', expires: Date.now() + 60000 });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), body.toString());
    const [writeUrl] = await direct.getSignedUrl({ action: 'write', expires: Date.now() + 60000, contentType: 'image/png' });
    const preflight = await fetch(writeUrl, { method: 'OPTIONS', headers: {
      Origin: 'https://character-higgsfield-direct.vercel.app',
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'content-type'
    } });
    assert.ok(preflight.ok, `Preflight: ${preflight.status}`);
    assert.ok(preflight.headers.get('access-control-allow-origin'));
    const upload = await fetch(writeUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body });
    assert.ok(upload.ok, `Upload direto: ${upload.status}`);
    assert.equal(Number((await direct.getMetadata())[0].size), body.length);
    console.log('Blob privado + Firestore: escrita, leitura, URL assinada e isolamento de metadata OK');
  } finally {
    await file.delete();
    await direct.delete();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
