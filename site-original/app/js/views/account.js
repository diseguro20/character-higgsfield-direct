// Character Online: entrada com a conta Higgsfield (antes, a etapa de criar a conta no Higgsfield pelo link de cadastro;
// e o código no e-mail, se o admin ligar), carteira de créditos (saldo,
// extrato e compra de pacotes), o painel "Sua conta" e a conta Higgsfield própria do aluno (painel, chip da barra do
// topo, faixa de aviso e aviso de geração).
// Mesmos componentes e classes do app local (panel, stepbox, gen-btn, Modal, Seg, table).
import { useState, useRef, useEffect, useLayoutEffect } from 'preact/hooks'
import { html, money, num, credits, cr, ago, Modal, Seg, Toasts, Badge, Spinner, confirmDialog } from '../ui.js'
import {
  S, useStore, notify, toast, load, logout, openWallet, loadPref, savePref, creditPackages, higgsfield,
  refreshHiggsfield, higgsfieldConnect, higgsfieldCallback, higgsfieldCancel, higgsfieldRefresh, higgsfieldDisconnect, higgsfieldLeave,
  openSignin, signinStart, signinCallback, signinCancel, signinRefresh, signinResume, signinLeave,
} from '../state.js'
import { api } from '../api.js'
import {
  entryDelta, HIGGSFIELD_SITE, higgsfieldChip, higgsfieldStep, higgsfieldStatusText, noticeActions, noticeKind, loginErrorText, callbackUrl,
  higgsfieldErrorOf, noCreditsText, loginTimeText, loginCountdown, loginQueueText, cancelQuestion, OPEN_LOGIN, signinStep,
  higgsfieldSigninNote, loginClockOn, loginPollMs, cliLogin, hasCallbackUrl, inAppBrowser, IN_APP_TEXT, copyHelp, planText, lastSentAt,
} from '../cloud.js'

const when = iso => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '')

