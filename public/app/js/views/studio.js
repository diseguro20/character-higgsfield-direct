// Estúdio: 4 etapas lado a lado. 1) personagem  2) vídeo base  3) gerar  4) resultados (com fila e detalhes).
// Upscale fica para depois (no vídeo pronto) ou junto, se quiser.
import { useState, useEffect, useRef } from 'preact/hooks'
import { html, usd, credits, cr, queueText, dayMonth, dur, resLabel, Badge, modelBadges, Toggle, Seg, jobProgress, plural, useDraft, remoteInfo, confirmDialog, Modal, Spinner, StepsProgress, PausedBanner } from '../ui.js'
import { S, useStore, loadPref, savePref, toast, characterById, modelById, clipById, castNames, refusalReason, projectById, projectChars, openWallet, modelCreditsPerSecond, higgsfield } from '../state.js'
import { estimateText, higgsfieldBlock, higgsfieldErrorOf, ownBudgetText, noCreditsText, liveHiggsfieldError, jobCredits, retryTitle, higgsfieldFree, canCancel } from '../cloud.js'
import { HiggsfieldWarn, HiggsfieldActions, higgsfieldErrorState, runHf, cancelJob } from './account.js'
import { api } from '../api.js'
import { uploadClips, run, askNotifications, downloadLinks, SOCIAL_RE } from '../actions.js'
import { CharacterCreator, CharacterDetail, coverOf, missingViews, viewsCredits, viewsBusy, askViews } from './characters.js'
import { PaywallModal, PaywallBand, paywallFrom, withPaywall, lockedJob, openPaywall, freeVideosText, paywallOf } from './paywall.js'

const BASE_CFG = {
  swapModels: [], swapOpts: {}, frameModel: null, frameOpts: {},
  upscaleModel: null, upscaleOpts: {}, prompt: '', promptOn: false,
  grain: 0, keepAudio: true, instagram: false, splitLong: true, compare: false, v: 8, upscaleAuto: false, collab: false, maxSeconds: null,
}
// Character Online: duração do vídeo (takes.max_seconds no servidor): null = vídeo completo; CUT_S = só os primeiros
// 30 s (o servidor corta o vídeo e o som antes de dividir; 30 s vão numa parte só, cobrada como 30 s)
const CUT_S = 30
const cutOf = cfg => (cfg?.maxSeconds === CUT_S ? CUT_S : null)
// Segundos que vão de fato para o modelo, pela mesma regra do servidor (core/pricing.js usedSeconds e core/split.js
// capDuration): no máximo maxClipSeconds (60 s), no corte escolhido (cut) e, de maxDuration (29,7 s) até
// maxDuration + 0,3 + 1 (31 s), uma parte só de maxDuration
function sentSeconds(seconds, limits, cut = null) {
  const top = Number(limits?.maxClipSeconds) || 0
  let d = top && seconds > top ? top : seconds
  if (cut && d > cut) d = cut
  const part = Number(limits?.maxDuration) || 0
  return part && d > part && d <= Math.round((part + 1.3) * 1000) / 1000 ? part : d
}
// partes em que o vídeo vai (como o planTake do servidor: partes de até maxDuration)
const partsOf = (seconds, limits) => {
  const part = Number(limits?.maxDuration) || 0
  return part && seconds > part ? Math.ceil(seconds / part) : 1
}
// o corte de 30 s muda este vídeo? (vídeo de até 31 s vai igual com ou sem ele; o servidor só grava o corte nesse caso)
const cutChanges = (seconds, limits) => sentSeconds(seconds, limits, CUT_S) < sentSeconds(seconds, limits)

const byRank = (a, b) => (b.configured - a.configured) || (a.rank - b.rank)
const perSecond = m => (m?.unitPrice ? m.unitPrice / 10 : 0)

// Modelos de troca agrupados por família (ex.: Kling Omni Edit 4K/1080p/720p vira um item com qualidades)
function families() {
  const map = new Map()
  for (const m of S.models.filter(x => x.step === 'swap')) {
    if (!map.has(m.family)) map.set(m.family, [])
    map.get(m.family).push(m)
  }
  return [...map.values()]
    .map(list => list.sort((a, b) => (b.limits?.outputLongSide || 0) - (a.limits?.outputLongSide || 0)))
    .sort((a, b) => byRank(a[0], b[0]))
}
const familyOf = id => families().find(f => f.some(m => m.id === id)) || []

function defaultSwap() {
  const fams = families().filter(f => f[0].status !== 'test')
  const ok = fams.find(f => f.some(m => m.configured))
  if (ok) return ok.find(m => m.configured).id
  // Character Online: sem conta Higgsfield conectada o Genjutsu continua escolhido (o aviso de conectar fica no Gerar)
  if (fams[0] && S.me?.higgsfield) return fams[0][0].id
  return 'mock-swap'
}
// upscale padrão para modelos que não entregam 4K (ex.: Genjutsu 1080p): o melhor Topaz com chave
function defaultUpscale() {
  const m = S.models.filter(x => x.step === 'video_upscale' && x.configured && x.status !== 'test' && x.provider !== 'mock').sort(byRank)[0]
  return m?.id || null
}

// ------------------------------------------------------------ pop-over genérico
function usePop() {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const on = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const esc = e => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('mousedown', on)
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('mousedown', on); window.removeEventListener('keydown', esc) }
  }, [open])
  return [open, setOpen, ref]
}

// ------------------------------------------------------------ seletor de modelo
function ModelSelect({ cfg, setCfg }) {
  const [open, setOpen, ref] = usePop()
  const cur = modelById(cfg.swapModels[0])
  const fams = families()
  const groups = [
    { title: 'Prontos para usar', list: fams.filter(f => f[0].status !== 'test' && f.some(m => m.configured)) },
    { title: S.me?.higgsfield ? 'Conecte o Higgsfield (Configurações)' : 'Precisam de chave (Configurações)', list: fams.filter(f => f[0].status !== 'test' && !f.some(m => m.configured)) },
    { title: 'Teste grátis', list: fams.filter(f => f[0].status === 'test') },
  ].filter(g => g.list.length)
  const pick = fam => {
    const m = fam.find(x => x.configured) || fam[0]
    if (cfg.compare) {
      const ids = cfg.swapModels.filter(id => !fam.some(x => x.id === id))
      const has = cfg.swapModels.some(id => fam.some(x => x.id === id))
      setCfg({ ...cfg, swapModels: has ? ids : [...cfg.swapModels, m.id] })
    } else {
      setCfg({ ...cfg, swapModels: [m.id] })
      setOpen(false)
    }
  }
  const label = cfg.compare && cfg.swapModels.length > 1
    ? `${cfg.swapModels.length} modelos para comparar`
    : cur ? `${cur.familyLabel}${cur.quality ? ` · ${cur.quality}` : ''}` : 'Escolher modelo'
  return html`
    <div class="relative" ref=${ref}>
      <button class="sel" onClick=${() => setOpen(!open)}>
        <div style="min-width:0"><span class="sel__k">Modelo</span>
          <span class="sel__v">${label} ${!cfg.compare && cur?.badges?.[1] ? html`<${Badge}>${cur.badges[1]}</${Badge}>` : null}</span></div>
        <span class="sel__chev">▾</span>
      </button>
      ${open ? html`<div class="pop">
        ${groups.map(g => html`<div key=${g.title}>
          <div class="pop__group">${g.title}</div>
          ${g.list.map(fam => {
            const top = fam[0]
            const on = cfg.swapModels.some(id => fam.some(x => x.id === id))
            return html`<div key=${top.family} class=${`pop__item ${on ? 'is-on' : ''} ${fam.some(m => m.configured) ? '' : 'is-off'}`} onClick=${() => pick(fam)}>
              <div class="pop__name">${cfg.compare ? html`<input type="checkbox" checked=${on} readonly style="accent-color:var(--accent)" />` : null}${top.familyLabel} ${modelBadges({ ...top, badges: (top.badges || []).slice(0, 2) })}</div>
              <span class="pop__price">${top.status === 'test' ? 'grátis' : `${cr(modelCreditsPerSecond(top))}/s`}</span>
              <div class="pop__desc">${cfg.collab ? html`<b style=${{ color: (top.limits?.maxCast || 1) > 1 ? 'var(--mint)' : 'var(--coral-l)' }}>${(top.limits?.maxCast || 1) > 1 ? `collab até ${top.limits.maxCast}` : 'não faz collab'}</b> · ` : null}${top.description}${fam.length > 1 ? ` · ${fam.map(x => x.quality).join(' / ')}` : ''} <span class="dim">· ${top.providerLabel}</span></div>
            </div>`
          })}
        </div>`)}
      </div>` : null}
    </div>`
}

// Linha de seleção no mesmo estilo do Modelo (rótulo em cima, valor, setinha, lista ao clicar)
function PopSelect({ label, value, options, onChange }) {
  const [open, setOpen, ref] = usePop()
  const cur = options.find(o => o.value === value) || options[0]
  return html`<div class="relative" ref=${ref}>
    <button class="sel" onClick=${() => setOpen(!open)}>
      <div style="min-width:0"><span class="sel__k">${label}</span><span class="sel__v">${cur?.label}${cur?.price ? html` <span class="pixel dim">${cur.price}</span>` : null}</span></div>
      <span class="sel__chev">▾</span>
    </button>
    ${open ? html`<div class="pop">${options.map(o => html`
      <div key=${String(o.value)} class=${`pop__item ${o.value === value ? 'is-on' : ''} ${o.disabled ? 'is-off' : ''}`}
        onClick=${() => { if (o.disabled) { toast(o.disabledMsg || 'Indisponível', 'err'); return } onChange(o.value); setOpen(false) }}>
        <div class="pop__name">${o.label}</div><span class="pop__price">${o.price || ''}</span>
        ${o.desc ? html`<div class="pop__desc">${o.desc}</div>` : null}
      </div>`)}</div>` : null}
  </div>`
}

