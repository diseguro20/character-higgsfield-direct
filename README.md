# Character School + Higgsfield

`npm start` executa a API Express e o frontend em `/app`. Na Vercel, configure as variáveis de `.env.example` no painel do projeto. O projeto Firebase usa Firestore; a conta de serviço deve poder ler e gravar documentos.

Personagens, referências, clips e jobs são gravados na coleção Firestore `character_school_data`; os arquivos enviados ficam em um Vercel Blob privado, com dono registrado na coleção `character_school_files`. Esta opção funciona sem mudar o plano de faturamento do Firebase. Em desenvolvimento sem Blob, os dados ficam em `data/` e `uploads/` locais. Não configure `VERCEL` sem as credenciais Firebase e Blob.

Na Vercel, arquivos acima de 4 MB são enviados diretamente do navegador ao Blob por URL assinada e depois registrados pela API. O limite de 350 MB exibido na tela ainda depende do espaço temporário e da memória disponíveis na função para analisar e processar o vídeo. No plano Hobby, o armazenamento e a transferência do Blob têm cotas gratuitas que podem interromper novos uploads quando esgotadas.

O acesso direto do dono exige `OWNER_ACCESS_KEY` no formulário da tela de entrada ou no cabeçalho `X-Owner-Access-Key` de `/api/auth/owner`. A chave não é aceita em URL. Leads entram com a própria conta Higgsfield via OAuth; dados e arquivos são isolados por usuário.

A pedido do proprietário, a interface usa somente login OAuth e não solicita chave de API aos leads. A API oficial do Genjutsu, porém, exige uma chave de API da conta que gera. Por isso o botão de vídeo fica bloqueado com uma explicação clara. Nenhum pedido dos leads é enviado com a credencial do dono. O saldo OAuth exibido não representa o saldo da plataforma Higgsfield API.

Credenciais que antes estavam em `server.js` e `data/config.json` foram removidas do código atual. **Revogue e substitua as antigas no Higgsfield**, pois ainda podem existir no histórico Git.

A rota de geração de vistas ainda retorna erro explícito. Ela não cria cópias de fotos nem marca jobs como concluídos sem resultado real.
