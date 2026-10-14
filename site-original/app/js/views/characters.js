// Personagens: biblioteca, ficha do personagem e criação de imagem (GPT Image e outros).
import { useState, useRef, useEffect } from 'preact/hooks'
import { html, credits, Badge, Modal, Seg, Spinner, modelBadges, plural, useDraft, confirmDialog, ago } from '../ui.js'
import { S, useStore, load, characterById, modelById, showLightbox, toast, loadPref, savePref, projectById, projectChars, castIds, newestFirst, isAdmin, modelImageCredits, higgsfield, upsertJob, dropJob } from '../state.js'
import { api, uploadFile } from '../api.js'
import { run, uploadCharacterImages, isImage } from '../actions.js'
import { higgsfieldBlock, higgsfieldErrorOf, ownBudgetText, noCreditsText, liveHiggsfieldError, higgsfieldFree } from '../cloud.js'
// Character Online: o aviso de plano do Higgsfield (higgsfieldPlanWarn) pelo módulo inteiro: sem ele, a tela fica como antes
import * as cloud from '../cloud.js'
import { HiggsfieldWarn, HiggsfieldActions, higgsfieldErrorState, runHf, cancelJob } from './account.js'

export const coverOf = c => c && (c.images.find(i => i.id === c.cover) || c.images[0])

const byRank = (a, b) => (b.configured - a.configured) || (a.rank - b.rank)
const imageModels = () => S.models.filter(m => m.step === 'image_gen').sort(byRank)

const TEMPLATE_OPTS = [
  { value: 'card', label: 'Face card amarelo' },
  { value: 'sheet', label: 'Ficha completa' },
  { value: 'fullbody', label: 'Corpo inteiro' },
  { value: 'free', label: 'Livre' },
]

// Mesmo método dos 29 face cards aprovados: um card da Série Amarela entra como âncora de ESTILO
// (luz, fundo, enquadramento, acabamento), nunca de identidade.
const STYLE_LINE = 'Reference image 1 is ONLY the style anchor: match its soft studio light, solid butter-yellow background, three-quarter bust framing, camera angle and premium photographic finish. Never copy its identity, face, hair, moustache or clothes. '
export const styleAnchor = () => {
  const c = S.characters.find(x => x.code === 'CS004') || S.characters.find(x => x.source === 'Série Amarela')
  const img = c && (c.images.find(i => i.id === c.cover) || c.images[0])
  return img ? { characterId: c.id, imageId: img.id, url: img.thumbUrl } : null
}

function fillT(key, identity, name) {
  if (key === 'free') return identity
  const t = S.templates[key] || ''
  return t.replaceAll('{identity}', identity.trim() || '...').replaceAll('{name}', name || 'the character')
}

// ------------------------------------------------------------ Character Online: opções do card e vistas
// Como no app antigo: "Gerar" pede N opções do card (1 a 4) e o aluno salva as que quiser; nada vira personagem
// sozinho. As vistas para vídeo (frente, perfil e 3/4 direita) saem depois, a partir do card escolhido, na ficha.
export const RECENT_MS = 48 * 3600 * 1000 // pedidos de imagem não salvos voltam ao abrir o criador por 48 h
const active = j => j.status === 'running' || j.status === 'queued'
const cardJob = j => j.kind === 'image' && j.subkind !== 'views'
// opções de um pedido: as prontas (na ordem das opções), as que falharam e as que ainda faltam
export function optionsOf(j) {
  const ready = j.outputs?.imageUrls || []
  const total = Math.max(Number(j.input?.n) || 1, ready.length)
  const failed = active(j) || j.status === 'done' ? Math.min(Number(j.outputs?.failed) || 0, total - ready.length) : total - ready.length
  return { ready, total, failed, waiting: active(j) ? total - ready.length - failed : 0 }
}
// opções que ainda dá para salvar (prontas ou a caminho)
export function unsavedOptions(j) {
  const o = optionsOf(j)
  return Math.max(0, o.ready.length + o.waiting - (j.savedImages || []).length)
}
// Pedidos de opções do card dos últimos 2 dias com opção ainda não salva, do criador de personagem novo (ou do
// "Novas imagens" deste personagem), do mais novo para o mais velho
export function unsavedImageJobs(characterId = null, now = Date.now()) {
  return S.jobs
    .filter(j => cardJob(j) && (j.input?.characterId || null) === (characterId || null) && now - new Date(j.createdAt).getTime() < RECENT_MS)
    .filter(j => (active(j) || j.status === 'done') && unsavedOptions(j) > 0)
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
}
// nome do personagem no título do pedido ("Imagem · Archibald"); sem nome, vazio
const jobName = j => { const t = String(j?.title || '').replace(/^Imagem\s*·\s*/i, '').trim(); return /^novo personagem$/i.test(t) ? '' : t }
// Character Online: pedido barrado pelo plano da conta Higgsfield (Free ou teste grátis): tentar de novo igual não
// passa; o aviso traz Assinar e Já assinei (no teste grátis, Abrir higgsfield.ai: a conferência não muda o plano lido)
export const planError = j => j?.errorKind === 'plan' || j?.errorKind === 'trial'
// O card sai da descrição e das imagens de referência anexadas: o app não abre links nem perfis (o aluno colava o link
// e escrevia "igual à foto"; agora a foto vai em Imagens de referência)
export const DESCRIBE_TIP = 'O personagem sai da sua descrição e das imagens de referência que você anexar. O app não abre links nem perfis. Não cite nomes de personagens famosos nem de pessoas reais: o Higgsfield costuma recusar, e personagem famoso pode ser barrado na hora do vídeo. Descreva cabelo, rosto, roupa e cores.'
export const LINK_TEXT = 'O app não abre links nem perfis com @. Para usar uma foto ou um desenho, anexe a imagem em Imagens de referência. Enviando mesmo assim.'

// Character Online: imagens de referência do aluno (foto, desenho ou print de quem é o personagem): até 3 por pedido,
// JPG, PNG ou WEBP de até 10 MB (o servidor confere de novo, pelos bytes). Vão depois da âncora de estilo da Série
// Amarela, que continua dando a luz, o fundo e o enquadramento.
export const REF_MAX = 3
export const REF_MAX_MB = 10
export const REF_TIP = 'Foto, desenho ou print de quem é o personagem: o rosto, o cabelo, as cores e a roupa saem dela, e ele vira uma pessoa de verdade no estilo da Série Amarela. JPG, PNG ou WEBP, até 10 MB cada. O Higgsfield costuma recusar personagem famoso e gente famosa.'
const REF_BAD_TYPE = 'envie uma imagem em JPG, PNG ou WEBP.'
export const isRefImage = f => /^image\/(jpeg|png|webp)$/i.test(f?.type || '') || (!f?.type && /\.(jpe?g|png|webp)$/i.test(f?.name || ''))
export const hasLink = t => /https?:\/\/|www\.|@/i.test(String(t || ''))