function QualitySelect({ cfg, setCfg }) {
  const m = modelById(cfg.swapModels[0])
  if (!m || cfg.compare) return null
  const fam = familyOf(m.id)
  if (fam.length > 1) {
    return html`<${PopSelect} label="Qualidade" value=${m.id} onChange=${id => setCfg({ ...cfg, swapModels: [id] })}
      options=${fam.map(x => ({
        value: x.id,
        label: `${x.quality} (${modelCreditsPerSecond(x)} cr/s)`,
        desc: x.id.includes('720p') ? 'Mais rápido e econômico: usa apenas 7 créditos por segundo' : 'Resolução máxima Full HD: 11 créditos por segundo',
        price: `${cr(modelCreditsPerSecond(x))}/s`,
        disabled: !x.configured,
        disabledMsg: `Falta a chave do ${x.providerLabel}`
      }))} />`
  }
  const opt = (m.options || []).find(o => o.key === 'resolution')
  if (opt) {
    const v = cfg.swapOpts[m.id]?.resolution ?? opt.default
    return html`<${PopSelect} label="Qualidade" value=${v} onChange=${x => setCfg({ ...cfg, swapOpts: { ...cfg.swapOpts, [m.id]: { ...(cfg.swapOpts[m.id] || {}), resolution: x } } })}
      options=${opt.choices.map(c => ({ value: c.value, label: c.label }))} />`
  }
  return null
}

function ExtraOptions({ cfg, setCfg }) {
  const m = modelById(cfg.swapModels[0])
  const rest = (m?.options || []).filter(o => o.key !== 'resolution')
  if (!m || cfg.compare || !rest.length) return null
  const value = cfg.swapOpts[m.id] || {}
  return html`<div class="row wrap" style="gap:8px">${rest.map(o => {
    const v = value[o.key] ?? o.default
    if (o.type === 'toggle') return html`<${Toggle} key=${o.key} checked=${!!v} label=${o.label} onChange=${x => setCfg({ ...cfg, swapOpts: { ...cfg.swapOpts, [m.id]: { ...value, [o.key]: x } } })} />`
    if (o.type === 'select') return html`<label key=${o.key} class="row small"><span class="muted">${o.label}</span>
      <select class="select input--sm" style="width:auto" value=${v} onChange=${e => setCfg({ ...cfg, swapOpts: { ...cfg.swapOpts, [m.id]: { ...value, [o.key]: e.target.value } } })}>
        ${o.choices.map(c => html`<option value=${c.value}>${c.label}</option>`)}</select></label>`
    return null
  })}</div>`
}

// ------------------------------------------------------------ vídeo base
function TrimModal({ clip, onClose }) {
  const v = useRef(null)
  const d0 = clip.info.duration
  const [s, setS] = useState(clip.trim?.start ?? 0)
  const [e, setE] = useState(clip.trim?.end ?? d0)
  const [sT, setST] = useState((clip.trim?.start ?? 0).toFixed(1))
  const [eT, setET] = useState((clip.trim?.end ?? d0).toFixed(1))
  const apply = (a, b) => { setS(a); setE(b); setST(a.toFixed(1)); setET(b.toFixed(1)) }
  const commit = (a, b) => {
    a = Math.max(0, Math.min(d0, Number.isFinite(a) ? a : 0))
    b = Math.max(0, Math.min(d0, Number.isFinite(b) ? b : d0))
    if (b - a < 0.5) b = Math.min(d0, a + 0.5)
    apply(a, b)
  }
  const save = async () => { const r = await run(() => api.patch(`/api/clips/${clip.id}`, { trim: { start: s, end: e } })); if (r) onClose() }
  return html`<${Modal} title=${`Trecho · ${clip.name}`} size="sm" onClose=${onClose}
    foot=${html`<button class="btn btn--quiet" onClick=${() => apply(0, d0)}>Vídeo inteiro</button><span class="grow"></span><button class="btn btn--primary" onClick=${save}>Salvar trecho</button>`}>
    <div class="stack">
      <video ref=${v} src=${clip.url} controls playsinline preload="metadata" style="width:100%;max-height:52vh;border-radius:12px;background:#000"></video>
      <div class="row wrap small">
        <span class="muted">De</span><input class="input input--sm" style="width:80px" type="number" step="0.1" value=${sT} onInput=${x => setST(x.target.value)} onChange=${x => commit(Number(x.target.value), e)} />
        <span class="muted">até</span><input class="input input--sm" style="width:80px" type="number" step="0.1" value=${eT} onInput=${x => setET(x.target.value)} onChange=${x => commit(s, Number(x.target.value))} />
        <button class="btn btn--xs" onClick=${() => { const t = v.current?.currentTime || 0; commit(t, Math.max(e, t + 0.5)) }}>[ início aqui</button>
        <button class="btn btn--xs" onClick=${() => commit(s, v.current?.currentTime || e)}>fim aqui ]</button>
      </div>
      <span class="small muted">${dur(e - s)} selecionados</span>
    </div>
  </${Modal}>`
}

// ------------------------------------------------------------ upscale
function UpscaleSelect({ value, onChange }) {
  const list = S.models.filter(m => m.step === 'video_upscale').sort(byRank)
  return html`<${PopSelect} label="Upscale" value=${value || ''} onChange=${v => onChange(v || null)}
    options=${[{ value: '', label: 'Sem upscale' }, ...list.map(m => ({ value: m.id, label: m.label, price: m.unitPrice ? `${usd(m.unitPrice)}/10 s` : '', desc: m.description, disabled: !m.configured, disabledMsg: `Falta a chave do ${m.providerLabel}` }))]} />`
}

function UpscaleMenu({ jobs, onDone, small = true }) {
  const [open, setOpen, ref] = usePop()
  const list = S.models.filter(m => m.step === 'video_upscale').sort(byRank)
  const go = async m => {
    setOpen(false)
    let ok = 0
    for (const j of jobs) if (await run(() => api.post(`/api/jobs/${j.id}/upscale`, { model: m.id }))) ok++
    if (ok) toast(`${plural(ok, 'upscale entrou', 'upscales entraram')} na fila (${m.label})`, 'ok')
    onDone?.()
  }
  const all4k = jobs.every(j => Math.min(j.result?.width || 0, j.result?.height || 0) >= 2000)
  return html`<div class="relative" ref=${ref} style="display:inline-block">
    <button class=${`btn ${small ? 'btn--xs' : 'btn--sm'} btn--butter`} onClick=${() => setOpen(!open)}>${all4k ? 'Refinar pele' : 'Upscale 4K'}${jobs.length > 1 ? ` (${jobs.length})` : ''}</button>
    ${open ? html`<div class="pop" style="width:330px;left:auto;right:0">
      <div class="pop__group">${all4k ? 'Recriar textura de pele (mantém 4K)' : 'Aumentar para 4K'}</div>
      ${list.map(m => html`<div key=${m.id} class=${`pop__item ${m.configured ? '' : 'is-off'}`} onClick=${() => (m.configured ? go(m) : toast(`Falta a chave do ${m.providerLabel}`, 'err'))}>
        <div class="pop__name">${m.label}</div><span class="pop__price">${m.unitPrice ? `${usd(m.unitPrice)}/10 s` : ''}</span>
        <div class="pop__desc">${m.description}</div></div>`)}
    </div>` : null}
  </div>`
}

// Quem recusou/falhou: o modelo da etapa (ou parte) que falhou de verdade
function failedModelName(j) {
  for (const st of j.steps || []) {
    const holders = [...(st.parts || []), st].filter(h => h.status === 'failed' && h.model)
    if (holders.length) { const m = modelById(holders[0].model); return m?.familyLabel || m?.label || holders[0].model }
  }
  const m = modelById(j.input?.swapModel || j.input?.upscaleModel || j.input?.model)
  return m?.familyLabel || m?.label || 'provedor'
}
// Character Online: vídeo barrado decide pelo tipo do erro (errorKind) que o servidor manda; o texto do erro fica só
// como reserva para job sem errorKind (o texto novo de plano diz "recusou" e não é vídeo barrado)
const REFUSED_KINDS = { ip_detected: 'direitos autorais', nsfw: 'moderação' }
const isRefused = j => (j.errorKind ? Object.hasOwn(REFUSED_KINDS, j.errorKind) : /política|recus|nsfw|policy/i.test(j.error || ''))
const failLabel = (j, refused) => {
  const why = j.errorKind ? REFUSED_KINDS[j.errorKind] || null : refusalReason(j.error)
  return refused || why ? `Barrado pelo ${failedModelName(j)}${why ? ` (${why})` : ''}` : `Falhou no ${failedModelName(j)}`
}

// ------------------------------------------------------------ histórico
const ASPECT = (w, h) => {
  if (!w || !h) return ''
  const r = w / h
  return Math.abs(r - 9 / 16) < 0.03 ? '9:16' : Math.abs(r - 16 / 9) < 0.03 ? '16:9' : Math.abs(r - 3 / 4) < 0.03 ? '3:4' : Math.abs(r - 1) < 0.03 ? '1:1' : `${w}×${h}`
}