// ------------------------------------------------------------ etapa 1: criar a conta no Higgsfield
// Decisão do dono (12/10/2026): antes de entrar (ou conectar), a pessoa cria a conta no Higgsfield pelo link de cadastro
// e assina um plano pago, porque a conta grátis (Free) e o teste grátis do Higgsfield não criam personagem por
// aplicativos. O link é o de afiliado do dono: settings.links.higgsfield_signup_url, que o GET /api/state manda em
// `links` (com e sem sessão). Sem ele, ou com um endereço que não seja https, o site do Higgsfield. O mesmo link é o
// "Assinar plano no Higgsfield" do aviso do plano.
export const SIGNUP_STEP_TEXT = 'Crie sua conta no Higgsfield por este link e assine um plano pago (o Starter já serve). A conta grátis e o teste grátis não criam personagem por aplicativos.'
export function higgsfieldSignupUrl(s = S) {
  const url = String(s?.links?.higgsfield_signup_url ?? '').trim()
  return /^https:\/\/[^\s"'<>\\]+$/i.test(url) ? url : HIGGSFIELD_SITE
}
// n = número da etapa (tela de entrada); sem número no painel de Configurações
function HiggsfieldSignupStep({ n = null }) {
  const s = useStore()
  return html`<div class="hf-login__step hf-signup">
    ${n ? html`<span class="step-num">${n}</span>` : null}
    <span class="grow">${SIGNUP_STEP_TEXT}</span>
    <a class="btn btn--sm btn--butter" href=${higgsfieldSignupUrl(s)} target="_blank" rel="noopener">Criar conta no Higgsfield</a>
  </div>`
}

// ------------------------------------------------------------ entrar
// Entrada pelo Higgsfield (decisão do dono, 11/10/2026): "Entrar com o Higgsfield" abre o mesmo login do painel de
// Configurações (fila, abrir o login, colar o endereço, relógio e Cancelar) e, quando ele termina, a pessoa já entra com
// a conta conectada. O código por e-mail só aparece quando o servidor diz que está ligado (S.emailLogin).
// Sem login aberto, duas etapas: 1, criar a conta no Higgsfield pelo link de cadastro e assinar um plano; 2, entrar.
export function Login() {
  const s = useStore()
  return html`
    <div class="app">
      <header class="topbar">
        <a class="brand" href="#/"><span class="brand__word">Character</span></a>
      </header>
      <main class="main">
        <div class="page">
          <div class="login">
            <${HiggsfieldSignIn} />
            ${s.emailLogin ? html`<${EmailLogin} />` : null}
          </div>
        </div>
      </main>
      <${Toasts} />
    </div>`
}

// Entrar com a conta Higgsfield (sem sessão: rotas /api/auth/higgsfield, ações em state.js)
function HiggsfieldSignIn() {
  const s = useStore()
  const login = s.signin
  const step = signinStep(login)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  // recarregou ou voltou do Higgsfield nesta aba: retoma o login guardado; aba nova: o login aberto deste navegador
  useEffect(() => { signinResume() }, [])
  // o login trocou ou mudou de passo (venceu, falhou, cancelou): o erro da última ação não vale mais
  useEffect(() => { setErr(null) }, [login?.id, step])
  const { now, opened } = useLoginWatch(login, {
    refresh: () => signinRefresh(),
    leave: signinLeave,
    // a tela some com o login pela CLI ainda aberto (entrou pelo código no e-mail, por exemplo): cancela e libera a
    // vaga. Quando a entrada abre pelo próprio login, ele já terminou e não há o que cancelar. O login pelo navegador
    // (pkce) não ocupa vaga e fica aberto (useLoginWatch nem chama)
    cancel: l => { if (openSignin()?.id === l.id) signinCancel(l.id).catch(() => null) },
  })
  const act = useAct(busy, setBusy, setErr)
  const start = () => act(signinStart)
  const failed = step === 'failed' ? loginErrorText(login, 'Não consegui entrar com a sua conta Higgsfield. Tente de novo.') : null
  // login pelo navegador que venceu depois de abrir o link: quem já tem o endereço da página que não abriu ainda pode
  // colar (o servidor aceita o endereço de uma tentativa anterior deste navegador). O que falhou não: o state dele foi
  // apagado (o Higgsfield recusou o código, ou a troca já foi tentada) e o endereço da mesma tentativa daria 409
  const latePaste = step === 'failed' && login.status === 'expired' && !cliLogin(login) && !!login.authorizeUrl
  const message = err || s.loginError
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''

  return html`<section class="panel signin">
    <div class="panel__head">
      <h2 class="panel__title">Entrar</h2>
      <span class="panel__hint">com a sua conta Higgsfield</span>
    </div>
    <div class="panel__body stack">
      ${step === 'login' ? html`<${HiggsfieldLoginSteps} login=${login} now=${now} busy=${busy} onOpen=${opened}
          onPaste=${url => act(() => signinCallback(login.id, url))} onBad=${setErr} onCancel=${() => act(() => signinCancel(login.id))}
          doneHint="Se o app abrir aqui sozinho, pode fechar aquela página." verb="entrando" />`
      : html`
        <span class="small muted">O Character é grátis e gera os vídeos na sua própria conta Higgsfield, com os créditos dela.</span>
        <div class="stepbox">
          <${HiggsfieldSignupStep} n=${1} />
          <span class="small dim">Já tem conta? Confira em <a href=${HIGGSFIELD_SITE} target="_blank" rel="noopener">higgsfield.ai</a> se ela tem um plano ativo.</span>
        </div>
        <div class="stepbox">
          <div class="hf-login__step"><span class="step-num">2</span>
            <span class="grow">Entre com essa conta. O login é feito no site do Higgsfield e a gente nunca vê a sua senha.</span></div>
          ${failed ? html`<div class="warnbox">${failed}</div>` : null}
          ${inAppBrowser(ua) ? html`<div class="warnbox hf-warn hf-inapp"><span>${IN_APP_TEXT}</span>
            <span class="hf-actions"><button class="btn btn--sm btn--butter" onClick=${copyAppLink}>Copiar link do app</button></span></div>` : null}
          <button class="gen-btn" disabled=${busy} onClick=${start}>${busy ? 'Abrindo o login...' : 'Entrar com o Higgsfield'}</button>
          ${latePaste ? html`<span class="small dim">Se você já tem o endereço da página que não abriu, cole aqui mesmo assim.</span>
            <${CallbackPaste} key=${login.id} busy=${busy} onPaste=${url => act(() => signinCallback(login.id, url))} onBad=${setErr} />` : null}
        </div>`}
      ${message ? html`<div class="warnbox">${message}</div>` : null}
    </div>
  </section>`
}

// Navegador de dentro de app (Instagram, TikTok): copia o endereço do app para a pessoa abrir no Safari ou no Chrome.
// Sem a área de transferência, o aviso mostra o endereço para copiar à mão.
async function copyAppLink() {
  const link = typeof location !== 'undefined' ? String(location.href || '').split('#')[0] : ''
  try {
    await navigator.clipboard.writeText(link)
    toast('Link copiado. Abra o Safari ou o Chrome e cole na barra de endereço.', 'ok', 7000)
  } catch {
    toast(`Copie este link e abra no Safari ou no Chrome: ${link}`, 'info', 15000)
  }
}

// Entrar com o código por e-mail (só quando o servidor liga: features.email_login). O admin desligou com a tela aberta:
// o formulário some e o aviso do servidor aparece na entrada.
const emailLoginOff = x => {
  if (x?.data?.code !== 'email_login_off') return false
  Object.assign(S, { emailLogin: false, loginError: x.message })
  notify()
  return true
}
function EmailLogin() {
  const [step, setStep] = useState('email')
  const [email, setEmail] = useState(loadPref('loginEmail', ''))
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const codeRef = useRef(null)
  useEffect(() => { if (step === 'code') codeRef.current?.focus() }, [step])

  async function sendCode(e) {
    e?.preventDefault()
    const v = email.trim()
    if (!v || busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.post('/api/auth/code', { email: v })
      savePref('loginEmail', v)
      setStep('code')
      setCode('')
      toast('O código chega em instantes. Confira também a caixa de spam.', 'ok', 6000)
    } catch (x) { if (emailLoginOff(x)) return; setErr(x.message) }
    setBusy(false)
  }

  async function verify(e, value = code) {
    e?.preventDefault()
    const c = String(value).replace(/\D/g, '')
    if (c.length !== 6 || busy) return
    setBusy(true)
    setErr(null)
    try {
      await api.post('/api/auth/verify', { email: email.trim(), code: c })
      S.loginError = null
      await load()
    } catch (x) { if (emailLoginOff(x)) return; setErr(x.message) }
    setBusy(false)
  }

  return html`
    <section class="panel">
      <div class="panel__head">
        <span class="step-num">${step === 'email' ? '1' : '2'}</span>
        <h2 class="panel__title">${step === 'email' ? 'Ou entre com o seu e-mail' : 'Código de acesso'}</h2>
        <span class="panel__hint">sem senha</span>
      </div>
      ${step === 'email' ? html`
        <form class="panel__body stack" onSubmit=${sendCode}>
          <label class="field"><span class="label">Seu e-mail</span>
            <input class="input" type="email" autocomplete="email" inputmode="email" spellcheck="false" required
              placeholder="voce@email.com" value=${email} onInput=${e => setEmail(e.target.value)} /></label>
          ${err ? html`<div class="warnbox">${err}</div>` : null}
          <button class="btn btn--block" disabled=${busy || !email.trim()}>${busy ? 'Enviando...' : 'Receber código'}</button>
          <span class="small dim">Mandamos um código de 6 dígitos para o seu e-mail. Não precisa de senha.</span>
        </form>`
      : html`
        <form class="panel__body stack" onSubmit=${verify}>
          <span class="small muted">Enviamos o código para <b>${email.trim()}</b>. Confira também a caixa de spam.</span>
          <label class="field"><span class="label">Código de 6 dígitos</span>
            <input ref=${codeRef} class="input login__code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"
              value=${code} onInput=${e => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) verify(null, v) }} /></label>
          ${err ? html`<div class="warnbox">${err}</div>` : null}
          <button class="gen-btn" disabled=${busy || code.length !== 6}>${busy ? 'Entrando...' : 'Entrar'}</button>
          <div class="row small">
            <a href="#" onClick=${e => { e.preventDefault(); setStep('email'); setErr(null) }}>Trocar e-mail</a>
            <span class="grow"></span>
            <a href="#" onClick=${e => { e.preventDefault(); sendCode() }}>Reenviar código</a>
          </div>
        </form>`}
    </section>`
}

