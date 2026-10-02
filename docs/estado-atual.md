# Estado atual

Projeto renomeado de Agent Watchers para Locum em 19 de setembro de 2026.

Atualizado em 2 de outubro de 2026.

## Iniciativas: onde parou em 27/09/2026

Plano completo em `docs/plano-iniciativas.md`, decisões em
`docs/adr/0004-iniciativas.md`, motivação em `docs/briefing-iniciativas.md`.
Cada fatia fechou com `npm run verify` e `npm test` verdes em `app/`, e todas
já estão em `origin/main`.

### Fatias que entraram

| fatia | commit | o que trouxe |
|---|---|---|
| 1 | `7325bce` | ADR 0004, briefing e marcos I1 a I5 no roadmap |
| 2 | `fa39c15` | esquema e migração aditiva, `ContextStore`, `InitiativeService`, `PromptService`, paridade de chaves `en` e `pt-BR` no `check:i18n` |
| 3a | `810d9b5` | escopo MCP: agent de iniciativa só enxerga os servidores dela, pelo `runs.initiative_id` fotografado no `createRun` |
| 3b | `c18d19c` | contexto muda só por proposta aprovada, agent de sistema `locum-context`, conflito de publicação, `executor.decide` devolvendo `{ status, run }` |
| 4 | `36f7eee` | 13 ferramentas de iniciativa e prompt no servidor MCP e no chat (fecha o I1) |
| 5a | `20606a2` | rota `#/initiatives`, lista e detalhe com a aba Contexto, fixture e smoke |
| 6 | `38e2874` | painel do Início, revisão de `context.update`, `initiatives.staleDays` |
| F | `c6a3271` | armadilhas, contagens e roadmap do dia |
| 5b | `97d8124` | formulários, iniciativa atual, chips em agents e execuções, paleta e assistente (fecha o I2) |
| 7 | `ca85572` | sessão do Claude no Terminal ou iTerm com o contexto da iniciativa, passagem voltando como proposta `append`, deep link `locum://session/ended` (fecha o I3 no código) |

Nenhuma fatia ficou pela metade. Há um `git stash` antigo, "fatia 3b parcial",
com uma primeira tentativa da 3b que foi refeita do zero e está no `c18d19c`.
Não tem nada que falte no código; pode ser descartado com `git stash drop`.

### O que falta de I1 a I3

- I1: nada.
- I2: nada do escopo funcional. O redesenho visual (I2b) fica para depois de
  alguns dias de uso, só registrado no roadmap.
- I3: nada no código. Falta o teste à mão: abrir uma sessão de verdade pelo
  botão, escrever a passagem e ler de volta; e o deep link de fim de sessão,
  que só chega com o app empacotado (`npm run dist:dir`).
- Fora do caminho crítico: O1 e O2 prontos (as rotas já estão em inglês, com
  o hash antigo redirecionado), e o I4 coberto pela vitrine de conexões.

### Decisões tomadas

- Um agent pertence a no máximo uma iniciativa; o escopo MCP vem do run, não
  do agent atual, inclusive na retomada.
- Contexto mora em pasta local (`~/Locum/initiatives/<slug>/context.md`,
  raiz configurável por `initiatives.root`, `LOCUM_INITIATIVES_DIR` nos
  testes); o banco só indexa. Muda só por proposta aprovada: `append` sem hash,
  `replace` com hash, conflito fecha a pendência como `conflict`.
- Prompt é entidade versionada, sem gatilho.
- O chat ganha as escritas internas de iniciativa; aprovar e abrir sessão
  continuam só por clique.
- Status `paused` ou `done` da iniciativa não bloqueia gatilho nesta rodada.
- `initiatives.staleDays` configurável desde já: padrão 7, de 1 a 90.
- Na O2, os ids de rota em português (`execucoes`, `configuracao`, `revisao`)
  viram inglês, com redirecionamento do hash antigo. O id `inbox` fica, com
  rótulo "Início".
- Identificador, caminho, rota, protocolo e chave em inglês; texto visível só
  pelos dicionários `en` e `pt-BR`. O termo do produto é "iniciativa" /
  "initiative".
- Em aberto: quando docs, ADRs e mensagens de commit passam para inglês.
- Sessão no terminal (fatia 7): o Locum gera `.locum/session.md`,
  `.locum/session-settings.json` e `.locum/open-session.command` na pasta de
  contexto e roda `open -a Terminal|iTerm` no script. O `claude` é achado por
  `LOCUM_CLAUDE_BIN`, depois `zsh -ilc 'command -v claude'`, depois a lista
  fixa dos instaladores; sem achar, o script usa o `claude` do PATH do
  terminal e a tela avisa. O `deny` barra `context.md` e `.locum/**` com
  `//caminho` absoluto (confirmado no Claude Code 2.1.283).
- Uma passagem por sessão: `handoffs/<data>-<8 primeiros do id>.md`, gravado
  em `sessions.handoff_path` ao abrir. O plano dizia `<data>.md`, que colidiria
  com duas sessões no mesmo dia. "Ler passagem" pega a mais nova ainda não
  lida, de sessão aberta ou encerrada, e marca a sessão como `read`.
- Abrir sessão e ler passagem são só clique (aba Ações e paleta); não estão
  no chat nem no MCP.

### Primeiro passo da próxima sessão

Testar a fatia 7 à mão: abrir uma sessão pela aba Ações da iniciativa
`example`, conferir que o Claude não consegue editar o `context.md`, escrever a
passagem e ler de volta pela revisão. Depois empacotar com `npm run dist:dir` e
conferir que o fim da sessão volta pelo deep link. Com isso o I3 fecha; o que
sobra é O1, O2 e a fatia 9.

As armadilhas da fatia 7 estão no fim de "Armadilhas encontradas".

## O que existe e roda

Núcleo headless em `app/`, verificação de tipos limpa. A casca Electron já sobe
e carrega a página construída em `app/renderer`, ainda sem tela de verdade.
Tudo que existe continua alcançável pela linha de comando, com o mesmo executor
que a interface vai usar.

