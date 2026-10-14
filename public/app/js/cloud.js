// Character Online: formatos de créditos (a carteira do aluno é em créditos: 1 crédito do app = 1 crédito do
// Higgsfield) e de dinheiro (só o preço dos pacotes de créditos, em centavos de real), fila e previsão, a
// fórmula de créditos para a prévia do painel do admin e os textos e ações da conta Higgsfield própria do aluno.
// Funções puras: as telas importam daqui pelo ui.js.

const brl = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const int = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })

// centavos -> "R$ 1.234,56" (preço dos pacotes de créditos)
export const money = cents => {
  const n = Math.round(Number(cents) || 0)
  return `${n < 0 ? '-' : ''}R$ ${brl.format(Math.abs(n) / 100)}`
}

// créditos -> "1.250" (inteiro, separador de milhar)
export const num = n => {
  const v = Math.round(Number(n) || 0)
  return `${v < 0 ? '-' : ''}${int.format(Math.abs(v))}`
}

// créditos -> "1.250 créditos" ("1 crédito")
export const credits = n => {
  const v = Math.round(Number(n) || 0)
  return `${num(v)} ${Math.abs(v) === 1 ? 'crédito' : 'créditos'}`
}

// créditos, curto (onde o espaço é pouco) -> "330 cr"
export const cr = n => `${num(n)} cr`

// "50" -> 5000, "25,90" -> 2590, "R$ 1.234,56" -> 123456, "-10" -> -1000 (null se não for valor)
export function parseMoney(text) {
  let t = String(text ?? '').replace(/R\$|\s/g, '')
  if (!t) return null
  const neg = t.startsWith('-')
  if (neg) t = t.slice(1)
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.')
  else if (/^\d+(,\d{1,2})?$/.test(t)) t = t.replace(',', '.')
  else if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const n = Math.round(Number(t) * 100)
  return Number.isFinite(n) ? (neg ? -n : n) : null
}

// "1000" -> 1000, "1.000" -> 1000, "-50" -> -50, "+50" -> 50, "330 cr" -> 330 (null se não for um número inteiro)
export function parseCredits(text) {
  let t = String(text ?? '').replace(/\s|créditos?|cr\b/gi, '')
  if (!t) return null
  const neg = t.startsWith('-')
  if (neg || t.startsWith('+')) t = t.slice(1)
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '')
  else if (!/^\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isSafeInteger(n) ? (neg ? -n : n) : null
}

