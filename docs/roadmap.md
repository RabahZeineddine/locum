# Roadmap

Ordem revisada pelo ADR 0002: o servidor MCP vem antes da interface, porque é o
que torna o produto configurável enquanto não há tela.

## Pendências pequenas do núcleo

Absorvidas pelos marcos abaixo e prontas: o cadastro de servidores MCP vem do
banco (`mcp-service.ts`), o reconciliador de review humano e as métricas têm
serviço próprio (`reconcile-service.ts`, `metrics-service.ts`), e o agendador
escuta suspensão e retomada da máquina, conferido no smoke.

## M1, camada de serviço

`AgentService`, `McpService`, `ProviderService`, `RunService` e
`ApprovalService`. Linha de comando passa a ser casca fina.

Pronto quando a linha de comando não tiver mais nenhuma regra de cadastro e o
`demo` continuar passando.

Estimativa: um fim de semana.

## M2, servidor MCP próprio

Transporte stdio sobre o mesmo banco. Ferramentas de leitura, configuração e
execução. Aprovação e publicação ficam de fora, por decisão do ADR 0002.

Pronto quando um assistente externo conseguir cadastrar um servidor MCP, montar
um agent e disparar uma execução sem tocar no código.

Estimativa: um fim de semana.

## M3, casca Electron

Processo principal carregando o núcleo, bandeja, início automático,
`powerMonitor`, `safeStorage` para credencial, notificação com ação, deep link
para OAuth.

Pronto quando o aplicativo ficar na bandeja, sobreviver ao sono da máquina e
notificar uma pendência.

Estimativa: um a dois fins de semana.

## M4, interface

Construída sobre AI Elements, por decisão do ADR 0003. Quatro telas: inbox,
execuções, agents, configuração. Mais o chat interno, que opera o produto pela
mesma camada de serviço que o servidor MCP usa.

A tela de execuções aproveita as famílias de código e raciocínio: chamada de
ferramenta com entrada e saída, destaque de sintaxe, stack trace, streaming. O
grafo da execução, somente leitura, sai barato porque o passo já declara `needs`.

Aprovação aparece como botão renderizado, nunca como ferramenta invocável pelo
modelo, porque o assistente lê conteúdo não confiável.

Pronto quando der para aprovar um achado sem abrir o terminal, e pedir ao chat
que crie um agent novo.

Estimativa: dois a três fins de semana, possivelmente menos com os componentes
prontos.

## M5, empacotamento

`electron-builder`, ícone, `.dmg`. Módulo nativo recompilado para o runtime do
Electron. Assinatura e notarização ficam condicionadas a conta de desenvolvedor
Apple; sem ela o aplicativo roda com aviso na primeira abertura e a atualização
automática não funciona.

Pronto quando existir um `.dmg` que instala e abre em uma máquina limpa.

Estimativa: um fim de semana, mais o tempo da conta Apple se você quiser
assinatura.

## Iniciativas

A partir do ADR 0004: a iniciativa como unidade de trabalho acima do agent, com
contexto, workspaces, integrações MCP, agents, prompts e links próprios.

**I1, núcleo. Pronto em 27/09.** Esquema, `ContextStore`, escopo MCP por
`runs.initiative_id`, contexto que só muda por proposta aprovada na fila,
agent de sistema `locum-context`, ferramentas no servidor MCP e no chat. O
chat interno cria e configura uma iniciativa completa.

**I2, interface. Pronto em 27/09.** Rota de iniciativas com lista e detalhe
(contexto, agents, integrações, execuções, ações), formulários de criação e
edição, painel de iniciativas no Início, revisão do tipo `context.update` com
diff e aviso de conflito, `staleDays` configurável, iniciativa atual com chips
em agents e execuções, paleta e assistente cientes da iniciativa.

**I2b, redesenho visual.** Depois de dias de uso, a partir de capturas reais da
interface do I2. Sem data.

**I3, sessão. Pronto no código em 27/09, falta o teste à mão.** Abrir sessão no terminal (Terminal ou iTerm) com o contexto da
iniciativa por `--append-system-prompt` e `--settings` negando escrita em
`context.md`, e a passagem de volta como proposta de contexto. O fim da sessão volta por
`locum://session/ended`, que só funciona com o app empacotado.

**I4, presets MCP genéricos.** GitHub, Jira, Confluence e Notion como preset
público, sem endereço, projeto ou token de empresa, ligados à iniciativa pela
tab de integrações. Coberto pela vitrine de conexões, que traz GitHub,
Atlassian (Jira e Confluence), Notion, Linear e outros com endereço público e
OAuth de um clique.

**I5, uso real.** Ajustes a partir do uso do dia a dia: se status `paused` ou
`done` da iniciativa deve bloquear gatilho de agent, e o que mais o uso pedir.

## Open source bilíngue

Fatias O1 e O2, fora do caminho crítico de I1 a I3.

