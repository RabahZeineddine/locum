# ADR 0004: iniciativas como unidade de trabalho

Data: 27/09/2026
Status: aceito
Complementa: ADR 0002 e ADR 0003

## Contexto

Hoje o Locum organiza o trabalho por agent: cada agent tem versões, gatilhos, execuções e aprovações, e todo servidor MCP habilitado fica disponível para qualquer agent que declare a ferramenta. O `docs/briefing-iniciativas.md` pede uma unidade acima disso, a iniciativa: uma frente com objetivo, critério de pronto, prazo, contexto em texto, workspaces (repos, worktrees, branch), integrações MCP, agents, prompts e links. O aceite do I1 no briefing é o chat interno criar e configurar uma iniciativa completa.

O projeto também vai ser aberto para a comunidade, em inglês e português. O código já tem os dois dicionários (`app/locales/en.json`, `app/locales/pt-BR.json`, guardados por `npm run check:i18n`), mas nomes de arquivo, rota e ferramenta ainda misturam os dois idiomas.

As perguntas que este ADR responde: o que um agent de iniciativa enxerga; onde mora o contexto; como prompts são guardados; como o contexto muda sem furar a fila de aprovação; o que o chat pode fazer; como a sessão no terminal recebe a iniciativa; e em que idioma vão nome e texto.

## Drivers

1. Isolamento entre frentes: o que um agent enxerga cabe numa linha.
2. Revisão humana antes de qualquer escrita que a pessoa assina, e o contexto da iniciativa conta como escrita dela.
3. Reaproveitar fila, versões imutáveis, executor e servidor MCP, em vez de criar caminho paralelo.

## Decisões

### 1. Escopo MCP: um agent pertence a no máximo uma iniciativa

- `agents.initiative_id` nulo quer dizer agent global, com o comportamento de hoje.
- A fonte do escopo na execução é `runs.initiative_id`, gravada no `createRun` e nunca reescrita. A retomada lê essa fotografia, não o agent atual. A lista de servidores da frente é lida a cada `execute`, então tirar um servidor vale na próxima execução ou retomada.
- A checagem roda antes do `missing()` no executor. Ferramenta ou `requiresServers` de servidor fora da frente conta como ausente: passo opcional é pulado com o motivo, obrigatório falha com o motivo.
- Limites registrados:
  - O escopo não cobre passo de ação (`slack.post`, `tracker.create_issue` e afins). Esses já passam pela fila de aprovação.
  - A classe de ferramenta (`read`, `internal_write`, `external_write`) é autodeclarada na config do servidor (`app/src/config/types.ts:13`). Quem registra o servidor pode declarar errado. A classe passa a vir do servidor ou do preset no I4.

### 2. Contexto em pasta local, atrás de `ContextStore`

- Pasta `<root>/<slug>/`, com `root` em `LOCUM_INITIATIVES_DIR`, senão na configuração `initiatives.root`, senão em `~/Locum/initiatives`.
- Dentro: `context.md` (da pessoa), `handoffs/<date>.md` (passagens de sessão) e `.locum/` (artefatos derivados que o Locum regera).
- O Locum cria `context.md` só quando não existe e nunca reescreve fora da fila.
- `LocalFolderContextStore` grava de forma atômica e recusa caminho que sai da pasta. A interface deixa outro adaptador (Confluence, Notion) para depois.

### 3. Prompt reutilizável é entidade própria, versionada

`prompts` e `prompt_versions`, com versão nova só quando o corpo muda, e iniciativa opcional. Não é agent sem gatilho, que carregaria passo, modelo e custo e poluiria a lista.

### 4. O contexto muda só por proposta aprovada

- `InitiativeService.proposeContextUpdate` valida o payload pela gate e então grava, numa transação só, o run (com `initiative_id` explícito e status `paused`), o passo `propose` já `awaiting_approval` e a pendência `context.update`. Ou as três linhas existem, ou nenhuma: não há run sem pendência nem pendência sem passo. Não há evento nem execução de agent. O run nasce com o início gravado, para a decisão não o contar como execução nova no uso diário.
- O run pertence ao agent de sistema `locum-context`, versão `locum-context@1`, semeado pelo `migrateDb` de forma síncrona e idempotente (`INSERT OR IGNORE` numa transação), porque Electron, CLI e servidor MCP migram o mesmo banco. O sistema é reconhecido pelo id da versão. Agent de usuário com o mesmo id não é sobrescrito nem ganha a versão, e a proposta falha com mensagem clara.
- O agent reservado fica fora de tudo que trata agent de quem usa: lista, visão geral, orçamentos, duplicar, exportar, métricas, contagem do health e reconciliação. Editar, orçar, importar, pôr gatilho, disparar e reexecutar passo recusam o id, no serviço, então MCP, ponte e CLI herdam a recusa.
- A decisão devolve o estado final da pendência (`approved`, `rejected` ou `conflict`) e o do run (`done`, `paused` ou `failed`), na ponte e na CLI, em vez de ecoar o que foi pedido. Quem aprovou e caiu em conflito vê que nada foi publicado.
- Dois modos:
  - `append` anexa ao texto atual, sem hash esperado, com um marcador por pendência que torna a publicação idempotente.
  - `replace` exige o hash lido. A revisão mostra o diff contra o arquivo atual e avisa quando o arquivo mudou desde a proposta.
