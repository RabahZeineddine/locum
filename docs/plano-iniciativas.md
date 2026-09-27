> **Aprovado em 27/09/2026.** Plano das fatias de iniciativas, na versão aprovada depois de três rodadas de revisão. O andamento de cada fatia (o que entrou, com hash, e o que falta) está em `docs/estado-atual.md`. ADR: `docs/adr/0004-iniciativas.md`.

# Plano: iniciativas no Locum (I1, I2, I3, I4 opcional, e open source bilíngue)

Fonte: `docs/briefing-iniciativas.md`. Todo caminho abaixo é relativo à raiz, e todo comando roda em `app/`.

Regra de nome (ADR 0004, decisão 7): identificador, caminho, rota, protocolo, chave de i18n, tabela, coluna, ferramenta e ação em inglês; o texto que a pessoa lê vem do dicionário, em `en` e `pt-BR`. Código existente com nome em português não é renomeado nas fatias de I1 a I3.

## Decisões do usuário em 27/09 (aprovação)

- Plano e ADR aprovados para execução.
- Status `paused`/`done` da iniciativa não bloqueia gatilho nesta rodada (follow-up para o I5).
- N de "parada há N dias" configurável já (`initiatives.staleDays`, fatia 6).
- Na O2, renomear ids de rota em português (`execucoes`, `configuracao`, `revisao`) para inglês, com redirecionamento do hash antigo.
- Em aberto: quando docs internos, ADRs e commits passam para inglês.

## Mudanças desde v3

Remendo final, a partir da terceira rodada de revisão.

- Run da proposta nasce com `startedAt` gravado, para a decisão não contar execução nova no `usage_daily` (`executor.ts:114`, `budget.ts:61-75`). Teste: depois de decidir, nenhuma linha de `locum-context` no `usage_daily`.
- `executor.decide` devolve `{ status: "approved" | "rejected" | "conflict"; run: "done" | "paused" | "failed" }`; as asserções de `approval-resume.test.ts:97,108` e `budget.test.ts:136` passam a ler `.run`; a CLI (`cli.ts:575`) imprime os dois.
- `InitiativeService` recebe a gate pelo construtor (padrão `buildGate()`, `build.ts:61`); `prepare` devolve `{ payload, mode }`; toda escrita da transação termina em `.run()`.
- Linhas que ainda diziam `gate.submit` direto trocadas por `prepare` mais `enqueue`.
- `src/services` sai da promessa do `check-i18n` (o script só olha JSX e menu ou notificação do Electron). A guarda é o `text-service.test` mais um teste procurando frase fixa no `context.md` e no `session.md` gerados.
- Citações: `electron/bridge-contract.ts:37`; consumidor `renderer/lib/aprovar.ts:32` trata `conflict` (fatias 3b e 6).

## Mudanças desde v2

Remendo sobre a v2, a partir da segunda rodada de revisão. O que não está aqui ficou como na v2.

- Agent reservado protegido também fora do `AgentService`: `TriggerService.set` e `setEnabled` (`trigger-service.ts:67`), `ExecutionService.start` (atrás do `run_agent`, `run-tools.ts:41`, e do `cli.ts:57`) e `RunService.rerunStep` (`run-service.ts:253`) recusam o id, o que cobre MCP, ponte e CLI de uma vez. Reservados saem do `MetricsService` (`metrics-service.ts:79-89`), da contagem do `locum_health` (`server.ts:57`) e da varredura da reconciliação (`reconcile-service.ts:33`). Um teste por ponto (fatia 3b).
- Proposta de contexto atômica: validação assíncrona primeiro, depois run, passo (já `awaiting_approval`) e pendência numa transação síncrona só, pela `ApprovalGate.enqueue`, que o `submit` passa a usar por dentro. Falha antes ou dentro da transação não deixa nada gravado; teste com falha injetada entre as gravações.
- Semeadura síncrona no `migrateDb` (`migrate.ts:99`), `INSERT OR IGNORE` de agent e versão numa transação, com id de versão fixo `locum-context@1`. O sistema é reconhecido pelo id da versão. Spec com o passo `key: "propose"`, `action: "context.update"`, igual ao passo gravado.
- `DecisionResult` (`bridge-contract.ts:37`, `bridge.ts:132-142`) e a saída do `approve` na CLI (`cli.ts:574`) devolvem o estado final da pendência: `approved`, `rejected` ou `conflict`. A revisão mostra o conflito.
- i18n: `check-i18n.mjs` ganha paridade de chaves `en` e `pt-BR` e a raiz `src/services` (fatia 2). Texto gerado fora da casca usa `src/services/i18n-service.ts` (`FALLBACK_LANGUAGE`, `LANGUAGE_KEY`) mais um `translate` novo em `src/services/text-service.ts`, com os dicionários por `import` estático como `electron/i18n.ts:2-3`. CLI e MCP leem a preferência gravada.
- Motivo de passo pulado ou falho vira código (`outside_initiative`, `rejected`, `publish_conflict`) em `steps.error`, traduzido na tela. Motivos antigos em português ficam como estão e aparecem crus.
- `resolveClaudeBinary`: `/bin/zsh -ilc`, só caminho absoluto com `X_OK`, e `~/.local/bin/claude` na lista. `deny` usa `//` para caminho absoluto. Teste de shell com sentinela `touch`, nunca `rm`.
- `LOCUM_INITIATIVES_DIR` nos dois ramos do `smokeHome` (`path.ts:39-41`). Citação corrigida para `executor.ts:327`. Comentário `chat-tools.ts:27-28` ganha parágrafo próprio.
- Critério de pronto lista as fatias do mínimo: 1, 2, 3a, 3b, 4, 5a, 6, F.

## Mudanças desde v1

- Proposta de contexto sem evento e sem execução de agent: `InitiativeService.proposeContextUpdate` grava run, passo e pendência por `gate.prepare` mais `gate.enqueue` (v3). Agent de sistema `locum-context` com id reservado, semeado pelo `migrateDb`, escondido e protegido no `AgentService` (fatia 3b).
- `context.update` com regra de conflito que nunca deixa pendência presa: `append` sem `baseHash`, `replace` com hash, `publish` idempotente, e conflito fecha a pendência como `conflict` (gate ganha `PublishConflict`).
- Escopo MCP lê `runs.initiative_id` fotografado no `createRun`, inclusive na retomada; checagem antes do `missing()`. ADR registra o que o escopo não cobre.
- Chat ganha as escritas `internal_write` de iniciativa, para o aceite do I1 valer, com justificativa contra a emenda 5 do ADR 0003.
- Sessão (I3) sem `CLAUDE.md`: prompt por `--append-system-prompt`, `--settings` negando `Edit` e `Write` no `context.md`, caminho do `claude` resolvido de fato, aspas de shell com teste de `"; rm -rf ~`, "Read handoff" como caminho testável. Warp sai desta rodada.
- Fatia 3 virou 3a e 3b; fatia 5 virou 5a e 5b; corte do dia marcado; fechamento (fatia F) ao fim de cada dia.
- `LOCUM_INITIATIVES_DIR` em `test/setup.ts` e no `smokeHome` (cobre `smoke` e `smoke:dist`). Testes de gate e executor no banco do módulo.
- Colunas novas em `agents` e `runs` sem `.references()`, para a migração não recriar tabela.
- Bilíngue: nomes em inglês (`~/Locum/initiatives/<slug>/`, `context.md`, `handoffs/`, `#/initiatives/<slug>/<tab>`, `locum://session/ended`, `CurrentInitiativeProvider`); aceite de i18n por fatia; texto gerado no idioma escolhido; descrições de ferramenta em inglês; fatias O1 e O2 pós-corte.
- Citações corrigidas: `claude-code.ts:9` é `claudeArgs` e o `claude` roda por PATH em `claude-code.ts:59`; `test/deep-link-service.test.ts` é arquivo novo; `InMemoryTransport` não tem precedente nos testes.