// ------------------------------------------------------------ carteira (créditos)
export function WalletModal() {
  const s = useStore()
  const [method, setMethod] = useState('pix')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const close = () => { S.walletOpen = false; notify() }
  const packs = creditPackages()
  const buy = async p => {
    setBusy(true)
    setMsg(null)
    try {
      await api.post('/api/wallet/topup', { package_index: p.index, method })
      toast('Pedido de compra criado', 'ok')
    } catch (e) { setMsg(e.message) }
    setBusy(false)
  }
  const reserved = Number(s.wallet.reserved_credits) || 0
  const perSecond = Number(s.me?.pricing?.credits_per_second) || 0
  return html`<${Modal} title="Créditos" size="sm" onClose=${close}>
    <div class="stack" style="gap:16px">
      <div class="summary">
        <span class="label">Créditos disponíveis</span>
        <div class="summary__big"><span class="display">${num(s.wallet.balance_credits)}</span><span class="muted">${Math.abs(Number(s.wallet.balance_credits)) === 1 ? 'crédito' : 'créditos'}</span></div>
        <span class="small muted">${reserved ? `${credits(reserved)} reservados para vídeos e personagens em andamento` : `${perSecond ? `Cada segundo de vídeo usa ${credits(perSecond)}. ` : ''}Você vê o total antes de gerar, e os créditos só são descontados quando o vídeo fica pronto.`}</span>
      </div>
      ${packs.length ? html`<div class="stepbox">
        <div class="row"><span class="label grow">Comprar créditos</span>
          <${Seg} value=${method} onChange=${setMethod} options=${[{ value: 'pix', label: 'Pix' }, { value: 'card', label: 'Cartão' }]} /></div>
        <div class="row wrap" style="gap:8px">${packs.map(p => html`<button key=${p.index} class="btn btn--sm btn--butter" disabled=${busy} onClick=${() => buy(p)}
          title=${`${money(p.price_cents / p.credits)} por crédito`}>${credits(p.credits)} · ${money(p.price_cents)}</button>`)}</div>
        ${msg ? html`<div class="warnbox">${msg}</div>` : html`<span class="small dim">Os créditos entram assim que o pagamento é confirmado.</span>`}
      </div>` : null}
      <div class="stack" style="gap:6px">
        <span class="label">Extrato</span>
        ${s.entries.length
          ? html`<table class="table"><tbody>${s.entries.slice(0, 30).map(e => {
              const d = entryDelta(e)
              return html`<tr key=${e.id}>
                <td class="small dim" style="white-space:nowrap">${when(e.created_at)}</td>
                <td>${e.note}</td>
                <td class="pixel" style=${{ textAlign: 'right', whiteSpace: 'nowrap', color: d > 0 ? 'var(--mint)' : d < 0 ? 'var(--ink-2)' : 'var(--dim)' }}>${d > 0 ? '+' : ''}${cr(d || e.amount_credits)}</td>
              </tr>`
            })}</tbody></table>`
          : html`<div class="empty"><b>Nenhuma movimentação ainda</b><span>Compras, reservas e descontos de créditos aparecem aqui.</span></div>`}
      </div>
    </div>
  </${Modal}>`
}