export const VIEW_ROLES = ['front', 'profile', 'right']
const VIEW_NAMES = { front: 'frente', profile: 'perfil', right: '3/4 direita' }
// Vistas que faltam: o servidor manda (missingViews); sem isso, pelas imagens do personagem. Biblioteca já vem com elas.
export const missingViews = c => (!c || c.library ? [] : Array.isArray(c.missingViews) ? c.missingViews : VIEW_ROLES.filter(r => !c.images.some(i => i.role === r)))
// Créditos das vistas que faltam: o do servidor (viewsCredits) ou uma imagem do GPT Image por vista
export function viewsCredits(c) {
  const miss = missingViews(c)
  return miss.length ? Number(c.viewsCredits) || miss.length * modelImageCredits(imageModels()[0]) : 0
}
// vistas sendo geradas agora para este personagem
export const viewsBusy = c => c?.status === 'generating' || S.jobs.some(j => j.kind === 'image' && j.subkind === 'views' && j.input?.characterId === c?.id && active(j))
const listText = l => (l.length > 1 ? `${l.slice(0, -1).join(', ')} e ${l[l.length - 1]}` : l[0] || '')

// Character Online: corpo inteiro (opcional, nunca por padrão): uma imagem da cabeça aos pés, depois do card e das 3
// vistas, só nos personagens do aluno. Preço de uma imagem do GPT Image (o mesmo character_image_credits do servidor).
export const BODY_ROLE = 'fullbody'
export const BODY_TIP = 'Opcional: uma foto da cabeça aos pés, com a mesma roupa e a parte de baixo combinando. Ajuda quando o vídeo mostra pernas e sapatos.'
export const bodyCredits = () => modelImageCredits(imageModels()[0])
export const hasBody = c => !!c?.images?.some(i => i.role === BODY_ROLE)
// pode pedir o corpo inteiro: personagem do aluno com o card e as 3 vistas, ainda sem o corpo inteiro
export const canBody = c => !!c && !c.library && c.images.some(i => i.role === 'card') && VIEW_ROLES.every(r => c.images.some(i => i.role === r)) && !hasBody(c)
// último pedido de corpo inteiro deste personagem (vistas com o papel fullbody)
export const bodyJobOf = c => S.jobs
  .filter(j => j.kind === 'image' && j.subkind === 'views' && j.input?.characterId === c?.id && (j.input?.roles || []).includes(BODY_ROLE))
  .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))[0] || null

// Pergunta antes de gerar as vistas, com o que falta e o preço (na conta própria, dos créditos do Higgsfield do aluno)
export function askViews(chars) {
  const list = chars.filter(c => missingViews(c).length)
  const total = list.reduce((n, c) => n + viewsCredits(c), 0)
  const what = list.length === 1
    ? `as vistas para vídeo de ${list[0].name} (${listText(missingViews(list[0]).map(r => VIEW_NAMES[r] || r))}) a partir do card`
    : `as vistas para vídeo de ${list.length} personagens (frente, perfil e 3/4 direita) a partir do card de cada um`
  const cost = total ? ` Usa ${credits(total)}${higgsfield()?.mode === 'own' ? ' do seu Higgsfield' : ''}.` : ''
  return confirmDialog(`Gerar ${what}?${cost} O vídeo já funciona só com o card; com as vistas o Higgsfield acerta mais o personagem.`, { ok: 'Gerar vistas', danger: false, no: 'Voltar' })
}