## Princípios, motivadores e opções

### Princípios

1. Nada muda fora do Locum, nem no contexto da iniciativa, sem passar pela fila de aprovação. Exceção declarada: a própria pessoa editando o arquivo no editor dela.
2. Aditivo: agent sem iniciativa se comporta exatamente como hoje, e nenhuma rota atual some.
3. Um caminho de escrita só. O que agent, chat ou sessão propõem vira pendência no `ApprovalGate`.
4. O dado de quem usa mora na pasta e no banco dela. O repo leva só código, fixtures e presets genéricos.
5. Aberto para contribuir: nome em inglês, texto visível nos dois dicionários, nada cravado.
6. Fatia pequena, verde e commitada: `npm run verify` e `npm test` verdes e um commit em `main`, sem push.

### Drivers de decisão

1. Isolamento entre frentes (o que um agent enxerga cabe numa linha).
2. Revisão humana antes de qualquer escrita que a pessoa assina.
3. Reaproveitar fila, versões imutáveis, executor e servidor MCP, em vez de criar paralelo.

### Opções por decisão

**A. MCP de agent em mais de uma iniciativa**

| opção | prós | contras |
|---|---|---|
| No máximo uma iniciativa, escopo lido de `runs.initiative_id` (escolhida) | regra de uma linha; agent global intacto; a fonte na execução deixa escopo por execução virar mudança de gatilho, sem migração | reaproveitar hoje exige duplicar agent ou usar prompt |
| União, com `external_write` sempre aprovado | agent reaproveitado sem cópia | vaza leitura e `internal_write` entre frentes; a garantia do `external_write` já existe (`app/src/mcp/registry.ts:150`) |
| Interseção | seguro | ligar a segunda frente tira ferramenta |
| Escopo por execução já agora | atende o observer da gestão interina | pede iniciativa em todo gatilho, em todo `run_agent` e na tela de agent; não cabe na rodada |

**B. Onde mora o contexto**: pasta local atrás de `ContextStore` (escolhida) contra texto no banco (tira a pasta de quem usa) e dentro do repo do workspace (suja repo de outro time).

**C. Como a proposta de contexto vira pendência**

| opção | prós | contras |
|---|---|---|
| Run, passo e pendência gravados pelo serviço numa transação, por `gate.prepare` mais `gate.enqueue`, agent reservado semeado (escolhida) | reaproveita fila, joins do `ApprovalService.query` (`approval-service.ts:96`), retomada e tela; nenhuma coluna de `approvals` muda | um agent que ninguém criou, oculto e protegido, com teste |
| Evento mais agent de sistema executado (v1) | usa o executor inteiro | não funciona: `runActionStep` lê `step.input ?? step.needs[0]` (`executor.ts:327`) e `alvoDoEvento` copia lista fixa (`executor.ts:366`); o payload chega `undefined` |
| `runs.agent_version_id` nulo | sem agent reservado | SQLite recria `runs`; todo `innerJoin` com agents vira `leftJoin`; orçamento e tela assumem agent |
| Tabela própria de propostas | modelo limpo | segunda fila, segunda tela, segundo caminho de escrita; fere o princípio 3 |

**D. Prompt da sessão (I3)**

