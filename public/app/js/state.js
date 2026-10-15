// Estado global da interface + atualização ao vivo pelo servidor (SSE).
import { useEffect, useReducer, useRef } from 'preact/hooks'
import { api, onAuthLost } from './api.js'
import { validPackages, higgsfieldReady, OPEN_LOGIN, emailLoginOn, sameEmail, enteredText } from './cloud.js'

export const S = {
  ready: false,
  error: null,
  // Character Online: sessão do aluno e carteira
  auth: null, // null = conferindo a sessão, 'login' = tela de entrada, 'ok' = dentro do app
  loginError: null,
  emailLogin: false, // a entrada também mostra o código por e-mail (só quando o servidor diz que está ligado)
  signin: null, // login de entrada pelo Higgsfield ({ id, status, authorizeUrl, callbackPort, expiresAt, queuePosition, error })
  me: null, // GET /api/me: { user, wallet, limits, pricing, features, credit_packages, higgsfield, paywall }
  paywallOpen: null, // aviso de pagamento da hospedagem aberto ({ text, checkoutUrl, priceLabel, locked }; views/paywall.js)
  wallet: { balance_credits: 0, reserved_credits: 0 }, // em créditos (1 crédito do app = 1 crédito do Higgsfield)
  entries: [], // extrato recente (GET /api/wallet)
  packages: null, // pacotes de créditos de GET /api/wallet ({ credits, price_cents }); sem eles, vale me.credit_packages
  walletOpen: false,
  characters: [],
  projects: [], // pastas de projeto
  paused: {}, // provedores pausados por falta de créditos: { hfcli: { at, reason } }
  clips: [],
  jobs: [],
  models: [],
  providers: [],
  settings: {},
  templates: {},
  spend: { today: 0, month: 0, total: 0 },
  toasts: [],
  lightbox: null,
  confirm: null,
  uploads: [], // { id, name, progress, error }
}

const subs = new Set()
let scheduled = false
export function notify() {
  if (scheduled) return
  scheduled = true
  // microtask (e não requestAnimationFrame/setTimeout): o navegador não segura isso com a aba em segundo plano
  queueMicrotask(() => { scheduled = false; for (const f of subs) f() })
}

// Inscreve já no primeiro render (e não num useEffect): numa aba em segundo plano os efeitos do Preact
// atrasam até 1 min e a tela ficava presa em "carregando" mesmo com os dados prontos.
export function useStore() {
  const [, force] = useReducer(x => x + 1, 0)
  const ref = useRef(null)
  if (!ref.current) { ref.current = force; subs.add(force) }
  useEffect(() => () => subs.delete(ref.current), [])
  return S
}

// /api/state traz "me" achatado ({ id, email, role, wallet, pricing... }); as telas usam o formato de /api/me ({ user, ... })
const meOf = m => (!m ? null : m.user ? m : { user: { id: m.id, email: m.email, name: m.name, role: m.role }, wallet: m.wallet, pricing: m.pricing, limits: m.limits, features: m.features, credit_packages: m.credit_packages, higgsfield: m.higgsfield, paywall: m.paywall })

export async function load() {
  try {
    const state = await api.get('/api/state')
    // sem sessão, o servidor pode responder 200 dizendo qual entrada mostrar ({ auth: 'login', login_methods })
    if (state?.auth === 'login' && !state.me) { signedOut(null, state); return }
    const me = meOf(state.me) || await api.get('/api/me')
    Object.assign(S, state, { ready: true, error: null, auth: 'ok', loginError: null, me, wallet: me.wallet ? walletOf(me.wallet) : S.wallet })
    rememberSignin(null) // dentro do app: não há login de entrada para retomar depois de sair
    syncHiggsfieldModels()
    connect()
  } catch (e) {
    // sem sessão (ou acesso bloqueado): tela de entrada (a resposta diz se o código por e-mail está ligado)
    if (e.status === 401 || e.status === 403) { signedOut(e.status === 403 ? e.message : null, e.data); return }
    S.error = e.message
  }
  notify()
}

function upsert(list, item) {
  const i = list.findIndex(x => x.id === item.id)
  if (i >= 0) list[i] = item
  else list.unshift(item)
}

