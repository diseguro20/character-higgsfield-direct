// Componentes e formatadores compartilhados.
import { h } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import htm from 'htm'
import { S, notify, toast } from './state.js'
import { api } from './api.js'

export const html = htm.bind(h)

const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const usd = n => `US$ ${nf2.format(Number(n) || 0)}`
// Character Online: créditos ("1.250 créditos", curto "330 cr"), dinheiro só dos pacotes ("R$ 250,00"), fila e prazo do vídeo pronto
export { money, num, credits, cr, queueText, dayMonth } from './cloud.js'

export function dur(s) {
  s = Number(s) || 0
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace('.', ',')} s`
  const m = Math.floor(s / 60)
  const r = Math.round(s % 60)
  return `${m}:${String(r).padStart(2, '0')}`
}

export function resLabel(w, h) {
  if (!w || !h) return ''
  const short = Math.min(w, h)
  const tag = short >= 2000 ? '4K' : short >= 1400 ? '1440p' : short >= 1000 ? '1080p' : short >= 700 ? '720p' : `${short}p`
  return tag
}

export function ago(iso) {
  if (!iso) return ''
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })
}

export function elapsed(job) {
  if (!job.startedAt) return ''
  const end = job.finishedAt ? new Date(job.finishedAt) : (job.status === 'running' ? new Date() : new Date(job.updatedAt))
  const s = (end - new Date(job.startedAt)) / 1000
  return s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`
}

export function Badge({ kind = '', children, title }) {
  return html`<span class=${`badge ${kind ? 'badge--' + kind : ''}`} title=${title}>${children}</span>`
}

export function modelBadges(m) {
  if (!m) return null
  return html`${(m.badges || []).map(b => html`<${Badge} kind=${/4k/i.test(b) ? '4k' : /grátis/i.test(b) ? 'test' : ''}>${b}</${Badge}>`)}${m.status === 'beta' ? html`<${Badge} kind="coral" title="Endpoint ainda não testado com chave real">beta</${Badge}>` : null}`
}

export function Toggle({ checked, onChange, label }) {
  return html`<label class="toggle"><input type="checkbox" checked=${checked} onChange=${e => onChange(e.target.checked)} /><span class="toggle__track"></span>${label}</label>`
}

export function Seg({ value, options, onChange }) {
  return html`<div class="seg">${options.map(o => html`<button type="button" class=${o.value === value ? 'is-on' : ''} onClick=${() => onChange(o.value)}>${o.label}</button>`)}</div>`
}

// Campo que o usuário está editando não é sobrescrito pelas atualizações ao vivo da fila.
// Devolve [rascunho, setRascunho, confirmar]: chame confirmar() ao salvar para voltar a seguir o valor salvo.
export function useDraft(source, resetKey) {
  const [draft, setDraft] = useState(source)
  const dirty = useRef(false)
  useEffect(() => { dirty.current = false; setDraft(source) }, [resetKey])
  useEffect(() => { if (!dirty.current) setDraft(source) }, [source])
  return [draft, v => { dirty.current = true; setDraft(v) }, () => { dirty.current = false }]
}

// Pilha de janelas abertas: Esc fecha só a de cima.
const layers = []

export function Modal({ title, onClose, size = '', children, foot, head }) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const token = {}
    layers.push(token)
    const onKey = e => {
      if (e.key !== 'Escape' || e.defaultPrevented || S.lightbox) return
      if (layers[layers.length - 1] !== token) return
      e.preventDefault()
      closeRef.current?.()
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); layers.splice(layers.indexOf(token), 1) }
  }, [])
  return html`
    <div class="overlay" onMouseDown=${e => { if (e.target === e.currentTarget) onClose?.() }}>
      <div class=${`modal ${size ? 'modal--' + size : ''}`} role="dialog" aria-modal="true">
        <div class="modal__head">
          <h2 class="display modal__title">${title}</h2>
          ${head}
          <button class="btn btn--quiet btn--icon" style="margin-left:auto" onClick=${onClose} aria-label="Fechar">✕</button>
        </div>
        <div class="modal__body">${children}</div>
        ${foot ? html`<div class="modal__foot">${foot}</div>` : null}
      </div>
    </div>`
}

export function Toasts() {
  return html`<div class="toasts">${S.toasts.map(t => html`<div class=${`toast toast--${t.kind}`} key=${t.id}>${t.text}</div>`)}</div>`
}

export function Lightbox() {
  const lb = S.lightbox
  useEffect(() => {
    if (!lb) return
    // fase de captura + stopImmediatePropagation: o Esc fecha só a imagem, não a janela por baixo
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); S.lightbox = null; notify() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [lb])
  if (!lb) return null
  const close = () => { S.lightbox = null; notify() }
  return html`
    <div class="lightbox" onClick=${close}>
      ${lb.kind === 'video'
        ? html`<video src=${lb.url} controls autoplay playsinline onClick=${e => e.stopPropagation()}></video>`
        : html`<img src=${lb.url} onClick=${e => e.stopPropagation()} />`}
    </div>`
}

const STATUS = { pending: '', running: 'is-running', done: 'is-done', failed: 'is-failed', canceled: 'is-failed', skipped: 'is-skipped' }

