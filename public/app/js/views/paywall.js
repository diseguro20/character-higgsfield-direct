// Character Online: hospedagem paga (regras em src/core/paywall.js). O aluno com a conta Higgsfield própria gera os
// vídeos grátis (me.paywall.free_videos); pedir mais sem ter pago responde 402 { code: 'paywall', checkout_url,
// price_label, locked } e, depois dos grátis, a galeria fecha: os vídeos prontos vêm sem o link (job.locked) até o
// pagamento único na Kiwify. Aqui ficam o aviso de pagamento (modal), a faixa da galeria fechada e os textos.
// me.paywall = { active, applies, paid, locked, free_videos, used, free_left, price_label, checkout_url }
import { html, Modal } from '../ui.js'
import { S, useStore, notify, load, toast } from '../state.js'

export const paywallOf = () => S.me?.paywall || null
// galeria fechada para este aluno (o servidor também não manda os links)
export const galleryClosed = () => !!paywallOf()?.locked
// vídeo pronto que está guardado, mas fechado pela hospedagem
export const lockedJob = j => !!j?.locked && j.status === 'done'

export const GALLERY_TEXT = price => `Sua galeria está pausada, mas seus vídeos estão guardados com a gente. Para voltar a assistir e baixar, pague a pequena taxa do servidor (${price}, uma vez só).`

// Erro 402 da hospedagem -> { text, checkoutUrl, priceLabel, locked, freeLeft } (null = outro erro)
export function paywallErrorOf(e) {
  const d = e?.data
  if (d?.code !== 'paywall') return null
  return {
    text: d.error || e.message, checkoutUrl: d.checkout_url || null, priceLabel: d.price_label || null,
    locked: !!d.locked, freeLeft: d.free_left ?? null,
  }
}

// Abre o aviso de pagamento: com o erro da API, o texto dele; sem, o da galeria fechada (ou, com ela aberta, o dos
// vídeos grátis)
export function openPaywall(info = null) {
  const p = paywallOf()
  const price = p?.price_label || ''
  const text = p?.locked ? GALLERY_TEXT(price) : freeVideosText(p) || GALLERY_TEXT(price)
  S.paywallOpen = info || { text, checkoutUrl: p?.checkout_url || null, priceLabel: p?.price_label || null, locked: !!p?.locked }
  notify()
}
export function closePaywall() {
  S.paywallOpen = null
  notify()
}

// Erro da hospedagem: abre o aviso e, se a galeria fechou agora, recarrega o estado (os vídeos prontos perdem o
// link). Devolve true quando era isso.
export function paywallFrom(e) {
  const info = paywallErrorOf(e)
  if (!info) return false
  openPaywall(info)
  if (info.locked && !paywallOf()?.locked) load()
  return true
}

// Pedido que pode esbarrar na hospedagem (Tentar de novo, Gerar): o 402 abre o aviso e o pedido devolve null
export async function withPaywall(fn) {
  try {
    return await fn()
  } catch (e) {
    if (paywallFrom(e)) return null
    throw e
  }
}

// Linha do Estúdio sobre os vídeos grátis (null = nada a dizer: cobrança desligada, já pagou ou não vale para ele)
export function freeVideosText(p) {
  if (!p?.active || !p.applies || p.paid) return null
  const price = p.price_label
  if (p.locked) return `Sua galeria está pausada, mas seus vídeos estão guardados. Para voltar a gerar e assistir, pague a pequena taxa do servidor (${price}, uma vez só).`
  if (p.free_left <= 0) {
    return p.free_videos
      ? `${p.free_videos === 1 ? 'O seu vídeo grátis foi por nossa conta' : `Os seus ${p.free_videos} vídeos grátis foram por nossa conta`}. Para continuar gerando, pague a pequena taxa do servidor (${price}, uma vez só), que guarda seus vídeos aqui.`
      : `O Character é gratuito. Para gerar e guardar seus vídeos aqui, pague a pequena taxa do servidor (${price}, uma vez só).`
  }
  return `${p.free_left === 1 ? 'Falta 1 vídeo grátis' : `Faltam ${p.free_left} vídeos grátis`}, por nossa conta. Depois, para continuar gerando, há uma pequena taxa do servidor (${price}, uma vez só) que guarda seus vídeos.`
}

// "Já paguei": recarrega o estado; ainda fechado, explica que a confirmação da Kiwify leva alguns instantes
async function checkPaid() {
  await load()
  const p = paywallOf()
  if (p && !p.locked && (p.paid || !p.active)) {
    closePaywall()
    toast('Pagamento confirmado. Sua galeria está liberada.', 'ok', 6000)
  } else {
    toast('Ainda não recebemos a confirmação do pagamento. Ela costuma chegar em poucos minutos: a galeria abre sozinha.', 'info', 9000)
  }
}

// Aviso de pagamento (as telas Estúdio, Fila e Galeria desenham; só uma aparece por vez)
export function PaywallModal() {
  useStore()
  const info = S.paywallOpen
  if (!info) return null
  const p = paywallOf()
  const url = info.checkoutUrl || p?.checkout_url || null
  const price = info.priceLabel || p?.price_label || ''
  const email = S.me?.user?.email
  return html`<${Modal} title="Uma pequena taxa para guardar seus vídeos" onClose=${closePaywall}
    foot=${html`
      <button class="btn btn--quiet" onClick=${checkPaid}>Já paguei</button>
      <span class="grow"></span>
      ${url ? html`<a class="btn btn--primary" href=${url} target="_blank" rel="noopener">Pagar ${price}</a>` : null}`}>
    <div class="paywall stack">
      <p>${info.text}</p>
      ${email ? html`<p class="small muted">No pagamento, use o e-mail da sua conta (<b>${email}</b>): assim a liberação é automática. Pagou com outro e-mail? Fale com o suporte.</p>` : null}
      ${!url ? html`<p class="small muted">O link de pagamento ainda não está disponível. Tente de novo em instantes.</p>` : null}
    </div>
  </${Modal}>`
}

// Faixa da galeria fechada (Galeria, Estúdio e Fila), com o botão de pagar
export function PaywallBand() {
  useStore()
  const p = paywallOf()
  if (!p?.locked) return null
  return html`<div class="paywall-band">
    <span class="paywall-band__text">${GALLERY_TEXT(p.price_label)}</span>
    <button class="btn btn--sm btn--primary" onClick=${() => openPaywall()}>Liberar por ${p.price_label}</button>
  </div>`
}
