# Servidor MCP do Locum

O Locum é cliente e servidor MCP ao mesmo tempo, e os dois papéis não se
misturam.

Como **cliente**, ele consome servidores cadastrados no banco (GitHub, ArgoCD,
Sonar, o que for) para dar ferramentas aos passos dos seus agents. Esse lado
mora em `app/src/mcp/`, no `McpRegistry`.

Como **servidor**, ele se expõe a assistentes externos por transporte stdio,
lendo o mesmo banco SQLite do aplicativo. Esse lado mora em
`app/src/mcp-server/`, e é o assunto deste documento.

Enquanto a interface não existe, o servidor é o que torna o produto operável de
fora: um assistente consegue configurar agent, cadastrar servidor, disparar
execução e ler achado sem passar pela linha de comando.

## Como subir

O aplicativo serve o MCP ele mesmo: `Locum --mcp` sobe sem janela, abre o cofre
pelo keychain como a janela abre, e fala stdio. Em Configuração, Conexões, o
cartão do Claude Code roda `claude mcp add --scope user locum -- <binário> --mcp`
num clique, e qualquer sessão passa a ver o servidor com as credenciais
guardadas no app, sem `GITHUB_TOKEN` exportado.

O repositório não tem mais `.mcp.json`. Ele era escopo de projeto, ganhava do
cadastro de usuário dentro do repo e subia por `node`, que não decifra o cofre
do Electron: dentro do repo, `run_agent` falhava sem token. Para subir à mão no
desenvolvimento:

```bash
cd app
npm run build
node scripts/mcp-handshake.mjs node_modules/.bin/electron dist/main.cjs
```

O exame acima também roda no fim do `npm run smoke` e do `smoke:dist`, contra o
binário empacotado.

O transporte é stdio, então **nada pode escrever em stdout**: esse é o canal do
protocolo, e um `console.log` perdido corrompe a sessão. Com `--mcp`, o
`electron/mcp-stdout.ts`, primeiro import do processo principal, desvia
`console.log` para stderr antes de qualquer módulo escrever.

O banco é o mesmo do aplicativo, em modo WAL, então este processo lê enquanto a
linha de comando escreve. Não existe cópia nem sincronização.

## O que o servidor expõe

São 185 ferramentas, todas casca fina sobre a camada de serviço em
`app/src/services/`. A regra mora no serviço, não aqui: versão de agent
continua imutável, ciclo na tabela de substituição continua recusado na
gravação, gatilho do pacote que espera a escolha de chats não liga.

O MCP tem paridade com a tela. Tudo que a janela faz por um canal da ponte
(`app/electron/bridge-contract.ts`) tem ferramenta equivalente, e o teste
`app/test/mcp-paridade.test.ts` lê os canais e falha se algum ficar sem. A
tabela canal a ferramenta mora em `app/src/mcp-server/paridade.ts`, com as
exceções e o motivo de cada uma:

| canal da tela | por que não tem ferramenta |
|---|---|
| `terminal.*` | O terminal embutido é teclado e tela ao vivo dentro da janela. Pelo MCP a sessão abre num aplicativo de terminal (`open_initiative_session`, `resume_claude_session`). |
| `chat.*` | O console da janela é o assistente da própria tela; quem fala pelo MCP já é o assistente. |
| `window.inboxTarget` | Diz para onde o último clique de notificação levou a janela. |
| `pacote.chooseFile` | Seletor de arquivo do sistema; pelo MCP o texto do pacote vai direto. |
| `mcp.mostrarOrigem` | Mostra o arquivo no Finder; o caminho já vem em `get_mcp_links`. |
| `agents.aiStatus`, `agents.aiDraft` | O rascunho com IA é a tela pedindo a um modelo; pelo MCP o cliente escreve o spec e grava com `save_agent_draft`. |
| `updates.check`, `updates.apply`, `updates.dismiss` | Baixar, trocar e adiar a atualização é do processo do app aberto; o `--mcp` é outro processo. |