export function StepsProgress({ job }) {
  return html`<div class="steps">${(job.steps || []).map(st => {
    let p = st.progress
    if (st.parts?.length) p = st.parts.filter(x => x.status === 'done').length / st.parts.length
    const w = st.status === 'running' && p ? `${Math.round(p * 100)}%` : '0'
    return html`<span class=${`stp ${STATUS[st.status] || ''}`} title=${st.error || st.log || ''}><i style=${{ width: w }}></i><span>${st.label}${st.parts?.length > 1 ? ` ${st.parts.filter(x => x.status === 'done').length}/${st.parts.length}` : ''}</span></span>`
  })}</div>`
}

export function jobProgress(job) {
  const steps = (job.steps || []).filter(s => s.status !== 'skipped')
  if (!steps.length) return 0
  let sum = 0
  for (const st of steps) {
    if (st.status === 'done') sum += 1
    else if (st.status === 'running') {
      if (st.parts?.length) sum += st.parts.reduce((a, p) => a + (p.status === 'done' ? 1 : (p.progress || 0) * 0.9), 0) / st.parts.length
      else sum += (st.progress || 0) * 0.95
    }
  }
  return sum / steps.length
}

export function Spinner() { return html`<span class="spinner"></span>` }

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

// O que está acontecendo no provedor agora (para a fila não parecer travada)
// Character Online: a tentativa falhou no Higgsfield e o app reenvia sozinho (job.retrying, do servidor): diz isso no
// lugar de voltar para "preparando..."
export function remoteInfo(job, modelById) {
  const again = job.retrying?.text ? { text: job.retrying.text, busy: true } : null
  const st = (job.steps || []).find(x => x.status === 'running')
  if (!st) return again
  const h = (st.parts || []).find(p => p.status === 'running') || st
  const m = h.model && modelById(h.model)
  const prov = m?.providerLabel || h.provider || 'provedor'
  if (h.remote === 'uploading') return { text: `enviando arquivos para o ${prov}...`, busy: true }
  if (!h.submittedAt) return again
  const mins = Math.max(0, (Date.now() - new Date(h.submittedAt).getTime()) / 60000)
  const exp = m?.eta ? m.eta.base + (m.eta.perSecond || 0) * (h.duration || 0) : null
  const fmt = n => (n < 1 ? 'menos de 1 min' : `${Math.round(n)} min`)
  if (h.remote === 'queued') return { text: `na fila do ${prov}${h.queuePosition != null ? ` (posição ${h.queuePosition + 1})` : ''} há ${fmt(mins)}: o ${prov} roda poucos pedidos por vez`, busy: true }
  return { text: `${prov} gerando há ${fmt(mins)}${exp ? ` · costuma levar uns ${Math.round(exp)} min` : ''}`, busy: true, pct: exp ? Math.min(0.95, mins / exp) : null }
}

// Confirmação dentro do app (o painel embutido do Claude não mostra o confirm() do navegador)
// Character Online: `no` = rótulo do botão que desiste (no "Cancelar este vídeo?" ele não pode ser outro "Cancelar")
export function confirmDialog(text, { ok = 'Apagar', danger = true, no = 'Cancelar' } = {}) {
  return new Promise(resolve => { S.confirm = { text, ok, danger, no, resolve }; notify() })
}

export function ConfirmHost() {
  const c = S.confirm
  if (!c) return null
  const close = v => { S.confirm = null; notify(); c.resolve(v) }
  return html`<${Modal} title="Tem certeza?" size="sm" onClose=${() => close(false)}
    foot=${html`<button class="btn btn--quiet" onClick=${() => close(false)}>${c.no || 'Cancelar'}</button>
      <button class=${`btn ${c.danger ? 'btn--danger' : 'btn--primary'}`} onClick=${() => close(true)} autofocus>${c.ok}</button>`}>
    <p style="margin:0;font-size:16px">${c.text}</p>
  </${Modal}>`
}

// Provedor sem créditos: os vídeos dele esperam na fila (não falham). Recarregue os créditos e clique em Retomar.
const jobProvider = j => {
  if (j.waitingFor) return j.waitingFor
  const id = j.kind === 'take' ? j.input?.swapModel : j.kind === 'video_upscale' ? j.input?.upscaleModel : j.input?.model
  return S.models.find(m => m.id === id)?.provider
}
export function PausedBanner() {
  const ids = Object.keys(S.paused || {}).filter(id => S.paused[id]?.kind !== 'busy')
  if (!ids.length) return null
  return html`${ids.map(id => {
    const p = S.providers.find(x => x.id === id)
    const waiting = S.jobs.filter(j => j.status === 'queued' && jobProvider(j) === id).length
    const resume = async () => {
      try { const r = await api.post(`/api/providers/${id}/resume`); S.paused = r.paused; notify(); toast('Retomado: a fila volta a enviar', 'ok') } catch (e) { toast(e.message, 'err') }
    }
    return html`<div key=${id} class="pausebar">
      <div class="grow"><b>${p?.label || id} ${S.paused[id]?.kind === 'auth' ? 'desconectado' : 'sem créditos'}.</b> ${waiting ? `${waiting} ${waiting === 1 ? 'vídeo esperando' : 'vídeos esperando'} na fila (nada foi perdido).` : ''} ${S.paused[id]?.kind === 'auth' ? 'Conecte a conta em Configurações e clique em Retomar.' : 'Recarregue os créditos e clique em Retomar.'}</div>
      <button class="btn btn--sm btn--butter" onClick=${resume}>Retomar</button>
    </div>`
  })}`
}
