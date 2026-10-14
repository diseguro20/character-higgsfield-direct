# 🚀 PROMPT DE EXECUÇÃO PARA CODING AGENT (Antigravity / Cursor / Codex)

> **ATENÇÃO IA:** Você está trabalhando diretamente na pasta onde os arquivos da plataforma clonada foram baixados e extraídos.

### 📁 Estrutura de Arquivos no seu Workspace:
- **`./index.html`**: Landing page / visualizador principal 100% renderizável offline.
- **`./paginas/`**: Páginas individuais do sistema (`painel.html`, `jogar.html`, `categoria.html`, etc.).
- **`./imagens/`**: Todas as imagens, banners, logos e ícones originais em formato `.webp` leve.
- **`./catalogo_produtos.json`**: Dados estruturados de produtos, apostas ou itens mapeados.
- **`./sitemap.txt`**: Todas as rotas do projeto.

## 🎯 SUA TAREFA:
Construa a aplicação completa em **Next.js / React + Tailwind CSS (Full-Stack Pixel Perfect)** com **100% de fidelidade visual, estrutural e funcional**:

1. **🔗 Use os Assets Locais**: Carregue as logos, banners e ícones diretamente de `./imagens/*.webp`.
2. **📐 Design System e Temas**: Preserve a paleta escura (cyber dark / navy neon), glassmorphism, sombras brilhantes e fontes.
3. **📱 Navegação & Modais**: Implemente todas as rotas e sheets deslizantes (`Depositar`, `Sacar`, `Indicar`, `Perfil`, `Instalar App`).

### 🎮 Arquitetura da Plataforma Interativa:
- **Landing Page (`/`)**: Hero com título em gradiente, banner flutuante, botão CTA ("Jogar agora" / "Já tenho conta"), contador online dinâmico, estatísticas em tempo real, mini-tabuleiro animado e carrossel de como jogar.
- **Painel do Usuário (`/painel`)**: Topbar com saldo (real vs bônus + barra de rollover), card de aposta com chips de entrada rápida, seletor de recompensa e barra de navegação inferior com sheets modais (PIX Copia e Cola, chave PIX para saque, links de afiliados N1/N2/N3).
- **Motor do Jogo (`/jogar`)**: Tabuleiro 8×8, bandeja de 3 peças aleatórias, mecânica de arrastar/encaixar blocos, detecção de linhas e colunas completas com explosão de partículas, multiplicador de pontuação e botão de resgate (Cashout).

| Métrica da Plataforma | Valor |
|---|---|
| **URL de Origem** | https://app.charactersschool.com |
| **Páginas Capturadas** | 3 páginas em `./paginas/` |
| **Assets e Imagens** | 0 arquivos em `./imagens/` |
| **Framework Recomendado** | Next.js / React + Tailwind CSS (Full-Stack Pixel Perfect) |

## 📐 Design System Global Extraído

### Paleta de Cores da Interface
rgb(255, 255, 255)

### Tipografia Global
monospace, "Times New Roman"

---

## 🗺️ Rotas e Abas Capturadas
- https://app.charactersschool.com/
- https://app.charactersschool.com/painel
- https://app.charactersschool.com/jogar

---

## 🏗️ Código HTML da Página Principal

```html
<html><head><style>body {transition: opacity ease-in 0.2s; } 
body[unresolved] {opacity: 0; display: block; overflow: hidden; position: relative; } 
</style><meta name="color-scheme" content="light dark"><style data-site-cloner-inlined="true">
body {transition: opacity ease-in 0.2s; } 
body[unresolved] {opacity: 0; display: block; overflow: hidden; position: relative; } 

</style></head><body><pre style="word-wrap: break-word; white-space: pre-wrap;">O Character está fechado no momento. Volte mais tarde.</pre>
        <script>
          (function() {
            document.addEventListener('DOMContentLoaded', function() {
              // Bottom Navigation & Sheet controller
              const navButtons = document.querySelectorAll('[data-nav]');
              const sheets = {
                'depositar': document.getElementById('sheet-deposit'),
                'sacar': document.getElementById('sheet-withdraw'),
                'indicar': document.getElementById('sheet-referral'),
                'perfil': document.getElementById('sheet-profile')
              };

              navButtons.forEach(btn => {
                btn.addEventListener('click', function(e) {
                  const target = btn.getAttribute('data-nav');
                  if (target === 'jogar') {
                    if (window.location.pathname.includes('painel')) {
                      window.location.href = window.location.href.includes('/paginas/') ? 'jogar.html' : './paginas/jogar.html';
                    }
                    return;
                  }
                  Object.values(sheets).forEach(s => { if (s) { s.hidden = true; s.style.display = 'none'; } });
                  const sheet = sheets[target];
                  if (sheet) {
                    sheet.hidden = false;
                    sheet.style.display = 'flex';
                  }
                });
              });

              // Close buttons
              document.querySelectorAll('[data-close], .sheet-close, .app-install-close, #replay-close-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                  const sheetOverlay = btn.closest('.sheet-overlay, .modal-overlay, .app-install-bar');
                  if (sheetOverlay) {
                    sheetOverlay.hidden = true;
                    sheetOverlay.style.display = 'none';
                  }
                });
              });

              // CTA Play buttons
              const ctaPlay = document.getElementById('cta-play') || document.getElementById('hero-play') || document.getElementById('play-cta');
              if (ctaPlay) {
                ctaPlay.addEventListener('click', function(e) {
                  e.preventDefault();
                  if (!window.location.pathname.includes('painel') && !window.location.pathname.includes('jogar')) {
                    window.location.href = window.location.href.includes('/paginas/') ? 'painel.html' : './paginas/painel.html';
                  }
                });
              }
            });
          })();
        </script>
        
</body></html>
```

*📊 Prompt Otimizado para Workspace: ~1.446 tokens*
