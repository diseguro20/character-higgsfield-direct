const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { spawn } = require('child_process');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');
const higgsfieldCli = require('./higgsfieldCli');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const DEFAULT_PORT = process.env.PORT || 3333;
const SESSION_SECRET = process.env.SESSION_SECRET || (!process.env.VERCEL ? crypto.randomBytes(32).toString('hex') : '');
if (!SESSION_SECRET) throw new Error('SESSION_SECRET deve ser configurado na Vercel');

app.use(cors());
app.use(express.json());
// Para uploads brutos de vídeos/imagens da interface original
app.use(express.raw({ type: ['application/octet-stream', 'video/*', 'image/*'], limit: '350mb' }));
// Credenciais nunca fazem parte das respostas JSON enviadas ao navegador.
const requestStore = new AsyncLocalStorage();
app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  res.json = value => {
    const safe = JSON.parse(JSON.stringify(value, (key, item) =>
      ['token', 'refreshToken', 'apiKey', 'apiSecret', 'apiCredential', 'verifier', 'cookie'].includes(key) ? undefined : item));
    const pending = requestStore.getStore()?.pending || [];
    if (!pending.length) return originalJson(safe);
    Promise.all(pending).then(() => originalJson(safe)).catch(err => {
      console.error('Falha ao persistir no Firebase:', err);
      res.status(503);
      originalJson({ error: 'Não foi possível salvar no Firebase.' });
    });
    return res;
  };
  next();
});

// Diretórios
const SITE_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, 'site-original');
const REPO_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.CHARACTER_DATA_DIR || (process.env.VERCEL ? path.join('/tmp', 'data') : REPO_DATA_DIR);
const UPLOADS_DIR = process.env.CHARACTER_UPLOADS_DIR || (process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads'));

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');
const REFERENCE_IMAGES_FILE = path.join(DATA_DIR, 'reference_images.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Firebase Backend Integration (Projeto: autocontentai-f20d8)
let firebaseAdmin = null;
let firestore = null;
let storageBucket = null;
try {
  const admin = require('firebase-admin/app');
  if (!admin.getApps().length) {
    const credential = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
      ? admin.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON))
      : admin.applicationDefault();
    admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'autocontentai-f20d8',
      credential, storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
  }
  firebaseAdmin = admin;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_STORAGE_BUCKET) {
    firestore = require('firebase-admin/firestore').getFirestore();
  }
  if (process.env.BLOB_READ_WRITE_TOKEN && firestore) {
    storageBucket = require('./blobStorage').createBlobStorage(firestore);
  } else if (process.env.FIREBASE_STORAGE_BUCKET && firestore) {
    storageBucket = require('firebase-admin/storage').getStorage().bucket();
  }
  console.log(storageBucket ? '[Backend] Firestore e armazenamento persistente configurados' : '[Backend] SDK inicializado; usando persistência local');
} catch (e) {
  console.log('[Firebase Backend] Aviso de inicialização:', e.message);
}
if (process.env.VERCEL && (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON || !firestore || !storageBucket)) {
  throw new Error('Configure FIREBASE_SERVICE_ACCOUNT_JSON e BLOB_READ_WRITE_TOKEN na Vercel');
}

// Configuração padrão do Dono (sirilisworks3@gmail.com) - isolada
const DEFAULT_OWNER_CONFIG = {
  connected: false,
  status: "idle",
  email: "sirilisworks3@gmail.com",
  userId: "owner",
  token: process.env.HIGGSFIELD_OWNER_TOKEN || '',
  refreshToken: process.env.HIGGSFIELD_OWNER_REFRESH_TOKEN || '',
  workspaceId: process.env.HIGGSFIELD_OWNER_WORKSPACE_ID || '',
  credits: 0,
  plan: "",
  checkedAt: null
};

let memoryCache = {};
const uploadedFilesBufferMap = new Map();
const uploadedReferenceMap = new Map();

function saveUploadedBuffer(name, buffer, mime) {
  uploadedFilesBufferMap.set(name, { buffer, mime });
  if (storageBucket) {
    const scope = requestStore.getStore();
    const userId = scope?.req ? getSession(scope.req)?.user?.id : null;
    const promise = storageBucket.file(`uploads/${name}`).save(buffer, { contentType: mime, resumable: false,
      metadata: { metadata: { userId: userId || '' } } });
    if (scope) scope.pending.push(promise);
    else promise.catch(error => console.error('Upload Firebase:', error));
    return;
  }
  const filePath = path.join(UPLOADS_DIR, name);
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (e) {
    console.error('Erro ao escrever arquivo em disco:', e.message);
  }
}

