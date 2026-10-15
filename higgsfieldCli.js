const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const binary = process.env.VERCEL
  ? path.join(__dirname, 'vendor', 'hf')
  : path.join(path.dirname(require.resolve('@higgsfield/cli/package.json')), 'vendor', process.platform === 'win32' ? 'hf.exe' : 'hf');

async function invoke(args, session, media = []) {
  const hf = session?.higgsfield;
  if (!hf?.connected || !hf.token || !hf.refreshToken) throw new Error('Conecte novamente sua conta Higgsfield.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'character-hf-'));
  const credentialsPath = path.join(dir, 'credentials.json');
  const configPath = path.join(dir, 'config.json');
  try {
    await fs.writeFile(credentialsPath, JSON.stringify({
      auth_version: 2, access_token: hf.token, refresh_token: hf.refreshToken,
      expires_at: hf.expiresAt || Math.floor(Date.now() / 1000) + 300,
      token_type: 'bearer', scope: 'email profile offline_access user:org:read'
    }), { mode: 0o600 });
    await fs.writeFile(configPath, JSON.stringify({ workspace_id: hf.workspaceId || '' }), { mode: 0o600 });
    const localArgs = [];
    for (const item of media) {
      const filename = path.join(dir, item.filename);
      await item.write(filename);
      localArgs.push(item.flag, filename);
    }
    const childEnv = { ...process.env };
    for (const name of Object.keys(childEnv)) {
      if (/^(HIGGSFIELD_|FIREBASE_|BLOB_|OWNER_|SESSION_|AWS_)/.test(name)) delete childEnv[name];
    }
    childEnv.HIGGSFIELD_CREDENTIALS_PATH = credentialsPath;
    childEnv.HIGGSFIELD_CONFIG_PATH = configPath;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(binary, [...args, ...localArgs, '--json'], {
        env: childEnv,
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      const max = 2 * 1024 * 1024;
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > max) child.kill(); });
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > max) child.kill(); });
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) return reject(new Error(stderr.replace(/Bearer\s+\S+|oat_[A-Za-z0-9._-]+|\beyJ[A-Za-z0-9_-]{40,}(?:\.[A-Za-z0-9_-]+){1,2}/gi, '[credencial]').slice(0, 500) || `Higgsfield CLI: código ${code}`));
        try { resolve(JSON.parse(stdout)); }
        catch { reject(new Error('Resposta inválida do Higgsfield.')); }
      });
    });
    const updated = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    if (updated.access_token) hf.token = updated.access_token;
    if (updated.refresh_token) hf.refreshToken = updated.refresh_token;
    if (updated.expires_at) hf.expiresAt = updated.expires_at;
    const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
    if (config.workspace_id) hf.workspaceId = config.workspace_id;
    return output;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

module.exports = { invoke };
