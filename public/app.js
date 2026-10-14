// Estado global da aplicação
const state = {
  characters: [],
  selectedCharacterId: null,
  currentVideoUrl: null,
  videoDuration: null,
  hasCredentials: false,
  isGenerating: false
};

// Elementos DOM
const apiStatusPill = document.getElementById('apiStatusPill');
const openConfigBtn = document.getElementById('openConfigBtn');
const configModal = document.getElementById('configModal');
const closeConfigBtn = document.getElementById('closeConfigBtn');
const cancelConfigBtn = document.getElementById('cancelConfigBtn');
const configForm = document.getElementById('configForm');

const charList = document.getElementById('charList');
const openNewCharBtn = document.getElementById('openNewCharBtn');
const charModal = document.getElementById('charModal');
const closeCharModalBtn = document.getElementById('closeCharModalBtn');
const cancelCharBtn = document.getElementById('cancelCharBtn');
const newCharForm = document.getElementById('newCharForm');
const charPhotosDropzone = document.getElementById('charPhotosDropzone');
const charPhotosInput = document.getElementById('charPhotosInput');
const charPhotoPreviewList = document.getElementById('charPhotoPreviewList');

const socialUrlInput = document.getElementById('socialUrlInput');
const downloadSocialBtn = document.getElementById('downloadSocialBtn');
const videoDropzone = document.getElementById('videoDropzone');
const videoFileInput = document.getElementById('videoFileInput');
const videoPreviewBox = document.getElementById('videoPreviewBox');
const baseVideoPlayer = document.getElementById('baseVideoPlayer');
const videoDurationLabel = document.getElementById('videoDurationLabel');

const resolutionSelect = document.getElementById('resolutionSelect');
const promptInput = document.getElementById('promptInput');
const generateBtn = document.getElementById('generateBtn');

const progressBox = document.getElementById('progressBox');
const progressStatusLabel = document.getElementById('progressStatusLabel');
const progressPercentLabel = document.getElementById('progressPercentLabel');
const progressBarFill = document.getElementById('progressBarFill');

const historyList = document.getElementById('historyList');

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
  loadConfig();
  loadCharacters();
  loadHistory();
  setupEvents();
});

// 1. CONFIGURAÇÕES
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();
    state.hasCredentials = data.hasCredentials;

    if (data.hasCredentials) {
      apiStatusPill.textContent = 'Higgsfield Conectado';
      apiStatusPill.style.background = 'rgba(36, 224, 122, 0.12)';
      apiStatusPill.style.color = '#24e07a';
      apiStatusPill.style.borderColor = 'rgba(36, 224, 122, 0.3)';
    } else {
      apiStatusPill.textContent = 'Chave Não Configurada';
      apiStatusPill.style.background = 'rgba(255, 77, 77, 0.1)';
      apiStatusPill.style.color = '#ff5555';
      apiStatusPill.style.borderColor = 'rgba(255, 77, 77, 0.3)';
    }

    if (data.defaultResolution) {
      resolutionSelect.value = data.defaultResolution;
    }
  } catch (e) {
    console.error('Falha ao obter config:', e);
  }
}

configForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = document.getElementById('cfgApiKey').value;
  const apiSecret = document.getElementById('cfgApiSecret').value;
  const defaultResolution = document.getElementById('cfgDefaultRes').value;

  try {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey, apiSecret, defaultResolution })
    });
    const data = await res.json();
    if (data.success) {
      alert('Chaves salvas com sucesso!');
      configModal.classList.remove('active');
      loadConfig();
      checkCanGenerate();
    }
  } catch (err) {
    alert('Erro ao salvar chaves: ' + err.message);
  }
});

// 2. PERSONAGENS
async function loadCharacters() {
  try {
    const res = await fetch('/api/characters');
    state.characters = await res.json();
    renderCharacters();
  } catch (e) {
    console.error('Falha ao carregar personagens:', e);
  }
}

function renderCharacters() {
  charList.innerHTML = '';
  if (!state.characters.length) {
    charList.innerHTML = '<div style="grid-column: 1/-1; text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 20px 0;">Nenhum personagem cadastrado. Clique no botão abaixo para adicionar.</div>';
    return;
  }

  state.characters.forEach(char => {
    const card = document.createElement('div');
    card.className = `char-card ${state.selectedCharacterId === char.id ? 'selected' : ''}`;
    card.onclick = () => selectCharacter(char.id);

    const img = document.createElement('img');
    img.src = char.cover || (char.images && char.images[0]) || '';
    img.alt = char.name;

    const name = document.createElement('div');
    name.className = 'char-name';
    name.textContent = char.name;

    card.appendChild(img);
    card.appendChild(name);
    charList.appendChild(card);
  });
}