function GenCard({ j, grid, picked, onPick, onRecreate }) {
  const ch = characterById(j.input?.characterId)
  const clip = clipById(j.input?.clipId)
  const m = modelById(j.input?.swapModel)
  const um = modelById(j.input?.upscaleModel)
  const active = j.status === 'running' || j.status === 'queued'
  const ri = j.status === 'running' ? remoteInfo(j, modelById) : null
  const p = jobProgress(j)
  const refs = (j.input?.imageIds?.length ? j.input.imageIds.map(id => ch?.images.find(i => i.id === id)) : ch?.images.filter(i => i.useAsRef) || []).filter(Boolean).slice(0, 5)
  const errText = j.error || ''
  const refused = isRefused(j)
  // Character Online: plano da conta Higgsfield (Free ou teste grátis): repetir igual não passa (como na Fila)
  const planErr = j.errorKind === 'plan' || j.errorKind === 'trial'
  const bg = coverOf(ch)?.thumbUrl || clip?.thumbUrl
  const title = j.kind === 'video_upscale' ? `Upscale · ${castNames(j)}` : (castNames(j) || j.title)
  // Character Online: "Tentar de novo" recusado pela conta Higgsfield do aluno: aviso com o botão certo aqui mesmo
  const [hfErr, setHfErr] = useState(null)
  const hfWarn = liveHiggsfieldError(hfErr, higgsfield())
  const credit = jobCredits(j)
  return html`<div class=${`gen ${grid ? 'gen--grid' : ''} ${picked ? 'is-picked' : ''}`}>
    <div class="gen__media">
      ${lockedJob(j) ? html`
        ${j.outputs?.thumbUrl ? html`<div class="gen__bg" style=${{ backgroundImage: `url(${j.outputs.thumbUrl})` }}></div>` : null}
        <div class="gen__state">
          <b>Galeria pausada</b>
          <span class="small muted">O vídeo está guardado. Pague a taxa do servidor para assistir e baixar.</span>
          <button class="btn btn--sm btn--primary" onClick=${() => openPaywall()}>Liberar para assistir</button>
        </div>` : null}
      ${j.status === 'done' && j.outputs?.masterUrl ? html`
        <video src=${j.outputs.instagramUrl || j.outputs.masterUrl} poster=${j.outputs.thumbUrl} controls playsinline preload="none"></video>
        <div class="gen__chips">
          ${j.result ? html`<span class="chip chip--ok">${resLabel(j.result.width, j.result.height)}</span>` : null}
        </div>` : null}
      ${active ? html`
        ${bg ? html`<div class="gen__bg" style=${{ backgroundImage: `url(${bg})` }}></div>` : null}
        <div class="gen__state">
          <${Spinner} />
          <b>${j.status === 'queued' ? 'Na fila do app' : 'Gerando'}</b>
          <span class="small muted">${j.waiting?.text || ri?.text || (j.status === 'queued' ? queueText(j) || 'esperando vaga (vários vídeos ao mesmo tempo)' : 'preparando...')}</span>
          <div class=${`bar ${ri?.busy ? 'bar--busy' : ''}`}><i style=${{ width: `${Math.max(4, (ri?.pct != null ? Math.max(p, ri.pct * 0.9) : p) * 100)}%` }}></i></div>
          <${StepsProgress} job=${j} />
          ${j.waiting && j.waiting.kind !== 'busy' ? html`<${HiggsfieldActions} kind=${j.waiting.kind === 'credits' ? 'no_credits' : 'auth'} />` : null}
          ${canCancel(j) ? html`<button class="btn btn--xs" onClick=${() => cancelJob(j)}>Cancelar</button>` : null}
        </div>` : null}
      ${j.status === 'failed' || j.status === 'canceled' ? html`
        ${bg ? html`<div class="gen__bg" style=${{ backgroundImage: `url(${bg})` }}></div>` : null}
        <div class="gen__chips"><span class="chip chip--warn">${j.status === 'canceled' ? 'Cancelado' : failLabel(j, refused)}</span></div>
        <div class="gen__err">
          <p>${j.status === 'canceled' ? (j.billing === 'own' && j.error) || 'Geração cancelada.' : errText}</p>
          <div class="row wrap" style="gap:8px">
            ${!refused && !planErr ? html`<button class="btn btn--sm" onClick=${() => runHf(() => withPaywall(() => api.post(`/api/jobs/${j.id}/retry`)), null, setHfErr)} title=${retryTitle(j)}>Tentar de novo</button>` : null}
            ${planErr && j.status === 'failed' ? html`<${HiggsfieldActions} kind=${j.errorKind === 'trial' ? 'trial' : 'plan'} />` : null}
            ${refused ? html`<button class="btn btn--sm" title="Carrega este personagem e deixa o passo 2 livre para outro vídeo" onClick=${() => onRecreate(j, { only: 'character' })}>Usar outro vídeo</button>
              <button class="btn btn--sm" title="Carrega este vídeo e deixa o passo 1 livre para outro personagem" onClick=${() => onRecreate(j, { only: 'clip' })}>Usar outro personagem</button>`
            : html`<button class="btn btn--sm" onClick=${() => onRecreate(j)}>Recriar com outro ajuste</button>`}
            <button class="btn btn--sm btn--quiet" onClick=${() => run(() => api.del(`/api/jobs/${j.id}`))}>Apagar</button>
          </div>
          <${HiggsfieldWarn} warn=${hfWarn} />
        </div>` : null}
    </div>
    <div class="gen__meta">
      <div class="row" style="gap:8px"><span class="gen__model">${j.kind === 'video_upscale' ? `⤢ ${um?.label || 'Upscale'}` : `${m?.familyLabel || j.input?.swapModel}${m?.quality ? ` · ${m.quality}` : ''}`}</span>
        <button class="btn btn--quiet btn--xs" style="margin-left:auto" title="Favoritar" onClick=${() => run(() => api.patch(`/api/jobs/${j.id}`, { favorite: !j.favorite }))}>${j.favorite ? '★' : '☆'}</button></div>
      <div style="font-weight:600">${title}</div>
      ${j.kind === 'take' && j.input?.prompt ? html`<div class="gen__prompt">${j.input.prompt}</div>` : null}
      <div class="gen__refs">
        ${clip ? html`<img src=${clip.thumbUrl} title=${`Vídeo base: ${clip.name}`} />` : null}
        ${refs.map(img => html`<img key=${img.id} src=${img.thumbUrl} title=${img.label || 'Referência'} />`)}
      </div>
      <div class="gen__facts">
        ${j.result ? html`<${Badge} kind=${Math.min(j.result.width, j.result.height) >= 2000 ? '4k' : ''}>${resLabel(j.result.width, j.result.height)}</${Badge}><${Badge}>${dur(j.result.duration)}</${Badge}><${Badge}>${ASPECT(j.result.width, j.result.height)}</${Badge}>` : null}
        ${j.input?.upscaleModel && j.kind === 'take' ? html`<${Badge}>+ upscale</${Badge}>` : null}
        ${j.kind === 'take' && j.input?.maxSeconds === CUT_S ? html`<${Badge} title="Gerado só com os primeiros 30 segundos do vídeo base">primeiros 30 s</${Badge}>` : null}
        ${credit ? html`<${Badge} title=${credit.title}>${credit.text}</${Badge}>` : null}
        ${j.status === 'done' && j.expiresAt ? html`<${Badge} title="O vídeo fica disponível para baixar até esta data">até ${dayMonth(j.expiresAt)}</${Badge}>` : null}
      </div>
      ${lockedJob(j) ? html`<div class="gen__actions">
        <button class="btn btn--xs btn--primary" onClick=${() => openPaywall()}>Liberar para assistir</button>
        ${j.kind === 'take' ? html`<button class="btn btn--xs" onClick=${() => onRecreate(j)}>Recriar</button>` : null}
      </div>` : null}
      ${j.status === 'done' && j.outputs?.masterUrl ? html`<div class="gen__actions">
        <a class="btn btn--xs btn--primary" href=${j.outputs.masterUrl} download>Baixar</a>
        ${j.outputs.instagramUrl ? html`<a class="btn btn--xs" href=${j.outputs.instagramUrl} download>Instagram</a>` : null}
        ${j.kind === 'take' ? html`<button class="btn btn--xs" onClick=${() => onRecreate(j)}>Recriar</button>` : null}
        <button class="btn btn--xs btn--quiet" title="Apagar do histórico (o arquivo também sai do servidor)" onClick=${async () => (await confirmDialog('Apagar este vídeo? O arquivo também é apagado do servidor: baixe antes se quiser guardar.')) && run(() => api.del(`/api/jobs/${j.id}`))}>🗑</button>
      </div>` : null}
    </div>
  </div>`
}

// ------------------------------------------------------------ etapas
function StepHead({ n, title, done, hint }) {
  return html`<div class="panel__head"><span class=${`step-num ${done ? 'is-done' : ''}`}>${n}</span><h2 class="panel__title">${title}</h2>${hint ? html`<span class="panel__hint">${hint}</span>` : null}</div>`
}

// Collab: quem cada personagem substitui no vídeo
const CAST_TARGETS = [
  { value: 'left', label: 'Pessoa da esquerda' },
  { value: 'right', label: 'Pessoa da direita' },
  { value: 'middle', label: 'Pessoa do meio' },
  { value: 'first', label: 'Quem aparece primeiro' },
  { value: 'second', label: 'Quem aparece depois' },
]
const DEFAULT_TARGETS = { 2: ['left', 'right'], 3: ['left', 'middle', 'right'], 4: ['left', 'middle', 'right', 'second'] }
const castTarget = (meta, id, i, n) => meta[id]?.target || (DEFAULT_TARGETS[n] || DEFAULT_TARGETS[4])[i] || 'left'
const maxCastOf = cfg => Math.min(...cfg.swapModels.map(id => modelById(id)?.limits?.maxCast || 1))