| opção | prós | contras |
|---|---|---|
| `--append-system-prompt` com texto gerado e `--settings` negando escrita no `context.md` (escolhida) | não depende de variável de ambiente; a proteção vai junto; nada no worktree | `deny` não cobre escrita por `Bash`; é guarda, não garantia |
| `CLAUDE.md` na pasta, passada com `--add-dir` | arquivo legível | só carrega com `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; `--add-dir` dá escrita na pasta inteira sem trava |
| `CLAUDE.md` no worktree | carregado sem flag | suja repo alheio e colide com o `CLAUDE.md` dele |

**E. Chat e escrita de iniciativa**

| opção | prós | contras |
|---|---|---|
| Expor as `internal_write` de iniciativa no catálogo escrito à mão (escolhida) | cumpre o aceite do I1 como o briefing escreveu; nada publica fora nem decide pendência | injeção vinda de conteúdo lido pode mudar configuração do Locum, como ligar servidor a uma frente; visível na conversa e reversível |
| Reescrever o aceite do I1 para MCP, com chat só lendo | superfície menor | contraria o briefing; o chat é o gêmeo do MCP (ADR 0003, decisão 2) |

**F. Idioma das descrições de ferramenta (MCP e chat)**

| opção | prós | contras |
|---|---|---|
| Inglês nas novas, e fatia O1 migrando as existentes (escolhida) | consumidor é modelo e o público é a comunidade; uma convenção só | catálogo misto até a O1 rodar |
| Manter português | nada muda | quem contribui de fora não lê; mistura com nomes já em inglês (`upsert_agent`) |

**G. Prompt reutilizável**: entidade própria versionada (escolhida) contra agent sem gatilho, que carrega passo, modelo e custo e polui a lista.

## Desenho

### Esquema (`app/src/db/schema.ts`, migração por `npm run db:generate -- --name initiatives`)

Colunas novas em tabela existente, nulas e **sem `.references()`**, para o SQL gerado ser `ALTER TABLE ADD COLUMN` e não recriar `agents` nem `runs`. A integridade fica no serviço: iniciativa não é apagada nesta rodada, só vai para `dropped`.

- `agents.initiative_id` (tabela em `schema.ts:15`). Só `linkAgent` grava. O vínculo não entra no `AgentSpec` nem no export, porque é dado de quem usa.
- `runs.initiative_id` (tabela em `schema.ts:83`). Gravada no `createRun` (`executor.ts:46`), que ganha o parâmetro `initiativeId` opcional: explícito quando vem, senão o `agents.initiative_id` naquele momento. Nunca reescrita.

Tabelas novas (padrão de `schema.ts`: `id` texto, datas `integer` com `now` de `schema.ts:11`; FKs só entre as novas):

- `initiatives`: `id`, `slug` (único, regex de `ID_DE_AGENT`, `agent-service.ts:37`), `title`, `objective`, `done_criteria`, `due_at` (nulo), `status` (`active` | `paused` | `done` | `dropped`), `goal_ref` (nulo), `context_path`, `context_hash` (nulo), `context_updated_at` (nulo), `created_at`, `updated_at`.
- `initiative_workspaces`: `id`, `initiative_id` (cascade), `repo_path`, `worktree_path` (nulo), `branch` (nulo), `label` (nulo).
- `initiative_mcp_servers`: `initiative_id` (cascade), `server_name`, único no par. Nome e não FK, porque o servidor pode ser removido e registrado de novo.
- `initiative_links`: `id`, `initiative_id` (cascade), `kind` (`doc` | `board` | `repo` | `other`), `url`, `label`.
- `prompts`: `id`, `name` (único), `initiative_id` (nulo), `created_at`. `prompt_versions`: `id`, `prompt_id` (cascade), `version`, `body`, `note`, `created_at`, único em `(prompt_id, version)`.
- `sessions` (usada na fatia 7, criada já nesta migração): `id`, `initiative_id` (cascade), `workspace_id` (nulo), `terminal` (`terminal` | `iterm`), `nonce` (único), `status` (`open` | `ended` | `read`), `handoff_path` (nulo), `started_at`, `ended_at` (nulo).

`approvals.status` ganha o valor `conflict`, sem migração (coluna texto; atualizar o comentário em `schema.ts:143`).

Borda de banco adotado (`migrate.ts:59-76`): banco nascido de `drizzle-kit push` e sem tabela de controle tem todas as migrações marcadas como aplicadas, esta inclusive, sem rodar. Todo banco real hoje já tem controle; o executor confere no dele e registra como armadilha, sem código novo.

### Pasta de contexto

`<root>/<slug>/`, com `root` vindo de `LOCUM_INITIATIVES_DIR`, senão da chave `initiatives.root` do `SettingsService` (`settings-service.ts:14`), senão `~/Locum/initiatives`. Dentro: `context.md` (da pessoa), `handoffs/<date>.md` (escritos pela sessão), e `.locum/` com os artefatos derivados que o Locum regera e ninguém edita (`session.md`, `session-settings.json`, `open-session.command`).

### Serviços (`app/src/services/`, `db` no construtor como os atuais)

- `context-store.ts`: interface `ContextStore` (`read`, `list`, `hash`, `write(file, content, { expectHash? })`, `append(file, block, marker)`) e `LocalFolderContextStore(root)`. Escrita atômica (temporário e `rename`). Caminho fora da pasta (`..`, absoluto, link simbólico que sai) é recusado.
- `initiative-service.ts`: `list`, `get(slug)`, `upsert` (cria pasta e `context.md` **só quando não existem**; nunca reescreve), `setStatus`, `setServers(slug, names[])` (valida contra `McpService.list`, `mcp-service.ts:41`, e devolve os agents ligados que perderiam ferramenta), `linkAgent(slug, agentId | null)` (recusa se ferramentas ou `requiresServers` do agent saem dos servidores da frente), `setWorkspaces` (caminho absoluto, diretório existente, normalizado por `realpath`; recusa o resto), `addLink`, `removeLink`, `overview()` (fato cru para o Início; a casca escreve a frase).
- Texto gerado (o `context.md` inicial e o `session.md`) vem de chaves do dicionário (`initiatives.contextTemplate.*`, `session.prompt.*`), nos dois idiomas. `src/` não importa `electron/`, então o idioma fora da casca vem de `src/services/i18n-service.ts`: `I18nService` lê a preferência gravada (`LANGUAGE_KEY`, `i18n.language`), e sem ela vale `FALLBACK_LANGUAGE` (`en`). O `translate(lang, key, vars)` fica em `src/services/text-service.ts` (novo), com os dois dicionários por `import` estático de `../../locales/en.json` e `../../locales/pt-BR.json`, o mesmo padrão de `electron/i18n.ts:2-3` (`resolveJsonModule` ligado no `tsconfig.json`). Assim nenhum ramo lê arquivo de dicionário em tempo de execução: o MCP roda por `tsx` (`.mcp.json`, `npm run mcp`), a CLI também (`npm run dev`), e no app empacotado o esbuild do `build-main.mjs` embute o JSON no `dist/main.cjs`. Não existe CLI empacotada hoje; se vier, o mesmo `import` vale. A casca continua podendo injetar o `t` dela, e o serviço usa o `text-service` quando nada é injetado. Interpolação `{{nome}}` igual à do i18next, sem trazer o i18next para `src/`.
- `InitiativeService` recebe a `ApprovalGate` pelo construtor, além do `db`; quem monta passa a gate de `buildGate()` (`app/src/executor/build.ts:61`), como o executor já faz. O teste injeta a gate montada no banco do módulo.
- `InitiativeService.proposeContextUpdate({ slug, mode, content, baseHash?, origin })` (fatia 3b), sem executar agent e sem evento:
  1. valida (`replace` exige `baseHash`; `append` não aceita) e confere que a versão `locum-context@1` existe e pertence ao agent `locum-context`; senão falha com mensagem clara;
  2. roda a parte assíncrona antes de gravar: `gate.prepare("context.update", payload, "approve")`, que é o começo do `submit` de hoje (`gate.ts:76-92`: modo aceito e `handler.propose`) e devolve `{ payload, mode }`, com `mode` já depois do `holdForApproval` (`gate.ts:92`). Erro aqui não grava nada;
  3. numa transação síncrona do better-sqlite3 (`db.transaction((tx) => { ... })`, callback sem `async`), grava três linhas, cada escrita terminando em `.run()` (o driver better-sqlite3 do drizzle não executa builder solto): o run com `agent_version_id: "locum-context@1"`, `initiative_id` explícito, `status: "paused"` e `startedAt` preenchido com o `now` do insert (sem ele, a decisão vê `startedAt === null` em `executor.ts:114`, trata como run novo e o `recordSpend` grava `runs=1` para `locum-context` no `usage_daily`, `budget.ts:61-75`, que aparece em `MetricsService.usage`, `metrics-service.ts:201-214`); o passo com `stepKey: "propose"`, `idx: 0`, o payload em `input` e **já** `status: "awaiting_approval"`; e a pendência `pending` por `gate.enqueue(tx, req, prepared)`, o insert que hoje está em `gate.ts:94-102`, extraído para o `submit` e a proposta usarem o mesmo código;
  4. devolve o id da pendência.
  Não existe estado intermediário: ou as três linhas existem, ou nenhuma. Por isso "submit falhou" não precisa virar run `failed`: não há run. O `resumeAll` olha `queued` e `running`, então nunca pega esse run; a retomada depois da decisão casa por `step.key` (`executor.ts:118`), e o passo gravado tem a mesma chave do spec.
  A decisão segue o caminho de sempre: `executor.decide` fecha e retoma, e a retomada (`executor.ts:124-131`) leva o run a `done`.
- Agent reservado `locum-context`: `RESERVED_AGENT_IDS` e `isReserved(id)` exportados de `agent-service.ts`.
  - Semeadura: `seedSystemAgents()` síncrono, chamado no fim do `migrateDb` (`migrate.ts:99`, que é síncrono), porque Electron, CLI e MCP migram o mesmo banco (`electron/main.ts:5228`, `src/cli.ts:433`, `src/mcp-server/index.ts:20`), às vezes ao mesmo tempo. Insert direto em `agents` e `agent_versions` com `.onConflictDoNothing().run()` do drizzle (`INSERT OR IGNORE`), numa transação síncrona, sem o `AgentService`, que é assíncrono. Ids fixos: agent `locum-context`, versão `locum-context@1`, `version: 1`. Dentro da transação, se o agent `locum-context` já existe e a versão `locum-context@1` não, é agent de usuário: não grava nada, e a proposta falha no passo 1 acima. O sistema é reconhecido pelo id da versão, nunca pela comparação de spec.
  - Spec: um passo `{ key: "propose", type: "action", action: "context.update", mode: "approve" }`, mais o `name` e o `needs: []` do `StepBase`, validado pelo `AgentSpec` de hoje no teste, com a mesma chave do passo que a proposta grava.
  - `AgentService` esconde os reservados de `list`, `overview`, `budgets`, `duplicate` e `exportSpec`, e recusa `upsert`, `saveEdited`, `setBudget` e `importSpec`. Não há `delete` hoje; se entrar, recusa também.
  - Fora do `AgentService`, recusa com a mesma mensagem: `TriggerService.set` e `setEnabled` (`trigger-service.ts:60-70`), `ExecutionService.start` (`execution-service.ts:76`, atrás do `run_agent` em `run-tools.ts:41` e da CLI em `cli.ts:57`) e `RunService.rerunStep` (`run-service.ts:253`, atrás do `rerun_step`, de `runs.rerunStep` em `bridge.ts:125` e de `cli.ts:591`). A checagem mora no serviço, então MCP, ponte e CLI herdam.
  - Fora das contas: `MetricsService` filtra o agent reservado no join de `metrics-service.ts:79-89`; `locum_health` conta agents sem os reservados (`server.ts:57`); a reconciliação (`SWEEPABLE`, `reconcile-service.ts:33`) ignora runs de agent reservado, que ficam `paused` na fila e não têm achado.
  - O nome visível do agent na fila e nas execuções vem do dicionário.
- `prompt-service.ts`: `list(initiativeId?)`, `get(name)`, `upsert(name, body, note)` (versão nova só quando o corpo muda), `versions(name)`.
- `RunFilter` (`run-service.ts:16`) ganha `initiativeId`. `AgentService.overview` (`agent-service.ts:357`) devolve `initiativeId`.

### Fila: handler `context.update` e conflito

- `app/src/approval/gate.ts` ganha `class PublishConflict extends Error`. Em `decide` (`gate.ts:125`), se `publish` lança `PublishConflict`, a gate fecha a pendência como `conflict` e chama `settleStep(stepId, "conflict")`. Outro erro segue como hoje: pendência continua `pending` e rejeitável.
- `settleStep` (`gate.ts:158`) trata `conflict` como `rejected` (passo `skipped`, com o motivo). Sem isso a retomada em `executor.ts:130` marcaria o passo como publicado.
- Motivo de passo pulado ou falho é código, não frase: `steps.error` recebe `rejected`, `publish_conflict` ou `outside_initiative` (o texto de hoje em `gate.ts:163`, "rejeitado na fila de aprovação", vira `rejected`). A tela de execução traduz por `runs.stepReason.<code>` nos dois dicionários; valor que não é código conhecido (erro de runtime, motivo antigo gravado em português) aparece cru, como hoje. Os demais motivos existentes do executor ficam como estão nesta rodada; migrá-los é follow-up.
- Estado final da decisão: `ApprovalGate.decide` passa a devolver `{ runId, status }`, com `status` em `approved`, `rejected` ou `conflict`. `executor.decide` (`executor.ts:63`), que hoje devolve só o estado do run, passa a `Promise<{ status: "approved" | "rejected" | "conflict"; run: "done" | "paused" | "failed" }>`: `status` é o da pendência, `run` o do run depois da retomada. As asserções que hoje comparam o retorno com `"done"` (`test/approval-resume.test.ts:97,108` e `test/budget.test.ts:136`) passam a ler `.run`, e nada mais nelas muda. `DecisionResult` (`electron/bridge-contract.ts:37`) ganha `status` com os três valores, preenchido em `bridge.ts:132-142` a partir do retorno, em vez de ecoar a decisão pedida. A CLI (`cli.ts:575`) imprime os dois campos, e `conflict` sai como "conflito, nada publicado", sem dizer "aprovado e publicado". No renderer, `decidir` (`renderer/lib/aprovar.ts:32`, hoje `Promise<void>`) devolve o `DecisionResult`, e a revisão, ao receber `conflict`, mostra o aviso de conflito no lugar do toast de aprovado.
- Handler em `buildGate` (`app/src/executor/build.ts:61`), `modes: ["approve"]`:
  - `propose` valida `{ initiativeId, slug, file: "context.md", mode, content, baseHash?, origin }` com zod.
  - `publish` com `replace`: hash atual igual ao hash de `content` é no-op (retomada pós-crash); hash atual diferente de `baseHash` lança `PublishConflict`; senão grava.
  - `publish` com `append`: anexa ao texto atual, sem `baseHash`, com o marcador `<!-- locum:<externalId> -->` antes do bloco; marcador já presente é no-op. É a idempotência do `append`, que não tem hash esperado.
  - Depois de gravar, atualiza `context_hash` e `context_updated_at`.
- Revisão (`renderer/src/telas/revisao.tsx`, fatia 6): diff contra o arquivo **atual**, lido na hora, com `diffLinhas` (`renderer/lib/diff.ts:47`). `replace` com hash atual diferente do `baseHash` mostra o aviso de que o contexto mudou desde a proposta e desliga aprovar; recusar continua. Pendência já fechada como `conflict` (hash mudou entre abrir a tela e clicar, ou por outro cliente) mostra o estado de conflito, com o motivo traduzido, e nenhum botão de decisão.

### Executor: escopo MCP

- `execute` lê `run.initiativeId`, a fotografia do `createRun`, também na retomada; nunca relê do agent. A lista de servidores da frente é lida a cada `execute`, então tirar um servidor vale na próxima execução ou retomada.
- `runModelStep`: `resolveTools(spec, step)` sobe para antes do `missing()` (`executor.ts:230`; hoje `resolveTools` está em `:249`). Servidores das ferramentas e de `requiresServers` fora da frente entram na conta dos ausentes: opcional é pulado com o código `outside_initiative` em `steps.error`, obrigatório falha com o mesmo código. O runtime recebe só os permitidos (`executor.ts:278`).
- Não cobre passo de ação (`slack.post`, `tracker.create_issue`): esses já passam pela fila, e o ADR registra o limite.

### Servidor MCP do Locum (`app/src/mcp-server/initiative-tools.ts`, registrado em `server.ts:21`)

Nomes e descrições em inglês.

| ferramenta | classe |
|---|---|
| `list_initiatives`, `get_initiative`, `read_initiative_context` (com hash), `list_prompts`, `get_prompt` | read |
| `upsert_initiative`, `set_initiative_status`, `set_initiative_servers`, `link_agent_to_initiative`, `set_initiative_workspace`, `add_initiative_link`, `upsert_prompt` | internal_write |
| `propose_context_update` (só cria a pendência) | internal_write |

Fora do MCP e do chat: aprovar e abrir sessão no terminal. Só por clique, como o `approvals.decide` hoje.

### Chat (`app/electron/chat-tools.ts`)

O catálogo ganha, entrada por entrada, as de leitura e as `internal_write` da tabela acima, com nomes e descrições em inglês (`list_initiatives`, `create_initiative`, `set_initiative_servers`, `propose_context_update` e as demais). As entradas existentes em português ficam até a O1 e a O2. O comentário do topo (`chat-tools.ts:11-30`) ganha o motivo: a emenda 5 do ADR 0003 proíbe catálogo derivado dos canais e `approvals.decide`, e nenhuma destas publica fora, decide pendência ou gasta cota. O parágrafo de `chat-tools.ts:27-28` ("Gravar agent entra, porque ... volta rebaixado para aprovacao") só justifica gravar agent, pelo teto do rebaixamento, e não vale para as escritas de iniciativa, que não têm esse teto. Ele fica como está, e as escritas de iniciativa ganham parágrafo próprio logo abaixo, com a justificativa acima e o risco de injeção dito com todas as letras, sem estender aquele argumento a elas. O risco que sobra fica no ADR 0004, com follow-up de confirmação na conversa para escrita que amplia escopo.

### Interface

Chaves de i18n em inglês (`nav.home`, `initiatives.list.title`, `initiatives.detail.tabs.context`).

| rota | o que vira |
|---|---|
| `inbox` | rótulo "Início"/"Home" (chave `nav.home`). Painel de frentes no topo e a fila atual embaixo. Id `inbox` fica pelo smoke (`electron/main.ts:1066`) e pelas notificações. |
| `revisao` | continua em `#/inbox/<approvalId>`, com o tipo `context.update`. |
| `initiatives` (nova) | lista em `#/initiatives`, detalhe em `#/initiatives/<slug>/<tab>`, com `tab` em `context` \| `agents` \| `integrations` \| `runs` \| `actions`. O detalhe chega como `slug/tab` (`renderer/lib/router.ts:30`); tab ausente vale `context`. Arquivos novos em inglês (`renderer/src/telas/initiatives.tsx`, na pasta existente). |
| `agents`, `execucoes` | ganham chip de filtro por iniciativa (5b). Ids existentes não mudam. |
| `configuracao` | seção `geral` (`configuracao.tsx:52`) ganha a pasta raiz das iniciativas (5b) e o terminal preferido (7), chaves `initiatives.root` e `session.terminal`. |