function selectCharacter(id) {
  state.selectedCharacterId = id;
  renderCharacters();
  document.getElementById('step1Badge').classList.add('done');
  checkCanGenerate();
}

let selectedCharFiles = [];
charPhotosDropzone.onclick = () => charPhotosInput.click();
charPhotosInput.onchange = (e) => {
  const files = Array.from(e.target.files);
  selectedCharFiles = files;
  charPhotoPreviewList.innerHTML = '';
  files.forEach(f => {
    const reader = new FileReader();
    reader.onload = (ev) => {
      const thumb = document.createElement('img');
      thumb.src = ev.target.result;
      thumb.style.width = '50px';
      thumb.style.height = '65px';
      thumb.style.objectFit = 'cover';
      thumb.style.borderRadius = '6px';
      thumb.style.border = '1px solid var(--panel-border)';
      charPhotoPreviewList.appendChild(thumb);
    };
    reader.readAsDataURL(f);
  });
};

newCharForm.onsubmit = async (e) => {
  e.preventDefault();
  const name = document.getElementById('newCharName').value;
  if (!selectedCharFiles.length) {
    return alert('Selecione ao menos 1 foto do personagem.');
  }

  const formData = new FormData();
  formData.append('name', name);
  selectedCharFiles.forEach(f => formData.append('images', f));

  const saveBtn = document.getElementById('saveCharBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Salvando...';

  try {
    const res = await fetch('/api/characters', {
      method: 'POST',
      body: formData
    });
    const newChar = await res.json();
    charModal.classList.remove('active');
    selectedCharFiles = [];
    charPhotoPreviewList.innerHTML = '';
    newCharForm.reset();
    await loadCharacters();
    selectCharacter(newChar.id);
  } catch (err) {
    alert('Erro ao cadastrar: ' + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Salvar Personagem';
  }
};

// 3. VÍDEO BASE
downloadSocialBtn.onclick = async () => {
  const url = socialUrlInput.value.trim();
  if (!url) return alert('Cole o link do TikTok ou Instagram.');

  downloadSocialBtn.disabled = true;
  downloadSocialBtn.textContent = 'Baixando...';

  try {
    const res = await fetch('/api/download-social', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    setBaseVideo(data.videoUrl, data.duration);
  } catch (err) {
    alert('Erro no download: ' + err.message);
  } finally {
    downloadSocialBtn.disabled = false;
    downloadSocialBtn.textContent = 'Baixar';
  }
};

videoDropzone.onclick = () => videoFileInput.click();
videoFileInput.onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('video', file);

  videoDropzone.style.opacity = '0.5';

  try {
    const res = await fetch('/api/upload-video', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    setBaseVideo(data.videoUrl, data.duration);
  } catch (err) {
    alert('Erro ao enviar vídeo: ' + err.message);
  } finally {
    videoDropzone.style.opacity = '1';
  }
};

function setBaseVideo(url, duration) {
  state.currentVideoUrl = url;
  state.videoDuration = duration;
  baseVideoPlayer.src = url;
  videoPreviewBox.style.display = 'block';
  videoDurationLabel.textContent = `Duração: ${duration} s`;
  document.getElementById('step2Badge').classList.add('done');
  checkCanGenerate();
}

function checkCanGenerate() {
  const can = state.selectedCharacterId && state.currentVideoUrl && !state.isGenerating;
  generateBtn.disabled = !can;
  if (can) {
    document.getElementById('step3Badge').classList.add('done');
  } else {
    document.getElementById('step3Badge').classList.remove('done');
  }
}

// 4. GERAÇÃO DIRETA VIA HIGGSFIELD GENJUTSU
generateBtn.onclick = async () => {
  if (!state.selectedCharacterId || !state.currentVideoUrl) return;

  if (!state.hasCredentials) {
    configModal.classList.add('active');
    return alert('Por favor, informe suas chaves do Higgsfield nas configurações primeiro!');
  }

  state.isGenerating = true;
  generateBtn.disabled = true;
  generateBtn.textContent = 'Processando Troca...';
  progressBox.style.display = 'block';
  progressBarFill.style.width = '10%';
  progressPercentLabel.textContent = '10%';
  progressStatusLabel.textContent = 'Enviando arquivos para o Higgsfield...';

  // Animação de progresso simulado enquanto o Higgsfield renderiza
  let pct = 10;
  const progressTimer = setInterval(() => {
    if (pct < 90) {
      pct += Math.floor(Math.random() * 4) + 1;
      progressBarFill.style.width = `${pct}%`;
      progressPercentLabel.textContent = `${pct}%`;
      if (pct > 25 && pct <= 60) {
        progressStatusLabel.textContent = 'Higgsfield Genjutsu renderizando vídeo em 1080p...';
      } else if (pct > 60) {
        progressStatusLabel.textContent = 'Sincronizando áudio e finalizando render...';
      }
    }
  }, 4000);

  try {
    const res = await fetch('/api/generate-swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        characterId: state.selectedCharacterId,
        videoUrl: state.currentVideoUrl,
        prompt: promptInput.value.trim(),
        resolution: resolutionSelect.value
      })
    });

    const data = await res.json();
    clearInterval(progressTimer);

    if (data.error) throw new Error(data.error);

    progressBarFill.style.width = '100%';
    progressPercentLabel.textContent = '100%';
    progressStatusLabel.textContent = 'Vídeo finalizado com sucesso!';

    alert('🎉 Seu vídeo com o novo personagem ficou pronto com áudio original!');
    await loadHistory();

  } catch (err) {
    clearInterval(progressTimer);
    alert('Erro na geração: ' + err.message);
    progressBox.style.display = 'none';
  } finally {
    state.isGenerating = false;
    generateBtn.disabled = false;
    generateBtn.textContent = '⚡ Gerar com Higgsfield Genjutsu';
  }
};