// minutos -> "menos de 1 min", "25 min", "1 h 20 min", "2 h"
export function etaText(min) {
  if (!(Number(min) >= 1)) return 'menos de 1 min'
  const m = Math.ceil(Number(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} h ${r} min` : `${h} h`
}

// Posição na fila e previsão de um vídeo (job.queue = { position, eta_minutes }; position = partes na frente)
export function queueText(job) {
  // vídeo parado pela conta Higgsfield do aluno (sem créditos, login vencido, pausa): o motivo vale mais que a posição
  if (job?.waiting?.text && (job.status === 'queued' || job.status === 'running')) return job.waiting.text
  const q = job?.queue
  if (!q) return ''
  const eta = q.eta_minutes != null ? `pronto em cerca de ${etaText(q.eta_minutes)}` : ''
  if (job.status !== 'queued') return eta
  const pos = q.position > 0 ? `${q.position + 1}º na fila` : 'próximo da fila'
  return eta ? `${pos} · ${eta}` : `${pos} · esperando uma vaga no Higgsfield`
}

// "12/11" (ou "12/11/2027" em outro ano)
export function dayMonth(iso, now = new Date()) {
  if (!iso) return ''
  const d = new Date(iso)
  const dd = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`
  return d.getFullYear() === now.getFullYear() ? dd : `${dd}/${d.getFullYear()}`
}

// Efeito de um lançamento do extrato nos créditos disponíveis (a cobrança só baixa o que já estava reservado)
export function entryDelta(e) {
  const v = Number(e?.amount_credits) || 0
  if (e?.kind === 'topup' || e?.kind === 'release' || e?.kind === 'adjust') return v
  if (e?.kind === 'reserve' || e?.kind === 'refund') return v ? -v : 0
  return 0
}

// Resumo do orçamento do Estúdio: "30 s cobrados · 2 partes" (parts pode vir como número ou lista)
export function estimateText(est) {
  if (!est) return ''
  const secs = Number(est.seconds_billed)
  const parts = Array.isArray(est.parts) ? est.parts.length : Number(est.parts)
  const out = []
  if (secs > 0) out.push(`${num(secs)} s cobrados`)
  if (parts > 0) out.push(parts === 1 ? '1 parte' : `${num(parts)} partes`)
  return out.join(' · ')
}

// Pacotes de créditos válidos ({ credits, price_cents }), na ordem do servidor (o índice vai na compra)
export function validPackages(list) {
  return (Array.isArray(list) ? list : [])
    .map((p, index) => ({ index, credits: Number(p?.credits), price_cents: Number(p?.price_cents) }))
    .filter(p => Number.isInteger(p.credits) && p.credits > 0 && Number.isInteger(p.price_cents) && p.price_cents > 0)
}

// Mesma regra do servidor, só para a prévia do painel do admin: cada parte é cobrada por segundo inteiro
// (mínimo min_seconds) a credits_per_second créditos; o personagem novo usa character_image_credits por imagem.
const clean = n => Number(n.toFixed(6))
export function partCredits(seconds, p) {
  const billed = Math.ceil(clean(Math.max(Number(p.min_seconds) || 0, Number(seconds) || 0)))
  return Math.ceil(clean(billed * Number(p.credits_per_second)))
}
export const newCharacterCredits = (p, images = 4) => Math.ceil(clean(Number(p.character_image_credits) * images))

// ------------------------------------------------------------ conta Higgsfield própria (me.higgsfield)
// { mode: 'own' | 'pool' | 'none', connected, status, credits, available, checkedAt, email, busyUntil, login, notice }
// credits = saldo da conta própria (o número do chip); available = créditos livres para um pedido novo (saldo menos o
// que o Higgsfield ainda vai descontar e a fila do aluno); login.cancelToken = ficha do sendBeacon ao fechar a aba
// Regras e textos do servidor em docs/conta-propria-higgsfield.md e src/core/higgsfield/own.js.

export const HIGGSFIELD_SITE = 'https://higgsfield.ai'
export const OPEN_LOGIN = ['starting', 'waiting', 'completing']

// Dá para gerar agora? Conjunto do app, ou conta própria sem o login vencido (a mesma regra do "configured" do catálogo)
export const higgsfieldReady = h => !!h && (h.mode === 'pool' || (h.mode === 'own' && h.status !== 'auth_error' && h.status !== 'disabled'))

// Antes de gerar: sem conta (e sem o conjunto do app) ou com o login vencido não dá. O aviso já vem pronto.
// images: o pedido é de imagem (criar personagem, vistas). A conta no plano grátis (Free) do Higgsfield não cria imagem
// por aplicativos (me.higgsfield.notice { kind: 'plan', reason: 'free_plan' }): só aí trava. O vídeo continua liberado
// (uma conta Free já gerou vídeo pelo app), então o Gerar do Estúdio não passa images.
export function higgsfieldBlock(h, { images = false } = {}) {
  if (!h) return null
  if (h.mode === 'none') return { kind: 'not_connected', text: 'Conecte sua conta Higgsfield em Configurações para gerar.' }
  if (h.mode === 'own' && h.status === 'auth_error') return { kind: 'auth', text: 'Sua conexão com o Higgsfield expirou. Conecte de novo em Configurações.' }
  if (images && h.notice?.kind === 'plan' && h.notice.reason === 'free_plan') return { kind: 'plan', text: h.notice.text }
  return null
}

// Aviso do plano do Higgsfield (plano grátis, teste grátis ou plano que não libera o pedido) que não trava: o criador
// mostra junto do botão (quem tem espaço de equipe pago, por exemplo, ainda consegue gerar). null sem esse aviso.
// O do teste grátis vem com kind 'trial' (só Abrir higgsfield.ai: noticeActions)
export function higgsfieldPlanWarn(h) {
  const n = h?.notice
  return n?.kind === 'plan' && n.text ? { kind: n.reason === 'trial' ? 'trial' : 'plan', text: n.text } : null
}

// Nome do plano da conta Higgsfield (me.higgsfield.plan, como o Higgsfield manda: 'free', 'plus', 'starter'...) para a
// tela: "Free", "Plus". null sem plano conhecido.
export function planText(plan) {
  const t = String(plan ?? '').trim().replace(/[_-]+/g, ' ')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null
}

// Erro de geração ligado à conta do aluno ({ error, code, need, have, balance? } da API) -> aviso com a ação certa
// (null = outro erro). have = créditos livres (saldo menos a fila); balance = saldo da conta. ready: o servidor mandou o
// campo balance (mesmo null), então o texto dele já separa o saldo do que está reservado para a fila (ou decidiu não
// separar) e aparece como veio. higgsfield_plan: pedido de imagem barrado porque a conta está no plano grátis (402)
const ERROR_KIND = { higgsfield_not_connected: 'not_connected', higgsfield_no_credits: 'no_credits', higgsfield_auth: 'auth', higgsfield_plan: 'plan' }
export function higgsfieldErrorOf(e) {
  const kind = ERROR_KIND[e?.data?.code]
  if (!kind) return null
  return {
    kind, text: e.data.error || e.message, need: e.data.need ?? null, have: e.data.have ?? null, balance: e.data.balance ?? null,
    ready: 'balance' in e.data,
  }
}

// O aviso de um erro da conta Higgsfield ainda vale? O de conectar some quando a conta volta a gerar; o de créditos
// some quando o saldo sobe depois do erro (seen = saldo visto logo depois dele), e aí vale a conta de agora; o do plano
// (o 402 do plano grátis) some quando o servidor deixa de mandar o aviso do plano (o aluno assinou e clicou em "Já
// assinei, atualizar": a conferência lê o plano pago)
export function liveHiggsfieldError(err, h) {
  if (!err) return null
  if (err.kind === 'plan') return h?.notice?.kind === 'plan' ? err : null
  if (err.kind !== 'no_credits') return higgsfieldReady(h) ? null : err
  if (err.seen != null && h?.credits != null && Number(h.credits) > Number(err.seen)) return null
  return err
}

// Créditos livres da conta própria para um pedido novo: o servidor manda o saldo menos a fila (available); sem
// isso, o saldo da conta
export const higgsfieldFree = h => (h?.available != null ? Number(h.available) : h?.credits != null ? Number(h.credits) : null)

// Parte do saldo já reservada para a fila do aluno (saldo da conta menos os livres; 0 quando não dá para saber)
const reservedOf = (have, balance) => (balance != null && have != null && Number(balance) > Number(have) ? Number(balance) - Math.max(0, Number(have)) : 0)

// Orçamento com a conta própria: "usa 143 créditos do seu Higgsfield (você tem 1.000)"; com fila, o saldo da conta
// (o mesmo número do chip da barra) separado do que está livre: "(200 livres de 1.000; 800 reservados para a fila)"
export function ownBudgetText(need, have, balance = null) {
  const free = num(Math.max(0, Number(have) || 0))
  const held = reservedOf(have, balance)
  const tail = have == null ? '' : held ? ` (${free} livres de ${num(balance)}; ${num(held)} reservados para a fila)` : ` (você tem ${free})`
  return `usa ${credits(need)} do seu Higgsfield${tail}`
}

// Saldo da conta própria não cobre o pedido (mesmo texto do servidor). Com fila, diz que o saldo da conta é maior,
// mas parte dele já está reservada para os vídeos da fila (senão o aluno vê 1.000 no chip e "tem 200" no aviso).
// Pedido de opções do card (unit = créditos de uma opção, n = quantas): quando o saldo cobre 1, diz para escolher 1
// opção (o mesmo texto do servidor, noCreditsError)
export function noCreditsText(need, have, balance = null, { unit = null, n = null } = {}) {
  const held = reservedOf(have, balance)
  const free = Math.max(0, Number(have) || 0)
  if (held) return `Sua conta Higgsfield tem ${num(balance)} créditos, mas ${num(held)} já estão reservados para os vídeos da sua fila. Sobram ${num(free)} e este pedido usa ${num(need)}. Adicione créditos em higgsfield.ai ou espere a fila andar.`
  if (Number(n) > 1 && Number(unit) > 0 && free >= Number(unit)) {
    return `Sua conta Higgsfield tem ${num(free)} créditos e as ${num(n)} opções usam ${num(need)}. Escolha 1 opção ou adicione créditos em higgsfield.ai.`
  }
  return `Sua conta Higgsfield tem ${num(free)} créditos e este pedido usa ${num(need)}. Adicione créditos em higgsfield.ai e tente de novo.`
}

// Créditos de um vídeo ou personagem na tela: { value, of, text, title } ("143 cr", "330 cr" ou null, "143 cr / 330 cr");
// null = nada a mostrar. Carteira: descontados (/ reservados enquanto roda). Conta Higgsfield própria (billing 'own'):
// os créditos do Higgsfield do aluno já usados (/ o total do pedido enquanto roda); falhou ou cancelado sem nada
// enviado: nada (o Higgsfield não cobrou).
export function jobCredits(j) {
  const active = j?.status === 'running' || j?.status === 'queued'
  const own = j?.billing === 'own'
  const used = Number(own ? j.higgsfield_credits : j?.charged_credits) || 0
  if (own && !active && !used) return null
  const value = cr(used)
  const of = active && Number(j?.price_credits) ? cr(j.price_credits) : null
  const title = own
    ? (active ? 'Créditos do seu Higgsfield já usados / que este pedido usa' : 'Créditos do seu Higgsfield que este pedido usou')
    : (active ? 'Créditos descontados até agora / reservados' : 'Créditos descontados')
  return { value, of, text: of ? `${value} / ${of}` : value, title }
}

// Dica do "Tentar de novo": na conta própria o pedido usa os créditos do Higgsfield de novo (a carteira não entra)
export function retryTitle(j) {
  if (j?.kind === 'download') return 'Baixa de novo o mesmo link'
  if (j?.billing === 'own') return 'Pede de novo com os mesmos ajustes (usa os créditos do seu Higgsfield de novo)'
  return 'Pede de novo com os mesmos ajustes (o valor é reservado de novo; o que falhou não é cobrado)'
}

// Botões de cada aviso: conectar (Configurações), abrir o site do Higgsfield, assinar um plano (link de cadastro do
// dono), atualizar o saldo.
// 'refused' = o Higgsfield recusou os envios mesmo com saldo (o aluno confere o plano e os créditos no site);
// 'low_credits' = saldo baixo para vídeo, mas ainda gera (aviso leve); 'plan' = o plano da conta não libera o pedido
// (assinar e "Já assinei, atualizar"); 'trial' = teste grátis do plano (ativar a cobrança no site: a conferência não
// muda o plano lido, então nada de Atualizar; o aviso sai com o próximo pedido aceito)
export function noticeActions(kind) {
  if (kind === 'not_connected' || kind === 'auth') return ['connect']
  if (kind === 'no_credits' || kind === 'refused' || kind === 'low_credits') return ['site', 'refresh']
  if (kind === 'plan') return ['subscribe', 'refresh']
  if (kind === 'trial') return ['site']
  if (kind === 'error') return ['refresh']
  return []
}

// Botões da faixa (me.higgsfield.notice). O aviso 'error' tem dois casos: sem comunicação com o Higgsfield (conta em
// 'error': Atualizar) ou envios recusados mesmo com saldo (conta 'active' ou 'out_of_credits': Abrir higgsfield.ai e
// Atualizar saldo, como no aviso de créditos). O do plano no teste grátis (reason 'trial') vira 'trial'
export function noticeKind(h) {
  const n = h?.notice
  if (!n) return null
  if (n.kind === 'error' && h.connected && h.status !== 'error') return 'refused'
  if (n.kind === 'plan' && n.reason === 'trial') return 'trial'
  return n.kind
}

// ------------------------------------------------------------ cancelar um vídeo
// O servidor diz se aceita (job.cancelable): na conta própria até a montagem final, mesmo com parte já enviada; na
// carteira só antes do primeiro envio. Sem o campo (servidor antigo, download, imagens): a regra de antes.
export function canCancel(j) {
  if (j?.cancelable != null) return !!j.cancelable
  return (j?.status === 'running' || j?.status === 'queued') && !['generating', 'finishing'].includes(j.stage)
}

// Alguma parte do vídeo já foi (ou está indo) para o Higgsfield? (enviando, gerando lá ou pronta)
export const partsSent = j => (j?.steps || []).some(s => s.key === 'swap' && (s.parts || []).some(p => p.status === 'running' || p.status === 'done'))

// Pergunta antes de cancelar: na conta própria com parte já enviada, o aviso de que o Higgsfield cobra a parte enviada
// mesmo cancelando e de onde fica o que sair (o histórico da conta em higgsfield.ai)
export const CANCEL_SENT_TEXT = 'O Higgsfield já começou este vídeo e vai cobrar os créditos da parte enviada mesmo se você cancelar. O que sair fica no seu histórico em higgsfield.ai. Cancelar mesmo assim?'
export function cancelQuestion(j) {
  if (j?.billing === 'own' && partsSent(j)) return CANCEL_SENT_TEXT
  return 'Cancelar este vídeo?'
}

// Quando o Higgsfield aceitou a última parte de vídeo da conta própria (ISO; null sem nenhuma): o saldo conferido antes
// disso ainda não desconta esses vídeos
export function lastSentAt(jobs) {
  let last = null
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (j?.billing !== 'own') continue
    for (const s of j.steps || []) {
      if (s.key !== 'swap') continue
      for (const p of s.parts || []) if (p.submittedAt && (!last || p.submittedAt > last)) last = p.submittedAt
    }
  }
  return last
}

