// Painel do admin dentro de Configurações: contas Higgsfield, alunos e licenças, hospedagem paga, créditos, pacotes e
// limites, o robô do Telegram e o Google Drive do dono. Usa as rotas /api/admin/* (só role admin) e os mesmos
// componentes do app (panel, keys, table, stepbox).
import { useState, useEffect, useRef } from 'preact/hooks'
import { html, money, num, credits, cr, Badge, Toggle, Spinner, plural, confirmDialog, ago } from '../ui.js'
import { toast, load } from '../state.js'
import { api, uploadForm } from '../api.js'
import { run } from '../actions.js'
import { etaText, parseMoney, parseCredits, partCredits, newCharacterCredits } from '../cloud.js'
import { goToHiggsfieldPanel } from './account.js'

export function AdminPanels() {
  return html`<${AccountsPanel} /><${StudentsPanel} /><${PaywallPanel} /><${PricingPanel} /><${TelegramPanel} /><${DrivePanel} />`
}

// ------------------------------------------------------------ contas Higgsfield
const ACCOUNT_STATUS = {
  active: ['ativa', 'mint'], paused: ['pausada', ''], out_of_credits: ['sem créditos', 'coral'],
  auth_error: ['login vencido', 'red'], error: ['erro', 'red'], disabled: ['desativada', ''],
}

function AccountsPanel() {
  const [ov, setOv] = useState(null)
  const [label, setLabel] = useState('')
  const reload = async () => { try { setOv(await api.get('/api/admin/overview')) } catch (e) { toast(e.message, 'err') } }
  useEffect(() => {
    reload()
    const t = setInterval(reload, 30000)
    return () => clearInterval(t)
  }, [])
  const create = async e => {
    e.preventDefault()
    if (!label.trim()) return
    const r = await run(() => api.post('/api/admin/accounts', { label: label.trim() }), 'Conta criada (pausada). Envie as credenciais, confira e ative.')
    if (r) { setLabel(''); reload() }
  }
  const q = ov?.queue
  return html`<section class="panel">
    <div class="panel__head"><h2 class="display panel__title">Contas Higgsfield</h2>
      <span class="panel__hint">${q ? `${q.slots_free} de ${q.slots_total} vagas livres · ${plural(q.waiting_parts, 'parte', 'partes')} na fila · ${q.eta_minutes != null ? `fila zera em ${etaText(q.eta_minutes)}` : 'nenhuma conta ativa'}` : 'carregando...'}</span></div>
    <div class="panel__body stack">
      ${ov ? html`<div class="row wrap small muted" style="gap:16px">
        <span>Alunos <b class="pixel">${ov.users_count}</b></span>
        <span>Vídeos hoje <b class="pixel">${ov.takes_today}</b></span>
        <span>Em andamento <b class="pixel">${q.active_takes}</b></span>
        <span>Partes gerando <b class="pixel">${q.active_parts}</b></span>
        <span>Créditos Higgsfield hoje <b class="pixel">${num(ov.credits_today)}</b></span>
        <span>Cobrado dos alunos hoje <b class="pixel">${cr(ov.charged_credits_today)}</b></span>
      </div>` : html`<${Spinner} />`}
      ${ov && !ov.accounts.length ? html`<div class="empty"><b>Nenhuma conta ainda</b><span>Crie a conta abaixo, envie o credentials.json e o config.json da CLI, confira e ative.</span></div>` : null}
      <div class="keys">${(ov?.accounts || []).map(a => html`<${AccountRow} key=${a.id} a=${a} onChange=${reload} />`)}</div>
      <form class="row" onSubmit=${create}>
        <input class="input input--sm grow" maxlength="80" placeholder="Nome da conta nova (ex.: conta 2)" value=${label} onInput=${e => setLabel(e.target.value)} />
        <button class="btn btn--sm btn--butter" disabled=${!label.trim()}>Nova conta</button>
      </form>
    </div>
  </section>`
}

function AccountRow({ a, onChange }) {
  const [slots, setSlots] = useState(String(a.max_slots))
  const [minc, setMinc] = useState(String(a.min_credits))
  const [busy, setBusy] = useState(false)
  const files = useRef(null)
  useEffect(() => { setSlots(String(a.max_slots)); setMinc(String(a.min_credits)) }, [a.max_slots, a.min_credits])
  const [label, kind] = ACCOUNT_STATUS[a.status] || [a.status, '']
  const act = async (fn, ok) => {
    setBusy(true)
    const r = await run(fn, ok)
    setBusy(false)
    if (r) onChange()
    return r
  }
  const patch = (body, ok) => act(() => api.patch(`/api/admin/accounts/${a.id}`, body), ok)
  const refresh = async () => {
    const r = await act(() => api.post(`/api/admin/accounts/${a.id}/refresh`))
    if (r) toast(r.ok ? `${a.label}: ${r.account?.credits_balance ?? '?'} créditos` : `${a.label}: ${r.error}`, r.ok ? 'ok' : 'err', 8000)
  }
  const upload = list => {
    const pick = n => [...list].find(f => f.name.toLowerCase() === n)
    const credentials = pick('credentials.json')
    const config = pick('config.json')
    if (!credentials || !config) { toast('Escolha os dois arquivos juntos: credentials.json e config.json', 'err', 8000); return }
    act(() => uploadForm(`/api/admin/accounts/${a.id}/credentials`, { credentials, config }), 'Credenciais enviadas. Agora clique em Conferir.')
  }
  const dirty = slots !== String(a.max_slots) || minc !== String(a.min_credits)
  return html`<div class="key">
    <div>
      <div class="key__name"><span class=${`dot ${a.status === 'active' ? 'is-on' : ''}`}></span>${a.label}</div>
      <div class="row wrap small dim" style="gap:6px;margin-top:4px"><${Badge} kind=${kind}>${label}</${Badge}>${a.has_credentials ? 'credenciais ok' : 'sem credenciais'}</div>
    </div>
    <div class="stack" style="gap:6px">
      <div class="small muted">${a.credits_balance != null ? html`<b class="pixel">${a.credits_balance}</b> créditos` : 'créditos não conferidos'}${a.credits_checked_at ? ` · conferido ${ago(a.credits_checked_at)}` : ''} · ${a.active_parts} de ${a.max_slots} vagas em uso</div>
      <div class="row wrap" style="gap:8px">
        <label class="row small"><span class="muted">Vagas</span><input class="input input--sm" style="width:72px" type="number" min="1" max="64" value=${slots} onInput=${e => setSlots(e.target.value)} /></label>
        <label class="row small"><span class="muted">Créditos mínimos</span><input class="input input--sm" style="width:96px" type="number" min="0" value=${minc} onInput=${e => setMinc(e.target.value)} /></label>
        ${dirty ? html`<button class="btn btn--xs btn--butter" disabled=${busy} onClick=${() => patch({ max_slots: Number(slots), min_credits: Number(minc) }, 'Conta atualizada')}>Salvar</button>` : null}
      </div>
      ${a.last_error ? html`<div class="small" style="color:var(--coral-l)">${a.last_error}</div>` : null}
    </div>
    <div class="row wrap" style="gap:6px;justify-content:flex-end;max-width:330px">
      <button class="btn btn--sm" disabled=${busy} title="credentials.json e config.json da CLI do Higgsfield (escolha os dois juntos)" onClick=${() => files.current.click()}>Enviar credenciais</button>
      <button class="btn btn--sm" disabled=${busy || !a.has_credentials} title="Confere o login e os créditos na CLI" onClick=${refresh}>Conferir</button>
      ${a.status === 'active'
        ? html`<button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${() => patch({ status: 'paused' }, 'Conta pausada: não recebe novos envios')}>Pausar</button>`
        : html`<button class="btn btn--sm btn--butter" disabled=${busy || !a.has_credentials} onClick=${() => patch({ status: 'active' }, 'Conta ativa')}>Ativar</button>`}
      ${a.status !== 'disabled' ? html`<button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${async () => (await confirmDialog(`Desativar a conta ${a.label}? Ela sai da distribuição até ser ativada de novo.`, { ok: 'Desativar' })) && patch({ status: 'disabled' }, 'Conta desativada')}>Desativar</button>` : null}
      <input ref=${files} type="file" accept=".json,application/json" multiple hidden onChange=${e => { upload(e.target.files); e.target.value = '' }} />
    </div>
  </div>`
}