function CastPanel({ sel, setSel, meta, setMeta }) {
  const chosen = sel.map(characterById).filter(Boolean)
  const set = (id, patch) => setMeta({ ...meta, [id]: { ...meta[id], ...patch } })
  const up = i => setSel(p => { const a = [...p]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; return a })
  return html`<div class="cast">
    ${chosen.length < 2 ? html`<div class="small dim">Escolha 2 ou mais personagens abaixo. Cada um substitui uma pessoa do vídeo.</div>` : null}
    ${chosen.map((c, i) => html`<div key=${c.id} class="cast__row">
      <span class="cast__n">${i + 1}</span>
      <img class="cast__img" src=${coverOf(c)?.thumbUrl} alt="" />
      <div class="cast__body">
        <div class="row" style="gap:4px"><b class="grow ellipsis small">${c.name}</b>
          ${i > 0 ? html`<button class="btn btn--quiet btn--xs" title="Subir na ordem" onClick=${() => up(i)}>↑</button>` : null}
          <button class="btn btn--quiet btn--xs" title="Tirar do collab" onClick=${() => setSel(p => p.filter(x => x !== c.id))}>✕</button></div>
        <select class="select input--sm" value=${castTarget(meta, c.id, i, chosen.length)} onChange=${e => set(c.id, { target: e.target.value })}>
          ${CAST_TARGETS.map(t => html`<option value=${t.value}>${t.label}</option>`)}
        </select>
        <input class="input input--sm" placeholder="Como ela está no vídeo (ex.: man in blue shirt)" value=${meta[c.id]?.cue || ''}
          onChange=${e => set(c.id, { cue: e.target.value.slice(0, 80) })} />
      </div>
    </div>`)}
    ${chosen.length >= 2 ? html`<div class="small dim">Dica: descreva a roupa da pessoa (melhor em inglês). Evite vídeos em que elas trocam de lado.</div>` : null}
  </div>`
}

// Character Online: personagem que o Higgsfield barrou em vários vídeos e que nunca passou (c.blocked, do servidor):
// selo no card com a explicação ao passar o mouse
const blockedVideos = b => (Number(b?.count) > 0 ? plural(Number(b.count), 'vídeo', 'vídeos') : 'vários vídeos')
const blockedTip = b => (b?.reason === 'ip_detected'
  ? `O Higgsfield barrou este personagem em ${blockedVideos(b)} por direitos autorais e ele ainda não passou em nenhum. Costuma ser personagem parecido demais com um famoso: vale tentar outro.`
  : `O Higgsfield barrou este personagem em ${blockedVideos(b)} e ele ainda não passou em nenhum. Vale tentar outro.`)
const BLOCKED_STYLE = 'display:flex;width:fit-content;margin-bottom:4px;white-space:normal;background:var(--coral);color:#fff;border-color:transparent'

const CHAR_FILTERS = [{ value: 'all', label: 'Todos' }, { value: 'fav', label: '★' }, { value: 'serie', label: 'Biblioteca' }, { value: 'meus', label: 'Criados' }]