- `publish` repetido não duplica nem falha, para a retomada depois de um crash.
- Conflito nunca prende pendência: o handler lança `PublishConflict`, a gate fecha a pendência como `conflict` e o passo vira `skipped` com o motivo. Outro erro de publicação mantém a pendência aberta e rejeitável, como hoje.
- Alternativas comparadas:
  - Evento com agent de sistema executado: o payload não chega ao passo de ação (`executor.ts:327`, `executor.ts:366`).
  - `runs.agent_version_id` nulo: recria a tabela `runs` no SQLite e troca todo join com agents.
  - Tabela própria de propostas: segunda fila e segundo caminho de escrita.
  - O agent reservado é o menor custo: uma linha escondida, com teste da ocultação.

### 5. O chat ganha as escritas internas de iniciativa

- O catálogo escrito à mão do chat recebe as ferramentas de leitura e as `internal_write` de iniciativa e prompt, incluindo `propose_context_update`.
- Justificativa diante da emenda 5 do ADR 0003: ela proíbe catálogo derivado dos canais da ponte e `approvals.decide`. Nada disso muda. Nenhuma das entradas novas publica fora, decide pendência, roda agent ou gasta cota, e o contexto continua passando pela fila.
- Risco que sobra: um conteúdo lido pelo chat pode induzir uma mudança de configuração do Locum, como ligar um servidor a uma frente. A mudança aparece na conversa e é reversível.
- Aprovar e abrir sessão no terminal ficam fora do chat e do MCP, só por clique.

### 6. A sessão no terminal recebe a iniciativa por artefato derivado

- `.locum/session.md` e `.locum/session-settings.json` são regerados a cada abertura. Ninguém os edita.
- O prompt entra por `--append-system-prompt`. A pasta entra por `--add-dir`. `--settings` nega `Edit` e `Write` em `context.md` e em `.locum/`, com caminho absoluto escrito com `//` na frente (na regra, `/` sozinho é relativo ao arquivo de settings).
- Nada é escrito no worktree nem no repo do workspace.
- Limite registrado: a negação não cobre escrita por `Bash`. É guarda, não garantia.
- O script de abertura cita todo valor com aspas de shell e usa o caminho resolvido do `claude`: shell de login e interativo, e só caminho absoluto executável, porque o app aberto pelo Finder não tem o PATH do terminal e a saída do shell pode trazer alias ou ruído do `.zshrc`. Só Terminal e iTerm nesta rodada. Warp fica fora porque exige gravar em `~/.warp`.
- A passagem volta como proposta `append`: pelo botão de ler a passagem, ou pelo deep link `locum://session/ended`, que só funciona com o app empacotado.

### 7. Idioma: identificador, caminho, rota e protocolo em inglês; o texto visível vem do dicionário

- Em inglês: nome de arquivo e pasta criados pelo Locum, id e segmento de rota (`#/initiatives/<slug>/<tab>`), deep link, id de agent de sistema, tabela, coluna, chave de configuração, ferramenta MCP e do chat, tipo de ação da fila, componente, hook, arquivo novo e chave de i18n (`initiatives.detail.tabs.context`).
- Todo texto que a pessoa lê (tela, bandeja, notificação, prompt de sistema e texto gerado, como o `context.md` inicial e o `session.md`) vem de chave presente em `en` e `pt-BR`. O texto gerado segue o idioma escolhido. Fora da casca (CLI e servidor MCP), o idioma é a preferência gravada, lida por `src/services/i18n-service.ts`, e sem ela o idioma base `en`; o dicionário entra por `import` estático, nunca lido do disco.
- Motivo de passo pulado ou falho é gravado como código em inglês (`rejected`, `publish_conflict`, `outside_initiative`) e traduzido na tela. Os motivos que o executor já grava em português ficam como estão nesta rodada e aparecem crus; migrá-los é follow-up.
- Descrições de ferramenta MCP e do chat ficam em inglês, porque quem lê é modelo e o público é a comunidade. As existentes, hoje em português sem acento, migram numa fatia própria.
- Código existente com nome em português não é renomeado nas fatias de I1 a I3. O rename é tarefa opcional da fatia de open source bilíngue, com redirecionamento dos ids de rota antigos.
- Docs internos, ADRs e mensagens de commit seguem em português por enquanto. `README.md` e `CONTRIBUTING.md` vão para inglês, e o README em português fica em `README.pt-BR.md`.

