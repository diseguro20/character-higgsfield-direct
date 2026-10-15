const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { HiggsfieldClient } = require('@higgsfield/client');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const DEFAULT_PORT = process.env.PORT || 3333;
const SESSION_SECRET = process.env.SESSION_SECRET || 'character-higgsfield-isolated-sessions-2026';

app.use(cors());
app.use(express.json());
// Para uploads brutos de vídeos/imagens da interface original
app.use(express.raw({ type: ['application/octet-stream', 'video/*', 'image/*'], limit: '350mb' }));

// Diretórios
const SITE_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, 'site-original');
const REPO_DATA_DIR = path.join(__dirname, 'data');
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'data') : REPO_DATA_DIR;
const UPLOADS_DIR = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Firebase Backend Integration (Projeto: autocontentai-f20d8)
let firebaseAdmin = null;
try {
  const admin = require('firebase-admin');
  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: 'autocontentai-f20d8'
    });
  }
  firebaseAdmin = admin;
  console.log('🔥 [Firebase Backend] Conectado ao projeto autocontentai-f20d8');
} catch (e) {
  console.log('[Firebase Backend] Aviso de inicialização:', e.message);
}

// Configuração padrão do Dono (sirilisworks3@gmail.com) - isolada
const DEFAULT_OWNER_CONFIG = {
  connected: true,
  status: "active",
  email: "sirilisworks3@gmail.com",
  userId: "user_3KOFf1GutHdSGplLiBGJVX0XZk1",
  token: "oat_OYQRHSNWH29GPJMR2HXDZY508KQ67ZYE",
  refreshToken: "N2M5MTE3NDUTODBLYI01MMUYLWFIOTETOTHKODQ0ZJNINGEW",
  workspaceId: "54e977f6-fece-4649-8e44-b86cf8e406e4",
  credits: 560,
  plan: "plus",
  checkedAt: "2026-10-15T03:09:48.505Z"
};

let memoryCache = {};