// ------------------------------------------------------------ alunos e licenças
const LICENSE = { active: 'ativa', refunded: 'reembolsada', chargeback: 'chargeback', revoked: 'revogada' }
// Hospedagem paga de um aluno da lista: [texto, cor]
export function hostingOf(u) {
  if (u.paywall_grant === 'blocked') return ['bloqueada pelo admin', 'red']
  if (u.paywall_grant === 'paid') return ['liberada pelo admin', 'mint']
  if (u.paywall_paid) return ['paga', 'mint']
  if (u.paywall_locked_at) return ['galeria fechada', 'coral']
  return ['não paga', '']
}

function StudentsPanel() {
  const [q, setQ] = useState('')
  const [data, setData] = useState(null)
  const [email, setEmail] = useState('')
  const search = async (term = q) => {
    try { setData(await api.get(`/api/admin/users?q=${encodeURIComponent(term.trim())}`)) } catch (e) { toast(e.message, 'err') }
  }
  useEffect(() => {
    const t = setTimeout(() => search(q), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [q])
  const grant = async e => {
    e.preventDefault()
    const v = email.trim()
    if (!v) return
    const r = await run(() => api.post('/api/admin/licenses', { email: v }), `Licença ativa para ${v}: já pode entrar com a conta Higgsfield desse e-mail`)
    if (r) { setEmail(''); search() }
  }
  return html`<section class="panel">
    <div class="panel__head"><h2 class="display panel__title">Alunos e licenças</h2><span class="panel__hint">créditos, licença e acesso</span></div>
    <div class="panel__body stack">
      <div class="row wrap">
        <label class="search" style="max-width:340px"><input class="input input--sm" placeholder="Buscar por e-mail ou nome" value=${q} onInput=${e => setQ(e.target.value)} /></label>
        <span class="grow"></span>
        <form class="row" style="gap:6px" onSubmit=${grant}>
          <input class="input input--sm" style="width:240px" type="email" placeholder="email@aluno.com" value=${email} onInput=${e => setEmail(e.target.value)} />
          <button class="btn btn--sm btn--butter" disabled=${!email.trim()}>Conceder licença</button>
        </form>
      </div>
      ${!data ? html`<${Spinner} />` : data.users?.length ? html`<table class="table">
        <thead><tr><th>Aluno</th><th>Licença</th><th>Hospedagem</th><th>Créditos</th><th>Vídeos</th><th></th></tr></thead>
        <tbody>${data.users.map(u => html`<${UserRow} key=${u.id} u=${u} onChange=${() => search()} />`)}</tbody>
      </table>` : html`<div class="empty"><b>Nenhum aluno ${q.trim() ? 'com essa busca' : 'ainda'}</b></div>`}
      ${data?.pending_licenses?.length ? html`<div class="stack" style="gap:6px"><span class="label">Licenças de quem ainda não entrou</span>
        <div class="row wrap" style="gap:6px">${data.pending_licenses.map(l => html`<${Badge} key=${l.id} kind=${l.status === 'active' ? 'mint' : ''} title=${[l.source, l.product].filter(Boolean).join(' · ')}>${l.email} · ${LICENSE[l.status] || l.status}</${Badge}>`)}</div>
      </div>` : null}
    </div>
  </section>`
}

function UserRow({ u, onChange }) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const idem = useRef(null)
  const adjust = async e => {
    e.preventDefault()
    const n = parseCredits(amount)
    if (!n) { toast('Quantidade inválida. Ex.: 1000 ou -50 (negativo para debitar)', 'err'); return }
    if (!note.trim()) { toast('Escreva o motivo do ajuste', 'err'); return }
    // mesma chave enquanto o formulário não muda: clique duplo não credita duas vezes
    idem.current ||= globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    setBusy(true)
    const done = Math.abs(n) === 1 ? (n > 0 ? 'adicionado para' : 'debitado de') : (n > 0 ? 'adicionados para' : 'debitados de')
    const r = await run(() => api.post(`/api/admin/users/${u.id}/adjust`, { amount_credits: n, note: note.trim(), idem_key: idem.current }),
      `${credits(Math.abs(n))} ${done} ${u.email}`)
    setBusy(false)
    if (r) { idem.current = null; setAmount(''); setNote(''); setOpen(false); onChange() }
  }
  const toggleBlock = async () => {
    const to = u.status === 'blocked' ? 'active' : 'blocked'
    if (to === 'blocked' && !(await confirmDialog(`Bloquear ${u.email}? Ele sai na hora e não entra mais até ser liberado.`, { ok: 'Bloquear' }))) return
    if (await run(() => api.patch(`/api/admin/users/${u.id}`, { status: to }), to === 'blocked' ? 'Aluno bloqueado' : 'Aluno liberado')) onChange()
  }
  return html`
    <tr>
      <td><b>${u.email}</b>${u.role === 'admin' ? html` <${Badge} kind="4k">admin</${Badge}>` : null}${u.status === 'blocked' ? html` <${Badge} kind="red">bloqueado</${Badge}>` : null}
        <div class="small dim">${u.name || ''}${u.name ? ' · ' : ''}${u.last_login_at ? `entrou ${ago(u.last_login_at)}` : 'nunca entrou'}</div></td>
      <td>${u.license_status ? html`<${Badge} kind=${u.license_status === 'active' ? 'mint' : 'red'}>${LICENSE[u.license_status] || u.license_status}</${Badge}>` : html`<span class="small dim">sem licença</span>`}</td>
      <td>${u.role === 'admin' ? html`<span class="small dim">não paga</span>` : html`<${Badge} kind=${hostingOf(u)[1]}>${hostingOf(u)[0]}</${Badge}>
        <div class="small dim">${plural(Number(u.paywall_used) || 0, 'vídeo conta', 'vídeos contam')}</div>`}</td>
      <td class="pixel">${num(u.balance_credits)}${Number(u.reserved_credits) ? html`<div class="small dim">${num(u.reserved_credits)} reservados</div>` : null}</td>
      <td class="pixel">${u.takes_count}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class=${`btn btn--xs ${open ? 'btn--butter' : ''}`} onClick=${() => setOpen(!open)}>Ajustar créditos</button>
        ${u.role !== 'admin' ? html` <button class="btn btn--xs btn--quiet" onClick=${toggleBlock}>${u.status === 'blocked' ? 'Liberar' : 'Bloquear'}</button>` : null}
      </td>
    </tr>
    ${open ? html`<tr><td colspan="6">
      <form class="row wrap" style="gap:8px" onSubmit=${adjust}>
        <input class="input input--sm" style="width:130px" inputmode="numeric" placeholder="Créditos (ex.: 1000)" value=${amount} onInput=${e => { setAmount(e.target.value); idem.current = null }} />
        <input class="input input--sm grow" maxlength="300" placeholder="Motivo (aparece no extrato do aluno)" value=${note} onInput=${e => { setNote(e.target.value); idem.current = null }} />
        <button class="btn btn--sm btn--butter" disabled=${busy}>${busy ? 'Salvando...' : 'Lançar'}</button>
        <span class="small dim">Negativo para debitar. Os créditos nunca ficam abaixo de zero.</span>
      </form>
    </td></tr>` : null}`
}

// ------------------------------------------------------------ hospedagem paga
// Configuração (GET/PUT /api/admin/settings/paywall), se a cobrança está valendo, quem pagou na Kiwify, a transferência
// do pedido pago com outro e-mail (POST /api/admin/paywall/transfer) e a liberação ou o bloqueio manual por e-mail
// (POST /api/admin/paywall/access). Regras em src/core/paywall.js.
const MISSING_TEXT = { checkout_url: 'o link do checkout', kiwify_product: 'o id do produto na Kiwify' }
const ORDER_STATUS = { paid: ['paga', 'mint'], refunded: ['reembolsada', 'red'], chargeback: ['chargeback', 'red'] }
const ACCESS_DONE = { paid: 'Hospedagem liberada para', blocked: 'Hospedagem bloqueada para', auto: 'Voltou a valer só o pagamento na Kiwify para' }
const PAYWALL_FIELDS = [
  ['enabled', 'Cobrar a hospedagem depois dos vídeos grátis', 'bool'],
  ['free_videos', 'Vídeos grátis por aluno'],
  ['price_label', 'Preço mostrado ao aluno (ex.: R$ 37,90)'],
  ['checkout_url', 'Link do checkout na Kiwify (o e-mail do aluno vai junto)'],
  ['kiwify_product_ids', 'Id do produto na Kiwify (vários: separe por vírgula)'],
  ['kiwify_product_names', 'Nome do produto (sem o id: preencha o nome e o valor juntos)'],
  ['kiwify_price_cents', 'Preço do produto em centavos (sem o id: junto com o nome; ex.: 3790)'],
]
const paywallDraft = v => Object.fromEntries(PAYWALL_FIELDS.map(([f, , type]) => {
  const x = v?.[f]
  return [f, type === 'bool' ? x !== false : Array.isArray(x) ? x.join(', ') : String(x ?? '')]
}))
export function paywallStatusText(d) {
  if (!d) return ''
  if (!d.config?.enabled) return 'Desligada: todos geram e assistem sem pagar.'
  if (d.missing?.length) return `Ainda não vale: falta ${d.missing.map(m => MISSING_TEXT[m] || m).join(' e ')}. Até lá ninguém é cobrado.`
  return `Valendo: depois de ${plural(d.config.free_videos, 'vídeo grátis', 'vídeos grátis')}, o aluno paga ${d.config.price_label} para continuar.`
}

function PaywallPanel() {
  const [data, setData] = useState(null)
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [order, setOrder] = useState('')
  const [orderEmail, setOrderEmail] = useState('')
  const reload = async () => {
    try {
      const d = await api.get('/api/admin/paywall')
      setData(d)
      setDraft(paywallDraft(d.config))
    } catch (e) { toast(e.message, 'err') }
  }
  useEffect(() => { reload() }, [])
  const saved = data ? paywallDraft(data.config) : {}
  const changed = draft ? PAYWALL_FIELDS.map(([f]) => f).filter(f => draft[f] !== saved[f]) : []
  const save = async () => {
    const body = {}
    for (const f of changed) body[f] = draft[f]
    setBusy(true)
    const r = await run(() => api.put('/api/admin/settings/paywall', { value: body }), 'Hospedagem paga salva')
    setBusy(false)
    if (r) { await reload(); load() }
  }
  const access = async status => {
    const v = email.trim()
    if (!v) { toast('Digite o e-mail do aluno', 'err'); return }
    if (status === 'blocked' && !(await confirmDialog(`Bloquear a hospedagem de ${v}? A galeria fecha até você liberar ou o pagamento chegar.`, { ok: 'Bloquear' }))) return
    const r = await run(() => api.post('/api/admin/paywall/access', { email: v, status }), `${ACCESS_DONE[status]} ${v}`)
    if (r) { setEmail(''); reload() }
  }
  // pagou com outro e-mail: o pedido passa a valer para a conta do aluno (o reembolso dele continua fechando a galeria)
  const transfer = async () => {
    const id = order.trim()
    const to = orderEmail.trim()
    if (!id || !to) { toast('Digite o número do pedido e o e-mail da conta do aluno', 'err'); return }
    if (!(await confirmDialog(`Transferir o pedido ${id} para ${to}? O e-mail usado na compra deixa de valer.`, { ok: 'Transferir', danger: false }))) return
    const r = await run(() => api.post('/api/admin/paywall/transfer', { order_id: id, email: to }), `Pedido ${id} transferido para ${to}`)
    if (r) { setOrder(''); setOrderEmail(''); reload() }
  }
  const active = data?.active
  return html`<section class="panel">
    <div class="panel__head"><h2 class="display panel__title">Hospedagem paga</h2>
      <span class="panel__hint">${data ? `${plural(data.paid_orders, 'pagamento', 'pagamentos')} na Kiwify · ${plural(data.locked_users, 'aluno', 'alunos')} com a galeria fechada` : 'carregando...'}</span></div>
    <div class="panel__body stack">
      ${!data || !draft ? html`<${Spinner} />` : html`
        <div class=${active ? 'small' : 'warnbox'}>${active ? html`<${Badge} kind="mint">valendo</${Badge}> ` : null}${paywallStatusText(data)}</div>
        <div class="stepbox">
          <div class="row"><span class="label grow">Configuração</span>
            ${changed.length ? html`<button class="btn btn--xs btn--butter" disabled=${busy} onClick=${save}>${busy ? 'Salvando...' : 'Salvar'}</button>
              <button class="btn btn--xs btn--quiet" disabled=${busy} onClick=${() => setDraft(saved)}>Desfazer</button>` : null}</div>
          <div class="admin-grid">${PAYWALL_FIELDS.map(([f, label, type]) => (type === 'bool'
            ? html`<${Toggle} key=${f} checked=${!!draft[f]} onChange=${v => setDraft(d => ({ ...d, [f]: v }))} label=${label} />`
            : html`<label key=${f} class="field"><span class="small muted">${label}</span>
                <input class="input input--sm" value=${draft[f] ?? ''} onInput=${e => { const v = e.target.value; setDraft(d => ({ ...d, [f]: v })) }} /></label>`))}</div>
          <span class="small dim">A liberação é automática pelo webhook da Kiwify quando o e-mail da compra é o da conta do aluno. Reembolso ou chargeback fecha a galeria de novo.</span>
        </div>
        <div class="stepbox">
          <span class="label">Liberar ou bloquear por e-mail</span>
          <div class="row wrap" style="gap:6px">
            <input class="input input--sm grow" style="min-width:200px" type="email" placeholder="email@aluno.com" value=${email} onInput=${e => setEmail(e.target.value)} />
            <button class="btn btn--sm btn--butter" disabled=${!email.trim()} onClick=${() => access('paid')}>Liberar</button>
            <button class="btn btn--sm btn--quiet" disabled=${!email.trim()} onClick=${() => access('blocked')}>Bloquear</button>
            <button class="btn btn--sm btn--quiet" disabled=${!email.trim()} title="Tira a liberação ou o bloqueio manual: vale só o pagamento na Kiwify" onClick=${() => access('auto')}>Automático</button>
          </div>
          <span class="small dim">Liberar é cortesia: vale até você clicar em Automático, e reembolso na Kiwify não desfaz. Para quem pagou com outro e-mail, use Transferir pedido (abaixo).</span>
        </div>
        <div class="stepbox">
          <span class="label">Pagou com outro e-mail</span>
          <div class="row wrap" style="gap:6px">
            <input class="input input--sm" style="width:170px" placeholder="Número do pedido" value=${order} onInput=${e => setOrder(e.target.value)} />
            <input class="input input--sm grow" style="min-width:200px" type="email" placeholder="e-mail da conta no Character" value=${orderEmail} onInput=${e => setOrderEmail(e.target.value)} />
            <button class="btn btn--sm btn--butter" disabled=${!order.trim() || !orderEmail.trim()} onClick=${transfer}>Transferir pedido</button>
          </div>
          <span class="small dim">O pedido passa a valer para a conta do aluno e o e-mail da compra deixa de valer. Reembolso ou chargeback desse pedido fecha a galeria de novo.</span>
        </div>
        ${data.grants?.length ? html`<div class="stack" style="gap:6px"><span class="label">Liberações e bloqueios manuais</span>
          <div class="row wrap" style="gap:6px">${data.grants.map(g => html`<${Badge} key=${g.email} kind=${g.status === 'paid' ? 'mint' : 'red'} title=${[g.actor_email && `por ${g.actor_email}`, g.note].filter(Boolean).join(' · ')}>${g.email} · ${g.status === 'paid' ? 'liberada' : 'bloqueada'}</${Badge}>`)}</div>
        </div>` : null}
        ${data.orders?.length ? html`<table class="table">
          <thead><tr><th>Quem pagou</th><th>Pedido</th><th>Valor</th><th>Situação</th><th></th></tr></thead>
          <tbody>${data.orders.map(o => html`<tr key=${o.order_id}>
            <td><b>${o.email}</b><div class="small dim">${o.user_id ? 'tem conta' : 'ainda sem conta'} · ${ago(o.created_at)}${o.buyer_email ? ` · comprou com ${o.buyer_email}` : ''}</div></td>
            <td class="small dim">${o.order_id}</td>
            <td class="pixel">${o.price_cents != null ? money(o.price_cents) : ''}</td>
            <td><${Badge} kind=${(ORDER_STATUS[o.status] || [])[1] || ''}>${(ORDER_STATUS[o.status] || [o.status])[0]}</${Badge}></td>
            <td style="text-align:right">${o.status === 'paid' ? html`<button class="btn btn--xs btn--quiet" title="Pagou com outro e-mail: passar o pedido para a conta do aluno" onClick=${() => setOrder(o.order_id)}>Transferir</button>` : null}</td>
          </tr>`)}</tbody>
        </table>` : html`<div class="empty"><b>Nenhum pagamento ainda</b><span>As compras da hospedagem aparecem aqui assim que a Kiwify avisar.</span></div>`}`}
    </div>
  </section>`
}

// ------------------------------------------------------------ créditos, pacotes, limites e recursos
const FIELDS = {
  pricing: [
    ['credits_per_second', 'Créditos por segundo de vídeo (Genjutsu 1080p)'],
    ['min_seconds', 'Mínimo cobrado por parte (s)'],
    ['character_image_credits', 'Créditos por imagem de personagem'],
    ['credit_price_brl_cost', 'Custo de 1 crédito no Higgsfield (R$, só informativo)'],
  ],
  limits: [
    ['max_take_seconds', 'Duração máxima do vídeo (s)'],
    ['max_part_seconds', 'Duração máxima de cada parte (s)'],
    ['max_upload_mb', 'Tamanho máximo do envio (MB)'],
    ['max_active_takes_per_user', 'Vídeos em andamento por aluno'],
    ['result_days', 'Dias que o vídeo pronto fica disponível'],
    ['input_days', 'Dias que o vídeo base fica guardado'],
  ],
  features: [
    ['link_import', 'Baixar vídeo por link (TikTok e Instagram)', 'bool'],
    ['user_photo_characters', 'Aluno cria personagem a partir de foto', 'bool'],
    ['signup_requires_license', 'Só entra quem tem licença (desligado = acesso grátis para qualquer e-mail)', 'bool'],
    ['shared_pool', 'Alunos sem conta própria usam as contas centrais (desligado = cada aluno conecta o Higgsfield dele)', 'bool'],
    // a outra porta de entrada, para quando o login do Higgsfield parar (009_entrar_com_higgsfield.sql grava false)
    ['email_login', 'Entrar também com código no e-mail (desligado = só Entrar com o Higgsfield)', 'bool'],
    // 013_a_entrada_pkce.sql: 'pkce' (padrão) ou o login antigo da CLI, para voltar se o login pelo servidor falhar
    ['higgsfield_login', 'Como entrar com o Higgsfield', 'choice', [['pkce', 'Pelo servidor, sem fila (padrão)'], ['cli', 'Login antigo da CLI (fila de 10)']]],
  ],
}
const TITLES = { pricing: 'Créditos', limits: 'Limites', features: 'Recursos' }
const SAVED = { pricing: 'Créditos salvos', limits: 'Limites salvos', features: 'Recursos salvos' }
const toDraft = v => Object.fromEntries(Object.entries(v || {}).map(([k, x]) => [k, typeof x === 'boolean' ? x : String(x ?? '')]))
const decimal = v => Number(String(v ?? '').replace(',', '.'))

function PricingPanel() {
  const [all, setAll] = useState(null)
  useEffect(() => { api.get('/api/admin/settings').then(setAll).catch(e => toast(e.message, 'err')) }, [])
  const box = k => html`<${SettingBox} key=${k} k=${k} value=${all[k] || {}} onSaved=${v => setAll({ ...all, [k]: v })} />`
  return html`<section class="panel">
    <div class="panel__head"><h2 class="display panel__title">Preços e limites</h2><span class="panel__hint">vale para os próximos pedidos</span></div>
    <div class="panel__body stack">
      ${!all ? html`<${Spinner} />` : html`
        ${box('pricing')}
        <${PackagesBox} value=${all.credit_packages} cost=${decimal(all.pricing?.credit_price_brl_cost)} onSaved=${v => setAll({ ...all, credit_packages: v })} />
        ${box('limits')}
        ${box('features')}`}
    </div>
  </section>`
}

function SettingBox({ k, value, onSaved }) {
  const [draft, setDraft] = useState(() => toDraft(value))
  const [busy, setBusy] = useState(false)
  useEffect(() => setDraft(toDraft(value)), [JSON.stringify(value)])
  const saved = toDraft(value)
  const changed = FIELDS[k].map(([f]) => f).filter(f => draft[f] !== saved[f])
  const save = async () => {
    const body = {}
    for (const f of changed) body[f] = typeof draft[f] === 'boolean' ? draft[f] : String(draft[f]).replace(',', '.')
    setBusy(true)
    const r = await run(() => api.put(`/api/admin/settings/${k}`, { value: body }), SAVED[k])
    setBusy(false)
    if (r) { onSaved(r.value); load() } // créditos e limites novos valem na hora para o Estúdio
  }
  const p = k === 'pricing' ? Object.fromEntries(FIELDS.pricing.map(([f]) => [f, decimal(draft[f])])) : null
  const valid = p && Object.values(p).every(Number.isFinite)
  const cost = c => (p.credit_price_brl_cost > 0 ? ` (${money(c * p.credit_price_brl_cost * 100)} no Higgsfield)` : '')
  const ex = valid && { s15: partCredits(15, p), part: partCredits(29.7, p), ch: newCharacterCredits(p) }
  return html`<div class="stepbox">
    <div class="row"><span class="label grow">${TITLES[k]}</span>
      ${changed.length ? html`<button class="btn btn--xs btn--butter" disabled=${busy} onClick=${save}>${busy ? 'Salvando...' : 'Salvar'}</button>
        <button class="btn btn--xs btn--quiet" disabled=${busy} onClick=${() => setDraft(saved)}>Desfazer</button>` : null}</div>
    <div class="admin-grid">${FIELDS[k].map(([f, label, type, options]) => (type === 'bool'
      ? html`<${Toggle} key=${f} checked=${!!draft[f]} onChange=${v => setDraft({ ...draft, [f]: v })} label=${label} />`
      : type === 'choice'
      ? html`<label key=${f} class="field"><span class="small muted">${label}</span>
          <select class="input input--sm" value=${draft[f] || options[0][0]} onChange=${e => setDraft({ ...draft, [f]: e.target.value })}>
            ${options.map(([v, text]) => html`<option key=${v} value=${v}>${text}</option>`)}
          </select></label>`
      : html`<label key=${f} class="field"><span class="small muted">${label}</span>
          <input class="input input--sm" inputmode="decimal" value=${draft[f] ?? ''} onInput=${e => setDraft({ ...draft, [f]: e.target.value })} /></label>`))}</div>
    ${ex ? html`<span class="small dim">Com estes valores: um vídeo de 15 s usa ${credits(ex.s15)}${cost(ex.s15)}, uma parte de 29,7 s usa ${credits(ex.part)}${cost(ex.part)} e um personagem novo usa ${credits(ex.ch)}${cost(ex.ch)}. O aluno paga os mesmos créditos do Higgsfield; a sua margem está no preço dos pacotes.</span>` : null}
  </div>`
}

// Pacotes de créditos que o aluno compra (preço em reais). A ordem importa: a compra manda o número do pacote.
const MAX_PACKAGES = 12
const centsText = c => (Number(c) > 0 ? (Number(c) / 100).toFixed(2).replace('.', ',') : '')
const packRows = v => (Array.isArray(v) ? v : []).map(p => ({ credits: p?.credits != null ? String(p.credits) : '', price: centsText(p?.price_cents) }))

function PackagesBox({ value, cost, onSaved }) {
  const saved = packRows(value)
  const [rows, setRows] = useState(saved)
  const [busy, setBusy] = useState(false)
  useEffect(() => setRows(packRows(value)), [JSON.stringify(value)])
  const changed = JSON.stringify(rows) !== JSON.stringify(saved)
  const parsed = rows.map(r => ({ credits: parseCredits(r.credits), price_cents: parseMoney(r.price) }))
  const bad = parsed.findIndex(p => !(p.credits > 0) || !(p.price_cents > 0))
  const set = (i, field, v) => setRows(rows.map((r, j) => (j === i ? { ...r, [field]: v } : r)))
  const save = async () => {
    if (!rows.length) { toast('Deixe pelo menos um pacote para o aluno poder comprar créditos', 'err', 7000); return }
    if (bad >= 0) { toast(`Pacote ${bad + 1}: escreva os créditos (ex.: 1000) e o preço em reais (ex.: 250,00)`, 'err', 7000); return }
    setBusy(true)
    const r = await run(() => api.put('/api/admin/settings/credit_packages', { value: parsed }), 'Pacotes de créditos salvos')
    setBusy(false)
    if (r) { onSaved(r.value); load() } // a carteira dos alunos passa a mostrar os pacotes novos
  }
  return html`<div class="stepbox">
    <div class="row"><span class="label grow">Pacotes de créditos</span>
      ${changed ? html`<button class="btn btn--xs btn--butter" disabled=${busy} onClick=${save}>${busy ? 'Salvando...' : 'Salvar'}</button>
        <button class="btn btn--xs btn--quiet" disabled=${busy} onClick=${() => setRows(saved)}>Desfazer</button>` : null}</div>
    ${rows.map((r, i) => {
      const p = parsed[i]
      const each = p.credits > 0 && p.price_cents > 0 ? p.price_cents / p.credits : null
      const margin = each && cost > 0 ? Math.round((each / (cost * 100) - 1) * 100) : null
      return html`<div key=${i} class="row wrap" style="gap:8px">
        <label class="row small"><span class="muted">Créditos</span><input class="input input--sm" style="width:110px" inputmode="numeric" placeholder="1000" value=${r.credits} onInput=${e => set(i, 'credits', e.target.value)} /></label>
        <label class="row small"><span class="muted">Preço (R$)</span><input class="input input--sm" style="width:110px" inputmode="decimal" placeholder="250,00" value=${r.price} onInput=${e => set(i, 'price', e.target.value)} /></label>
        <span class="small dim grow">${each ? `${money(each)} por crédito${margin != null ? ` · ${margin >= 0 ? 'margem de' : 'abaixo do custo:'} ${Math.abs(margin)}% sobre o custo` : ''}` : 'preencha os dois campos'}</span>
        <button class="btn btn--xs btn--quiet" title="Tirar este pacote" onClick=${() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
      </div>`
    })}
    <div class="row wrap" style="gap:8px">
      <button class="btn btn--xs" disabled=${rows.length >= MAX_PACKAGES} onClick=${() => setRows([...rows, { credits: '', price: '' }])}>Adicionar pacote</button>
      <span class="small dim">${rows.length ? `O aluno vê os pacotes na carteira, nesta ordem (até ${MAX_PACKAGES}).` : 'Deixe pelo menos um pacote para o aluno poder comprar créditos.'}</span>
    </div>
  </div>`
}

// ------------------------------------------------------------ robô do Telegram
// O dono manda um vídeo (ou link) com a instrução para o robô e ele gera na conta de quem ligou, com o Higgsfield dela.
// Os segredos vão para o servidor e nunca voltam: os campos (tipo senha) começam sempre vazios e o painel mostra só
// "configurado" e os 4 últimos caracteres. autocomplete new-password (e os data-* dos gerenciadores de senha): o
// navegador não preenche ali a senha guardada do site. Rotas /api/admin/telegram* (src/api/admin.js).
const TG_ROWS = [
  {
    name: 'Token do robô', fields: [['token', 'token', 'Cole o token que o @BotFather mandou']],
    hint: 'No Telegram, fale com o @BotFather, mande /newbot e copie o token que ele responder. Para usar num grupo, mande também /setprivacy ao @BotFather, escolha o robô e Disable (senão ele só vê comandos no grupo).',
    link: ['https://t.me/BotFather', 'Abrir o BotFather'],
  },
  {
    name: 'Chave da API da Anthropic', fields: [['anthropic_key', 'chave', 'Cole a chave (começa com sk-ant-)']],
    hint: 'É a IA que lê as suas instruções. Crie a chave em console.anthropic.com, API Keys.',
    link: ['https://console.anthropic.com/settings/keys', 'Criar chave'],
  },
  {
    name: 'Arquivos grandes (opcional)', optional: true,
    fields: [['api_id', 'api_id', 'api_id (só números)'], ['api_hash', 'api_hash', 'api_hash (32 letras e números)']],
    hint: 'Com o api_id e o api_hash (my.telegram.org, API development tools) o robô recebe e envia arquivos até 2 GB. Sem eles, recebe até 20 MB e envia até 50 MB.',
    link: ['https://my.telegram.org/apps', 'Abrir my.telegram.org'],
  },
]
const TG_POLL_MS = 30000
const TG_POLL_CODE_MS = 4000 // com o código na tela: confere logo se o dono já mandou o /ligar
const hhmm = iso => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })

// "termina em abcd", "não configurado" ou "salvo com outro SESSION_SECRET"
function secretText(label, s) {
  if (!s?.set) return `${label}: não configurado`
  if (!s.readable) return `${label}: não abre neste servidor (SESSION_SECRET mudou), cole de novo`
  return `${label}: configurado, termina em ${s.last4}`
}

// Limite de arquivos do robô: 2 GB só com o servidor local em uso (active_mode); com o api_id/api_hash salvos e o
// servidor ainda não atendendo, diz isso em vez de prometer os 2 GB
function filesText(st) {
  const lim = st.file_limits_mb || { download: 20, upload: 50 }
  const active = st.active_mode === undefined ? st.mode : st.active_mode   // servidor antigo, sem o campo: o configurado
  if (active === 'local') return 'Arquivos até 2 GB (servidor local da Bot API)'
  const now = `recebe até ${lim.download} MB e envia até ${lim.upload} MB`
  return st.mode === 'local' ? `api_id e api_hash salvos, mas o servidor para arquivos grandes ainda não está atendendo (compilando, reiniciando ou desligado na instalação). Por enquanto ${now}.` : `Arquivos: ${now}`
}

// O robô gera com o Higgsfield próprio de quem está ligado (antes de ligar, de quem gera o código): sem ele, nada sai
function hfWarnText(st) {
  const h = st.higgsfield
  if (!h) return null
  const whose = h.for === 'owner' ? `da conta ${st.owner?.email || 'ligada'}` : 'da sua conta'
  if (!h.connected) return `O robô gera com o Higgsfield ${whose}, e ele não está conectado. Conecte no painel Higgsfield, acima, antes de mandar vídeos.`
  if (h.status === 'auth_error') return `O login do Higgsfield ${whose} venceu: o robô não consegue gerar. Conecte de novo no painel Higgsfield, acima.`
  return null
}

