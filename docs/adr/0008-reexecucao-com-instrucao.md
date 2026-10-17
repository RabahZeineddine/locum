# ADR 0008: reexecução com instrução

Data: 17/10/2026
Status: aceito
Complementa: ADR 0006 (nada implícito), ADR 0007 (passo avulso)

## Contexto

A pessoa pode querer que um passo de modelo rode de novo com um pedido a mais
("revise também o tratamento de erro em X"). O resultado novo muda o que as ações
a jusante dizem, e uma ação em `auto` publicaria isso sem ninguém olhar.

## Decisão

1. `rerun_step` aceita uma instrução, só para passo de modelo. Ela é gravada em
   `steps.instrucao` e entra depois do prompt renderizado, sob um rótulo que é
   parâmetro (`instructionLabel`, com padrão escrito no executor). Dependentes
   perdem a instrução.
2. Com instrução, todo passo de ação a jusante que estava em `auto` roda em
   `approve` naquele run. A marca fica em `steps.rebaixado` (mesmo vocabulário do
   `config/rebaixado.ts`), aparece no run e no MCP, e só vale até a próxima
   reexecução. O spec da automação não muda.
3. Sem instrução, a reexecução segue o spec, como antes.
4. A prévia (`rerunPreview`, `preview_rerun` no MCP) lista os passos que voltam
   a rodar e as ações que vão para a Fila, antes de confirmar.

## Consequências

- É trava que só pede mais confirmação, permitida pelo CLAUDE.md: nunca rebaixa
  para automático.
- O avulso derivado continua expirando na reexecução do passo de origem (ADR 0007).