// Character Online: o job que a rota acabou de devolver entra já na lista (o criador mostra o pedido sem esperar o
// evento ao vivo); se o evento chegou antes, fica o dele, que é mais novo
export function upsertJob(job) {
  if (!job?.id || S.jobs.some(j => j.id === job.id)) return
  S.jobs = [job, ...S.jobs]
  notify()
}
export function dropJob(id) {
  S.jobs = S.jobs.filter(j => j.id !== id)
  notify()
}

let lastError = false
let es = null
let takePoll = null
let pollingTakes = false
async function pollRunningTakes() {
  if (pollingTakes || S.auth !== 'ok') return
  const active = S.jobs.filter(job => job.kind === 'take' && job.status === 'running' && job.providerRequestId)
  if (!active.length) return
  pollingTakes = true
  try {
    for (const job of active) {
      try {
        const updated = await api.get(`/api/jobs/${encodeURIComponent(job.id)}/status`)
        apply({ type: 'job', item: updated })
      } catch {}
    }
    notify()
  } finally { pollingTakes = false }
}
export function connect() {
  if (es) return
  es = new EventSource('/api/events')
  if (!takePoll) takePoll = setInterval(pollRunningTakes, 8000)
  es.onopen = () => { if (lastError) { lastError = false; load() } }
  es.onerror = () => { lastError = true }
  es.onmessage = e => {
    const d = JSON.parse(e.data)
    for (const ev of d.events || []) apply(ev)
    if (d.spend) S.spend = d.spend
    notify()
  }
  // Character Online: a hospedagem mudou (galeria fechou, pagamento confirmado ou desfeito, admin liberou): o aviso vem
  // pelo quadro nomeado "v2" ({ type: 'paywall' }) e o estado inteiro recarrega (os vídeos prontos ganham ou perdem o link)
  es.addEventListener?.('v2', e => {
    let d = null
    try { d = JSON.parse(e.data) } catch {}
    if (d?.type === 'paywall') load()
  })
}

function apply({ type, item }) {
  if (type === 'job') {
    const prev = S.jobs.find(j => j.id === item.id)
    upsert(S.jobs, item)
    if (prev && prev.status !== item.status) onJobStatus(item)
  } else if (type === 'job:removed') S.jobs = S.jobs.filter(j => j.id !== item.id)
  else if (type === 'character') upsert(S.characters, item)
  else if (type === 'character:removed') S.characters = S.characters.filter(c => c.id !== item.id)
  else if (type === 'project') { const i = S.projects.findIndex(p => p.id === item.id); if (i >= 0) S.projects[i] = item; else S.projects.push(item) }
  else if (type === 'paused') S.paused = item.data || {}
  else if (type === 'project:removed') S.projects = S.projects.filter(p => p.id !== item.id)
  else if (type === 'clip') upsert(S.clips, item)
  else if (type === 'clip:removed') S.clips = S.clips.filter(c => c.id !== item.id)
  else if (type === 'wallet') { S.wallet = walletOf(item); if (S.walletOpen) refreshWallet() }
  else if (type === 'settings') { const { id, ...rest } = item; S.settings = rest }
  else if (type === 'higgsfield') { if (item?.mode) setHiggsfield(item); else refreshHiggsfield() }
}

// ------------------------------------------------------------ Character Online: sessão e carteira
// data: resposta do servidor sem sessão (diz se o código por e-mail está ligado); sem ela (sair, sessão vencida), vale
// o me.features de quem estava dentro
export function signedOut(message = null, data = null) {
  es?.close()
  es = null
  if (takePoll) clearInterval(takePoll)
  takePoll = null
  lastError = false
  const emailLogin = data ? emailLoginOn(data) : S.me ? emailLoginOn({ features: S.me.features }) : S.emailLogin
  Object.assign(S, {
    // links: o link de cadastro no Higgsfield da etapa 1, que vem no corpo 401 do GET /api/state
    links: data?.links || S.links || null,
    auth: 'login', ready: false, error: null, loginError: message, me: null, emailLogin, signin: null, paywallOpen: null,
    wallet: { balance_credits: 0, reserved_credits: 0 }, entries: [], packages: null, walletOpen: false,
    characters: [], projects: [], clips: [], jobs: [], uploads: [], spend: { today: 0, month: 0, total: 0 },
  })
  notify()
}

export async function logout() {
  // Character Online: login do Higgsfield aberto é cancelado antes (depois de sair a sessão já não vale)
  const open = openHiggsfieldLogin()
  if (open) await api.post(`/api/higgsfield/connect/${open.id}/cancel`).catch(() => null)
  try { await api.post('/api/auth/logout') } catch {}
  signedOut()
}

