// Galeria: vídeos prontos, filtros, download, upscale depois e comparação lado a lado.
import { useState, useRef, useEffect } from 'preact/hooks'
import { html, usd, cr, dayMonth, dur, Badge, Modal, Toggle, resLabel } from '../ui.js'
import { S, useStore, characterById, clipById, modelById, showLightbox, castNames, newestFirst } from '../state.js'
import { api } from '../api.js'
import { run } from '../actions.js'
import { jobCredits } from '../cloud.js'
import { PaywallModal, PaywallBand, lockedJob, openPaywall } from './paywall.js'

const byRank = (a, b) => (b.configured - a.configured) || (a.rank - b.rank)

function VideoCard({ j, picked, onPick }) {
  const [hover, setHover] = useState(false)
  const [upOpen, setUpOpen] = useState(false)
  const ch = characterById(j.input?.characterId)
  const sm = modelById(j.input?.swapModel)
  const ups = S.models.filter(m => m.step === 'video_upscale').sort(byRank)
  const short = Math.min(j.result?.width || 0, j.result?.height || 0)
  return html`
    <div class=${`vid ${picked ? 'is-picked' : ''}`}>
      <div class="vid__media" onMouseEnter=${() => setHover(true)} onMouseLeave=${() => setHover(false)} onClick=${() => showLightbox('video', j.outputs.masterUrl)}>
        ${hover ? html`<video src=${j.outputs.instagramUrl || j.outputs.masterUrl} autoplay muted loop playsinline poster=${j.outputs.thumbUrl}></video>` : html`<img src=${j.outputs.thumbUrl} alt="" loading="lazy" />`}
        <button class=${`round vid__pick ${picked ? 'is-on' : ''}`} title="Escolher para comparar" onClick=${e => { e.stopPropagation(); onPick() }}>✓</button>
        <button class=${`round vid__fav ${j.favorite ? 'is-on' : ''}`} title="Favoritar" onClick=${e => { e.stopPropagation(); run(() => api.patch(`/api/jobs/${j.id}`, { favorite: !j.favorite })) }}>★</button>
        <span class="vid__dur"><${Badge}>${dur(j.result?.duration)}</${Badge}></span>
      </div>
      <div class="vid__body">
        <div class="vid__title ellipsis" title=${j.title}>${castNames(j) || j.title}</div>
        <div class="row wrap" style="gap:5px">
          <${Badge} kind=${short >= 2000 ? '4k' : ''}>${resLabel(j.result?.width, j.result?.height)}</${Badge}>
          <span class="small dim ellipsis">${sm?.label || ''}${j.kind === 'video_upscale' ? ' + upscale' : j.input?.upscaleModel ? ` + ${modelById(j.input.upscaleModel)?.label || 'upscale'}` : ''}</span>
        </div>
        <div class="small dim ellipsis" title=${jobCredits(j)?.title}>${clipById(j.input?.clipId)?.name || ''}${jobCredits(j) ? ` · ${jobCredits(j).text}` : ''}${j.expiresAt ? ` · até ${dayMonth(j.expiresAt)}` : ''}</div>
        <div class="vid__actions">
          <a class="btn btn--xs btn--butter" href=${j.outputs.masterUrl} download>Baixar</a>
          ${j.outputs.instagramUrl ? html`<a class="btn btn--xs" href=${j.outputs.instagramUrl} download title="1080p otimizado para Instagram/TikTok">Instagram</a>` : null}
          ${ups.length ? html`<button class="btn btn--xs" title=${short >= 2000 ? 'Passa o vídeo 4K pelo Topaz para recriar a textura de pele e tirar o aspecto de IA' : 'Aumenta para 4K'} onClick=${() => setUpOpen(!upOpen)}>${short >= 2000 ? 'Refinar pele' : 'Upscale 4K'}</button>` : null}
        </div>
        ${upOpen ? html`<div class="stack" style="gap:6px">${ups.map(m => html`<button class="btn btn--xs" disabled=${!m.configured} onClick=${() => { setUpOpen(false); run(() => api.post(`/api/jobs/${j.id}/upscale`, { model: m.id }), 'Upscale na fila') }}>${m.label}${m.unitPrice ? ` · ${usd(m.unitPrice)}/10 s` : ''}</button>`)}</div>` : null}
      </div>
    </div>`
}

// Character Online: vídeo guardado com a galeria fechada pela hospedagem (sem o link do vídeo): a miniatura apagada,
// e o clique abre o aviso de pagamento
function LockedCard({ j }) {
  return html`
    <div class="vid vid--locked">
      <div class="vid__media" title="Galeria pausada: pague a taxa do servidor para assistir e baixar" onClick=${() => openPaywall()}>
        ${j.outputs?.thumbUrl ? html`<img src=${j.outputs.thumbUrl} alt="" loading="lazy" />` : null}
        <span class="vid__lock">Galeria pausada</span>
        <span class="vid__dur"><${Badge}>${dur(j.result?.duration)}</${Badge}></span>
      </div>
      <div class="vid__body">
        <div class="vid__title ellipsis" title=${j.title}>${castNames(j) || j.title}</div>
        <div class="small dim ellipsis">${clipById(j.input?.clipId)?.name || ''}${j.expiresAt ? ` · até ${dayMonth(j.expiresAt)}` : ''}</div>
        <div class="vid__actions">
          <button class="btn btn--xs btn--primary" onClick=${() => openPaywall()}>Liberar para assistir</button>
        </div>
      </div>
    </div>`
}