// ------------------------------------------------------------ criar imagens
export function CharacterCreator({ onClose, onSaved, character = null }) {
  useStore()
  const models = imageModels()
  const [name, setName] = useState(character?.name || '')
  const [identity, setIdentity] = useState(character?.identityEn || character?.description || '')
  const [tpl, setTpl] = useState('free') // Character Online: o servidor monta o card (Série Amarela) a partir da descrição
  const [custom, setCustom] = useState(null)
  const [refs, setRefs] = useState(() => {
    const cv = coverOf(character)
    return cv ? [{ characterId: character.id, imageId: cv.id, url: cv.thumbUrl }] : []
  })
  const [modelId, setModelId] = useState(() => loadPref('creatorModel', null) || models.find(m => m.configured)?.id || models[0]?.id)
  const [opts, setOpts] = useState({})
  const [useStyle, setUseStyle] = useState(!character)
  // Character Online: pedidos recentes ainda não salvos voltam ao abrir (fechar a janela não perde as opções)
  const [earlier] = useState(() => unsavedImageJobs(character?.id).map(j => j.id))
  const [jobIds, setJobIds] = useState(earlier)
  const [savedTo, setSavedTo] = useState(character?.id || null)
  const [picking, setPicking] = useState(false)
  // quantas opções do card (1 a 4, padrão 2, lembrado). Chave nova: a versão anterior gravava 4 em creatorN sem escolha
  const [nPref, setN] = useState(() => loadPref('creatorOptions', 2))
  const fileRef = useRef(null)
  const m = modelById(modelId)
  const maxN = Math.max(1, Number(m?.limits?.images) || 4)
  const n = Math.min(maxN, Math.max(1, Math.round(Number(nPref)) || 2))
  const anchor = useStyle && tpl === 'card' ? styleAnchor() : null
  const prompt = custom ?? ((anchor ? STYLE_LINE : '') + fillT(tpl, identity, name))
  // Character Online: conta Higgsfield do aluno: orçamento nos créditos dela e aviso de conectar / sem créditos
  const [hfErr, setHfErr] = useState(null)
  // Character Online: imagens de referência do aluno ({ key, id, url, thumbUrl, name, busy }), enviadas ao anexar
  const [refImgs, setRefImgs] = useState([])
  const refFileRef = useRef(null)
  const hf = higgsfield()
  const own = hf?.mode === 'own'
  // créditos livres (saldo menos a fila, quando o servidor manda) e o saldo da conta (o número do chip da barra)
  const hfHave = own ? higgsfieldFree(hf) : null
  const hfBalance = own ? hf.credits ?? null : null
  const unit = modelImageCredits(m) // créditos de uma opção
  const need = unit * n
  // conta no plano Free do Higgsfield: o Gerar fica desligado com o aviso de assinar (só imagem; o vídeo continua)
  const hfBlock = higgsfieldBlock(hf, { images: true })
  // o aviso do erro some quando a conta volta (conectar) ou o saldo sobe (créditos); aí vale a conta de agora.
  // Teste grátis ou outro plano que o Higgsfield pode recusar: aviso sem travar
  const hfWarn = hfBlock || liveHiggsfieldError(hfErr, hf) || cloud.higgsfieldPlanWarn?.(hf)
    || (own && need && hfHave != null && hfHave < need ? { kind: 'no_credits', text: noCreditsText(need, hfHave, hfBalance, { unit, n }) } : null)
  // trava de envio: o clique duplo no Gerar criava dois pedidos (a trava vale já no clique; o botão desliga no quadro seguinte)
  const [sending, setSending] = useState(false)
  const lock = useRef(false)

  async function generate() {
    if (!m) return
    if (lock.current) return
    setHfErr(null)
    if (hfBlock) return
    if (!m.configured) { toast(`Falta a chave do ${m.providerLabel}. Abra Configurações.`, 'err'); return }
    if (!prompt.trim()) { toast('Descreva o personagem', 'err'); return }
    if (refImgs.some(r => r.busy)) { toast('Espere as imagens de referência terminarem de enviar.', 'warn'); return }
    savePref('creatorModel', modelId); savePref('creatorOptions', n); savePref('creatorTpl', tpl)
    // link, foto ou perfil no texto: avisa e envia mesmo assim
    if (hasLink(`${name} ${custom ?? identity}`)) toast(LINK_TEXT, 'warn', 9000)
    let job = null
    lock.current = true
    setSending(true)
    try {
      job = await api.post('/api/images', {
        model: modelId, prompt, n, opts, title: `Imagem · ${name || 'novo personagem'}`,
        refs: [...(anchor ? [anchor] : []), ...refs].map(r => (r.path ? { path: r.path } : { characterId: r.characterId, imageId: r.imageId })),
        characterId: character?.id, // "Novas imagens" de um personagem: o pedido volta só no criador dele
        expected_credits: need || undefined, // Character Online: os créditos que a tela mostrou (n opções)
        referenceIds: refImgs.filter(r => r.id).map(r => r.id).slice(0, REF_MAX), // Character Online: imagens do aluno
      })
    } catch (e) {
      const hfe = higgsfieldErrorOf(e)
      // Character Online: sem conta conectada, sem créditos ou login vencido no Higgsfield: aviso com a ação certa
      if (hfe) setHfErr(await higgsfieldErrorState(hfe)) // confere a conta de novo e guarda o saldo visto
      // o preço mudou: recarrega o catálogo (o rodapé mostra o valor novo) e espera outro clique
      else if (e.status === 409 && e.data?.code === 'price_changed') { toast(`Os créditos mudaram: agora ${credits(e.data.credits)}. Confira e clique em Gerar de novo.`, 'err', 9000); load() } else toast(e.message, 'err', 7000)
    } finally {
      lock.current = false
      setSending(false)
    }
    if (job) upsertJob(job) // Character Online: o pedido aparece já, com uma roda por opção
    if (job) setJobIds(ids => [job.id, ...ids])
  }

  // Salvamentos em fila: o 2º usa o personagem criado pelo 1º (nada de personagem duplicado)
  // Character Online: pedido de antes (reaberto) vai para o personagem dele, ou um novo com o nome e a descrição do
  // pedido, sem misturar com o personagem de agora (sem characterId o servidor acha o personagem do pedido)
  const saving = useRef(Promise.resolve(character?.id || null))
  const [pending, setPending] = useState([])
  function save(job, index, makeCover) {
    const key = `${job.id}:${index}`
    if (pending.includes(key)) return
    setPending(p => [...p, key])
    const old = !character && earlier.includes(job.id)
    saving.current = saving.current.then(async prevId => {
      const c = await run(() => api.post('/api/images/save', {
        jobId: job.id, index, characterId: prevId, name: name || 'Novo personagem',
        identityEn: identity, makeCover, kind: tpl === 'sheet' ? 'sheet' : tpl === 'fullbody' ? 'fullbody' : 'card',
        ...(old ? { characterId: undefined, name: jobName(job) || 'Novo personagem', identityEn: undefined } : {}),
      }), 'Imagem salva no personagem')
      if (c) setSavedTo(c.id)
      setPending(p => p.filter(k => k !== key))
      if (old) return prevId
      return c?.id || prevId
    })
  }

  // Character Online: pedido descartado sai da lista (as opções já salvas continuam no personagem)
  async function discard(j) {
    const left = unsavedOptions(j)
    if (left && !(await confirmDialog(left === 1 ? 'Descartar a opção não salva deste pedido? Ela some da lista.' : `Descartar as ${left} opções não salvas deste pedido? Elas somem da lista.`, { ok: 'Descartar', no: 'Voltar' }))) return
    if (!(await run(() => api.del(`/api/jobs/${j.id}`)))) return
    setJobIds(ids => ids.filter(id => id !== j.id))
    dropJob(j.id)
  }
  // Tentar de novo: o servidor põe um pedido novo no lugar do que falhou; ele fica no mesmo lugar da lista (e, se era
  // um pedido de antes, continua salvando no personagem dele)
  // (com trava por pedido: o clique duplo punha dois pedidos novos)
  const [retrying, setRetrying] = useState([])
  const retryLock = useRef(new Set())
  async function retry(j) {
    if (retryLock.current.has(j.id)) return
    retryLock.current.add(j.id)
    setRetrying(r => [...r, j.id])
    let nj = null
    try {
      nj = await runHf(() => api.post(`/api/jobs/${j.id}/retry`), null, setHfErr)
    } finally {
      retryLock.current.delete(j.id)
      setRetrying(r => r.filter(id => id !== j.id))
    }
    if (!nj?.id) return
    if (earlier.includes(j.id)) earlier.push(nj.id)
    upsertJob(nj)
    setJobIds(ids => ids.map(id => (id === j.id ? nj.id : id)))
  }
  // Pedido esperando créditos ou o login do Higgsfield: Cancelar fecha as opções que ainda não foram enviadas
  const [canceling, setCanceling] = useState([])
  async function cancelWaiting(j) {
    if (canceling.includes(j.id)) return
    setCanceling(c => [...c, j.id])
    await cancelJob(j)
    setCanceling(c => c.filter(id => id !== j.id))
  }

  async function addFiles(files) {
    for (const f of [...files].filter(isImage)) {
      const r = await run(() => uploadFile('/api/uploads', f))
      if (r) setRefs(x => [...x, { path: r.path, url: r.url }])
    }
  }

  // Character Online: anexa as imagens de referência (até REF_MAX), conferindo tipo e tamanho antes de enviar; cada uma
  // aparece já com a roda e vira miniatura quando o servidor guarda
  async function addRefImages(files) {
    const list = []
    let room = REF_MAX - refImgs.length
    for (const f of [...files]) {
      if (room <= 0) { toast(`Anexe até ${REF_MAX} imagens de referência.`, 'warn', 6000); break }
      if (!isRefImage(f)) { toast(`${f.name}: ${REF_BAD_TYPE}`, 'err', 7000); continue }
      if (f.size > REF_MAX_MB * 1024 * 1024) { toast(`${f.name}: passa de ${REF_MAX_MB} MB. Envie um arquivo menor.`, 'err', 7000); continue }
      room--
      list.push({ f, key: `${Date.now()}-${Math.random().toString(36).slice(2)}` })
    }
    if (!list.length) return
    setRefImgs(x => [...x, ...list.map(({ f, key }) => ({ key, name: f.name, busy: true }))])
    for (const { f, key } of list) {
      try {
        const r = await uploadFile('/api/reference-images', f)
        setRefImgs(x => x.map(i => (i.key === key ? { key, ...r.reference, busy: false } : i)))
      } catch (e) {
        toast(`${f.name}: ${e.message}`, 'err', 7000)
        setRefImgs(x => x.filter(i => i.key !== key))
      }
    }
  }
  // tirar da lista também apaga no servidor (a que um pedido ainda está usando sai quando ele terminar)
  function removeRef(r) {
    setRefImgs(x => x.filter(i => i.key !== r.key))
    if (r.id) api.del(`/api/reference-images/${r.id}`).catch(() => {})
  }

  const jobs = jobIds.map(id => S.jobs.find(j => j.id === id)).filter(Boolean)
  const maxRefs = m?.limits?.maxRefs ?? 0
  return html`
    <${Modal} title=${character ? `Novas imagens · ${character.name}` : 'Criar personagem'} onClose=${() => { onClose?.(); if (savedTo && !character) onSaved?.(characterById(savedTo)) }} size="xl"
      foot=${html`
        <span class="small muted grow">${m ? html`${m.label} · ${plural(n, 'opção', 'opções')} do card${need ? ` · ${own ? ownBudgetText(need, hfHave, hfBalance) : credits(need)}` : ''}` : null}</span>
        ${savedTo && !character ? html`<button class="btn" onClick=${() => { onSaved?.(characterById(savedTo)); onClose?.() }}>Concluir e usar no Estúdio</button>` : null}
        <button class="btn btn--primary" disabled=${!!hfBlock || sending} onClick=${generate}>${sending ? 'Enviando...' : `Gerar ${plural(n, 'opção', 'opções')}${need ? ` (${credits(need)})` : ''}`}</button>`}>
      <div class="creator" style="display:grid;grid-template-columns:minmax(320px,440px) 1fr;gap:22px;align-items:start">
        <div class="stack" style="gap:14px">
          ${!character ? html`<label class="field"><span class="label">Nome</span><input class="input" value=${name} placeholder="Ex.: Archibald Brown" onInput=${e => setName(e.target.value)} /></label>` : null}
          <label class="field"><span class="label">Como ele é</span>
            <textarea class="textarea" rows="5" value=${identity} placeholder="Ex.: homem de 60 anos, cabelo grisalho, bigode branco, terno azul-marinho. Pode escrever em português." onInput=${e => { setIdentity(e.target.value); }}></textarea>
            <span class="small dim">${DESCRIBE_TIP}</span></label>
          <div class="field refs"><span class="label">Imagens de referência <span class="dim">(opcional, até ${REF_MAX})</span></span>
            <div class="refs__row" data-own-drop onDragOver=${e => e.preventDefault()} onDrop=${e => { e.preventDefault(); addRefImages(e.dataTransfer.files) }}>
              ${refImgs.map(r => html`<div key=${r.key} class="refs__item" title=${r.name || ''}>
                ${r.busy ? html`<${Spinner} />` : html`<img src=${r.thumbUrl || r.url} alt="" onClick=${() => showLightbox('image', r.url)} />`}
                ${!r.busy ? html`<button class="round refs__rm" title="Tirar esta imagem" aria-label="Tirar esta imagem" onClick=${() => removeRef(r)}>✕</button>` : null}
              </div>`)}
              ${refImgs.length < REF_MAX ? html`<button class="refs__add" title="Anexar foto, desenho ou print" onClick=${() => refFileRef.current?.click()}><span>+</span>Anexar</button>` : null}
              <input ref=${refFileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange=${e => { addRefImages(e.target.files); e.target.value = '' }} />
            </div>
            <span class="small dim">${REF_TIP}</span></div>
          ${maxRefs ? html`<div class="field">
            <span class="label">Referências ${maxRefs ? html`<span class="dim">(até ${maxRefs})</span>` : html`<span class="dim">(este modelo não usa)</span>`}</span>
            <div class="row wrap" style="gap:8px" data-own-drop onDrop=${e => { e.preventDefault(); addFiles(e.dataTransfer.files) }}>
              ${refs.map((r, i) => html`<div key=${i} class="img" style="width:64px"><img src=${r.url} onClick=${() => showLightbox('image', r.url)} /><button class="round" style="position:absolute;top:3px;right:3px;width:22px;height:22px;font-size:11px" onClick=${() => setRefs(refs.filter((_, j) => j !== i))}>✕</button></div>`)}
              <button class="btn btn--sm" onClick=${() => setPicking(!picking)}>Da biblioteca</button>
              <button class="btn btn--sm" onClick=${() => fileRef.current.click()}>Enviar imagem</button>
              <input ref=${fileRef} type="file" accept="image/*" multiple hidden onChange=${e => { addFiles(e.target.files); e.target.value = '' }} />
            </div>
            ${picking ? html`<div style="max-height:250px;overflow:auto;padding:4px 6px 6px 2px"><div class="chars" style="grid-template-columns:repeat(auto-fill,minmax(64px,1fr))">
              ${S.characters.map(c => html`<button key=${c.id} class="char" title=${c.name} onClick=${() => { const cv = coverOf(c); if (cv) setRefs([...refs, { characterId: c.id, imageId: cv.id, url: cv.thumbUrl }]); setPicking(false) }}><img src=${coverOf(c)?.thumbUrl} loading="lazy" /></button>`)}
            </div></div>` : null}
          </div>` : null}
          <div class="field"><span class="label">Modelo</span>
            <select class="select" value=${modelId} onChange=${e => { setModelId(e.target.value); setOpts({}) }}>
              ${models.map(x => html`<option value=${x.id} disabled=${!x.configured}>${x.label}${!x.configured ? (hf ? ' (conecte o Higgsfield)' : ' (sem chave)') : ''}</option>`)}
            </select>
            ${m ? html`<div class="row wrap" style="gap:6px">${modelBadges(m)}<span class="small dim">${m.description}</span></div>` : null}
            ${m?.options?.length ? html`<div class="row wrap" style="gap:8px">${m.options.map(o => html`<label key=${o.key} class="row small"><span class="muted">${o.label}</span>
              <select class="select input--sm" style="width:auto" value=${opts[o.key] ?? o.default} onChange=${e => setOpts({ ...opts, [o.key]: e.target.value })}>${(o.choices || []).map(c => html`<option value=${c.value}>${c.label}</option>`)}</select></label>`)}</div>` : null}
          </div>
          <div class="field"><span class="label">Opções do card</span><${Seg} value=${n} onChange=${v => { setN(v); savePref('creatorOptions', v) }} options=${Array.from({ length: maxN }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
            <span class="small dim">Cada opção é um card diferente${unit ? ` (${credits(unit)} cada)` : ''}. Salve a que gostar; as vistas para vídeo você gera depois, no personagem.</span></div>
          <details class="more"><summary>Prompt final ${custom != null ? '(editado)' : ''}</summary>
            <div class="stack" style="margin-top:8px;gap:6px">
              <textarea class="textarea" rows="10" value=${prompt} onInput=${e => setCustom(e.target.value)}></textarea>
              ${custom != null ? html`<button class="btn btn--xs" style="justify-self:start" onClick=${() => setCustom(null)}>Voltar ao modelo</button>` : null}
            </div></details>
          <${HiggsfieldWarn} warn=${hfWarn} />
        </div>
        <div class="stack">
          <span class="label">Resultados</span>
          ${!jobs.length ? html`<div class="empty"><b>Nada gerado ainda</b><span>Descreva o personagem, escolha quantas opções quer e clique em Gerar. Cada opção aparece aqui assim que fica pronta: salve a que gostar.</span></div>` : null}
          ${jobs.map(j => {
            // Character Online: cada opção aparece assim que fica pronta (evento ao vivo), com Salvar e como capa
            const o = optionsOf(j)
            const old = earlier.includes(j.id)
            // Character Online: erro de plano: o aviso com Assinar e Já assinei no lugar do "Tentar de novo" (que não passa)
            const plan = j.status === 'failed' && planError(j)
            // opções paradas pela conta Higgsfield do aluno (sem créditos ou login vencido): o motivo no lugar da roda
            const stuck = o.waiting && j.waiting?.text ? j.waiting : null
            return html`
            <div key=${j.id} class=${`stack optreq ${old ? 'optreq--old' : ''}`} style="gap:8px">
              <div class="row wrap small"><span class="dim">${old ? `Pedido anterior, ainda não salvo (${ago(j.createdAt)})${jobName(j) ? ` · ${jobName(j)}` : ''} · ` : ''}${plural(o.total, 'opção', 'opções')}${o.waiting ? ` · ${plural(o.ready.length, 'pronta', 'prontas')}` : ''}</span>${j.status === 'failed' && !plan ? html`<span style="color:var(--red)">${j.error}</span>` : null}
                ${j.status === 'done' && o.failed ? html`<span class="dim">${j.warning || (o.failed === 1 ? '1 opção não saiu' : `${o.failed} opções não saíram`)}</span>` : null}
                ${j.status === 'canceled' ? html`<span class="dim">${j.error || 'Cancelado por você.'}</span>` : null}
                ${j.status === 'failed' && !plan ? html`<button class="btn btn--xs" disabled=${retrying.includes(j.id)} onClick=${() => retry(j)}>${retrying.includes(j.id) ? 'Enviando...' : 'Tentar de novo'}</button>` : null}
                <span class="grow"></span>
                ${!o.waiting ? html`<button class="btn btn--xs btn--quiet" title="Apaga este pedido da lista (as opções salvas continuam no personagem)" onClick=${() => discard(j)}>Descartar</button>` : null}</div>
              ${plan ? html`<${HiggsfieldWarn} warn=${{ kind: j.errorKind === 'trial' ? 'trial' : 'plan', text: j.error }} />` : null}
              ${stuck ? html`<div class="row wrap" style="gap:8px">
                ${stuck.kind !== 'busy' ? html`<${HiggsfieldActions} kind=${stuck.kind === 'credits' ? 'no_credits' : 'auth'} />` : null}
                <button class="btn btn--sm" disabled=${canceling.includes(j.id)} title="Cancela as opções que ainda não foram enviadas ao Higgsfield" onClick=${() => cancelWaiting(j)}>Cancelar</button>
              </div>` : null}
              <div class="results">
                ${o.ready.map((u, i) => {
                    const saved = (j.savedImages || []).includes(i)
                    const busy = pending.includes(`${j.id}:${i}`)
                    return html`<div key=${i} class="result">
                      <div class="result__img"><img src=${u} onClick=${() => showLightbox('image', u)} /></div>
                      <div class="row" style="gap:6px">
                        <button class="btn btn--sm ${saved ? '' : 'btn--butter'}" disabled=${saved || busy} onClick=${() => save(j, i, false)}>${saved ? 'Salva ✓' : busy ? 'Salvando...' : 'Salvar'}</button>
                        ${!saved && !busy ? html`<button class="btn btn--sm btn--quiet" onClick=${() => save(j, i, true)} title="Salvar e usar como capa">como capa</button>` : null}
                      </div></div>`
                  })}
                ${Array.from({ length: o.waiting + o.failed }, (_, i) => html`<div key=${`falta-${i}`} class="result"><div class="result__img" title=${i >= o.waiting && j.warning ? j.warning : undefined}>${i >= o.waiting ? html`<span class="dim">✕</span>` : stuck ? html`<span class="small muted" style="padding:12px;text-align:center">${stuck.text}</span>` : html`<${Spinner} />`}</div></div>`)}
              </div>
            </div>`
          })}
        </div>
      </div>
    </${Modal}>`
}