export function TelegramPanel() {
  const [st, setSt] = useState(null)
  const [error, setError] = useState(null)
  const [code, setCode] = useState(null) // { code, expires_at, at, bound } (bound = ligação de antes do código)
  const reload = async () => {
    try { setSt(await api.get('/api/admin/telegram')); setError(null) } catch (e) { setError(e.message) }
  }
  useEffect(() => { reload() }, [])
  useEffect(() => {
    const t = setInterval(reload, code ? TG_POLL_CODE_MS : TG_POLL_MS)
    return () => clearInterval(t)
  }, [!!code])
  // o dono mandou o /ligar (a ligação mudou depois do código) ou o servidor diz que o código não vale mais (venceu,
  // tentativas erradas demais ou desligado): o código sai da tela. A folga de 10 s ignora uma consulta que saiu antes
  // do código ser gerado e voltou depois.
  useEffect(() => {
    if (!code || !st) return
    if (st.owner?.bound_at && st.owner.bound_at !== code.bound) { setCode(null); toast('Robô ligado ao seu Telegram', 'ok', 6000) }
    else if (!st.bind && Date.now() - code.at > 10000) setCode(null)
  }, [st, code])

  if (!st) {
    return html`<section class="panel">
      <div class="panel__head"><h2 class="display panel__title">Robô do Telegram</h2></div>
      <div class="panel__body">${error ? html`<div class="warnbox">${error}</div>` : html`<${Spinner} />`}</div>
    </section>`
  }
  const tokenOk = st.secrets.token?.readable
  const keyOk = st.secrets.anthropic_key?.readable
  const user = st.bot.username ? `@${st.bot.username}` : 'o robô'
  const hint = !tokenOk ? 'falta o token do robô'
    : st.bot.running ? `rodando${st.bot.username ? ` · @${st.bot.username}` : ''}`
      : st.bot.seen_at ? `parado (visto pela última vez ${ago(st.bot.seen_at)})` : 'o processo do robô ainda não rodou'
  return html`<section class="panel">
    <div class="panel__head"><h2 class="display panel__title">Robô do Telegram</h2><span class="panel__hint">${hint}</span></div>
    <div class="panel__body stack">
      <span class="small muted">Mande para o robô, no privado ou num grupo com ele, um vídeo (arquivo ou link do TikTok ou do Instagram) com a instrução na mesma mensagem, por exemplo "Vector no lugar do cara de camiseta azul, sem áudio". Ele gera a troca na sua conta, com o seu Higgsfield, e devolve o vídeo no chat. Só você manda gerar: mensagens de outras pessoas são ignoradas.</span>
      ${tokenOk && !keyOk ? html`<div class="warnbox">Falta a chave da API da Anthropic: sem ela o robô não entende as instruções.</div>` : null}
      ${hfWarnText(st) ? html`<div class="warnbox hf-warn"><span>${hfWarnText(st)}</span>${st.higgsfield.for === 'you' ? html`<span class="hf-actions"><a class="btn btn--sm btn--butter" href="#/config" onClick=${goToHiggsfieldPanel}>Ir para o Higgsfield</a></span>` : null}</div>` : null}
      <div class="keys">
        ${TG_ROWS.map(row => html`<${TelegramSecretRow} key=${row.name} row=${row} st=${st} onSaved=${setSt} />`)}
        <${TelegramModelRow} st=${st} onSaved=${setSt} />
      </div>
      <${TelegramBindBox} st=${st} code=${code} user=${user} onCode=${setCode} onSaved=${setSt} />
    </div>
  </section>`
}

