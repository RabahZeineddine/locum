# ADR 0006: nada implícito, todo efeito é um nó

Data: 16/10/2026
Status: aceito
Complementa: ADR 0005 (conceito v3)

## Contexto

O ADR 0005 diz que o Locum entrega mecanismo, não política. O código não seguiu
isso à risca. O gatilho do Teams com link de PR punha 👀 na mensagem sozinho, a
publicação da review trocava pelo emoji do veredito no Teams e no Slack, e o
executor e o scheduler tiravam a reação quando o run falhava ou o evento era
descartado. Nada disso aparecia no canvas nem no MCP, e tudo saía no nome da
pessoa.

A auditoria de 16/10/2026 achou outros casos do mesmo tipo: filtros, janelas e
tetos que decidem o que roda sem estar no nó, e texto que vai ao GitHub fixo no
código.

## Decisão

1. Escrita fora da máquina só sai de um passo de ação do fluxo, pelos handlers
   registrados em `src/executor/build.ts` e pela `approval/`. Nenhum gatilho,
   fonte, executor, scheduler ou outro handler escreve fora.
2. Um nó faz uma coisa. Ação não dispara efeito secundário.
3. O que decide se, o que e quando algo roda é parâmetro do nó ou do gatilho,
   com padrão visível na tela e no MCP.
4. Texto que sai para outra pessoa vem do fluxo (parâmetro ou template).
5. O padrão de uso vem montado no template, com os nós à vista. Automação
   gravada não ganha nó sozinha; o editor oferece e a pessoa salva.
6. Uma trava automática cobra a regra 1: um teste falha quando código fora da
   lista de handlers chama as funções de escrita externa.

## Consequências

- As reações viram nós `teams.react` e `slack.react`, e saem do gatilho, da
  publicação, do executor e do scheduler.
- Quem atualiza e tinha a automação de review do Teams deixa de ver reações até
  adicionar os nós. O editor avisa uma vez e insere com um clique.
- Cada item da auditoria vira trabalho; a lista com o estado de cada um fica em
  `docs/auditoria-mecanismos-2026-10-16.md`.
- O chat do agent continua podendo escrever fora por clique da pessoa no cartão
  de confirmação. É exceção nomeada na trava, porque a confirmação é humana e
  explícita.
