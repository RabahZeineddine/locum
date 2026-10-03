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