// ------------------------------------------------------------ Configurações: sua conta
export function AccountPanel() {
  const s = useStore()
  const u = s.me?.user
  const p = s.me?.pricing || {}
  // com a conta Higgsfield própria (ou sem conta) os vídeos usam os créditos do Higgsfield: a carteira do app sai daqui
  const hfMode = s.me?.higgsfield?.mode
  const wallet = !hfMode || hfMode === 'pool'
  if (!u) return null
  return html`<section class="panel">
    <div class="panel__head"><h2 class="display panel__title">Sua conta</h2><span class="panel__hint">${u.email}</span></div>
    <div class="panel__body"><div class="keys">
      <div class="key">
        <div><div class="key__name"><span class="dot is-on"></span>${u.name || u.email}</div>
          <div class="small dim">${u.role === 'admin' ? 'administrador' : 'aluno'}</div></div>
        <div class="small muted">${wallet ? html`Créditos <b class="pixel">${num(s.wallet.balance_credits)}</b>${s.wallet.reserved_credits ? html` · <span class="dim">${num(s.wallet.reserved_credits)} reservados</span>` : null}` : 'Créditos do Higgsfield'}
          <div class="small dim">Vídeo: ${credits(p.credits_per_second)} por segundo (mínimo de ${p.min_seconds || 0} s por parte) · Personagem novo: ${credits(p.character_credits)}</div></div>
        <div class="row" style="gap:6px">
          ${wallet ? html`<button class="btn btn--sm btn--butter" onClick=${openWallet}>Créditos</button>` : null}
          <button class="btn btn--sm btn--quiet" onClick=${logout}>Sair</button>
        </div>
      </div>
      ${u.role === 'admin' ? html`<div class="small dim">${html`<${Badge} kind="4k">admin</${Badge}>`} Os painéis de contas Higgsfield, alunos e preços ficam logo abaixo.</div>` : null}
    </div></div>
  </section>`
}

// ------------------------------------------------------------ Character Online: conta Higgsfield do aluno
// Links para Configurações (Conectar, chip da barra): já estando lá, o endereço não muda e o clique não fazia nada.
// Rola até o painel do Higgsfield (nunca abre um login novo: um login aberto em outra aba seria cancelado).
const onConfig = () => typeof location !== 'undefined' && location.hash.replace(/^#\/?/, '').split('?')[0] === 'config'
export function goToHiggsfieldPanel(e) {
  if (!onConfig()) return
  e?.preventDefault?.()
  document.getElementById?.('hf-panel')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
}

// Erro da conta Higgsfield ao gerar: confere o estado de novo e guarda o saldo visto logo depois (o aviso de créditos
// some sozinho quando o saldo sobe). O 402 que traz o campo balance já vem com o texto pronto (separa o saldo do que
// está reservado para a fila, ou não separa quando a falta não vem da fila); sem ele (servidor antigo), a interface
// monta o mesmo texto com o saldo visto
export async function higgsfieldErrorState(hfe) {
  const h = (await refreshHiggsfield()) || higgsfield()
  const seen = h?.credits ?? null
  if (hfe.kind !== 'no_credits' || hfe.ready || hfe.need == null || hfe.have == null) return { ...hfe, seen }
  return { ...hfe, seen, text: noCreditsText(hfe.need, hfe.have, seen) }
}

// Cancelar um vídeo (Estúdio e Fila): pergunta antes. Na conta própria com parte já enviada, a pergunta diz que essa
// parte usa créditos da conta do aluno no Higgsfield (ela termina lá; o resto não é enviado). Outros pedidos (download,
// imagens): cancela direto, como antes.
export async function cancelJob(j) {
  if (j.kind === 'take' && !(await confirmDialog(cancelQuestion(j), { ok: 'Cancelar vídeo', no: 'Voltar' }))) return null
  return runHf(() => api.post(`/api/jobs/${j.id}/cancel`))
}

// Pedido que usa créditos fora do botão Gerar (Tentar de novo, Gerar vistas): como o run() de sempre, mas o erro da
// conta Higgsfield (sem conta, sem créditos, login vencido) vai para onHf, que mostra o aviso com o botão certo.
// Deu certo: onHf(null) tira o aviso.
export async function runHf(fn, okMsg, onHf) {
  try {
    const r = await fn()
    onHf?.(null)
    if (okMsg) toast(okMsg, 'ok')
    return r
  } catch (e) {
    const hfe = onHf ? higgsfieldErrorOf(e) : null
    if (hfe) onHf(await higgsfieldErrorState(hfe))
    else toast(e.message, 'err', 7000)
    return null
  }
}

// Atualizar saldo (avisos e painel): depois do clique o botão fica desligado por REFRESH_COOLDOWN_MS, o mesmo intervalo
// em que o servidor não confere de novo (devolve o estado com refreshed: false e 200; o 429 de um servidor antigo
// também fica quieto). onError: onde aparece o erro de verdade (padrão: aviso no canto)
export const REFRESH_COOLDOWN_MS = 15000
function useRefresh(onError = msg => toast(msg, 'err', 7000)) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  // o aviso pode sumir com a própria resposta (o saldo voltou): aí não sobra relógio para trás
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; clearTimeout(timer.current) }
  }, [])
  const run = async () => {
    if (busy || done) return
    setBusy(true)
    let ok = true
    try { await higgsfieldRefresh() } catch (e) { if (e.status !== 429) { ok = false; onError(e.message) } }
    setBusy(false)
    if (!ok || !alive.current) return
    setDone(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setDone(false), REFRESH_COOLDOWN_MS)
  }
  return { busy, done, run }
}