function TelegramSecretRow({ row, st, onSaved }) {
  const [vals, setVals] = useState({})
  const [busy, setBusy] = useState(false)
  const info = row.fields.map(([f]) => st.secrets[f])
  const on = info.every(s => s?.readable)
  const dirty = row.fields.some(([f]) => (vals[f] || '').trim())
  const save = async () => {
    const body = Object.fromEntries(row.fields.map(([f]) => [f, (vals[f] || '').trim()]).filter(([, v]) => v))
    if (!Object.keys(body).length) return
    setBusy(true)
    const r = await run(() => api.put('/api/admin/telegram', body), `${row.name.replace(/ \(opcional\)$/, '')}: salvo no servidor`)
    setBusy(false)
    if (r) { setVals({}); onSaved(r) } // o campo volta vazio: o valor salvo nunca aparece de novo
  }
  const clear = async () => {
    if (!(await confirmDialog(`Apagar ${row.fields.map(([, label]) => label).join(' e ')} do servidor?`, { ok: 'Apagar' }))) return
    setBusy(true)
    const r = await run(() => api.put('/api/admin/telegram', Object.fromEntries(row.fields.map(([f]) => [f, null]))), 'Apagado do servidor')
    setBusy(false)
    if (r) onSaved(r)
  }
  return html`<div class="key">
    <div>
      <div class="key__name"><span class=${`dot ${on ? 'is-on' : ''}`}></span>${row.name}</div>
      ${row.fields.map(([f, label]) => html`<div key=${f} class="small dim tg-secret">${secretText(label, st.secrets[f])}</div>`)}
    </div>
    <div class="stack" style="gap:6px">
      ${row.fields.map(([f, label, ph]) => html`<input key=${f} class="input input--sm" type="password" autocomplete="new-password" data-1p-ignore data-lpignore="true" spellcheck="false"
        aria-label=${label} placeholder=${st.secrets[f]?.set ? `${label} já salvo (cole outro para trocar)` : ph} value=${vals[f] || ''}
        onInput=${e => { const v = e.target.value; setVals(old => ({ ...old, [f]: v })) }} onKeyDown=${e => { if (e.key === 'Enter') save() }} />`)}
      <span class="small dim">${row.hint}</span>
    </div>
    <div class="row wrap" style="gap:6px;justify-content:flex-end">
      ${dirty ? html`<button class="btn btn--sm btn--butter" disabled=${busy} onClick=${save}>${busy ? 'Salvando...' : 'Salvar'}</button>` : null}
      ${row.optional && info.some(s => s?.set) ? html`<button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${clear}>Apagar</button>` : null}
      <a class="btn btn--sm btn--quiet" href=${row.link[0]} target="_blank" rel="noopener">${row.link[1]} ↗</a>
    </div>
  </div>`
}

