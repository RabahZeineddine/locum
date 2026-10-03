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

São 38 ferramentas, todas casca fina sobre a camada de serviço em
`app/src/services/`. A regra mora no serviço, não aqui, e por isso um
assistente externo não consegue contornar nenhuma delas: versão de agent
continua imutável, ciclo na tabela de substituição continua recusado na
gravação, gatilho continua nascendo desabilitado.

Erro não vira falha de transporte. Ele volta como resultado marcado com
`isError`, com a mensagem legível, para que o modelo do outro lado consiga
corrigir a própria chamada. Falha de validação sai com o caminho de cada campo,
e não com o JSON cru do zod.

### Saúde

| ferramenta | o que faz |
|---|---|
| `locum_health` | Confere que o servidor está de pé e enxergando o mesmo banco do aplicativo. Devolve identidade da máquina, caminho do banco e contagem de agents, execuções e servidores cadastrados. |

### Leitura

Nada nesta seção escreve.

| ferramenta | o que faz |
|---|---|
| `list_agents` | Agents cadastrados, com a versão mais recente e a contagem de passos de cada um. |
| `get_agent` | Um agent, o spec da versão do topo e o histórico de versões com nota e data. |
| `list_runs` | Execuções mais recentes, filtrando por status ou por agent. |
| `get_run` | Uma execução com os passos e o spec da versão que ela executou. |
| `list_findings` | Achados de uma execução, vindos da tabela ou da saída do passo que os produziu. |
| `get_metrics` | Métricas por versão de agent e o gasto diário registrado numa janela. Só lê: quem recalcula é `locum metrics` na linha de comando. |
| `list_mcp_servers` | Servidores que o Locum consome como cliente, com transporte, escopo e se estão expostos ao executor. O segredo mora no keychain e nunca passa por aqui: sai só o nome da credencial. |
| `list_providers` | Provedores de modelo desta máquina, a tabela de substituição e, se um modelo for informado, onde ele cairia. |
| `get_machine_profile` | Retrato da máquina: identidade, banco, provedores, substituições e servidores cadastrados. |

### Configuração

Toda gravação valida pelo zod do serviço, o mesmo que a linha de comando e a
interface aplicam. Um schema duplicado aqui viraria a porta larga.

| ferramenta | o que faz |
|---|---|
| `upsert_agent` | Grava um AgentSpec como versão nova e imutável. Spec idêntico ao topo devolve a versão que já existe, e spec inválido não grava nada. |
| `register_mcp_server` | Cadastra ou atualiza um servidor que o Locum vai consumir como cliente. O nome é a chave que os passos referenciam. |
| `test_mcp_server` | Sobe o servidor cadastrado, conta as ferramentas e encerra. Falha de conexão volta como resultado, não como erro, porque testar é justamente para descobrir isso. |
| `list_server_tools` | Ferramentas que um servidor expõe, com descrição e estimativa de tokens do schema, para escolher quais marcar num passo. |
| `set_model_fallback` | Grava uma substituição de modelo para a máquina. Cadeia circular é recusada na gravação. |
| `set_budget` | Ajusta o teto de gasto por execução e por dia. Como o orçamento mora no spec, isso grava versão nova. |
| `set_trigger` | Cadastra ou atualiza um gatilho do agent. Nasce desabilitado: habilitar é o passo que deixa o agent acordar sozinho. |

### Biblioteca e catálogo

Para montar automação conversando: o catálogo diz o que um fluxo pode ter, e a
biblioteca guarda agents e toolsets que os passos reutilizam. A gravação passa
pelo mesmo `libraryService` da tela. Ferramenta nova de servidor `write` é
recusada, direto no agent ou pelo toolset, como no `upsert_agent`. Remover
agent ou toolset fica para a tela.

| ferramenta | o que faz |
|---|---|
| `describe_steps` | Catálogo dos passos: modelo, ação e lógica, as operações de lógica (if, switch, conversões de JSON, formatadores de Slack e Teams), as comparações, as ações com os modos que cada uma aceita, e a sintaxe dos marcadores. |
| `list_library_agents` | Agents da biblioteca, com os fluxos que usam cada um. |
| `get_library_agent` | Um agent da biblioteca, com o spec do topo e o histórico de versões. |
| `upsert_library_agent` | Grava versão nova de um agent da biblioteca: contexto, instruções, modelo, temperatura, toolsets e ferramentas. |
| `list_toolsets` | Toolsets, com os agents que incluem cada um. |
| `upsert_toolset` | Grava um toolset. Sem versão: vale na próxima execução de todo agent que o inclui. |

### Execução

Nenhuma das duas espera o pipeline terminar por padrão. Uma execução completa
leva minutos e estoura o tempo de espera do cliente, então o identificador volta
na hora e o andamento sai por `get_run`. Quem quiser bloquear pede `wait`.

| ferramenta | o que faz |
|---|---|
| `run_agent` | Dispara um agent contra um pull request (`owner/repo#123`) ou contra o evento sintético (`sintetico`). Devolve o identificador do run. |
| `rerun_step` | Zera um passo e todos que dependem dele, e roda o run de novo a partir dali. O custo dos passos zerados sai do total. |

## Por que aprovação e publicação não estão aqui

`approve`, `reject` e qualquer ação que publique ficam fora, sem exceção. A
decisão está registrada no [ADR 0002](adr/0002-camada-de-servico-e-servidor-mcp.md).

O motivo é a invariante central do produto. Se um agent pode aprovar, o portão
deixa de existir, porque passa a ser um agent liberando a saída de outro. A
garantia de que nada sai no nome de quem usa viraria decoração: bastaria o
assistente externo disparar a execução e aprovar o resultado dela mesma, sem
ninguém ler nada no meio.

A separação que sustenta isso é entre disparar e publicar. Disparar está aqui:
o run roda, os achados ficam no banco, o custo é contabilizado. Publicar não
está: o passo de ação para na fila de aprovação e o run fica em
`awaiting_approval` até alguém decidir. Gravar configuração é reversível e
auditável, e por isso pode ser exposto. Publicar no nome de outra pessoa não é.

Aprovar continua sendo ato humano, pela bandeja, pela interface ou pela linha de
comando:

```bash
cd app
npm run dev inbox
npm run dev approve <id>
```

Uma consequência prática: uma story que peça ferramenta de aprovação no servidor
MCP é para ser recusada, não cumprida.

## Por que gravar agent tambem nao publica

Nao expor `approve` nao basta sozinho. `upsert_agent` grava o spec inteiro, e um
passo de acao carrega o modo: `approve`, `draft` ou `auto`. Gravar um passo em
`auto` e chamar `run_agent` publicaria sem clique nenhum, contornando o ADR 0002
em dois passos.

Por isso a gravacao vinda daqui tem teto. Todo passo de acao que chegue em
`draft` ou `auto` volta rebaixado para `approve`, e o rebaixamento vem declarado
no campo `downgrades` da resposta. A excecao e o passo que ja estava naquele
modo na versao anterior: significa que uma pessoa autorizou antes, pela
interface ou pela linha de comando, e reeditar outra parte do spec nao pode
derrubar essa autorizacao.

A regra que vale nao e "nao existe ferramenta de aprovar". E "nada sai sem uma
pessoa ter dito que sai".