Erro não vira falha de transporte. Ele volta como resultado marcado com
`isError`, com a mensagem legível, para que o modelo do outro lado consiga
corrigir a própria chamada. Falha de validação sai com o caminho de cada campo.

Segredo entra e não sai: as ferramentas que guardam token ou chave aceitam o
valor e devolvem só o estado, e toda saída passa por `redactSecrets` antes de
voltar. A redação esconde só segredo de verdade: o que está no cofre, o valor
literal de `env` e `headers` (e o argumento que segue `--api-key`, `--token` e
parecidos no comando de um servidor) que não seja referência (`${credential}`,
`{{steps.x.campo}}`). Prompt, achado e instrução passam inteiros, porque o ciclo
ler, editar e gravar de volta não pode gravar texto mutilado. O que voltou
`<oculto>` numa escrita (`save_agent_edited`, `save_automation`, `upsert_agent`,
`import_agent`, `register_mcp_server`) recupera o valor da versão que já estava,
e o que não tem original cai fora, com `hiddenWithoutValue` na resposta. O
`export_agent` sai sem o literal, só com as referências. O teste de paridade
guarda um segredo de cada tipo pelas próprias ferramentas e confere que nenhuma
leitura o devolve.

## Quem confirma cada escrita

Por decisão do usuário (15/10/2026), a confirmação de cada escrita é do cliente
MCP, e não uma trava a mais no Locum. Cada ferramenta sai com as anotações do
protocolo (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`), por tipo, definidas em `app/src/mcp-server/tool-def.ts`:

| tipo | o que faz | anotação |
|---|---|---|
| `read` | Só lê o banco ou a máquina. | leitura |
| `read-external` | Só lê, mas fala com um serviço de fora (Teams, GitHub, o provedor). | leitura, mundo aberto |
| `write` | Grava configuração interna, reversível, sem efeito fora da máquina. | escrita |
| `danger` | Apaga, sobrescreve, ou alarga o que o app faz sozinho. | destrutiva |
| `external` | Fala com serviço de fora ou abre o navegador ou o terminal, sem publicar. | escrita, mundo aberto |
| `publish` | Publica em nome da pessoa, ou liga e dispara o que age sozinho com a conta dela. | destrutiva, mundo aberto |

Ferramenta registrada sem tipo estoura na montagem do servidor (`exigirAnotacoes`).

A recomendação para o Claude Code é liberar só as de tipo `read` nas permissões
e deixar o resto perguntar a cada chamada. Por exemplo, em
`~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": ["mcp__locum__list_agents", "mcp__locum__get_agent", "mcp__locum__list_runs", "mcp__locum__get_run"]
  }
}
```

A lista inteira das de leitura está na tabela abaixo, na coluna tipo. Liberar
`mcp__locum` inteiro tira a pergunta de decidir aprovação, ligar gatilho e
guardar segredo, e não é recomendado.

## Ferramentas

| ferramenta | tipo | canal da tela |
|---|---|---|
| `locum_health` | read | só MCP |
| `list_agents` | read | `agents.list` |
| `get_agent` | read | `agents.get`, `agents.versions` |
| `list_runs` | read | `runs.list` |
| `get_run` | read | `runs.get` |
| `list_findings` | read | `runs.findings` |
| `get_metrics` | read | `metrics.report` |
| `list_mcp_servers` | read | `mcp.list` |
| `get_provider_limits` | read | `limites.overview` |
| `refresh_provider_limits` | external | `limites.refresh` |
| `set_provider_budget` | write | `limites.setBudget` |
| `set_limits_config` | write | `limites.setConfig` |
| `list_providers` | read | `providers.list`, `providers.fallbacks`, `providers.preview` |
| `get_machine_profile` | read | `machine.profile` |
| `upsert_agent` | danger | só MCP |
| `register_mcp_server` | danger | só MCP |
| `test_mcp_server` | external | `mcp.test` |
| `list_server_tools` | external | `mcp.tools` |
| `set_model_fallback` | write | só MCP |
| `set_budget` | write | só MCP |
| `set_trigger` | write | `triggers.set` |
| `list_findings_by_run` | read | `runs.findingsByRun` |
| `run_agent` | publish | `runs.start` |
| `rerun_step` | publish | `runs.rerunStep` |
| `list_initiatives` | read | `initiatives.list` |
| `get_initiative` | read | `initiatives.detail` |
| `read_initiative_context` | read | `initiatives.context` |
| `list_prompts` | read | `prompts.list` |
| `get_prompt` | read | só MCP |
| `upsert_initiative` | write | `initiatives.upsert` |
| `set_initiative_status` | write | `initiatives.setStatus` |
| `set_initiative_servers` | danger | `initiatives.setServers` |
| `link_agent_to_initiative` | danger | `initiatives.linkAgent` |
| `set_initiative_workspace` | write | `initiatives.setWorkspaces` |
| `add_initiative_link` | write | `initiatives.addLink` |
| `upsert_prompt` | write | só MCP |
| `propose_context_update` | write | só MCP |
| `get_initiatives_overview` | read | `initiatives.overview` |
| `list_initiative_deliveries` | read | `initiatives.deliveries` |
| `get_initiative_settings` | read | `initiatives.staleDays`, `initiatives.root` |
| `set_initiative_stale_days` | write | `initiatives.setStaleDays` |
| `set_initiatives_root` | write | `initiatives.setRoot` |
| `remove_initiative_link` | write | `initiatives.removeLink` |
| `suggest_library_id` | read | `library.suggestId` |
| `describe_steps` | read | `actions.describe` |
| `list_library_agents` | read | `library.profiles` |
| `get_library_agent` | read | `library.profile`, `library.profileVersions` |
| `upsert_library_agent` | danger | `library.saveProfile` |
| `list_toolsets` | read | `library.toolsets` |
| `upsert_toolset` | danger | `library.saveToolset` |
| `remove_library_agent` | danger | `library.removeProfile` |
| `remove_toolset` | danger | `library.removeToolset` |
| `list_automations` | read | só MCP |
| `get_automation` | read | `automations.get` |
| `list_triggers` | read | `triggers.list`, `triggers.lastError` |
| `list_trigger_discards` | read | `triggers.discards` |
| `get_trigger_schedule` | read | `triggers.schedule` |
| `suggest_automation_id` | read | `automations.suggestId` |
| `preview_github_trigger` | read-external | `triggers.previewGithub` |
| `save_automation` | danger | `automations.save` |
| `set_automation_enabled` | publish | `automations.setEnabled` |
| `set_trigger_enabled` | publish | `triggers.setEnabled` |
| `remove_trigger` | danger | `triggers.remove` |
| `allow_all_chats_for_trigger` | danger | só MCP |
| `run_automation_now` | publish | `automations.runNow` |
| `tick_triggers` | publish | `triggers.tick` |
| `list_connections` | read | `connections.list` |
| `get_connection_usage` | read | `connections.usage` |
| `connect_connection` | external | `connections.connect` |
| `disconnect_connection` | danger | `connections.disconnect` |
| `add_custom_connection` | external | `connections.addCustom` |
| `enable_github_mcp_server` | write | `connections.ligarServidorDoGithub` |
| `get_github_status` | read | `github.status` |
| `save_github_token` | write | `github.save` |
| `forget_github_token` | danger | `github.forget` |
| `check_github` | read-external | `github.check` |
| `list_gh_accounts` | read | `github.ghAccounts` |
| `use_gh_account` | write | `github.useGh` |
| `get_claude_code_status` | read | `claudeCode.status` |
| `connect_claude_code` | danger | `claudeCode.connect` |
| `get_opencode_status` | read | `opencode.status` |
| `connect_opencode` | danger | `opencode.connect` |
| `list_claude_account_connectors` | read-external | `claudeAccount.list` |
| `list_claude_import` | read | `claudeImport.list` |
| `list_claude_import_origins` | read | `claudeImport.origins` |
| `apply_claude_import` | write | `claudeImport.apply` |
| `list_grafana_instances` | read | `grafana.list` |
| `save_grafana_instance` | write | `grafana.save` |
| `remove_grafana_instance` | danger | `grafana.remove` |
| `get_credentials_overview` | read | `credentials.overview` |
| `get_slack_app` | read | `connections.slackApp` |
| `open_slack_manifest` | external | `connections.openSlackManifest` |
| `connect_slack` | external | `connections.connectSlack` |
| `disconnect_slack` | danger | `connections.disconnectSlack` |
| `get_slack_config` | read | `slack.get` |
| `set_slack_source` | write | `slack.setSource` |
| `add_slack_channel` | write | `slack.addChannel` |
| `remove_slack_channel` | write | `slack.removeChannel` |
| `get_teams_app` | read | `connections.teamsApp` |
| `get_teams_mcp` | read | `connections.teamsPeloMcp` |
| `use_claude_teams_server` | publish | `connections.usarTeamsDoClaude` |
| `connect_teams` | external | `connections.connectTeams` |
| `teams_admin_consent` | external | `connections.teamsAdminConsent` |
| `set_teams_channels` | write | `connections.setTeamsChannels` |
| `disconnect_teams` | danger | `connections.disconnectTeams` |
| `list_teams_chats` | read-external | `connections.teamsChats` |
| `list_teams_channels` | read-external | `connections.teamsChannels` |
| `list_trackers` | read | `trackers.list` |
| `register_tracker` | write | `trackers.register` |
| `remove_tracker` | danger | `trackers.remove` |
| `set_tracker_enabled` | write | `trackers.setEnabled` |
| `set_tracker_project` | write | `trackers.setProject` |
| `save_tracker_secret` | write | `trackers.saveSecret` |
| `forget_tracker_secret` | danger | `trackers.forgetSecret` |
| `test_tracker` | read-external | `trackers.test` |
| `list_tracker_projects` | read-external | `trackers.projects` |
| `list_pending_approvals` | read | `approvals.listPending` |
| `list_stuck_approvals` | read | `approvals.listStuck` |
| `get_approval` | read | `approvals.get` |
| `edit_approval_findings` | write | `approvals.update` |
| `edit_approval_text` | write | `approvals.updateText` |
| `propose_tracker_issue` | write | `approvals.createTrackerIssue` |
| `decide_approval` | publish | `approvals.decide` |
| `settle_stuck_approval` | danger | `approvals.settleStuck` |
| `preview_package` | read | `pacote.preview` |
| `export_package` | read | `pacote.exportFile` |
| `import_package` | danger | `pacote.import` |
| `list_agent_budgets` | read | `agents.budgets` |
| `get_agents_overview` | read | `agents.overview` |
| `save_agent_edited` | danger | `agents.saveEdited` |
| `duplicate_agent` | write | `agents.duplicate` |
| `export_agent` | read | `agents.exportFile` |
| `import_agent` | danger | `agents.importFile` |
| `save_agent_draft` | write | `agents.aiSave` |
| `list_agent_templates` | read-external | `agents.templates` |
| `install_agent_template` | write | `agents.importTemplate` |
| `install_reply_agent` | write | `agents.installReply` |
| `agent_chat_state` | read | `agentChat.state` |
| `agent_chat_send` | external | `agentChat.send` |
| `agent_chat_decide` | publish | `agentChat.decide` |
| `agent_chat_cancel` | write | `agentChat.cancel` |
| `agent_chat_reset` | danger | `agentChat.reset` |
| `list_registered_providers` | read | `providers.registered` |
| `register_provider` | write | `providers.register` |
| `set_provider_enabled` | write | `providers.setEnabled` |
| `remove_provider` | danger | `providers.remove` |
| `get_provider_credentials` | read | `providers.credentials` |
| `save_provider_secret` | write | `providers.saveSecret` |
| `forget_provider_secret` | danger | `providers.forgetSecret` |
| `check_provider` | read-external | `providers.checkSecret` |
| `list_provider_models` | read-external | `providers.models` |
| `list_all_models` | read-external | `providers.allModels` |
| `get_ollama_url` | read | `providers.ollamaUrl` |
| `set_ollama_url` | write | `providers.setOllamaUrl` |
| `list_model_prices` | read | `providers.prices` |
| `set_model_price` | write | `providers.setPrice` |
| `remove_model_price` | write | `providers.removePrice` |
| `set_mcp_server_enabled` | danger | `mcp.setEnabled` |
| `set_mcp_server_credential` | write | `mcp.setCredential` |
| `get_mcp_usage` | read | `mcp.usage` |
| `get_mcp_links` | read | `mcp.vinculos` |
| `accept_mcp_origin` | danger | `mcp.aceitarOrigem` |
| `keep_mcp_previous` | write | `mcp.manterAnterior` |
| `unlink_mcp_server` | write | `mcp.desvincular` |
| `list_cached_server_tools` | read | `mcp.toolsCached` |
| `list_claude_sessions` | read | `claudeSessions.list` |
| `mark_claude_session_done` | write | `claudeSessions.markDone` |
| `reopen_claude_session` | write | `claudeSessions.reopen` |
| `resume_claude_session` | external | `claudeSessions.resume` |
| `open_initiative_session` | external | `sessions.open` |
| `list_initiative_sessions` | read | `sessions.list` |
| `read_session_handoff` | write | `sessions.readHandoff` |
| `close_initiative_session` | write | `sessions.close` |
| `get_session_terminal` | read | `sessions.terminal`, `sessions.installedTerminals` |
| `set_session_terminal` | write | `sessions.setTerminal` |
| `get_working_hours` | read | `scheduler.getWorkingHours` |
| `set_working_hours` | write | `scheduler.setWorkingHours` |
| `get_startup` | read | `startup.get` |
| `set_startup` | write | `startup.set` |
| `get_language` | read | `i18n.state` |
| `set_language` | write | `i18n.setPreference` |
| `get_update_settings` | read | `updates.state` |
| `set_updates_enabled` | write | `updates.setEnabled` |
| `get_app_version` | read | `app.version` |
| `list_skills` | read | `skills.list` |

Algumas ferramentas antigas mantêm o teto de quem grava como agent, e a tela tem
a versão que grava como pessoa:

- `upsert_agent` rebaixa para `approve` o passo de ação que chega em `draft` ou
  `auto` e mudou desde a versão anterior; `save_agent_edited` e
  `save_automation` gravam como a tela.
- `set_budget` só baixa ou acrescenta teto; subir é por `save_agent_edited`.
- `register_mcp_server` grava desligado; ligar é `set_mcp_server_enabled`.
- `set_trigger` não liga; ligar é `set_trigger_enabled`.
- `upsert_agent` ainda recusa escrita pela conta Claude em passo de modelo
  (escrita externa vai como passo de ação); ferramenta nova de servidor `write`
  entra como na tela.

Gravam como a tela, sem recusa, e por isso são `danger`:
`set_initiative_servers` e `link_agent_to_initiative` (ampliam o que os agents
já ligados alcançam), `upsert_library_agent` e `upsert_toolset` (adicionam
ferramenta de escrita), e `register_mcp_server` (pode baixar um servidor de
`write` para `read`). Quem confirma é o cliente, pela anotação.

O chat de agent (`agent_chat_*`) só existe com o servidor subido pelo binário do
Locum (`--mcp`), que entrega o processo do chat; pelo `npm run mcp` as
ferramentas respondem dizendo isso.

## Execução

Nenhuma ferramenta de execução espera o pipeline terminar por padrão. Uma
execução completa leva minutos e estoura o tempo de espera do cliente, então o
identificador volta na hora e o andamento sai por `get_run`. Quem quiser
bloquear pede `wait`.

## Aprovação pelo MCP

`decide_approval` decide a fila pela mesma gate do executor que a tela usa, a
porta única do [ADR 0002](adr/0002-camada-de-servico-e-servidor-mcp.md). Ela é
do tipo `publish`: o Claude Code pergunta antes de cada chamada, e é essa
pergunta que mantém a invariante de que nada sai no nome de quem usa sem a
pessoa ter dito que sai.
