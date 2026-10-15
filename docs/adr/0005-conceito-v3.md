# ADR 0005: conceito v3, cada tela com uma ideia só

Data: 14/10/2026
Status: proposto
Complementa: ADR 0004 (iniciativas)

## Contexto

O Locum cresceu por funcionalidade e as ideias se misturaram. Hoje a automação é
gravada como agent (um `AgentSpec` com passos de IA embutidos), a lista de
Automações tem uma aba "Meus Agents", o agent de verdade (instruções e
ferramentas) mora na Biblioteca como "perfil", e o mesmo gatilho do GitHub era
configurado em dois lugares. Quem abre o app pela primeira vez não sabe onde
começa uma coisa e termina a outra, e as telas não explicam o que respondem.

A comparação com ferramentas parecidas (n8n, Node-RED, Windmill, Dify, Kestra,
OpenHands, PR-Agent) mostrou que o diferencial do Locum continua valendo: app
local, gatilhos de PR, Slack e Teams, aprovação humana e orçamento no mesmo
lugar. O que falta é a montagem de fluxo que essas ferramentas têm e um
vocabulário que não se sobreponha.

## Princípio

O Locum entrega mecanismo, não política. Autonomia, aprovação, o que um agent
pode usar e o que um orquestrador pode fazer sozinho são configurados por quem
monta. O app traz o padrão conservador e avisa quando algo sai em nome da pessoa
sem revisão, mas não decide no lugar dela.

## Decisões

### 1. Automação é um fluxo montado com nós

Canvas de arrastar e soltar, no espírito do n8n e do Node-RED. A paleta separa os
nós por categoria:

- **Gatilhos**: pull request, Slack, Teams, horário, intervalo, webhook, manual,
  consulta a servidor MCP.
- **Agents**: chama um agent com uma entrada montada a partir dos nós anteriores.
- **Ações de app**: comentar no PR, postar no Slack ou no Teams, abrir card ou
  issue.
- **Ferramentas**: chamada a ferramenta MCP, chamada HTTP.
- **Lógica**: condição, ramos, transformação, espera.
- **Aprovação**: etapa manual que para o fluxo na Fila até alguém decidir.

A aprovação é um nó como os outros: quem monta escolhe onde ela entra. O editor
mostra um aviso, sem bloquear, quando uma ação que publica em nome da pessoa não
tem aprovação antes dela. Os templates do marketplace já vêm com o nó.

### 2. Agent é instrução, modelo e permissão

Um agent tem instruções, modelo, servidores MCP e ferramentas que pode usar,
skills e orçamento. Não tem gatilho nem passo de ação: quem decide quando ele
trabalha e o que acontece com a saída é a automação. Cada agent tem um chat para
conversar com ele e testar fora de qualquer automação.

### 3. Fila é só o que pede decisão

Aprovação e etapa manual. Nada que seja só para ler.

### 4. Hoje é a visão geral

O que espera você (atalho para a Fila), o que deu erro, o que roda a seguir,
custo, e as leituras: digest, briefing e alerta sem ação, que somem quando
lidas.

### 5. Iniciativa agrupa tudo em volta de um objetivo

Exemplos: "Hub Parcerias", "Principal Software Engineer". Uma iniciativa tem
contexto (objetivo, pessoas, repositórios, canais), as automações e os agents que
trabalham para ela, e o progresso visível: PRs ligados, execuções, pendências.

Uma iniciativa pode ter um orquestrador: um agent que delega a outros agents e
pode trabalhar em código, cada tarefa na sua worktree. O que ele pode fazer
sozinho e o que passa pela Fila é configurado na iniciativa, ação por ação.

### 6. Sessão é trabalho no terminal que não pode se perder

Uma sessão do Claude Code tem estado (aberta, parada, terminada) e próximo
passo. Pode ficar solta ou ligada a uma iniciativa; o Locum sugere a iniciativa
pelo repositório e pela worktree. "Retomar" reabre a sessão na worktree dela.

### 7. Exportar e importar em pacote

