// Configurações: a conta Higgsfield do aluno (conectar, saldo, desconectar), sua conta, catálogo de modelos com os
// créditos de cada um e, para o admin, contas Higgsfield, alunos e preços.
// Character Online: chaves de API, login do Higgsfield, download por link, velocidade e pastas do Mac eram do app local.
import { html, cr, modelBadges } from '../ui.js'
import { S, useStore, isAdmin, modelCreditsPerSecond, modelCharacterCredits } from '../state.js'
import { AccountPanel, HiggsfieldPanel } from './account.js'
import { AdminPanels } from './admin.js'

const STEP_LABEL = { image_gen: 'Criar imagem', image_edit: 'Primeiro quadro', image_upscale: 'Upscale de imagem', swap: 'Troca de personagem', video_upscale: 'Upscale de vídeo' }

export function Settings() {
  useStore()
  const steps = Object.keys(STEP_LABEL)
  return html`
    <div class="page">
      <div class="page__head"><h1 class="display page__title">Configurações</h1></div>
      <div class="settings">
        <${HiggsfieldPanel} />
        <${AccountPanel} />

        <section class="panel">
          <div class="panel__head"><h2 class="display panel__title">Modelos</h2><span class="panel__hint">créditos de 10 s de vídeo (ou de 1 personagem com 4 imagens)</span></div>
          <div class="panel__body">
            <table class="table">
              <thead><tr><th>Etapa</th><th>Modelo</th><th>Provedor</th><th>Créditos</th><th></th></tr></thead>
              <tbody>
                ${steps.flatMap(st => S.models.filter(m => m.step === st).map(m => html`
                  <tr key=${m.id}>
                    <td class="muted">${STEP_LABEL[st]}</td>
                    <td><b>${m.label}</b> <span class="row wrap" style="gap:4px;display:inline-flex">${modelBadges(m)}</span><div class="small dim">${m.description}</div></td>
                    <td><span class=${`dot ${m.configured ? 'is-on' : ''}`} style="display:inline-block;margin-right:6px"></span>${m.providerLabel}<div class="small dim"><code>${m.endpoint}</code></div></td>
                    <td class="pixel">${m.step === 'swap' && modelCreditsPerSecond(m) ? cr(modelCreditsPerSecond(m) * 10) : m.step === 'image_gen' && modelCharacterCredits(m) ? cr(modelCharacterCredits(m)) : m.status === 'test' ? 'grátis' : '?'}${m.priceNote ? html`<div class="small dim" style="font-family:var(--f-body)">${m.priceNote}</div>` : null}</td>
                    <td>${m.docsUrl ? html`<a href=${m.docsUrl} target="_blank" rel="noopener">docs ↗</a>` : null}</td>
                  </tr>`))}
              </tbody>
            </table>
          </div>
        </section>

        ${isAdmin() ? html`<${AdminPanels} />` : null}
      </div>
    </div>`
}
