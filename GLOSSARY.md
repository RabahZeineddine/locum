# Glossário

Os termos que o Locum usa na tela, no código e na documentação. Um termo por
ideia; se dois nomes parecem servir, só um está certo. Decisões em
`docs/adr/0005-conceito-v3.md`.

**Agent**: instruções, modelo, servidores MCP, ferramentas, skills e orçamento.
Não tem gatilho nem ação própria. Pode ser testado no chat dele. Não é a
automação.

**Conexão do agent**: o que um agent usa de uma conexão. Leitura vem ligada e
escrita desligada; cada ferramenta pode ser ajustada. Ao adicionar a conexão, a
tela grava as leituras ligadas; servidor com mais de 30 leituras (ms365, por
exemplo) começa sem nenhuma, e a pessoa escolhe as que o agent precisa. O agent
salvo antes mantém toda leitura ligada. A escrita ligada só sai
com confirmação, no chat do agent.
Ferramenta que o mapa da conexão não cita vale desligada (`leituraPadrao:
"limitada"`). **Linha de base das ferramentas**: ao passar para a lista
explícita (migração do agent antigo, primeiro save, ou a primeira leitura com
catálogo de agent `limitada` sem o marcador, como os vindos da main), toda
ferramenta do catálogo de então entra no mapa, `true` ou `false`. Conexão
adicionada sem lista em cache fica `pendente` e ganha a linha de base quando a
lista chega (leitura ligada, escrita desligada). Daí em diante o save só
preserva o mapa. O aviso de "novas" é o que o servidor ganhou depois da linha de
base e o mapa não cita; só some quando a pessoa grava a escolha, ligada ou
desligada.

**Automação**: fluxo de nós ligados que começa num gatilho. Decide quando os
agents trabalham e o que acontece com a saída deles.

**Automação arquivada**: automação tirada de uso. Some das listas e do agendador,
e os gatilhos saem com o estado preso a eles. Execuções, aprovações, achados e
versões ficam, porque são o registro do que foi publicado em nome da pessoa, e
o id continua ocupado. Dá para desarquivar: volta sem gatilhos e desligada.

**Automação deletada**: automação arquivada que a pessoa apagou de vez, com tudo
que pertencia a ela (versões, gatilhos e o estado deles, execuções com passos,
aprovações e achados, métricas, orçamento, gasto e os eventos colados à mão para
ela). Só se deleta a arquivada, e não tem volta; o id fica livre. O agent da
biblioteca e as skills ficam. Como a dedupe de review lê as aprovações de todas as
automações, os PRs que ela já revisou deixam de contar, e outra automação pode
revisá-los de novo.

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

**Passo avulso**: ação proposta depois, sobre uma execução que já rodou, e não
desenhada no fluxo. Nasce com origem `avulso`, sempre em aprovação, e aparece na
execução depois dos passos do fluxo. O conteúdo vem do `inputSchema` do handler;
o alvo (PR, conversa) vem do evento da execução. Decidir fecha só ele: a execução
não retoma. Reexecutar o passo de que ele deriva expira a pendência. Exceção
nomeada do ADR 0007 à regra 1 do ADR 0006.

**Instrução de reexecução**: texto que a pessoa acrescenta ao reexecutar um passo
de modelo. Entra no fim do prompt daquele passo e não é dado de fora. Vem
entre uma marca aleatória que o system declara como pedido da pessoa. Fica em
`steps.instrucao`, no passo reexecutado, até ele ser reexecutado de novo. Passo
que não é de modelo recusa a instrução. Com instrução num ancestral, a ação a
jusante em `auto` ou `draft` vai para a Fila (`steps.rebaixado`, ADR 0008); a
prévia mostra isso antes de confirmar.

**Descarte**: o que um gatilho viu e deixou de fora, com o motivo.

**Iniciativa**: objetivo que agrupa contexto, automações, agents, sessões e o
progresso visível.

**Orquestrador**: agent de uma iniciativa que delega a outros agents. O que ele
faz sozinho é configurado na iniciativa.

**Sessão**: trabalho no Claude Code com estado e próximo passo, solta ou ligada
a uma iniciativa.

**Pacote**: arquivo `.locum.json` exportado de uma automação, com o fluxo, os
agents e as dependências (conexões, servidores MCP por nome, provedor), sem
segredo, canal, chat ou conta. Importar mostra uma prévia e a pessoa liga cada
dependência ao que tem; gatilho entra desligado. É também o formato do template
do marketplace.

**Campo a preencher**: o que um pacote importado deixou de fora por ser desta
máquina (destino, endereço, canal, dono, filtro de pessoa). Fica gravado na
automação (`pendentes`: o nó, o caminho do campo e o motivo), marcado no nó do
editor. Passo com campo a preencher não roda, gatilho com campo a preencher não
liga, e nada cai em padrão. Some quando o campo ganha valor e a pessoa salva, ou
quando ela dispensa.

**Legado**: automação ou agent do modelo anterior ao ADR 0005, só leitura.

**Cartão**: a chamada de escrita que o agent quer fazer no chat dele, mostrada
com servidor, ferramenta e argumentos, à espera do clique em Executar ou
Recusar. Vive só na conversa, nunca vai para a Fila, e expira se a conversa for
limpa ou o app fechar.