// Barra do topo: conta própria = "Higgsfield 1.250" (abre Configurações); sem conta = "Conectar Higgsfield";
// conjunto do app (ou servidor sem conta própria) = null, fica o chip de Créditos de sempre. O aviso leve de saldo baixo
// (low_credits: ainda dá para gerar) não pinta o chip de alerta. sentAt = lastSentAt dos vídeos: saldo conferido antes
// deles, a dica diz isso (o número do chip ainda não desconta esses vídeos)
export function higgsfieldChip(h, { sentAt = null } = {}) {
  if (!h || h.mode === 'pool') return null
  if (h.mode === 'none') return { kind: 'connect', label: 'Conectar Higgsfield', title: 'Conecte sua conta Higgsfield para gerar com os seus créditos' }
  const warn = (!!h.notice && h.notice.kind !== 'low_credits') || h.status === 'out_of_credits' || h.status === 'auth_error' || h.status === 'error'
  const held = reservedOf(h.available, h.credits)
  const stale = !!sentAt && !!h.checkedAt && new Date(h.checkedAt) < new Date(sentAt)
  return {
    kind: 'own', label: 'Higgsfield', value: h.credits == null ? '?' : num(h.credits), warn,
    title: `Créditos da sua conta Higgsfield${h.email ? ` (${h.email})` : ''}: ${higgsfieldStatusText(h)}${held ? `. ${num(held)} já estão reservados para a sua fila` : ''}${stale ? '. Saldo conferido antes dos últimos vídeos' : ''}`,
  }
}