onAuthLost(() => {
  if (S.auth !== 'ok') return
  signedOut()
  toast('Sua sessão terminou. Entre de novo para continuar.', 'info', 7000)
})

// carteira em créditos (o evento ao vivo e as rotas mandam { balance_credits, reserved_credits })
const walletOf = w => ({ balance_credits: Number(w?.balance_credits) || 0, reserved_credits: Number(w?.reserved_credits) || 0 })

export async function refreshWallet() {
  try {
    const w = await api.get('/api/wallet')
    S.wallet = walletOf(w.wallet)
    S.entries = w.entries || []
    if (Array.isArray(w.credit_packages)) S.packages = w.credit_packages
    notify()
  } catch {}
}

// Pacotes de créditos à venda (preço em centavos de real); lista vazia = a compra fica escondida
export const creditPackages = () => validPackages(S.packages ?? S.me?.credit_packages)

// Créditos de um modelo do catálogo (se o catálogo não trouxer, vale o preço da conta em me.pricing)
export const modelCreditsPerSecond = m => Number(m?.credits_per_second ?? S.me?.pricing?.credits_per_second) || 0
export const modelCharacterCredits = m => Number(m?.character_credits ?? S.me?.pricing?.character_credits) || 0
// Créditos de UMA imagem do GPT Image (uma opção do card ou uma vista para vídeo): o catálogo manda unitPrice
export const modelImageCredits = m => Number(m?.unitPrice ?? S.me?.pricing?.character_image_credits) || 0

export function openWallet() {
  S.walletOpen = true
  notify()
  refreshWallet()
}

export const isAdmin = () => S.me?.user?.role === 'admin'

// ------------------------------------------------------------ Character Online: conta Higgsfield do aluno
// me.higgsfield vem no GET /api/state, nas rotas /api/higgsfield (todas devolvem o mesmo objeto) e no evento ao vivo
// { type: 'higgsfield' }. Formato em cloud.js; regras em docs/conta-propria-higgsfield.md.
export const higgsfield = () => S.me?.higgsfield || null
export const ownHiggsfield = () => higgsfield()?.mode === 'own'

// O catálogo marca o Higgsfield como pronto só quando dá para gerar (mesma regra do servidor): muda junto com a conta
function syncHiggsfieldModels() {
  const h = higgsfield()
  if (!h) return
  const ok = higgsfieldReady(h)
  if (S.models.some(m => m.provider === 'hfcli' && m.configured !== ok)) S.models = S.models.map(m => (m.provider === 'hfcli' ? { ...m, configured: ok } : m))
  if (S.providers.some(p => p.id === 'hfcli' && p.configured !== ok)) S.providers = S.providers.map(p => (p.id === 'hfcli' ? { ...p, configured: ok } : p))
}

// quiet: sem o aviso de "conectada" (o próprio aluno cancelou o login)
export function setHiggsfield(h, { quiet = false } = {}) {
  if (!S.me || !h || typeof h !== 'object' || !h.mode) return
  const prev = S.me.higgsfield
  const { id, ...next } = h
  // a ficha de cancelar o login (login.cancelToken) vem no GET /api/state e nas rotas /api/higgsfield; o estado sem ela
  // (evento ao vivo), do mesmo login, fica com a última que chegou
  if (next.login && prev?.login?.id === next.login.id && next.login.cancelToken === undefined && prev.login.cancelToken) {
    next.login = { ...next.login, cancelToken: prev.login.cancelToken }
  }
  S.me = { ...S.me, higgsfield: next }
  syncHiggsfieldModels()
  // o login terminou e a conta funciona: aviso de conectada. O login que falhou ou venceu continua em next.login
  // (com o mesmo id); cancelar ou vencer a reconexão de uma conta com o login vencido deixa a conta em auth_error.
  const was = prev?.login && OPEN_LOGIN.includes(prev.login.status) ? prev.login : null
  const closed = was && (!next.login || next.login.status === 'done' || (next.login.id !== was.id && !OPEN_LOGIN.includes(next.login.status)))
  if (closed && !quiet && next.connected && next.status !== 'auth_error' && next.status !== 'disabled') {
    toast(next.email ? `Conta Higgsfield conectada: ${next.email}` : 'Conta Higgsfield conectada', 'ok', 6000)
  }
  notify()
}