Iniciativa atual (5b): `CurrentInitiativeProvider` e `useCurrentInitiative` em `renderer/src/current-initiative.tsx`, montado no `Layout` (`layout.tsx:68`); dentro de `#/initiatives/<slug>` a fonte é a rota, fora dela a última visitada, só em memória. Paleta (`paleta.tsx:13`): ir para iniciativa e copiar prompt em 5b; abrir sessão da atual na fatia 7. `chat.send` (`bridge-contract.ts:296`) ganha `context?: { initiative?: string }`, e `electron/chat.ts:133` acrescenta só o slug ao prompt de sistema, por chave do dicionário, nunca o texto do contexto.

### Sessão no terminal (I3, fatia 7)

- Artefatos derivados em `<pasta>/.locum/`, regerados a cada abertura: `session.md` (objetivo, critério de pronto, prazo, workspaces, links, e a instrução de escrever a passagem em `handoffs/<date>.md`), no idioma escolhido, de `session.prompt.*`; e `session-settings.json` (`permissions.deny` para `Edit` e `Write` em `context.md` e em `.locum/`). Sintaxe decidida: caminho absoluto leva `//` na frente, porque `/caminho` numa regra é relativo ao arquivo de settings e `~/` é relativo ao home. Para a pasta `/Users/x/Locum/initiatives/foo`, as regras são `Edit(//Users/x/Locum/initiatives/foo/context.md)`, `Write(//Users/x/Locum/initiatives/foo/context.md)`, `Edit(//Users/x/Locum/initiatives/foo/.locum/**)` e `Write(//Users/x/Locum/initiatives/foo/.locum/**)`, com o caminho vindo do `realpath` da pasta. O teste confere o JSON gerado com esse formato.
- `.locum/open-session.command` (modo 755): `cd` no worktree (ou repo, ou na pasta), `<claude> --add-dir <pasta> --settings <settings> --append-system-prompt "$(cat <session.md>)"`, depois `open 'locum://session/ended?session=<id>&token=<nonce>'`. O executor confere as três flags no `claude --help`.
- Aspas de shell: todo valor que entra no script passa por `shellQuote` (aspas simples, `'` vira `'\''`). O texto do prompt nunca é interpolado, só lido por `$(cat ...)`.
- Caminho do `claude`: `resolveClaudeBinary()` em `app/src/runtimes/claude-binary.ts`, na ordem `LOCUM_CLAUDE_BIN`, `/bin/zsh -ilc 'command -v claude'` (interativo e de login, porque o PATH de muita gente só nasce no `.zshrc`), `~/.local/bin/claude` (instalador nativo atual), `~/.claude/local/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`. Todo candidato só vale se for caminho absoluto e passar em `accessSync(p, X_OK)`: a saída do `zsh` pega a última linha não vazia, e `claude: aliased to ...`, nome de função ou texto de `.zshrc` falante são descartados e a busca segue. O `zsh` roda com tempo limite curto e `stdin` fechado. Achou, o script leva o caminho absoluto; não achou, o botão avisa e o script usa `claude` do PATH do terminal. O runtime (`claude-code.ts:59`) e `claudeCodeAvailable` (`providers/registry.ts:93`) seguem no PATH nesta rodada; adotar o resolvedor ali é follow-up.
- Terminais: Terminal e iTerm por `open -a <app> <script>`, padrão Terminal. Warp fica fora: grava em `~/.warp/launch_configurations`, fora da pasta de contexto.
- Volta: botão "Read handoff" (texto do dicionário) na aba `actions` é o caminho testável e o garantido. O deep link `session/ended` entra no `parseDeepLink` (`deep-link-service.ts:72`, hoje só `oauth/callback` em `:85`) com sessão e nonce validados e de uso único, mas só funciona com o app empacotado (`docs/estado-atual.md`, item do dono do esquema `locum://`). Ler o handoff mais novo ainda não lido chama `proposeContextUpdate` com `append`.
- Teste e smoke nunca abrem terminal: `exec` injetado com espião.