// Campo que salva ao sair (blur/Enter) sem ser sobrescrito pelas atualizações ao vivo enquanto você digita.
export function DraftField({ value, resetKey, onCommit, textarea = false, rows = 4, cls }) {
  const [v, setV, done] = useDraft(value || '', resetKey)
  const props = {
    class: cls || (textarea ? 'textarea' : 'input'),
    value: v,
    onInput: e => setV(e.target.value),
    onChange: e => { done(); if (e.target.value !== (value || '')) onCommit(e.target.value) },
  }
  return textarea ? html`<textarea rows=${rows} ...${props}></textarea>` : html`<input ...${props} />`
}

// Character Online: personagem da biblioteca só para ler (o servidor recusa mudar nome e descrição dele)
function LibraryText({ c }) {
  return html`<div class="stack" style="gap:12px">
    <span class="small dim">Personagem da biblioteca: para mudar, crie o seu em + Criar personagem.</span>
    <div class="field"><span class="label">Nome</span><span>${c.name}</span></div>
    ${c.identityEn ? html`<div class="field"><span class="label">Descrição em inglês (vai nos prompts)</span><span class="small" style="white-space:pre-wrap">${c.identityEn}</span></div>` : null}
    ${c.description ? html`<div class="field"><span class="label">Descrição (português)</span><span class="small" style="white-space:pre-wrap">${c.description}</span></div>` : null}
  </div>`
}