| área | estado |
|---|---|
| esquema SQLite com 27 tabelas | pronto, sete a mais desde a virada para iniciativas: `initiatives`, `initiative_workspaces`, `initiative_mcp_servers`, `initiative_links`, `prompts`, `prompt_versions` e `sessions` |
| migração de esquema no aplicativo | sete migrações em `app/drizzle` aplicadas na subida do processo principal, banco existente adotado sem recriar tabela |
| AgentSpec em zod, herança de ferramentas, ordenação topológica | pronto |
| registro de provedores e resolução de fallback por máquina | pronto, com cadastro pelo serviço; a chave de cada provedor entra pela interface, vai para o keychain e o registro é remontado na hora |
| provedor compatível com OpenAI cadastrável | identificador, nome e endereço base no banco, o registro monta os fixos mais os cadastrados, chave própria no keychain e remoção avisando onde o provedor aparece |
| registro MCP com spawn sob demanda e encerramento por ocioso | pronto, lendo o cadastro do banco; um pool só por processo, que vive entre execuções, reaproveita o servidor que continua com o mesmo cadastro, troca o que mudou e fecha no tempo ocioso, no fim do comando da linha de comando ou na saída do aplicativo |
| runtime nativo sobre o AI SDK | pronto, sem teste com chave real; custo calculado pelos tokens do laço inteiro vezes o preço cadastrado em `model_prices`, e zero com aviso quando o modelo não tem preço |
| cache de prompt | o executor separa o começo literal do template, antes do primeiro marcador, e o runtime nativo manda sistema e skills, esse trecho estável e o resto nessa ordem, com a marca de cache da Anthropic no fim do estável; OpenAI e Gemini guardam prefixo sozinhos e só precisam da ordem. Triagem e auditoria do `pr-review` trazem as instruções antes dos dados do evento e o diff por último. O passo grava em `cache_read_tokens` o que o provedor informou ter lido de cache, nulo quando ele não informa, pelo runtime nativo e pelo `claude -p` |
| runtime de assinatura sobre `claude -p` | pronto e verificado |
| runtime de assinatura sobre `codex exec` | pronto no código, flags e falha conferidas contra o `codex-cli` 0.160.0 sem login, falta uma execução com conta; aparece quando `codex login status` sai com zero, roda isolado (`--ignore-user-config`, `--ephemeral`, `--sandbox read-only`, pasta temporária) e recebe só os servidores e ferramentas do passo por `-c mcp_servers.*`. O `error` de reconexão no meio do turno não é falha; só `turn.failed` é |
| executor durável com retomada | pronto e verificado |
| orçamento por execução e por dia | teto em dólar e teto em tokens, por run e por dia; o gasto vai para `usage_daily` em toda saída do trecho executado, `done`, `paused` ou `failed`, uma vez por trecho, e a retomada não conta execução nova; o teto do dia soma o que o trecho em curso ainda não gravou |
| fila de aprovação com identificador externo antes da publicação | pronto; a decisão fecha o passo de ação, em `done` aprovado e em `skipped` rejeitado, e o executor retoma o run até o fim; na retomada, passo parado em aguardando com a pendência já fechada é reconciliado pela decisão gravada; a edição pela janela troca só a lista de achados, validada um a um, e dono, repositório e pull request ficam os que o executor gravou |
| fonte GitHub com varredura por cursor | escrito, sem teste com token; o token sai do cofre e o ambiente é o caminho de trás; cursor com hora completa e um por escopo de consulta, busca paginada, repositório exato vai na consulta, rascunho fora por padrão (`includeDrafts` no gatilho), e o commit de cabeça já gravado pula arquivos e checks |
| corte do diff | lockfile, arquivo minificado, pasta de build e código gerado saem antes do modelo; depois vale um teto de caracteres, 200 mil por padrão e trocável pelo `GithubService`, cortando por arquivo inteiro; o evento guarda o que ficou fora e por quê, e triagem e auditoria recebem a lista para não afirmar o que não leram |
| status de CI na auditoria | a ingestão lê os check runs do commit de cabeça, sem modelo, e o evento guarda o estado, verde, vermelho, pendente, sem check ou ilegível, com a lista e um resumo em texto; a auditoria recebe o resumo por `{{event.ci.summary}}` e não gasta achado repetindo o que um check vermelho já aponta; falha de leitura, como token sem permissão de Checks, vira aviso no resumo em vez de derrubar a ingestão |
| triagem com categoria | a triagem do `pr-review` devolve a categoria da mudança, entre fix, feature, refactor, config e dependency, e os arquivos sensíveis com a área, banco, concorrência, autenticação, pagamento ou rota pública, presos no esquema de saída; a auditoria recebe a categoria por `{{steps.triage.category}}` e ajusta o que lê, e atualização de dependência pede changelog e uso em vez de lógica |
| prompt de auditoria | seis focos trazidos da versão Python, regressão funcional, idempotência e concorrência, segurança e autorização, erro engolido, quebra de contrato e lacuna de teste; rubrica do que é crítico, alto, médio e baixo; título e descrição do pull request para pegar a intenção que o código contradiz; e `confidence` obrigatório por achado, alto, médio ou baixo, que atravessa a edição da revisão e aparece na tela. Verificado com os dois eventos sintéticos: o de defeito plantado acha todos, e o `demo limpo`, com diff correto, volta com zero achado |
| fonte por consulta a servidor MCP | pronta e verificada contra o servidor de brinquedo; cursor por servidor e ferramenta, `{{cursor}}` trocado nos argumentos do cadastro, e deduplicação pelo `id` do item |
| fonte de menções do Slack | pronta e verificada contra o servidor de brinquedo; o servidor MCP de Slack e os canais entram pela configuração, um cursor por canal, e o evento sai com autor, canal, texto e vínculo da thread; nenhum token de Slack no Locum |
| agent de digest do Slack | pronto e verificado com conversa sintética; a ingestão agrupa por canal e por thread e filtra ruído antes do modelo, e o digest para na inbox como proposta de leitura, sem ação de saída |
| ação de resposta no Slack | pronta e verificada com evento sintético; o texto vem do passo de modelo, o canal do evento e a thread é conferida contra o que já foi lido, e a pendência guarda o texto exato que sairia; publicar só depois do clique |
| ação de review com modo rascunho e modo aprovação | escrita, sem teste com token; publica com o veredito da auditoria como evento da review, APPROVE, COMMENT ou REQUEST_CHANGES, e pendência sem veredito sai como comentário; aprovar ou pedir mudança nunca sai sozinho, porque o handler segura a proposta na fila mesmo com o passo em modo automático |
| veredito da review | a auditoria devolve `verdict` preso no esquema de saída, com o critério de cada um no prompt; a tela de revisão mostra o veredito e deixa trocar antes de aprovar, gravando na pendência junto com os achados; aprovar sem achado é publicável, comentar sem achado não |
| tracker de tarefa, Jira e GitHub Issues | adaptador, cadastro no banco e credencial no keychain; teste de conexão e lista de destinos pela interface, verificado contra um tracker de mentira em 127.0.0.1 |
| Slack pelo servidor oficial | o painel do Slack guia a criação de um app no workspace a partir de manifesto (cliente público com PKCE, retorno fixo em `http://localhost:41753/callback`), recebe o client id e autoriza no navegador; a origem do Slack passa a usar `slack_read_channel` e `slack_send_message`; com a conexão feita, o gatilho `slack-inbox` acorda um agent em menção e mensagem direta. Verificado com servidor de autorização de mentira; contra o Slack de verdade, ainda não |
| Teams pelo Microsoft Graph | cada organização registra um app no Entra (tenant único, cliente público com PKCE, retorno fixo em `http://localhost:41754/callback`), e o painel recebe tenant e client id e autoriza no navegador; escopos `User.Read`, `Chat.Read` e `ChatMessage.Send`, nenhum de administrador; o gatilho `teams-inbox` acorda um agent em menção e mensagem direta, e a ação `teams.post` responde na conversa depois do clique. Verificado com Graph de mentira; contra o Teams de verdade, ainda não |
| Jira pela conexão Atlassian | tipo `jira-atlassian`, que fala com o servidor MCP oficial usando a autorização da vitrine, sem e-mail nem token; o Jira mora no painel da Atlassian e o GitHub Issues no do GitHub, e o cartão Jira separado saiu |
| passo de ação que abre tarefa | `tracker.create_issue` monta o item e para na fila; corpo escrito por um passo de modelo antes dele, modo travado em `approve` pelo handler |
| descoberta de skills e seleção por arquivo alterado | pronto |
| servidor MCP próprio | 32 ferramentas de leitura, configuração, execução e iniciativa sobre a camada de serviço, servido pelo próprio app em `--mcp` e cadastrado no Claude Code por um botão em Conexões |
| vitrine de conexões | catálogo de serviços com logo, estado, busca e categoria em Conexões; servidor MCP remoto com OAuth e registro automático de cliente (Linear, Notion, Atlassian, Sentry, Cloudflare, Vercel, Supabase, Stripe, Figma) liga num clique pelo navegador, com PKCE, retorno em loopback, token no keychain e renovação antes de cada uso; servidor próprio entra pelo endereço; verificado contra um servidor de autorização de mentira em 127.0.0.1, ainda não contra os serviços de verdade |
| iniciativa como unidade de trabalho (I1) | `InitiativeService` cadastra, liga servidor MCP, workspace, agent e link; `ContextStore` guarda a pasta de contexto em disco e o hash do arquivo; contexto só muda por proposta aprovada na fila, decidida pelo agent de sistema `locum-context`; agent ligado a uma iniciativa não pode passar a exigir servidor de fora dela, checado ao ligar e a cada `upsert` de spec |
| ferramentas de iniciativa no chat interno | 13 entradas do catálogo (`electron/chat-tools.ts`), de um total de 26, para criar e configurar iniciativa, ligar agent, propor mudança de contexto e cadastrar prompt |
| prompts por iniciativa | `PromptService` com versionamento; leitura por iniciativa via `list_prompts({ initiativeId })`, sem ligação a agent nesta rodada |
| cadastro de gatilho | serviço pronto, nasce desabilitado, cadastrado pela interface; o gatilho de varredura filtra por autoria do pull request, comparando o autor gravado no evento com a conta do token |
| reconciliador de review humano | pronto, verificado com evento e reviews sintéticos, sem teste com token; disparado pela batida do agendador, com cursor próprio por execução |
| métricas por versão de agent | agregação de `finding_outcomes` em `agent_metrics`, por versão mais conjunto de skills |
| agendador | cursor de tempo por gatilho, batido de fora, sem relógio próprio; acordado pelo evento de energia do Electron |
| camada de serviço, 28 módulos em `src/services` | pronto, com o `PriceService` do preço por modelo, `InitiativeService`/`PromptService` das iniciativas e `SessionService` da sessão no terminal |
| servidor MCP próprio, 32 ferramentas | pronto |
| reconciliador de review humano | pronto, sem teste com token |
| métricas por versão | pronto |
| agendador por cursor | pronto, batido pelo `resume` do `powerMonitor`; cada batida confere o que fechou desde a última |
| casca Electron | processo principal com `--smoke`, bandeja com contagem de pendências, início no login por preferência guardada, eventos de energia batendo o agendador e deep link de OAuth |
| credenciais no keychain | `safeStorage` cifra, o banco guarda só a referência, e sem keychain vale a variável de ambiente |
| notificação nativa | um aviso por run, para achado crítico na fila ou run que falhou, com o clique apontando para o run |
| deep link `locum://` | esquema registrado no sistema, retorno de OAuth com PKCE roteado do `open-url` até o cofre |
| ponte entre janela e serviços | preload em sandbox, 96 canais tipados pelos próprios métodos dos serviços (`BRIDGE_CHANNELS`; o catálogo do renderer, `READ_CHANNELS` mais `ACTION_CHANNELS`, cobre 82 deles, e deixa `approvals.decide` e alguns canais de agent fora por decisão do ADR 0003), decisão de aprovação só encaminhada, e guarda de compilação contra canal que abra tarefa ou publique no Slack |
| tela de iniciativas (I2) | lista e detalhe (contexto, agents, execuções, ações) por rota com sub-rota de hash; painel de iniciativas no Início; revisão de pendência `context.update` com diff e aviso de conflito; `staleDays` (dias parados até "sem sinal") configurável na tela de configuração, de 1 a 90, padrão 7 |
| sessão da iniciativa no terminal (I3) | `SessionService` gera em `.locum/` da pasta de contexto o prompt (`session.prompt.*` no idioma da preferência), o `deny` de `Edit` e `Write` em `context.md` e `.locum/**` e o script `open-session.command`, que o `open -a` roda no Terminal ou no iTerm (escolha na configuração); o `claude` sai de `resolveClaudeBinary`; "Ler passagem" vira proposta `append` na fila; `locum://session/ended` fecha a sessão com nonce de uso único; botões na aba Ações e comando na paleta, sem entrada no chat nem no MCP |
| interface | esqueleto do renderer em Vite com React e Tailwind, construído para `dist/renderer` e carregado pela janela, já lendo pela ponte |
| componentes da interface | shadcn e AI Elements vendorizados em `app/renderer/components`, tema escuro por padrão, sem dependência de rede |
| cliente da ponte no renderer | `app/renderer/lib/bridge.ts` com catálogo de leitura escrito à mão e hook `useRead`, a janela lendo agents, execuções e fila |
| layout e roteamento | barra lateral com os quatro destinos, rota por hash com sub-rota de detalhe, paleta de comandos pelo atalho, ainda sem comando |
| tela de execuções | lista virtualizada com estado, custo e agent, detalhe com a linha do tempo dos passos e botão de reexecutar por passo |
| tela de agents | somente leitura: lista, histórico de versões, comparação de spec linha a linha, e por passo o modelo pedido contra o que esta máquina resolve |
| tela de configuração | provedores com disponibilidade e campo de chave por provedor, cadastro de gateway compatível com OpenAI, tabela de substituição de modelo, servidores MCP com testar conexão e listar ferramentas por token, credencial do GitHub com guardar, conferir e esquecer, repositórios observados com gatilho de varredura e filtro de autoria, canais do Slack observados por servidor MCP, preço por modelo editável na linha de cada provedor, e orçamentos com o gasto do dia em dólar e em tokens, avisando quando um modelo sem preço deixa o teto medindo só em tokens |
| grafo da execução | desenho somente leitura sobre a família de workflow do AI Elements, lendo `needs` do spec, com estado por cor da borda |
| base de i18n | i18next e react-i18next com dicionário em `app/locales`, idioma vindo de `app.getLocale()` pela ponte, preferência em `settings` por cima, plural por `Intl.PluralRules` e chave ausente estourando fora de app empacotado; 699 chaves-folha em `en.json` e 729 em `pt-BR.json`, as 30 a mais são a forma plural `_zero`, que o português usa e o `Intl.PluralRules` do inglês não distingue |
| texto do processo principal | menu da bandeja, notificação, item de login e a saída do `--smoke` pelo mesmo dicionário, com instância própria do i18next sem React |
| texto da inbox e das execuções | as duas telas pelo dicionário, com plural de achado, execução e pendência, e os rótulos de severidade e de estado num módulo só |
| texto das outras telas | agents, configuração, barra lateral, paleta de comandos, grafo e o painel do assistente pelo dicionário, com o prompt de sistema do assistente junto |
| guarda contra literal solto | `app/scripts/check-i18n.mjs` varre `renderer/src`, `renderer/lib` e `electron` por posição visível e falha com a lista; ligado em `npm run verify` |
| seleção de idioma | seção na tela de configuração com os idiomas disponíveis e a opção de seguir o sistema, gravada em `settings`, aplicada sem recarregar a janela e valendo também para bandeja e notificação |
| ícone do aplicativo | `app/build/icon.svg` versionado e `app/build/icon.icns` gerado dele por `npm run build:icon`, com `sips` e `iconutil` do próprio sistema |
| empacotamento | electron-builder por `app/electron-builder.yml`, alvos `dmg` e `zip` para arm64 e x64, saída em `app/release`, com dicionário, migração e binário nativo dentro do pacote; `node_modules` fora e o processo principal embutido, `.app` de 234 MB e imagem de 100 MB |
| fumaça fora do banco real | `--smoke` sem `LOCUM_HOME` roda numa pasta de rascunho vazia, semeada com o agent `pr-review` e apagada na saída; com `LOCUM_HOME`, como o loop faz, a pasta escolhida vale |
| fumaça contra o pacote | `npm run smoke:dist` roda o binário de dentro do `.app` com `--smoke`, com a mesma bateria do smoke de desenvolvimento |
| atualização automática | electron-updater atrás de interruptor em `settings`, desligado por padrão, sem carregar o módulo nem sair para a rede enquanto estiver desligado |
| credencial do GitHub na interface | seção na configuração guarda o token no keychain pelo `GithubService`, mostra se existe, de quem é e quando foi conferido, e nunca o valor; o botão de conferir pergunta ao GitHub a conta e os escopos |
| repositórios observados na interface | seção na configuração cadastra dono, padrão de repositório e cadência, e mostra a última varredura e a próxima; o gatilho nasce parado e ligar é o segundo clique |
| canais do Slack na interface | seção na configuração escolhe qual servidor MCP responde pelo Slack e quais canais o Locum lê, sem campo de token: a credencial é a do servidor MCP |
| guia da primeira execução real | `docs/primeira-execucao.md` na ordem em que alguém faria, do provedor ao primeiro review na fila, com a seção de tracker explicando onde pegar a credencial, o que o Locum cria e por que abrir tarefa nunca é automático |
| teste unitário | `npm test` pelo executor embutido do Node com `tsx` como carregador, sem dependência nova; 35 arquivos em `app/test`, banco em memória montado pelas migrações, e `LOCUM_HOME` apontado para pasta temporária antes de qualquer importação, para que nenhum teste alcance o banco de verdade; cobre ordenação topológica, resolução de fallback com ciclo, rebaixamento de modo de ação, o run que termina depois da decisão, aprovada ou rejeitada, e o orçamento: custo pelo preço cadastrado, gasto gravado ao pausar e ao falhar, e teto em dólar e em tokens interrompendo o runtime nativo, o corte do diff: descarte por tipo de arquivo, teto por arquivo inteiro e a lista chegando ao prompt, a edição da revisão que não troca o alvo, o esquema da triagem com categoria e a categoria chegando à auditoria, o prompt da auditoria com focos, rubrica e intenção do pull request, a confiança obrigatória na saída e aceita na edição, o veredito no esquema da auditoria, como evento da review, trocável na edição e segurando a fila em modo automático, o status de CI: estado por conclusão do check, leitura pelo commit de cabeça, falha de leitura sem derrubar a ingestão, resumo gravado no evento e chegando à auditoria, o pool MCP: duas execuções no mesmo processo do servidor, fechamento depois do ócio e troca de cadastro, e o cache de prompt: ordem do estável antes do variável, marca no fim do estável e tokens de cache gravados no passo; e as iniciativas: escopo de agent fora dos servidores da iniciativa, o run da decisão de contexto não contando execução nova, `InMemoryTransport` do MCP SDK ligando cliente e servidor sem processo externo, e `staleDays` configurável no painel do Início |

## Execução verificada

Evento sintético com quatro defeitos plantados em C#, rodando na assinatura:

```
 1  Triagem              done      claude-code/claude-sonnet-5   62s
 2  Auditoria            done      claude-code/claude-opus-5     74s
 3  Contexto de deploy   skipped   servidores indisponiveis: argocd
 4  Comentar no PR       awaiting_approval

custo: 0.000 USD cobrado, 0.930 USD equivalente
```

Os quatro defeitos foram encontrados. Passo opcional sem servidor foi pulado com
motivo registrado, o passo de ação parou o run e criou a pendência, e a retomada
não reexecutou os passos concluídos.

## Comandos

```bash
cd app
npm install
npm run db:push                       # desenvolvimento: empurra o esquema direto
npm run db:generate                   # gera a migração depois de mexer no schema.ts
npm run dev seed
npm run dev demo                      # não precisa de credencial
npm run dev demo limpo                # diff correto, tem que voltar sem achado
npm run dev fixture:run               # execução plantada no banco, sem chamar modelo
npm run dev review owner/repo#123     # precisa de GITHUB_TOKEN
npm run dev poll 'time/.*'
npm run dev digest                    # junta o Slack desde a última entrega e roda o agent de digest
npm run dev inbox
npm run dev runs
npm run dev reconcile <run-id>        # precisa de GITHUB_TOKEN, só leitura
npm run dev metrics                   # recalcula e imprime precisão por versão
npm run dev rerun <run-id> audit
npm run dev triggers                  # gatilhos cadastrados e quando o agendador quer a próxima batida
npm run dev tick                      # uma batida nos gatilhos habilitados, e a conferência do que fechou
npm run dev providers
npm run dev mcp
npm run dev mcp:register locum-fixture stdio 'npx tsx src/fixtures/mcp-fixture-server.ts'
npm run dev secrets                   # credenciais guardadas e quem aponta para elas
npm run dev secret:link mcp:locum-fixture mcp/locum-fixture
npm run dev secret:unlink provider:anthropic
npm run dev startup                   # o Locum sobe junto com o login?
npm run dev startup:on                # passa a subir, valendo na próxima subida
npm run dev startup:off               # deixa de subir
npm run dev updates                   # mostra o interruptor da atualização automática
npm run dev updates:on                # liga a verificação na subida do app
npm run dev updates:off               # desliga a verificação
npm run mcp                           # servidor MCP próprio, por stdio
npm run dev approve <id>
npm run dev resume
npm run build:main                    # empacota o processo principal em dist/main.cjs
npm run build:renderer                # constrói a página em dist/renderer
npm run build                         # processo principal mais página
npm run smoke                         # sobe o Electron sem janela e sai 0
npm run check:i18n                    # acusa texto cravado fora do dicionário
npm run verify                        # tipos, guarda de i18n, build e smoke
npm test                              # teste unitário, banco em memória
npm run build:icon                    # regera build/icon.icns a partir do SVG
npm run dist:dir                      # empacota sem instalador, em release/mac-<arch>/Locum.app
npm run dist                          # gera o .dmg e o .zip
npm run smoke:dist                    # roda o binário de dentro do .app e sai 0
npx electron dist/main.cjs --set-secret provider/anthropic     # valor pelo stdin
npx electron dist/main.cjs --remove-secret provider/anthropic
npm start                             # sobe o Electron com janela
```

## Armadilhas encontradas

**Instalação.** O pnpm 12 e o npm 11 bloqueiam scripts de build por padrão. Para
`better-sqlite3` e `esbuild` é preciso aprovar com `npm approve-scripts` antes de
`npm rebuild`.

**`drizzle-kit push` com dados.** Alteração que exige recriar tabela falha com
`SQLITE_CONSTRAINT_FOREIGNKEY` quando já existem linhas. Coluna nova se resolve
com `alter table add column` manual.

**Linha de comando não migra o banco.** Só o processo principal do Electron
aplica as migrações na subida. Depois de migração nova, a linha de comando
estoura em `no such column` até alguém rodar `migrateDb()` no banco dela. Não
usar `db:push` para isso num banco que já foi adotado pelas migrações: o
`push` cria a coluna sem registro, e a próxima subida do aplicativo tenta o
`alter table` de novo e falha com coluna duplicada.

**Autoria da review automática.** O token é pessoal, então o que o Locum
publica sai assinado pela mesma conta que revisa a mão. Sem marca no corpo, o
reconciliador leria o próprio achado como confirmação humana dele mesmo. Por
isso tudo que sai leva um `<!-- locum -->`, invisível no GitHub, e o
reconciliador descarta a review e os comentários que a carregam.

**Dois ABIs para o mesmo `better-sqlite3`.** O binário em `node_modules` é
compilado para o ABI do Node, que a linha de comando usa por `tsx`. O Electron
tem ABI próprio e recusa esse binário, e os dois não cabem no mesmo caminho.
O `build:main` recompila para o Electron, guarda a cópia em `app/native/`, e
devolve o `node_modules` ao estado de Node. Quem carrega escolhe: o processo
principal aponta `LOCUM_SQLITE_BINDING` para a cópia antes de importar o núcleo,
e sem a variável vale o caminho padrão.

**Item de login fora de app empacotado.** O macOS só aceita
`app.setLoginItemSettings` de aplicativo empacotado, assinado e notarizado.
Rodando por `npx electron` a chamada volta com `Operation not permitted` no log
e nada é registrado. Por isso a preferência guardada no banco é a fonte da
verdade, e o processo principal reconcilia o sistema com ela a cada subida, em
vez de ler o sistema e acreditar. A preferência tem três estados: sem linha na
tabela `settings` quer dizer que ninguém decidiu, e aí o app não mexe em nada.

**A chave do provedor precisa valer sem reabrir a janela.** Guardar no cofre
não basta: o registro de provedores é um mapa de closures montado uma vez, e
quem já o tinha em mãos continuaria vendo o provedor apagado. Por isso
`setSecret` e `clearSecret` terminam em `loadSecrets`, que remonta o registro
inteiro, e por isso o processo principal chama `loadSecrets` logo depois de
ligar o cofre, e não só quando um executor é montado: a tela de configuração
pergunta a disponibilidade assim que abre.

Junto com isso, a variável de ambiente que cada chave preenche saiu da tabela
`PROVIDER_SECRET_VARS` e foi para `secretVar`, dentro da própria entrada do
registro. Era o único lugar onde ela não pode discordar do `requires` e do
`available` que estão duas linhas acima, e é também o que torna possível
examinar o caminho com um provedor inventado: o smoke monta um, com catálogo
num servidor em 127.0.0.1, porque gravar em `provider/anthropic` para provar o
caminho destruiria a chave de quem desenvolve.

**Onde o segredo cabe.** O Electron não expõe a API de item do keychain, só o
`safeStorage`, que guarda a chave de cifra no keychain e devolve texto cifrado
para quem chamou. Então o par é chave no keychain mais texto cifrado num arquivo
por credencial dentro da pasta do app, e no banco fica apenas o `credential_ref`.
Gravar exige o app aberto; quem usa a linha de comando lê `undefined` e cai para
a variável de ambiente, que é como sempre funcionou.

**A janela não desenha antes de saber o idioma.** A etiqueta do sistema só
existe do lado do Electron, então o provedor de idioma espera a resposta da
ponte antes de montar a árvore. Montar em inglês e corrigir depois faria a tela
piscar em toda subida de quem escolheu português. A consequência é que o smoke
não pode conferir `#root` logo depois do `loadFile`: ele espera o marcador, como
já fazia com as leituras da ponte.

**A chave do provedor cadastrado precisa do provedor primeiro.** Nos fixos, a
variável que a chave preenche está escrita no código, então ela existe antes de
qualquer leitura do banco. No cadastrado ela é derivada do identificador e só
existe depois que o provedor entra no registro, e o `loadSecrets` lia a
variável do registro anterior. Por isso ele monta duas vezes: primeiro um
registro sem segredo nenhum, só para saber quais variáveis existem, e depois o
definitivo com as chaves. Sem isso, a chave de um gateway recém-cadastrado
ficaria guardada e sem valer até alguém reabrir o app.

**Marcador de credencial no cadastro de MCP.** O valor `${credential}` em `env`
ou `headers` é onde o segredo entra na hora de conectar. A substituição acontece
num caminho separado do que alimenta tela, log e ferramenta de leitura, para que
não exista listagem por onde um segredo decifrado escape. Sem nada guardado, a
entrada de `env` cai para a variável de ambiente de mesmo nome, e não havendo
nem isso a entrada some do mapa: mandar o marcador adiante viraria um token
literal numa chamada de rede.

**O serviço entrega o fato, a casca escreve a frase.** O `NoticeService` passou
a devolver o nome do agent e a contagem de críticos em vez de título e corpo
prontos. Texto montado no serviço prenderia o aviso a um idioma só, e a linha de
comando e o servidor MCP não falam necessariamente o mesmo da janela. A exceção
é a mensagem de erro do run, que sai como veio: ela é do provedor, e traduzir
seria inventar. O processo principal monta a própria instância do i18next, sem
`react-i18next`, e o que ele compartilha com a janela é o par de arquivos de
dicionário, não o módulo que cria a instância.

**O prompt de sistema do assistente é texto de produto.** Ele saiu do código e
foi para o dicionário, em `assistant.system`. A linha que manda responder em
português é justamente a que precisa mudar quando a janela está em inglês, e
deixá-la numa constante faria o assistente responder num idioma com a tela em
volta dele em outro. O prompt é lido a cada envio, e não uma vez por subida,
porque o idioma do processo principal pode ter mudado desde que o módulo
carregou.

**O destino da barra lateral guarda a chave, não o título.** `ROTAS` passou a
carregar `rotulo: "nav.inbox"` no lugar do texto pronto. A barra e o cabeçalho
leem a mesma chave, então a troca de idioma muda os dois de uma vez e nenhum dos
dois fica com uma cópia do texto para envelhecer sozinha.

**O marcador do Tailwind ficou sem texto dentro.** O que o smoke mede ali é o
estilo calculado, e frase nenhuma precisa existir para isso. A que existia era
texto fora do dicionário sem ninguém para ler.

**Trocar de idioma pela tela avisa o processo principal.** O canal
`i18n.setPreference` grava em `settings`, devolve o estado novo para a janela e,
na mesma chamada, aplica o idioma na instância do processo principal e remonta o
menu da bandeja. Sem isso a janela viraria de idioma sozinha e a barra do sistema
continuaria na língua da subida até alguém reiniciar o app, que é justamente o
tipo de desencontro que ninguém repara num menu que quase ninguém abre.

**O nome de cada idioma não sai do dicionário.** Ele vem do `Intl.DisplayNames`
no próprio idioma, e não de uma chave traduzida para o idioma corrente: quem
abre essa seção é quem está com a janela numa língua que não lê, e "Portuguese"
escrito em inglês não ajuda a achar o português na lista. Seguir o sistema é
botão à parte, e não o mesmo que escolher o idioma que a máquina fala hoje: quem
segue o sistema vira junto quando a máquina virar.

**A guarda de i18n olha a posição, não o formato da string.** Procurar "texto
que parece prosa" acusaria nome de evento, consulta SQL e caminho de arquivo, e
o barulho faria a guarda ser desligada na primeira semana. O
`app/scripts/check-i18n.mjs` lê o TypeScript pelo compilador e só conta literal
que chega a uma pessoa pelo lugar onde está: conteúdo de JSX, atributo que o
navegador mostra ou lê em voz alta, e propriedade que o Electron pinta em menu
ou notificação. Fora dessas quatro posições, literal é identificador até prova
em contrário, e é daí que saem de graça as exceções de nome de canal, classe de
CSS e chave de dicionário. O `renderer/components` fica fora da varredura: o
texto em inglês do shadcn e do AI Elements veio do registry, e reescrevê-lo
quebraria a próxima atualização do upstream.

**Prefixo de versão e tecla de atalho também são texto.** A guarda achou `v{n}`
nas telas de agents e de execuções e o `⌘J` no botão do assistente, e os três
foram para o dicionário em vez de para a lista de exceções. Uma guarda que
absorve na exceção o que acabou de encontrar não guarda nada.

**Rótulo de severidade e de estado passa por lista conhecida.** A severidade e
o estado chegam do banco como texto solto, e a guarda de chave ausente está
ligada fora de app empacotado: um valor novo gravado lá atrás derrubaria a tela
inteira em vez de aparecer cru. O `app/renderer/lib/rotulos.ts` confere contra a
lista antes de consultar o dicionário, e devolve o valor como veio quando não
reconhece. Sem tradução é ruim; tela em branco é pior.

**O crachá de estado guarda o valor cru no marcador.** O texto do crachá segue o
idioma, mas `data-locum-estado` continua com o que o serviço devolveu. O smoke
compara os dois lados, e comparar contra o texto da tela faria a verificação
depender do idioma da máquina que roda o loop.