function TelegramModelRow({ st, onSaved }) {
  const [model, setModel] = useState(st.model)
  const [busy, setBusy] = useState(false)
  useEffect(() => setModel(st.model), [st.model])
  const dirty = model.trim() !== st.model
  const save = async () => {
    setBusy(true)
    const r = await run(() => api.put('/api/admin/telegram', { model: model.trim() }), 'Modelo da IA salvo')
    setBusy(false)
    if (r) onSaved(r)
  }
  return html`<div class="key">
    <div>
      <div class="key__name"><span class=${`dot ${st.secrets.anthropic_key?.readable ? 'is-on' : ''}`}></span>Modelo da IA</div>
      <div class="small dim">${filesText(st)}</div>
    </div>
    <div class="stack" style="gap:6px">
      <input class="input input--sm" spellcheck="false" autocomplete="off" aria-label="Modelo da IA" placeholder=${st.default_model} value=${model}
        onInput=${e => setModel(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter' && dirty) save() }} />
      <span class="small dim">Modelo da Anthropic que lê as instruções. Padrão: ${st.default_model}.</span>
    </div>
    <div class="row wrap" style="gap:6px;justify-content:flex-end">
      ${dirty ? html`<button class="btn btn--sm btn--butter" disabled=${busy} onClick=${save}>${busy ? 'Salvando...' : 'Salvar'}</button>
        <button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${() => setModel(st.model)}>Desfazer</button>` : null}
    </div>
  </div>`
}

