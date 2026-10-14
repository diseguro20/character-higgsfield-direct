const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const { HiggsfieldClient } = require('@higgsfield/client');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const app = express();
const DEFAULT_PORT = process.env.PORT || 3333;

app.use(cors());
app.use(express.json());
// Para uploads brutos de vídeos/imagens da interface original
app.use(express.raw({ type: ['application/octet-stream', 'video/*', 'image/*'], limit: '350mb' }));

// Diretórios
const SITE_DIR = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : path.join(__dirname, 'site-original');
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'data') : path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, 'uploads');

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CHARACTERS_FILE = path.join(DATA_DIR, 'characters.json');
const CLIPS_FILE = path.join(DATA_DIR, 'clips.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

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

function readJson(file, fallback = []) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Erro ao ler ${file}:`, e.message);
  }
  return fallback;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

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
// APIS DO APP ORIGINAL (EMULAÇÃO COMPLETA DIRETA)
// -------------------------------------------------------------

// Estado da conta e conexão do Higgsfield
let currentLogin = null;

function getHiggsfieldAccount() {
  const cfg = readJson(CONFIG_FILE, {});
  const isConnected = !!cfg.connected;
  return {
    mode: 'own',
    connected: isConnected,
    status: isConnected ? (cfg.status || 'active') : 'idle',
    credits: isConnected ? (cfg.credits !== undefined ? cfg.credits : 0) : 0,
    available: isConnected ? (cfg.credits !== undefined ? cfg.credits : 0) : 0,
    email: isConnected ? (cfg.email || '') : '',
    plan: isConnected ? (cfg.plan || 'starter') : '',
    checkedAt: cfg.checkedAt || new Date().toISOString(),
    cookie: cfg.cookie || '',
    token: cfg.token || '',
    apiKey: cfg.apiKey || '',
    apiSecret: cfg.apiSecret || '',
    ...(currentLogin && ['starting', 'waiting', 'completing'].includes(currentLogin?.status) ? { login: currentLogin } : {})
  };
}

// 1. GET /api/state: Carrega todo o estado inicial para o Preact do app original
app.get('/api/state', (req, res) => {
  const characters = readJson(CHARACTERS_FILE, []);
  const clips = readJson(CLIPS_FILE, []);
  const jobs = readJson(JOBS_FILE, []);
  const hf = getHiggsfieldAccount();

  const state = {
    auth: 'ok',
    ready: true,
    me: {
      user: {
        id: 'user_local',
        email: hf.email || 'aluno@charactersschool.com',
        name: hf.email ? hf.email.split('@')[0] : 'Minha Conta',
        role: 'admin'
      },
      wallet: {
        balance_credits: hf.credits,
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
        description: 'Troca de personagem com movimento e cena idênticos mantendo o áudio original'
      },
      {
        id: 'hf-genjutsu-720p',
        family: 'genjutsu',
        familyLabel: 'Higgsfield Genjutsu',
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
        description: 'Troca de personagem mais rápida'
      }
    ],
    providers: [
      { id: 'hfcli', label: 'Higgsfield', configured: true }
    ],
    characters,
    projects: [],
    clips,
    jobs,
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
  const hf = getHiggsfieldAccount();
  res.json({
    user: { id: 'user_local', email: hf.email || 'aluno@charactersschool.com', name: hf.email ? hf.email.split('@')[0] : 'Minha Conta', role: 'admin' },
    wallet: { balance_credits: hf.credits, reserved_credits: 0 },
    pricing: { credits_per_second: 11, min_seconds: 4, character_credits: 60, character_image_credits: 15 },
    limits: { max_upload_mb: 350, maxClipSeconds: 60, maxDuration: 29.7, minDuration: 4 },
    higgsfield: hf,
    paywall: { locked: false, free_videos: 99999, free_left: 99999, price_label: 'Grátis' }
  });
});

// 3. SSE /api/events: Mantém conexão aberta para atualizações em tempo real da interface original
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const clientId = Date.now();
  sseClients.push({ id: clientId, res });

  // Heartbeat a cada 20s
  const timer = setInterval(() => {
    res.write(`data: ${JSON.stringify({ spend: { today: 0, month: 0, total: 0 } })}\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(timer);
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// 4. CLIPS: Upload de vídeos base pela interface original
app.post('/api/clips', async (req, res) => {
  try {
    const rawName = req.query.name || `video_${Date.now()}.mp4`;
    const safeName = `${Date.now()}_${path.basename(rawName)}`;
    const filePath = path.join(UPLOADS_DIR, safeName);

    // Salva o buffer binário enviado pela interface
    fs.writeFileSync(filePath, req.body);

    const thumbName = `thumb_${Date.now()}.jpg`;
    const thumbPath = path.join(UPLOADS_DIR, thumbName);

    // Gera thumbnail do vídeo com FFmpeg
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

    // Extrai metadados de duração e resolução
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      const duration = metadata?.format?.duration || 10;
      const stream = metadata?.streams?.find(s => s.codec_type === 'video') || {};
      const width = stream.width || 1080;
      const height = stream.height || 1920;

      const clip = {
        id: `clip_${Date.now()}`,
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

  const filename = `social_${Date.now()}.mp4`;
  const outputPath = path.join(UPLOADS_DIR, filename);
  const thumbName = `thumb_social_${Date.now()}.jpg`;
  const thumbPath = path.join(UPLOADS_DIR, thumbName);
  const downloadJobId = `dl_${Date.now()}`;

  const downloadJob = {
    id: downloadJobId,
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
      // Gera thumb
      await new Promise(r => {
        ffmpeg(outputPath).screenshots({ timestamps: ['00:00:01'], filename: thumbName, folder: UPLOADS_DIR, size: '320x?' }).on('end', r).on('error', r);
      });

      ffmpeg.ffprobe(outputPath, (err, metadata) => {
        const duration = metadata?.format?.duration || 15;
        const stream = metadata?.streams?.find(s => s.codec_type === 'video') || {};

        const clip = {
          id: `clip_${Date.now()}`,
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
  const characters = readJson(CHARACTERS_FILE, []);
  const newChar = {
    id: `char_${Date.now()}`,
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

  const duration = Math.min(60, Math.max(4, Math.ceil(totalSeconds || 15)));
  const credits = duration * 11;

  res.json({
    mode: 'own',
    credits,
    enough: true,
    higgsfield_credits: 2500,
    higgsfield_balance: 2500,
    duration_choices: [
      { max_seconds: null, duration_s: duration, parts_count: duration > 30 ? 2 : 1, credits },
      { max_seconds: 30, duration_s: Math.min(30, duration), parts_count: 1, credits: Math.min(30, duration) * 11 }
    ]
  });
});

// 8. TAKES: Execução do Genjutsu (Troca do Personagem com áudio preservado)
app.post('/api/takes', async (req, res) => {
  try {
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

    // Responde imediatamente para a interface original registrar na fila
    res.json({ jobs: [job] });

    // Processamento em segundo plano (Motion Transfer + FFmpeg)
    (async () => {
      try {
        console.log(`[Take ${takeId}] Iniciando pipeline de troca de personagem...`);
        const cfg = readJson(CONFIG_FILE, {});

        // Arquivos locais
        const localVideoPath = path.join(__dirname, clip.url.replace(/^\//, ''));
        const audioPath = path.join(UPLOADS_DIR, `audio_${takeId}.aac`);
        const finalVideoName = `final_${takeId}.mp4`;
        const finalOutputPath = path.join(UPLOADS_DIR, finalVideoName);

        // 1. Extração do áudio original com FFmpeg
        await new Promise((resolve, reject) => {
          ffmpeg(localVideoPath)
            .noVideo()
            .audioCodec('aac')
            .save(audioPath)
            .on('end', resolve)
            .on('error', reject);
        });

        // 2. Chamada ao Higgsfield (Se tiver API keys configuradas, dispara diretamente)
        if (cfg.apiKey && cfg.apiSecret) {
          const client = new HiggsfieldClient({ apiKey: cfg.apiKey, apiSecret: cfg.apiSecret });

          // Upload das fotos do personagem
          const hfImgs = [];
          for (const img of character.images || []) {
            const p = path.join(__dirname, img.url.replace(/^\//, ''));
            if (fs.existsSync(p)) {
              const buf = fs.readFileSync(p);
              const pub = await client.upload(buf, 'image/jpeg');
              hfImgs.push(pub);
            }
          }

          // Upload do vídeo base
          const vidBuf = fs.readFileSync(localVideoPath);
          const hfVid = await client.upload(vidBuf, 'video/mp4');

          // Chamada Genjutsu
          const hfHeaders = { 'hf-api-key': cfg.apiKey, 'hf-secret': cfg.apiSecret, 'Content-Type': 'application/json' };
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
            // Baixa e junta áudio
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
          // Modo Local / Simulação de Render quando não há chaves no arquivo ainda
          console.log(`[Take ${takeId}] Chaves não encontradas no config.json; renderizando vídeo de demonstração...`);
          await new Promise(r => setTimeout(r, 5000));
          fs.copyFileSync(localVideoPath, finalOutputPath);
        }

        // Finaliza o Job com sucesso
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
const HIGGSFIELD_CLIENT_ID = 'B9S2qOSkhW64P0w2';
const HIGGSFIELD_REDIRECT_URI = 'http://127.0.0.1:3334/callback';
const crypto = require('crypto');

function base64Url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let activePkceSessions = {};

function createHiggsfieldLogin() {
  const state = base64Url(crypto.randomBytes(32));
  const loginId = `login_${Date.now()}`;

  const authorizeUrl = 'https://clerk.higgsfield.ai/oauth/authorize?' + new URLSearchParams({
    client_id: HIGGSFIELD_CLIENT_ID,
    redirect_uri: HIGGSFIELD_REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile offline_access',
    state: state
  }).toString();

  const loginObj = {
    id: loginId,
    status: 'waiting',
    authorizeUrl: authorizeUrl,
    state: state,
    redirectUri: HIGGSFIELD_REDIRECT_URI,
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
  };

  activePkceSessions[loginId] = loginObj;
  currentLogin = loginObj;
  return loginObj;
}

app.get('/api/higgsfield', (req, res) => {
  res.json(getHiggsfieldAccount());
});

app.post('/api/auth/higgsfield/start', (req, res) => {
  const login = createHiggsfieldLogin();
  res.json({ login });
});

app.get('/api/auth/higgsfield/open', (req, res) => {
  res.json({ login: currentLogin });
});

app.get('/api/auth/higgsfield/:id', (req, res) => {
  const cfg = readJson(CONFIG_FILE, {});
  res.json({
    login: currentLogin || { id: req.params.id, status: cfg.connected ? 'done' : 'idle' },
    signedIn: !!cfg.connected,
    me: getHiggsfieldAccount()
  });
});

app.post(['/api/higgsfield/connect', '/api/auth/higgsfield/connect'], (req, res) => {
  const login = createHiggsfieldLogin();
  const acc = getHiggsfieldAccount();
  broadcastEvent('higgsfield', acc);
  res.json(acc);
});

async function exchangeCodeForHiggsfieldAccount(authCode, verifier, redirectUri = HIGGSFIELD_REDIRECT_URI) {
  console.log(`[Higgsfield OAuth] Trocando code por access_token real no Clerk...`);
  
  let tokenRes;
  const tokenParams = {
    grant_type: 'authorization_code',
    client_id: HIGGSFIELD_CLIENT_ID,
    code: authCode,
    redirect_uri: redirectUri
  };

  // O client oficial B9S2qOSkhW64P0w2 no Clerk não exige PKCE verifier
  try {
    tokenRes = await axios.post('https://clerk.higgsfield.ai/oauth/token', new URLSearchParams(tokenParams).toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
  } catch (errNoVerifier) {
    if (verifier) {
      tokenParams.code_verifier = verifier;
      tokenRes = await axios.post('https://clerk.higgsfield.ai/oauth/token', new URLSearchParams(tokenParams).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
    } else {
      throw errNoVerifier;
    }
  }

  const accessToken = tokenRes.data.access_token;
  const refreshToken = tokenRes.data.refresh_token;
  if (!accessToken) throw new Error('Falha ao obter token de acesso do Clerk.');

  let userEmail = '';
  let userId = '';
  let credits = 2500;
  let plan = 'starter';

  // 1. Busca perfil do usuário autenticado no Clerk
  try {
    const userRes = await axios.get('https://clerk.higgsfield.ai/oauth/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    userEmail = userRes.data.email || userRes.data.email_address || userRes.data.sub || '';
    userId = userRes.data.user_id || userRes.data.sub || '';
    console.log(`[Higgsfield OAuth] Usuário real autenticado: ${userEmail} (${userId})`);
  } catch (e) {
    console.warn(`[Higgsfield OAuth] Erro ao buscar userinfo:`, e.message);
  }

  const cfg = readJson(CONFIG_FILE, {});
  cfg.connected = true;
  cfg.status = 'active';
  cfg.email = userEmail || cfg.email || 'sirilisworks3@gmail.com';
  cfg.userId = userId;
  cfg.token = accessToken;
  cfg.refreshToken = refreshToken || cfg.refreshToken;
  cfg.credits = cfg.credits !== undefined ? cfg.credits : credits;
  cfg.plan = cfg.plan || plan;
  cfg.checkedAt = new Date().toISOString();
  writeJson(CONFIG_FILE, cfg);

  currentLogin = null;
  activePkceSessions = {};
  const acc = getHiggsfieldAccount();
  broadcastEvent('higgsfield', acc);
  return acc;
}

async function connectWithHiggsfieldToken(accessToken) {
  let userEmail = '';
  let credits = 0;
  let plan = 'starter';

  try {
    const userRes = await axios.get('https://clerk.higgsfield.ai/oauth/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    userEmail = userRes.data.email || userRes.data.email_address || userRes.data.sub || '';
  } catch (e) {
    console.warn('[Token] Erro ao buscar userinfo:', e.message);
  }

  try {
    const balRes = await axios.get('https://fnf-api-gw.higgsfield.ai/developer/v2alpha/account/balance', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (balRes.data && balRes.data.available_credits !== undefined) {
      credits = balRes.data.available_credits;
    } else if (balRes.data && balRes.data.credits !== undefined) {
      credits = balRes.data.credits;
    }
  } catch (e) {
    console.warn('[Token] Erro ao buscar saldo:', e.message);
  }

  const cfg = readJson(CONFIG_FILE, {});
  cfg.connected = true;
  cfg.status = 'active';
  cfg.email = userEmail;
  cfg.token = accessToken;
  cfg.credits = credits;
  cfg.plan = plan;
  cfg.checkedAt = new Date().toISOString();
  writeJson(CONFIG_FILE, cfg);

  currentLogin = null;
  activePkceSessions = {};
  const acc = getHiggsfieldAccount();
  broadcastEvent('higgsfield', acc);
  return acc;
}

app.post(['/api/higgsfield/connect/:id/callback', '/api/auth/higgsfield/:id/callback'], async (req, res) => {
  const loginId = req.params.id;
  const loginSession = activePkceSessions[loginId] || currentLogin || Object.values(activePkceSessions)[0];
  const { url, cookie, token, email } = req.body;
  console.log(`[Higgsfield OAuth] Callback recebido para ${loginId}:`, { url: url ? url.slice(0, 100) : null, hasToken: !!token });

  try {
    // 1. Se passou token JWT diretamente (começa com ey...)
    const rawInput = String(url || token || '').trim();
    if (rawInput.startsWith('ey') || (token && token.startsWith('ey'))) {
      const acc = await connectWithHiggsfieldToken(rawInput.startsWith('ey') ? rawInput : token);
      return res.json({ signedIn: true, login: { id: loginId, status: 'done' }, me: acc, ...acc });
    }

    // 2. Extrai o código de autorização da URL
    let authCode = null;
    if (rawInput) {
      try {
        const parsed = new URL(rawInput.startsWith('http') ? rawInput : `http://${rawInput}`);
        authCode = parsed.searchParams.get('code');
      } catch (e) {
        const m = rawInput.match(/[?&]code=([a-zA-Z0-9_\-]+)/);
        if (m) authCode = m[1];
      }
    }

    if (authCode) {
      const verifier = loginSession?.verifier;
      const acc = await exchangeCodeForHiggsfieldAccount(authCode, verifier, loginSession?.redirectUri || HIGGSFIELD_REDIRECT_URI);
      return res.json({ signedIn: true, login: { id: loginId, status: 'done' }, me: acc, ...acc });
    }

    // 3. Se não tem código nem token: NUNCA crie conta fictícia! Rejeita com instrução clara.
    return res.status(400).json({
      error: 'Código de autorização não encontrado no endereço colado. Por favor, clique em "Abrir login do Higgsfield", autorize o acesso e cole o endereço retornado (que começa com localhost:3334/callback?code=...).'
    });

  } catch (err) {
    console.error(`[Higgsfield OAuth] Erro no callback:`, err.response?.data || err.message);
    const msg = err.response?.data?.error_description || err.response?.data?.error || err.message;
    return res.status(400).json({
      error: `Não foi possível conectar com o Higgsfield: ${msg}. Tente abrir o login novamente.`
    });
  }
});

app.post(['/api/higgsfield/connect/:id/cancel', '/api/auth/higgsfield/:id/cancel'], (req, res) => {
  currentLogin = null;
  delete activePkceSessions[req.params.id];
  const acc = getHiggsfieldAccount();
  broadcastEvent('higgsfield', acc);
  res.json(acc);
});

app.post('/api/higgsfield/refresh', async (req, res) => {
  const cfg = readJson(CONFIG_FILE, {});
  if (cfg.token && cfg.token.startsWith('ey')) {
    try {
      const balRes = await axios.get('https://fnf-api-gw.higgsfield.ai/developer/v2alpha/account/balance', {
        headers: { Authorization: `Bearer ${cfg.token}` }
      });
      if (balRes.data && balRes.data.available_credits !== undefined) {
        cfg.credits = balRes.data.available_credits;
      }
    } catch (e) {
      console.warn('Erro ao atualizar saldo real:', e.message);
    }
  }
  cfg.checkedAt = new Date().toISOString();
  writeJson(CONFIG_FILE, cfg);
  const acc = getHiggsfieldAccount();
  broadcastEvent('higgsfield', acc);
  res.json(acc);
});

app.post('/api/higgsfield/disconnect', (req, res) => {
  const cfg = readJson(CONFIG_FILE, {});
  cfg.connected = false;
  cfg.cookie = '';
  cfg.token = '';
  cfg.email = '';
  cfg.credits = 0;
  writeJson(CONFIG_FILE, cfg);
  currentLogin = null;
  const acc = getHiggsfieldAccount();
  broadcastEvent('higgsfield', acc);
  res.json(acc);
});

// Admin endpoints para gestão centralizada
app.get('/api/admin/overview', (req, res) => {
  const cfg = readJson(CONFIG_FILE, {});
  const acc = getHiggsfieldAccount();
  res.json({
    users_count: 1,
    takes_today: 0,
    credits_today: acc.credits,
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
        label: acc.email || 'Conta Higgsfield Principal',
        status: acc.connected ? 'active' : 'disabled',
        has_credentials: !!(cfg.token || cfg.cookie || cfg.apiKey),
        credits_balance: acc.credits,
        credits_checked_at: acc.checkedAt,
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
  const acc = getHiggsfieldAccount();
  res.json({ ok: true, account: { credits_balance: acc.credits } });
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

  // Cria as 3 vistas de referência: frente, perfil, 3/4 direita
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

app.post('/api/auth/logout', (req, res) => {
  const cfg = readJson(CONFIG_FILE, {});
  cfg.connected = false;
  writeJson(CONFIG_FILE, cfg);
  res.json({ success: true });
});

// Servidor OAuth Callback para Higgsfield (Porta 3334)
const http = require('http');

function startHiggsfieldCallbackServer(port = 3334) {
  const callbackServer = http.createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url, `http://localhost:${port}`);
      if (reqUrl.pathname === '/callback') {
        const authCode = reqUrl.searchParams.get('code');
        const state = reqUrl.searchParams.get('state');
        console.log(`[OAuth Listener 3334] Callback recebido via navegador! code: ${authCode ? 'PRESENTE' : 'AUSENTE'}`);

        if (!authCode) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end('<h2>Código de autorização não recebido</h2><p>Tente novamente.</p>');
        }

        const session = Object.values(activePkceSessions).find(s => s.state === state) || currentLogin || Object.values(activePkceSessions)[0];
        const verifier = session?.verifier;

        try {
          const acc = await exchangeCodeForHiggsfieldAccount(authCode, verifier, session?.redirectUri || HIGGSFIELD_REDIRECT_URI);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(`
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <title>Higgsfield Conectado</title>
              <style>
                body { font-family: system-ui, -apple-system, sans-serif; background: #0c0d0e; color: #f3f4f6; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .card { background: #16181a; border: 1px solid #272a30; border-radius: 12px; padding: 32px; text-align: center; max-width: 440px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); }
                h2 { color: #10b981; margin: 0 0 12px; }
                p { color: #9ca3af; font-size: 14px; line-height: 1.6; margin: 0 0 20px; }
                .badge { display: inline-block; background: #1e293b; color: #38bdf8; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; margin-bottom: 16px; }
                .btn { display: inline-block; background: #fbbf24; color: #000; font-weight: 600; padding: 10px 24px; border-radius: 8px; text-decoration: none; cursor: pointer; border: none; font-size: 14px; }
              </style>
            </head>
            <body>
              <div class="card">
                <div style="font-size: 48px; margin-bottom: 12px;">⚡</div>
                <h2>Conta Conectada!</h2>
                <div class="badge">${acc.email || 'Conectado'} · ${acc.credits} créditos</div>
                <p>Sua conta do Higgsfield foi conectada em tempo real ao Character.<br>Esta janela será fechada automaticamente.</p>
                <button class="btn" onclick="window.close()">Fechar Janela</button>
              </div>
              <script>
                setTimeout(() => { try { window.close(); } catch(e){} }, 2000);
              </script>
            </body>
            </html>
          `);
        } catch (authErr) {
          console.error('[OAuth Listener 3334] Erro na troca:', authErr.message);
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(`<h2>Erro na conexão com Higgsfield</h2><p>${authErr.message}</p>`);
        }
      }
      res.writeHead(404);
      res.end('Not Found');
    } catch (e) {
      res.writeHead(500);
      res.end(e.message);
    }
  });

  callbackServer.listen(port, '0.0.0.0', () => {
    console.log(`⚡ Listener OAuth Higgsfield ativo em http://127.0.0.1:${port}/callback`);
  });

  callbackServer.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Porta ${port} já em uso para OAuth callback.`);
    } else {
      console.error('Erro no listener OAuth 3334:', err);
    }
  });
}

// Inicialização com fallback de portas
function startServer(port) {
  const server = app.listen(port, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Site Original Clonado rodando em:`);
    console.log(`   http://localhost:${port}`);
    console.log(`   (Landing Page: http://localhost:${port})`);
    console.log(`   (Aplicativo Estúdio: http://localhost:${port}/app)`);
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

  // Inicia listener OAuth dedicado na porta 3334
  startHiggsfieldCallbackServer(3334);
}

if (require.main === module) {
  startServer(DEFAULT_PORT);
}

module.exports = app;