## Alternativas consideradas

- Escopo por união dos servidores das iniciativas do agent: vaza leitura e `internal_write` entre frentes.
- Escopo por interseção: seguro, mas ligar a segunda frente tira ferramenta.
- Escopo por execução já agora: atende quem quer reaproveitar um observer entre frentes, mas pede iniciativa em todo gatilho e em todo `run_agent`. Fica como follow-up; a decisão 1 já grava o escopo na execução, então não vai precisar de migração.
- Contexto no banco: tira a pasta de quem usa. Contexto dentro do repo do workspace: suja repo de outro time.
- `CLAUDE.md` para a sessão: só carrega de pasta extra com variável de ambiente, e dentro do worktree colide com o do repo.
- Chat só lendo, com o aceite do I1 reescrito para MCP: contraria o briefing e a decisão 2 do ADR 0003.
- Descrições de ferramenta em português: fecham o projeto para quem contribui de fora.

## Por que estas

Cada decisão reusa uma peça que já existe (fila, versões, executor, servidor MCP, dicionários) e acrescenta o mínimo para isolar frentes e manter a pessoa revisando o que sai no nome dela. Agent sem iniciativa e todas as rotas atuais seguem iguais.

## Consequências

- Duas colunas nulas em tabela existente, sem chave estrangeira no banco, para a migração não recriar `agents` nem `runs`. A integridade fica no serviço, e iniciativa não é apagada nesta rodada, só vai para `dropped`.
- `approvals.status` ganha o valor `conflict`. A tela e as contagens precisam conhecê-lo.
- Existe um agent que ninguém criou. A ocultação e cada recusa têm teste, e qualquer listagem, contagem ou disparo novo de agent precisa respeitá-las (`isReserved`).
- `check:i18n` passa a exigir o mesmo conjunto de chaves em `en` e `pt-BR`. Ele não olha texto gerado em `src/`; ali a guarda é teste: toda chave de template resolve nos dois idiomas, e o `context.md` e o `session.md` gerados não trazem frase cravada.
- O chat passa a escrever configuração do Locum. A superfície cresce, dentro de `internal_write`.
- Reaproveitar um agent entre frentes exige duplicá-lo até o follow-up do escopo por execução.
- O catálogo de ferramentas fica misto em idioma até a fatia de migração das descrições.
- Teste e fumaça usam `LOCUM_INITIATIVES_DIR` e nunca tocam `~/Locum`.
- Status `paused` ou `done` da iniciativa não bloqueia gatilho de agent nesta rodada; segue como follow-up, para virar bloqueio se incomodar no uso.
- `initiatives.staleDays` (padrão dos dias parados que acendem o alerta de frente esquecida) fica configurável desde já, em vez de fixo no código.
- Na fatia de open source (O2), os ids de rota em português (`execucoes`, `configuracao`, `revisao`) são renomeados para inglês, com redirecionamento do hash antigo: link de notificação e janela restaurada com hash velho continuam abrindo a tela certa.

## Follow-ups

- Escopo por execução, a partir de `runs.initiative_id`, para o observer da gestão interina servir a mais de uma frente, sem migração.
- Classe de ferramenta declarada pelo servidor ou pelo preset (I4), em vez de autodeclarada na config.
- Escopo também para passo de ação.
- Warp como terminal de sessão.
- Resolvedor do caminho do `claude` também no runtime e no `claudeCodeAvailable`.
- Confirmação na conversa antes de escrita do chat que amplia escopo (ligar servidor, ligar agent).
- Status `paused` ou `done` da iniciativa bloqueando gatilho de agent.
- Adaptadores de `ContextStore` além da pasta local.
- Motivos de passo que o executor já grava em português migrados para código traduzido.
- Docs internos, ADRs e commits em inglês, quando o projeto tiver quem contribua de fora.