// 1) Personagem
function CharactersCol({ sel, setSel, model, collab, setCollab, castMeta, setCastMeta }) {
  useStore()
  const [q, setQ] = useState('')
  const [f0, setF] = useState(loadPref('charFilter2', 'all'))
  // pasta apagada: volta para "Todos"
  const proj = f0.startsWith('p:') ? projectById(f0.slice(2)) : null
  const f = f0.startsWith('p:') && !proj ? 'all' : f0
  const filters = [CHAR_FILTERS[0], CHAR_FILTERS[1], ...S.projects.map(p => ({ value: `p:${p.id}`, label: `📁 ${p.name}` })), ...CHAR_FILTERS.slice(2)]
  const [creating, setCreating] = useState(false)
  const [detail, setDetail] = useState(null)
  const qq = q.trim().toLowerCase()
  const base = proj ? projectChars(proj) : S.characters
  const list = base.filter(c => {
    if (qq && !`${c.name} ${c.code || ''}`.toLowerCase().includes(qq)) return false
    if (proj) return true
    if (f === 'fav') return c.favorite
    if (f === 'serie') return c.library // Character Online: personagens prontos da biblioteca
    if (f === 'meus') return !c.importKey
    return true
  })
  const toggle = id => setSel(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  const chosen = sel.map(characterById).filter(Boolean)
  const one = !collab && chosen.length === 1 ? chosen[0] : null
  const refs = one ? one.images.filter(i => i.useAsRef).sort((a, b) => (a.role === 'front' ? -1 : 0) - (b.role === 'front' ? -1 : 0)) : []
  // Character Online: o vídeo já sai só com o card; com as vistas para vídeo (frente, perfil e 3/4 direita, geradas a
  // partir do card) o Higgsfield acerta mais o personagem. Sugere gerar as que faltam, com o preço e a pergunta antes.
  const needViews = chosen.filter(c => missingViews(c).length && !viewsBusy(c))
  const viewsCost = needViews.reduce((n, c) => n + viewsCredits(c), 0)
  const makeViews = async () => {
    if (!(await askViews(needViews))) return
    run(async () => { for (const c of needViews) await api.post(`/api/characters/${c.id}/views`, {}) }, 'Gerando as vistas. Elas entram sozinhas.')
  }
  return html`<section class="panel">
    <${StepHead} n="1" title="Personagem" done=${chosen.length}
      hint=${chosen.length ? html`${collab && chosen.length > 1 ? `collab de ${chosen.length}` : plural(chosen.length, 'escolhido', 'escolhidos')} · <a href="#" onClick=${e => { e.preventDefault(); setSel([]) }}>limpar</a>` : 'clique para escolher'} />
    ${collab ? html`<${CastPanel} sel=${sel} setSel=${setSel} meta=${castMeta} setMeta=${setCastMeta} />` : null}
    ${one ? html`<div class="selrefs">
      <div class="row small"><b class="grow ellipsis">${one.name}</b><a href="#" onClick=${e => { e.preventDefault(); setDetail(one.id) }}>ficha</a></div>
      <div class="refs">${refs.slice(0, 6).map(img => html`<button key=${img.id} class="ref ref--sm" onClick=${() => setDetail(one.id)} title=${img.label || 'Referência'}><img src=${img.thumbUrl} alt="" />${img.role ? html`<span class="ref__tag">${img.label || img.role}</span>` : null}</button>`)}</div>
    </div>` : null}
    ${needViews.length ? html`<div class="selrefs" style="padding-top:8px">
      <div class="row small" style="gap:8px;color:var(--accent)"><span class="grow">${needViews.length === 1 ? `${needViews[0].name} ainda não tem as vistas para vídeo` : `${needViews.length} personagens sem as vistas para vídeo`}: o Higgsfield acerta mais o personagem com elas</span>
      <button class="btn btn--xs btn--butter" onClick=${makeViews}>Gerar vistas${viewsCost ? ` (${credits(viewsCost)})` : ''}</button></div>
    </div>` : null}
    <div class="panel__body">
      <label class="search" style="display:block;margin-bottom:8px"><input class="input input--sm" placeholder="Buscar personagem" value=${q} onInput=${e => setQ(e.target.value)} /></label>
      <div style="margin-bottom:10px"><${Seg} value=${f} options=${filters} onChange=${v => { setF(v); savePref('charFilter2', v) }} /></div>
      ${proj && !proj.characterIds.length ? html`<div class="small dim" style="margin-bottom:10px">A pasta ${proj.name} está vazia. Escolha os personagens dela em Personagens.</div>` : null}
      ${!S.characters.length ? html`<div class="empty" style="margin-bottom:10px"><b>Biblioteca vazia</b><span>Crie o seu primeiro personagem no botão +.</span></div>` : null}
      <div class="chars chars--c">
        <button class="char char--new" onClick=${() => setCreating(true)}><span>+</span>Criar</button>
        ${list.map(c => html`
          <button key=${c.id} class=${`char ${sel.includes(c.id) ? 'is-on' : ''}`} onClick=${() => toggle(c.id)} onDblClick=${() => setDetail(c.id)} title="Clique para escolher · duplo clique abre a ficha">
            <img src=${coverOf(c)?.thumbUrl} alt="" loading="lazy" />
            ${c.favorite ? html`<span class="char__fav">★</span>` : null}
            <span class="char__check">${collab && sel.includes(c.id) ? sel.indexOf(c.id) + 1 : '✓'}</span>
            <span class="char__name">${c.blocked ? html`<span class="badge" style=${BLOCKED_STYLE} title=${blockedTip(c.blocked)}>Barrado em ${blockedVideos(c.blocked)}</span>` : null}${c.name}</span>
          </button>`)}
      </div>
    </div>
    ${creating ? html`<${CharacterCreator} onClose=${() => setCreating(false)} onSaved=${c => {
      setCreating(false)
      if (!c) return
      setSel(p => (p.includes(c.id) ? p : [...p, c.id]))
      if (proj) run(() => api.patch(`/api/projects/${proj.id}`, { add: [c.id] }))
    }} />` : null}
    ${detail ? html`<${CharacterDetail} id=${detail} onClose=${() => setDetail(null)} />` : null}
  </section>`
}

// 2) Vídeo base
// Character Online: até 2 s acima do máximo o servidor aceita e usa só os primeiros segundos (OVER_MAX_SECONDS de
// src/core/pricing.js); só acima disso o vídeo precisa ser cortado
const OVER_MAX_S = 2
// Baixar por link (TikTok / Instagram): campo + downloads em andamento ou que falharam
function LinkBox({ range }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const go = async e => {
    e?.preventDefault()
    if (!text.trim() || busy) return
    setBusy(true)
    const r = await downloadLinks(text)
    setBusy(false)
    if (r) setText('')
  }
  return html`<form class="linkbox" onSubmit=${go}>
    <input class="input input--sm grow" type="url" inputmode="url" spellcheck="false" autocomplete="off" placeholder=${`Cole o link do TikTok ou Instagram (vídeo de ${range || '4 a 60 s'})`}
      value=${text} onInput=${e => setText(e.target.value)} onPaste=${e => { const t = e.clipboardData?.getData('text') || ''; if (SOCIAL_RE.test(t)) { e.preventDefault(); setText(''); setBusy(true); downloadLinks(t).finally(() => setBusy(false)) } }} />
    <button class="btn btn--sm btn--butter" disabled=${!text.trim() || busy}>${busy ? '...' : 'Baixar'}</button>
  </form>`
}

// Character Online: link que não vai passar de novo (j.retryable false: login do Instagram, vídeo privado...): no lugar
// do "Tentar de novo", "Enviar o arquivo" abre o seletor do passo 2 (onPickFile)
function DownloadRow({ j, onPickFile }) {
  const failed = j.status === 'failed'
  const st = j.steps?.find(x => x.status === 'running')
  // baixar pesa 90% da barra; conferir e importar, 10%
  const dl = j.steps?.find(x => x.key === 'download')
  const imp = j.steps?.find(x => x.key === 'import')
  const p = dl?.status === 'done' ? 0.9 + 0.1 * (imp?.status === 'done' ? 1 : imp?.progress || 0) : 0.9 * (dl?.progress || 0)
  return html`<div class=${`dlrow ${failed ? 'is-failed' : ''}`}>
    <div class="row small" style="gap:6px">
      <span class="dlrow__site">${j.input?.label || 'Link'}</span>
      <span class="grow ellipsis" title=${j.input?.url}>${j.title}</span>
      ${failed
        ? html`${j.retryable !== false ? html`<button class="btn btn--quiet btn--xs" onClick=${() => run(() => api.post(`/api/jobs/${j.id}/retry`))}>Tentar de novo</button>`
            : html`<button class="btn btn--xs" title="Baixe o vídeo no celular ou no computador e envie o arquivo aqui" onClick=${() => onPickFile?.()}>Enviar o arquivo</button>`}
            <button class="btn btn--quiet btn--xs" title="Dispensar" onClick=${() => run(() => api.del(`/api/jobs/${j.id}`))}>✕</button>`
        : html`<span class="pixel">${j.status === 'queued' ? 'na fila' : st?.key === 'import' ? 'conferindo' : `${Math.round(p * 100)}%`}</span>
            <button class="btn btn--quiet btn--xs" title="Cancelar" onClick=${() => run(() => api.post(`/api/jobs/${j.id}/cancel`))}>✕</button>`}
    </div>
    ${failed ? html`<div class="small dlrow__err">${j.error || 'Cancelado'}</div>` : html`<div class=${`upload-bar ${j.status === 'queued' ? 'bar--busy' : ''}`}><i style=${{ width: `${Math.max(4, p * 100)}%` }}></i></div>`}
  </div>`
}

// descrição da origem de um vídeo baixado (aparece ao passar o mouse)
function sourceTip(src) {
  const f = src.format || {}
  const mbps = f.tbr ? `${(f.tbr / 1000).toFixed(1).replace('.', ',')} Mbps` : ''
  return [
    `${src.platformLabel}${src.author ? ` · @${src.author}` : ''}`,
    src.caption ? src.caption.slice(0, 160) : '',
    [f.width && f.height ? `${f.width}×${f.height}` : '', (f.vcodec || '').split('.')[0].replace('avc1', 'H.264').replace(/^hvc1|hev1|^h265|bytevc1/, 'HEVC').replace(/^vp0?9/, 'VP9').replace(/^av01/, 'AV1'), mbps].filter(Boolean).join(' · '),
    src.why ? `Escolha: ${src.why}` : '',
  ].filter(Boolean).join('\n')
}

function ClipsCol({ sel, setSel, model, cut, onUseReserved }) {
  useStore()
  const input = useRef(null)
  const [trim, setTrim] = useState(null)
  const toggle = id => setSel(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]))
  // Character Online: limites do vídeo base à vista (duração do modelo, tamanho do servidor) e o arquivo grande demais
  // sai antes de enviar, com o tamanho dele (o servidor recusaria só depois do envio inteiro)
  const range = `${model?.limits?.minDuration || 4} a ${model?.limits?.maxClipSeconds || 60} s`
  const maxMb = Number(S.me?.limits?.max_upload_mb) || 300
  const pick = all => {
    const files = [...all].filter(f => {
      if (!(f.size > maxMb * 1024 * 1024)) return true
      toast(`${all.length > 1 ? `${f.name}: ` : ''}Esse vídeo tem ${Math.ceil(f.size / 1024 / 1024)} MB e o máximo é ${maxMb} MB. Exporte em 1080p e envie de novo.`, 'err', 9000)
      return false
    })
    if (files.length || !all.length) uploadClips(files, c => setSel(p => (p.includes(c.id) ? p : [...p, c.id])))
  }
  const remove = async (e, c) => {
    e.stopPropagation()
    if (!(await confirmDialog(`Apagar o vídeo base "${c.name}"? Os vídeos já gerados continuam na galeria.`))) return
    const r = await run(() => api.del(`/api/clips/${c.id}`))
    if (r) setSel(p => p.filter(x => x !== c.id))
  }
  const len = c => (c.trim?.end ?? c.info.duration) - (c.trim?.start ?? 0)
  const max = model?.limits?.maxDuration
  const reservedFor = c => (c.reservedFor && !S.jobs.some(j => j.kind === 'take' && j.input?.clipId === c.id && j.input?.characterId === c.reservedFor && !['failed', 'canceled'].includes(j.status)) ? characterById(c.reservedFor) : null)
  useEffect(() => {
    const on = e => {
      if (e.defaultPrevented || e.target?.closest?.('input, textarea, [contenteditable="true"]') || document.querySelector('.overlay')) return
      const t = e.clipboardData?.getData('text') || ''
      if (!SOCIAL_RE.test(t)) return
      e.preventDefault()
      downloadLinks(t)
    }
    window.addEventListener('paste', on)
    return () => window.removeEventListener('paste', on)
  }, [])
  // em andamento e os que falharam (cancelado some na hora)
  const downloads = S.jobs.filter(j => j.kind === 'download' && j.status !== 'done' && j.status !== 'canceled').slice(0, 8)
  return html`<section class="panel">
    <${StepHead} n="2" title="Vídeo base" done=${sel.length}
      hint=${sel.length ? html`${plural(sel.length, 'escolhido', 'escolhidos')} · <a href="#" onClick=${e => { e.preventDefault(); setSel([]) }}>limpar</a>` : 'arraste para a janela'} />
    <div class="panel__body">
      <div class="drop drop--c" onClick=${() => input.current.click()}>
        <span class="drop__plus">+</span><div><b>Solte ou escolha vídeos de ${range}</b><div class="small dim">MP4, MOV ou WEBM, até ${maxMb} MB</div></div>
        <input ref=${input} type="file" accept="video/*,.mov,.mp4,.m4v" multiple hidden onChange=${e => { pick(e.target.files); e.target.value = '' }} />
      </div>
      <${LinkBox} range=${range} />
      ${downloads.map(j => html`<${DownloadRow} key=${j.id} j=${j} onPickFile=${() => input.current?.click()} />`)}
      ${S.uploads.map(u => html`<div key=${u.id} class="stack" style="margin-top:8px;gap:4px"><div class="row small"><span class="grow ellipsis">${u.name}</span><span class="pixel">${Math.round(u.progress * 100)}%</span></div><div class="upload-bar"><i style=${{ width: `${u.progress * 100}%` }}></i></div></div>`)}
      <div class="clips" style="gap:8px;margin-top:10px">${S.clips.map(c => {
        const trimmed = Math.abs(len(c) - c.info.duration) > 0.15
        // "Primeiros 30 segundos" escolhido no passo 3: o vídeo escolhido que o corte muda (mais de 31 s) usa só o começo.
        // Partes pela regra do servidor (de 29,7 a 31 s, uma parte só): 30 s cortados vão numa parte
        const cutHere = !!cut && sel.includes(c.id) && cutChanges(len(c), model?.limits)
        const n = partsOf(sentSeconds(len(c), model?.limits, cutHere ? cut : null), model?.limits)
        const parts = n > 1 ? n : 0
        return html`<div key=${c.id} class=${`clip clip--c ${sel.includes(c.id) ? 'is-on' : ''}`} onClick=${() => toggle(c.id)}>
          <img class="clip__thumb" src=${c.thumbUrl} alt="" loading="lazy" />
          <div style="min-width:0">
            <div class="row" style="gap:4px"><div class="clip__name grow ellipsis" title=${c.source ? sourceTip(c.source) : c.name}>${c.name}</div>
              ${c.source?.webpageUrl ? html`<a class="btn btn--quiet btn--xs" href=${c.source.webpageUrl} target="_blank" rel="noopener noreferrer" title=${`Abrir o original no ${c.source.platformLabel}`} onClick=${e => e.stopPropagation()}>↗</a>` : null}
              <button class="btn btn--quiet btn--xs" title="Apagar" onClick=${e => remove(e, c)}>🗑</button></div>
            <div class="clip__meta">
              <${Badge}>${dur(len(c))}${trimmed ? ' ✂' : ''}</${Badge}>
              <${Badge} kind=${resLabel(c.info.width, c.info.height) === '4K' ? '4k' : ''}>${resLabel(c.info.width, c.info.height)}</${Badge}>
              ${c.info.hdr ? html`<${Badge} kind="coral">HDR</${Badge}>` : null}
              ${c.source ? html`<${Badge} title=${sourceTip(c.source)}>${c.source.platformLabel}</${Badge}>` : null}
              ${c.blocked ? html`<${Badge} kind="coral" title=${c.blocked.reason}>Vídeo barrado</${Badge}>` : null}
              ${reservedFor(c) ? html`<${Badge} kind="4k" title="Sorteado para este personagem na produção. Clique em Usar para escolher os dois e depois em Gerar.">Reservado: ${reservedFor(c).name}</${Badge}>
                <button class="btn btn--butter btn--xs" onClick=${e => { e.stopPropagation(); onUseReserved?.(c) }}>Usar com ${reservedFor(c).name}</button>` : null}
              ${sel.includes(c.id) && parts ? html`<${Badge} title=${`O ${model.familyLabel} gera até ${max} s por vez`}>${parts} partes</${Badge}>` : null}
              ${cutHere ? html`<${Badge} title="Escolhido no passo 3: só os primeiros 30 segundos deste vídeo entram na troca">primeiros 30 s</${Badge}>` : null}
              ${model?.limits?.maxClipSeconds && len(c) > model.limits.maxClipSeconds + OVER_MAX_S + 0.05 ? html`<${Badge} kind="coral" title=${`Vídeos de até ${model.limits.maxClipSeconds} s. Corte e envie de novo.`}>passa de ${model.limits.maxClipSeconds} s</${Badge}>` : null}
              ${!cutHere && model?.limits?.maxClipSeconds && len(c) > model.limits.maxClipSeconds + 0.05 && len(c) <= model.limits.maxClipSeconds + OVER_MAX_S + 0.05 ? html`<${Badge} title=${`O vídeo passa um pouco de ${model.limits.maxClipSeconds} s: a troca usa só os primeiros ${model.limits.maxClipSeconds} s`}>usa os primeiros ${model.limits.maxClipSeconds} s</${Badge}>` : null}
            </div>
          </div>
        </div>`
      })}</div>
    </div>
    ${trim ? html`<${TrimModal} clip=${trim} onClose=${() => setTrim(null)} />` : null}
  </section>`
}