## Fatias

Regra de toda fatia:

- Executor Sonnet implementa, roda `npm run verify` e `npm test` em `app/`, e commita em `main` sem push, sem trailer `Co-Authored-By` nem assinatura de IA.
- Fatia que mexe no esquema roda `db:generate` na mesma fatia e a migração vai no mesmo commit.
- **i18n**: toda string nova de tela, bandeja, notificação, prompt de sistema e texto gerado entra em `app/locales/en.json` e `app/locales/pt-BR.json`, com chave em inglês; nada cravado. Aceite de toda fatia com texto visível: `npm run check:i18n` verde, e a partir da fatia 2 ele falha quando o conjunto de chaves de `en` e `pt-BR` difere.
- Toda fatia anota armadilha nova (causa e contorno) numa nota de trabalho do dia; a fatia F leva para `docs/estado-atual.md`.

### Corte do dia

- **Mínimo de hoje (I1 e I2):** 1, 2, 3a, 3b, 4, 5a, 6, F. Ao fim, chat e MCP criam e configuram iniciativa, agent de frente só enxerga os servidores dela, contexto muda por aprovação, e a interface tem Início, lista e detalhe com Contexto, nos dois idiomas.
- **Amanhã:** 5b, 7 (I3), F de novo; depois O1, O2 e 9 (I4) se sobrar. O1 e O2 ficam fora do caminho crítico de I1 a I3.
- Se o dia acabar antes do mínimo, a F roda mesmo assim sobre o que ficou pronto.

### Fatia 1. Base de documentação

- Commit inclui `docs/briefing-iniciativas.md` (hoje untracked).
- `.gitignore` da raiz ganha a pasta de planejamento local.
- `docs/adr/0004-iniciativas.md` a partir do rascunho aprovado, `Status: aceito`.
- `docs/roadmap.md`: seção "Iniciativas" depois de M5: I1 núcleo, I2 interface, I2b redesenho visual (depois de dias de uso, a partir de capturas reais, sem data), I3 sessão, I4 presets MCP genéricos, I5 uso real, e "Open source bilíngue" (O1 descrições de ferramenta em inglês, O2 README em inglês, `README.pt-BR.md`, `CONTRIBUTING.md`, renomeação opcional). Link do ADR 0004 na tabela de documentação do `README.md`.
- Cria a nota de armadilhas do dia com o formato (fatia, causa, contorno).
- Aceite: `git ls-files docs/briefing-iniciativas.md` lista o arquivo; ADR com as seções do rascunho; `verify` verde.
- Commit: `docs: ADR 0004, briefing e marcos de iniciativas no roadmap`

### Fatia 2. Esquema, ContextStore, InitiativeService e PromptService (I1)