function Compare({ jobs, onClose }) {
  const refs = useRef([])
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [len, setLen] = useState(0)
  const [soundIdx, setSoundIdx] = useState(-1)
  const vids = () => refs.current.filter(Boolean)
  useEffect(() => {
    const id = setInterval(() => { const v = vids()[0]; if (v) { setT(v.currentTime); setLen(v.duration || 0) } }, 120)
    return () => clearInterval(id)
  }, [])
  const toggle = () => {
    const vs = vids()
    if (playing) vs.forEach(v => v.pause())
    else { const t0 = vs[0]?.currentTime || 0; vs.forEach(v => { v.currentTime = t0; v.play() }) }
    setPlaying(!playing)
  }
  const seek = x => vids().forEach(v => { v.currentTime = x })
  const cols = jobs.length <= 2 ? jobs.length : jobs.length <= 4 ? jobs.length : 3
  useEffect(() => {
    const on = e => { if (e.key === ' ') { e.preventDefault(); toggle() } }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })
  return html`
    <${Modal} title="Comparar" onClose=${onClose} size="xl"
      foot=${html`
        <button class="btn btn--primary" onClick=${toggle}>${playing ? 'Pausar' : 'Tocar todos'} <span class="kbd">espaço</span></button>
        <input class="scrub grow" type="range" min="0" max=${len || 1} step="0.04" value=${t} onInput=${e => seek(Number(e.target.value))} />
        <span class="pixel">${dur(t)} / ${dur(len)}</span>`}>
      <div class="compare__grid" style=${{ gridTemplateColumns: `repeat(${cols}, 1fr)`, height: '100%' }}>
        ${jobs.map((j, i) => html`
          <div key=${j.id} class="compare__cell">
            <div class="row small"><b class="ellipsis grow">${modelById(j.input?.swapModel)?.label || j.title}</b>
              <span class="dim" title=${jobCredits(j)?.title}>${resLabel(j.result?.width, j.result?.height)}${jobCredits(j) ? ` · ${jobCredits(j).text}` : ''}</span>
              <button class=${`btn btn--xs ${soundIdx === i ? 'btn--butter' : ''}`} onClick=${() => setSoundIdx(soundIdx === i ? -1 : i)}>${soundIdx === i ? '🔊' : '🔇'}</button></div>
            <video ref=${el => (refs.current[i] = el)} src=${j.outputs.masterUrl} muted=${soundIdx !== i} playsinline loop preload="auto" style="max-height:calc(100vh - 260px)"></video>
          </div>`)}
      </div>
    </${Modal}>`
}

export function Gallery() {
  useStore()
  const [q, setQ] = useState('')
  const [model, setModel] = useState('')
  const [favs, setFavs] = useState(false)
  const [picked, setPicked] = useState([])
  const [comparing, setComparing] = useState(false)
  // Character Online: com a galeria fechada pela hospedagem os vídeos guardados aparecem sem o link (lockedJob)
  const all = S.jobs.filter(j => (j.kind === 'take' || j.kind === 'video_upscale') && j.status === 'done' && (j.outputs?.masterUrl || lockedJob(j))).sort(newestFirst)
  const qq = q.trim().toLowerCase()
  const list = all.filter(j => {
    if (favs && !j.favorite) return false
    if (model && j.input?.swapModel !== model) return false
    if (qq && !`${j.title} ${castNames(j)}`.toLowerCase().includes(qq)) return false
    return true
  })
  const usedModels = [...new Set(all.map(j => j.input?.swapModel).filter(Boolean))]
  const pick = id => setPicked(picked.includes(id) ? picked.filter(x => x !== id) : [...picked, id].slice(-6))
  const pickedJobs = picked.map(id => all.find(j => j.id === id)).filter(j => j && !lockedJob(j))
  return html`
    <div class="page">
      <div class="page__head">
        <h1 class="display page__title">Galeria <em>${all.length || ''}</em></h1>
        <label class="search" style="max-width:280px"><input class="input" placeholder="Buscar personagem ou vídeo" value=${q} onInput=${e => setQ(e.target.value)} /></label>
        <select class="select" style="width:auto" value=${model} onChange=${e => setModel(e.target.value)}>
          <option value="">Todos os modelos</option>
          ${usedModels.map(id => html`<option value=${id}>${modelById(id)?.label || id}</option>`)}
        </select>
        <${Toggle} checked=${favs} onChange=${setFavs} label="Só favoritos" />
        <span class="grow"></span>
        ${pickedJobs.length >= 2 ? html`<button class="btn btn--primary" onClick=${() => setComparing(true)}>Comparar ${pickedJobs.length}</button>` : html`<span class="small dim">Marque ✓ em 2 ou mais para comparar</span>`}
      </div>
      <${PaywallBand} />
      ${!list.length ? html`<div class="empty"><b>Nenhum vídeo pronto ${all.length ? 'com esse filtro' : 'ainda'}</b><span>Cada vídeo pronto fica disponível para baixar por ${S.me?.limits?.result_days || 30} dias. Baixe os que quiser guardar.</span></div>` : null}
      <div class="gallery">${list.map(j => (lockedJob(j) ? html`<${LockedCard} key=${j.id} j=${j} />` : html`<${VideoCard} key=${j.id} j=${j} picked=${picked.includes(j.id)} onPick=${() => pick(j.id)} />`))}</div>
      ${comparing ? html`<${Compare} jobs=${pickedJobs} onClose=${() => setComparing(false)} />` : null}
      <${PaywallModal} />
    </div>`
}
