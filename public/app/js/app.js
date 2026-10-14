// Casca do app: barra superior, rotas, arrastar-e-soltar global.
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { html, num, cr, Toasts, Lightbox, ConfirmHost } from './ui.js'
import { S, useStore, load, logout, openWallet } from './state.js'
import { uploadClips, isVideo } from './actions.js'
import { Login, WalletModal, HiggsfieldChip, HiggsfieldBand } from './views/account.js'
import { Studio } from './views/studio.js'
import { Characters } from './views/characters.js'
import { Queue } from './views/queue.js'
import { Gallery } from './views/gallery.js'
import { Settings } from './views/settings.js'

const ROUTES = [
  { path: '', label: 'Estúdio', view: Studio },
  { path: 'personagens', label: 'Personagens', view: Characters },
  { path: 'fila', label: 'Fila', view: Queue },
  { path: 'galeria', label: 'Galeria', view: Gallery },
  { path: 'config', label: 'Configurações', view: Settings },
]

function useRoute() {
  const get = () => location.hash.replace(/^#\/?/, '').split('?')[0]
  const [r, setR] = useState(get())
  useEffect(() => {
    const on = () => setR(get())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return r
}

function GlobalDrop() {
  const [on, setOn] = useState(false)
  useEffect(() => {
    let depth = 0
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files')
    const enter = e => { if (!hasFiles(e)) return; depth++; setOn(true) }
    const leave = e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) setOn(false) }
    const over = e => { if (hasFiles(e)) e.preventDefault() }
    const drop = e => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setOn(false)
      // zonas específicas (ex.: imagens de personagem) tratam o próprio drop
      if (e.target.closest?.('[data-own-drop]')) return
      const files = [...e.dataTransfer.files].filter(isVideo)
      if (files.length) uploadClips(files, clip => window.dispatchEvent(new CustomEvent('clip-added', { detail: clip })))
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
  return html`<div class=${`dropzone-global ${on ? 'is-on' : ''}`}>Solte o vídeo base aqui</div>`
}

function App() {
  const s = useStore()
  const route = useRoute()
  const current = ROUTES.find(r => r.path === route) || ROUTES[0]
  const active = s.jobs.filter(j => j.status === 'running' || j.status === 'queued').length
  // Character Online: o número da Fila conta só o que está na fila ou gerando (os erros ficam dentro da Fila)
  const failed = s.jobs.filter(j => j.status === 'failed' && !j.archived).length
  const anyKey = s.providers.some(p => p.id !== 'mock' && p.configured)
  // Character Online: conta Higgsfield própria (ou sem conta): o chip do Higgsfield fica no lugar dos Créditos
  const hf = s.me?.higgsfield
  const hfChip = !!hf && hf.mode !== 'pool'
  const View = current.view

  useEffect(() => { document.title = `${active ? `(${active}) ` : ''}Character · ${s.auth === 'login' ? 'Entrar' : current.label}` }, [active, current, s.auth])

  // Character Online: sem sessão, só a tela de entrada
  if (s.auth === 'login') return html`<${Login} />`
  return html`
    <div class=${hf?.notice ? 'app app--band' : 'app'}>
      <header class="topbar">
        <a class="brand" href="#/"><span class="brand__word">Character</span></a>
        <nav class="nav">
          ${ROUTES.map(r => html`<a href=${`#/${r.path}`} class=${r === current ? 'is-on' : ''}>${r.label}
            ${r.path === 'fila' && active ? html`<span class="count" title=${`${active} na fila ou gerando${failed ? `, ${failed} com erro (veja na Fila)` : ''}`}>${active}</span>` : null}</a>`)}
        </nav>
        <div class="topbar__right">
          ${!anyKey && s.ready && !hf ? html`<a class="mode-pill" href="#/config" title="Sem chaves de API: só o modo teste funciona">modo teste</a>` : null}
          <div class="spend" title="Créditos usados (vídeos e imagens)">
            <span>Hoje<b>${cr(s.spend.today)}</b></span>
            <span>Mês<b>${cr(s.spend.month)}</b></span>
          </div>
          ${s.me ? html`${hfChip ? html`<${HiggsfieldChip} />` : html`<button class="wallet-chip" onClick=${openWallet} title="Seus créditos: saldo, extrato e compra de créditos">Créditos<b>${num(s.wallet.balance_credits)}</b></button>`}
            <button class="btn btn--quiet btn--sm" onClick=${logout} title=${`Sair (${s.me.user?.email || ''})`}>Sair</button>` : null}
        </div>
      </header>
      <${HiggsfieldBand} />
      <main class="main">
        ${s.ready ? html`<${View} />` : html`<div class="page"><div class="empty">${s.error ? html`<b>Não consegui falar com o servidor</b><span>${s.error}</span>` : html`<span class="spinner"></span>`}</div></div>`}
      </main>
      <${GlobalDrop} />
      ${s.walletOpen ? html`<${WalletModal} />` : null}
      <${Toasts} />
      <${Lightbox} />
      <${ConfirmHost} />
    </div>`
}

render(html`<${App} />`, document.getElementById('app'))
load() // conecta os eventos ao vivo depois de confirmar a sessão