// 5. HISTÓRICO
async function loadHistory() {
  try {
    const res = await fetch('/api/history');
    const history = await res.json();
    renderHistory(history);
  } catch (e) {
    console.error('Falha ao carregar galeria:', e);
  }
}

function renderHistory(history) {
  historyList.innerHTML = '';
  if (!history.length) {
    historyList.innerHTML = '<div style="grid-column: 1/-1; color: var(--text-muted); font-size: 0.85rem;">Nenhum vídeo gerado ainda. Crie seu primeiro vídeo no estúdio acima!</div>';
    return;
  }

  history.forEach(item => {
    const card = document.createElement('div');
    card.className = 'history-card';

    const vid = document.createElement('video');
    vid.src = item.videoUrl;
    vid.controls = true;
    vid.playsinline = true;
    vid.preload = 'metadata';

    const info = document.createElement('div');
    info.className = 'history-info';
    info.innerHTML = `
      <div>
        <strong style="display: block; font-size: 0.9rem;">${item.characterName}</strong>
        <span style="font-size: 0.75rem; color: var(--accent);">${item.resolution || '1080p'}</span>
      </div>
      <div style="display: flex; gap: 8px;">
        <a href="${item.videoUrl}" download="personagem_${item.id}.mp4" class="btn btn-primary" style="padding: 4px 10px; font-size: 0.8rem;">Baixar</a>
        <button class="btn btn-danger" style="padding: 4px 10px; font-size: 0.8rem;" onclick="deleteHistory('${item.id}')">Excluir</button>
      </div>
    `;

    card.appendChild(vid);
    card.appendChild(info);
    historyList.appendChild(card);
  });
}

async function deleteHistory(id) {
  if (!confirm('Deseja excluir este vídeo da sua galeria?')) return;
  try {
    await fetch(`/api/history/${id}`, { method: 'DELETE' });
    loadHistory();
  } catch (e) {
    alert('Erro ao excluir: ' + e.message);
  }
}

// Eventos de Modais
function setupEvents() {
  openConfigBtn.onclick = () => configModal.classList.add('active');
  closeConfigBtn.onclick = () => configModal.classList.remove('active');
  cancelConfigBtn.onclick = () => configModal.classList.remove('active');

  openNewCharBtn.onclick = () => charModal.classList.add('active');
  closeCharModalBtn.onclick = () => charModal.classList.remove('active');
  cancelCharBtn.onclick = () => charModal.classList.remove('active');
}
