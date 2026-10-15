const { put, get, head, del, issueSignedToken, presignUrl } = require('@vercel/blob');
const fs = require('node:fs');
const { Readable } = require('node:stream');
const { finished } = require('node:stream/promises');

function createBlobStorage(firestore) {
  const files = firestore.collection('character_school_files');

  return {
    file(pathname) {
      if (!/^uploads\/[a-zA-Z0-9._-]+$/.test(pathname)) throw new Error('Nome de arquivo inválido.');
      const name = pathname.slice('uploads/'.length);
      const metadataRef = files.doc(name);

      return {
        async save(buffer, options = {}) {
          const stored = await put(pathname, buffer, {
            access: 'private', contentType: options.contentType || 'application/octet-stream',
            addRandomSuffix: false
          });
          await metadataRef.set({
            userId: options.metadata?.metadata?.userId || '',
            contentType: stored.contentType, size: buffer.length, createdAt: Date.now()
          });
        },
        async getMetadata() {
          const [blob, record] = await Promise.all([head(pathname), metadataRef.get()]);
          return [{
            size: blob.size, contentType: blob.contentType,
            metadata: { userId: record.exists ? (record.data().userId || '') : '' }
          }];
        },
        async setMetadata(value) {
          await metadataRef.set({ userId: value?.metadata?.userId || '' }, { merge: true });
        },
        async getSignedUrl({ action, expires, contentType }) {
          const operation = action === 'write' ? 'put' : 'get';
          const validUntil = Math.min(expires || Date.now() + 3600000, Date.now() + 7 * 86400000);
          const options = {
            pathname, operations: [operation], validUntil,
            ...(operation === 'put' ? {
              allowedContentTypes: [contentType], maximumSizeInBytes: 350 * 1024 * 1024
            } : {})
          };
          const signed = await issueSignedToken(options);
          const { presignedUrl } = await presignUrl(signed, {
            operation, pathname, access: 'private', validUntil,
            ...(operation === 'put' ? {
              allowedContentTypes: [contentType], maximumSizeInBytes: 350 * 1024 * 1024,
              addRandomSuffix: false, allowOverwrite: false
            } : {})
          });
          return [presignedUrl];
        },
        async download(options = {}) {
          const result = await get(pathname, { access: 'private' });
          if (!result || result.statusCode !== 200) throw new Error('Arquivo não encontrado.');
          if (options.destination) {
            await finished(Readable.fromWeb(result.stream).pipe(fs.createWriteStream(options.destination)));
            return [options.destination];
          }
          return [Buffer.from(await new Response(result.stream).arrayBuffer())];
        },
        async delete() {
          await del(pathname);
          await metadataRef.delete();
        }
      };
    }
  };
}

module.exports = { createBlobStorage };