// ------------------------------------------------------------ ficha do personagem
export function CharacterDetail({ id, onClose }) {
  useStore()
  const c = characterById(id)
  const [creating, setCreating] = useState(false)
  const [upModel, setUpModel] = useState(() => S.models.filter(m => m.step === 'image_upscale').sort(byRank)[0]?.id)
  const fileRef = useRef(null)
  // Character Online: "Gerar vistas" recusado pela conta Higgsfield do aluno: aviso com o botão certo na própria ficha
  const [hfErr, setHfErr] = useState(null)
  const hfWarn = liveHiggsfieldError(hfErr, higgsfield())
  // Character Online: corpo inteiro (trava do clique duplo, como no Gerar do criador)
  const [bodySending, setBodySending] = useState(false)
  const bodyLock = useRef(false)
  if (!c) return null
  const patch = body => run(() => api.patch(`/api/characters/${c.id}`, body))
  const imgPatch = (img, body) => run(() => api.patch(`/api/characters/${c.id}/images/${img.id}`, body))
  const upModels = S.models.filter(m => m.step === 'image_upscale').sort(byRank)
  const refsOn = c.images.filter(i => i.useAsRef).length
  // a última referência marcada não desmarca (o servidor recusa: o personagem precisa de pelo menos uma)
  const lastRef = img => refsOn === 1 && !!img.useAsRef
  // Character Online: foto enviada pelo aluno só com o recurso ligado pelo admin (Configurações > Recursos)
  const canUpload = !c.library && (isAdmin() || S.me?.features?.user_photo_characters === true)
  // Character Online: vistas para vídeo (frente, perfil e 3/4 direita) a partir do card, só as que faltam, com o preço
  // no botão e a pergunta antes; com as três o botão some
  const missing = missingViews(c)
  const viewsCost = viewsCredits(c)
  const busyViews = viewsBusy(c)
  const makeViews = async () => {
    if (!(await askViews([c]))) return
    runHf(() => api.post(`/api/characters/${c.id}/views`, {}), 'Gerando as vistas. Elas entram aqui sozinhas.', setHfErr)
  }
  // Character Online: corpo inteiro, só quando o aluno pede (nunca por padrão), com o preço e a pergunta antes. Conta no
  // plano Free do Higgsfield: botão desligado com o aviso de assinar (o servidor também barra)
  const bodyJob = bodyJobOf(c)
  const bodyBusy = bodySending || (!!bodyJob && active(bodyJob))
  const bodyCost = bodyCredits()
  const bodyBlock = higgsfieldBlock(higgsfield(), { images: true })
  const bodyErr = !bodyBusy && !hasBody(c) && bodyJob?.status === 'failed' ? bodyJob.error : null
  const showBody = !c.library && (canBody(c) || bodyBusy)
  const makeBody = async () => {
    if (bodyLock.current || bodyBlock) return
    // a trava vale já no clique (o segundo clique não abre outra pergunta) e sai quando a pergunta ou o envio termina
    bodyLock.current = true
    try {
      const cost = bodyCost ? ` Usa ${credits(bodyCost)}${higgsfield()?.mode === 'own' ? ' do seu Higgsfield' : ''}.` : ''
      if (!(await confirmDialog(`Gerar o corpo inteiro de ${c.name}?${cost} É uma foto da cabeça aos pés, com a mesma roupa, que entra nas referências do vídeo.`, { ok: 'Gerar corpo inteiro', danger: false, no: 'Voltar' }))) return
      setBodySending(true)
      const r = await runHf(() => api.post(`/api/characters/${c.id}/views`, { roles: ['body'], expected_credits: bodyCost || undefined }), 'Gerando o corpo inteiro. Ele entra aqui sozinho.', setHfErr)
      for (const j of r?.jobs || []) upsertJob(j)
    } finally {
      bodyLock.current = false
      setBodySending(false)
    }
  }

  return html`
    <${Modal} title=${c.name} onClose=${onClose} size="xl"
      head=${html`<button class="btn btn--sm ${c.favorite ? 'btn--butter' : ''}" onClick=${() => patch({ favorite: !c.favorite })}>${c.favorite ? '★ Favorito' : '☆ Favoritar'}</button>`}
      foot=${c.library ? html`<span class="small dim grow">Personagem da biblioteca: pronto para usar no Estúdio.</span>` : html`
        <button class="btn btn--danger btn--sm" onClick=${async () => { if (await confirmDialog(`Apagar ${c.name} e todas as imagens dele?`)) { const r = await run(() => api.del(`/api/characters/${c.id}`)); if (r) onClose() } }}>Apagar personagem</button>
        <span class="grow"></span>
        ${canUpload ? html`<button class="btn" onClick=${() => fileRef.current.click()}>Enviar imagens</button>` : null}
        ${missing.length ? html`<button class="btn btn--butter" disabled=${busyViews} title="Frente, perfil e 3/4 direita no mesmo padrão do card: o Higgsfield acerta muito melhor o personagem no vídeo" onClick=${makeViews}>${busyViews ? 'Gerando as vistas...' : `Gerar vistas para vídeo${viewsCost ? ` (${credits(viewsCost)})` : ''}`}</button>` : null}
        <button class="btn btn--primary" onClick=${() => setCreating(true)}>Gerar novas imagens</button>`}>
      <div class="chardetail" style="display:grid;grid-template-columns:1fr minmax(300px,380px);gap:22px;align-items:start">
        <div class="stack" data-own-drop onDragOver=${e => e.preventDefault()} onDrop=${e => { e.preventDefault(); if (canUpload) uploadCharacterImages(c.id, e.dataTransfer.files) }}>
          <div class="row"><span class="label grow">Imagens · ${plural(refsOn, 'usada', 'usadas')} como referência no vídeo</span>
            ${upModels.length ? html`<select class="select input--sm" style="width:auto" value=${upModel} onChange=${e => setUpModel(e.target.value)} title="Modelo de upscale">${upModels.map(m => html`<option value=${m.id} disabled=${!m.configured}>${m.label}</option>`)}</select>` : null}</div>
          <div class="imgs">
            ${c.images.map(img => html`
              <div key=${img.id} class=${`img ${img.role === BODY_ROLE ? 'img--body' : ''} ${c.cover === img.id ? 'is-cover' : ''} ${img.useAsRef ? '' : 'is-off'}`}>
                <img src=${img.thumbUrl} onClick=${() => showLightbox('image', img.url)} loading="lazy" />
                <span class="img__tag">${img.role ? html`<${Badge} kind="mint">${img.label || img.role}</${Badge}>` : img.kind === 'upscale' ? html`<${Badge} kind="4k">upscale</${Badge}>` : img.width ? html`<${Badge}>${img.width}×${img.height}</${Badge}>` : null}</span>
                <div class="img__bar">
                  ${!c.library ? html`<button class=${`round ${img.useAsRef ? 'is-on' : ''}`} disabled=${lastRef(img)} title=${lastRef(img) ? 'O personagem precisa de pelo menos uma referência' : 'Usar como referência no vídeo'} onClick=${() => imgPatch(img, { useAsRef: !img.useAsRef })}>✓</button>` : null}
                  <button class=${`round ${c.cover === img.id ? 'is-on' : ''}`} title="Usar como capa" onClick=${() => patch({ cover: img.id })}>★</button>
                  ${upModel ? html`<button class="round" title="Upscale desta imagem" onClick=${() => run(() => api.post(`/api/characters/${c.id}/images/${img.id}/upscale`, { model: upModel }), 'Upscale na fila. A imagem nova aparece aqui.')}>⤢</button>` : null}
                  ${!c.library ? html`<button class="round" title="Apagar imagem" onClick=${async () => (await confirmDialog('Apagar esta imagem?')) && run(() => api.del(`/api/characters/${c.id}/images/${img.id}`))}>🗑</button>` : null}
                </div>
              </div>`)}
            ${bodyBusy && !hasBody(c) ? html`<div class="img img--body img--wait" title="Gerando o corpo inteiro"><${Spinner} /></div>` : null}
          </div>
          ${showBody ? html`<div class="bodygen">
            <div class="bodygen__text"><b>Corpo inteiro</b><span class="small dim">${BODY_TIP}</span></div>
            <button class="btn btn--sm btn--butter" disabled=${bodyBusy || !!bodyBlock} onClick=${makeBody}>${bodyBusy ? 'Gerando o corpo inteiro...' : `Gerar corpo inteiro${bodyCost ? ` (${credits(bodyCost)})` : ''}`}</button>
            ${bodyErr ? html`<span class="small bodygen__err">${bodyErr}</span>` : null}
            ${bodyBlock ? html`<div class="bodygen__warn"><${HiggsfieldWarn} warn=${bodyBlock} /></div>` : null}
          </div>` : null}
          <span class="small dim">${canUpload ? 'Arraste imagens para cá para adicionar. ' : ''}Passe o mouse numa imagem para ver as ações. Ficha de corpo inteiro e close do cabelo ajudam muito os modelos de vídeo.</span>
          <input ref=${fileRef} type="file" accept="image/*" multiple hidden onChange=${e => { uploadCharacterImages(c.id, e.target.files); e.target.value = '' }} />
        </div>
        <div class="stack" style="gap:14px">
          <${HiggsfieldWarn} warn=${hfWarn} />
          ${c.library ? html`<${LibraryText} c=${c} />` : html`
          <label class="field"><span class="label">Nome</span><${DraftField} value=${c.name} resetKey=${c.id} onCommit=${v => patch({ name: v })} /></label>
          <label class="field"><span class="label">Descrição em inglês (vai nos prompts)</span>
            <${DraftField} textarea rows="7" value=${c.identityEn} resetKey=${c.id} onCommit=${v => patch({ identityEn: v })} /></label>
          <label class="field"><span class="label">Descrição (português)</span>
            <${DraftField} textarea rows="4" value=${c.description} resetKey=${c.id} onCommit=${v => patch({ description: v })} /></label>
          `}
          <div class="small dim">${c.code ? `${c.code} · ` : ''}${c.source || ''}</div>
        </div>
      </div>
      ${creating ? html`<${CharacterCreator} character=${c} onClose=${() => setCreating(false)} />` : null}
    </${Modal}>`
}

