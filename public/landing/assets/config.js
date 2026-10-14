/*
  CONFIGURAÇÃO DA PÁGINA DO CHARACTER
  Edite só os valores abaixo. A página inicial, os Termos de Uso e a Política de Privacidade leem daqui.
  O Character não vende créditos nem pacotes: cada aluno gera na própria conta Higgsfield (com um plano assinado lá) e
  paga os créditos lá. Os números de créditos abaixo só explicam quanto o Higgsfield cobra. Os primeiros vídeos são
  grátis; depois, a hospedagem dos vídeos é paga uma vez (hospedagem, abaixo).
  Campo vazio ('') na empresa aparece na página como "a preencher" até você completar.
*/
window.CHARACTER_LANDING = {
  // Onde o aluno entra no app (todos os botões "Começar grátis" e "Entrar" levam para cá)
  appUrl: '/app',

  // Link para criar a conta no Higgsfield (etapa 1 de "Como funciona" e as perguntas). Ponha aqui o link de afiliado,
  // o mesmo de settings.links.higgsfield_signup_url no app. Só vale endereço https; enquanto isso, o site do Higgsfield.
  higgsfieldCadastroUrl: 'https://higgsfield.ai',

  // Hospedagem 100% gratuita no seu servidor local
  hospedagem: {
    videosGratis: 99999,
    preco: 'Grátis',
  },

  // Créditos do Higgsfield (os mesmos do app: Configurações > Preços e limites). O app mostra o total exato antes de gerar.
  creditosPorSegundo: 11,   // cada segundo de vídeo em 1080p (contado em segundos inteiros)
  minimoSegundos: 4,        // cada parte do vídeo é cobrada com no mínimo 4 s
  exemploSegundos: 15,      // "um vídeo de 15 s usa 165 créditos" (até 29 s: o vídeo sai numa parte só)
  imagensPersonagem: 4,     // imagens geradas para um personagem novo
  creditosPorImagem: 15,    // créditos de cada imagem do personagem (GPT Image 2.5 na qualidade máxima, medido em 13/10/2026: 4 x 15 = 60). 0 = não aparece

  limiteSegundos: 60,       // duração máxima de cada vídeo enviado
  diasNaGaleria: 30,        // quantos dias o vídeo pronto fica disponível para baixar
  diasVideoEnviado: 7,      // quantos dias o vídeo enviado pelo aluno fica guardado (Termos e Privacidade)

  // Dados da empresa (rodapé, Termos e Privacidade)
  empresa: {
    nomeFantasia: 'Character',
    razaoSocial: '',
    cnpj: '',
    endereco: '',
    emailSuporte: '',
    cidadeForo: '',         // cidade/UF do foro nos Termos (ex.: 'São Paulo/SP')
  },
}