function readJson(file, fallback = []) {
  const baseName = path.basename(file);
  const scoped = requestStore.getStore()?.documents;
  if (scoped?.has(baseName)) {
    const value = scoped.get(baseName);
    if (baseName !== 'config.json') return value;
    return { ...DEFAULT_OWNER_CONFIG, ...value,
      token: value.token || process.env.HIGGSFIELD_OWNER_TOKEN || '',
      refreshToken: value.refreshToken || process.env.HIGGSFIELD_OWNER_REFRESH_TOKEN || '',
      workspaceId: value.workspaceId || process.env.HIGGSFIELD_OWNER_WORKSPACE_ID || '' };
  }
  if (baseName === 'config.json') {
    if (memoryCache[baseName]) {
      return memoryCache[baseName];
    }
    let data = null;
    const repoFile = path.join(REPO_DATA_DIR, baseName);
    try {
      if (fs.existsSync(repoFile)) {
        data = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
      }
    } catch {}
    try {
      if (fs.existsSync(file)) {
        const tmpData = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (tmpData && tmpData.token) {
          data = { ...data, ...tmpData };
        }
      }
    } catch {}
    const finalConfig = { ...DEFAULT_OWNER_CONFIG, ...(data || {}) };
    if (process.env.VERCEL) {
      finalConfig.token = process.env.HIGGSFIELD_OWNER_TOKEN || '';
      finalConfig.refreshToken = process.env.HIGGSFIELD_OWNER_REFRESH_TOKEN || '';
      finalConfig.workspaceId = process.env.HIGGSFIELD_OWNER_WORKSPACE_ID || '';
    }
    finalConfig.connected = !!finalConfig.token;
    memoryCache[baseName] = finalConfig;
    return finalConfig;
  }

  try {
    if (memoryCache[baseName]) return memoryCache[baseName];
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      memoryCache[baseName] = data;
      return data;
    }
    const repoFile = path.join(REPO_DATA_DIR, baseName);
    if (fs.existsSync(repoFile)) {
      const data = JSON.parse(fs.readFileSync(repoFile, 'utf8'));
      memoryCache[baseName] = data;
      return data;
    }
  } catch (e) {
    console.error(`Erro ao ler ${file}:`, e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  try {
    const baseName = path.basename(file);
    const scope = requestStore.getStore();
    if (firestore && scope) {
      const previous = scope.beforeWrite.get(baseName);
      const snapshot = JSON.parse(JSON.stringify(data));
      const before = JSON.parse(JSON.stringify(previous));
      scope.documents.set(baseName, data);
      scope.beforeWrite.set(baseName, snapshot);
      const doc = firestore.collection('character_school_data').doc(baseName.replace('.json', ''));
      scope.lastWrite = (scope.lastWrite || Promise.resolve()).then(() => firestore.runTransaction(async tx => {
        const stored = await tx.get(doc);
        const current = stored.exists ? stored.data().value : (Array.isArray(snapshot) ? [] : {});
        if (Array.isArray(snapshot) && Array.isArray(before) && Array.isArray(current)) {
          const old = new Map(before.map(item => [item.id, item]));
          const next = new Map(snapshot.map(item => [item.id, item]));
          const merged = current.filter(item => !old.has(item.id) || next.has(item.id));
          for (const item of snapshot) {
            if (!old.has(item.id) || JSON.stringify(old.get(item.id)) !== JSON.stringify(item)) {
              const index = merged.findIndex(existing => existing.id === item.id);
              if (index < 0) merged.unshift(item);
              else merged[index] = item;
            }
          }
          tx.set(doc, { value: merged });
        } else {
          tx.set(doc, { value: snapshot });
        }
      }));
      scope.pending.push(scope.lastWrite);
      return;
    }
    memoryCache[baseName] = data;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Erro ao escrever ${file}:`, e.message);
  }
}

// Cada requisição lê seu próprio snapshot; gravações aguardam confirmação antes da resposta.
app.use(async (req, res, next) => {
  if (!firestore || (!req.path.startsWith('/api/') && !req.path.startsWith('/uploads/'))) return next();
  try {
    const names = ['characters.json', 'clips.json', 'jobs.json', 'projects.json', 'reference_images.json', 'config.json', 'sessions.json'];
    const docs = await firestore.getAll(...names.map(name => firestore.collection('character_school_data').doc(name.replace('.json', ''))));
    const documents = new Map(names.map((name, i) => [name, docs[i].exists ? docs[i].data().value : (name.endsWith('config.json') ? { ...DEFAULT_OWNER_CONFIG } : name.endsWith('sessions.json') ? {} : [])]));
    requestStore.run({ documents, beforeWrite: new Map(Array.from(documents, ([name, value]) => [name, JSON.parse(JSON.stringify(value))])), pending: [], req }, next);
  } catch (error) {
    console.error('Firebase indisponível:', error);
    res.status(503).json({ error: 'Firebase indisponível.' });
  }
});

// -------------------------------------------------------------
// GERENCIAMENTO DE SESSÕES MULTI-TENANT (ISOLAMENTO POR COOKIE)
// -------------------------------------------------------------
function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach(cookie => {
      const parts = cookie.split('=');
      const name = parts.shift().trim();
      const value = decodeURIComponent(parts.join('='));
      list[name] = value;
    });
  }
  return list;
}

function signSession(data) {
  const key = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig.length !== expectedSig.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const bytes = Buffer.from(payload, 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', crypto.createHash('sha256').update(SESSION_SECRET).digest(), bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const session = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    return Date.now() - Date.parse(session.createdAt) < 30 * 86400000 ? session : null;
  } catch (e) {
    return null;
  }
}

const activeSessions = new Map();

function getSession(req) {
  if (req.session) return req.session;
  const cookies = parseCookies(req);
  const token = cookies['character_session'];
  if (!token) return null;

  if (activeSessions.has(token)) {
    return activeSessions.get(token);
  }

  const verified = verifySession(token);
  if (verified) {
    activeSessions.set(token, verified);
    return verified;
  }
  return null;
}

function createSession(userData, higgsfieldData) {
  const sessionId = 'cs_' + crypto.randomBytes(16).toString('hex');
  const session = {
    id: sessionId,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    user: userData,
    higgsfield: higgsfieldData
  };
  return session;
}

function setSessionCookie(res, session) {
  const token = signSession(session);
  activeSessions.set(token, session);
  res.setHeader('Set-Cookie', `character_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${process.env.VERCEL ? '; Secure' : ''}`);
  return token;
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'character_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// Acesso direto do dono exige uma chave privada configurada no servidor.
async function ownerLogin(req, res) {
  const supplied = String(req.body?.key || req.headers['x-owner-access-key'] || '');
  const expected = process.env.OWNER_ACCESS_KEY || '';
  if (!expected || supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Acesso do dono indisponível.' });
  }
  const config = readJson(CONFIG_FILE, DEFAULT_OWNER_CONFIG);
  if (!config.token) return res.status(503).json({ error: 'Configure HIGGSFIELD_OWNER_TOKEN.' });
  const previousToken = config.token;
  const balance = process.env.CHARACTER_TEST_MODE ? { credits: 0 } : await fetchRealHiggsfieldBalance(config).catch(() => null);
  if (config.token !== previousToken) writeJson(CONFIG_FILE, config);
  const credits = balance?.credits ?? 0;
  const session = createSession(
    { id: config.userId || 'owner', email: config.email, name: 'sirilisworks3', role: 'admin' },
    { mode: 'own', connected: true, status: 'active', credits,
      available: credits, email: config.email, plan: balance?.plan || config.plan,
      checkedAt: balance ? new Date().toISOString() : null, token: config.token, refreshToken: config.refreshToken,
      workspaceId: config.workspaceId,
      apiCredentialsConfigured: false }
  );
  setSessionCookie(res, session);
  return req.method === 'POST' ? res.json({ ok: true }) : res.redirect('/app');
}
app.get('/api/auth/owner', ownerLogin);
app.post('/api/auth/owner', ownerLogin);
app.get('/app', (req, res, next) => req.query.owner === '1' ? ownerLogin(req, res) : next());

// Clientes SSE (Server-Sent Events)
let sseClients = [];
function broadcastEvent(type, item) {
  const payload = `data: ${JSON.stringify({ events: [{ type, item }] })}\n\n`;
  sseClients.filter(c => item?.userId && c.userId === item.userId).forEach(c => c.res.write(payload));
}

// -------------------------------------------------------------
// ARQUIVOS ESTÁTICOS DO SITE CLONADO ORIGINAL
// -------------------------------------------------------------
app.use('/landing', express.static(path.join(SITE_DIR, 'landing')));
app.use('/app', express.static(path.join(SITE_DIR, 'app')));
app.get(['/uploads/:name', '/api/uploads/:name'], async (req, res) => {
  const session = getSession(req);
  if (!session?.higgsfield?.connected) return res.status(401).send('Não autorizado');
  const fileName = req.params.name;
  if (storageBucket) {
    try {
      const file = storageBucket.file(`uploads/${fileName}`);
      const [metadata] = await file.getMetadata();
      if (metadata.metadata?.userId !== session.user.id) return res.status(403).send('Acesso negado');
      const [url] = await file.getSignedUrl({ version: 'v4', action: 'read', expires: Date.now() + 60 * 60000 });
      return res.redirect(302, url);
    } catch { return res.status(404).send('Arquivo não encontrado'); }
  }
  if (uploadedFilesBufferMap.has(fileName)) {
    const item = uploadedFilesBufferMap.get(fileName);
    res.setHeader('Content-Type', item.mime || 'application/octet-stream');
    return res.send(item.buffer);
  }
  const filePath = path.join(UPLOADS_DIR, fileName);
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }
  res.status(404).send('Arquivo não encontrado');
});

// Rota raiz: serve a landing page original
app.get('/', (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'index.html'));
});

// Rota /app e /app/: serve o aplicativo original
app.get(['/app', '/app/'], (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'app', 'index.html'));
});

function owns(req, item) {
  const user = getSession(req)?.user;
  return !!user && (item?.userId === user.id || (!item?.userId && user.role === 'admin'));
}
app.use('/api', (req, res, next) => {
  if (req.path === '/state' || req.path.startsWith('/auth/') || req.path.startsWith('/higgsfield')) return next();
  if (!getSession(req)?.higgsfield?.connected) return res.status(401).json({ error: 'Conecte sua conta Higgsfield.' });
  if (req.path.startsWith('/admin') && getSession(req).user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito.' });
  next();
});

// -------------------------------------------------------------
// APIS DO APP ORIGINAL (MULTI-TENANT / CONEXÃO POR LEAD)
// -------------------------------------------------------------

let currentLogin = null;

function getHiggsfieldAccount(req) {
  const session = getSession(req);
  if (session && session.higgsfield && session.higgsfield.connected) {
    return {
      ...session.higgsfield,
      login: null
    };
  }
  return {
    mode: 'own',
    connected: false,
    status: 'idle',
    credits: 0,
    available: 0,
    email: '',
    plan: '',
    checkedAt: null,
    cookie: '',
    token: '',
    apiKey: '',
    apiSecret: '',
    login: null
  };
}

// 1. GET /api/state: Carrega todo o estado inicial para o Preact do app original
app.get('/api/state', (req, res) => {
  const session = getSession(req);
  if (!session || !session.higgsfield || !session.higgsfield.connected) {
    // Visitante / Lead sem sessão conectada: exibe a tela de login original
    return res.json({
      auth: 'login',
      ready: false,
      me: null,
      features: {
        email_login: false
      },
      links: {
        higgsfield_signup_url: 'https://higgsfield.ai'
      }
    });
  }

  const hf = session.higgsfield;
  const user = session.user;
  const characters = readJson(CHARACTERS_FILE, []);
  const clips = readJson(CLIPS_FILE, []);
  const jobs = readJson(JOBS_FILE, []);

  // Filtra por usuário (se item tiver userId) ou exibe itens base
  const userCharacters = characters.filter(c => owns(req, c));
  const userClips = clips.filter(c => owns(req, c));
  const userJobs = jobs.filter(j => owns(req, j));

  const state = {
    auth: 'ok',
    ready: true,
    me: {
      user: user,
      wallet: {
        balance_credits: hf.credits || 0,
        reserved_credits: 0
      },
      pricing: {
        credits_per_second: 20,
        min_seconds: 4,
        character_credits: 60,
        character_image_credits: 15
      },
      limits: {
        max_upload_mb: 350,
        maxClipSeconds: 60,
        maxDuration: 29.7,
        minDuration: 4
      },
      features: {
        email_login: false,
        user_photo_characters: true
      },
      higgsfield: { ...hf, apiCredentialsConfigured: !!(hf.apiCredential || (hf.apiKey && hf.apiSecret)) },
      paywall: {
        locked: false,
        free_videos: 99999,
        free_left: 99999,
        price_label: 'Grátis'
      }
    },
    models: [
      {
        id: 'hf-genjutsu-1080p',
        family: 'genjutsu',
        familyLabel: 'Higgsfield Genjutsu',
        label: 'Higgsfield Genjutsu 1080p',
        endpoint: 'https://api.higgsfield.ai/v1/genjutsu',
        provider: 'hfcli',
        providerLabel: 'Higgsfield',
        quality: '1080p',
        step: 'swap',
        configured: true,
        rank: 1,
        status: 'ready',
        limits: { outputLongSide: 1920, maxClipSeconds: 60, maxDuration: 29.7, minDuration: 4, maxCast: 4 },
        credits_per_second: 20,
        badges: ['1080p', 'Genjutsu'],
        description: 'Troca de personagem com movimento e cena idênticos mantendo o áudio original',
        docsUrl: 'https://higgsfield.ai'
      },
      {
        id: 'hf-genjutsu-720p',
        family: 'genjutsu',
        familyLabel: 'Higgsfield Genjutsu',
        label: 'Higgsfield Genjutsu 720p',
        endpoint: 'https://api.higgsfield.ai/v1/genjutsu-720p',
        provider: 'hfcli',
        providerLabel: 'Higgsfield',
        quality: '720p',
        step: 'swap',
        configured: true,
        rank: 2,
        status: 'ready',
        limits: { outputLongSide: 1280, maxClipSeconds: 60, maxDuration: 29.7, minDuration: 4, maxCast: 4 },
        credits_per_second: 7,
        badges: ['720p'],
        description: 'Troca de personagem mais rápida',
        docsUrl: 'https://higgsfield.ai'
      },
      {
        id: 'hf-character-image',
        family: 'image_gen',
        familyLabel: 'Higgsfield Character Image',
        label: 'Criar Imagem de Personagem',
        endpoint: 'https://api.higgsfield.ai/v1/character-image',
        provider: 'hfcli',
        providerLabel: 'Higgsfield',
        step: 'image_gen',
        configured: true,
        rank: 3,
        status: 'ready',
        character_credits: 60,
        badges: ['IA', 'Personagem'],
        description: 'Gera imagem âncora e 3 vistas de referência do personagem',
        docsUrl: 'https://higgsfield.ai'
      },
      {
        id: 'hf-first-frame',
        family: 'image_edit',
        familyLabel: 'Higgsfield First Frame',
        label: 'Primeiro Quadro (Face Swap)',
        endpoint: 'https://api.higgsfield.ai/v1/first-frame',
        provider: 'hfcli',
        providerLabel: 'Higgsfield',
        step: 'image_edit',
        configured: true,
        rank: 4,
        status: 'ready',
        credits_per_second: 11,
        badges: ['Quadro 1'],
        description: 'Gera o primeiro quadro do vídeo com a face do personagem substituída',
        docsUrl: 'https://higgsfield.ai'
      },
      {
        id: 'hf-image-upscale',
        family: 'image_upscale',
        familyLabel: 'Higgsfield Upscale Image',
        label: 'Upscale de Imagem 4K',
        endpoint: 'https://api.higgsfield.ai/v1/upscale-image',
        provider: 'hfcli',
        providerLabel: 'Higgsfield',
        step: 'image_upscale',
        configured: true,
        rank: 5,
        status: 'ready',
        badges: ['4k', 'Upscale'],
        description: 'Aumenta a resolução da imagem para 4K mantendo fidelidade de textura',
        docsUrl: 'https://higgsfield.ai'
      },
      {
        id: 'hf-video-upscale',
        family: 'video_upscale',
        familyLabel: 'Higgsfield Upscale Video',
        label: 'Upscale de Vídeo 1080p/4K',
        endpoint: 'https://api.higgsfield.ai/v1/upscale-video',
        provider: 'hfcli',
        providerLabel: 'Higgsfield',
        step: 'video_upscale',
        configured: true,
        rank: 6,
        status: 'ready',
        credits_per_second: 15,
        badges: ['4k', 'Vídeo'],
        description: 'Aprimora resolução e nitidez do vídeo gerado',
        docsUrl: 'https://higgsfield.ai'
      }
    ],
    providers: [
      { id: 'hfcli', label: 'Higgsfield', configured: true }
    ],
    characters: userCharacters,
    projects: readJson(PROJECTS_FILE, []).filter(p => owns(req, p)),
    clips: userClips,
    jobs: userJobs,
    templates: {
      card: 'Photorealistic portrait of {identity}',
      sheet: 'Character sheet of {name}, three views: front view, profile view, three-quarter view, neutral background, photorealistic. {identity}',
      fullbody: 'Full body shot of {name}, standing, studio lighting, photorealistic, head to toe visible. {identity}'
    },
    spend: { today: 0, month: 0, total: 0 }
  };

  res.json(state);
});

// 2. GET /api/me
app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session || !session.higgsfield || !session.higgsfield.connected) {
    return res.status(401).json({ error: 'Não autorizado' });
  }
  const hf = session.higgsfield;
  res.json({
    user: session.user,
    wallet: { balance_credits: hf.credits || 0, reserved_credits: 0 },
    pricing: { credits_per_second: 20, min_seconds: 4, character_credits: 60, character_image_credits: 15 },
    limits: { max_upload_mb: 350, maxClipSeconds: 60, maxDuration: 29.7, minDuration: 4 },
    features: {
      email_login: false,
      user_photo_characters: true
    },
    higgsfield: { ...hf, apiCredentialsConfigured: !!(hf.apiCredential || (hf.apiKey && hf.apiSecret)) },
    paywall: { locked: false, free_videos: 99999, free_left: 99999, price_label: 'Grátis' }
  });
});

// 3. SSE /api/events: Mantém conexão aberta para atualizações em tempo real
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res, userId: getSession(req).user.id });

  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify({ spend: { today: 0, month: 0, total: 0 } })}\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(timer);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// 4. CLIPS: Upload de vídeos base
app.post('/api/clips', async (req, res) => {
  try {
    const session = getSession(req);
    const userId = session?.user?.id || 'anonymous';
    const direct = req.body?.uploadName ? await directUpload(req) : null;
    if (direct && !direct.mime.startsWith('video/')) return res.status(415).json({ error: 'Envie um vídeo.' });
    const rawName = req.body?.name || req.query.name || `video_${Date.now()}.mp4`;
    const safeName = direct?.name || `${crypto.randomUUID()}_${path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const filePath = path.join(UPLOADS_DIR, safeName);

    if (direct) await direct.file.download({ destination: filePath });
    else {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Vídeo vazio.' });
      fs.writeFileSync(filePath, req.body);
      saveUploadedBuffer(safeName, req.body, req.headers['content-type'] || 'video/mp4');
    }

    const thumbName = `thumb_${Date.now()}.jpg`;
    const thumbPath = path.join(UPLOADS_DIR, thumbName);

    await new Promise(resolve => {
      ffmpeg(filePath)
        .screenshots({
          timestamps: ['00:00:01'],
          filename: thumbName,
          folder: UPLOADS_DIR,
          size: '320x?'
        })
        .on('end', resolve)
        .on('error', () => resolve());
    });
    if (fs.existsSync(thumbPath)) saveUploadedBuffer(thumbName, fs.readFileSync(thumbPath), 'image/jpeg');

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      const duration = metadata?.format?.duration || 10;
      const stream = metadata?.streams?.find(s => s.codec_type === 'video') || {};
      const width = stream.width || 1080;
      const height = stream.height || 1920;

      const clip = {
        id: `clip_${Date.now()}`,
        userId,
        name: rawName,
        url: `/api/uploads/${safeName}`,
        localPath: filePath,
        thumbUrl: fs.existsSync(thumbPath) ? `/api/uploads/${thumbName}` : `/api/uploads/${safeName}`,
        info: {
          duration: Math.round(duration * 10) / 10,
          width,
          height,
          hdr: false
        },
        trim: { start: 0, end: duration }
      };

      const clips = readJson(CLIPS_FILE, []);
      clips.unshift(clip);
      writeJson(CLIPS_FILE, clips);

      broadcastEvent('clip', clip);
      res.json(clip);
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/clips/:id', (req, res) => {
  const id = req.params.id;
  const clips = readJson(CLIPS_FILE, []);
  const clip = clips.find(c => c.id === id && owns(req, c));
  if (clip) {
    for (const field of ['name', 'trim']) {
      if (req.body?.[field] !== undefined) clip[field] = req.body[field];
    }
    writeJson(CLIPS_FILE, clips);
    broadcastEvent('clip', clip);
  }
  res.json(clip || {});
});

app.delete('/api/clips/:id', (req, res) => {
  const id = req.params.id;
  let clips = readJson(CLIPS_FILE, []);
  clips = clips.filter(c => c.id !== id || !owns(req, c));
  writeJson(CLIPS_FILE, clips);
  broadcastEvent('clip:removed', { id, userId: getSession(req).user.id });
  res.json({ success: true });
});

// 5. DOWNLOADS: Download de TikTok / Instagram direto no Estúdio
app.post('/api/downloads', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'URL do vídeo é obrigatória' });

  const session = getSession(req);
  const userId = session?.user?.id || 'anonymous';
  const filename = `social_${Date.now()}.mp4`;
  const outputPath = path.join(UPLOADS_DIR, filename);
  const thumbName = `thumb_social_${Date.now()}.jpg`;
  const downloadJobId = `dl_${Date.now()}`;

  const downloadJob = {
    id: downloadJobId,
    userId,
    kind: 'download',
    title: text.slice(0, 50),
    status: 'running',
    input: { url: text, label: 'TikTok/Reels' },
    steps: [{ key: 'download', status: 'running', progress: 0.1 }]
  };

  broadcastEvent('job', downloadJob);

  const yt = spawn('yt-dlp', [
    '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format', 'mp4',
    '-o', outputPath,
    text
  ]);

  yt.on('close', async code => {
    if (code === 0 && fs.existsSync(outputPath)) {
      await new Promise(r => {
        ffmpeg(outputPath).screenshots({ timestamps: ['00:00:01'], filename: thumbName, folder: UPLOADS_DIR, size: '320x?' }).on('end', r).on('error', r);
      });

      ffmpeg.ffprobe(outputPath, (err, metadata) => {
        const duration = metadata?.format?.duration || 15;
        const stream = metadata?.streams?.find(s => s.codec_type === 'video') || {};

        const clip = {
          id: `clip_${Date.now()}`,
          userId,
          name: `Vídeo Viral (${Math.round(duration)}s)`,
          url: `/uploads/${filename}`,
          localPath: outputPath,
          thumbUrl: `/uploads/${thumbName}`,
          info: { duration: Math.round(duration * 10) / 10, width: stream.width || 1080, height: stream.height || 1920 },
          trim: { start: 0, end: duration }
        };

        const clips = readJson(CLIPS_FILE, []);
        clips.unshift(clip);
        writeJson(CLIPS_FILE, clips);
        broadcastEvent('clip', clip);

        downloadJob.status = 'done';
        downloadJob.clipIds = [clip.id];
        broadcastEvent('job', downloadJob);

        res.json({ jobs: [downloadJob], existing: [], skipped: [] });
      });
    } else {
      downloadJob.status = 'failed';
      downloadJob.error = 'Falha ao baixar vídeo pelo link.';
      broadcastEvent('job', downloadJob);
      res.status(500).json({ error: downloadJob.error });
    }
  });
});