**Notificação é sobre o que chegou agora.** A primeira leitura da fila na
subida só marca o que já estava lá, sem mostrar nada: subir o Locum depois de
uma semana desligado despejaria uma pilha de avisos de coisa velha. O acumulado
tem lugar próprio, que é a contagem na bandeja. Por isso a memória do que já foi
avisado é de sessão e não vai para o banco.

**Dono do esquema `locum://` fora de app empacotado.** Ao contrário do item de
login, o `setAsDefaultProtocolClient` funciona rodando por `npx electron`, e o
`isDefaultProtocolClient` volta verdadeiro. O que fica registrado no sistema,
porém, é o binário do Electron, não o Locum: enquanto não houver empacotamento,
abrir um `locum://` acorda o Electron sem o `dist/main.cjs`. O empacotamento
precisa declarar `CFBundleURLTypes` no `Info.plist`, porque a chamada em tempo
de execução não substitui a declaração do bundle.

**A URL do deep link é entrada de fora.** Qualquer programa da máquina abre um
`locum://`, então nada do que vem nela é confiável: a leitura nunca estoura, o
que não bate vira rota desconhecida e é descartado, e o motivo registrado no log
não repete a consulta, que é por onde o `code` viaja. O `state` é comparado em
tempo constante e consumido antes da troca do código, para que um segundo
retorno com o mesmo `state` não valha nada.

**Onde o token de OAuth cabe.** O que vai para o cofre é o valor pronto do
cabeçalho, `Bearer <token>`, e não o token cru: a substituição de `${credential}`
troca o valor inteiro da entrada de `headers`, então não sobra lugar para montar
o prefixo depois. O par `state` mais `code_verifier` também mora no cofre, e não
em memória, porque o macOS pode ter fechado o Locum enquanto a pessoa autorizava
no navegador e a abertura do `locum://` sobe um processo novo, que não lembra de
nada.

**Preload só roda quando um documento carrega.** Conferir que o
`dist/preload.cjs` existe não prova ponte nenhuma: enquanto a janela não chama
`loadURL`, o preload nem é executado e `window.locum` não existe. Por isso o
smoke sobe uma janela com `show: false`, carrega `about:blank`, e pergunta ao
próprio renderer o que ele enxerga. Nada aparece na tela e o caminho inteiro é
exercitado, do `contextBridge` até o serviço.

**`packages: "external"` não vale para o preload.** No sandbox não existe
resolução por `node_modules`: o que não estiver dentro do arquivo não carrega. O
pacote do preload sai com tudo embutido e só `electron` como externo, que é o
único módulo que o sandbox fornece. Por isso o contrato da ponte, que os dois
lados importam, não tem import de valor vindo de `src/`: um só arrastaria o
núcleo e o `better-sqlite3` para dentro do preload.

**Erro de handler de IPC sempre vai para o log.** O Electron registra toda
rejeição de `ipcMain.handle`, e o smoke prova de propósito que decidir sobre uma
pendência inexistente é recusado. A linha de erro que aparece depois do aviso
`ponte: a proxima linha de erro e a recusa esperada da gate` é o teste passando.

**Módulo ES em `file://`.** A página construída pelo Vite sai com
`<script type="module">`, e num Chrome de mesa isso não carrega de `file://`,
porque a origem é opaca e o import bate em CORS. O Electron não aplica essa
recusa, então a janela carrega o `dist/renderer/index.html` do disco direto,
sem servidor e sem esquema próprio registrado. O que a página precisa em troca
é `base` relativa no Vite: caminho absoluto viraria a raiz do volume.

**Raiz montada não prova folha de estilo.** O smoke pergunta ao renderer se o
`#root` tem filho, o que só diz que o React rodou. A página carrega um marcador
com a classe `hidden`, e o smoke confere que ele está com `display: none`: se o
CSS construído não tivesse chegado, a raiz montaria igual e o teste passaria
sem interface nenhuma. O console de erro do renderer entra no mesmo exame,
porque módulo que falha ao carregar deixa a raiz vazia sem estourar do lado do
processo principal.

**`vite build` recebe a raiz por posição.** No Vite 8 não existe `--root` na
linha de comando: a opção é o argumento posicional, e passar a flag aborta com
`Unknown option`. O `build:renderer` chama
`vite build --config renderer/vite.config.ts renderer`.

**O `shadcn add` não roda sozinho.** Ele pergunta a biblioteca de componente
(Base UI, React Aria, Radix UI) mesmo com `--yes`, e a resposta não cabe no
`components.json`: o campo não existe no esquema. Para trazer o vendor deste
marco a escolha foi empurrada pela entrada padrão, com
`printf '\033[B\033[B\n' |` antes do comando, que é o Radix, que é o que o AI
Elements espera. E ele só roda onde existe `package.json`, por isso o
`components.json` mora em `app/` e não em `app/renderer/`, com o apelido `@/`
declarado nos dois `tsconfig.json`. O que vem do registry do AI Elements cai em
`app/src/components/ai-elements`, porque a CLI vê a pasta `src` e se guia por
ela; o lugar certo é `app/renderer/components/ai-elements`, e mover é parte do
trabalho.

**O `cn` mudou de casa.** Os componentes novos do shadcn importam de um pacote
`cn`, que é o `clsx` mais o `tailwind-merge` compilados, e não mais de
`@/lib/utils`. Os do AI Elements continuam pedindo `@/lib/utils`. Por isso
`app/renderer/lib/utils.ts` é uma reexportação de uma linha: duas
implementações de merge brigariam no mesmo elemento.

**Token do shadcn não vem do `add`.** Só o `init` escreve a folha, e o estilo v4
manda importar `shadcn/tailwind.css`, que é a própria CLI virando dependência de
build por causa de um arquivo. Em vez disso os tokens da paleta zinc foram
copiados do registry para dentro de `renderer/src/index.css`, pelo mesmo motivo
dos componentes: nada da interface pode depender de rede. O que veio de pacote
foi só o `tw-animate-css`, porque os componentes usam `animate-in` e
`slide-in-from-top-2`.

**O shiki traz todas as gramáticas.** O `codeToHtml` do pacote raiz alcança o
conjunto inteiro de linguagens, e o Vite parte isso em mais de 600 pedaços
separados, carregados sob demanda. Funciona de `file://`, e o smoke prova isso
esperando o destaque aparecer: import dinâmico do disco é justamente o que o
teste exercita. O preço é o tamanho de `dist/renderer`, que só importa quando o
empacotamento entrar.

**Destaque de código não está no HTML construído.** O shiki colore no navegador,
depois que a página montou, e ainda espera a gramática chegar. Conferir logo
depois do `loadFile` encontraria o `pre` vazio. Por isso o smoke gira até
aparecer `span` com cor dentro do bloco, e sem gramática o `pre` até existiria,
só que com o código todo da mesma cor.

**Catálogo de leitura da janela, e o que o compilador vigia.** O
`READ_CHANNELS` de `app/renderer/lib/bridge.ts` é lista escrita à mão, e a
emenda 5 do ADR 0003 é o motivo: derivar de `BRIDGE_CHANNELS` seria mais curto
e entregaria `approvals.decide` junto, mais todo canal de escrita que aparecer
depois. Revisão humana esquece disso, então existe uma guarda de tipo no mesmo
arquivo: se o canal de decisão entrar na lista, o `Extract` deixa de ser `never`
e o `npm run build` para antes de a janela enxergar o canal.

**O contrato da ponte typecheca no renderer.** O `renderer/tsconfig.json` não
tem `node` em `types`, e mesmo assim o `import type` de
`electron/bridge-contract.ts` passa: o contrato só tem tipo, e o que ele puxa de
`src/services/` chega por `import type` também. Import de valor vindo de lá
quebraria isso na hora.

**Argumento de hook entra por valor, não por referência.** O `useRead` põe
`JSON.stringify(args)` na lista de dependência do efeito. Quem chama passa
objeto literal, que muda de referência a cada render, e comparar por identidade
dispararia a leitura em laço. Os argumentos de verdade viajam numa `ref`, porque
espalhá-los na lista traria a identidade de volta.

**Comparar versão exige duas, e o banco novo tem uma.** O
`app/src/fixtures/agent-history.ts` planta a que falta, e planta a antiga, não a
nova: ele grava o passo de ação em `draft` e logo em seguida devolve o spec
canônico por cima, então o topo do histórico continua em `approve`. A ordem é o
ponto. Deixar o `draft` no topo faria uma verificação afrouxar o modo de
publicação do agent que roda nesta máquina, e o teto do que sai sem clique não é
coisa que teste mexe. A idempotência é por conteúdo, e não por identificador:
o `upsert` devolve a versão existente quando o spec bate com o topo, e a
checagem antes da gravação é o que impede o histórico de crescer duas linhas a
cada subida do smoke.

**Contar token de ferramenta sobe servidor.** Por isso `mcp.tools` entrou em
`ACTION_CHANNELS`, e não no catálogo de leitura: num hook que dispara ao montar
a tela, abrir o destino de agents subiria todo servidor MCP citado por um spec.
Atrás de um clique, sobe o que alguém pediu e só quando pediu. O smoke confere
que existe um botão por passo com ferramenta, e nunca clica.

**Prévia de modelo em lote.** O `resolvePreview` relê a tabela de substituição
da máquina a cada chamada, então uma tela que pergunta pelo spec inteiro faria
uma consulta por passo. O `resolvePreviews` lê uma vez e responde a lista, e é
ele que o canal `providers.preview` encaminha.

**A execução do smoke é plantada, não rodada.** Um `demo` de verdade custa
minutos de assinatura, e o smoke roda a cada iteração do loop. Por isso
`app/src/fixtures/demo-run.ts` escreve direto no banco uma execução pronta, com
os números da execução verificada acima, e o smoke chama `ensureDemoRun()` antes
de carregar a página. Ela é idempotente pelos identificadores fixos, então
chamar de novo não acumula linha. O que ela não faz é decidir nada: o passo de
ação nasce parado na fila, como o de verdade nasceu.

**O botão de reexecutar nunca é clicado no smoke.** Clicar solta o executor de
verdade, que gasta assinatura e leva o run junto. O que a verificação prova é a
fiação: um botão por passo, com a chave do passo escrita nele. O canal
`runs.rerunStep` chega à janela por `ACTION_CHANNELS`, uma segunda lista escrita
à mão em `renderer/lib/bridge.ts`, separada da de leitura porque quem lê dispara
sozinho ao montar a tela e quem age precisa de alguém clicando. A guarda de tipo
que mantém `approvals.decide` fora passou a cobrir as duas listas.

**Virtualização escrita à mão.** A lista de execuções tem linha de altura fixa,
então a primeira visível é uma divisão e não há o que medir: `renderer/lib/janela.ts`
resolve isso em trinta linhas, e um virtualizador de pacote só ganharia se a
altura variasse. O smoke confere as duas coisas separadas, o total que a janela
leu e quantas linhas existem de fato no DOM, porque uma lista que desenhasse
zero linha ainda mostraria o total certo no marcador.

**Detalhe de execução mora no hash, depois do destino.** `#/runs/<run-id>` (era `#/execucoes/<run-id>` até a 0.1.19, e o hash velho ainda é traduzido).
O roteador devolve o primeiro segmento como destino e o resto inteiro como
detalhe, sem quebrar de novo, e destino desconhecido descarta o resto e cai na
inbox. As telas recebem o detalhe do layout em vez de chamarem `useRota` por
conta própria: dois ouvintes de `hashchange` discordariam por um quadro na troca
de destino.

**Marcador com menos um quer dizer lendo.** O detalhe faz duas leituras pela
ponte, os passos e os achados, e a segunda termina depois. O smoke gira enquanto
qualquer um dos dois estiver em menos um, senão conferiria o estado inicial
achando que era o final.

**Banco vazio faz o smoke passar sem provar nada.** A comparação entre o que a
janela leu e o que o serviço devolve é verdadeira por acidente quando os dois
lados são zero: uma ponte que respondesse `[]` sempre passaria igual. Por isso o
banco do worktree precisa do `seed`, e por isso o marcador carrega os
identificadores dos agents, e não só a contagem.

**Roteamento por hash porque não há servidor.** A página é um arquivo no disco,
carregado por `file://`. Caminho escrito pelo History API até navegaria, mas a
primeira recarga pediria ao sistema de arquivos um `dist/renderer/agents` que
nunca existiu. O hash fica fora do caminho, então recarregar e voltar pelo
histórico caem no mesmo lugar sem nada atrás respondendo. Hash desconhecido não
deixa a janela em branco: cai no destino padrão, que é a inbox, e o smoke prova
isso porque hash velho chega de deep link e de janela restaurada.