// Botões de um aviso do Higgsfield: Conectar (Configurações), Abrir higgsfield.ai, Assinar plano no Higgsfield (link de
// cadastro do dono), Atualizar saldo ("Já assinei, atualizar" no aviso do plano; o do teste grátis, 'trial', só abre o
// site: noticeActions)
export function HiggsfieldActions({ kind, settings = false }) {
  const r = useRefresh()
  const acts = noticeActions(kind)
  const word = kind === 'plan' || kind === 'error'
  const label = r.done ? (word ? 'Conferido agora' : 'Saldo conferido agora') : kind === 'plan' ? 'Já assinei, atualizar' : kind === 'error' ? 'Atualizar' : 'Atualizar saldo'
  return html`<span class="hf-actions">
    ${acts.includes('connect') ? html`<a class="btn btn--sm btn--butter" href="#/config" onClick=${goToHiggsfieldPanel}>Conectar</a>` : null}
    ${acts.includes('site') ? html`<a class="btn btn--sm btn--butter" href=${HIGGSFIELD_SITE} target="_blank" rel="noopener">Abrir higgsfield.ai</a>` : null}
    ${acts.includes('subscribe') ? html`<a class="btn btn--sm btn--butter" href=${higgsfieldSignupUrl(S)} target="_blank" rel="noopener">Assinar plano no Higgsfield</a>` : null}
    ${acts.includes('refresh') ? html`<button class="btn btn--sm" disabled=${r.busy || r.done} onClick=${r.run}>${label}</button>` : null}
    ${settings && !acts.includes('connect') ? html`<a class="btn btn--sm btn--quiet" href="#/config" onClick=${goToHiggsfieldPanel}>Configurações</a>` : null}
  </span>`
}

// Aviso dentro do Estúdio e do criador de personagem ({ kind, text } de higgsfieldBlock / higgsfieldErrorOf)
export function HiggsfieldWarn({ warn }) {
  if (!warn) return null
  return html`<div class="warnbox hf-warn"><span>${warn.text}</span><${HiggsfieldActions} kind=${warn.kind} settings /></div>`
}

// Faixa logo abaixo da barra do topo quando o servidor manda um aviso (me.higgsfield.notice)
// (envios recusados mesmo com saldo chegam como 'error' e ganham os botões do aviso de créditos: noticeKind)
export function HiggsfieldBand() {
  const s = useStore()
  const n = s.me?.higgsfield?.notice
  if (!n) return null
  return html`<div class=${`hfband hfband--${n.kind}`} role="status">
    <span class="hfband__text">${n.text}</span>
    <${HiggsfieldActions} kind=${noticeKind(s.me.higgsfield)} />
  </div>`
}

// Barra do topo: "Higgsfield 1.250" (conta própria) ou "Conectar Higgsfield" (sem conta); os dois abrem Configurações
export function HiggsfieldChip() {
  const s = useStore()
  const c = higgsfieldChip(s.me?.higgsfield, { sentAt: lastSentAt(s.jobs) })
  if (!c) return null
  if (c.kind === 'connect') return html`<a class="btn btn--sm btn--butter" href="#/config" title=${c.title} onClick=${goToHiggsfieldPanel}>${c.label}</a>`
  return html`<a class=${`wallet-chip ${c.warn ? 'wallet-chip--warn' : ''}`} href="#/config" title=${c.title} onClick=${goToHiggsfieldPanel}>${c.label}<b>${c.value}</b></a>`
}