// ------------------------------------------------------------ login do Higgsfield (painel de Configurações)
// O login pelo navegador (pkce, o padrão) fica aberto 30 min depois de abrir o link (dá tempo de criar a conta ou
// assinar um plano no meio); o pela CLI (method 'cli') continua com os 5 min dela. O servidor manda o prazo em
// login.expiresAt; o relógio só aparece nos últimos LOGIN_CLOCK_MINUTES.
export const LOGIN_MINUTES = 30
export const CLI_LOGIN_MINUTES = 5
export const LOGIN_CLOCK_MINUTES = 5
export const loginMinutes = login => (login?.method === 'cli' ? CLI_LOGIN_MINUTES : LOGIN_MINUTES)

// Prazo do login aberto, em texto: "Você tem 30 minutos para entrar." enquanto falta o prazo inteiro; depois, o que
// falta de verdade, contado de login.expiresAt ("Faltam 10 minutos para entrar."): o login retomado em outra aba, ou
// ao voltar para a tela, não recomeça os 30 minutos, e o relógio só aparece nos últimos LOGIN_CLOCK_MINUTES. Sem prazo
// do servidor, o prazo inteiro.
export function loginTimeText(login, now = Date.now()) {
  const full = loginMinutes(login)
  const end = login?.expiresAt ? new Date(login.expiresAt).getTime() : NaN
  if (!Number.isFinite(end)) return `Você tem ${full} minutos para entrar.`
  const left = Math.ceil((end - Number(now)) / 60_000)
  if (left >= full) return `Você tem ${full} minutos para entrar.`
  if (left <= 0) return 'O tempo para entrar acabou.'
  return left === 1 ? 'Falta 1 minuto para entrar.' : `Faltam ${left} minutos para entrar.`
}