Exportar uma automação gera um pacote JSON com o fluxo, os agents que ele usa e o
que ele precisa na outra máquina (app conectado, servidor MCP com tal nome,
provedor de modelo), sem nenhum segredo. Importar mostra o que vai ser criado e o
que falta, e a pessoa liga cada dependência ao que tem: provedor e modelo de cada
agent, servidor MCP equivalente. Agent com o mesmo id vira versão nova. O
template do marketplace é um pacote desses guardado no repositório.

### 8. Conexões, modelos e configuração, cada um no seu lugar

**Conexões** (hoje "Apps") é o único lugar de tudo que é externo: serviço do
catálogo, servidor MCP próprio, tracker de tarefas. Por baixo, um serviço do
catálogo é um preset de servidor MCP ou de API nativa, e a tela trata os dois do
mesmo jeito. Cada conexão diz o que libera, nas palavras da automação:

- gatilhos (pull request, mensagem do Slack);
- ações de app (comentar no PR, postar no canal);
- ferramentas que um agent pode usar, com a classe de cada uma (leitura,
  escrita interna, escrita externa).

A tela abre com o que está conectado e o estado de cada um (ok, precisa de
atenção, com erro). O catálogo fica atrás de "Adicionar conexão", com busca,
em vez de uma parede de cartões. O detalhe de uma conexão mostra conta, teste,
ferramentas com interruptor e quem usa (agents e automações).

**Modelos** é a lista de provedores: estado, modelos, chave ou endereço editados
na própria tela, sem variável de ambiente nem reinício. Provedor de fábrica é só
o público; endereço de empresa entra como "compatível com OpenAI".

**Configuração** fica só com o comportamento do app: idioma, início no login,
horário de trabalho, assistente, terminal, atualização, e o Locum dentro das
ferramentas de código (Claude Code, opencode).

O agent escolhe ferramentas por conexão ("GitHub: leitura", "Slack: postar"), e
o primeiro uso é um caminho guiado: modelo, conexões, primeira automação.

### 9. Recomeçar em vez de migrar

As automações e os agents do modelo atual não são convertidos. O conceito novo
nasce vazio e o que existia fica como legado, só leitura, até a pessoa recriar
ou descartar.

## Consequências

- O `AgentSpec` com passos se divide em dois: o agent (decisão 2) e o fluxo da
  automação (decisão 1). Executor, fila, versões e orçamento continuam, com o
  run passando a ser de um fluxo.
- A decisão 1 do ADR 0004 ("um agent pertence a no máximo uma iniciativa") vale
  para o agent novo; a iniciativa passa a agrupar também automações e sessões.
- A Biblioteca deixa de existir como lugar separado: "Agents" é a tela do agent.
- Ordem de trabalho, um PR por item: este documento e o glossário; Conexões,
  Modelos e Configuração; Agent com o chat; Automação v2 com o canvas, o nó de
  aprovação e o pacote; Fila e Hoje; Iniciativa e Sessões com o orquestrador.
  Conexões vem antes do Agent porque a permissão do agent é dada por conexão.

## Notas de implementação

- Item 3, fatia A (15/10/2026): o agent novo é o perfil da Biblioteca, com
  `connections`, `skills` e `budget` opcionais. Escrita ligada numa conexão
  não vira ferramenta que o agent chama sozinho em automação: fica à espera da
  confirmação do chat (fatia B), de acordo com "mecanismo, não política" e com a
  regra de que escrita externa pede aprovação. Ligar escrita é decisão de quem
  usa a tela; o MCP continua recusando.
- Decisão 8, vínculo com a origem (15/10/2026): servidor MCP importado deixa de
  ser cópia e passa a ler a configuração da origem na hora do uso. A decisão
  não muda: segue "mecanismo, não política". O padrão é conservador, porque
  mudança de comando, args, url ou env na origem (escopos, por exemplo) pede
  aceite antes de valer, mas quem usa decide: aceita, mantém a anterior ou
  desvincula. Só a versão do diretório do plugin segue sem pergunta.