// Relógio que anda a cada segundo enquanto `on` (o prazo do login). A hora é lida a cada desenho: o primeiro quadro do
// relógio já vem certo, mesmo depois de minutos esperando vaga na fila.
function useNow(on) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    tick(n => n + 1)
    const t = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [on])
  return Date.now()
}

// Login do Higgsfield aberto (painel de Configurações e tela de entrada): confere sozinho (refresh) e o relógio do prazo
// anda. A consulta sai a cada 2 s enquanto o servidor trabalha (esperando vaga, conferindo o endereço) e a cada 15 s
// com o link aberto (quem age é a pessoa, no site do Higgsfield), e também na hora em que a aba volta a aparecer
// (visibilitychange, focus). Login pela CLI (method 'cli'): quem foi embora com ele aberto cancela, para a vaga do
// corretor (poucas, divididas por todos) não ficar presa até o prazo: fechar a aba (pagehide) chama leave(login), sem
// esperar resposta; a tela sumir (sair de Configurações) chama cancel(login). Logo depois de clicar em "Abrir login do
// Higgsfield" (opened) não: alguns navegadores (os de dentro de app) abrem o link nesta mesma aba. Login pelo navegador
// (pkce, ou sem o campo method): não ocupa vaga e fica aberto, para a pessoa terminar em outra aba ou depois de voltar
// de outro app (a tela nova retoma pelo GET /api/auth/higgsfield/open).
function useLoginWatch(login, { refresh, leave, cancel }) {
  const open = login && OPEN_LOGIN.includes(login.status) ? login : null
  const fns = useRef(null)
  fns.current = { refresh, leave, cancel }
  const every = open ? loginPollMs(open) : 0
  // logo no desenho (useLayoutEffect): o intervalo novo vale assim que o passo muda (o useEffect do Preact sem
  // requestAnimationFrame só roda 100 ms depois)
  useLayoutEffect(() => {
    if (!open) return
    const t = setInterval(() => fns.current.refresh(), every)
    return () => clearInterval(t)
  }, [open?.id, every])
  const waiting = open?.status === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const onBack = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') fns.current.refresh() }
    if (typeof window !== 'undefined') window.addEventListener?.('focus', onBack)
    if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onBack)
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener?.('focus', onBack)
      if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onBack)
    }
  }, [waiting])
  const now = useNow(waiting)
  const current = useRef(null)
  const openedAt = useRef(0)
  current.current = open
  useEffect(() => {
    const onHide = () => { if (cliLogin(current.current) && Date.now() - openedAt.current > 5000) fns.current.leave(current.current) }
    if (typeof window !== 'undefined') window.addEventListener?.('pagehide', onHide)
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener?.('pagehide', onHide)
      if (cliLogin(current.current)) fns.current.cancel(current.current)
    }
  }, [])
  return { now, opened: () => { openedAt.current = Date.now() } }
}

// Ações de um painel com um botão de cada vez: erro da API vira a mensagem do painel. Devolve true quando deu certo.
function useAct(busy, setBusy, setErr) {
  return async fn => {
    if (busy) return false
    setBusy(true)
    setErr(null)
    let ok = true
    try { await fn() } catch (e) { setErr(e.message); ok = false }
    setBusy(false)
    return ok
  }
}

// Campo de colar o endereço da página que não abre (passo 2 do login aberto e login de entrada vencido): Colar (lê a
// área de transferência, só quando o navegador tem essa função), colar no campo um texto que já tem o endereço envia
// sozinho, e Concluir. onPaste(endereço) devolve true quando o servidor aceitou (o campo limpa); onBad(texto) mostra o
// erro que a tela já sabe sem perguntar ao servidor (endereço do site do Higgsfield, área de transferência negada).
// Quem usa passa key = id do login: outro login começa com o campo vazio.
function CallbackPaste({ busy, onPaste, onBad }) {
  const [value, setValue] = useState('')
  const pasting = useRef(false)
  const send = async url => {
    let v = String(url || '').trim()
    if (!v) {
      onBad?.('Cole o endereço do login (começa com localhost:3334/callback) ou seu token.')
      return
    }
    try { v = callbackUrl(v) } catch (x) { onBad?.(x.message); return }
    if (v && (await onPaste(v))) setValue('')
  }
  const finish = e => {
    e?.preventDefault()
    if (!busy && value.trim()) send(value)
  }
  // colou (menu do navegador, Ctrl+V) um texto com o endereço: envia sem esperar o Concluir; digitar não envia
  const input = e => {
    const v = e.target.value
    const pasted = pasting.current || e.inputType === 'insertFromPaste'
    pasting.current = false
    setValue(v)
    if (pasted && !busy && hasCallbackUrl(v)) send(v)
  }
  const clip = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
  const paste = async () => {
    let t = ''
    try { t = String((await navigator.clipboard.readText()) ?? '') } catch {
      onBad?.('Não consegui ler o endereço copiado. Toque e segure o campo e escolha Colar.')
      return
    }
    setValue(t)
    if (t.trim()) send(t)
  }
  return html`<form class="row hf-login__paste" onSubmit=${finish} style="gap:6px">
    <input class="input input--sm grow" spellcheck="false" autocomplete="off" placeholder="Cole o link do callback (127.0.0.1:3334/callback?code=...) ou seu Token/API Key" value=${value}
      onPaste=${() => { pasting.current = true }} onInput=${input} />
    ${clip ? html`<button type="button" class="btn btn--sm" disabled=${busy} onClick=${paste}>Colar</button>` : null}
    <button class="btn btn--sm btn--primary" disabled=${busy || !value.trim()}>Concluir</button>
  </form>`
}