// 3) Gerar
// Character Online: perguntas antes de gerar o que o Higgsfield já barrou (personagem barrado em vários vídeos, par
// vídeo e personagem barrado). Não bloqueia: às vezes passa (ex.: depois de tirar o Prompt)
const ASK_REFUSED = { ok: 'Tentar mesmo assim', no: 'Voltar', danger: false }
function blockedQuestion(list, total) {
  const n = c => blockedVideos(c.blocked)
  if (list.length > 1) return `Estes personagens foram barrados pelo Higgsfield em vários vídeos: ${list.map(c => `${c.name} (${n(c)})`).join(', ')}. Tentar mesmo assim?`
  return `${total > 1 ? `O personagem ${list[0].name}` : 'Esse personagem'} foi barrado pelo Higgsfield em ${n(list[0])}. Tentar mesmo assim?`
}

// Character Online: duração (pedido do dono): "Vídeo completo" ou "Primeiros 30 segundos". A duração e os créditos de
// cada escolha vêm do orçamento (duration_choices); a escolha só aparece quando o corte muda algum vídeo escolhido
// (mais de 31 s: até aí o vídeo já vai numa parte só, igual com ou sem o corte), e nos outros casos a caixa diz isso
const clipSeconds = c => (c ? (c.trim?.end ?? c.info?.duration ?? 0) - (c.trim?.start ?? 0) : 0)
// algum dos vídeos escolhidos muda com o corte de 30 s? (só então a escolha aparece e o pedido leva o corte)
const cutMatters = (clips, limits) => clips.some(id => cutChanges(clipSeconds(clipById(id)), limits))
function DurationPick({ clips, cfg, setCfg, est, count, limits }) {
  if (!clips.length) return null
  const lens = clips.map(id => clipSeconds(clipById(id)))
  const longest = Math.max(0, ...lens)
  const cut = cutOf(cfg)
  if (!cutMatters(clips, limits)) {
    const many = clips.length > 1
    const why = longest <= CUT_S + 0.05
      ? `${many ? 'Vídeos de até 30 s vão inteiros' : `Vídeo de ${dur(longest)}: vai inteiro`}. Escolher os primeiros 30 segundos só muda vídeos mais longos.`
      : `${many ? 'Estes vídeos já vão numa parte só' : `Vídeo de ${dur(longest)}: já vai numa parte só`}, então escolher os primeiros 30 segundos não muda nada.`
    return html`<div class="stepbox dur-pick" style="gap:6px">
      <span class="label">Duração</span>
      <span class="small dim">${why}</span>
    </div>`
  }
  const choice = v => (Array.isArray(est?.duration_choices) ? est.duration_choices.find(x => (x.max_seconds ?? null) === v) : null)
  const one = clips.length === 1 && count <= 1
  const opts = [
    { value: null, label: 'Vídeo completo', secs: longest },
    { value: CUT_S, label: 'Primeiros 30 segundos', secs: Math.min(CUT_S, longest) },
  ]
  return html`<div class="stepbox dur-pick" style="gap:8px">
    <span class="label">Duração</span>
    <div class="model-pick" role="radiogroup" aria-label="Duração do vídeo">
      ${opts.map(o => {
        const c = choice(o.value)
        const on = o.value === cut
        const desc = c ? `${dur(c.duration_s)}${one ? '' : ' no total'} · ${plural(c.parts_count, 'parte', 'partes')}` : one ? dur(o.secs) : ''
        return html`<label key=${String(o.value)} class=${`model-opt ${on ? 'is-on' : ''}`} style="min-width:0">
          <input type="radio" name="duracao" checked=${on} onChange=${() => { if (!on) setCfg({ ...cfg, maxSeconds: o.value }) }} />
          <div style="min-width:0;overflow-wrap:anywhere"><div class="model-opt__name">${o.label}</div>${desc ? html`<div class="model-opt__desc">${desc}</div>` : null}</div>
          <span class="model-opt__price">${c ? cr(c.credits) : ''}</span>
        </label>`
      })}
    </div>
    ${cut ? html`<span class="small dim">Usa só o começo do vídeo, com o som dele. O resto fica de fora.${lens.some(d => !cutChanges(d, limits)) ? ' Os vídeos mais curtos vão como estão.' : ''}</span>` : null}
  </div>`
}