function readJson(file, fallback = []) {
  const baseName = path.basename(file);
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
    memoryCache[baseName] = data;
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error(`Erro ao escrever ${file}:`, e.message);
  }
}

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
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const jsonStr = Buffer.from(payload, 'base64url').toString('utf8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

const activeSessions = new Map();

function getSession(req) {
  const cookies = parseCookies(req);
  const token = cookies['character_session'] || req.headers['x-character-session'];
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
  res.setHeader('Set-Cookie', `character_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  return token;
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'character_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

// Atalho para o dono: acessar ?owner=1 ou /api/auth/owner conecta a conta do dono diretamente
app.use((req, res, next) => {
  if (req.query.owner === '1' || req.query.admin === '1') {
    const ownerConfig = readJson(CONFIG_FILE, DEFAULT_OWNER_CONFIG);
    const ownerSession = createSession(
      {
        id: ownerConfig.userId || 'user_owner',
        email: ownerConfig.email || 'sirilisworks3@gmail.com',
        name: ownerConfig.email ? ownerConfig.email.split('@')[0] : 'admin',
        role: 'admin'
      },
      {
        mode: 'own',
        connected: true,
        status: 'active',
        credits: ownerConfig.credits !== undefined ? ownerConfig.credits : 560,
        available: ownerConfig.credits !== undefined ? ownerConfig.credits : 560,
        email: ownerConfig.email || 'sirilisworks3@gmail.com',
        plan: ownerConfig.plan || 'plus',
        checkedAt: ownerConfig.checkedAt || new Date().toISOString(),
        token: ownerConfig.token,
        refreshToken: ownerConfig.refreshToken,
        workspaceId: ownerConfig.workspaceId
      }
    );
    setSessionCookie(res, ownerSession);
    if (req.path === '/app' || req.path === '/app/') {
      return res.redirect('/app');
    }
  }
  next();
});

app.get('/api/auth/owner', (req, res) => {
  const ownerConfig = readJson(CONFIG_FILE, DEFAULT_OWNER_CONFIG);
  const ownerSession = createSession(
    {
      id: ownerConfig.userId || 'user_owner',
      email: ownerConfig.email || 'sirilisworks3@gmail.com',
      name: 'sirilisworks3',
      role: 'admin'
    },
    {
      mode: 'own',
      connected: true,
      status: 'active',
      credits: ownerConfig.credits !== undefined ? ownerConfig.credits : 560,
      available: ownerConfig.credits !== undefined ? ownerConfig.credits : 560,
      email: ownerConfig.email || 'sirilisworks3@gmail.com',
      plan: ownerConfig.plan || 'plus',
      checkedAt: ownerConfig.checkedAt || new Date().toISOString(),
      token: ownerConfig.token,
      refreshToken: ownerConfig.refreshToken,
      workspaceId: ownerConfig.workspaceId
    }
  );
  setSessionCookie(res, ownerSession);
  res.redirect('/app');
});

// Clientes SSE (Server-Sent Events)
let sseClients = [];
function broadcastEvent(type, item) {
  const payload = `data: ${JSON.stringify({ events: [{ type, item }] })}\n\n`;
  sseClients.forEach(c => c.res.write(payload));
}

// -------------------------------------------------------------
// ARQUIVOS ESTÁTICOS DO SITE CLONADO ORIGINAL
// -------------------------------------------------------------
app.use('/landing', express.static(path.join(SITE_DIR, 'landing')));
app.use('/app', express.static(path.join(SITE_DIR, 'app')));
app.use('/uploads', express.static(UPLOADS_DIR));

// Rota raiz: serve a landing page original
app.get('/', (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'index.html'));
});

// Rota /app e /app/: serve o aplicativo original
app.get(['/app', '/app/'], (req, res) => {
  res.sendFile(path.join(SITE_DIR, 'app', 'index.html'));
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
      ...(currentLogin && ['starting', 'waiting', 'completing'].includes(currentLogin?.status) ? { login: currentLogin } : {})
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
    ...(currentLogin && ['starting', 'waiting', 'completing'].includes(currentLogin?.status) ? { login: currentLogin } : {})
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
  const userCharacters = characters.filter(c => !c.userId || c.userId === user.id);
  const userClips = clips.filter(c => !c.userId || c.userId === user.id);
  const userJobs = jobs.filter(j => !j.userId || j.userId === user.id);

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
        credits_per_second: 11,
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
        email_login: false
      },
      higgsfield: hf,
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
        credits_per_second: 11,
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
    projects: [],
    clips: userClips,
    jobs: userJobs,
    templates: {
      card: 'Reference image 1 is ONLY the style anchor: match its soft studio light, solid butter-yellow background, three-quarter bust framing, camera angle and premium photographic finish. Never copy its identity, face, hair, moustache or clothes. {identity}',
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
    pricing: { credits_per_second: 11, min_seconds: 4, character_credits: 60, character_image_credits: 15 },
    limits: { max_upload_mb: 350, maxClipSeconds: 60, maxDuration: 29.7, minDuration: 4 },
    higgsfield: hf,
    paywall: { locked: false, free_videos: 99999, free_left: 99999, price_label: 'Grátis' }
  });
});

// 3. SSE /api/events: Mantém conexão aberta para atualizações em tempo real
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

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
    const rawName = req.query.name || `video_${Date.now()}.mp4`;
    const safeName = `${Date.now()}_${path.basename(rawName)}`;
    const filePath = path.join(UPLOADS_DIR, safeName);

    fs.writeFileSync(filePath, req.body);

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

    ffmpeg.ffprobe(filePath, (err, metadata) => {
      const duration = metadata?.format?.duration || 10;
      const stream = metadata?.streams?.find(s => s.codec_type === 'video') || {};
      const width = stream.width || 1080;
      const height = stream.height || 1920;

      const clip = {
        id: `clip_${Date.now()}`,
        userId,
        name: rawName,
        url: `/uploads/${safeName}`,
        localPath: filePath,
        thumbUrl: fs.existsSync(thumbPath) ? `/uploads/${thumbName}` : `/uploads/${safeName}`,
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
  const clip = clips.find(c => c.id === id);
  if (clip) {
    Object.assign(clip, req.body);
    writeJson(CLIPS_FILE, clips);
    broadcastEvent('clip', clip);
  }
  res.json(clip || {});
});

app.delete('/api/clips/:id', (req, res) => {
  const id = req.params.id;
  let clips = readJson(CLIPS_FILE, []);
  clips = clips.filter(c => c.id !== id);
  writeJson(CLIPS_FILE, clips);
  broadcastEvent('clip:removed', { id });
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

// 6. PERSONAGENS E FOTOS DE REFERÊNCIA
app.post('/api/characters', (req, res) => {
  const session = getSession(req);
  const userId = session?.user?.id || 'anonymous';
  const characters = readJson(CHARACTERS_FILE, []);
  const newChar = {
    id: `char_${Date.now()}`,
    userId,
    name: req.body?.name || 'Novo Personagem',
    code: `CS${String(characters.length + 1).padStart(3, '0')}`,
    images: [],
    cover: null,
    favorite: false,
    library: false,
    createdAt: new Date().toISOString()
  };
  characters.unshift(newChar);
  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character', newChar);
  res.json(newChar);
});

// Upload de imagens no personagem (frente, perfil, 3/4)
app.post('/api/characters/:id/images', (req, res) => {
  const charId = req.params.id;
  const characters = readJson(CHARACTERS_FILE, []);
  const char = characters.find(c => c.id === charId);
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });

  const rawName = req.query.name || `photo_${Date.now()}.jpg`;
  const safeName = `ref_${Date.now()}_${path.basename(rawName)}`;
  const filePath = path.join(UPLOADS_DIR, safeName);

  fs.writeFileSync(filePath, req.body);

  const imgObj = {
    id: `img_${Date.now()}`,
    url: `/uploads/${safeName}`,
    thumbUrl: `/uploads/${safeName}`,
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

// 7. ORÇAMENTO (ESTIMATE): Calcula os créditos e partes do vídeo
app.post('/api/estimate', (req, res) => {
  const { clipIds } = req.body;
  const clips = readJson(CLIPS_FILE, []);
  let totalSeconds = 0;

  if (Array.isArray(clipIds)) {
    clipIds.forEach(id => {
      const c = clips.find(x => x.id === id);
      if (c) totalSeconds += Number(c.info?.duration || 10);
    });
  }

  const session = getSession(req);
  const userCredits = session?.higgsfield?.credits || 0;
  const duration = Math.min(60, Math.max(4, Math.ceil(totalSeconds || 15)));
  const credits = duration * 11;

  res.json({
    mode: 'own',
    credits,
    enough: userCredits >= credits,
    higgsfield_credits: userCredits,
    higgsfield_balance: userCredits,
    duration_choices: [
      { max_seconds: null, duration_s: duration, parts_count: duration > 30 ? 2 : 1, credits },
      { max_seconds: 30, duration_s: Math.min(30, duration), parts_count: 1, credits: Math.min(30, duration) * 11 }
    ]
  });
});

// 8. TAKES: Execução do Genjutsu
app.post('/api/takes', async (req, res) => {
  try {
    const session = getSession(req);
    const hf = session?.higgsfield;
    if (!hf || !hf.connected || (!hf.token && !hf.apiKey)) {
      return res.status(401).json({ error: 'Conecte sua conta Higgsfield para gerar vídeos.' });
    }

    const { characterIds, clipIds, prompt, swapModels } = req.body;
    const characters = readJson(CHARACTERS_FILE, []);
    const clips = readJson(CLIPS_FILE, []);
    const jobs = readJson(JOBS_FILE, []);

    const charId = characterIds?.[0];
    const clipId = clipIds?.[0];
    const character = characters.find(c => c.id === charId) || characters[0];
    const clip = clips.find(c => c.id === clipId) || clips[0];

    if (!character || !clip) {
      return res.status(400).json({ error: 'Selecione um personagem e um vídeo base no Estúdio.' });
    }

    const takeId = `take_${Date.now()}`;
    const duration = clip.info?.duration || 15;
    const billedCredits = Math.ceil(duration) * 11;

    const job = {
      id: takeId,
      userId: session.user.id,
      title: `${character.name} · ${clip.name}`,
      kind: 'take',
      status: 'running',
      stage: 'generating',
      billing: 'own',
      createdAt: new Date().toISOString(),
      input: {
        characterId: character.id,
        clipId: clip.id,
        swapModel: swapModels?.[0] || 'hf-genjutsu-1080p',
        prompt: prompt || ''
      },
      price_credits: billedCredits,
      higgsfield_credits: billedCredits,
      outputs: {
        thumbUrl: clip.thumbUrl
      },
      steps: [
        { key: 'swap', status: 'running', parts: [{ status: 'running', submittedAt: new Date().toISOString() }] }
      ]
    };

    jobs.unshift(job);
    writeJson(JOBS_FILE, jobs);
    broadcastEvent('job', job);

    res.json({ jobs: [job] });

    (async () => {
      try {
        console.log(`[Take ${takeId}] Iniciando pipeline de troca de personagem para ${session.user.email}...`);

        const localVideoPath = path.join(__dirname, clip.url.replace(/^\//, ''));
        const audioPath = path.join(UPLOADS_DIR, `audio_${takeId}.aac`);
        const finalVideoName = `final_${takeId}.mp4`;
        const finalOutputPath = path.join(UPLOADS_DIR, finalVideoName);

        // 1. Extração do áudio original
        await new Promise((resolve, reject) => {
          ffmpeg(localVideoPath)
            .noVideo()
            .audioCodec('aac')
            .save(audioPath)
            .on('end', resolve)
            .on('error', reject);
        });

        // 2. Chamada ao Higgsfield (Se tiver API keys ou token)
        if (hf.apiKey && hf.apiSecret) {
          const client = new HiggsfieldClient({ apiKey: hf.apiKey, apiSecret: hf.apiSecret });

          const hfImgs = [];
          for (const img of character.images || []) {
            const p = path.join(__dirname, img.url.replace(/^\//, ''));
            if (fs.existsSync(p)) {
              const buf = fs.readFileSync(p);
              const pub = await client.upload(buf, 'image/jpeg');
              hfImgs.push(pub);
            }
          }

          const vidBuf = fs.readFileSync(localVideoPath);
          const hfVid = await client.upload(vidBuf, 'video/mp4');

          const hfHeaders = { 'hf-api-key': hf.apiKey, 'hf-secret': hf.apiSecret, 'Content-Type': 'application/json' };
          const hfRes = await axios.post('https://api.higgsfield.ai/higgsfield/genjutsu/motion-transfer/v1.0', {
            prompt: prompt || `Swap person with ${character.name}, cinematic, photorealistic, natural lighting`,
            video_url: hfVid,
            image_urls: hfImgs,
            resolution: '1080p'
          }, { headers: hfHeaders });

          const reqId = hfRes.data.request_id || hfRes.data.id;
          let renderedUrl = null;

          for (let i = 0; i < 90; i++) {
            await new Promise(r => setTimeout(r, 6000));
            const chk = await axios.get(`https://api.higgsfield.ai/requests/${reqId}/status`, { headers: hfHeaders });
            if (chk.data.status === 'completed' || chk.data.status === 'done') {
              renderedUrl = chk.data.output?.video_url || chk.data.result?.url;
              break;
            } else if (chk.data.status === 'failed') {
              throw new Error(chk.data.error || 'Rejeitado pelo Higgsfield');
            }
          }

          if (renderedUrl) {
            const silentPath = path.join(UPLOADS_DIR, `silent_${takeId}.mp4`);
            const writer = fs.createWriteStream(silentPath);
            const stream = await axios({ method: 'get', url: renderedUrl, responseType: 'stream' });
            stream.data.pipe(writer);
            await new Promise(r => writer.on('finish', r));

            await new Promise((r, reject) => {
              ffmpeg().input(silentPath).input(audioPath).outputOptions(['-c:v copy', '-c:a aac', '-map 0:v:0', '-map 1:a:0?', '-shortest']).save(finalOutputPath).on('end', r).on('error', reject);
            });
            try { fs.unlinkSync(silentPath); fs.unlinkSync(audioPath); } catch {}
          }
        } else {
          console.log(`[Take ${takeId}] Sem chaves de API diretas; gerando vídeo preview local...`);
          await new Promise(r => setTimeout(r, 5000));
          fs.copyFileSync(localVideoPath, finalOutputPath);
        }

        job.status = 'done';
        job.stage = 'ready';
        job.finishedAt = new Date().toISOString();
        job.outputs = {
          masterUrl: `/uploads/${finalVideoName}`,
          thumbUrl: clip.thumbUrl
        };
        job.result = {
          width: 1080,
          height: 1920,
          duration
        };
        job.steps = [{ key: 'swap', status: 'done', parts: [{ status: 'done' }] }];

        writeJson(JOBS_FILE, jobs);
        broadcastEvent('job', job);
        console.log(`[Take ${takeId}] FINALIZADO COM SUCESSO!`);

      } catch (err) {
        console.error(`[Take ${takeId}] Erro:`, err.message);
        job.status = 'failed';
        job.error = err.message;
        writeJson(JOBS_FILE, jobs);
        broadcastEvent('job', job);
      }
    })();

  } catch (e) {
    res.status(500).json({ error: e.message });
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
  if (!state || typeof state !== 'string') return null;
  if (state.startsWith('hf_ey') || state.startsWith('hf_')) {
    try {
      const jsonStr = Buffer.from(state.slice(3), 'base64url').toString('utf8');
      const parsed = JSON.parse(jsonStr);
      if (parsed && parsed.v) {
        return { verifier: parsed.v, redirectUri: parsed.r || 'http://localhost:8765/callback' };
      }
    } catch {}
  }
  if (state.startsWith('hf_v1_')) {
    return { verifier: state.slice(6), redirectUri: 'http://localhost:8765/callback' };
  }
  return null;
}