// Passos do login do Higgsfield aberto (painel de Configurações e tela de entrada): esperando vaga (posição na fila),
// abrir o login, colar o endereço que não abre (CallbackPaste), prazo e Cancelar. O relógio só aparece nos últimos
// minutos (loginClockOn): antes, o texto do prazo basta e não apressa quem precisa criar a conta ou assinar um plano.
// O texto conta o que falta de login.expiresAt (loginTimeText): o login retomado depois não diz 30 minutos de novo.
// doneHint = o que acontece quando o login termina sozinho na mesma máquina; verb = o que a fila diz que muita gente
// está fazendo ("conectando" no painel, "entrando" na tela de entrada).
function HiggsfieldLoginSteps({ login, now, busy, onOpen, onPaste, onBad, onCancel, doneHint, verb = 'conectando' }) {
  // no app online o passo de colar o endereço é o caminho normal: o retorno do Higgsfield vai para "localhost",
  // que no navegador do aluno é o computador (ou celular) dele, e a página não abre
  const waiting = login.status === 'waiting' && login.authorizeUrl
  const queued = loginQueueText(login)
  const clock = waiting && loginClockOn(login.expiresAt, now) ? loginCountdown(login.expiresAt, now) : null
  const help = copyHelp(typeof navigator !== 'undefined' ? navigator.userAgent : '')
  return html`<div class="stepbox hf-login">
    ${waiting ? html`
      <div class="hf-login__step"><span class="step-num">1</span>
        <span class="grow">Clique em Abrir login do Higgsfield para conectar sua conta real (se você já estiver logado, a conexão é direta).</span>
        <a class="btn btn--sm btn--butter" href=${login.authorizeUrl} target="_blank" rel="noopener" onClick=${onOpen}>Abrir login do Higgsfield</a></div>
      <div class="hf-login__step"><span class="step-num">2</span>
        <span class="grow">Após autorizar no Higgsfield, a página conecta automaticamente. Se a janela não fechar, copie o endereço dela (começa com 127.0.0.1:3334) ou seu Token e clique em Concluir:</span></div>
      ${help.map(t => html`<span class="small dim hf-login__help">${t}</span>`)}
      <${CallbackPaste} key=${login.id} busy=${busy} onPaste=${onPaste} onBad=${onBad} />
      <span class="small dim">${doneHint}</span>`
    : html`<div class="row"><${Spinner} /><span class="small muted">${login.status === 'completing' ? 'Conferindo o login no Higgsfield...' : queued ? `Muita gente ${verb} agora. ${queued}` : 'Preparando o login do Higgsfield...'}</span></div>
      ${queued ? html`<span class="small dim">Deixe esta página aberta: o login abre aqui sozinho quando chegar a sua vez.</span>` : null}`}
    <div class="row hf-login__time">
      <span class="small dim grow">${waiting ? loginTimeText(login, now) : ''}</span>
      ${clock ? html`<b class="pixel hf-login__clock" title="Tempo que falta para entrar">${clock}</b>` : null}
      <button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${onCancel}>Cancelar</button>
    </div>
  </div>`
}