async function higgsfieldCall(method, url, body, opts) {
  const h = method === 'get' ? await api.get(url) : await api.post(url, body)
  setHiggsfield(h, opts)
  return h
}
// recarrega me.higgsfield (o painel chama a cada 2 s durante o login); falha de rede fica quieta
export const refreshHiggsfield = () => higgsfieldCall('get', '/api/higgsfield').catch(() => null)
// ações do painel: erro (4xx) volta como exceção com a mensagem pronta da API
export const higgsfieldConnect = () => higgsfieldCall('post', '/api/higgsfield/connect')
export const higgsfieldCallback = (id, url) => higgsfieldCall('post', `/api/higgsfield/connect/${id}/callback`, { url })
export const higgsfieldCancel = id => higgsfieldCall('post', `/api/higgsfield/connect/${id}/cancel`, {}, { quiet: true })
export const higgsfieldRefresh = () => higgsfieldCall('post', '/api/higgsfield/refresh')
export const higgsfieldDisconnect = () => higgsfieldCall('post', '/api/higgsfield/disconnect')

// Login aberto (ou null)
export const openHiggsfieldLogin = () => { const l = higgsfield()?.login; return l && OPEN_LOGIN.includes(l.status) ? l : null }

// Fechar a aba com o login aberto: cancela sem esperar a resposta, para a vaga do login do Higgsfield (são poucas,
// divididas por todos os alunos) não ficar presa até o prazo. navigator.sendBeacon (feito para a página fechando): não
// manda cabeçalho próprio, por isso vai com a ficha do login na query (?t=login.cancelToken; a rota confere a ficha, a
// sessão e a origem). Sem a ficha ou sem sendBeacon: fetch com keepalive e o X-Character de sempre.
// O mesmo para o login de entrada (signinLeave), sem sessão: o servidor confere o cookie deste navegador.
export const higgsfieldLeave = login => leaveLogin(login, login?.id && `/api/higgsfield/connect/${login.id}/cancel`)
export const signinLeave = login => leaveLogin(login, login?.id && `/api/auth/higgsfield/${login.id}/cancel`)
function leaveLogin(login, url) {
  if (!login?.id) return
  try {
    if (login.cancelToken && typeof navigator !== 'undefined' && navigator.sendBeacon?.(`${url}?t=${encodeURIComponent(login.cancelToken)}`, '{}')) return
  } catch {}
  try { fetch(url, { method: 'POST', keepalive: true, headers: { 'X-Character': '1', 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}) } catch {}
}

// ------------------------------------------------------------ Character Online: entrar com o Higgsfield
// Sem sessão, a entrada é o login do Higgsfield (o mesmo do painel de Configurações) pelas rotas /api/auth/higgsfield,
// com o login no mesmo formato de me.higgsfield.login. O servidor amarra o login a este navegador (cookie próprio):
// quando ele termina, o GET deste navegador abre a sessão (signedIn: true) e o app carrega, já com a conta conectada.
// O id fica guardado nesta aba (sessionStorage): voltar para a aba depois que um navegador de dentro de app abriu o
// Higgsfield nela mesma retoma o mesmo login. O login pelo navegador (pkce) fica aberto ao recarregar, fechar ou abrir
// outra aba: a aba nova retoma pelo GET /api/auth/higgsfield/open (signinResume). Só o login pela CLI cancela ao
// recarregar ou fechar a aba (pagehide, ver useLoginWatch), e a tela avisa ao retomar (signinRefresh).
const SIGNIN_KEY = 'character.signin'
const rememberSignin = id => { try { if (id) sessionStorage.setItem(SIGNIN_KEY, id); else sessionStorage.removeItem(SIGNIN_KEY) } catch {} }
const rememberedSignin = () => { try { return sessionStorage.getItem(SIGNIN_KEY) } catch { return null } }

// Login de entrada aberto (ou null)
export const openSignin = () => (S.signin && OPEN_LOGIN.includes(S.signin.status) ? S.signin : null)

let entering = false
// ações da pessoa (começar, colar, cancelar): a consulta que saiu antes de uma delas chega velha e não vale
let actions = 0
// quiet: a tela só retomando o login guardado (sem o aviso de entrada que não abriu)
async function setSignin(r, { fromGet = false, quiet = false } = {}) {
  const login = r?.login || null
  if (r?.signedIn || login?.status === 'done') {
    // terminou: a sessão vem no cookie da resposta do GET deste navegador; carrega o app uma vez só
    const id = login?.id || S.signin?.id
    S.signin = null
    rememberSignin(null)
    if (entering) return r
    entering = true
    let why = null
    let g = null
    try {
      // terminou numa resposta que não abre a sessão (colar o endereço, cancelar no último segundo): o GET abre
      if (!r.signedIn && !fromGet && id) g = await api.get(`/api/auth/higgsfield/${id}`).catch(e => { if (e.status === 403) why = e.message; return null })
      await load()
      // created (conta do app criada agora) só vem na resposta que abriu a sessão
      const opened = r.signedIn ? r : g?.signedIn ? g : null
      if (S.auth === 'ok') entered({ created: opened?.created === true, kept: g?.login?.error || login?.error })
      else if (why || !quiet) {
        S.loginError = why || 'O login no Higgsfield terminou, mas a entrada não abriu. Clique em Entrar com o Higgsfield de novo.'
      }
    } finally {
      entering = false
      notify()
    }
    return r
  }
  // a ficha de cancelar (sendBeacon): uma resposta sem ela, do mesmo login, fica com a última que chegou
  const prev = S.signin
  S.signin = login && prev?.id === login.id && login.cancelToken === undefined && prev.cancelToken ? { ...login, cancelToken: prev.cancelToken } : login
  rememberSignin(login && OPEN_LOGIN.includes(login.status) ? login.id : null)
  notify()
  return r
}

// Entrou: o aviso fala da conta com que a pessoa entrou (a identidade, me.user.email); conta do app criada agora
// (created), o aviso diz isso, para quem já usava o Character com outra conta Higgsfield sair e entrar com ela (texto em
// cloud.js). Trocou de conta com vídeos ainda sendo gerados na conta conectada (o corretor mantém a conectada até eles
// terminarem): o servidor manda o aviso no login.error do login terminado (kept); sem ele (a sessão veio por outra aba,
// por exemplo), o mesmo aviso quando a conta conectada não é a da entrada.
function entered({ created = false, kept = null } = {}) {
  const who = S.me?.user?.email
  const hf = higgsfield()?.email
  toast(enteredText(who, created), 'ok', created ? 12000 : 6000)
  const other = who && hf && !sameEmail(hf, who)
  const warn = kept || (other ? `A conta Higgsfield conectada para gerar continua sendo ${hf}, e os próximos vídeos usam os créditos dela. Para gerar com a ${who}, conecte essa conta em Configurações depois que os vídeos em andamento terminarem.` : null)
  if (warn) toast(warn, 'warn', 15000)
  // a conta está num plano do Higgsfield que não gera por aplicativos (plano grátis, teste grátis): avisa logo na entrada
  const plan = higgsfield()?.notice
  if (plan?.kind === 'plan' && plan.text) toast(plan.text, 'warn', 15000)
}

// Login que este navegador não acha mais (404: outra aba começou outro login e trocou o cookie, ou é de outro
// navegador) ou acesso recusado no fim (403: bloqueado): volta para o botão de entrar, com o aviso. Devolve true quando
// era isso. quiet: sem o aviso de outra aba (cancelar, ou a tela só retomando o login guardado).
function signinGone(id, e, { quiet = false } = {}) {
  if (e?.status !== 404 && e?.status !== 403) return false
  if (S.signin && S.signin.id !== id) return true
  const lost = S.signin?.id === id
  S.signin = null
  rememberSignin(null)
  if (e.status === 403) S.loginError = e.message
  else if (lost && !quiet) S.loginError = 'Este login foi aberto em outra aba ou em outro navegador. Clique em Entrar com o Higgsfield para começar de novo.'
  notify()
  return true
}

// ações da tela de entrada: erro (4xx) volta como exceção com a mensagem pronta da API (menos o login perdido, acima).
// Começar com um login ainda aberto neste navegador (outra aba, ou o mesmo clicado de novo): o servidor devolve esse
// mesmo login (resumed: true), sem cancelar nada, e o aviso diz para terminar por aqui
export const SIGNIN_RESUMED = 'Seu login com o Higgsfield continua aberto: termine por aqui.'
export async function signinStart() {
  actions++
  const r = await api.post('/api/auth/higgsfield/start')
  S.loginError = null
  if (r?.resumed === true && r.login) toast(SIGNIN_RESUMED, 'info', 7000)
  return setSignin(r)
}
export async function signinCallback(id, url) {
  actions++
  try { return await setSignin(await api.post(`/api/auth/higgsfield/${id}/callback`, { url })) } catch (e) { if (e.status === 404 && signinGone(id, e)) return null; throw e }
}
export async function signinCancel(id) {
  actions++
  try { return await setSignin(await api.post(`/api/auth/higgsfield/${id}/cancel`, {})) } catch (e) { if (e.status === 404 && signinGone(id, e, { quiet: true })) return null; throw e }
}

// Confere o login de entrada (a tela chama a cada 2 s; vale como sinal de vida para o servidor). Uma consulta por vez; a
// resposta de um login que já foi trocado por outro, ou que saiu antes de a pessoa agir (Cancelar, colar o endereço),
// não vale: a próxima consulta traz o estado novo. Falha de rede fica quieta. A consulta que não volta (conexão presa)
// é cortada depois de SIGNIN_CHECK_MS, para não segurar as próximas; o prazo é folgado porque é o GET do login
// terminado que traz o cookie da sessão, entregue uma vez só.
export const SIGNIN_CHECK_MS = 30000
export const SIGNIN_CLOSED = 'O login anterior foi cancelado quando a página fechou ou recarregou. Clique em Entrar com o Higgsfield para começar de novo.'
let checking = false
export async function signinRefresh(id = S.signin?.id, { resume = false } = {}) {
  if (!id || checking || entering) return null
  checking = true
  const seen = actions
  const ctl = typeof AbortController === 'function' ? new AbortController() : null
  const cut = ctl && setTimeout(() => ctl.abort(), SIGNIN_CHECK_MS)
  try {
    const r = await api.get(`/api/auth/higgsfield/${id}`, { signal: ctl?.signal })
    if ((S.signin && S.signin.id !== id) || seen !== actions) return null
    // resposta sem o login (corpo cortado no meio): não vale, a próxima consulta traz o estado
    if (!r?.login && !r?.signedIn) return null
    // retomando: o login guardado foi cancelado ao fechar ou recarregar a página (pagehide), não pela pessoa
    if (resume && r.login?.status === 'canceled') S.loginError = SIGNIN_CLOSED
    return await setSignin(r, { fromGet: true, quiet: resume })
  } catch (e) {
    if (seen === actions) signinGone(id, e)
    return null
  } finally {
    clearTimeout(cut)
    checking = false
  }
}

// Tela de entrada aberta: retoma o login guardado nesta aba (recarregou ou voltou do Higgsfield). Fechar ou recarregar
// a aba com o login aberto pela CLI manda cancelar (pagehide, menos logo depois de abrir o link nela mesma): retomar
// um login cancelado assim mostra o aviso SIGNIN_CLOSED, com o botão de começar de novo. Sem login guardado nesta aba
// (aba nova, outro app que abriu o link): pergunta ao servidor pelo login aberto deste navegador (GET
// /api/auth/higgsfield/open, pelo cookie) e retoma o que vier, quieto: aberto (os passos) ou que falhou ou venceu há
// pouco (o motivo e o campo de colar o endereço)
export function signinResume() {
  if (S.signin) return null
  const id = rememberedSignin()
  return id ? signinRefresh(id, { resume: true }) : signinOpen()
}
async function signinOpen() {
  const seen = actions
  try {
    const r = await api.get('/api/auth/higgsfield/open')
    const l = r?.login
    // a pessoa já agiu (Entrar, outra consulta) ou a tela já tem um login: a resposta não vale
    if (S.signin || seen !== actions || !l?.id) return null
    if (!OPEN_LOGIN.includes(l.status) && l.status !== 'failed' && l.status !== 'expired') return null
    return await setSignin({ login: l }, { quiet: true })
  } catch {
    return null // servidor sem a rota, sem rede: fica o botão de entrar
  }
}

// Motivo de um vídeo barrado pelo provedor (null = falha comum, não recusa). kind = job.errorKind, que o servidor
// grava (ip_detected, nsfw) e vale mais que o texto: o texto do erro muda com o tempo e fica só como reserva
const REFUSAL_KIND = { ip_detected: 'direitos autorais', nsfw: 'moderação' }
export function refusalReason(err, kind = null) {
  if (kind && Object.hasOwn(REFUSAL_KIND, kind)) return REFUSAL_KIND[kind]
  const t = String(err || '')
  if (/direitos autorais/i.test(t)) return 'direitos autorais'
  if (/ip_detected|propriedade intelectual/i.test(t)) return 'direitos autorais'
  if (/nsfw|moderação/i.test(t)) return 'moderação'
  if (/política|policy|pessoa real/i.test(t)) return 'política de conteúdo'
  return null
}

// downloads pedidos nesta tela: quando terminam, o vídeo já entra escolhido no passo 2
export const selectOnDone = new Set()

function onJobStatus(job) {
  if (job.kind === 'download') {
    if (job.status === 'done') {
      toast(`Baixado: ${job.title}`, 'ok')
      if (job.warning) toast(job.warning, 'err', 9000)
      if (selectOnDone.delete(job.id)) {
        // grava a seleção também: se você estiver em outra tela, o vídeo já aparece escolhido ao voltar ao Estúdio
        savePref('selClips', [...new Set([...loadPref('selClips', []), ...(job.clipIds || [])])])
        for (const id of job.clipIds || []) window.dispatchEvent(new CustomEvent('clip-added', { detail: { id } }))
      }
    } else if (job.status === 'failed') toast(`Não baixou: ${job.error || job.title}`, 'err', 9000)
    return
  }
  // Character Online: vistas para vídeo (pedidas na ficha ou no Estúdio) e o corpo inteiro (o mesmo tipo de pedido, só
  // com o papel 'fullbody') entram sozinhos no personagem: avisa quando terminam, com o nome do que foi pedido. As
  // opções do card aparecem no próprio criador, uma a uma.
  if (job.kind === 'image') {
    const who = characterById(job.input?.characterId)?.name || job.title
    const body = (job.input?.roles || []).includes('fullbody')
    if (job.subkind === 'views' && job.status === 'done') toast(body ? `Corpo inteiro pronto: ${who}` : `Vistas para vídeo prontas: ${who}`, 'ok')
    else if (job.subkind === 'views' && job.status === 'failed') toast(`Não consegui gerar ${body ? 'o corpo inteiro' : 'as vistas'} de ${who}: ${job.error || 'tente de novo'}`, 'err', 9000)
    return
  }
  if (job.kind !== 'take' && job.kind !== 'video_upscale') return
  if (job.status === 'done') {
    toast(`Pronto: ${job.title}`, 'ok')
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Vídeo pronto', { body: job.title, icon: job.outputs?.thumbUrl || 'img/favicon.png' })
    }
  } else if (job.status === 'failed') {
    // vídeo barrado (direitos autorais, moderação...): aviso que fica mais tempo e notificação do Mac
    const why = refusalReason(job.error, job.errorKind)
    toast(why ? `Barrado (${why}): ${job.title}` : `Falhou: ${job.title}`, 'err', why ? 15000 : 7000)
    if (why && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification(`Vídeo barrado (${why})`, { body: job.title, icon: 'img/favicon.png' })
    }
  }
}