- Tabelas e colunas do desenho, `npm run db:generate -- --name initiatives`. Conferir o SQL: só `CREATE TABLE` das novas e `ALTER TABLE ... ADD COLUMN` em `agents` e `runs`; nenhum `__new_agents` nem `__new_runs`.
- `ContextStore`, `LocalFolderContextStore`, `InitiativeService` (sem `linkAgent` e sem `proposeContextUpdate`), `PromptService`, `text-service.ts` (`translate`, dicionários por `import` estático). Template do `context.md` inicial em `initiatives.contextTemplate.*` nos dois dicionários.
- `scripts/check-i18n.mjs` ganha a checagem de paridade: achata as chaves de `en.json` e `pt-BR.json` (ignorando o sufixo `_zero`, que só `pt-BR` exige, `:204-223`) e falha listando o que falta de cada lado. `RAIZES` não muda: o script só acusa literal em JSX e em menu ou notificação do Electron (`:9-15`), então pôr `src/services` ali não guardaria nada. A guarda do texto gerado fora da casca é o `test/text-service.test.ts` mais o teste de frase fixa do `context.md` gerado, abaixo.
- `test/setup.ts` define `LOCUM_INITIATIVES_DIR` dentro da pasta temporária dele. `smokeHome` (`src/db/path.ts`) define `LOCUM_INITIATIVES_DIR` em `<dir>/initiatives` quando ausente **nos dois ramos**: no de `LOCUM_HOME` já escolhido (`path.ts:39-41`, que hoje retorna cedo) e no temporário. Sem isso, a fumaça rodada pelo loop com `LOCUM_HOME` próprio criaria iniciativa em `~/Locum`. `electron/main.ts:52` e `scripts/smoke-dist.mjs` passam pelo `smokeHome`, então `smoke` e `smoke:dist` ficam cobertos.
- Testes: `test/context-store.test.ts` (ler, listar, gravar atômico, `expectHash` errado recusa, `append` com marcador repetido é no-op, recusa de `..`, absoluto e link que sai); `test/initiative-service.test.ts` (upsert cria pasta e `context.md`; segundo upsert não reescreve `context.md` editado; slug inválido recusado; servidores validados; `setWorkspaces` recusa relativo, inexistente e arquivo; `context.md` inicial sai em `en` sem preferência gravada, em `pt-BR` com `i18n.language` gravado como `pt-BR` e sem nada injetado, e com o `t` injetado quando há; o `context.md` gerado em `en` não contém frase do template `pt-BR` e vice-versa, e nenhuma linha dele fica fora do que as chaves `initiatives.contextTemplate.*` produzem, o que pega frase cravada no serviço; `overview` com data fixa); `test/text-service.test.ts` (toda chave de `initiatives.contextTemplate.*` e `session.prompt.*` resolve nos dois idiomas, sem cair na própria chave; interpolação); `test/prompt-service.test.ts`; casos novos em `test/smoke-home.test.ts` (pasta de iniciativas dentro do home temporário; com `LOCUM_HOME` escolhido, pasta de iniciativas dentro dele; `LOCUM_INITIATIVES_DIR` já definido respeitado nos dois ramos); caso novo em `test/entrypoint-migrations.test.ts` (migração aplica sobre banco com dados da `0004` e preserva `agents` e `runs`). Banco do módulo com `migrateDb()` para `InitiativeService`, como `test/approval-resume.test.ts:15-18`; `bancoDeTeste()` só para o que não encosta em gate nem executor.
- Aceite: testes verdes; `verify` verde; nada criado em `~/Locum` durante `npm test` e `npm run smoke` (`ls ~/Locum` antes e depois); `check:i18n` verde com a paridade ligada, e vermelho quando se apaga uma chave de um dos dicionários (conferido à mão, desfeito antes do commit).
- Nota do dicionário fora da casca: o MCP e a CLI rodam por `tsx`, que resolve o `import` de JSON; o app empacotado tem o JSON embutido pelo esbuild. Ler `locales/*.json` do disco em tempo de execução está fora, porque o caminho muda entre `tsx`, `dist/` e o `asar`.
- Armadilhas conhecidas: esquema vem de migração; nunca `db:push` em banco adotado; pasta `drizzle/` viaja como arquivo (conferir a `0005` no pacote); dois ABIs do `better-sqlite3` (`npm run build:main` se o teste reclamar).
- Commit: `feat: iniciativas no banco, com contexto em pasta local e prompts versionados`

### Fatia 3a. Escopo MCP (I1)

- `createRun` com `initiativeId`; checagem de escopo no executor como no desenho; `linkAgent`; validação no `AgentService.upsert` de agent ligado; `RunFilter.initiativeId`; `initiativeId` no `overview`.
- Testes em `test/initiative-scope.test.ts`, no banco do módulo (`migrateDb()`), com registry e runtime falsos como `test/approval-resume.test.ts`: agent global vê tudo; agent de frente com ferramenta de fora falha com `steps.error` igual a `outside_initiative`; opcional é pulado com o mesmo código; mudar o agent de frente depois não reescreve `runs.initiative_id`; retomada usa a fotografia e não o agent atual; servidor tirado da frente vale na retomada.
- Aceite: testes antigos de executor e fila com o mesmo resultado.
- Commit: `feat: agent de iniciativa só enxerga os servidores dela`

### Fatia 3b. Proposta de contexto (I1)

- `PublishConflict` e `conflict` na gate e no `settleStep`; `gate.prepare` (devolve `{ payload, mode }`) e `gate.enqueue` extraídos do `submit` sem mudar o comportamento dele; `InitiativeService` com a gate no construtor; `decide` devolvendo o estado final, com `executor.decide` na forma `{ status, run }`, as asserções de `approval-resume.test.ts:97,108` e `budget.test.ts:136` lendo `.run`, `DecisionResult` em `electron/bridge-contract.ts:37` e CLI (`cli.ts:575`) imprimindo os dois, como no desenho; motivo `rejected` e `publish_conflict` como código, com `runs.stepReason.*` nos dois dicionários e a tela de execução traduzindo; handler `context.update`; `seedSystemAgents()` síncrono no `migrateDb`; ocultação e recusa no `AgentService`, nos gatilhos, no `ExecutionService.start`, no `rerunStep`, em métricas, health e reconciliação; `InitiativeService.proposeContextUpdate`.
- Testes no banco do módulo:
  - `test/context-update.test.ts`: proposta cria run `paused`, passo `propose` já `awaiting_approval` e pendência `pending`, na frente certa; aprovar `append` anexa ao texto atual mesmo com edição externa no meio; aprovar `replace` grava e atualiza hash; `replace` com arquivo mudado fecha como `conflict`, passo `skipped` com `publish_conflict`, run `done`, arquivo intacto, e `executor.decide` devolve `{ status: "conflict", run: "done" }`; `publish` repetido (retomada) não duplica nem falha; erro comum no `publish` deixa `pending` e `rejected` ainda fecha; run da proposta nasce com `startedAt` preenchido, e depois de aprovar e de rejeitar o `usage_daily` não tem linha de `locum-context`.
  - Crash na proposta, no mesmo arquivo: com `gate.enqueue` trocado por um que lança depois de o run e o passo entrarem na transação, `proposeContextUpdate` rejeita e o banco não tem run, passo nem pendência novos; com `handler.propose` lançando, idem; `resumeAll` depois disso não devolve nada.
  - `test/system-agent.test.ts`: `locum-context` e `locum-context@1` existem depois de `migrateDb` duas vezes, com uma linha de cada; o spec semeado passa no `AgentSpec` e o passo tem `key: "propose"` e `action: "context.update"`; não aparece em `list`, `overview`, `budgets`; `duplicate`, `exportSpec`, `upsert`, `saveEdited`, `setBudget` e `importSpec` recusam o id; `locum-context` de usuário preexistente não ganha a versão `locum-context@1` e a proposta falha com mensagem clara.
  - `test/reserved-agent-guard.test.ts`: `TriggerService.set` e `setEnabled`, `ExecutionService.start` e `RunService.rerunStep` recusam o agent reservado; `MetricsService` não devolve linha dele mesmo com run e achado plantados; a contagem de agents do `health` não o inclui; a varredura da reconciliação não pega run `paused` dele.
  - Caso novo em `test/entrypoint-migrations.test.ts`: dois `migrateDb` seguidos sobre o mesmo arquivo, como Electron e MCP subindo juntos, não falham e deixam uma linha de agent e uma de versão.