**O smoke navega escrevendo o hash.** É o mesmo caminho do clique na barra
lateral, que também só escreve o hash e deixa o `hashchange` mandar de volta.
Por isso a barra nunca discorda da tela: existe uma fonte só, e é o endereço.
Os identificadores e os títulos que o smoke confere saem da própria barra, não
de uma cópia do lado do processo principal, que passaria a concordar consigo
mesma no dia em que o catálogo do renderer mudasse. O que fica escrito lá é só
a exigência da story, que são estes quatro destinos.

**A página lê ao montar, então o smoke precisa da ponte no ar.** O
`checkRenderer` passou a chamar `setupBridge` e `trustWindow` antes do
`loadFile`, e a esperar o marcador `ponte` sair de "carregando": conferir logo
depois do `loadFile` pegaria a tela no estado de leitura pendente. O estado vai
no próprio marcador justamente para a espera saber a hora, em vez de dormir um
tempo arbitrário.

**A tabela `budgets` não é onde o orçamento mora.** Ela existe no esquema e
ninguém escreve nela: o teto que o executor lê antes de cada passo está no
`budget` do spec do agent, e por isso mexer nele grava versão nova, pelo
`AgentService.setBudget`. Quem monta tela de orçamento tirando da tabela
mostraria vazio para sempre. O `AgentService.budgets()` cruza a versão do topo
com `usage_daily`, que é onde o gasto acumula.

**Modelo sem preço custa zero, e o teto em dólar não o alcança.** O runtime
nativo multiplica os tokens pelo preço de `model_prices`, que alguém cadastra
na linha do provedor; sem linha ali, o custo gravado é zero. Para esses
modelos o que protege é `perRunTokens` e `perDayTokens` no `budget` do spec, e
a seção de orçamentos avisa qual modelo do agent está nessa situação. A
assinatura fica fora do aviso: ela gasta cota, não token cobrado.

**Credencial se acha por quem aponta, não por nome.** A tela de configuração
poderia adivinhar que o provider `anthropic` usa a referência
`provider/anthropic`, e acertaria hoje. Quem escolhe a referência, porém, é
quem liga os dois, e nada impede dois cadastros apontarem para a mesma. Por
isso o `credentials.overview` devolve os usuários de cada referência e a tela
indexa por `kind:name`. O que ele nunca devolve é valor: o cofre só se abre no
caminho de quem vai conectar, e a janela não é esse caminho.

**O token do GitHub atravessa a ponte numa direção só.** A regra de que a
janela não abre o cofre continua de pé: nenhum canal devolve valor de segredo, e
`github.status` responde endereço, se há algo guardado, de quem é a conta e
quando foi a última conferência. O que mudou é que existe um canal de ida,
`github.save`, porque digitar o token em algum lugar é o único jeito de ele
chegar ao keychain sem abrir terminal. A prova de que a volta não existe está no
catálogo de leitura, escrito à mão, e o smoke a repete de fora: depois de
guardar, o valor não aparece no campo nem no HTML da página.

**Guardar token novo apaga a conta do anterior.** O login e os escopos descrevem
o token que estava ali, e não a referência. Mantê-los depois da troca faria a
tela afirmar, com cara de dado conferido, uma conta que o token novo pode nem
ter. Por isso `setToken` e `clearToken` limpam a conferência, e o smoke cobra
isso.

**A conferência do GitHub é exercitada sem falar com o GitHub.** O marco proíbe
credencial de verdade, e a proibição não tira nada do que a story pede: guardar,
ler do cofre, conferir e esquecer terminam dentro da máquina. O único pedaço que
sairia é a resposta do GitHub a um token, e ela entra pelo construtor do
`GithubService`, que aceita a sonda trocada. Na interface o clique de conferir só
acontece com o cofre vazio, quando a resposta é "não há token" e não sai daqui;
com token guardado o exame pula o clique, porque ele viraria uma chamada
autenticada feita por um loop que roda sem ninguém olhando.

**O único clique do smoke é testar conexão.** O botão de reexecutar passo
continua sendo só conferido por existir, porque clicar solta o executor de
verdade. Testar conexão é diferente: o alvo é o `mcp-fixture-server.ts`, que é
local, não fala com ninguém e custa o tempo de subir um `tsx`. E é o único
jeito de provar o que a story pede, que é o teste respondendo na interface, e
não o canal existindo. Por isso `mcp.test` entrou em `ACTION_CHANNELS`, ao lado
de `mcp.tools`, e pelo mesmo motivo dela: as duas sobem o servidor que vão
examinar, e numa leitura que dispara ao montar a tela isso subiria todo
cadastro de uma vez.

**O cadastro do fixture carrega caminho absoluto.** `src/fixtures/mcp-fixture.ts`
registra o servidor de brinquedo com `node` mais o caminho inteiro do `tsx` e do
fixture: o cadastro não tem campo para
diretório de trabalho, e quem sobe o processo usa o `cwd` de quem chamou, que é
`app/` para o smoke e a raiz do repositório para um cliente externo. O registro
é por nome, então subir o smoke de novo sobrescreve em vez de acumular linha.

**A família de workflow não se chama workflow no registry.** O
`npx shadcn add @ai-elements/workflow` responde 404: o que existe são os itens
soltos `canvas`, `node`, `edge`, `connection`, `controls`, `panel` e `toolbar`,
e o grafo precisa dos quatro primeiros. Todos dependem de `@xyflow/react`, que
entrou como dependência e é empacotada pelo Vite, sem nada de rede em tempo de
execução. Como nas outras vendorizações, a CLI escreve em `app/src/components`
e mover para `app/renderer/components` é parte do trabalho.

**O dado de um nó do React Flow precisa de assinatura de índice.** A restrição
é `Record<string, unknown>`, e `interface` não a satisfaz: só o alias de objeto
ganha a assinatura implícita. Declarar o dado do passo como `interface` quebra
a compilação em três lugares de uma vez, e a mensagem fala de índice ausente,
não de React Flow.

**O arranjo do grafo é conta nossa.** O React Flow desenha onde mandarem, e não
posiciona nada sozinho. A coluna de cada passo é a maior distância até um passo
sem dependência, e não a menor: com a menor, um passo que espera dois cairia à
esquerda de quem ele espera e a seta apontaria para trás. Quem faz a conta é
`renderer/lib/grafo.ts`, fora do componente.

**A aresta entra no DOM um quadro depois do nó.** O React Flow só desenha a
ligação depois de medir as caixas, então conferir logo que o nó aparece
contaria zero aresta com o grafo certo na tela. O smoke gira até as duas
contagens saírem do zero, e compara nó e aresta contra o `needs` do spec, não
contra número escrito no teste.

**A forma do grafo vem do spec, o estado vem do run.** A tabela `steps` guarda
a ordem em que o executor rodou, que é uma linearização: desenhar a partir dela
transformaria todo grafo numa fila. O `needs` só existe no spec da versão que
executou, que o `runs.get` já devolve junto.

**Nome do helper do AI SDK.** É `stepCountIs`, não `isStepCount`.

**Dois ABI do `better-sqlite3`.** O módulo compilado para o Node do sistema não
carrega no Electron, e o `electron-rebuild` sobrescreve o mesmo caminho, o que
quebraria a linha de comando. O build guarda a cópia de Electron em `app/native/`
e devolve o `node_modules` ao estado de Node; o processo principal aponta
`LOCUM_SQLITE_BINDING` antes de importar o núcleo.

**Depois de um merge que traz dependência nova**, rode `npm install` e
`npx drizzle-kit push --force` na árvore principal: o worktree do loop tem
`node_modules` e banco próprios, então nada disso vem junto.

**Tipagem das ferramentas.** Tipar o conjunto de ferramentas como
`Record<string, unknown>` faz a inferência do `stopWhen` cair para `never`. Use
`ToolSet` do pacote `ai`.

**O MCP precisa subir pelo Electron, não por `node`.** O cofre usa `safeStorage`,
cuja chave mora no keychain em nome do aplicativo: um processo `node` lê o banco
mas não decifra o token, e `run_agent` falhava com "sem token do GitHub". Por
isso o servidor sobe com `Locum --mcp`, e o `.mcp.json` do repositório saiu.

**O esquema do aplicativo vem de migração, o do desenvolvimento vem de push.**
O `drizzle-kit push` é ferramenta de desenvolvimento e não existe dentro do
`.app`: numa máquina limpa o Locum subiria sem tabela nenhuma. Por isso o
processo principal aplica `app/drizzle` na subida, antes de qualquer serviço
tocar o banco, inclusive antes do idioma, que mora em `settings`. Quem mexer no
`schema.ts` precisa rodar `npm run db:generate` junto, senão o pacote sobe com
um esquema mais velho que o código.

**A pasta de migração viaja como arquivo.** O migrator do drizzle lê os `.sql`
do disco na hora de rodar, então embutir a pasta no pacote do esbuild não
adianta. O `build:main` copia `app/drizzle` para `app/dist/drizzle`, e o
processo principal aponta para lá pelo caminho do próprio bundle.

**Banco que nasceu de `push` é adotado, não recriado.** Ele tem as tabelas e
nenhum registro de migração, e a primeira migração estouraria em `table agents
already exists`. Na primeira subida com migração, o Locum reconhece o esquema
já existente e marca as migrações da pasta como aplicadas, sem tocar em dado.

**O módulo nativo precisa sair do asar.** O asar é um arquivo só, e o Electron
remenda o `fs` para ler de dentro dele: JSON, HTML e os `.sql` da migração
saem de lá sem ninguém notar. `dlopen` não passa por esse remendo, então um
`.node` dentro do asar simplesmente não carrega. O `asarUnpack` manda `native/`
para `app.asar.unpacked`, e o processo principal troca um segmento do caminho
pelo outro antes de apontar o binding.

**O binário nativo carrega a arquitetura no nome.** O pacote sai para arm64 e
x64, e um `.node` só serve para a arquitetura em que foi compilado. Com nome
genérico, empacotar x64 numa máquina arm64 produziria um `.app` que instala e
não abre. Com a arquitetura no nome, falta a cópia e a subida estoura dizendo
qual arquivo não existe. Quem for gerar o pacote x64 precisa rodar
`node scripts/build-main.mjs --arch x64` antes.

**O electron-builder não reconstrói o `node_modules`.** O padrão dele é
recompilar as dependências nativas para o ABI do Electron, que é justamente o
que quebraria a linha de comando: ela roda por `tsx`, no Node do sistema, e
ficaria sem banco. Por isso `npmRebuild: false`, e o ABI do Electron vem da
segunda cópia que o `build:main` guarda em `native/`.

**Sem certificado da Apple, `identity` vai explícito como nulo.** Deixando o
padrão, o electron-builder procura identidade no keychain e falha o
empacotamento por não achar. Assinatura e notarização dependem de conta de
desenvolvedor, que é decisão do dono do repositório.

**A saída do empacotamento não pode ser `dist`.** É o padrão do
electron-builder e é onde o esbuild e o Vite já escrevem: sem mudar para
`release`, o pacote sobrescreveria o que está embrulhando.

**O mapa de origem fica fora do pacote.** São mais de cinco mil arquivos que só
servem a quem tem o código, e quem tem o código roda por `npm start`. Dentro do
`.app` eles dobravam o tamanho do asar sem ninguém para abrir.

**O `node_modules` também fica fora, e por isso o processo principal sai
embutido.** O padrão do electron-builder é embrulhar a árvore de produção
inteira, e quase nada dela era alcançado de dentro do `.app`: React, Radix,
Shiki e as fontes já tinham sido embutidos pelo Vite na página da janela e
viajavam de novo em código-fonte, e o Octokit sozinho passava de cem megabytes.
O `esbuild` passou a embutir em `dist/main.cjs` tudo o que o processo principal
importa, com `external` só para `electron`, que vem do runtime, e para
`better-sqlite3`, que chega ao `.node` por `require` de caminho. As duas pontas
são uma coisa só: mexer no `external` sem mexer no `!node_modules/**`, ou o
contrário, quebra a subida do pacote e passa batido no `smoke` de
desenvolvimento, que ainda enxerga o `node_modules` do repositório.

**As traduções do Chromium seguem o nome da pasta, não a etiqueta do
dicionário.** O Electron traz 220 `.lproj` e o Locum fala duas, então
`electronLanguages` corta o resto. Só que esta versão do electron-builder
compara o nome do arquivo em minúsculas: `pt-BR` não casa com `pt_BR.lproj` e
apaga a tradução que se queria manter. O estrago é silencioso porque o macOS
decide o idioma do aplicativo pelos `.lproj` que sobraram, e sem `pt_BR` o
`app.getLocale()` devolve `en` até em sistema em português, com a interface
inteira trocando de idioma.

