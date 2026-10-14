// Fila: tudo que está rodando, com etapas, partes, créditos, erros e ações.
import { useState } from 'preact/hooks'
import { html, queueText, dur, Badge, Seg, StepsProgress, jobProgress, elapsed, ago, remoteInfo, PausedBanner } from '../ui.js'
import { S, useStore, characterById, modelById, showLightbox, toast } from '../state.js'
import { api } from '../api.js'
import { run } from '../actions.js'
import { coverOf } from './characters.js'
import { HiggsfieldActions, HiggsfieldWarn, runHf, cancelJob } from './account.js'
import { jobCredits, retryTitle, liveHiggsfieldError, canCancel } from '../cloud.js'
import { PaywallModal, PaywallBand, withPaywall, lockedJob, openPaywall } from './paywall.js'

const FILTERS = [
  { value: 'active', label: 'Rodando' },
  { value: 'failed', label: 'Com erro' },
  { value: 'done', label: 'Prontos' },
  { value: 'all', label: 'Todos' },
]

// Character Online: o que não passa tentando de novo igual fica sem "Tentar de novo" e fora do "Tentar todos": erro
// de plano do Higgsfield (Free ou teste grátis: passa só depois de assinar), vídeo barrado por direitos autorais ou
// moderação (o servidor responde 409; o caminho é trocar o vídeo ou o personagem no Estúdio) e link que não vai baixar
// de novo (j.retryable false: pediu login, privado, longo demais...; o servidor responde 409 download_not_retryable e o
// caminho é enviar o arquivo no Estúdio). Um 409 no meio do "Tentar todos" parava o laço sem reenviar o resto.
const planError = j => j?.errorKind === 'plan' || j?.errorKind === 'trial'
const refusedTake = j => j?.kind === 'take' && (j.stage === 'refused' || j.errorKind === 'ip_detected' || j.errorKind === 'nsfw')
const deadLink = j => j?.kind === 'download' && j.retryable === false
const canRetry = j => !!j && !planError(j) && !refusedTake(j) && !deadLink(j)

const KIND = { take: 'Troca', image: 'Imagem', image_upscale: 'Upscale imagem', video_upscale: 'Upscale vídeo', download: 'Download' }
const STATUS = { queued: ['Na fila', ''], running: ['Rodando', 'coral'], done: ['Pronto', 'mint'], failed: ['Erro', 'red'], canceled: ['Cancelado', ''] }