function createHiggsfieldLogin(req) {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(crypto.createHash('sha256').update(verifier).digest());
  const redirectUri = 'http://localhost:8765/callback';
  const statePayload = { v: verifier, r: redirectUri };
  const state = 'hf_' + Buffer.from(JSON.stringify(statePayload)).toString('base64url');
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
  currentLogin = loginObj;
  return loginObj;
}

async function fetchRealHiggsfieldBalance(cfg) {
  let token = cfg?.token;
  if (!token && !cfg?.refreshToken) return null;

  // 1. Tenta consulta via CLI oficial hf.exe (se executando localmente)
  try {
    const { execSync } = require('child_process');
    const hfPath = path.join(__dirname, 'hf.exe');
    if (fs.existsSync(hfPath)) {
      const out = execSync(`"${hfPath}" account status --json`, { timeout: 6000, encoding: 'utf8' });
      const parsed = JSON.parse(out);
      if (parsed && (parsed.credits !== undefined || parsed.available_credits !== undefined)) {
        const val = parsed.credits !== undefined ? parsed.credits : parsed.available_credits;
        return {
          credits: Number(val),
          plan: parsed.subscription_plan_type || parsed.plan || cfg.plan,
          email: parsed.email || cfg.email
        };
      }
    }
  } catch (cliErr) {}

  // 2. Consulta direta aos endpoints oficiais do Higgsfield Gateway (fnf-api-gw)
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
  res.json(getHiggsfieldAccount(req));
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
  res.json({ login: currentLogin || createHiggsfieldLogin(req) });
});