- Aceite: nenhum caminho grava no `context.md` sem pendência aprovada; nenhuma pendência de contexto fica presa; nenhuma proposta deixa run sem pendência; testes antigos de fila (`approval-resume`, gate) com o mesmo resultado; `check:i18n` verde.
- Armadilhas conhecidas: `migrateDb` é síncrono, então a semeadura não pode usar serviço assíncrono; a transação do better-sqlite3 no drizzle recusa callback que devolve promessa, e builder sem `.run()` dentro dela não executa nada.
- Commit: `feat: contexto da iniciativa muda só por proposta aprovada`

### Fatia 4. Ferramentas MCP e chat (I1, fecha o aceite)

- `initiative-tools.ts` com `respond()` (`mcp-server/respond.ts`), registro em `server.ts`; catálogo do chat como no desenho, com o comentário do topo atualizado. Descrições em inglês.
- Testes: `test/mcp-initiative-tools.test.ts` com `InMemoryTransport.createLinkedPair()` de `@modelcontextprotocol/sdk/inMemory.js` (existe no SDK instalado, sem precedente nos testes; se não ligar, chamar os handlers registrados direto): listar, ler contexto com hash, `upsert_initiative` e `set_initiative_servers` gravam, `propose_context_update` cria pendência e não muda o arquivo. `test/chat-tools.test.ts` (novo): o catálogo tem as escritas de iniciativa e nada que decida pendência, abra sessão ou rode agent.
- Aceite (I1): só por chamadas do catálogo do chat, sem a interface, cria iniciativa, liga servidor, liga agent, põe workspace e link, grava prompt e propõe contexto; o teste do chat faz essa sequência.
- Armadilhas conhecidas: caminho do servidor no `.mcp.json`; contrato da ponte typecheca no renderer, só `import type`.
- Commit: `feat: iniciativas e prompts no servidor MCP e no assistente`

### Fatia 5a. Rota, lista e detalhe com Contexto (I2)

- Rota `initiatives`, lista, detalhe com as cinco tabs (`context` com texto e hash; as outras em leitura). Canais novos de leitura em `BRIDGE_CHANNELS` e `READ_CHANNELS` (`bridge-contract.ts:309`) com a guarda de tipo que exclui aprovação.
- Fixture genérico `app/src/fixtures/initiative.ts` (slug `example`, pasta dentro de `LOCUM_INITIATIVES_DIR`) chamado com os fixtures do smoke (`electron/main.ts:857`).
- Smoke: lista em `electron/main.ts:1066` passa a `["inbox", "initiatives", "execucoes", "agents", "configuracao"]`; checagem nova navega para `#/initiatives/example/context` e confere título e texto, depois `#/initiatives/example/agents`. A checagem de idioma existente do smoke (`electron/main.ts:948`) passa com as chaves novas.
- Aceite: smoke verde; `check:i18n` verde com toda string nova em `en` e `pt-BR`.
- Armadilhas conhecidas: roteamento por hash; smoke navega escrevendo hash; guarda de i18n olha posição.
- Commit: `feat: tela de iniciativas, com lista e detalhe`

### Fatia 6. Início e revisão de contexto (I2)

- Rótulo `nav.home`, painel a partir de `InitiativeService.overview`, fila atual embaixo, badge mantido. Revisão do tipo `context.update` como no desenho; `decidir` em `renderer/lib/aprovar.ts:32` devolve o `DecisionResult` (tipo de `electron/bridge-contract.ts:37`) e a revisão trata `conflict`; rótulo do estado `conflict` e do agent reservado no dicionário.
- Fixture planta uma proposta `replace` pendente e uma já fechada como `conflict`; smoke abre a primeira, confere o diff e, depois de o fixture mexer no arquivo, confere o aviso de contexto mudado e o aprovar desligado (sem aprovar); abre a segunda e confere o estado de conflito sem botões.
- N de "parada há N dias" é configurável: chave `initiatives.staleDays` em `settings` (padrão 7, inteiro de 1 a 90), editável na seção `geral` da Configuração, lida pelo `overview`; rótulo e ajuda nos dois dicionários.
- Teste: `test/initiative-overview.test.ts` (parada há 7 dias pelo padrão e há 3 com a chave em 3, esperando por mim, com relógio fixo; valor inválido cai no padrão).
- Aceite: `#/inbox` e `#/inbox/<id>` seguem como antes; notificações abrem a revisão; `check:i18n` verde, frases do painel nos dois idiomas.
- Commit: `feat: Início com o painel das frentes e a revisão de contexto`

### Fatia F. Fechamento do dia

- Passa a nota de armadilhas do dia para "Armadilhas encontradas" em `docs/estado-atual.md`; atualiza "O que existe e roda", "Próximos passos" e as contagens (tabelas, ferramentas MCP, entradas do chat, canais da ponte, serviços, arquivos de teste, chaves de i18n, data). `docs/roadmap.md` marca o que ficou pronto.
- Aceite: `verify` verde; nenhuma armadilha sem causa e contorno; contagens batem com `grep` no código.
- Commit: `docs: estado atual com iniciativas`

### Fatia 5b. Formulários, iniciativa atual e contexto no assistente (I2, amanhã)

- Formulário de criação e edição, ligar servidores e agents, workspaces e links, prompts na tab `actions` (copiar); pasta raiz na seção `geral`. `CurrentInitiativeProvider`, chips em Agents e Execuções, paleta (ir para iniciativa, copiar prompt), `chat.send` com `context`.
- Smoke: `#/execucoes` mostra o chip da iniciativa visitada. Teste de `chat.ts`: o prompt de sistema leva o slug e não o texto do contexto, nos dois idiomas.
- Aceite: `check:i18n` verde, formulários e chips nos dois dicionários.
- Armadilhas conhecidas: detalhe mora no hash; destino da barra guarda chave; argumento de hook por valor; prompt de sistema do assistente é texto de produto.
- Commit: `feat: iniciativa atual valendo em agents, execuções, paleta e assistente`

### Fatia 7. Abrir sessão (I3, amanhã)