function TelegramBindBox({ st, code, user, onCode, onSaved }) {
  const [busy, setBusy] = useState(false)
  const o = st.owner
  const generate = async () => {
    setBusy(true)
    const r = await run(() => api.post('/api/admin/telegram/code'))
    setBusy(false)
    if (r) { onCode({ code: r.code, expires_at: r.expires_at, at: Date.now(), bound: o?.bound_at || null }); onSaved(r.state) }
  }
  const unbind = async () => {
    if (!(await confirmDialog('Desligar o robô do seu Telegram? Ele para de obedecer e cancela os pedidos que ainda estão na fila dele, até você mandar um código novo.', { ok: 'Desligar' }))) return
    setBusy(true)
    const r = await run(() => api.post('/api/admin/telegram/unbind'), 'Robô desligado')
    setBusy(false)
    if (r) { onCode(null); onSaved(r) }
  }
  const copy = () => globalThis.navigator?.clipboard?.writeText(`/ligar ${code.code}`).then(() => toast('Comando copiado', 'ok'), () => {})
  return html`<div class="stepbox">
    <div class="row"><span class="label grow">Ligação com o seu Telegram</span>${o ? html`<${Badge} kind="mint">ligado</${Badge}>` : html`<${Badge}>não ligado</${Badge}>`}</div>
    ${o ? html`<span class="small tg-owner">Obedece só ao usuário do Telegram <b>${o.telegram_user_id}</b>${o.email ? ` e gera na conta ${o.email}` : ''} · ${plural(o.chats, 'chat liberado', 'chats liberados')} · ligado ${ago(o.bound_at)}</span>`
      : html`<span class="small muted">Enquanto não estiver ligado, o robô ignora todo mundo. Gere o código e mande para ele.</span>`}
    ${code ? html`<div class="tg-code">
        <b class="tg-code__num">${code.code}</b>
        <span class="small tg-code__text">Mande <b>/ligar ${code.code}</b> para ${user}, no privado ou no grupo. Vale até ${hhmm(code.expires_at)} e só uma vez.</span>
        ${globalThis.navigator?.clipboard ? html`<button class="btn btn--xs" onClick=${copy}>Copiar comando</button>` : null}
      </div>` : null}
    <div class="row wrap" style="gap:6px">
      <button class="btn btn--sm btn--butter" disabled=${busy || !st.secrets.token?.readable} title=${st.secrets.token?.readable ? '' : 'Cole o token do robô primeiro'} onClick=${generate}>${code ? 'Gerar outro código' : 'Gerar código de ligação'}</button>
      ${o ? html`<button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${unbind}>Desligar</button>` : null}
    </div>
  </div>`
}