// Configurações: conectar a conta Higgsfield do aluno (login do Higgsfield em outra aba), saldo e desconectar
export function HiggsfieldPanel() {
  const s = useStore()
  const h = s.me?.higgsfield
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const step = higgsfieldStep(h)
  const login = step === 'login' ? h.login : null
  useEffect(() => { setErr(null) }, [login?.id])
  // login aberto: confere sozinho (quando o Higgsfield devolve o login, o painel passa para conectado); com o login
  // pela CLI, sair de Configurações ou fechar a aba cancela o login (depois de sair da conta a sessão já não vale); o
  // login pelo navegador (pkce) fica aberto para a pessoa voltar
  const { now, opened } = useLoginWatch(login, {
    refresh: refreshHiggsfield,
    leave: higgsfieldLeave,
    cancel: l => { if (S.auth === 'ok') higgsfieldCancel(l.id).catch(() => null) },
  })
  const act = useAct(busy, setBusy, setErr)
  const refresh = useRefresh(setErr)
  if (!h) return null

  const connect = () => act(higgsfieldConnect)
  const disconnect = async () => {
    if (await confirmDialog('Desconectar sua conta Higgsfield? Os próximos vídeos e personagens só saem depois de conectar de novo.', { ok: 'Desconectar' })) act(higgsfieldDisconnect)
  }
  const failed = loginErrorText(h.login)
  const hint = h.mode === 'own' ? 'seus créditos' : h.mode === 'pool' ? 'contas do app' : 'não conectada'

  let body
  if (step === 'login') {
    body = html`<${HiggsfieldLoginSteps} login=${login} now=${now} busy=${busy} onOpen=${opened}
      onPaste=${url => act(() => higgsfieldCallback(login.id, url))} onBad=${setErr} onCancel=${() => act(() => higgsfieldCancel(login.id))}
      doneHint="Se aqui aparecer a conta conectada sozinha, pode fechar aquela página." />`
  } else if (step === 'connected') {
    const on = h.status === 'active'
    // o plano da conta no Higgsfield (Free, Starter, Plus...), quando o servidor sabe
    const plan = planText(h.plan)
    const onEditBalance = async () => {
      const val = prompt('Informe o saldo real de créditos da sua conta no Higgsfield (ou cole o token de sessão):', String(h.credits ?? ''));
      if (val !== null && val.trim() !== '') {
        const trimmed = val.trim();
        const numCredits = Number(trimmed.replace(/[^0-9]/g, ''));
        if (!isNaN(numCredits) && !trimmed.startsWith('ey') && !trimmed.startsWith('oat_')) {
          await api.post('/api/higgsfield/refresh', { credits: numCredits });
          toast(`Saldo atualizado para ${num(numCredits)} créditos!`, 'ok');
        } else {
          await api.post('/api/higgsfield/refresh', { token: trimmed });
          toast('Consultando saldo no Higgsfield...', 'info');
        }
        refresh.run();
      } else {
        refresh.run();
      }
    };

    body = html`<div class="key">
      <div><div class="key__name"><span class=${`dot ${on ? 'is-on' : ''}`}></span><span class="ellipsis">${h.email || 'Conta conectada'}</span></div>
        <div class="small dim">${higgsfieldStatusText(h)}</div>
        ${plan ? html`<div class="small dim hf-plan">Plano: ${plan}</div>` : null}</div>
      <div class="small muted">Créditos <b class="pixel" style="cursor:pointer;text-decoration:underline dotted" onClick=${onEditBalance} title="Clique para editar ou conferir seu saldo real">${h.credits == null ? '?' : num(h.credits)}</b>
        <div class="small dim">Os vídeos e personagens usam os créditos desta conta.${h.checkedAt ? ` Saldo conferido ${ago(h.checkedAt)}.` : ''}</div></div>
      <div class="row" style="gap:6px">
        ${h.status === 'auth_error' ? html`<button class="btn btn--sm btn--butter" disabled=${busy} onClick=${connect}>Conectar de novo</button>` : null}
        <button class="btn btn--sm" disabled=${busy || refresh.busy} onClick=${onEditBalance} title="Clique para atualizar ou ajustar seu saldo real">${refresh.done ? 'Saldo conferido agora' : 'Atualizar saldo'}</button>
        <button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${disconnect}>Desconectar</button>
      </div>
    </div>`
  } else {
    body = html`<div class="key">
      <div><div class="key__name"><span class="dot"></span>Sua conta Higgsfield</div><div class="small dim">não conectada</div></div>
      <div class="small muted">${h.mode === 'pool'
        ? 'Hoje você gera pelas contas do app. Conecte a sua conta Higgsfield para gerar com os créditos dela.'
        : 'Você gera vídeos e personagens na sua própria conta do Higgsfield, com os seus créditos. Conecte uma vez e pronto.'}</div>
      <div class="row"><button class="btn btn--sm btn--butter" disabled=${busy} onClick=${connect}>${step === 'failed' ? 'Tentar de novo' : 'Conectar minha conta Higgsfield'}</button></div>
    </div>`
  }

  // login que falhou: com a conta já funcionando (o aluno conectou depois), o aviso velho não aparece; com o login
  // vencido, o motivo fica ao lado do botão "Conectar de novo"
  const showFailed = failed && step !== 'login' && (step !== 'connected' || h.status === 'auth_error')
  // a conta conectada aqui também abre esta conta do Character pelo "Entrar com o Higgsfield": conectada outra que não a
  // da entrada, a linha diz com qual a pessoa entra; sem conta (ou com Conectar de novo), pede para conectar só a dela
  const note = higgsfieldSigninNote(h, s.me?.user?.email)
  // sem conta conectada (e sem login aberto): o link para criar a conta no Higgsfield, antes do Conectar
  const signup = step === 'none' || step === 'failed'
  return html`<section class="panel" id="hf-panel">
    <div class="panel__head"><h2 class="display panel__title">Higgsfield</h2><span class="panel__hint">${hint}</span></div>
    <div class="panel__body"><div class="keys">
      ${signup ? html`<${HiggsfieldSignupStep} />` : null}
      ${body}
      ${note ? html`<div class="small dim hf-note">${note}</div>` : null}
      ${showFailed ? html`<div class="warnbox">${failed}</div>` : null}
      ${err ? html`<div class="warnbox">${err}</div>` : null}
    </div></div>
  </section>`
}