- `SessionService` (`plan`, `open`, `finish`, `readHandoff`), `shellQuote`, `resolveClaudeBinary`, artefatos em `.locum/`, adaptadores Terminal e iTerm, rota `session/ended`, botões "Open session" e "Read handoff" (texto do dicionário) na tab `actions`, terminal preferido na seção `geral`, abrir sessão da atual na paleta. Template `session.prompt.*` nos dois dicionários.
- Testes: `test/session-service.test.ts`: conteúdo do `session.md` em `en` e em `pt-BR`, sem frase do outro idioma nem linha fora do que `session.prompt.*` produz (a guarda de texto cravado, já que o `check-i18n` não olha `src/`), e do `session-settings.json` (deny no `context.md`); regras do `deny` no formato `//` com o caminho absoluto da pasta; script faz `cd` no worktree e nada é criado fora da pasta de contexto (worktree de mentira intacto); injeção de shell com sentinela, nunca com `rm`: para cada nome hostil de diretório temporário (`x"; touch PWNED; "`, `$(touch PWNED)`, `` `touch PWNED` ``, `it's`), o script passa em `/bin/sh -n`, e o `cd` gerado, rodado num subshell com `cwd` num diretório vazio próprio, termina no diretório hostil e deixa `PWNED` inexistente em todo lugar que o teste olha (diretório vazio, diretório hostil, pasta temporária). O mesmo vale para título de iniciativa e slug hostis no `session.md`, que é lido por `$(cat ...)` e nunca interpolado; comando de cada terminal pelo espião; nonce de uso único; "Read handoff" vira proposta `append`. `test/claude-binary.test.ts`, com ambiente, `exec` e `access` falsos: ordem de resolução; `zsh` chamado com `-ilc`; saída `claude: aliased to ...`, nome de função e caminho relativo descartados; caminho absoluto sem `X_OK` descartado; `~/.local/bin/claude` achado quando só ele existe; nada achado devolve `undefined`. `test/deep-link-service.test.ts` (arquivo novo): rota aceita, nonce errado recusado, parâmetro extra ignorado.
- Aceite: nada abre terminal em teste nem no smoke; `context.md` fora do alcance de `Edit` e `Write` da sessão; `check:i18n` verde.
- Armadilhas conhecidas: URL do deep link é entrada de fora; deep link só com app empacotado; PATH do app aberto pelo Finder não é o do terminal.
- Commit: `feat: abrir sessão da iniciativa no terminal, e a passagem volta como proposta`

### Fatia O1. Descrições de ferramenta em inglês (pós-corte)

- Traduz para inglês as descrições e os `.describe()` das ferramentas existentes do servidor MCP (`app/src/mcp-server/config-tools.ts:30` em diante, `read-tools.ts`, `run-tools.ts`) e as descrições do catálogo do chat (`electron/chat-tools.ts`). Nomes do chat ficam (renomear é da O2). Nenhuma mudança de comportamento.
- Aceite: `grep` sem descrição em português nesses arquivos; testes e smoke verdes; `docs/mcp-server.md` com os mesmos textos.
- Commit: `chore: descrições das ferramentas do Locum em inglês`

### Fatia O2. Open source bilíngue (pós-corte)

- `README.md` em inglês; o atual vira `README.pt-BR.md`; link cruzado no topo dos dois.
- `CONTRIBUTING.md` em inglês: como rodar, `verify`, e como adicionar idioma novo (criar `app/locales/<lang>.json`, registrar na lista de idiomas, rodar `npm run check:i18n`).
- Nota de idioma (já no ADR 0004, decisão 7): docs internos, ADRs e mensagens de commit seguem em português por enquanto; identificador e código em inglês.
- Opcional, commit separado, risco baixo (rename mecânico e `verify`): renomear o que tem nome em português (`renderer/src/telas/`, `rotas.tsx`, `idioma.tsx`, `useIdioma`, `ProvedorDeIdioma`, nomes do catálogo do chat). Ids de rota existentes (`execucoes`, `configuracao`, `revisao`) só com redirecionamento do hash antigo, porque hash velho chega de notificação e janela restaurada; histórico de conversa guarda nome de ferramenta, então conferir `test/chat-history.test.ts`.
- Aceite: links dos dois READMEs resolvem; `verify` verde.
- Commit: `docs: README em inglês, versão em português e guia de contribuição`

### Fatia 9 (opcional). Presets MCP genéricos (I4)

- Presets de GitHub, Jira, Confluence e Notion: comando ou URL públicos, classe por ferramenta declarada no preset, nenhum endereço, projeto ou token de empresa. Nome e descrição do preset nos dois dicionários. Registrar e ligar à iniciativa na tab `integrations`.
- Teste: preset gera `McpServerConfig` válido (`config/types.ts:181`) sem campo de empresa; todo preset tem as chaves `en` e `pt-BR`.
- Commit: `feat: presets de servidor MCP para GitHub, Jira, Confluence e Notion`

## Critério de pronto do plano

- Mínimo de hoje: fatias 1, 2, 3a, 3b, 4, 5a, 6 e F commitadas em `main`, sem push (a 5b é de amanhã); aceite do I1 provado pelo teste do chat.
- Agent global e todo fluxo atual iguais (testes e smoke antigos verdes, exceto a lista de rotas).
- Nenhum caminho do Locum grava no contexto sem aprovação; nenhuma pendência de contexto fica presa; nada criado em worktree ou repo do workspace; nenhum teste nem smoke toca `~/Locum`.
- Todo texto visível novo nos dois dicionários; todo nome novo em inglês.
- Nenhum dado de empresa no repo.

## Perguntas abertas

- Parada há N dias configurável por `initiatives.staleDays` (decisão do usuário em 27/09).
- Status `paused` ou `done` da iniciativa não bloqueia gatilho de agent nesta rodada; follow-up se incomodar.
- Quando docs internos, ADRs e commits passam para inglês: fora desta rodada.

## Resumo para o usuário
Decisões do ADR 0004:
1. Agent pertence a no máximo uma iniciativa; o escopo MCP vem de `runs.initiative_id`, fotografado na execução.
2. Contexto em pasta local (`~/Locum/initiatives/<slug>/context.md`), atrás de `ContextStore`.
3. Prompt reutilizável é entidade própria, versionada.
4. Contexto só muda por proposta aprovada na fila, gravada numa transação por um agent de sistema oculto; conflito fecha a pendência sem publicar.
5. O chat ganha as escritas internas de iniciativa; aprovar e abrir sessão ficam só no clique.
6. Sessão no terminal por `--append-system-prompt` e `--settings` negando escrita no `context.md`; a passagem volta como proposta.
7. Nome e código novos em inglês; texto visível nos dicionários `en` e `pt-BR`.
Fatias (corte do dia: hoje 1, 2, 3a, 3b, 4, 5a, 6 e F; amanhã 5b, 7 e F; O1, O2 e 9 se sobrar):
- 1: ADR, briefing e marcos no roadmap.
- 2: esquema, pasta de contexto, iniciativas e prompts no banco.
- 3a: agent de frente só enxerga os servidores dela.
- 3b: proposta de contexto pela fila, com conflito, estado final da decisão e agent reservado.
- 4: ferramentas no MCP e no chat, fechando o aceite do I1.
- 5a: tela de iniciativas, com lista e detalhe.
- 6: Início com o painel das frentes e a revisão de contexto.
- F: estado atual e armadilhas do dia em `docs/estado-atual.md`.
- 5b: formulários, iniciativa atual, chips, paleta e contexto no assistente.
- 7: abrir sessão no terminal e ler a passagem (I3).
- O1, O2 e 9: descrições em inglês, README bilíngue e presets MCP (opcional).
Perguntas que dependem de você (de `open-questions.md`):
- (Decidido) N configurável já, na fatia 6.
- Iniciativa `paused` ou `done` deve bloquear gatilho de agent nesta rodada, ou só se incomodar no uso?
- Quando docs internos, ADRs e commits passam para inglês?
- Na O2, renomear os ids de rota em português (com redirecionamento do hash antigo) ou deixar como estão?