// ------------------------------------------------------------ Google Drive do dono
// Cada vídeo que fica pronto na conta de quem está na lista sobe sozinho para uma pasta do Google Drive do dono
// (src/worker/drive.js, pelo rclone). A conexão com o Google é feita uma vez, no Terminal do Mac, com o comando que o
// painel mostra: o token fica só no servidor (a rota diz apenas se a conexão existe). "Enviar também os antigos"
// pergunta aqui mesmo, dentro do painel. Rotas /api/admin/drive* (src/api/admin.js).
const DRIVE_POLL_MS = 30000
const dateTime = iso => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
const mbText = bytes => `${(Number(bytes) / (1024 * 1024)).toFixed(1).replace('.', ',')} MB`
const andText = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`)

// Situação curta (no topo do painel)
export function driveHint(st) {
  if (!st.connected) return 'não conectado'
  if (st.auth_error) return 'o Google pediu login de novo'
  if (!st.config.enabled) return 'conectado · envio desligado'
  if (!st.worker.running) return 'conectado · envio parado'
  return 'conectado · enviando sozinho'
}

// Desde quando: data e hora, ou todos (o "Enviar também os antigos" grava 1970)
export function driveSinceText(since) {
  if (!since) return 'a partir de quando você ligar'
  if (new Date(since).getUTCFullYear() < 2000) return 'todos os vídeos prontos (também os de antes da conexão)'
  return `os vídeos prontos desde ${dateTime(since)}`
}

// Um envio da lista: [texto, cor]. eligible false: o e-mail saiu da lista (o envio não vai mais, sem ser erro)
export function uploadStatusOf(r, max = 8) {
  if (r.status === 'done') return ['enviado', 'mint']
  if (r.status === 'uploading') return ['enviando', '4k']
  if (r.status === 'pending') return r.eligible === false ? ['fora da lista', ''] : ['na fila', '']
  if (r.status === 'skipped') return ['pulado', '']
  if (r.status === 'failed') return r.attempts >= max ? [`desistiu depois de ${r.attempts} tentativas`, 'red'] : [`tentativa ${r.attempts} de ${max} falhou`, 'coral']
  return [r.status, '']
}

// Pausa sem culpa dos vídeos (eles esperam sem gastar tentativa): rede na renovação do acesso ou limite da conta
export function drivePauseText(p) {
  if (!p) return null
  const hour = p.until ? new Date(p.until).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null
  if (p.kind === 'limite') return `O Google limitou os envios desta conta (até 750 GB por dia). Os vídeos esperam sem gastar tentativa e o envio continua sozinho${hour ? ` a partir das ${hour}` : ''}.`
  return `O servidor não conseguiu falar com o Google${p.at ? ` (${ago(p.at)})` : ''}. Não é login vencido: o envio continua sozinho${hour ? ` a partir das ${hour}` : ' em alguns minutos'}.`
}

// Copia pelo navigator.clipboard; sem ele (http, navegador antigo), por um campo escondido e execCommand('copy')
export async function copyText(text) {
  try {
    if (globalThis.navigator?.clipboard?.writeText) { await globalThis.navigator.clipboard.writeText(text); return true }
  } catch {}
  try {
    const doc = globalThis.document
    const ta = doc.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    doc.body.appendChild(ta)
    ta.select()
    const ok = doc.execCommand('copy')
    ta.remove()
    return !!ok
  } catch {
    return false
  }
}

export function DrivePanel() {
  const [st, setSt] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState(null)     // { emails, folder } enquanto edita (null = o que está salvo)
  const [askOld, setAskOld] = useState(false)  // pergunta do "Enviar também os antigos", dentro do painel
  const reload = async () => {
    try { setSt(await api.get('/api/admin/drive')); setError(null) } catch (e) { setError(e.message) }
  }
  useEffect(() => {
    reload()
    const t = setInterval(reload, DRIVE_POLL_MS)
    return () => clearInterval(t)
  }, [])

  if (!st) {
    return html`<section class="panel">
      <div class="panel__head"><h2 class="display panel__title">Google Drive</h2></div>
      <div class="panel__body">${error ? html`<div class="warnbox">${error}</div>` : html`<${Spinner} />`}</div>
    </section>`
  }
  const cfg = st.config
  const c = st.counts
  const on = cfg.enabled
  const saved = { emails: cfg.emails.join(', '), folder: cfg.folder }
  const cur = draft || saved
  const changed = ['emails', 'folder'].filter(f => cur[f].trim() !== saved[f])
  const who = cfg.emails.length ? andText(cfg.emails) : 'ninguém (escreva o seu e-mail abaixo)'
  const act = async (fn, ok, after) => {
    setBusy(true)
    const r = await run(fn, ok)
    setBusy(false)
    if (r) { setSt(r); after?.() }
    return r
  }
  const edit = (f, v) => setDraft(d => ({ ...(d || saved), [f]: v }))
  const edits = () => Object.fromEntries(changed.map(f => [f, cur[f].trim()]))
  const save = () => act(() => api.put('/api/admin/drive', edits()), 'Google Drive: salvo', () => setDraft(null))
  // Ligar leva junto o que foi digitado e ainda não salvo (e-mail e pasta)
  const toggle = () => (on
    ? act(() => api.put('/api/admin/drive', { enabled: false }), 'Envio ao Drive desligado')
    : act(() => api.put('/api/admin/drive', { ...edits(), enabled: true }), 'Envio ao Drive ligado', () => setDraft(null)))
  const retry = async () => {
    const r = await act(() => api.post('/api/admin/drive/retry'))
    if (r) toast(r.retried ? `${plural(r.retried, 'vídeo voltou', 'vídeos voltaram')} para a fila do Drive` : 'Nenhum envio com erro para tentar de novo', 'ok')
  }
  const backfill = () => act(() => api.post('/api/admin/drive/backfill'), 'Os vídeos antigos também vão para o Drive', () => setAskOld(false))
  const copy = async () => {
    if (await copyText(st.connect_command)) toast('Comando copiado: cole no Terminal do seu Mac', 'ok')
    else toast('Não consegui copiar sozinho: toque no comando, selecione tudo e copie', 'err', 7000)
  }
  const allOld = !!cfg.since && new Date(cfg.since).getUTCFullYear() < 2000
  return html`<section class="panel drive">
    <div class="panel__head"><h2 class="display panel__title">Google Drive</h2><span class="panel__hint">${driveHint(st)}</span></div>
    <div class="panel__body stack">
      <span class="small muted">Cada vídeo que fica pronto na sua conta sobe sozinho para uma pasta do seu Google Drive, no arquivo original, com a data, o personagem e o nome do vídeo no nome do arquivo.</span>
      ${st.auth_error ? html`<div class="warnbox drive-warn">O Google pediu login de novo${st.auth_error.at ? ` (${ago(st.auth_error.at)})` : ''}: os envios estão parados. Conecte de novo: rode outra vez o comando abaixo e autorize com a mesma conta Google.</div>` : null}
      ${!st.connected ? html`<div class="warnbox drive-warn">O Google Drive ainda não está conectado. Rode o comando abaixo no Terminal do seu Mac e siga o que ele pedir.</div>` : null}
      ${st.pause && !st.auth_error ? html`<span class="small dim drive-text">${drivePauseText(st.pause)}</span>` : null}
      ${st.connected && on && !st.worker.running ? html`<div class="warnbox drive-warn">${st.worker.seen_at ? `O envio está parado (o processo foi visto pela última vez ${ago(st.worker.seen_at)}).` : 'O processo de envio ainda não rodou.'} Rode o deploy de novo ou veja o log: journalctl -u character-drive.</div>` : null}
      <div class="stepbox">
        <div class="row"><span class="label grow">Envio automático</span>${on ? html`<${Badge} kind="mint">ligado</${Badge}>` : html`<${Badge}>desligado</${Badge}>`}</div>
        <span class="small drive-text">${on
          ? `Vão para a pasta "${cfg.folder}" ${driveSinceText(cfg.since)} de ${who}.`
          : 'Desligado: nenhum vídeo vai para o Drive.'}</span>
        <div class="admin-grid">
          <label class="field"><span class="small muted">E-mails cujos vídeos vão para o Drive (separe por vírgula)</span>
            <input class="input input--sm" type="text" inputmode="email" autocomplete="off" spellcheck="false" aria-label="E-mails" value=${cur.emails}
              onInput=${e => edit('emails', e.target.value)} /></label>
          <label class="field"><span class="small muted">Pasta no Drive (subpasta: Pasta/Subpasta)</span>
            <input class="input input--sm" type="text" autocomplete="off" spellcheck="false" aria-label="Pasta no Drive" value=${cur.folder}
              onInput=${e => edit('folder', e.target.value)} /></label>
        </div>
        <span class="small dim drive-text">O app cria a pasta sozinho no seu Drive. Uma pasta com o mesmo nome criada por você, à mão, não é usada: o app só enxerga o que o rclone criou.</span>
        <div class="row wrap drive-actions">
          ${changed.length ? html`<button class="btn btn--sm btn--butter" disabled=${busy} onClick=${save}>Salvar</button>
            <button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${() => setDraft(null)}>Desfazer</button>` : null}
          ${on
            ? html`<button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${toggle}>Desligar</button>`
            : html`<button class="btn btn--sm btn--butter" disabled=${busy || !cur.emails.trim()} title=${cur.emails.trim() ? '' : 'Escreva pelo menos um e-mail'} onClick=${toggle}>Ligar</button>`}
        </div>
      </div>
      <div class="stepbox">
        <span class="label">Envios</span>
        <div class="row wrap small muted drive-counts">
          <span>${on ? 'Na fila' : 'Esperando'} <b class="pixel">${c.pending}</b></span>
          <span>Enviando <b class="pixel">${c.uploading}</b></span>
          <span>Enviados <b class="pixel">${c.done}</b></span>
          <span>Com erro <b class="pixel">${c.failed}</b></span>
          ${c.skipped ? html`<span>Pulados <b class="pixel">${c.skipped}</b></span>` : null}
        </div>
        ${c.failed ? html`<span class="small dim drive-text">${[
          c.retrying ? `${plural(c.retrying, 'vídeo tenta', 'vídeos tentam')} de novo sozinho.` : '',
          c.gave_up ? `${plural(c.gave_up, 'vídeo desistiu', 'vídeos desistiram')} depois de ${st.max_attempts} tentativas.` : '',
        ].filter(Boolean).join(' ')}</span>` : null}
        <div class="row wrap drive-actions">
          ${c.failed ? html`<button class="btn btn--sm" disabled=${busy} onClick=${retry}>Tentar de novo os com erro</button>` : null}
          ${!allOld && !askOld ? html`<button class="btn btn--sm btn--quiet" disabled=${busy || !cfg.emails.length} onClick=${() => setAskOld(true)}>Enviar também os antigos</button>` : null}
        </div>
        ${askOld ? html`<div class="drive-ask">
          <span class="small drive-text">Mandar para o Drive também os vídeos que já estavam prontos de ${who} e ainda não foram? Pode levar um tempo e ocupar espaço no seu Drive. Os que já foram não se repetem.</span>
          <div class="row wrap drive-actions">
            <button class="btn btn--sm btn--butter" disabled=${busy} onClick=${backfill}>Sim, enviar os antigos</button>
            <button class="btn btn--sm btn--quiet" disabled=${busy} onClick=${() => setAskOld(false)}>Cancelar</button>
          </div>
        </div>` : null}
        ${st.recent.length ? html`<div class="drive-list">${st.recent.map(r => {
          const [label, kind] = uploadStatusOf(r, st.max_attempts)
          return html`<div key=${r.take_id} class="drive-item">
            <div class="drive-item__name">${r.name || 'vídeo'}</div>
            <div class="row wrap small dim drive-item__meta"><${Badge} kind=${kind}>${label}</${Badge}><span>${ago(r.at)}</span>${r.bytes ? html`<span>${mbText(r.bytes)}</span>` : null}</div>
            ${r.error && r.status !== 'done' ? html`<div class="small drive-item__err">${r.error}</div>` : null}
          </div>`
        })}</div>` : html`<div class="empty"><b>Nenhum envio ainda</b><span>Os vídeos aparecem aqui quando começam a subir para o Drive.</span></div>`}
      </div>
      <div class="stepbox">
        <div class="row"><span class="label grow">${st.connected ? 'Conectar de novo ou trocar a conta Google' : 'Conectar o Google Drive'}</span>${st.connected ? html`<${Badge} kind="mint">conectado</${Badge}>` : html`<${Badge}>não conectado</${Badge}>`}</div>
        <ol class="small muted drive-steps">
          <li>No seu Mac, abra o Terminal, cole o comando abaixo e aperte Enter.</li>
          <li>Abra no navegador o link que aparecer (começa com http://127.0.0.1:53682), entre na conta Google onde quer os vídeos e autorize.</li>
          <li>Volte ao Terminal: ele testa a conexão, liga o envio (mantém os e-mails e a pasta daqui) e avisa quando estiver pronto.</li>
        </ol>
        <code class="drive-cmd">${st.connect_command}</code>
        <div class="row wrap drive-actions">
          <button class="btn btn--sm btn--butter" onClick=${copy}>Copiar comando</button>
          <span class="small dim drive-text">No seu Drive, o servidor só enxerga os arquivos criados pelo rclone (o programa que envia os vídeos) nesta conta Google: o resto continua invisível para ele.</span>
        </div>
      </div>
    </div>
  </section>`
}