**O `--smoke` de desenvolvimento passava e o do pacote não.** As duas coisas que
quebraram são exatamente as que só aparecem depois de empacotar. O servidor de
brinquedo era alcançado por `tsx` lendo `src/`, e nenhum dos dois entra no
`.app`: agora ele sai empacotado em `dist/mcp-fixture-server.mjs`, desempacotado
do asar porque quem o lê é um processo filho, sem o `fs` remendado do Electron.
E a conferência do i18n exigia a guarda de chave ausente sempre ligada, quando
ela segue `isPackaged` de propósito: em desenvolvimento estoura para o buraco
aparecer, e no pacote fica desligada para quem instalou não levar tela quebrada
por uma tradução faltando.

**O servidor de brinquedo sobe pelo próprio binário do Electron.** Com
`ELECTRON_RUN_AS_NODE`, e não pelo `node` do sistema: o pacote não pode supor
Node instalado na máquina de quem abre o `.app`.

**A atualização automática não serve sem assinatura da Apple.** O macOS recusa
instalar pacote não assinado vindo do updater, então ligar a verificação hoje
só gastaria rede para descobrir uma versão que nunca entra. Por isso o
interruptor nasce desligado e, desligado, o `electron-updater` sequer é
importado: um módulo carregado "só para consultar" deixa temporizador de pé, e
é assim que um verificador acaba batendo num servidor que ninguém autorizou. O
smoke prova isso contando o que sai pelo `http`, pelo `https` e pelo `net` do
Electron, porque ler o código e ver que ele decide não chamar não prova nada
sobre o que um temporizador faz três segundos depois.

**O `app-update.yml` só nasce com alvo `dmg` ou `zip`.** O electron-builder
escreve a configuração de publicação no pacote no `onAfterPack`, e no macOS ele
pula quando os alvos são só `dir`. Então `npm run dist:dir` produz um `.app` sem
feed, e o verificador ligado ali dentro responde `no-feed` em vez de armar. Vale
para o smoke do pacote: ele exercita o caminho desligado de verdade, e o caminho
ligado só até a decisão, pelo `planUpdater`, que nunca arma. Chamar o
`setupUpdater` ligado dentro de um pacote com dmg faria o smoke bater no
servidor de releases.

**Migração aditiva para o hash do contexto.** `initiatives.context_hash` e
`initiatives.context_updated_at` não existiam no esquema antes das iniciativas.
Como o banco já tinha linha, a migração `0006_rich_kate_bishop.sql` entrou
como coluna aditiva, sem default quebrando linha existente, em vez de recriar
a tabela.

**O run da decisão de contexto não pode virar execução fantasma no
orçamento.** O run criado por `proposeContextUpdate` já nasce com `startedAt`
preenchido, dentro da mesma transação. `Executor.execute()` decide se é um
run novo comparando `startedAt === null` na linha carregada no início da
função, e o agent de sistema `locum-context` não chama modelo nenhum: se a
decisão contasse como run novo, `usage_daily` ganharia uma linha e um gasto
fantasma para `SYSTEM_CONTEXT_AGENT_ID` sem custo de verdade por trás. O
critério de aceite é `usage_daily` sem linha nova depois de aprovar ou
rejeitar.

**O tipo de transação do drizzle não tem `$client`.** `ApprovalGate.enqueue()`
roda dentro da transação síncrona de `proposeContextUpdate`, então recebe
`tx`, não o `db` do módulo. O tipo `Db` em `gate.ts` era só `typeof db`, e
teve que virar `typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]`
porque `SQLiteTransaction<...>`, o tipo de `tx`, não tem `$client`, que
`BetterSQLite3Database` exige. `enqueue()` só usa `insert`, presente nos dois
tipos.

**Código de erro de step não entra no dicionário.** `"outside_initiative"`,
`"rejected"` e `"publish_conflict"` são string de backend e de log, sem tela
nem chave em `app/locales/*.json` associada. Confirmado por grep, só aparecem
em arquivo `.ts` de backend, e por `npm run check:i18n` limpo. Não repetir essa
investigação numa próxima fatia que mexa em código de erro de step.

**`linkAgent` inverte a ordem de parâmetros do texto do plano, de propósito.**
O plano descreve `linkAgent(slug, agentId | null)`; a implementação é
`linkAgent(agentId: string, slug: string | null)`, porque o ADR trata a regra
do ponto de vista do agent (um agent pertence a no máximo uma iniciativa), e
`null` desliga aquele agent especificamente, sem ambiguidade sobre qual agent
da iniciativa seria afetado. `linkAgent` recusa ligar um agent cujo spec já usa
servidor fora da iniciativa, mas não recusa quando a iniciativa perde um
servidor depois via `setServers`: `affectedAgents` só avisa, sem bloquear, e é
esse segundo caminho que testa um agent ligado terminando com um passo fora do
escopo.

**`create_initiative` no chat e `upsert_initiative` no MCP são o mesmo
método, de propósito.** Os dois nomes divergem por superfície e chamam
`InitiativeService.upsert`; nenhum dos dois foi igualado ao outro por conta
própria, porque o texto do plano usa cada nome como exemplo literal do
catálogo daquele lado.

**Leitura de contexto sem método na service, fechado só na fatia seguinte.**
Na Fatia 4, `InitiativeService` ainda não expunha leitura de `context.md` com
hash, e `read_initiative_context` (MCP e chat) abria `LocalFolderContextStore`
direto no arquivo da ferramenta. A Fatia 5a fechou o gap com `detail(slug)` e
`readContext(slug, file)` na service, e `initiative-tools.ts` passou a
delegar para eles em vez de montar a mesma junção duas vezes. `PromptService`
segue sem parâmetro `initiativeId` no `upsert`; leitura por iniciativa já
existe via `list_prompts({ initiativeId })`.

**Teste de ferramenta MCP em processo único, sem precedente no repo.**
`InMemoryTransport.createLinkedPair()` do `@modelcontextprotocol/sdk` liga
`Client` e `McpServer` sem stdio nem processo externo, e funcionou de
primeira. Vale para a próxima fatia que precisar testar ferramenta MCP.

**Chave de i18n no namespace `smoke` também entra na paridade.**
`t("smoke.renderer", ...)` interpola `{{initiatives}}`, e a chave teve que
entrar em `en.json` e `pt-BR.json` nos dois lugares, dentro de
`smoke.renderer` e como `smoke.initiatives` novo, porque `check:i18n` cobre
paridade de chave entre os dois dicionários mesmo no namespace que só aparece
no log do terminal.

**`approvals.get` devolve a pendência mesmo depois de resolvida.**
Ao contrário de `approvals.listPending()`, `approvals.get(approvalId)`
continua respondendo depois que a pendência fecha, e a tela de revisão usa
`approvals.get` para poder abrir uma pendência já fechada (aprovada,
rejeitada ou em conflito) pelo link direto. Como `ApprovalGate.decide()`
lança erro se `row.status !== "pending"`, a tela precisa calcular
`jaResolvida = pendencia.status !== "pending" || conflito` e esconder
Aprovar e Descartar nesse caso, em vez de deixar o clique estourar.

**Dois lugares com o mesmo rótulo, sem checagem cruzada.** `nav.inbox` virou
`nav.home` em `renderer/src/rotas.tsx` (rótulo da barra lateral) e em
`electron/menu.ts` (`DESTINOS`, rótulo do menu Visualizar), e os dois arquivos
não se importam um com o outro: renomear um sem o outro deixa os textos
divergentes sem erro de tipo nem de teste acusando.

**`useRead` sempre dispara, mesmo para leitura condicional.** O hook
`useRead(canal, ...args)` de `renderer/lib/bridge.ts` dispara sempre que
`canal` ou `args` mudam, sem mecanismo de pular a leitura. Um argumento
placeholder (string vazia) para condicionar `initiatives.context` a quando a
pendência é `context.update` ainda manda uma chamada de verdade ao backend,
que rejeita e loga erro no smoke sem quebrar a tela, porque o erro fica preso
no estado interno do hook. O contorno é leitura manual com `read()` dentro de
um `useEffect` guardado pela condição, com `useState<ReadState<...>>` local,
replicando o padrão já usado em `inbox.tsx` para `runs.findingsByRun`.
`useRead` continua certo para leitura incondicional, como `approvals.get` na
mesma tela.

**Checks do smoke compartilham janela e estado do React.** `checkInitiatives`,
`checkAgents` e `checkRuns` (`electron/main.ts`) rodam em sequência na mesma
janela, então qualquer estado em memória sobrevive de um check para o outro.
`checkInitiatives` termina navegando para `#/initiatives/example/agents`, e
isso deixa a iniciativa "atual" (guardada pelo `CurrentInitiativeProvider`)
marcada como `example` quando `checkAgents` e `checkRuns` rodam depois, mesmo
essas telas não sendo de iniciativa nenhuma. Uma tela que passasse a filtrar
por essa iniciativa atual por padrão quebraria as asserções desses dois checks,
que comparam a lista inteira (sem filtro) contra o que o serviço devolve. Os
chips de iniciativa em `agents.tsx` e `execucoes.tsx` nascem com o filtro
desligado por causa disso: o chip aparece sempre que há iniciativa atual, mas
só filtra depois de um clique.

**`setWorkspaces`/`setServers` substituem a lista inteira.** Nenhum dos dois
canais de `initiatives-service.ts` anexa um item; ambos recebem a lista
completa e a gravam por cima da anterior. Uma tela de "adicionar" precisa
mandar a lista atual mais o item novo, nunca só o item novo.

**`sessions.workspace_id` e o `setWorkspaces`.** A coluna aponta para
`initiative_workspaces`, e o `setWorkspaces` apaga e recria os workspaces com
id novo a cada gravação. Com `foreign_keys = ON`, uma sessão que guardasse o
workspace travaria a edição dos workspaces depois da primeira sessão. Contorno:
a sessão grava `null`; o `cwd` usado fica no script.

**O `check:i18n` não olha `src/`.** Texto gerado no núcleo, como o
`session.md`, escapa da guarda de literal solto. Contorno: o teste do
`SessionService` confere cada linha do arquivo contra as linhas de
`session.prompt.*` do idioma certo e recusa linha do outro idioma.

**App aberto pelo Finder não herda o PATH do terminal.** `claude` puro falha
justo para quem instalou pelo `.zshrc`. Contorno: `resolveClaudeBinary` tenta
`LOCUM_CLAUDE_BIN`, depois `zsh -ilc 'command -v claude'` com 3 s de limite e
stdin fechado, e só aceita a última linha não vazia se for caminho absoluto
executável (alias e função caem fora); depois a lista fixa dos instaladores.
Isso cobria só a sessão no Terminal: o runtime `claude -p`, o `codex` e o `npx`
dos servidores MCP stdio chamavam o nome solto e falhavam do mesmo jeito. Desde
a 0.1.21 a subida lê o PATH do `zsh -ilc` uma vez (`runtimes/login-path.ts`),
junta as pastas que faltam depois das do sistema e esquece a disponibilidade
dos binários de assinatura conferida com o PATH curto.

**Skill de plugin instalado não era achada.** A descoberta parava quatro
níveis abaixo de `~/.claude/plugins`, e o cache guarda a skill em
`cache/<marketplace>/<plugin>/<versão>/skills/<nome>`, mais fundo. Entrava o
fonte de marketplace, que nem está instalado, e ficava de fora o plugin
instalado. Contorno, desde a 0.1.21: a raiz de plugin vem do `installPath` de
`installed_plugins.json`, com a varredura da pasta inteira só quando o arquivo
falta. No mesmo lugar, o glob `**/*.tsx` só casava um nível de pasta, porque a
troca do `*` reescrevia o `.*` gerado pelo `**/`.

**`claude -p` isolado não abre skill pelo nome.** Com `--setting-sources ""` e
só as ferramentas MCP liberadas, o passo não enxerga plugin nem a ferramenta de
skill, então mandar só nome e descrição deixava a regra de skill sem efeito.
Contorno: o executor manda o corpo no prompt de sistema para todo runtime.

**Aprovar duas vezes publicava duas vezes.** A gate lia `pending`, publicava
e só depois fechava, então a tela de revisão e a inbox, ou a janela e o
`locum approve`, publicavam em dobro no nome de quem aprovou. Contorno, desde
a 0.1.23: a pendência é tomada numa escrita condicional (`pending` para
`publishing`) antes do handler. Falha antes de sair volta para `pending`;
queda no meio deixa `publishing` e faz a retomada pausar. Desde a 0.1.24, a
pendência parada há mais de cinco minutos aparece no topo da inbox (e no
`locum inbox`) com dois botões: "Saiu" fecha como aprovada e o run segue,
"Não saiu" devolve para a fila. Quem confere o destino é a pessoa; a tela só
registra. A review do GitHub também procura a marca `locum:<externalId>` nas
reviews do pull request antes de criar, então o passo `auto` reexecutado não
assina uma segunda. Slack e Teams não têm essa busca: os dois só saem em
`approve`, e a falha volta a pendência para a fila.