// O relógio do login aparece? Só quando faltam LOGIN_CLOCK_MINUTES ou menos (antes disso assusta quem precisa criar a
// conta ou assinar um plano no meio do login)
export function loginClockOn(expiresAt, now = Date.now()) {
  const end = expiresAt ? new Date(expiresAt).getTime() : NaN
  return Number.isFinite(end) && end - Number(now) <= LOGIN_CLOCK_MINUTES * 60_000
}

// Consulta do login aberto: a cada 2 s enquanto o servidor trabalha (esperando vaga ou conferindo o endereço); com o
// link aberto (waiting) quem age é a pessoa, então a cada 15 s (e também quando a aba volta a aparecer)
export const loginPollMs = login => (login?.status === 'waiting' ? 15000 : 2000)

// Login pela CLI (method 'cli'): ocupa uma vaga do corretor, então fechar a aba ou sair da tela cancela. O login pelo
// navegador (pkce, ou sem o campo) não ocupa vaga e continua aberto para a pessoa voltar (outra aba, outro app)
export const cliLogin = login => login?.method === 'cli'

// Relógio do login: "4:59" até expiresAt ("0:00" quando passou; null sem prazo)
export function loginCountdown(expiresAt, now = Date.now()) {
  const end = expiresAt ? new Date(expiresAt).getTime() : NaN
  if (!Number.isFinite(end)) return null
  const s = Math.max(0, Math.ceil((end - Number(now)) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Login esperando vaga (muita gente conectando ao mesmo tempo): "Você é o 3º na fila, aguarde." (queuePosition
// começa em 1 = o próximo; sem ela, null)
export function loginQueueText(login) {
  const n = Number(login?.queuePosition)
  if (login?.status !== 'starting' || !Number.isInteger(n) || n < 1) return null
  return `Você é o ${n}º na fila, aguarde.`
}

const STATUS_TEXT = {
  active: 'Conectada', out_of_credits: 'Sem créditos', auth_error: 'Conexão expirada', error: 'Com erro no Higgsfield', paused: 'Pausada',
}
export function higgsfieldStatusText(h, now = new Date()) {
  if (!h?.connected) return 'Não conectada'
  if (h.status === 'active' && h.busyUntil && new Date(h.busyUntil) > now) return 'O Higgsfield pediu uma pausa; continua em instantes'
  return STATUS_TEXT[h.status] || 'Conectada'
}

// O que o painel de Configurações mostra: 'login' (login aberto), 'connected', 'failed' (o último login falhou ou
// expirou e não há conta) ou 'none'
export function higgsfieldStep(h) {
  if (!h) return null
  if (h.login && OPEN_LOGIN.includes(h.login.status)) return 'login'
  if (h.connected) return 'connected'
  if (h.login && (h.login.status === 'failed' || h.login.status === 'expired')) return 'failed'
  return 'none'
}

// Mensagem do login que não terminou (o servidor manda o motivo quando tem; failed = o texto padrão da falha)
export function loginErrorText(login, failed = 'Não consegui conectar sua conta Higgsfield. Tente de novo.') {
  if (!login || (login.status !== 'failed' && login.status !== 'expired')) return null
  if (login.error) return login.error
  return login.status === 'expired' ? 'O login expirou antes de terminar. Tente de novo.' : failed
}

// ------------------------------------------------------------ entrar com o Higgsfield (tela de entrada)
// O que a tela de entrada mostra para o login de entrada (S.signin): 'login' (aberto), 'failed' (falhou ou expirou) ou
// 'idle' (nenhum, cancelado ou já terminado): o botão "Entrar com o Higgsfield"
export function signinStep(login) {
  if (login && OPEN_LOGIN.includes(login.status)) return 'login'
  if (login && (login.status === 'failed' || login.status === 'expired')) return 'failed'
  return 'idle'
}

// O código por e-mail aparece na entrada? Só quando o servidor diz que está ligado: GET /api/state sem sessão
// (login_methods com 'email', ou features.email_login) ou me.features.email_login de quem acabou de sair. Na dúvida, não.
export function emailLoginOn(data) {
  if (!data || typeof data !== 'object') return false
  if (Array.isArray(data.login_methods)) return data.login_methods.includes('email')
  return data.features?.email_login === true || data.email_login === true
}

// Mesmo e-mail? Maiúsculas e espaços nas pontas não contam. Sem um dos dois, não.
export const sameEmail = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()

// Entrou agora: o aviso fala da conta com que a pessoa entrou (a identidade, me.user.email). created = a conta do app
// foi criada nesta entrada (o GET que abriu a sessão manda created: true): quem já usava o Character com outra conta
// Higgsfield caiu numa conta nova e precisa sair e entrar com a antiga.
export function enteredText(email, created = false) {
  if (created) return `Criamos uma conta nova para ${email || 'você'}. Se você já usava o Character com outra conta Higgsfield, saia e entre com ela.`
  return email ? `Você entrou com a conta Higgsfield ${email}` : 'Você entrou com a sua conta Higgsfield'
}

// Linha do painel de Configurações: a conta Higgsfield conectada ali também abre esta conta do Character pelo botão
// Entrar com o Higgsfield (o corretor acha o aluno pelo e-mail da conta conectada). Conectada outra conta que não a da
// entrada (me.user.email): diz com qual a pessoa entra. Sem conta conectada ou com o login vencido (Conectar de novo):
// a mesma ideia, mais curta. null = nada a dizer.
export function higgsfieldSigninNote(h, userEmail) {
  if (!h) return null
  if (h.email && userEmail && !sameEmail(h.email, userEmail)) {
    return `Você entra no Character com a conta Higgsfield ${userEmail}. A conta conectada aqui gera os vídeos e também abre esta conta do Character pelo botão Entrar com o Higgsfield, então conecte só uma conta sua.`
  }
  if (!h.connected || h.status === 'auth_error') return 'Conecte a sua própria conta Higgsfield: quem conectar aqui também consegue entrar nesta conta do Character.'
  return null
}

// Endereço colado no passo 2: sem "http://" o navegador costuma copiar só "localhost:porta/callback?...". O
// compartilhar do Android cola o título da página e o endereço numa linha embaixo: vale só o endereço (a mesma regra do
// servidor, parseCallbackUrl). Endereço do site do Higgsfield (o aluno copiou a página errada): erro na hora, com o
// texto que o servidor daria (code 'callback_invalid', reason 'site_higgsfield').
const CALLBACK_RE = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d{2,5}\/callback\?[^\s"'<>]+/i
export const CALLBACK_SITE_TEXT = 'Endereço do Higgsfield detectado. Conectando...'
export const hasCallbackUrl = text => !!String(text ?? '').trim()
export function callbackUrl(text) {
  const t = String(text ?? '').trim()
  if (!t) throw new Error('Cole o link completo do callback ou seu Token.')
  if (t.startsWith('ey') || t.startsWith('hf')) return t
  const m = t.match(CALLBACK_RE)
  const u = m ? m[0] : t
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u
  if (u.includes('@')) return u
  return `http://${u}`
}

// ------------------------------------------------------------ aparelho (tela de entrada)
// Navegador de dentro de app (Instagram, Facebook, TikTok): o login do Higgsfield costuma falhar nele
export const IN_APP_TEXT = 'Abra o Character no Safari ou no Chrome. Dentro do Instagram ou do TikTok o login do Higgsfield costuma falhar.'
export const inAppBrowser = ua => /Instagram|FBAN|FBAV|TikTok|musical_ly|Bytedance/i.test(String(ua ?? ''))
// Celular pelo user-agent: 'iphone' (iPhone e iPad), 'android' ou null (computador ou não dá para saber)
export function phoneOf(ua) {
  const t = String(ua ?? '')
  if (/iPhone|iPad|iPod/i.test(t)) return 'iphone'
  if (/Android/i.test(t)) return 'android'
  return null
}
// Como copiar o endereço da página que não abre, em cada celular (sem saber o aparelho, os dois)
const COPY_HELP = {
  iphone: 'No iPhone: toque na barra de endereço e em Copiar.',
  android: 'No Android: toque e segure o endereço e escolha Copiar.',
}
export function copyHelp(ua) {
  const p = phoneOf(ua)
  return p ? [COPY_HELP[p]] : [COPY_HELP.iphone, COPY_HELP.android]
}
