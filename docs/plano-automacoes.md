# Plano: Apps e Automações

Escrito em 3 de outubro de 2026, a partir do teste do Slack: criar o app,
conectar e depois achar onde dizer "este canal acorda este agent" levou a pessoa
por quatro telas (Conexões, Configuração → Slack, Agents, gatilho do agent), e
nenhuma delas mostrava o fluxo inteiro.

## O que muda para quem usa

Duas palavras novas na barra lateral, no lugar de quatro lugares espalhados.

**Apps** é a vitrine do que o Locum sabe usar: Slack, Teams, Jira, GitHub,
Linear, Notion e os servidores MCP próprios. Cada app tem um único botão de
ligar, um "Testar" que diz se a conexão responde, e a lista do que ele oferece
para uma automação: gatilhos (mensagem nova num canal do Slack, menção no
Teams, pull request no GitHub) e ações (responder na thread, abrir tarefa no
Jira, comentar no pull request). Conexão volta a ser só a conta ligada. Canal,
filtro e destino saem dela e vão para a automação que usa.

**Automações** é onde o fluxo é montado, num canvas. À esquerda, os
componentes dos apps ligados; no meio, os nós ligados por setas; à direita, a
configuração do nó escolhido. O exemplo que motivou tudo fica assim:

    [Slack: mensagem no #canal-x] → [IA: analisa] → [Jira: abre tarefa] → [Slack: responde na thread]

Gatilhos possíveis no primeiro corte: manual (botão "Executar agora"),
relógio (a cada N minutos ou expressão cron), mensagem em canal do Slack,
menção e mensagem direta no Slack e no Teams, pull request no GitHub.

## O que não muda

**O motor.** Uma automação é um agent mais os gatilhos dele. O agent já é um
grafo de passos com `needs` desde o ADR 0001, o executor já anda por ordem
topológica e retoma do passo onde parou, a fila de aprovação já segura toda
escrita externa. O canvas edita o mesmo `AgentSpec` e a mesma tabela de
gatilhos que a lista editava. Execução, custo, orçamento, versão imutável e
histórico continuam onde estão.

**Nada sai sem clique.** Nó de ação nasce em modo `approve` e para na fila.
O canvas mostra isso no próprio nó ("só com clique"), como o grafo de execução
já mostra.

**Gatilho nasce desligado.** Montar e salvar uma automação não acorda nada.
Ligar é um clique de uma pessoa, como hoje.

## Por que não Node-RED, n8n ou Workflow SDK

Avaliados antes de decidir:

- **Workflow SDK da Vercel** (`"use workflow"` / `"use step"`) resolve
  durabilidade de passo, que o executor já resolve com a tabela `steps`. Ele
  pede um "world" de persistência e foi desenhado para servidor; trazer para
  dentro do Electron trocaria um motor testado por um que precisaria de
  adaptador para o SQLite local.
- **Node-RED** traz servidor HTTP e editor próprios. Embutir é rodar um segundo
  produto dentro do primeiro, com outra noção de credencial e de aprovação.
- **n8n** é o produto inteiro que a ideia descreve, com licença que não é
  aberta para embutir.
- **React Flow** (`@xyflow/react`) já está no projeto, já desenha o grafo de
  execução e é o que o Node-RED novo, o n8n e o Langflow usam por baixo. É o
  que fica.

O que este plano revisa: o canvas foi recusado três vezes
(`decisoes-da-conversa.md`) porque os pipelines eram cadeias curtas editadas
por quem escreveu o Locum. A automação de agora tem gatilho, ramificação e
quatro apps diferentes, e quem monta não quer ler JSON. A lista continua
existindo como visão alternativa do mesmo spec.

## Fatias

Cada fatia sai com typecheck, suíte, verify e release próprios.

1. **Motor dos gatilhos novos.** `manual` (sem relógio, só o botão),
   `schedule` com `cron` além de `everyMinutes`, e `slack-channel`, que leva os
   canais no próprio gatilho em vez do cadastro global do Slack. `AgentSpec`
   ganha `layout` opcional com a posição de cada nó, para o canvas não
   rearrumar o desenho a cada abertura. Serviço `automations` que lista agent
   com gatilhos e último run, e grava spec e gatilhos juntos.
2. **Apps.** A tela Conexões sai de dentro da Configuração e vira destino
   próprio, com "Testar" em cada app ligado e a lista de gatilhos e ações que
   ele oferece.
3. **Automações: lista e canvas.** Lista com nome, gatilhos, último run e
   interruptor. Detalhe com o canvas editável, a paleta de componentes por app
   e o painel do nó. "Executar agora" no topo.
4. **Modelos e arrumação.** "Nova automação" oferece modelos prontos (Slack →
   IA → responde; Slack → IA → Jira → responde; relógio → resumo). Agents sai
   da barra lateral, e o editor em lista passa a ser aberto de dentro da
   automação.

## Riscos

- **Gatilho de canal do Slack duplicado.** O cadastro global de canais
  (`slack.watch`) e o gatilho `slack-channel` podem observar o mesmo canal. O
  evento é deduplicado pela chave da mensagem e o `runsFor` deduplica por
  gatilho, então o pior caso é dois agents diferentes rodando sobre a mesma
  mensagem, que é o que a pessoa pediu ao montar duas automações.
- **Cron com o Mac dormindo.** O agendador anda por cursor. Para cron, o
  próximo disparo é a primeira ocorrência depois do último disparo; acordar
  depois de várias ocorrências perdidas dispara uma vez só.
- **Canvas grava spec inválido.** O canvas monta o spec e manda pelo mesmo
  `saveEdited`, que valida com zod e recusa ciclo. O erro aparece no painel,
  e nada é gravado pela metade.

## Revisão 2: peças reutilizáveis

As quatro fatias acima saíram (v0.1.39). Usando, ficou claro que cada peça
misturava duas funções: o app guardava o que observar, e o passo de IA levava
prompt, modelo e ferramentas dentro dele, sem como reaproveitar. A revisão
separa em quatro peças, cada uma com um dono só.

- **Apps.** Conectar, testar e mostrar o que o app oferece. Nenhuma
  configuração de uso: canal, menção e filtro moram no gatilho. Já feito.
- **Agents (biblioteca).** Uma especialidade reutilizável: nome, descrição,
  contexto (o que ele sabe do time), modelo, temperatura quando o provedor
  aceita, instruções e toolsets. Não tem gatilho nem passo. Tem versão, como o
  fluxo. Exemplos: "chamados", "parcerias", "revisor de PR".
- **Toolsets.** Conjunto nomeado de ferramentas que vários agents usam. Uma
  ferramenta é sempre um `ToolRef` (servidor MCP e nome), e as nativas do
  Locum entram como mais um servidor MCP, o `locum-ferramentas`, servido pelo
  próprio binário. Assim o runtime do Claude Code e o nativo enxergam igual, e
  toolset não precisa de caso especial.
- **Automações.** Só o fluxo. Quatro tipos de nó: gatilho (por app), agent
  (escolhe um da biblioteca e escreve a tarefa daquele passo), ação (por app)
  e lógica (if, switch, transformar, formatar).

### Decisões

- **Sem limite de ferramenta, com uma regra que fica.** Agent lê qualquer
  coisa: qualquer ferramenta de leitura de qualquer MCP, HTTP GET para
  qualquer host, JSON. O que escreve fora (mandar mensagem, abrir tarefa,
  POST para uma API) é nó de ação no fluxo, e não ferramenta do agent. O nó de
  ação nasce em "aprovar" e pode virar "automático" por passo. Isso mantém a
  regra do `McpRegistry.toolsFor` (escrita externa não entra como ferramenta)
  sem limitar o que o fluxo faz: tudo que o agent faria escrevendo, o fluxo faz
  num nó de ação depois dele.
- **Ação de app genérica.** Além das ações com tela própria (responder no
  Slack, reagir com emoji, abrir tarefa), todo app conectado oferece "chamar
  ferramenta": qualquer ferramenta de escrita do MCP dele, com os argumentos
  montados por template (`{{steps.analisar.titulo}}`). É o que deixa "fazer
  literalmente tudo" sem esperar o Locum ter um nó para cada coisa.
- **HTTP.** Nó de ação `http.request`, qualquer host e método, cabeçalho e
  corpo por template. Segredo de cabeçalho vem do cofre por referência, nunca
  escrito no spec.
- **Agent referenciado, com foto no run.** O passo guarda o id do agent. Ao
  começar o run, a versão do agent é resolvida e gravada no passo, para um run
  antigo continuar dizendo com que instruções rodou.
- **Lógica é determinística.** If, switch, texto para JSON e de volta, montar
  mensagem do Slack (mrkdwn ou Block Kit) e cartão do Teams não chamam
  modelo. Ramificação: o nó de if tem duas saídas, e um passo cujo caminho não
  foi escolhido fica "pulado", assim como tudo depois dele.
- **Iniciativa.** O agent do fluxo já tem `initiativeId`; a iniciativa ganha a
  aba Automações com as dela.

### Fatias

5. **Biblioteca de agents e toolsets.** Tabelas `agent_profiles` (com versões)
   e `toolsets`. Passo `model` ganha `profile` opcional: presente, modelo,
   instruções, temperatura e ferramentas vêm do agent, e o `prompt` do passo
   vira a tarefa. Tela Agents volta para a barra como biblioteca; o canvas
   ganha o nó "Agent". Os passos de IA que já existem continuam rodando como
   estão (agent embutido), e o painel oferece "transformar em agent da
   biblioteca".
6. **Ações por app e chamada genérica.** Catálogo de ações por app (Slack:
   mensagem, thread, reação; Jira: criar, comentar, transição; GitHub:
   comentário) e o nó "chamar ferramenta" para o resto. `http.request`.
7. **Lógica.** If e switch com ramificação no executor, transformar JSON,
   formatadores de Slack e Teams.
8. **Ferramentas nativas.** Servidor `locum-ferramentas` com HTTP GET, JSON e
   agent-to-agent (um agent consulta outro da biblioteca, só leitura).
9. **Iniciativa com automações.**

As cinco fatias da revisão 2 saíram entre a v0.1.40 e a v0.1.46.