**Run interrompido ficava parado até alguém clicar.** A retomada existia no
`locum`, mas o app empacotado não a chamava ao abrir, então o run que estava
`running` quando o Mac desligou só voltava por reexecução à mão. Contorno,
desde a 0.1.25: o app lê os runs `queued` e `running` antes de o relógio bater
e retoma em segundo plano. Na mesma leva, três buracos da retomada: queda entre
gravar a pendência e marcar o passo abria uma segunda pendência; a conferência
do passo parado podia ler uma aprovação vencida e dar o passo por publicado; e
reexecutar o passo enquanto a aprovação dele estava saindo abria corrida com a
publicação. Os dois primeiros agora leem a pendência viva mais nova do passo, e
o terceiro é recusado com mensagem. O passo de modelo nativo ganhou teto de 15
minutos, para uma resposta que nunca chega não prender o run.

**Segundo gatilho na mesma fonte nunca disparava.** A varredura do GitHub e a
por MCP devolviam só o evento que tinham acabado de gravar, e o cursor é da
consulta, não do gatilho. Dois gatilhos sobre a mesma organização (revisão e
resumo, por exemplo) dividiam o cursor, e o segundo a bater achava tudo
conhecido. O evento gravado numa batida que morreu antes de criar o run também
ficava para trás. Contorno, desde a 0.1.25: as duas devolvem a janela inteira e
o agendador deduplica pelo run do próprio gatilho. Na 0.1.26 o mesmo vale para
canal do Slack e caixas do Slack e do Teams. Ainda aberto: o cursor da fonte é
gravado antes de o agendador criar os runs, então queda exatamente entre as
duas coisas deixa o evento gravado e fora da próxima janela.

**Duas batidas no mesmo banco disparavam em dobro.** O app serializa as
próprias batidas, mas `locum tick` no terminal bate no mesmo SQLite. Contorno,
desde a 0.1.26: a batida toma o gatilho numa escrita condicional ao cursor que
leu, antes de disparar. Efeito colateral: queda no meio do disparo de um
gatilho de relógio pula aquela janela, em vez de repetir.

**Refresh de OAuth em paralelo derrubava a conexão.** Vários runs pedindo o
token vencido mandavam o mesmo refresh token. Contorno, desde a 0.1.26: uma
troca por servidor de cada vez. O retorno no loopback também passou a ignorar
pedido com state de outra tentativa, em vez de falhar com ele.

**Teto diário virava às 21h.** O dia do gasto era UTC. Desde a 0.1.26 é o dia
local do Mac. No dia da atualização, o gasto já gravado sob a data UTC pode
contar no dia errado uma vez.

**Evento sem run segurava a janela.** Um `startForEvent` que falhava parava o
laço, e o resto da janela ficava sem run com o cursor da fonte já andado.
Desde a 0.1.27 cada evento tenta o seu, e a batida sai `failed` contando
quantos ficaram sem run. O evento que falhou ainda não volta na próxima
varredura das fontes por cursor.

**Saída do modelo trocava o destino da ação.** O payload era o evento coberto
pela saída, e um diff que pedisse `owner` e `repo` de outro projeto mudava onde
a ação publicava. Desde a 0.1.27 `owner`, `repo`, `pull` e `headSha` do evento
vencem a saída. Run sem evento, como o de relógio, continua com o destino da
saída.

**Segredo seguia o nome, e não o destino.** Atualizar um servidor pela
ferramenta MCP trocando só o comando herdava o `env` antigo, token incluído.
Desde a 0.1.27 comando ou endereço novo não herda `env` nem `headers`.

**Credencial do MCP aparecia no `ps`.** O `claude -p` recebia a configuração
dos servidores, já com o token, no valor de `--mcp-config`. Desde a 0.1.27 vai
num arquivo 0600 numa pasta temporária, apagada no fim. No Codex, desde a
0.1.31, o valor vai no ambiente do processo e o `-c` leva só o nome
(`env_vars` e `env_http_headers`). Essas variáveis saem do shell do modelo por
`shell_environment_policy.exclude`. PATH, HOME, CODEX_* e afins seguem no `-c`
do servidor, para não trocar o ambiente do Codex inteiro. Dois servidores do
mesmo passo com a mesma variável em valores diferentes são recusados. Formato
conferido na documentação do Codex, ainda sem rodar o `codex` de verdade.

**Teto de gasto afrouxado pelo MCP.** `set_budget` gravava como pessoa, e
`null` tirava o teto de um agent já ligado a gatilho. Desde a 0.1.27 quem não é
pessoa só baixa ou cria teto; subir e tirar é na tela.

**Servidor MCP cadastrado pelo MCP rodava na hora.** O comando de um servidor
stdio roda com os poderes do app, e `register_mcp_server` gravava já ligado.
Desde a 0.1.28 servidor novo, ou com outro comando ou endereço, nasce
desligado, `enabled: true` é recusado, e `test_mcp_server` e
`list_server_tools` não sobem servidor desligado. A pessoa liga na tela de
Configuração, que mostra o comando no botão, ou com `locum mcp:enable`.

**Escopo da iniciativa alargado pelo MCP.** Agent fora de iniciativa enxerga
todos os servidores, então desligar o agent da iniciativa, ou trocar de
iniciativa, dá a ele ferramenta nova. Desde a 0.1.28 o servidor MCP e o chat do
app só ligam agent solto e só tiram servidor de iniciativa com agent ligado;
incluir servidor nela, desligar e trocar é na tela.

**Classe da ferramenta declarada por quem grava.** Só `external_write` era
barrada em passo, e pelo MCP dava para pôr como `read` a ferramenta que comenta
num PR. Desde a 0.1.28 quem não é pessoa não inclui em passo ferramenta de
servidor com escopo `write` que a versão anterior não usava, e não baixa o
escopo de um servidor de `write` para `read`. Por isso cadastrar como `write`
todo servidor que tem alguma ferramenta de escrita. O rascunho do "Criar com
IA" fica de fora da trava, porque a pessoa vê as ferramentas antes de gravar.

**Autorização de ação sobrevivia à troca do prompt.** O `auto` que a pessoa
deu a um passo de ação passava por qualquer edição pelo MCP que mantivesse a
ação, o destino e a entrada, e aí um prompt novo publicava sem clique. Desde a
0.1.29 a cadeia acima da ação também precisa ser a mesma: os passos de que ela
depende, direta ou indiretamente, com prompt, modelo e ferramentas iguais,
contando `defaultTools`. Mexer no nome, no teto ou em passo fora da cadeia
mantém o modo.

**Evento que não abria run sumia.** O cursor da fonte anda antes do run abrir,
e o evento que batia no teto do dia não voltava em varredura nenhuma. Desde a
0.1.30 o agendador anota por gatilho o evento que falhou e tenta de novo a
cada batida, por até 24 horas.

**Release levava junto o que mudou durante ele.** O commit da versão era
`git commit -am`, e mudança feita na árvore enquanto o pacote era montado
entrou no `chore: versão 0.1.29` sem ter sido empacotada. Desde a 0.1.30 o
commit leva só `package.json` e `package-lock.json`, e árvore que mudou no
meio do caminho para o release antes de publicar.

**Link de pull request abria o GitHub dentro do app.** O `target="_blank"`
criava outra janela do Electron. Contorno, desde a 0.1.25: a janela recusa
abrir janela nova e navegar para fora, e entrega `http` e `https` ao navegador.

**Teto diário furado por runs juntos.** O gasto ia para `usage_daily` só no
fim do trecho, e o gatilho de poll abre um run por evento ao mesmo tempo.
Contorno, desde a 0.1.23: cada passo cobrado grava no dia assim que termina.
Runs simultâneos ainda podem passar um passo cada além do teto.

**Deep link só chega com o app empacotado.** Em `npm start` o esquema
`locum://` não está registrado para o binário de desenvolvimento, e o `open`
do fim do script não volta. Contorno: "Ler passagem" funciona com a sessão
ainda `open`; o deep link só adianta o estado para `ended`.

**Uma passagem por sessão, não por dia.** O plano dizia
`handoffs/<data>.md`, e duas sessões no mesmo dia escreveriam no mesmo
arquivo. Contorno: `handoffs/<data>-<8 primeiros do id>.md`, gravado em
`sessions.handoff_path` na abertura, para "Ler passagem" achar a certa.

**Smoke e teste nunca abrem terminal.** O clique em "Abrir sessão" chamaria
`open -a Terminal` de verdade. Contorno: `SessionService` recebe `exec` por
dependência; teste e smoke passam espião, e o smoke confere os botões por
existir sem clicar. Os testes de injeção usam `touch PWNED` como sentinela,
nunca `rm`, e rodam o script só até a linha do `claude` (com `/bin/echo`), sem
a do `open`.

## Próximos passos

Iniciativas: I1, I2 e I3 prontos no código. Falta o teste à mão da sessão
(seção do topo) e, fora do caminho crítico, O1, O2 e a fatia 9 (I4). O resto
desta seção é o histórico das tarefas do loop Ralph.

Quebrados em tarefas atômicas em `scripts/ralph/prd.json`, na ordem revisada pelo
ADR 0002: camada de serviço, servidor MCP próprio, casca Electron, interface,
empacotamento. O cadastro de MCP já vem do banco, e o passo de contexto de
deploy passa a depender só de cadastrar o servidor certo.

O agendador não tem relógio próprio. Ele é batido de fora, hoje pelo comando
`tick`, e devolve em `nextDueAt` quando quer a próxima batida, para quem chama
armar um temporizador só. O `schedule()` responde o mesmo por gatilho, com a
última batida ao lado do cadastro, que é o que a tela de configuração mostra. O
relógio entra por parâmetro nos dois: gatilho que nunca disparou está vencido
agora, e duas chamadas com dois `Date.now()` responderiam números diferentes
para a mesma pergunta. Cada gatilho tem seu cursor de tempo na tabela
`cursors`, então sono da máquina não perde janela: a primeira batida depois de
acordar já encontra o gatilho vencido. Quem chama `onWake()` é o processo
principal do Electron, em `app/electron/power.ts`, no `resume` do
`powerMonitor`, e o tempo que a máquina passou dormindo vai para o log.

O tracker de tarefa tem cadastro, credencial e teste de conexão, e não tem
botão de abrir tarefa. Não é falta: pela decisão do marco, abrir tarefa nunca é
automático, então o `createIssue` do serviço só é alcançável pelo passo de ação,
que nasce em modo de aprovação e para na fila. A ponte não expõe canal que crie
tarefa, e duas guardas sustentam isso: uma de tipo no contrato, que para o
build, e uma no `--smoke`, que varre a lista de canais registrados.

O passo é `tracker.create_issue`, e ele aponta para o tracker pelo `target` do
próprio passo, não pela saída do modelo: destino é configuração de quem escreveu
o agent, e um modelo que escolhesse o projeto abriria tarefa no quadro de outro
time. O modo é travado no handler, em `modes`, e não no spec. A diferença
importa: o rebaixamento do `agent_versions` já impede um agent de gravar `auto`,
e `modes` impede também a pessoa que edita a spec à mão, porque o que sai
assinado por alguém não pode depender de a linha certa estar escrita lá.

O corpo da tarefa vem do passo de modelo anterior, em `objective`, `changes` e
`testing`, e o passo de ação só monta título, seções e links em volta. É o que
faz o texto ser legível antes de sair: prosa gerada dentro da publicação só
apareceria depois de publicada. Os dois passos saem prontos em
`app/src/seed/tracker-issue.ts`, como fragmento para concatenar num agent, e não
como agent semente: o `pr-review` não tem tracker para apontar.

O Jira tem dois caminhos. O `jira` fala REST com e-mail e API token, e o
`jira-atlassian` passa pelo servidor MCP oficial da Atlassian, com a autorização
que a vitrine já fez. O segundo não guarda credencial própria: o cadastro só tem
o site, `setSecret` recusa, e remover o tracker não apaga `mcp/atlassian`,
porque essa autorização serve a outras coisas além dele. O site vai como
`cloudId`, que as ferramentas aceitam no lugar do UUID. O tipo da tarefa sai dos
tipos do projeto, porque num site em português ele se chama `Tarefa` e um `Task`
fixo seria recusado. O teste de conexão desse tipo não roda no smoke: com a
Atlassian conectada na máquina de quem desenvolve, ele sairia para o site de
verdade. Quem cobre a conversa com o servidor é `test/jira-atlassian.test.ts`,
com um servidor de mentira injetado no serviço.

## Slack pelo servidor oficial

