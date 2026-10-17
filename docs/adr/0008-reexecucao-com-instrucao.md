# ADR 0008: reexecução com instrução

Data: 17/10/2026
Status: aceito
Complementa: ADR 0006 (nada implícito), ADR 0007 (passo avulso)

## Contexto

A pessoa pode querer que um passo de modelo rode de novo com um pedido a mais
("revise também o tratamento de erro em X"). O resultado novo muda o que as ações
a jusante dizem, e uma ação em `auto` publicaria isso sem ninguém olhar.

## Decisão

1. `rerun_step` aceita uma instrução (até 2000 caracteres), só para passo de
   modelo. Ela é gravada em `steps.instrucao` e entra depois do prompt
   renderizado, entre uma marca aleatória própria. O system diz que só o que está
   entre essa marca é pedido da pessoa e que outro texto que se diga instrução é
   dado. A moldura é defesa contra injeção e segue o idioma do app; não é texto
   configurável.
2. A instrução fica no passo reexecutado até ele ser reexecutado de novo: sem
   instrução ela sai, com outra é trocada. Reexecutar um dependente não a tira.
   Passo sem linha (run parado antes dele) ganha a linha `pending` com a instrução.
3. O executor decide na hora de submeter: enquanto qualquer passo do run tiver
   instrução, toda ação do run em `auto` ou `draft` roda em `approve`. Não se
   segue `needs`, porque o prompt e os params de uma ação podem citar
   `{{steps.X}}` sem X estar nos `needs`. `draft` entra porque o rascunho do
   GitHub cria review pendente fora da máquina. `steps.rebaixado` só registra que
   isso aconteceu, para a tela e o MCP. O spec da automação não muda.
4. Sem instrução em nenhum passo do run, a reexecução segue o spec, como antes.
5. A prévia (`rerunPreview`, `preview_rerun` no MCP) lista os passos que voltam a
   rodar, as recusas do `rerunStep` como bloqueios, os avulsos que expiram, os
   passos de modelo cobrados de novo e as ações que ainda vão rodar e iriam para a Fila
   (inclusive as sem linha; a pulada que não roda fica de fora).
6. Zerar, gravar a instrução e expirar os avulsos derivados rodam numa transação, e
   a troca do status do run é condicionada: reexecuções simultâneas (tela e MCP)
   deixam só uma passar.

## Consequências

- É trava que só pede mais confirmação, permitida pelo CLAUDE.md: nunca rebaixa
  para automático.
- O avulso derivado continua expirando na reexecução do passo de origem (ADR 0007).