function JobRow({ j }) {
  const ch = characterById(j.input?.characterId)
  const p = jobProgress(j)
  const [label, kind] = STATUS[j.status] || [j.status, '']
  const models = [j.input?.swapModel, j.input?.frameModel, j.input?.upscaleModel, j.input?.model].filter(Boolean).map(id => modelById(id)?.label || id)
  const runningStep = (j.steps || []).find(s => s.status === 'running')
  const log = runningStep?.parts?.find(x => x.status === 'running')?.log || runningStep?.log
  const ri = j.status === 'running' ? remoteInfo(j, modelById) : null
  const thumb = j.outputs?.thumbUrl || j.outputs?.imageUrls?.[0] || coverOf(ch)?.thumbUrl
  const swapStep = (j.steps || []).find(s => s.key === 'swap')
  // Character Online: créditos da carteira ou do Higgsfield do aluno; "Tentar de novo" recusado pela conta dele vira aviso
  const credit = jobCredits(j)
  const [hfErr, setHfErr] = useState(null)
  const hfWarn = liveHiggsfieldError(hfErr, S.me?.higgsfield)
  // trava do "Tentar de novo" deste pedido: o clique duplo punha dois pedidos novos (lock vale já no clique; o botão
  // desliga no quadro seguinte)
  const [retrying, setRetrying] = useState(false)
  const [lock] = useState(() => ({ on: false }))
  const retry = async () => {
    if (lock.on) return
    lock.on = true
    setRetrying(true)
    try {
      await runHf(() => withPaywall(() => api.post(`/api/jobs/${j.id}/retry`)), null, setHfErr)
    } finally {
      lock.on = false
      setRetrying(false)
    }
  }
  const stopped = j.status === 'failed' || j.status === 'canceled'
  return html`
    <div class=${`job is-${j.status}`}>
      <img class="job__thumb" src=${thumb} alt="" onClick=${() => lockedJob(j) ? openPaywall() : j.outputs?.masterUrl ? showLightbox('video', j.outputs.masterUrl) : thumb && showLightbox('image', j.outputs?.imageUrls?.[0] || thumb)} style="cursor:pointer" />
      <div style="min-width:0">
        <div class="row"><span class="job__title ellipsis">${j.title}</span></div>
        <div class="job__meta">
          <${Badge} kind=${kind}>${label}</${Badge}>
          <${Badge}>${KIND[j.kind] || j.kind}</${Badge}>
          ${models.map(m => html`<span class="small dim">${m}</span>`)}
          <span class="small dim">· ${ago(j.createdAt)}${j.startedAt ? ` · ${elapsed(j)}` : ''}</span>
          ${j.result ? html`<${Badge} kind=${Math.min(j.result.width, j.result.height) >= 2000 ? '4k' : ''}>${j.result.width}×${j.result.height} · ${dur(j.result.duration)}</${Badge}>` : null}
          ${queueText(j) ? html`<${Badge} kind="4k" title="Posição na fila e previsão de quando fica pronto">${queueText(j)}</${Badge}>` : null}
        </div>
        <${StepsProgress} job=${j} />
        ${swapStep?.parts?.length > 1 ? html`<div class="job__parts">${swapStep.parts.map(x => html`<span class=${`job__part is-${x.status}`} title=${x.error || ''}>parte ${x.i + 1}${x.queuePosition ? ` · fila ${x.queuePosition}` : ''}</span>`)}</div>` : null}
        ${j.status === 'running' ? html`<div class=${`bar ${ri?.busy ? 'bar--busy' : ''}`} style="margin-top:8px;max-width:420px"><i style=${{ width: `${Math.max(4, (ri?.pct != null ? Math.max(p, ri.pct * 0.9) : p) * 100)}%` }}></i></div>` : null}
        ${j.status === 'running' && (ri || log) ? html`<div class="job__log">${ri?.text || ''}${log && !/^\s*$/.test(log) ? ` · ${log}` : ''}</div>` : null}
        ${j.status === 'queued' && !j.waiting ? html`<div class="job__log">esperando vaga no app (vários vídeos ao mesmo tempo)</div>` : null}
        ${j.waiting && j.waiting.kind !== 'busy' ? html`<div class="row" style="margin-top:8px"><${HiggsfieldActions} kind=${j.waiting.kind === 'credits' ? 'no_credits' : 'auth'} /></div>` : null}
        ${j.error ? html`<div class="job__err">${j.error}</div>` : null}
        ${stopped && planError(j) ? html`<div class="row" style="margin-top:8px"><${HiggsfieldActions} kind=${j.errorKind === 'trial' ? 'trial' : 'plan'} /></div>` : null}
        ${lockedJob(j) ? html`<div class="row" style="margin-top:8px;gap:8px"><span class="small muted">Galeria pausada: o vídeo está guardado.</span><button class="btn btn--xs btn--primary" onClick=${() => openPaywall()}>Liberar para assistir</button></div>` : null}
        ${hfWarn ? html`<div style="margin-top:8px"><${HiggsfieldWarn} warn=${hfWarn} /></div>` : null}
      </div>
      <div class="stack" style="justify-items:end;gap:8px">
        ${credit ? html`<span class="pixel" title=${credit.title}>${credit.value}${credit.of ? html`<span class="dim"> / ${credit.of}</span>` : null}</span>` : null}
        <div class="job__actions">
          ${canCancel(j) ? html`<button class="btn btn--sm" onClick=${() => cancelJob(j)}>Cancelar</button>` : null}
          ${stopped && canRetry(j) ? html`<button class="btn btn--sm btn--butter" disabled=${retrying} onClick=${retry} title=${retryTitle(j)}>${retrying ? 'Enviando...' : 'Tentar de novo'}</button>` : null}
          ${stopped && refusedTake(j) ? html`<a class="btn btn--sm btn--butter" href="#/" title="No Estúdio, troque o vídeo ou o personagem e gere de novo">Abrir no Estúdio</a>` : null}
          ${stopped && deadLink(j) ? html`<a class="btn btn--sm btn--butter" href="#/" title="Baixe o vídeo no celular ou no computador e envie o arquivo no Estúdio">Enviar o arquivo</a>` : null}
          ${j.status !== 'running' && j.status !== 'queued' ? html`<button class="btn btn--sm btn--quiet" title=${j.status === 'done' ? 'Apagar da fila (o vídeo pronto também é apagado do servidor)' : 'Apagar da fila'} onClick=${() => run(() => api.del(`/api/jobs/${j.id}`))}>🗑</button>` : null}
        </div>
      </div>
    </div>`
}