**O1.** Descrições das ferramentas existentes do servidor MCP e do catálogo do
chat traduzidas para inglês, sem mudança de comportamento. Pronto em 02/10: as descrições de ferramenta e de parâmetro estão em
inglês; as mensagens de erro seguem em português.

**O2.** `README.md` em inglês, o atual como `README.pt-BR.md`, e
`CONTRIBUTING.md` com o passo a passo de rodar, verificar e adicionar idioma
novo. README e CONTRIBUTING em inglês prontos em 01/10, com as versões em
português ao lado (`README.pt-BR.md`, `CONTRIBUTING.pt-BR.md`); o rename de
identificadores segue opcional. Opcional: renomear identificadores em português do código, com
redirecionamento do hash antigo para os ids de rota que mudarem
(`execucoes`, `configuracao`, `revisao`).

## Depois do aplicativo

**Radar de Slack e Teams.** Digest em vez de notificação item a item. Depende de
acesso corporativo, que não é risco técnico. A fonte por consulta a MCP existe
para o caso de o registro de aplicativo não sair. É o teste do desenho: se este
watcher entrar sem tocar no núcleo, a arquitetura está certa.

**Incidente.** Alarme do New Relic como gatilho determinístico, com o agent
entrando depois para correlacionar deploy, trace e pull request recente.

**Adaptador `codex exec`.** Plano ChatGPT como terceira via, para a máquina sem
assinatura Claude. Pronto no código em 02/10, falta o teste com o binário de
verdade: o provedor `codex` aparece quando `codex login status` sai com zero, o
passo roda com `--ignore-user-config`, `--ephemeral` e `--sandbox read-only` numa
pasta temporária, os servidores do passo entram por `-c mcp_servers.*` com as
ferramentas marcadas em `enabled_tools`, e o modelo `codex/default` deixa a
escolha com o plano. O formato do JSONL e das flags veio do código-fonte do
Codex, não de uma execução.

**Credencial de sessão web e extensão de navegador.** Há uma classe de MCP que
não usa aplicativo aprovado e sim a sessão do navegador, porque o registro de
aplicativo não sai: sistema interno de empresa, sem OAuth aberto a terceiros.

Tecnicamente eles rodariam hoje, porque são processos stdio. Mas não é assim que
entram, e por dois motivos.

O primeiro é portabilidade. Cadastrar um servidor como caminho absoluto para uma
pasta de desenvolvimento de uma máquina não é configuração de aplicativo, é
gambiarra que só funciona em um computador. Servidor entra por referência
portátil, resolvida na instalação: pacote publicado executado por `uvx` ou `npx`,
ou instalação gerenciada pelo próprio Locum. Qual das duas fica para quando esta
frente for construída.

O segundo é ciclo de vida. Sessão web expira, e o
servidor passa a falhar em silêncio no meio de uma execução. Três coisas
resolvem, em ordem de valor:

1. **Estado de credencial no cadastro.** `testConnection` já distingue conectado
   de falho; falta guardar quando a sessão foi vista viva pela última vez, e
   marcar o servidor como precisando de autenticação em vez de deixar o passo
   quebrar. Barato, e é o que evita descobrir a expiração pelo achado que não
   veio.
2. **Renovação por deep link.** O `locum://` e o cofre do M3 já são a ponta
   receptora: uma extensão de navegador captura a sessão do domínio e entrega ao
   aplicativo por deep link, que guarda no keychain e devolve ao servidor MCP por
   variável de ambiente. Isso troca a cópia manual de cookie por um clique.
3. **Assistente de criação de MCP.** A extensão observa as chamadas que a página
   faz e propõe um servidor MCP a partir delas. É a parte mais cara e a menos
   necessária: gerar o servidor uma vez é trabalho de uma tarde, e renovar a
   credencial é trabalho de toda semana.

O item 1 está pronto desde 01/10: toda conexão, de teste ou de execução, grava
`last_ok_at` ou `last_failure_at` e `last_error` em `mcp_servers`, e a linha do
servidor na configuração mostra "respondeu há X", "falhou há X" ou o selo
"precisa autenticar" quando a falha mais recente é de credencial.

Dois cuidados que essa frente carrega, e não são técnicos. Guardar sessão de
sistema corporativo num cofre lido por agent autônomo aumenta o que um erro
alcança, então esses servidores entram com escopo de leitura e a classe de
escrita externa continua valendo. E o canal entre extensão e aplicativo precisa
de emparelhamento por segredo, senão qualquer página aberta no navegador
conversa com o aplicativo.

**O resto.** Jira, deploy, watcher dos próprios pull requests. Cada um é
configuração mais uma fonte, não código novo.

## Fora de escopo, de propósito

- editor visual de nós, enquanto os pipelines forem cadeias curtas. O canvas
  do AI Elements torna isso viável depois do M4, mas a lista continua sendo o
  editor principal
- agent agindo sozinho em escrita externa sem destravamento medido
- modelo vigiando log continuamente
- multiusuário, nuvem, time
- Windows e Linux