// 6. UPLOADS E IMAGENS DE REFERÊNCIA
app.post('/api/uploads/prepare', async (req, res) => {
  if (!storageBucket || !firestore) return res.status(501).json({ error: 'Upload direto requer armazenamento persistente.' });
  const { name, contentType, size } = req.body || {};
  if (typeof name !== 'string' || typeof contentType !== 'string' || !/^(image|video)\//.test(contentType)
    || !Number.isFinite(size) || size < 1 || size > 350 * 1024 * 1024) {
    return res.status(400).json({ error: 'Arquivo inválido ou maior que 350 MB.' });
  }
  const uploadName = `direct_${crypto.randomUUID()}_${path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const file = storageBucket.file(`uploads/${uploadName}`);
  try {
    const [uploadUrl] = await file.getSignedUrl({ version: 'v4', action: 'write', expires: Date.now() + 15 * 60000, contentType });
    await firestore.collection('character_school_pending_uploads').doc(uploadName).set({
      userId: getSession(req).user.id, contentType, size, createdAt: Date.now()
    });
    res.json({ uploadName, uploadUrl, contentType });
  } catch (error) { res.status(503).json({ error: `Não foi possível preparar upload: ${error.message}` }); }
});

async function directUpload(req) {
  const name = req.body?.uploadName;
  if (!name || typeof name !== 'string' || !/^direct_[a-f0-9-]+_[a-zA-Z0-9._-]+$/.test(name) || !storageBucket) return null;
  const pendingRef = firestore.collection('character_school_pending_uploads').doc(name);
  const pending = await pendingRef.get();
  const record = pending.data();
  if (!record || record.userId !== getSession(req).user.id || Date.now() - record.createdAt > 20 * 60000) throw new Error('Upload não autorizado ou expirado.');
  const file = storageBucket.file(`uploads/${name}`);
  const [metadata] = await file.getMetadata();
  if (Number(metadata.size) !== record.size || metadata.contentType !== record.contentType) throw new Error('Arquivo enviado não corresponde ao upload preparado.');
  await file.setMetadata({ metadata: { userId: record.userId } });
  await pendingRef.delete();
  return { name, mime: record.contentType, file };
}

app.post('/api/uploads', async (req, res) => {
  try {
    const direct = req.body?.uploadName ? await directUpload(req) : null;
    if (!direct && (!Buffer.isBuffer(req.body) || !req.body.length)) return res.status(400).json({ error: 'Arquivo vazio.' });
    const rawName = req.query.name || `upload_${Date.now()}.jpg`;
    const ext = path.extname(rawName).toLowerCase().replace('.', '') || 'jpeg';
    const mime = direct?.mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    const safeName = direct?.name || `up_${crypto.randomUUID()}_${path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    let base64 = null;
    if (!direct && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      saveUploadedBuffer(safeName, req.body, mime);
      base64 = `data:${mime};base64,${req.body.toString('base64')}`;
    }

    const url = storageBucket ? `/api/uploads/${safeName}` : (base64 || `/uploads/${safeName}`);
    res.json({
      path: `/uploads/${safeName}`,
      url: url
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/reference-images', async (req, res) => {
  try {
    const direct = req.body?.uploadName ? await directUpload(req) : null;
    if (!direct && (!Buffer.isBuffer(req.body) || !req.body.length)) return res.status(400).json({ error: 'Imagem vazia.' });
    if (direct && !direct.mime.startsWith('image/')) return res.status(415).json({ error: 'Envie uma imagem.' });
    if (!direct && !String(req.headers['content-type'] || '').match(/^(application\/octet-stream|image\/)/)) return res.status(415).json({ error: 'Envie uma imagem.' });
    const rawName = req.body?.name || req.query.name || `ref_${Date.now()}.jpg`;
    const ext = path.extname(rawName).toLowerCase().replace('.', '') || 'jpeg';
    const mime = direct?.mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
    const safeName = direct?.name || `ref_${crypto.randomUUID()}_${path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    let base64 = null;
    if (!direct && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      saveUploadedBuffer(safeName, req.body, mime);
      base64 = `data:${mime};base64,${req.body.toString('base64')}`;
    }

    const url = storageBucket ? `/api/uploads/${safeName}` : (base64 || `/uploads/${safeName}`);
    const refObj = {
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      userId: getSession(req).user.id,
      url: url,
      thumbUrl: url,
      name: rawName,
      createdAt: new Date().toISOString()
    };

    uploadedReferenceMap.set(refObj.id, refObj);
    const refList = readJson(REFERENCE_IMAGES_FILE, []);
    refList.unshift(refObj);
    writeJson(REFERENCE_IMAGES_FILE, refList);

    const session = getSession(req);
    if (session) {
      if (!session.referenceImages) session.referenceImages = [];
      session.referenceImages.push(refObj);
    }

    res.json({ reference: refObj });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/reference-images/:id', (req, res) => {
  const id = req.params.id;
  uploadedReferenceMap.delete(id);
  let refList = readJson(REFERENCE_IMAGES_FILE, []);
  refList = refList.filter(r => r.id !== id || !owns(req, r));
  writeJson(REFERENCE_IMAGES_FILE, refList);
  res.json({ ok: true });
});

// PERSONAGENS (CRUD COMPLETO)
app.post('/api/characters', (req, res) => {
  const session = getSession(req);
  const userId = session?.user?.id || 'anonymous';
  const characters = readJson(CHARACTERS_FILE, []);
  const initialImages = Array.isArray(req.body?.images) ? req.body.images.filter(i =>
    i && typeof i.url === 'string' && (i.url.startsWith('data:image/') || i.url.startsWith('/api/uploads/'))
    && !/\/(vector-|card-)/.test(i.url)).map(i => ({
      id: i.id || `img_${crypto.randomUUID()}`, url: i.url, thumbUrl: i.thumbUrl || i.url,
      role: i.role || 'card', label: i.label || 'Card', useAsRef: i.useAsRef !== false
    })) : [];
  const newChar = {
    id: `char_${Date.now()}`,
    userId,
    name: req.body?.name || 'Novo Personagem',
    code: `CS${String(characters.length + 1).padStart(3, '0')}`,
    identityEn: req.body?.identityEn || '',
    description: req.body?.description || '',
    images: initialImages,
    cover: initialImages.some(i => i.id === req.body?.cover) ? req.body.cover : (initialImages[0]?.id || null),
    favorite: false,
    library: false,
    createdAt: new Date().toISOString()
  };
  characters.unshift(newChar);
  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character', newChar);
  res.json(newChar);
});

app.patch('/api/characters/:id', (req, res) => {
  const id = req.params.id;
  const characters = readJson(CHARACTERS_FILE, []);
  const char = characters.find(c => c.id === id);
  if (!char || !owns(req, char)) return res.status(404).json({ error: 'Personagem não encontrado' });

  if (req.body.name !== undefined) char.name = req.body.name;
  if (req.body.identityEn !== undefined) char.identityEn = req.body.identityEn;
  if (req.body.description !== undefined) char.description = req.body.description;
  if (req.body.cover !== undefined) {
    if (req.body.cover && !char.images.some(i => i.id === req.body.cover)) return res.status(400).json({ error: 'Capa inválida.' });
    char.cover = req.body.cover;
  }
  if (req.body.favorite !== undefined) char.favorite = req.body.favorite;

  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character', char);
  res.json(char);
});

app.delete('/api/characters/:id', (req, res) => {
  const id = req.params.id;
  let characters = readJson(CHARACTERS_FILE, []);
  characters = characters.filter(c => c.id !== id || !owns(req, c));
  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character:removed', { id, userId: getSession(req).user.id });
  res.json({ ok: true });
});

// Upload de fotos/imagens do personagem
app.post('/api/characters/:id/images', async (req, res) => {
  const charId = req.params.id;
  const characters = readJson(CHARACTERS_FILE, []);
  const char = characters.find(c => c.id === charId);
  if (!char || !owns(req, char)) return res.status(404).json({ error: 'Personagem não encontrado' });
  let direct = null;
  try { direct = req.body?.uploadName ? await directUpload(req) : null; }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!direct && (!Buffer.isBuffer(req.body) || !req.body.length)) return res.status(400).json({ error: 'Imagem vazia.' });
  if (direct && !direct.mime.startsWith('image/')) return res.status(415).json({ error: 'Envie uma imagem.' });

  const rawName = req.body?.name || req.query.name || `photo_${Date.now()}.jpg`;
  const ext = path.extname(rawName).toLowerCase().replace('.', '') || 'jpeg';
  const mime = direct?.mime || (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
  const safeName = direct?.name || `ref_${crypto.randomUUID()}_${path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_')}`;

  let base64 = null;
  if (!direct && req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
    saveUploadedBuffer(safeName, req.body, mime);
    base64 = `data:${mime};base64,${req.body.toString('base64')}`;
  }

  const url = storageBucket ? `/api/uploads/${safeName}` : (base64 || `/uploads/${safeName}`);
  const thumbUrl = url;

  const imgObj = {
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    url: storageBucket ? url : (base64 || url),
    thumbUrl: thumbUrl,
    role: char.images.length === 0 ? 'card' : char.images.length === 1 ? 'front' : char.images.length === 2 ? 'profile' : 'right',
    label: char.images.length === 0 ? 'Card' : char.images.length === 1 ? 'Frente' : char.images.length === 2 ? 'Perfil' : '3/4',
    useAsRef: true
  };

  char.images.push(imgObj);
  if (!char.cover) char.cover = imgObj.id;

  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character', char);
  res.json(char);
});

app.patch('/api/characters/:id/images/:imgId', (req, res) => {
  const { id, imgId } = req.params;
  const characters = readJson(CHARACTERS_FILE, []);
  const char = characters.find(c => c.id === id);
  if (!char || !owns(req, char)) return res.status(404).json({ error: 'Personagem não encontrado' });
  const img = char.images.find(i => i.id === imgId);
  if (img) {
    if (req.body.useAsRef !== undefined) {
      if (req.body.useAsRef === false && img.useAsRef && !char.images.some(i => i.id !== img.id && i.useAsRef)) {
        return res.status(400).json({ error: 'Mantenha pelo menos uma imagem de referência.' });
      }
      img.useAsRef = !!req.body.useAsRef;
    }
    if (typeof req.body.label === 'string') img.label = req.body.label.slice(0, 80);
    writeJson(CHARACTERS_FILE, characters);
    broadcastEvent('character', char);
  }
  res.json(char);
});

app.delete('/api/characters/:id/images/:imgId', (req, res) => {
  const { id, imgId } = req.params;
  const characters = readJson(CHARACTERS_FILE, []);
  const char = characters.find(c => c.id === id);
  if (!char || !owns(req, char)) return res.status(404).json({ error: 'Personagem não encontrado' });
  char.images = char.images.filter(i => i.id !== imgId);
  if (char.cover === imgId) {
    char.cover = char.images[0]?.id || null;
  }
  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character', char);
  res.json(char);
});

app.post('/api/characters/:id/images/:imgId/upscale', (req, res) => {
  res.json({ ok: true, status: 'queued' });
});

// GERAÇÃO DE OPÇÕES DE IMAGEM & SALVAMENTO
app.post('/api/images', async (req, res) => {
  try {
    const session = getSession(req);
    const userId = session?.user?.id || 'anonymous';
    const { model, prompt, n = 2, opts, title, refs, characterId, referenceIds } = req.body;
    if (!Number.isInteger(n) || n < 1 || n > 4) return res.status(400).json({ error: 'Escolha entre 1 e 4 imagens.' });
    if (characterId && !readJson(CHARACTERS_FILE, []).some(c => c.id === characterId && owns(req, c))) return res.status(404).json({ error: 'Personagem não encontrado.' });

    const jobId = `job_img_${Date.now()}`;
    const generatedUrls = [];

    // 1. Coleta referências anexadas pelo usuário (fotos reais enviadas)
    const refList = readJson(REFERENCE_IMAGES_FILE, []);
    if (Array.isArray(referenceIds) && referenceIds.length > 0) {
      referenceIds.forEach(refId => {
        const found = uploadedReferenceMap.get(refId) || refList.find(r => r.id === refId);
        if (found && owns(req, found) && found.url) {
          generatedUrls.push(found.url);
        }
      });
    }
    if (Array.isArray(referenceIds) && referenceIds.length && !generatedUrls.length) return res.status(404).json({ error: 'Fotos de referência não encontradas.' });

    // 2. Resolve imagens pertencentes ao personagem autenticado.
    if (generatedUrls.length === 0 && Array.isArray(refs) && refs.length > 0) {
      refs.forEach(r => {
        const character = readJson(CHARACTERS_FILE, []).find(c => c.id === r.characterId && owns(req, c));
        const image = character?.images?.find(i => i.id === r.imageId);
        if (image?.url && !/\/(vector-|card-)/.test(image.url) && !generatedUrls.includes(image.url)) generatedUrls.push(image.url);
      });
    }

    // 3. Se referências de fotos foram enviadas, usamos as fotos do usuário para compor as opções
    if (generatedUrls.length > 0) {
      const userRefPool = [...generatedUrls];
      while (generatedUrls.length < n) {
        generatedUrls.push(userRefPool[generatedUrls.length % userRefPool.length]);
      }
    } else {
      // 4. Se NENHUMA foto foi anexada, geramos fotos realistas reais com IA a partir da descrição (prompt)
      const cleanPrompt = (prompt || 'photorealistic studio portrait of a character, high resolution, 8k')
        .replace(/Reference image 1 is ONLY the style anchor[^.]*\./gi, '')
        .trim();

      for (let i = 0; i < n; i++) {
        try {
          const seed = Math.floor(Math.random() * 10000000);
          const aiUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt + ', photorealistic, master studio lighting, 8k quality, neutral background')}?seed=${seed}&width=768&height=1024&model=flux&nologo=true`;

          const response = await axios.get(aiUrl, { responseType: 'arraybuffer', timeout: 30000 });
          if (!String(response.headers['content-type'] || '').startsWith('image/')) throw new Error('O provedor não retornou imagem');
          const imgBuf = Buffer.from(response.data);
          const safeName = `gen_${Date.now()}_${i}.jpg`;
          saveUploadedBuffer(safeName, imgBuf, 'image/jpeg');
          generatedUrls.push(storageBucket ? `/api/uploads/${safeName}` : `data:image/jpeg;base64,${imgBuf.toString('base64')}`);
        } catch (err) {
          throw new Error(`Falha ao gerar imagem real: ${err.message}`);
        }
      }
    }

    const job = {
      id: jobId,
      userId,
      kind: 'image',
      status: 'done',
      title: title || `Imagem · ${characterId ? 'Personagem' : 'Novo Personagem'}`,
      createdAt: new Date().toISOString(),
      input: {
        model,
        prompt,
        n,
        opts,
        characterId,
        referenceIds
      },
      outputs: {
        imageUrls: generatedUrls.slice(0, n)
      },
      savedImages: []
    };

    const jobs = readJson(JOBS_FILE, []);
    jobs.unshift(job);
    writeJson(JOBS_FILE, jobs);
    broadcastEvent('job', job);

    res.json(job);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/images/save', (req, res) => {
  try {
    const { jobId, index = 0, characterId, name, identityEn, makeCover, kind = 'card' } = req.body;
    const jobs = readJson(JOBS_FILE, []);
    const job = jobs.find(j => j.id === jobId);
    if (!job || !owns(req, job)) return res.status(404).json({ error: 'Pedido de imagem não encontrado' });

    if (!job.savedImages) job.savedImages = [];
    if (!job.savedImages.includes(index)) job.savedImages.push(index);
    writeJson(JOBS_FILE, jobs);
    broadcastEvent('job', job);

    const imgUrl = job.outputs?.imageUrls?.[index] || job.outputs?.imageUrls?.[0];
    if (!imgUrl) return res.status(400).json({ error: 'Nenhuma imagem encontrada neste pedido' });
    const characters = readJson(CHARACTERS_FILE, []);
    let char = characterId ? characters.find(c => c.id === characterId && owns(req, c)) : null;
    if (characterId && !char) return res.status(404).json({ error: 'Personagem não encontrado' });

    const session = getSession(req);
    const userId = session?.user?.id || 'anonymous';

    if (!char) {
      char = {
        id: `char_${Date.now()}`,
        userId,
        name: name || 'Novo Personagem',
        code: `CS${String(characters.length + 1).padStart(3, '0')}`,
        identityEn: identityEn || '',
        description: '',
        images: [],
        cover: null,
        favorite: false,
        library: false,
        createdAt: new Date().toISOString()
      };
      characters.unshift(char);
    } else {
      if (name && name !== 'Novo personagem' && name !== 'Novo Personagem') char.name = name;
      if (identityEn) char.identityEn = identityEn;
    }

    const imgObj = {
      id: `img_${Date.now()}_${index}`,
      url: imgUrl,
      thumbUrl: imgUrl,
      role: kind === 'sheet' ? 'sheet' : kind === 'fullbody' ? 'fullbody' : 'card',
      label: kind === 'sheet' ? 'Ficha' : kind === 'fullbody' ? 'Corpo inteiro' : 'Card',
      useAsRef: true
    };

    char.images.push(imgObj);
    if (makeCover || !char.cover) char.cover = imgObj.id;

    writeJson(CHARACTERS_FILE, characters);
    broadcastEvent('character', char);
    res.json(char);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// JOBS E GERENCIAMENTO DE FILA
app.delete('/api/jobs/:id', (req, res) => {
  const id = req.params.id;
  let jobs = readJson(JOBS_FILE, []);
  jobs = jobs.filter(j => j.id !== id || !owns(req, j));
  writeJson(JOBS_FILE, jobs);
  broadcastEvent('job:removed', { id, userId: getSession(req).user.id });
  res.json({ ok: true });
});

app.get('/api/jobs/:id/status', async (req, res) => {
  const job = readJson(JOBS_FILE, []).find(j => j.id === req.params.id && owns(req, j));
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  try { return res.json(await refreshTakeJob(req, res, job)); }
  catch (error) { return res.status(502).json({ error: error.message }); }
});

app.post('/api/jobs/:id/retry', async (req, res) => {
  const id = req.params.id;
  const jobs = readJson(JOBS_FILE, []);
  const job = jobs.find(j => j.id === id);
  if (!job || !owns(req, job)) return res.status(404).json({ error: 'Job não encontrado' });
  if (job.kind !== 'take' || !['failed', 'canceled'].includes(job.status)) return res.status(409).json({ error: 'Só é possível reenviar uma geração de vídeo encerrada com erro ou cancelada.' });
  try {
    const retried = await createTakeJob(req, res, {
      characterIds: [job.input.characterId], clipIds: [job.input.clipId],
      prompt: job.input.prompt, swapModels: [job.input.swapModel]
    });
    retried.retryOf = job.id;
    writeJson(JOBS_FILE, readJson(JOBS_FILE, []));
    return res.json({ jobs: [retried] });
  } catch (error) { return res.status(502).json({ error: error.message }); }
});

app.post('/api/jobs/:id/cancel', async (req, res) => {
  const id = req.params.id;
  const jobs = readJson(JOBS_FILE, []);
  const job = jobs.find(j => j.id === id);
  if (!job || !owns(req, job)) return res.status(404).json({ error: 'Job não encontrado' });
  if (job.status !== 'running' || !job.providerRequestId) return res.status(409).json({ error: 'Este job não está em geração ativa.' });
  return res.status(409).json({ error: 'O Higgsfield não oferece cancelamento de um Genjutsu em execução por esta conexão.' });
});

app.patch('/api/jobs/:id', (req, res) => {
  const id = req.params.id;
  const jobs = readJson(JOBS_FILE, []);
  const job = jobs.find(j => j.id === id && owns(req, j));
  if (job) {
    for (const field of ['title', 'favorite']) {
      if (req.body?.[field] !== undefined) job[field] = req.body[field];
    }
    writeJson(JOBS_FILE, jobs);
    broadcastEvent('job', job);
  }
  res.json(job || {});
});

app.post('/api/jobs/:id/upscale', (req, res) => {
  const id = req.params.id;
  res.json({ ok: true, id, status: 'queued' });
});

// PASTAS DE PROJETOS
app.post('/api/projects', (req, res) => {
  const projects = readJson(PROJECTS_FILE, []);
  const p = {
    id: `proj_${Date.now()}`,
    userId: getSession(req).user.id,
    name: req.body?.name || `Projeto ${projects.length + 1}`,
    target: req.body?.target || 15,
    characterIds: []
  };
  projects.push(p);
  writeJson(PROJECTS_FILE, projects);
  res.json(p);
});

app.patch('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  const projects = readJson(PROJECTS_FILE, []);
  const p = projects.find(x => x.id === id && owns(req, x));
  if (!p) return res.status(404).json({ error: 'Projeto não encontrado' });
  if (req.body.name !== undefined) p.name = req.body.name;
  if (req.body.target !== undefined) p.target = req.body.target;
  if (Array.isArray(req.body.add)) {
    req.body.add.forEach(cid => { if (!p.characterIds.includes(cid)) p.characterIds.push(cid); });
  }
  if (Array.isArray(req.body.remove)) {
    p.characterIds = p.characterIds.filter(cid => !req.body.remove.includes(cid));
  }
  writeJson(PROJECTS_FILE, projects);
  res.json(p);
});

app.delete('/api/projects/:id', (req, res) => {
  const id = req.params.id;
  let projects = readJson(PROJECTS_FILE, []);
  projects = projects.filter(x => x.id !== id || !owns(req, x));
  writeJson(PROJECTS_FILE, projects);
  res.json({ ok: true });
});

// 7. ORÇAMENTO (ESTIMATE): Calcula os créditos e partes do vídeo
app.post('/api/estimate', (req, res) => {
  const { clipIds, swapModels } = req.body;
  const clips = readJson(CLIPS_FILE, []);
  let totalSeconds = 0;

  if (Array.isArray(clipIds)) {
    clipIds.forEach(id => {
      const c = clips.find(x => x.id === id && owns(req, x));
      if (c) totalSeconds += Number(c.info?.duration || 10);
    });
  }

  const session = getSession(req);
  const userCredits = session?.higgsfield?.credits || 0;
  const modelId = swapModels?.[0] || 'hf-genjutsu-1080p';
  const ratePerSecond = modelId === 'hf-genjutsu-720p' ? 7 : 20;
  if (!totalSeconds) return res.status(400).json({ error: 'Selecione um vídeo válido.' });
  const duration = Math.min(30, Math.max(4, Math.ceil(totalSeconds)));
  const credits = duration * ratePerSecond;

  res.json({
    mode: 'own',
    credits,
    enough: userCredits >= credits,
    higgsfield_credits: userCredits,
    higgsfield_balance: userCredits,
    duration_choices: [
      { max_seconds: null, duration_s: duration, parts_count: duration > 30 ? 2 : 1, credits },
      { max_seconds: 30, duration_s: Math.min(30, duration), parts_count: 1, credits: Math.min(30, duration) * ratePerSecond }
    ]
  });
});

// 8. TAKES: envio assíncrono ao Genjutsu e consulta do resultado real
function takeFailure(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function takeMedia(req, mediaUrl, flag, index) {
  const match = /^\/api\/uploads\/([a-zA-Z0-9._-]+)$/.exec(mediaUrl || '');
  if (!match) {
    const data = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(mediaUrl || '');
    if (flag !== '--image-references' || !data) throw takeFailure('Envie novamente a foto ou o vídeo antes de gerar.');
    return { flag, filename: `image-${index}.${data[1] === 'jpeg' ? 'jpg' : data[1]}`,
      write: filename => fs.promises.writeFile(filename, Buffer.from(data[2], 'base64')) };
  }
  return { flag, filename: `${flag === '--video-references' ? 'video' : 'image'}-${index}${path.extname(match[1]) || (flag === '--video-references' ? '.mp4' : '.jpg')}`,
    write: async filename => {
      if (storageBucket) {
        const file = storageBucket.file(`uploads/${match[1]}`);
        let metadata;
        try { [metadata] = await file.getMetadata(); }
        catch { throw takeFailure('Arquivo de referência não encontrado. Envie-o novamente.'); }
        if (metadata.metadata?.userId !== getSession(req).user.id) throw takeFailure('Arquivo de outra conta não pode ser usado.', 403);
        await file.download({ destination: filename });
      } else {
        const cached = uploadedFilesBufferMap.get(match[1]);
        if (cached) await fs.promises.writeFile(filename, cached.buffer);
        else await fs.promises.copyFile(path.join(UPLOADS_DIR, match[1]), filename);
      }
    } };
}

async function createTakeJob(req, res, { characterIds, clipIds, prompt, swapModels }) {
  const session = getSession(req);
  if (!session?.higgsfield?.connected) throw takeFailure('Conecte sua conta Higgsfield para gerar vídeos.', 401);
  if (!session.higgsfield.token || !session.higgsfield.refreshToken) throw takeFailure('Conecte novamente sua conta Higgsfield para gerar.', 401);
  const character = readJson(CHARACTERS_FILE, []).find(c => c.id === characterIds?.[0] && owns(req, c));
  const clip = readJson(CLIPS_FILE, []).find(c => c.id === clipIds?.[0] && owns(req, c));
  if (!character || !clip) throw takeFailure('Selecione um personagem e um vídeo base no Estúdio.');
  const modelId = swapModels?.[0] || 'hf-genjutsu-1080p';
  if (!['hf-genjutsu-720p', 'hf-genjutsu-1080p'].includes(modelId)) throw takeFailure('Qualidade de vídeo inválida.');
  const duration = Number(clip.info?.duration);
  if (!Number.isFinite(duration) || duration < 4 || duration > 30) throw takeFailure('O Genjutsu aceita vídeos de 4 a 30 segundos.');
  const refs = (character.images || []).filter(image => image.useAsRef);
  if (!refs.length) throw takeFailure('Marque ao menos uma foto real do personagem como referência.');
  if (refs.length > 8) throw takeFailure('O Genjutsu aceita até oito fotos de referência.');
  const media = [takeMedia(req, clip.url, '--video-references', 0),
    ...refs.map((image, index) => takeMedia(req, image.url, '--image-references', index))];
  const balance = await fetchRealHiggsfieldBalance(session.higgsfield);
  if (!balance) throw takeFailure('Não foi possível confirmar o saldo do Higgsfield. Atualize a conexão e tente novamente.', 502);
  session.higgsfield.credits = balance.credits;
  session.higgsfield.available = balance.credits;
  setSessionCookie(res, session);
  const expectedCost = Math.ceil(duration) * (modelId === 'hf-genjutsu-720p' ? 7 : 20);
  if (balance.credits < expectedCost) throw takeFailure(`Créditos insuficientes no Higgsfield: são necessários ${expectedCost}.`, 409);
  const jobs = readJson(JOBS_FILE, []);
  const submittedAt = new Date().toISOString();
  const job = {
    id: `take_${crypto.randomUUID()}`, userId: session.user.id,
    title: `${character.name} · ${clip.name}`, kind: 'take', status: 'running',
    stage: 'submitting', billing: 'own', createdAt: submittedAt,
    input: { characterId: character.id, clipId: clip.id, swapModel: modelId, prompt: prompt || '' },
    price_credits: expectedCost,
    outputs: { thumbUrl: clip.thumbUrl },
    steps: [{ key: 'swap', status: 'running', parts: [{ status: 'running', submittedAt }] }]
  };
  jobs.unshift(job);
  writeJson(JOBS_FILE, jobs);
  await requestStore.getStore()?.lastWrite;
  try {
    const previousToken = session.higgsfield.token;
    const result = await higgsfieldCli.invoke(['generate', 'create', 'hf_mult_motion_control',
      '--prompt', prompt || `Replace the actor with ${character.name}, photorealistic, preserve natural motion`,
      '--resolution', modelId === 'hf-genjutsu-720p' ? '720p' : '1080p'], session, media);
    const submitted = Array.isArray(result) ? result[0] : result;
    const providerId = typeof submitted === 'string' ? submitted.trim() : submitted?.id || submitted?.job_id;
    if (!providerId || !/^[a-f0-9-]{36}$/i.test(providerId)) throw new Error('O Higgsfield não retornou o identificador do vídeo.');
    if (session.higgsfield.token !== previousToken) setSessionCookie(res, session);
    job.providerRequestId = providerId;
    job.stage = 'generating';
    job.providerStatus = result.status || 'queued';
    writeJson(JOBS_FILE, jobs);
    broadcastEvent('job', job);
    return job;
  } catch (error) {
    job.status = 'failed';
    job.stage = 'failed';
    job.error = error.message;
    writeJson(JOBS_FILE, jobs);
    broadcastEvent('job', job);
    throw takeFailure(error.message, 502);
  }
}

async function refreshTakeJob(req, res, job) {
  if (job.kind !== 'take' || job.status !== 'running' || !job.providerRequestId) return job;
  const session = getSession(req);
  if (!session?.higgsfield?.token || !session.higgsfield.refreshToken) throw takeFailure('Conecte novamente sua conta Higgsfield para acompanhar o vídeo.', 401);
  const previousToken = session.higgsfield.token;
  const result = await higgsfieldCli.invoke(['generate', 'get', job.providerRequestId], session);
  if (session.higgsfield.token !== previousToken) setSessionCookie(res, session);
  const status = String(result.status || '').toLowerCase();
  const jobs = readJson(JOBS_FILE, []);
  const current = jobs.find(item => item.id === job.id);
  if (!current || current.status !== 'running') return current || job;
  current.providerStatus = status;
  if (status === 'completed') {
    const videoUrl = result.result_url || result.video?.url || result.output?.video?.url || result.output?.video_url || result.result?.video?.url || result.video_url;
    if (!videoUrl || !/^https:\/\//i.test(videoUrl)) {
      current.status = 'failed'; current.stage = 'failed';
      current.error = 'O Higgsfield concluiu o pedido, mas não retornou um vídeo válido.';
    } else {
      current.status = 'done'; current.stage = 'ready';
      current.finishedAt = new Date().toISOString();
      current.outputs = { ...current.outputs, masterUrl: videoUrl };
      current.steps = [{ key: 'swap', status: 'done', parts: [{ status: 'done' }] }];
      const balance = await fetchRealHiggsfieldBalance(session.higgsfield);
      if (balance) {
        session.higgsfield.credits = balance.credits;
        session.higgsfield.available = balance.credits;
        session.higgsfield.checkedAt = new Date().toISOString();
        setSessionCookie(res, session);
      }
    }
  } else if (['failed', 'nsfw', 'canceled'].includes(status)) {
    current.status = status === 'canceled' ? 'canceled' : 'failed';
    current.stage = current.status;
    current.errorKind = status === 'nsfw' ? 'nsfw' : undefined;
    current.error = String(result.error?.message || result.error || result.message || `Higgsfield: ${status}`).slice(0, 500);
  }
  writeJson(JOBS_FILE, jobs);
  broadcastEvent('job', current);
  return current;
}

app.post('/api/takes', async (req, res) => {
  try {
    const job = await createTakeJob(req, res, req.body || {});
    res.json({ jobs: [job] });
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message });
  }
});

// 9. CONEXÃO HIGGSFIELD VIA OAUTH 2.0 PKCE REAL (CLERK HIGGSFIELD)
const HIGGSFIELD_CLIENT_ID = 'sRGCQJvvJkPrrtRj';

function readLocalCliCredentials() {
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (!userProfile) return null;
    const credPath = path.join(userProfile, '.higgsfield', 'credentials.json');
    if (fs.existsSync(credPath)) {
      return JSON.parse(fs.readFileSync(credPath, 'utf8'));
    }
  } catch {}
  return null;
}

function syncLocalCliCredentials(cfg) {
  try {
    const userProfile = process.env.USERPROFILE || process.env.HOME;
    if (!userProfile) return;
    const hfDir = path.join(userProfile, '.higgsfield');
    if (!fs.existsSync(hfDir)) fs.mkdirSync(hfDir, { recursive: true });
    
    if (cfg.token) {
      const credPath = path.join(hfDir, 'credentials.json');
      const credData = {
        access_token: cfg.token,
        refresh_token: cfg.refreshToken || '',
        token_type: 'Bearer',
        client_id: HIGGSFIELD_CLIENT_ID,
        workspace_id: cfg.workspaceId || ''
      };
      fs.writeFileSync(credPath, JSON.stringify(credData, null, 2), 'utf8');
    }
    if (cfg.workspaceId) {
      const confPath = path.join(hfDir, 'config.json');
      const confData = {
        workspace_id: cfg.workspaceId
      };
      fs.writeFileSync(confPath, JSON.stringify(confData, null, 2), 'utf8');
    }
  } catch (e) {}
}

function savePkceSession(session) {
  const sessions = readJson(SESSIONS_FILE, {});
  sessions[session.id] = session;
  if (session.state) sessions[session.state] = session;
  writeJson(SESSIONS_FILE, sessions);
}

function getPkceSession(idOrState) {
  if (!idOrState) return null;
  const sessions = readJson(SESSIONS_FILE, {});
  return sessions[idOrState] || Object.values(sessions).find(s => s.state === idOrState || s.id === idOrState) || null;
}

function extractPkceFromState(state) {
  return null;
}

function createHiggsfieldLogin(req) {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  // Este client_id é do CLI oficial; Clerk aceita somente o callback loopback registrado.
  // O aluno cola a URL resultante no formulário, que troca o código com este mesmo URI.
  const redirectUri = 'http://localhost:8765/callback';
  const state = base64Url(crypto.randomBytes(24));
  const loginId = `login_${Date.now()}`;

  const authorizeUrl = 'https://clerk.higgsfield.ai/oauth/authorize?' + new URLSearchParams({
    client_id: HIGGSFIELD_CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'email profile offline_access user:org:read',
    state: state
  }).toString();

  const loginObj = {
    id: loginId,
    status: 'waiting',
    authorizeUrl: authorizeUrl,
    verifier: verifier,
    state: state,
    redirectUri: redirectUri,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };

  savePkceSession(loginObj);
  return loginObj;
}

async function fetchRealHiggsfieldBalance(cfg) {
  let token = cfg?.token;
  if (!token && !cfg?.refreshToken) return null;

  // Consulta o saldo da conta correspondente ao token desta sessão.
  async function queryGw(activeToken) {
    let wsId = cfg.workspaceId;
    try {
      const wsRes = await axios.get('https://fnf-api-gw.higgsfield.ai/fnf/developer/v2alpha/account/workspaces', {
        headers: {
          'Authorization': `Bearer ${activeToken}`,
          'User-Agent': 'higgsfield-cli/1.1.26'
        },
        timeout: 8000
      });
      const items = wsRes.data?.items || wsRes.data?.workspaces || (Array.isArray(wsRes.data) ? wsRes.data : []);
      if (items.length > 0 && (items[0].id || items[0].workspace_id)) {
        wsId = items[0].id || items[0].workspace_id;
        cfg.workspaceId = wsId;
      }
    } catch (wsErr) {
      console.warn('[Higgsfield Gateway] Workspaces warning:', wsErr.response?.data || wsErr.message);
    }

    const balHeaders = {
      'Authorization': `Bearer ${activeToken}`,
      'User-Agent': 'higgsfield-cli/1.1.26'
    };
    if (wsId) {
      balHeaders['hf-workspace-id'] = wsId;
    }

    const balRes = await axios.get('https://fnf-api-gw.higgsfield.ai/fnf/developer/v2alpha/account/balance', {
      headers: balHeaders,
      timeout: 8000
    });

    if (balRes.data) {
      const credits = balRes.data.credits !== undefined ? balRes.data.credits : balRes.data.available_credits !== undefined ? balRes.data.available_credits : balRes.data.balance;
      const plan = balRes.data.subscription_plan_type || balRes.data.plan || cfg.plan;
      return { credits: Number(credits), plan, workspaceId: wsId };
    }
    return null;
  }

  try {
    const res = await queryGw(token);
    if (res && res.credits !== undefined && !isNaN(res.credits)) {
      return res;
    }
  } catch (err) {
    if (err.response?.status === 401 && cfg.refreshToken) {
      console.log('[Higgsfield Gateway] Token expirado, renovando via refresh_token no Clerk...');
      try {
        const refreshParams = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: HIGGSFIELD_CLIENT_ID,
          refresh_token: cfg.refreshToken
        });
        const refRes = await axios.post('https://clerk.higgsfield.ai/oauth/token', refreshParams.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        });
        if (refRes.data?.access_token) {
          cfg.token = refRes.data.access_token;
          if (refRes.data.refresh_token) cfg.refreshToken = refRes.data.refresh_token;
          cfg.expiresAt = Math.floor(Date.now() / 1000) + Number(refRes.data.expires_in || 300);
          const retryRes = await queryGw(cfg.token);
          if (retryRes) return retryRes;
        }
      } catch (refErr) {
        console.warn('[Higgsfield Gateway] Refresh token falhou:', refErr.response?.data || refErr.message);
      }
    }
  }

  return null;
}

app.get('/api/higgsfield', (req, res) => {
  const hf = getHiggsfieldAccount(req);
  res.json({ ...hf, apiCredentialsConfigured: !!(hf.apiCredential || (hf.apiKey && hf.apiSecret)) });
});

app.get('/api/higgsfield/cli-status', async (req, res) => {
  const session = getSession(req);
  if (!session?.higgsfield?.connected) return res.status(401).json({ error: 'Conecte sua conta Higgsfield.' });
  try {
    const account = await higgsfieldCli.invoke(['account', 'status'], session);
    if (account.email?.toLowerCase() !== session.higgsfield.email?.toLowerCase()) {
      return res.status(403).json({ error: 'A conta Higgsfield não corresponde à sessão.' });
    }
    session.higgsfield.credits = Number(account.credits);
    session.higgsfield.available = Number(account.credits);
    session.higgsfield.checkedAt = new Date().toISOString();
    setSessionCookie(res, session);
    res.json({ ready: true, email: account.email, credits: account.credits });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/higgsfield/api-credentials', (req, res) => {
  res.status(410).json({ error: 'O aplicativo está configurado para entrada somente via OAuth.' });
});

app.post('/api/auth/higgsfield/start', (req, res) => {
  const session = getSession(req);
  if (session && session.higgsfield && session.higgsfield.connected) {
    return res.json({
      login: { id: 'done', status: 'done' },
      signedIn: true,
      me: session.higgsfield
    });
  }
  const login = createHiggsfieldLogin(req);
  res.json({ login });
});

app.get('/api/auth/higgsfield/open', (req, res) => {
  const session = getSession(req);
  if (session && session.higgsfield && session.higgsfield.connected) {
    return res.json({
      login: { id: 'done', status: 'done' },
      signedIn: true,
      me: session.higgsfield
    });
  }
  res.json({ login: createHiggsfieldLogin(req) });
});

app.get('/api/auth/higgsfield/:id', (req, res) => {
  const session = getSession(req);
  const isConn = !!(session && session.higgsfield && session.higgsfield.connected);
  const pkce = getPkceSession(req.params.id);
  res.json({
    login: isConn ? { id: req.params.id, status: 'done' } : (pkce || { id: req.params.id, status: 'idle' }),
    signedIn: isConn,
    me: isConn ? session.higgsfield : { mode: 'own', connected: false, status: 'idle', credits: 0, available: 0, email: '', plan: '' }
  });
});

app.post(['/api/higgsfield/connect', '/api/auth/higgsfield/connect'], (req, res) => {
  const login = createHiggsfieldLogin(req);
  const acc = getHiggsfieldAccount(req);
  res.json(acc);
});

async function exchangeCodeForHiggsfieldAccount(authCode, verifier, redirectUri, state, req, res) {
  console.log(`[Higgsfield OAuth] Trocando code por access_token real no Clerk...`);
  
  const fromState = extractPkceFromState(state);
  if (fromState) {
    if (!verifier) verifier = fromState.verifier;
    if (fromState.redirectUri) redirectUri = fromState.redirectUri;
    console.log('[Higgsfield OAuth] Metadados PKCE recuperados do state com sucesso!');
  }

  if (!verifier && state) {
    const session = getPkceSession(state);
    if (session) {
      verifier = session.verifier;
      if (!redirectUri) redirectUri = session.redirectUri;
    }
  }

  if (!verifier || !redirectUri) throw new Error('Sessão OAuth inválida ou expirada. Reinicie o login.');

  console.log(`[Higgsfield OAuth] Tentando troca: redirect_uri=${redirectUri}, verifier=${verifier ? 'PRESENTE' : 'AUSENTE'}`);

  const tokenParams = {
    grant_type: 'authorization_code',
    client_id: HIGGSFIELD_CLIENT_ID,
    code: authCode,
    redirect_uri: redirectUri
  };
  if (verifier) tokenParams.code_verifier = verifier;

  let tokenRes = null;
  try {
    tokenRes = await axios.post('https://clerk.higgsfield.ai/oauth/token', new URLSearchParams(tokenParams).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    console.log(`[Higgsfield OAuth] Sucesso na troca de token com redirect: ${redirectUri}`);
  } catch (err) {
    console.error(`[Higgsfield OAuth] Erro na troca (${redirectUri}):`, err.response?.data || err.message);
    throw err;
  }

  if (!tokenRes?.data?.access_token) {
    throw new Error('Não foi possível obter o token de acesso do Higgsfield.');
  }

  const accessToken = tokenRes.data.access_token;
  const refreshToken = tokenRes.data.refresh_token;

  let userEmail = '';
  let userId = '';

  try {
    const userRes = await axios.get('https://clerk.higgsfield.ai/oauth/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 5000
    });
    userEmail = userRes.data.email || userRes.data.email_address || userRes.data.sub || '';
    userId = userRes.data.user_id || userRes.data.sub || '';
    console.log(`[Higgsfield OAuth] Usuário real autenticado: ${userEmail} (${userId})`);
  } catch (e) {
    console.warn(`[Higgsfield OAuth] Erro ao buscar userinfo:`, e.message);
  }

  console.log('[Higgsfield OAuth] Consultando saldo real na API do Higgsfield...');
  const tempCfg = { token: accessToken, refreshToken, workspaceId: '' };
  const bal = await fetchRealHiggsfieldBalance(tempCfg);
  const credits = (bal && bal.credits !== undefined) ? bal.credits : 0;
  const plan = (bal && bal.plan) ? bal.plan : 'free';
  const workspaceId = (bal && bal.workspaceId) ? bal.workspaceId : tempCfg.workspaceId || '';

  console.log(`[Higgsfield OAuth] Saldo identificado: ${credits} créditos (${plan}) para ${userEmail}`);

  const isOwner = userEmail.toLowerCase() === 'sirilisworks3@gmail.com';
  const role = isOwner ? 'admin' : 'student';

  const userObj = {
    id: userId || 'user_' + Date.now(),
    email: userEmail,
    name: userEmail ? userEmail.split('@')[0] : 'Usuário',
    role: role
  };

  const hfObj = {
    mode: 'own',
    connected: true,
    status: 'active',
    credits: credits,
    available: credits,
    email: userEmail,
    plan: plan,
    checkedAt: new Date().toISOString(),
    token: accessToken,
    refreshToken: refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + Number(tokenRes.data.expires_in || 300),
    workspaceId: workspaceId
  };

  const newSession = createSession(userObj, hfObj);

  if (res && res.setHeader) {
    setSessionCookie(res, newSession);
  }

  // Se for o dono conectando, sincroniza no config.json do servidor
  if (isOwner) {
    const ownerCfg = {
      connected: true,
      status: 'active',
      email: userEmail,
      userId: userId,
      token: accessToken,
      refreshToken: refreshToken,
      workspaceId: workspaceId,
      credits: credits,
      plan: plan,
      checkedAt: new Date().toISOString()
    };
    writeJson(CONFIG_FILE, ownerCfg);
    syncLocalCliCredentials(ownerCfg);
  }

  return hfObj;
}

async function connectWithHiggsfieldToken(accessToken, req, res) {
  let userEmail = '';
  let userId = '';

  try {
    const userRes = await axios.get('https://clerk.higgsfield.ai/oauth/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 5000
    });
    userEmail = userRes.data.email || userRes.data.email_address || userRes.data.sub || '';
    userId = userRes.data.user_id || userRes.data.sub || '';
  } catch (e) {
    console.warn('[Token] Erro ao buscar userinfo:', e.message);
  }

  const tempCfg = { token: accessToken, workspaceId: '' };
  const bal = await fetchRealHiggsfieldBalance(tempCfg);
  const credits = (bal && bal.credits !== undefined) ? bal.credits : 0;
  const plan = (bal && bal.plan) ? bal.plan : 'free';
  const workspaceId = (bal && bal.workspaceId) ? bal.workspaceId : tempCfg.workspaceId || '';

  const isOwner = userEmail.toLowerCase() === 'sirilisworks3@gmail.com';
  const role = isOwner ? 'admin' : 'student';

  const userObj = {
    id: userId || 'user_' + Date.now(),
    email: userEmail,
    name: userEmail ? userEmail.split('@')[0] : 'Usuário',
    role: role
  };

  const hfObj = {
    mode: 'own',
    connected: true,
    status: 'active',
    credits: credits,
    available: credits,
    email: userEmail,
    plan: plan,
    checkedAt: new Date().toISOString(),
    token: accessToken,
    workspaceId: workspaceId
  };

  const newSession = createSession(userObj, hfObj);

  if (res && res.setHeader) {
    setSessionCookie(res, newSession);
  }

  if (isOwner) {
    const ownerCfg = {
      connected: true,
      status: 'active',
      email: userEmail,
      userId: userId,
      token: accessToken,
      workspaceId: workspaceId,
      credits: credits,
      plan: plan,
      checkedAt: new Date().toISOString()
    };
    writeJson(CONFIG_FILE, ownerCfg);
    syncLocalCliCredentials(ownerCfg);
  }

  return hfObj;
}

// Rota de callback web (navegador direto)
app.get(['/api/auth/callback', '/callback', '/api/callback'], async (req, res) => {
  const authCode = req.query.code;
  const state = req.query.state;
  if (!authCode) {
    return res.redirect('/app/#/config?error=missing_code');
  }
  try {
    const session = getPkceSession(state);
    const acc = await exchangeCodeForHiggsfieldAccount(authCode, session?.verifier, session?.redirectUri, state, req, res);
    res.redirect('/app/#/config?connected=true&credits=' + (acc.credits ?? ''));
  } catch (err) {
    console.error('[Web Callback Error]:', err.message);
    res.redirect('/app/#/config?error=' + encodeURIComponent(err.message));
  }
});

// Callback padrão de colar o endereço manual
app.post(['/api/higgsfield/connect/:id/callback', '/api/auth/higgsfield/:id/callback'], async (req, res) => {
  const loginId = req.params.id;
  const loginSession = getPkceSession(loginId);
  const { url, token } = req.body;
  console.log(`[Higgsfield OAuth] Callback recebido para ${loginId}:`, { url: url ? url.slice(0, 100) : null, hasToken: !!token });

  try {
    const rawInput = String(url || token || '').trim();

    // A conexão de cada aluno deve passar pelo fluxo OAuth com state e PKCE.
    if (rawInput.startsWith('oat_') || rawInput.startsWith('ey') || (token && (token.startsWith('oat_') || token.startsWith('ey')))) {
      return res.status(400).json({ error: 'Use a página de autorização do Higgsfield para conectar sua conta.' });
    }

    // 2. Extrai o código de autorização e state da URL
    let authCode = null;
    let authState = null;
    if (rawInput) {
      try {
        const parsed = new URL(rawInput.startsWith('http') ? rawInput : `http://${rawInput}`);
        if (parsed.searchParams.get('error')) {
          const desc = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
          return res.status(400).json({
            error: `Erro retornado pelo Higgsfield: ${desc}. Clique em Reiniciar login e tente novamente.`
          });
        }
        authCode = parsed.searchParams.get('code');
        authState = parsed.searchParams.get('state');
      } catch (e) {
        const me = rawInput.match(/[?&]error=([^&]+)/);
        if (me) {
          const med = rawInput.match(/[?&]error_description=([^&]+)/);
          const desc = med ? decodeURIComponent(med[1].replace(/\+/g, ' ')) : me[1];
          return res.status(400).json({
            error: `Erro retornado pelo Higgsfield: ${desc}. Clique em Reiniciar login e tente novamente.`
          });
        }
        const m = rawInput.match(/[?&]code=([a-zA-Z0-9_\-]+)/);
        if (m) authCode = m[1];
        const ms = rawInput.match(/[?&]state=([a-zA-Z0-9_\-]+)/);
        if (ms) authState = ms[1];
      }
    }

    if (!authCode) {
      return res.status(400).json({
        error: 'Código de autorização não encontrado no endereço colado. Por favor, copie o endereço completo do navegador após a autorização.'
      });
    }

    const fromState = extractPkceFromState(authState);
    if (!authState || !loginSession || loginSession.state !== authState) {
      return res.status(400).json({ error: 'O endereço de autorização não corresponde a este login. Reinicie a conexão.' });
    }
    const session = loginSession;
    let verifier = session?.verifier;
    const redirectUri = session?.redirectUri;

    const acc = await exchangeCodeForHiggsfieldAccount(authCode, verifier, redirectUri, authState, req, res);
    return res.json({ signedIn: true, login: { id: loginId, status: 'done' }, me: acc, ...acc });

  } catch (err) {
    console.error(`[Higgsfield OAuth] Erro no callback:`, err.response?.data || err.message);
    const msg = err.response?.data?.error_description || err.response?.data?.error || err.message;
    return res.status(400).json({
      error: `Não foi possível conectar com o Higgsfield: ${msg}. Por favor, clique em Reiniciar login e tente novamente.`
    });
  }
});

app.post(['/api/higgsfield/connect/:id/cancel', '/api/auth/higgsfield/:id/cancel'], (req, res) => {
  const acc = getHiggsfieldAccount(req);
  res.json(acc);
});

app.post('/api/higgsfield/refresh', async (req, res) => {
  const session = getSession(req);
  if (!session || !session.higgsfield || !session.higgsfield.connected) {
    return res.status(401).json({ error: 'Nenhuma conta Higgsfield conectada' });
  }

  const hf = session.higgsfield;
  console.log(`[Higgsfield Saldo] Consultando saldo oficial para ${hf.email}...`);
  const bal = await fetchRealHiggsfieldBalance(hf);
  if (bal && bal.credits !== undefined) {
    hf.credits = bal.credits;
    hf.available = bal.credits;
    if (bal.plan) hf.plan = bal.plan;
    if (bal.workspaceId) hf.workspaceId = bal.workspaceId;
    hf.status = 'active';
    console.log(`[Higgsfield Saldo] Saldo oficial sincronizado: ${hf.credits} créditos (${hf.plan})`);
  } else {
    return res.status(502).json({ error: 'Não foi possível consultar o saldo do Higgsfield.' });
  }

  hf.checkedAt = new Date().toISOString();
  session.higgsfield = hf;
  setSessionCookie(res, session);

  if (session.user.role === 'admin') {
    writeJson(CONFIG_FILE, { ...readJson(CONFIG_FILE, {}), credits: hf.credits, plan: hf.plan, checkedAt: hf.checkedAt });
  }

  res.json(hf);
});

app.post('/api/higgsfield/disconnect', (req, res) => {
  const session = getSession(req);
  if (session && session.higgsfield) {
    session.higgsfield.connected = false;
    session.higgsfield.status = 'idle';
    session.higgsfield.token = '';
    session.higgsfield.refreshToken = '';
    session.higgsfield.email = '';
    session.higgsfield.credits = 0;
    session.higgsfield.available = 0;
    setSessionCookie(res, session);
    return res.json(session.higgsfield);
  }
  res.json({ mode: 'own', connected: false, status: 'idle', credits: 0, available: 0, email: '', plan: '' });
});

// Deslogar sessão
app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// Admin endpoints para gestão centralizada
app.get('/api/admin/overview', (req, res) => {
  const ownerConfig = readJson(CONFIG_FILE, DEFAULT_OWNER_CONFIG);
  res.json({
    users_count: 1,
    takes_today: 0,
    credits_today: ownerConfig.credits,
    charged_credits_today: 0,
    queue: {
      slots_free: 4,
      slots_total: 4,
      waiting_parts: 0,
      eta_minutes: 0,
      active_takes: 0,
      active_parts: 0
    },
    accounts: [
      {
        id: 'acc_main',
        label: ownerConfig.email || 'Conta Higgsfield Principal',
        status: ownerConfig.connected ? 'active' : 'disabled',
        has_credentials: !!(ownerConfig.token || ownerConfig.refreshToken),
        credits_balance: ownerConfig.credits,
        credits_checked_at: ownerConfig.checkedAt,
        active_parts: 0,
        max_slots: 4,
        min_credits: 60,
        last_error: null
      }
    ]
  });
});

app.post('/api/admin/accounts', (req, res) => {
  res.json({ ok: true });
});

app.patch('/api/admin/accounts/:id', (req, res) => {
  res.json({ ok: true, account: req.body });
});

app.post('/api/admin/accounts/:id/refresh', (req, res) => {
  const ownerConfig = readJson(CONFIG_FILE, DEFAULT_OWNER_CONFIG);
  res.json({ ok: true, account: { credits_balance: ownerConfig.credits } });
});

app.post('/api/admin/accounts/:id/credentials', (req, res) => {
  res.json({ ok: true });
});

// Admin Users / Alunos
app.get('/api/admin/users', (req, res) => {
  res.json({ users: [], pending_licenses: [] });
});

app.post('/api/admin/licenses', (req, res) => {
  res.json({ ok: true, email: req.body.email });
});

app.post('/api/admin/users/:id/adjust', (req, res) => {
  res.json({ ok: true });
});

app.patch('/api/admin/users/:id', (req, res) => {
  res.json({ ok: true });
});

// Admin Paywall
app.get('/api/admin/paywall', (req, res) => {
  res.json({
    config: { enabled: false, price_brl: 49.90 },
    orders: [],
    stats: { today: 0, month: 0, total: 0 }
  });
});

app.put('/api/admin/settings/paywall', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/paywall/access', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/paywall/transfer', (req, res) => {
  res.json({ ok: true });
});

// Admin Settings (Preços e Limites)
app.get('/api/admin/settings', (req, res) => {
  res.json({
    pricing: {
      credits_per_second: 20,
      min_seconds: 4,
      character_credits: 60,
      character_image_credits: 15,
      credit_price_brl_cost: '0.01'
    },
    limits: {
      max_upload_mb: 350,
      maxClipSeconds: 60,
      maxDuration: 29.7,
      minDuration: 4
    },
    features: {
      email_login: false
    },
    credit_packages: []
  });
});

app.put('/api/admin/settings/:key', (req, res) => {
  res.json({ ok: true });
});

// Admin Telegram
app.get('/api/admin/telegram', (req, res) => {
  res.json({
    connected: false,
    bot_token: null,
    bot_username: null,
    ai_api_key: null,
    model: 'claude-3-5-sonnet',
    owner: null,
    bind: null
  });
});

app.put('/api/admin/telegram', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/telegram/code', (req, res) => {
  res.json({ ok: true, code: '123456' });
});

app.post('/api/admin/telegram/unbind', (req, res) => {
  res.json({ ok: true });
});

// Admin Google Drive
app.get('/api/admin/drive', (req, res) => {
  res.json({
    connected: false,
    config: {
      enabled: false,
      emails: [],
      folder: 'Character'
    },
    counts: {
      pending: 0,
      uploading: 0,
      done: 0,
      failed: 0,
      skipped: 0,
      retrying: 0,
      gave_up: 0
    },
    recent: [],
    connect_command: 'rclone config',
    max_attempts: 3
  });
});

app.put('/api/admin/drive', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/admin/drive/retry', (req, res) => {
  res.json({ ok: true, retried: 0 });
});

app.post('/api/admin/drive/backfill', (req, res) => {
  res.json({ ok: true });
});

// Catch-all para qualquer rota administrativa adicional
app.use('/api/admin', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/characters/:id/views', (req, res) => {
  const charId = req.params.id;
  const characters = readJson(CHARACTERS_FILE, []);
  const char = characters.find(c => c.id === charId);
  if (!char || !owns(req, char)) return res.status(404).json({ error: 'Personagem não encontrado' });

  const baseImg = char.images[0] || (char.cover ? char.images.find(i => i.id === char.cover) : null);
  if (!baseImg) return res.status(400).json({ error: 'O personagem precisa de pelo menos uma imagem.' });
  return res.status(501).json({ error: 'Geração de vistas ainda não configurada no Higgsfield.' });
});

// Inicialização com fallback de portas
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Site Original Clonado rodando em:`);
    console.log(`   http://localhost:${port}`);
    console.log(`   (Landing Page: http://localhost:${port})`);
    console.log(`   (Aplicativo Estúdio: http://localhost:${port}/app)`);
    console.log(`   (Acesso Dono: /api/auth/owner com X-Owner-Access-Key configurado)`);
    console.log(`=======================================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Porta ${port} ocupada, tentando porta ${Number(port) + 1}...`);
      startServer(Number(port) + 1);
    } else {
      console.error('Erro no servidor:', err);
    }
  });
}

if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = app;