function GenerateCol({ chars, clips, cfg, setCfg, castMeta }) {
  const [est, setEst] = useState(null)
  const [busy, setBusy] = useState(false)
  // Character Online: conta Higgsfield do aluno: aviso de conectar / sem créditos (com o botão da ação) e orçamento nela
  const [hfErr, setHfErr] = useState(null)
  const hf = higgsfield()
  const own = hf?.mode === 'own'
  // créditos livres na conta própria: o orçamento do servidor já desconta a fila; sem ele, os livres do estado
  // (available) ou o saldo da conta. hfBalance: o saldo da conta (o número do chip da barra), para o texto dizer quanto
  // já está reservado para a fila
  const hfHave = !own ? null : est?.mode === 'own' && est.higgsfield_credits != null ? Number(est.higgsfield_credits) : higgsfieldFree(hf)
  const hfBalance = !own ? null : est?.higgsfield_balance ?? hf.credits ?? null
  const hfBlock = higgsfieldBlock(hf)
  // o aviso de conectar some sozinho quando a conta volta; o de créditos, quando muda o pedido, quando gera de novo
  // ou quando o saldo sobe (Atualizar saldo, evento ao vivo): aí vale a conta de agora (short)
  const hfWarn = hfBlock || liveHiggsfieldError(hfErr, hf)
  const swap = modelById(cfg.swapModels[0])
  const collab = cfg.collab && chars.length > 1
  // collab: o elenco todo entra num vídeo só
  const count = (collab ? 1 : chars.length) * clips.length * cfg.swapModels.length
  const castMax = maxCastOf(cfg)
  const castBad = collab && chars.length > castMax
  const castShort = cfg.collab && chars.length === 1
  const [promptDraft, setPromptDraft] = useDraft(cfg.prompt || '', 'prompt')
  // Character Online: hospedagem paga (vídeos grátis que faltam; acabaram: o botão de pagar)
  const pw = paywallOf()
  const pwText = freeVideosText(pw)
  const pwOut = !!pwText && (pw.locked || !(pw.free_left > 0))

  // corte de 30 s: só vai no pedido quando muda algum dos vídeos escolhidos (a escolha guardada não pesa nos curtos)
  const cut = cutMatters(clips, swap?.limits) ? cutOf(cfg) : null

  function body() {
    return {
      characterIds: chars, clipIds: clips,
      cast: collab ? chars.map((id, i) => ({ characterId: id, target: castTarget(castMeta, id, i, chars.length), cue: castMeta[id]?.cue || null })) : null,
      swapModels: cfg.swapModels, swapOpts: cfg.swapOpts,
      frameModel: cfg.frameModel, frameOpts: cfg.frameOpts,
      upscaleModel: cfg.upscaleModel, upscaleOpts: cfg.upscaleOpts,
      prompt: cfg.promptOn && (cfg.prompt || '').trim() ? cfg.prompt.trim() : null,
      splitLong: cfg.splitLong,
      maxSeconds: cut,
      finish: { grain: cfg.grain, keepAudio: cfg.keepAudio, instagram: cfg.instagram },
    }
  }

  // Character Online: o orçamento vale para esta seleção e esta duração (o Gerar manda o valor que a tela mostrou; trocar
  // a duração e clicar logo em Gerar não manda o preço da outra escolha)
  const estKey = JSON.stringify([chars, clips, cfg.swapModels, collab, cut])
  useEffect(() => {
    if (!clips.length || !cfg.swapModels.length) { setEst(null); return }
    const key = estKey
    const t = setTimeout(() => api.post('/api/estimate', { ...body(), characterIds: chars.length ? chars : ['x'] }).then(r => setEst({ ...r, key })).catch(() => setEst(null)), 250)
    return () => clearTimeout(t)
  }, [JSON.stringify(cfg), chars.join(), clips.join(), JSON.stringify(castMeta), hf?.mode, hf?.status, hf?.credits, hf?.available])
  useEffect(() => setHfErr(null), [estKey])

  // Character Online: par vídeo e personagem que o Higgsfield já barrou: o servidor responde 409 refused_pair com a
  // pergunta; confirmada, o mesmo pedido vai de novo com confirm_refused (os outros erros seguem para o catch do go)
  async function sendTakes(seen, sure) {
    const send = confirm => api.post('/api/takes', { ...body(), expected_total_credits: seen, ...(confirm ? { confirm_refused: true } : {}) })
    try {
      return await send(sure)
    } catch (e) {
      if (sure || e.status !== 409 || e.data?.code !== 'refused_pair') throw e
      if (!(await confirmDialog(e.message, ASK_REFUSED))) return null
      return send(true)
    }
  }

  async function go() {
    if (!count || busy || castBad || castShort || short) return
    setHfErr(null)
    if (hfBlock) return
    const missing = cfg.swapModels.map(modelById).filter(m => m && !m.configured)
    if (missing.length) { toast(`Falta a chave de: ${[...new Set(missing.map(m => m.providerLabel))].join(', ')}. Abra Configurações.`, 'err', 7000); return }
    // Character Online: personagem que o Higgsfield já barrou em vários vídeos (c.blocked): pergunta antes de gerar
    const blocked = chars.map(characterById).filter(c => c?.blocked)
    if (blocked.length && !(await confirmDialog(blockedQuestion(blocked, chars.length), ASK_REFUSED))) return
    setBusy(true)
    askNotifications()
    const seen = est && est.key === estKey ? est.credits : undefined
    let r = null
    try {
      // todos os personagens já confirmados acima: o servidor não pergunta de novo pelo par barrado
      r = await sendTakes(seen, blocked.length > 0 && blocked.length === chars.length)
    } catch (e) {
      const hfe = higgsfieldErrorOf(e)
      // Character Online: passou dos vídeos grátis sem ter pago a hospedagem: paywallFrom abre o aviso de pagamento
      if (paywallFrom(e)) setHfErr(null)
      // Character Online: sem conta conectada, sem créditos ou login vencido no Higgsfield: aviso com a ação certa
      else if (hfe) setHfErr(await higgsfieldErrorState(hfe)) // confere a conta de novo e guarda o saldo visto
      // os créditos mudaram desde o orçamento: mostra o total novo e espera outro clique (nada foi reservado)
      else if (e.status === 409 && e.data?.code === 'price_changed' && Number.isFinite(e.data.total_credits)) {
        setEst(prev => ({ ...(prev || {}), credits: e.data.total_credits, enough: Number(S.wallet.balance_credits) >= e.data.total_credits, key: estKey }))
        toast(`Os créditos mudaram: agora ${count > 1 ? 'estes vídeos usam' : 'este vídeo usa'} ${credits(e.data.total_credits)}. Confira e clique em Gerar de novo.`, 'err', 9000)
      } else toast(e.message, 'err', 7000)
    }
    setBusy(false)
    if (r) toast(`${plural(r.jobs.length, 'vídeo entrou', 'vídeos entraram')} na fila`, 'ok')
  }

  useEffect(() => {
    const on = e => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter' || e.repeat || e.isComposing || e.defaultPrevented) return
      if (document.querySelector('.overlay, .lightbox')) return
      e.preventDefault()
      go()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  })

  const ready = chars.length && clips.length && cfg.swapModels.length && !castBad && !castShort
  // os créditos da carteira (ou da conta Higgsfield própria) não cobrem o pedido (o saldo ao vivo vale mais que o da hora da cotação)
  const short = !!est && est.credits > 0 && hf?.mode !== 'none' && (own ? hfHave != null && hfHave < est.credits : S.me ? Number(S.wallet.balance_credits) < est.credits : est.enough === false)
  return html`<section class="panel">
    <${StepHead} n="3" title="Gerar" done=${ready} />
    <div class="panel__body stack" style="gap:10px">
      <${ModelSelect} cfg=${cfg} setCfg=${setCfg} />
      <${QualitySelect} cfg=${cfg} setCfg=${setCfg} />
      <${DurationPick} clips=${clips} cfg=${cfg} setCfg=${setCfg} est=${est} count=${count} limits=${swap?.limits} />
      ${castBad ? html`<div class="warnbox">${castMax > 1 ? `Este modelo faz collab de até ${castMax} personagens.` : `${swap?.familyLabel || 'Este modelo'} troca uma pessoa só. Para collab use o Higgsfield Genjutsu ou o Kling Omni Edit.`}</div>` : null}
      ${castShort ? html`<div class="warnbox">Collab ligado: escolha pelo menos 2 personagens no passo 1 (ou desligue o collab).</div>` : null}
      <${ExtraOptions} cfg=${cfg} setCfg=${setCfg} />
      <div class="stepbox" style="gap:8px">
        <div class="row"><span class="label grow">Prompt</span><${Toggle} checked=${cfg.promptOn} onChange=${v => setCfg({ ...cfg, promptOn: v })} label="" /></div>
        ${cfg.promptOn ? html`<textarea class="prompt-area" placeholder="Opcional. Ex.: troque o rapaz que está pilotando o jet ski." value=${promptDraft}
            onInput=${e => setPromptDraft(e.target.value)} onBlur=${e => setCfg({ ...cfg, prompt: e.target.value })}></textarea>
          <span class="small dim">Diga só quem trocar, ex.: o rapaz de camisa laranja à direita. Não escreva o nome do personagem nem marcas. A troca não muda cenário nem faz cortes.</span>`
        : html`<span class="small dim">Desligado: usa o padrão testado (mantém movimento, câmera, fundo e luz).</span>`}
      </div>
      ${pwText ? html`<div class=${`paywall-note ${pwOut ? 'paywall-note--out' : ''}`}>
        <span>${pwText}</span>
        ${pwOut ? html`<button class="btn btn--xs btn--primary" onClick=${() => openPaywall()}>Pagar ${pw.price_label}</button>` : null}
      </div>` : null}
      ${short && !own ? html`<div class="warnbox">Créditos insuficientes: ${count > 1 ? 'estes vídeos usam' : 'este vídeo usa'} ${credits(est.credits)} e você tem ${credits(S.wallet.balance_credits)}. <a href="#" onClick=${e => { e.preventDefault(); openWallet() }}>Comprar créditos</a></div>` : null}
      <${HiggsfieldWarn} warn=${hfWarn || (short && own ? { kind: 'no_credits', text: noCreditsText(est.credits, hfHave, hfBalance) } : null)} />
    </div>
    <div class="panel__foot stack" style="gap:8px">
      <span class="small muted">${ready ? `${collab ? `collab de ${chars.length}` : plural(chars.length, 'personagem', 'personagens')} × ${plural(clips.length, 'vídeo', 'vídeos')}${cfg.swapModels.length > 1 ? ` × ${cfg.swapModels.length} modelos` : ''}` : 'Escolha o personagem (1) e o vídeo (2)'}</span>
      ${ready && est && est.credits ? html`<span class="small dim" title=${own ? 'Cada segundo cobrado usa os créditos da sua conta Higgsfield' : 'Cada segundo cobrado usa os créditos do Higgsfield Genjutsu, sem acréscimo'}>${[estimateText(est), own ? ownBudgetText(est.credits, hfHave, hfBalance) : credits(est.credits)].filter(Boolean).join(' · ')}</span>` : null}
      <button class="gen-btn" disabled=${!ready || busy || short || !!hfBlock} onClick=${go}>
        ${busy ? 'Enviando...' : count > 1 ? `Gerar ${count} vídeos` : 'Gerar'}
        ${est && est.credits ? html`<span class="gen-btn__cost" title=${own ? 'Créditos da sua conta Higgsfield que este pedido usa' : 'Créditos reservados ao gerar. Só são descontados quando o vídeo fica pronto; se ele for recusado ou der erro, voltam todos.'}>${cr(est.credits)}</span>` : null}
        <span class="kbd">⌘↵</span>
      </button>
    </div>
    <${PaywallModal} />
  </section>`
}

// 4) Resultados (fila + prontos). Clique abre os detalhes.
function ResultsCol({ onRecreate }) {
  useStore()
  const [open, setOpen] = useState(null)
  const list = S.jobs.filter(j => j.kind === 'take' || j.kind === 'video_upscale').slice(0, 40)
  const running = list.filter(j => j.status === 'running' || j.status === 'queued').length
  const cur = open && S.jobs.find(j => j.id === open)
  return html`<section class="panel">
    <${StepHead} n="4" title="Resultados" done=${list.some(j => j.status === 'done')}
      hint=${html`${running ? `${running} gerando · ` : ''}<a href="#/galeria">Galeria →</a>`} />
    <div class="panel__body">
      <${PausedBanner} />
      <${PaywallBand} />
      ${!list.length ? html`<div class="empty"><b>Nada gerado ainda</b><span>Os vídeos aparecem aqui assim que você clicar em Gerar, com o progresso de cada um.</span></div>` : null}
      <div class="reslist">${list.map(j => html`<${ResultRow} key=${j.id} j=${j} onOpen=${() => setOpen(j.id)} />`)}</div>
    </div>
    ${cur ? html`<${Modal} title=${cur.title} size="xl" onClose=${() => setOpen(null)}>
      <${GenCard} j=${cur} grid=${false} picked=${false} onPick=${() => {}} onRecreate=${(j, o) => { setOpen(null); onRecreate(j, o) }} />
    </${Modal}>` : null}
  </section>`
}