O `https://mcp.slack.com/mcp` pede OAuth mas não tem registro automático de
cliente, e só atende app interno ou publicado no diretório. Usar o client id de
outro produto seria se passar por ele. O caminho é cada workspace criar o seu
app a partir do manifesto em `app/src/services/slack-app.ts`, e o Locum guardar
só o client id, em `settings` (`slack:clientId`), porque app público com PKCE não
tem segredo.

`McpOAuthService.connect` aceita um cliente cadastrado à mão: pula o registro e
volta por um endereço fixo, porque o Slack confere o retorno contra o que está
no app. Sendo `localhost`, o retorno escuta em `127.0.0.1` e em `::1`. O
servidor de autorização do Slack anuncia só `client_secret_post`, e o SDK cai
para `none` quando o cliente não tem segredo, que é o que se quer.

O que a pessoa faz no Slack, e o Locum não consegue fazer por ela: criar o app
(o botão abre `api.slack.com/apps?new_app=1&manifest_json=...`, e há o manifesto
para copiar se a tela vier vazia), ligar o MCP em Agents & AI Apps e instalar o
app como interno. Ligar PKCE no app não tem volta.

Falta ver com o Slack de verdade o formato do que `slack_read_channel` devolve.
A fonte do Slack procura `messages` com `ts` em cada item; se o servidor oficial
devolver texto formatado em vez de lista, a varredura não acha mensagem e
`slackMessages` precisa aprender esse formato.

### Menções e mensagens diretas

O gatilho `slack-inbox` acorda um agent quando alguém menciona a pessoa ou
manda mensagem direta. Não dá para receber evento do Slack sem um endereço
público (Socket Mode não entra no diretório e reparte os eventos entre
conexões), então ele varre, a cada 5 minutos por padrão.

A varredura (`app/src/sources/slack-inbox.ts`) fala com a API Web do Slack e não
com o servidor MCP, porque a busca do servidor oficial devolve markdown, sem
canal nem carimbo separados. Usa o mesmo token de usuário que a conexão oficial
guardou (`McpOAuthService.accessToken`, que renova antes) e o método
`assistant.search.context`, que com token de usuário não pede `action_token`.
São duas perguntas, cada uma com o próprio cursor: `<@eu>` em qualquer tipo de
conversa, e `to:<@eu>` em `im` e `mpim`. A pessoa é descoberta por `auth.test`.
O que ela mesma escreveu e o que veio de bot ficam de fora. A chave externa é a
mesma da fonte de canal, então a menção num canal observado não acorda o agent
duas vezes. A busca não devolve `thread_ts`, e o vínculo da thread sai do
permalink. O primeiro cursor é um dia atrás, para que ligar o gatilho não acorde
o agent para a história inteira da conta.

O manifesto ganhou os escopos `search:read.im`, `search:read.mpim`,
`search:read.files` e `search:read.users`. Quem já tinha o app precisa
reinstalar para eles valerem.

Verificado contra uma API de mentira. Falta ver com o Slack de verdade três
coisas: se o token emitido para o servidor MCP vale na API Web, se o filtro
`to:` separa mensagem direta como na barra de busca, e se o `after` vale pelo
segundo ou pelo dia (a varredura segue até quatro páginas por pergunta para que
um dia cheio não trave o cursor, e a chave externa descarta o repetido).

### Teams

Não existe servidor MCP do Teams que atenda app de desktop, então o Locum fala
direto com o Microsoft Graph, com a identidade de quem conectou. Cada
organização registra o próprio app no Entra (`app/src/services/teams-app.ts`
traz o comando da CLI do Azure), de um tenant só e como cliente público com
PKCE. Assim quem decide o que o Locum lê é o administrador do tenant, e o
projeto não depende de verificação de publicador para funcionar em qualquer
empresa. Tenant e client id ficam em `settings` (`teams:tenantId` e
`teams:clientId`); o token vai para o cofre por `McpOAuthService.connectDirect`,
que autoriza sem servidor MCP, sem o parâmetro `resource` e sem
`prompt=consent`. Para a empresa que desliga o consentimento do próprio
usuário, o painel abre o consentimento do administrador do tenant e espera a
volta pelo mesmo retorno.

A varredura (`app/src/sources/teams-inbox.ts`) lê `/me/chats` ordenado pela
última mensagem e para na primeira conversa mais velha que o cursor; em cada
conversa nova, pede as mensagens alteradas desde o cursor e descarta as criadas
antes dele, para que editar uma mensagem antiga não acorde o agent. Menção vale
em qualquer tipo de conversa, inclusive chat de reunião; mensagem direta vale
em `oneOnOne` e `group`. O que a própria pessoa escreveu, aviso de sistema,
mensagem apagada e mensagem de app ficam de fora. O cursor é ISO normalizado em
milissegundos, porque o Graph devolve frações de tamanhos diferentes e o cursor
compara como texto. O teto é de quatro páginas de 50 conversas; o que passar
disso numa batida se perde, de propósito, para um dia cheio não travar a
varredura.

Canal de equipe ficou de fora. Ler canal pede `ChannelMessage.Read.All`, que só
o administrador libera, e pedir escopo que nada usa ainda seria pedir acesso a
mais.

Verificado contra um Graph de mentira. Falta ver com o Teams de verdade se o
`$orderby` de `/me/chats` pela última mensagem vale em todos os tenants e se o
`$filter` por `lastModifiedDateTime` nas mensagens do chat responde sem pedir
permissão de aplicativo.

Para exercitar cliente MCP sem depender de nada instalado na máquina, existe
`app/src/fixtures/mcp-fixture-server.ts`, um servidor stdio de brinquedo com as
ferramentas `echo`, `sum`, `slow`, `fail` e `feed`. O `feed` devolve itens
carimbados a partir de uma data fixa, e não do relógio, porque a varredura por
cursor só pode ser verificada se as duas passadas virem os mesmos itens.

## A terceira forma de fonte

`app/src/sources/mcp-poll.ts` é a fonte que pergunta a um servidor MCP
cadastrado, a terceira das três previstas no ADR 0001. Existe para ambiente onde
não dá para registrar aplicativo, que é o caso de Slack e Teams corporativos:
não há webhook para receber nem SDK para chamar, mas há um servidor MCP que
alguém já autorizou.

O cadastro é o gatilho `mcp-poll`, com servidor, ferramenta e argumentos. A
janela entra pelos argumentos, e não por um campo próprio, porque cada servidor
chama a janela pelo nome que quer: `since`, `oldest`, `updated_after`. Onde
aparecer `{{cursor}}` em qualquer texto do argumento, em qualquer profundidade,
a varredura troca pelo cursor antes de chamar.

O que volta é desembrulhado do envelope do MCP e vira lista: array no topo, ou
array em `items`. Tudo mais é um item só. A chave de deduplicação é o `id` do
item quando ele tem um, e o resumo do conteúdo quando não tem. O cursor anda
para o maior `at` gravado, e só depois de gravar; quando nenhum item vem
carimbado, ele anda para o instante lido antes da chamada, que é a marca d'água
segura. Resposta com `isError` vira exceção, senão a mensagem de erro viraria
evento e o cursor passaria por cima de uma janela que ninguém leu.

## O digest

`app/src/digest/ingest.ts` junta o que a fonte do Slack gravou desde a última
entrega, agrupa por canal e por thread, e corta o que não vale mandar para o
modelo: mensagem sem texto e marcador de canal, que o Slack manda como mensagem
e ninguém lê. Tudo determinístico, e de propósito: agrupar é comparação de
carimbo, e pagar um modelo para isso seria mandar o canal inteiro para ele antes
de saber se há o que resumir. Há teto de leitura, de threads por canal, de
mensagens por thread e de tamanho de cada mensagem.

O cursor da entrega é por servidor de Slack e anda quando o evento do digest é
gravado, nunca quando alguém clica. A ordem é a mesma das outras fontes, e pela
mesma razão: se o processo morrer no meio, o evento existe e o run é retomado na
próxima subida. Andar só depois do clique faria uma pendência esquecida na fila
segurar toda a conversa seguinte fora do próximo digest.

O agent semente é `slack-digest`, com dois passos. Um de modelo, que classifica
cada assunto em `needs_reply`, `info` ou `ignore` e escreve o resumo, sem
nenhuma ferramenta: o que ele lê já chegou agrupado no evento. E um de ação,
`digest.deliver`, que monta a proposta e para na fila.

Esse é o primeiro passo de ação que passa pela fila sem ter lado de fora. Um
digest não publica nada: o clique quer dizer "li", e o `publish` do handler não
chama ninguém. Mesmo assim o caminho é a gate, porque é ela que grava a
proposta, mostra a pendência na inbox e registra quando ela foi resolvida, e um
digest que aparecesse por fora disso seria uma segunda inbox com regra própria.
O handler recusa `auto` e `draft`, por código: digest entregue sozinho sai da
fila sem ninguém ter lido, que é o contrário do que ele existe para fazer.

## A resposta no Slack

`app/src/slack/action.ts` é o handler de `slack.post`. Ele responde em thread
pelo mesmo servidor MCP que lê o canal, e não tem token próprio. Nasce e
permanece em `approve`: mensagem em canal aparece assinada por uma pessoa, e
quem lê não tem como saber que quem escreveu foi um agent. O modo automático
fica fora enquanto não houver medição que o sustente, e a recusa é de código, em
`modes`, não configuração de spec. Não há `draft`, porque rascunho de mensagem
de thread não existe no Slack e emular um publicando e apagando deixaria a
notificação na tela de todo mundo.

O texto vem do passo de modelo, e o handler só entrega. Quem diz o destino é o
evento e o cadastro: o canal sai do `repo` que a fonte grava (`slack/<canal>`),
o servidor sai do `target` do passo ou do Slack cadastrado na máquina, e a
thread, que passa pelo modelo, é conferida em `app/src/slack/thread.ts` contra
as mensagens que o Locum leu daquele canal. Carimbo inventado não acha thread
nenhuma e o passo falha antes de virar pendência.

A proposta é montada em `propose`, antes de a pendência ser gravada, então o que
a fila mostra é exatamente o texto que sairia, junto da mensagem que abriu a
thread e do endereço dela. O agent semente é `slack-reply`, com um passo de
modelo e um de ação.

Os nomes da ferramenta e dos argumentos da resposta ficam no cadastro do Slack,
separados dos da leitura: a ferramenta que lista histórico costuma chamar o
canal de `channel_id` e a que publica chama de `channel`. Cadastrar não publica
nada; só diz por onde a resposta sairia depois do clique.

Registrar a ação custou duas linhas em `app/src/executor/build.ts`, que é onde a
gate é montada. É a única mudança de núcleo do M8, e é de propósito: a gate só
vale como porta única se ela for sempre a mesma porta, e um mapa de handlers
montado em cada chamador deixaria um deles registrar handler diferente sem
ninguém notar. Fonte nova não encosta no núcleo; ação nova entra por essa linha.

**Claude Code com a configuração da máquina.** Sem isolamento, cada passo de
modelo subia com a configuração pessoal inteira: na mensagem de início, 27
servidores MCP, 13 plugins, 331 ferramentas e cinco hooks de sessão, incluindo
servidores de produção ao alcance de um agent que lê diff de terceiro. O
adaptador passa `--setting-sources ""`, `--strict-mcp-config` e
`--no-session-persistence`, e a mesma chamada cai para zero servidor, dois
plugins embutidos, 30 ferramentas e nenhum hook. O login de assinatura
sobrevive, ao contrário do `--bare`. A subida de um `-p` mínimo caiu de 6,9 s
para 3,3 s, e deixaram de entrar 16 mil tokens de esquema no cache a cada
processo.

O ganho na triagem inteira é menor do que a auditoria previa. Os 62 segundos
citados lá vêm da execução plantada pelo `fixture:run`, que não chama modelo. No
demo real a triagem leva uns 40 segundos com ou sem isolamento, porque quem
domina é a geração: 38 s para 2237 tokens de saída antes, 42 s para 3948
depois. O que o isolamento tira são os cerca de 3,5 s de subida por passo.

## O desenho cobrado

`docs/teste-do-desenho.md` fecha o M8 cobrando do ADR 0001 a promessa de que
fonte nova e ação nova entram como periferia. A conta está lá com commit e
arquivo: em 1928 linhas inseridas em `app/src`, a fila de aprovação, o executor,
o formato de agent e o esquema do banco ficaram com zero linha alterada, e o
núcleo mudou quatro linhas, as duas de cada ação em `executor/build.ts`.

A ressalva que o documento registra não é essa. É o desvio do Slack dentro do
ramo `mcp-poll` do agendador, em `app/src/triggers/scheduler.ts:381`, que hoje é
caso único e legível. Na segunda fonte que precisar do mesmo desvio, ele deixa
de ser, e o lugar de resolver isso é uma tabela de fontes registradas, antes de
escrever o segundo `if`.
