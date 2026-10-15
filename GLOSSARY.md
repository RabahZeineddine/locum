# Glossário

Os termos que o Locum usa na tela, no código e na documentação. Um termo por
ideia; se dois nomes parecem servir, só um está certo. Decisões em
`docs/adr/0005-conceito-v3.md`.

**Agent**: instruções, modelo, servidores MCP, ferramentas, skills e orçamento.
Não tem gatilho nem ação própria. Pode ser testado no chat dele. Não é a
automação.

**Conexão do agent**: o que um agent usa de uma conexão. Leitura vem ligada e
escrita desligada; cada ferramenta pode ser ajustada. A escrita ligada só sai
com confirmação, no chat do agent.

**Automação**: fluxo de nós ligados que começa num gatilho. Decide quando os
agents trabalham e o que acontece com a saída deles.

**Nó**: cada peça da automação. Categorias: gatilho, agent, ação de app,
ferramenta, lógica e aprovação.

**Gatilho**: o nó que acorda a automação (pull request, Slack, Teams, horário,
intervalo, webhook, manual, consulta MCP), com os filtros de quando vale.

**Ação de app**: nó que faz algo fora do Locum em nome da pessoa: comentar no PR,
postar no Slack ou no Teams, abrir card ou issue.

**Aprovação**: nó que para o fluxo na Fila até alguém decidir. Quem monta
escolhe onde ele entra.

**Conexão**: algo externo que o Locum alcança: serviço do catálogo, servidor
MCP próprio ou tracker. Libera gatilhos, ações de app e ferramentas. Na tela
antiga se chamava "App".

**Ferramenta**: operação de uma conexão que um agent pode chamar, com classe
leitura, escrita interna ou escrita externa.

**Origem**: o arquivo ou plugin de onde a configuração de um servidor MCP vem
(Claude Code, um plugin dele, opencode, Cursor, VS Code, Claude Desktop). É
guardada como ferramenta, plugin e servidor, nunca como caminho com versão.

**Vínculo**: a ligação de uma conexão importada com a origem dela, no lugar da
cópia. Comando, args, env e url se leem da origem na hora do uso; ligado,
credencial, escopo e as escolhas dos agents ficam no Locum. Mudança sensível na
origem espera aceite, e "desvincular" vira cadastro manual.

**Provedor**: de onde vêm os modelos: assinatura (Claude Code, Codex), chave de
API ou endereço compatível com OpenAI.

**Fila**: o que pede decisão da pessoa: aprovações e etapas manuais.

**Leitura**: saída que só informa (digest, briefing, alerta sem ação). Aparece
em Hoje e some quando lida. Nunca entra na Fila.

**Hoje**: a visão geral ao abrir o app.

**Execução**: uma passada de uma automação, do gatilho ao fim, com passos,
custo e resultado.

**Descarte**: o que um gatilho viu e deixou de fora, com o motivo.

**Iniciativa**: objetivo que agrupa contexto, automações, agents, sessões e o
progresso visível.

**Orquestrador**: agent de uma iniciativa que delega a outros agents. O que ele
faz sozinho é configurado na iniciativa.

**Sessão**: trabalho no Claude Code com estado e próximo passo, solta ou ligada
a uma iniciativa.

**Pacote**: JSON exportado de uma automação, com o fluxo, os agents e as
dependências, sem segredo. É também o formato do template do marketplace.

**Legado**: automação ou agent do modelo anterior ao ADR 0005, só leitura.