// ------------------------------------------------------------ página
const videosOf = id => S.jobs.filter(j => (j.kind === 'take' || j.kind === 'video_upscale') && j.status === 'done' && j.outputs?.masterUrl && castIds(j).includes(id)).sort(newestFirst)

// Vídeos prontos de cada personagem da pasta (clique abre o vídeo)
function ProjectVideos({ chars }) {
  const rows = chars.map(c => ({ c, list: videosOf(c.id) }))
  const total = rows.reduce((n, x) => n + x.list.length, 0)
  return html`<div class="pvids">
    <h2 class="pvids__title">Vídeos prontos <em>${total}</em></h2>
    ${rows.map(({ c, list }) => html`<div key=${c.id} class="pvids__row">
      <div class="pvids__who"><img src=${coverOf(c)?.thumbUrl} alt="" /><div><b>${c.name}</b><span class="small dim">${list.length ? plural(list.length, 'vídeo', 'vídeos') : 'nenhum ainda'}</span></div></div>
      <div class="pvids__strip">${list.map(j => html`<button key=${j.id} class="pvids__vid" title=${j.title} onClick=${() => showLightbox('video', j.outputs.masterUrl)}>
        <img src=${j.outputs.thumbUrl} alt="" loading="lazy" /><span>${Math.round(j.result?.duration || 0)} s</span></button>`)}</div>
    </div>`)}
  </div>`
}

