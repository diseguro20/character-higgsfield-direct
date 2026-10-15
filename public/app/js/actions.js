// Ações reutilizadas por várias telas.
import { api, uploadFile } from './api.js'
import { S, notify, toast, load, selectOnDone } from './state.js'

const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv)$/i
const IMAGE_RE = /\.(png|jpe?g|webp|heic)$/i

export const isVideo = f => f.type?.startsWith('video/') || VIDEO_RE.test(f.name)
export const isImage = f => f.type?.startsWith('image/') || IMAGE_RE.test(f.name)

// Sobe vídeos base (vários ao mesmo tempo, 2 por vez) e devolve os clipes criados.
export async function uploadClips(files, onEach) {
  const list = [...files].filter(isVideo)
  if (!list.length) { toast('Solte arquivos de vídeo (mp4, mov...)', 'err'); return [] }
  const created = []
  const queue = list.map(file => {
    const entry = { id: Math.random().toString(36).slice(2), name: file.name, file, progress: 0, error: null }
    S.uploads = [...S.uploads, entry]
    return { file, entry }
  })
  notify()
  const worker = async () => {
    while (queue.length) {
      const { file, entry } = queue.shift()
      try {
        const clip = await uploadFile('/api/clips', file, p => { entry.progress = p; notify() })
        created.push(clip)
        onEach?.(clip)
      } catch (e) {
        entry.error = e.message
        toast(`${file.name}: ${e.message}`, 'err', 7000)
      } finally {
        if (!entry.error) S.uploads = S.uploads.filter(u => u !== entry)
        notify()
      }
    }
  }
  await Promise.all([worker(), worker()])
  if (created.length) toast(`${created.length === 1 ? '1 vídeo pronto' : `${created.length} vídeos prontos`} para usar`, 'ok')
  return created
}

// Baixa vídeos por link (TikTok / Instagram; um ou vários colados juntos). Entram em Vídeo base já escolhidos.
export const SOCIAL_RE = /https?:\/\/[^\s]*(tiktok\.com|instagram\.com)/i
export async function downloadLinks(text) {
  const r = await run(() => api.post('/api/downloads', { text }))
  if (!r) return null
  for (const j of r.jobs) selectOnDone.add(j.id)
  for (const id of r.existing) window.dispatchEvent(new CustomEvent('clip-added', { detail: { id } }))
  const n = r.jobs.length
  if (n) toast(n === 1 ? 'Baixando o vídeo na maior qualidade...' : `Baixando ${n} vídeos, um de cada vez...`, 'ok')
  if (r.existing.length) toast(r.existing.length === 1 ? 'Esse vídeo já estava na biblioteca: escolhi ele' : `${r.existing.length} vídeos já estavam na biblioteca`, 'info')
  if (r.skipped.length) toast(r.skipped[0], 'err', 7000)
  return r
}

export async function uploadCharacterImages(characterId, files) {
  const list = [...files].filter(isImage)
  for (const f of list) {
    try { await uploadFile(`/api/characters/${characterId}/images`, f) } catch (e) { toast(`${f.name}: ${e.message}`, 'err') }
  }
}

export async function run(fn, okMsg) {
  try {
    const r = await fn()
    if (okMsg) toast(okMsg, 'ok')
    return r
  } catch (e) {
    toast(e.message, 'err', 7000)
    return null
  }
}

export function askNotifications() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {})
}

export const reveal = path => run(() => api.post('/api/reveal', path ? { path } : {}))

// Importa os face cards da pasta do projeto e recarrega tudo (mantém a ordem da Série Amarela).
export async function importLibrary() {
  const r = await run(() => api.post('/api/library/import'))
  if (!r) return
  await load()
  toast(r.added.length ? `${r.added.length} personagens importados` : 'A biblioteca já está em dia', 'ok')
}