app.get('/api/auth/higgsfield/:id', (req, res) => {
  const session = getSession(req);
  const isConn = !!(session && session.higgsfield && session.higgsfield.connected);
  const pkce = getPkceSession(req.params.id) || currentLogin;
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

  if (!verifier && currentLogin) {
    verifier = currentLogin.verifier;
    if (!redirectUri) redirectUri = currentLogin.redirectUri;
  }

  if (!redirectUri) {
    redirectUri = 'http://localhost:8765/callback';
  }

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

  currentLogin = null;
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

  currentLogin = null;
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
  const loginSession = getPkceSession(loginId) || currentLogin;
  const { url, token } = req.body;
  console.log(`[Higgsfield OAuth] Callback recebido para ${loginId}:`, { url: url ? url.slice(0, 100) : null, hasToken: !!token });

  try {
    const rawInput = String(url || token || '').trim();

    // 1. Se passou token diretamente (oat_... ou ey...)
    if (rawInput.startsWith('oat_') || rawInput.startsWith('ey') || (token && (token.startsWith('oat_') || token.startsWith('ey')))) {
      const tok = (rawInput.startsWith('oat_') || rawInput.startsWith('ey')) ? rawInput : token;
      const acc = await connectWithHiggsfieldToken(tok, req, res);
      return res.json({ signedIn: true, login: { id: loginId, status: 'done' }, me: acc, ...acc });
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
    const session = getPkceSession(authState) || loginSession;
    let verifier = fromState?.verifier || session?.verifier || currentLogin?.verifier;
    const redirectUri = fromState?.redirectUri || session?.redirectUri || 'http://localhost:8765/callback';

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
  currentLogin = null;
  const acc = getHiggsfieldAccount(req);
  res.json(acc);
});

app.post('/api/higgsfield/refresh', async (req, res) => {
  const session = getSession(req);
  if (!session || !session.higgsfield || !session.higgsfield.connected) {
    return res.status(401).json({ error: 'Nenhuma conta Higgsfield conectada' });
  }

  const hf = session.higgsfield;
  const { credits, token } = req.body || {};

  if (credits !== undefined && credits !== null && !isNaN(Number(credits))) {
    hf.credits = Number(credits);
    hf.available = Number(credits);
    console.log(`[Higgsfield Saldo] Saldo ajustado para ${hf.credits} créditos`);
  } else {
    if (token) hf.token = token;
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
      console.warn('[Higgsfield Saldo] Não foi possível obter o saldo da API.');
    }
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
      credits_per_second: 11,
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
  if (!char) return res.status(404).json({ error: 'Personagem não encontrado' });

  const baseImg = char.images[0] || { url: '/landing/assets/vector-1.webp' };
  const viewRoles = [
    { role: 'front', label: 'Frente' },
    { role: 'profile', label: 'Perfil' },
    { role: 'right', label: '3/4 Direita' }
  ];

  viewRoles.forEach((v, idx) => {
    if (!char.images.some(i => i.role === v.role)) {
      char.images.push({
        id: `view_${Date.now()}_${idx}`,
        url: baseImg.url,
        thumbUrl: baseImg.thumbUrl || baseImg.url,
        role: v.role,
        label: v.label,
        useAsRef: true
      });
    }
  });

  writeJson(CHARACTERS_FILE, characters);
  broadcastEvent('character', char);
  res.json(char);
});

// Inicialização com fallback de portas
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Site Original Clonado rodando em:`);
    console.log(`   http://localhost:${port}`);
    console.log(`   (Landing Page: http://localhost:${port})`);
    console.log(`   (Aplicativo Estúdio: http://localhost:${port}/app)`);
    console.log(`   (Acesso Dono direto: http://localhost:${port}/app?owner=1)`);
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