// Pastas de projeto: ex.: "Produção" com os 15 personagens que vão virar perfis. Só agrupam (apagar a pasta não apaga ninguém).
function ProjectHead({ p, editing, setEditing, onCreate, onClose }) {
  const missing = Math.max(0, (p.target || 0) - p.characterIds.length)
  const remove = async () => {
    if (!(await confirmDialog(`Apagar a pasta "${p.name}"? Os personagens continuam na biblioteca.`, { ok: 'Apagar pasta' }))) return
    if (await run(() => api.del(`/api/projects/${p.id}`))) onClose()
  }
  return html`<div class="phead">
    <span class="phead__icon">📁</span>
    <${DraftField} value=${p.name} resetKey=${p.id} cls="input phead__name" onCommit=${v => run(() => api.patch(`/api/projects/${p.id}`, { name: v }))} />
    <span class="phead__count"><b>${p.characterIds.length}</b>${p.target ? ` de ${p.target}` : ''} personagens${missing ? html` · <span style="color:var(--accent)">faltam ${missing}</span>` : ''}</span>
    <label class="row small muted" style="gap:6px">Meta
      <input class="input input--sm" style="width:64px" type="number" min="0" max="200" value=${p.target || ''} placeholder="—"
        onChange=${e => run(() => api.patch(`/api/projects/${p.id}`, { target: Number(e.target.value) || 0 }))} /></label>
    <span class="grow"></span>
    <button class=${`btn ${editing ? 'btn--butter' : ''}`} onClick=${() => setEditing(!editing)}>${editing ? 'Pronto' : 'Escolher personagens'}</button>
    <button class="btn btn--primary" onClick=${onCreate}>+ Criar nesta pasta</button>
    <button class="btn btn--quiet" onClick=${remove}>Apagar pasta</button>
  </div>`
}