function ResultRow({ j, onOpen }) {
  const ch = characterById(j.input?.characterId)
  const m = modelById(j.input?.swapModel)
  const um = modelById(j.input?.upscaleModel)
  const active = j.status === 'running' || j.status === 'queued'
  const ri = j.status === 'running' ? remoteInfo(j, modelById) : null
  const p = jobProgress(j)
  const refused = isRefused(j)
  const thumb = j.outputs?.thumbUrl || coverOf(ch)?.thumbUrl
  const model = j.kind === 'video_upscale' ? `Upscale · ${um?.label || ''}` : `${m?.familyLabel || j.input?.swapModel || ''}${m?.quality ? ` · ${m.quality}` : ''}`
  return html`<button class=${`res is-${j.status}`} onClick=${onOpen}>
    <img class="res__thumb" src=${thumb} alt="" loading="lazy" />
    <div class="res__info">
      <div class="res__title ellipsis">${castNames(j) || j.title}</div>
      <div class="res__sub ellipsis">${model}</div>
      ${active ? html`<div class=${`bar ${ri?.busy ? 'bar--busy' : ''}`} style="margin-top:6px"><i style=${{ width: `${Math.max(4, (ri?.pct != null ? Math.max(p, ri.pct * 0.9) : p) * 100)}%` }}></i></div>
        <div class="res__sub ellipsis" style="margin-top:3px">${j.status === 'queued' ? (queueText(j) || j.note || 'na fila do app') : j.waiting?.text || ri?.text || 'preparando...'}</div>` : null}
      ${lockedJob(j) ? html`<div class="res__sub ellipsis" style="margin-top:3px">Galeria pausada · clique para liberar</div>` : null}
      ${j.status === 'done' ? html`<div class="row" style="gap:4px;margin-top:5px">${j.result ? html`<${Badge} kind=${Math.min(j.result.width, j.result.height) >= 2000 ? '4k' : ''}>${resLabel(j.result.width, j.result.height)}</${Badge}><${Badge}>${dur(j.result.duration)}</${Badge}>` : null}${jobCredits(j) ? html`<${Badge} title=${jobCredits(j).title}>${jobCredits(j).text}</${Badge}>` : null}</div>` : null}
      ${j.status === 'failed' ? html`<div class="res__err ellipsis">${failLabel(j, refused)} · clique para ver</div>` : null}
      ${j.status === 'canceled' ? html`<div class="res__sub">Cancelado</div>` : null}
    </div>
  </button>`
}

// ------------------------------------------------------------ tela
export function Studio() {
  useStore()
  const [chars, setChars] = useState(loadPref('selChars', []))
  const [clips, setClips] = useState(loadPref('selClips', []))
  const [cfg, setCfgRaw] = useState(() => {
    const saved = loadPref('studio2', {})
    const from = saved.v || 0
    // v3: um vídeo só por padrão (versão Instagram desligada)
    if ((saved.v || 0) < 3) { saved.instagram = false; saved.v = 3 }
    // v4: padrão passa a ser Genjutsu (créditos do plano) + upscale 4K
    if (saved.v < 4) { saved.swapModels = []; saved.upscaleAuto = true; saved.v = 4 }
    // v5: sem grão de filme por padrão (deixava o vídeo granulado e menos nítido)
    if (saved.v < 5) { saved.grain = 0; saved.v = 5 }
    // v6: vídeo base acima de 40 s é cortado em 40 s (cobra por segundo)
    if (saved.v < 6) { saved.maxSeconds = 40; saved.splitLong = true; saved.v = 6 }
    // v7: sem upscale por padrão (pedido do dono em 05/10/2026); dá para ligar à mão em cada envio
    if (saved.v < 7) { saved.upscaleModel = null; saved.upscaleOpts = {}; saved.upscaleAuto = false; saved.v = 7 }
    // v8: duração escolhida no Gerar ("Vídeo completo" ou "Primeiros 30 segundos"). O 40 da v6 nunca valeu no servidor
    // (o vídeo sempre foi inteiro): volta para o vídeo completo, sem surpresa
    if (saved.v < 8) { saved.maxSeconds = null; saved.v = 8 }
    const merged = { ...BASE_CFG, ...saved }
    merged.maxSeconds = cutOf(merged) // só 30 ou null
    if (saved.v !== from) savePref('studio2', merged) // grava a migração já na abertura
    return merged
  })
  const setCfg = c => { setCfgRaw(c); savePref('studio2', c) }
  const [castMeta, setCastMetaRaw] = useState(loadPref('castMeta', {}))
  const setCastMeta = m => { setCastMetaRaw(m); savePref('castMeta', m) }

  const validChars = chars.filter(id => S.characters.some(c => c.id === id))
  const validClips = clips.filter(id => S.clips.some(c => c.id === id))
  useEffect(() => { savePref('selChars', validChars) }, [validChars.join()])
  useEffect(() => { savePref('selClips', validClips) }, [validClips.join()])

  // vídeo solto na janela entra selecionado
  useEffect(() => {
    const on = e => setClips(prev => (prev.includes(e.detail.id) ? prev : [...prev, e.detail.id]))
    window.addEventListener('clip-added', on)
    return () => window.removeEventListener('clip-added', on)
  }, [])

  // primeira vez (ou modelo sumiu do catálogo): escolhe o melhor modelo com chave
  useEffect(() => {
    if (!S.models.length) return
    let next = cfg
    if (!next.swapModels.length || next.swapModels.some(id => !modelById(id))) next = { ...next, swapModels: [defaultSwap()] }
    if (next.upscaleAuto) {
      const out = Math.max(...next.swapModels.map(id => modelById(id)?.limits?.outputLongSide || 0))
      next = { ...next, upscaleAuto: false, upscaleModel: out && out < 3840 ? defaultUpscale() : next.upscaleModel }
    }
    if (next !== cfg) setCfg(next)
  }, [S.models.length])

  // Character Online: vídeo barrado: only 'character' carrega só o personagem ("Usar outro vídeo") e only 'clip' só o
  // vídeo ("Usar outro personagem"); a outra etapa fica vazia, para o aluno não repetir o par que o Higgsfield barrou
  const recreate = (j, { only } = {}) => {
    const inp = j.input || {}
    const cast = inp.cast?.length > 1 ? inp.cast : null
    if (only === 'clip') {
      setChars([])
      setClips(inp.clipId ? [inp.clipId] : [])
      toast('Vídeo carregado. Escolha outro personagem no passo 1.', 'ok')
      return
    }
    setChars(cast ? cast.map(m => m.characterId) : inp.characterId ? [inp.characterId] : [])
    if (cast) setCastMeta({ ...castMeta, ...Object.fromEntries(cast.map(m => [m.characterId, { target: m.target, cue: m.cue || '' }])) })
    if (only === 'character') {
      setClips([])
      if (!!cfg.collab !== !!cast) setCfg({ ...cfg, collab: !!cast })
      toast('Personagem carregado. Escolha outro vídeo no passo 2.', 'ok')
      return
    }
    setClips(inp.clipId ? [inp.clipId] : [])
    setCfg({
      ...cfg,
      swapModels: inp.swapModel ? [inp.swapModel] : cfg.swapModels,
      swapOpts: inp.swapModel ? { ...cfg.swapOpts, [inp.swapModel]: inp.swapOpts || {} } : cfg.swapOpts,
      frameModel: inp.frameModel || null,
      upscaleModel: inp.upscaleModel || null,
      grain: inp.finish?.grain ?? cfg.grain, keepAudio: inp.finish?.keepAudio ?? true, instagram: inp.finish?.instagram ?? false,
      maxSeconds: inp.maxSeconds === CUT_S ? CUT_S : null,
      compare: false,
      collab: !!cast,
    })
    toast('Ajustes carregados nas etapas 1 a 3. Mude o que quiser e gere de novo.', 'ok')
  }

  const wrap = setter => v => setter(prev => (typeof v === 'function' ? v(prev) : v))
  const swap = modelById(cfg.swapModels[0])
  return html`<div class="studio4">
    <${CharactersCol} sel=${validChars} setSel=${wrap(setChars)} model=${swap} collab=${!!cfg.collab} setCollab=${v => setCfg({ ...cfg, collab: v })} castMeta=${castMeta} setCastMeta=${setCastMeta} />
    <${ClipsCol} sel=${validClips} setSel=${wrap(setClips)} model=${swap} cut=${cutOf(cfg)} onUseReserved=${c => {
      setChars([c.reservedFor]); setClips([c.id])
      if (cfg.collab) setCfg({ ...cfg, collab: false })
      toast(`Selecionado: ${characterById(c.reservedFor)?.name || 'personagem'} + este vídeo. Confira e clique em Gerar.`, 'ok')
    }} />
    <${GenerateCol} chars=${validChars} clips=${validClips} cfg=${cfg} setCfg=${setCfg} castMeta=${castMeta} />
    <${ResultsCol} onRecreate=${recreate} />
  </div>`
}