let toastId = 0
export function toast(text, kind = 'info', ms = 4200) {
  const id = ++toastId
  S.toasts = [...S.toasts, { id, text, kind }]
  notify()
  setTimeout(() => { S.toasts = S.toasts.filter(t => t.id !== id); notify() }, ms)
}

export function showLightbox(kind, url) { S.lightbox = { kind, url }; notify() }

// Preferências locais (seleções e configuração do Estúdio)
export function loadPref(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(`character.${key}`)); return v ?? fallback } catch { return fallback }
}
export function savePref(key, value) {
  try { localStorage.setItem(`character.${key}`, JSON.stringify(value)) } catch {}
}

export const modelById = id => S.models.find(m => m.id === id)
// elenco de um vídeo: no collab, todos na ordem; no vídeo simples, o personagem do job
// vídeos prontos: o que terminou por último fica no topo (não importa quando foi pedido)
export const newestFirst = (a, b) => (b.finishedAt || b.updatedAt || '').localeCompare(a.finishedAt || a.updatedAt || '')
export const castIds = j => (j?.input?.cast?.length ? j.input.cast.map(m => m.characterId) : [j?.input?.characterId].filter(Boolean))
export const castNames = j => castIds(j).map(id => S.characters.find(c => c.id === id)?.name).filter(Boolean).join(' + ')
export const characterById = id => S.characters.find(c => c.id === id)
export const clipById = id => S.clips.find(c => c.id === id)
export const projectById = id => S.projects.find(p => p.id === id)
// personagens da pasta, na ordem da pasta
export const projectChars = p => (p?.characterIds || []).map(characterById).filter(Boolean)