export function Characters() {
  useStore()
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState(null)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState(false)
  const [curId, setCurRaw] = useState(loadPref('charsProject', null))
  const setCur = id => { setCurRaw(id); savePref('charsProject', id); setEditing(false) }
  const cur = curId ? projectById(curId) : null
  const qq = q.trim().toLowerCase()
  const match = c => !qq || `${c.name} ${c.code || ''} ${c.description || ''}`.toLowerCase().includes(qq)
  // na pasta: só os dela (na ordem); escolhendo: a biblioteca toda, com os da pasta marcados
  const list = (cur && !editing ? projectChars(cur) : S.characters).filter(match)
  const inCur = id => !!cur?.characterIds.includes(id)
  const toggle = c => run(() => api.patch(`/api/projects/${cur.id}`, inCur(c.id) ? { remove: [c.id] } : { add: [c.id] }))
  const newProject = async () => {
    const p = await run(() => api.post('/api/projects', { name: `Projeto ${S.projects.length + 1}`, target: 15 }))
    if (p) { setCur(p.id); setEditing(true); toast('Pasta criada. Clique nos personagens para colocar nela.', 'ok', 6000) }
  }
  const empty = cur && !editing && !qq ? Math.max(0, (cur.target || 0) - cur.characterIds.length) : 0
  // Character Online: opções do card geradas e ainda não salvas (o criador mostra de novo, para salvar)
  const unsaved = unsavedImageJobs().reduce((k, j) => k + unsavedOptions(j), 0)
  return html`
    <div class="page">
      <div class="page__head">
        <h1 class="display page__title">Personagens <em>${cur && !editing ? cur.characterIds.length : S.characters.length}</em></h1>
        <label class="search" style="max-width:320px"><input class="input" placeholder="Buscar" value=${q} onInput=${e => setQ(e.target.value)} /></label>
        <span class="grow"></span>
        ${unsaved ? html`<button class="btn btn--butter" title="Opções do card que você gerou e ainda não salvou" onClick=${() => setCreating(true)}>${unsaved === 1 ? '1 opção não salva' : `${unsaved} opções não salvas`}</button>` : null}
        <button class="btn btn--primary" onClick=${() => setCreating(true)}>+ Criar personagem</button>
      </div>
      <div class="pbar">
        <button class=${`pchip ${!cur ? 'is-on' : ''}`} onClick=${() => setCur(null)}>Todos <em>${S.characters.length}</em></button>
        ${S.projects.map(p => html`<button key=${p.id} class=${`pchip ${cur?.id === p.id ? 'is-on' : ''}`} onClick=${() => setCur(p.id)}>📁 ${p.name} <em>${p.characterIds.length}${p.target ? `/${p.target}` : ''}</em></button>`)}
        <button class="pchip pchip--new" onClick=${newProject}><span>+</span> Nova pasta</button>
      </div>
      ${cur ? html`<${ProjectHead} p=${cur} editing=${editing} setEditing=${setEditing} onCreate=${() => setCreating(true)} onClose=${() => setCur(null)} />` : null}
      ${cur && editing ? html`<div class="small muted" style="margin:-4px 0 12px">Clique para colocar ou tirar da pasta <b>${cur.name}</b>. Os marcados com ✓ já estão nela.</div>` : null}
      <div class="lib">
        ${list.map(c => html`
          <button key=${c.id} class=${`char ${editing && inCur(c.id) ? 'is-on' : ''}`} onClick=${() => (editing ? toggle(c) : setDetail(c.id))}>
            <img src=${coverOf(c)?.thumbUrl} alt="" loading="lazy" />
            ${c.favorite ? html`<span class="char__fav">★</span>` : null}
            ${editing ? html`<span class="char__check">✓</span>` : null}
            <span class="char__name">${c.name}<br /><span class="dim" style="font-weight:500">${cur && !editing ? plural(videosOf(c.id).length, 'vídeo', 'vídeos') : plural(c.images.length, 'imagem', 'imagens')}</span></span>
          </button>`)}
        ${Array.from({ length: empty }, (_, i) => html`<button key=${`vaga-${i}`} class="char char--new char--slot" onClick=${() => setCreating(true)}><span>+</span>Criar</button>`)}
      </div>
      ${cur && !editing && cur.characterIds.length && !qq ? html`<${ProjectVideos} chars=${projectChars(cur)} />` : null}
      ${cur && !editing && !cur.characterIds.length ? html`<div class="empty" style="margin-top:12px"><b>Pasta vazia</b><button class="btn btn--butter" onClick=${() => setEditing(true)}>Escolher personagens</button></div>` : null}
      ${detail ? html`<${CharacterDetail} id=${detail} onClose=${() => setDetail(null)} />` : null}
      ${creating ? html`<${CharacterCreator} onClose=${() => setCreating(false)} onSaved=${c => {
        if (!c) return
        if (cur) run(() => api.patch(`/api/projects/${cur.id}`, { add: [c.id] }))
        setDetail(c.id)
      }} />` : null}
    </div>`
}