export function Queue() {
  useStore()
  const [f, setF] = useState('active')
  const list = S.jobs.filter(j => {
    if (f === 'active') return j.status === 'running' || j.status === 'queued'
    if (f === 'failed') return j.status === 'failed' || j.status === 'canceled'
    if (f === 'done') return j.status === 'done'
    return true
  })
  const counts = {
    active: S.jobs.filter(j => j.status === 'running' || j.status === 'queued').length,
    failed: S.jobs.filter(j => j.status === 'failed' || j.status === 'canceled').length,
  }
  const failedIds = S.jobs.filter(j => j.status === 'failed').map(j => j.id)
  // Character Online: sem os que o servidor recusa de novo (erro de plano, vídeo barrado, link que não baixa de novo)
  const retryIds = failedIds.filter(id => canRetry(S.jobs.find(j => j.id === id)))
  // Character Online: "Tentar todos" para no primeiro recusado pela conta Higgsfield do aluno, com o aviso e o botão certo
  const [hfErr, setHfErr] = useState(null)
  // (e no primeiro barrado pela hospedagem paga, com o aviso de pagamento); com trava contra o clique duplo
  const [retryingAll, setRetryingAll] = useState(false)
  const [lockAll] = useState(() => ({ on: false }))
  const retryAll = async () => {
    if (lockAll.on) return
    lockAll.on = true
    setRetryingAll(true)
    try {
      await runHf(async () => {
        for (const id of retryIds) if (!(await withPaywall(() => api.post(`/api/jobs/${id}/retry`)))) return
        toast('Tentando de novo', 'ok')
      }, null, setHfErr)
    } finally {
      lockAll.on = false
      setRetryingAll(false)
    }
  }
  return html`
    <div class="page">
      <div class="page__head">
        <h1 class="display page__title">Fila <em>${counts.active || ''}</em></h1>
        <${Seg} value=${f} onChange=${setF} options=${FILTERS.map(x => ({ ...x, label: x.value === 'active' && counts.active ? `${x.label} ${counts.active}` : x.value === 'failed' && counts.failed ? `${x.label} ${counts.failed}` : x.label }))} />
        <span class="grow"></span>
        ${f === 'failed' && retryIds.length > 1 ? html`<button class="btn btn--butter" disabled=${retryingAll} onClick=${retryAll}>${retryingAll ? 'Enviando...' : 'Tentar todos de novo'}</button>` : null}
      </div>
      <${PausedBanner} />
      <${PaywallBand} />
      <${HiggsfieldWarn} warn=${liveHiggsfieldError(hfErr, S.me?.higgsfield)} />
      ${!list.length ? html`<div class="empty"><b>${f === 'active' ? 'Nada rodando agora' : 'Nada por aqui'}</b><span>${f === 'active' ? 'Gere vídeos no Estúdio. Eles aparecem aqui com o progresso de cada etapa.' : ''}</span>${f === 'active' ? html`<a class="btn btn--primary" href="#/">Ir para o Estúdio</a>` : null}</div>` : null}
      <div class="jobs">${list.map(j => html`<${JobRow} key=${j.id} j=${j} />`)}</div>
      <${PaywallModal} />
    </div>`
}
