// Página do Character (usada com a conta Higgsfield do aluno): preenche os créditos do Higgsfield, os limites, a
// hospedagem dos vídeos, os links para o app e para criar a conta no Higgsfield e os dados da empresa a partir de
// assets/config.js.
// O HTML já vem com os valores padrão, então a página continua certa mesmo se este arquivo falhar.
(function () {
  var C = window.CHARACTER_LANDING || {}

  function get(path) {
    return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k] }, C)
  }
  function filled(v) {
    return !(v === undefined || v === null || v === '' || v === 0 || v === false)
  }
  function int(v) {
    return Math.round(Number(v)).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
  }
  function positive(v) {
    var n = Number(v)
    return isFinite(n) && n > 0 ? n : 0
  }
  function each(sel, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(sel), fn)
  }
  function missing(el, label) {
    el.textContent = label || 'a preencher'
    el.classList.add('is-missing')
  }

  // links: todo botão de entrar e de começar leva para o app
  each('[data-app]', function (el) { el.setAttribute('href', C.appUrl || '/app') })
  // criar a conta no Higgsfield (link de afiliado do dono): só endereço https; senão fica o do HTML (o site do Higgsfield)
  each('[data-signup]', function (el) {
    var url = String(C.higgsfieldCadastroUrl || '').trim()
    if (/^https:\/\/[^\s"'<>\\]+$/i.test(url)) el.setAttribute('href', url)
  })

  // valores
  each('[data-num]', function (el) {
    var v = get(el.getAttribute('data-num'))
    if (filled(v)) el.textContent = String(v)
  })
  // créditos (número inteiro com separador de milhar: 1.000)
  each('[data-credits]', function (el) {
    var v = positive(get(el.getAttribute('data-credits')))
    if (v) el.textContent = int(v)
  })
  // créditos de uma parte de vídeo de N segundos: segundos inteiros, com o mínimo por parte ("exemplo" = exemploSegundos)
  each('[data-credits-for]', function (el) {
    var raw = el.getAttribute('data-credits-for')
    var s = positive(raw === 'exemplo' ? C.exemploSegundos : raw === 'minimo' ? C.minimoSegundos : raw)
    var perSecond = positive(C.creditosPorSegundo)
    if (s && perSecond) el.textContent = int(Math.max(Math.ceil(s), positive(C.minimoSegundos)) * perSecond)
  })
  // créditos de um personagem novo (imagens x créditos por imagem)
  each('[data-credits-character]', function (el) {
    var total = positive(C.imagensPersonagem) * positive(C.creditosPorImagem)
    if (total) el.textContent = int(total)
  })
  each('[data-if]', function (el) {
    if (!filled(get(el.getAttribute('data-if')))) el.hidden = true
  })

  // dados da empresa
  each('[data-cfg]', function (el) {
    var v = get(el.getAttribute('data-cfg'))
    if (filled(v)) { el.textContent = String(v); el.classList.remove('is-missing') }
    else missing(el, el.getAttribute('data-placeholder'))
  })
  each('[data-mail]', function (el) {
    var email = get('empresa.emailSuporte')
    if (filled(email)) {
      el.setAttribute('href', 'mailto:' + email)
      if (!el.hasAttribute('data-keep-text')) el.textContent = email
      el.classList.remove('is-missing')
    } else {
      el.removeAttribute('href')
      if (!el.hasAttribute('data-keep-text')) missing(el, 'e-mail de suporte a preencher')
    }
  })
  each('[data-year]', function (el) { el.textContent = String(new Date().getFullYear()) })

  // vídeo de demonstração: sem movimento automático para quem pediu menos animação; pausa fora da tela
  var video = document.querySelector('[data-demo]')
  if (video) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    var play = function () { var p = video.play(); if (p && p.catch) p.catch(function () { video.controls = true }) }
    if (reduce) {
      video.removeAttribute('autoplay')
      video.pause()
      video.controls = true
    } else if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) play()
        else video.pause()
      }, { threshold: 0.1 }).observe(video)
    } else {
      play()
    }
  }

  // barra fixa no celular ("Começar grátis"): aparece depois do topo e some perto do preço, da chamada final e do rodapé
  var bar = document.querySelector('.sticky-cta')
  if (bar && 'IntersectionObserver' in window) {
    var watch = Array.prototype.slice.call(document.querySelectorAll('[data-hide-sticky]'))
    var visible = new Set()
    var update = function () {
      var on = visible.size === 0
      bar.classList.toggle('is-on', on)
      bar.setAttribute('aria-hidden', on ? 'false' : 'true')
      each('.sticky-cta a', function (a) { if (on) a.removeAttribute('tabindex'); else a.setAttribute('tabindex', '-1') })
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target) })
      update()
    })
    watch.forEach(function (el) { io.observe(el) })
  }
})()
