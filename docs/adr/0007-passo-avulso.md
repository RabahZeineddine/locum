# ADR 0007: passo avulso

Data: 17/10/2026
Status: aceito
Complementa: ADR 0006 (nada implícito)

## Contexto

Depois que uma automação de review avaliou um pull request, a pessoa pode querer
uma ação nova sobre o mesmo run, que o fluxo não previu: aprovar sem comentário,
por exemplo. A regra 1 do ADR 0006 diz que escrita fora da máquina só sai de um
passo de ação do fluxo. Mexer no fluxo para cada pedido pontual muda a
automação, e não só aquele run.

## Decisão

1. Existe o passo avulso: uma ação proposta sobre um run que já rodou, gravada
   como passo do próprio run (`steps.origem = "avulso"`, chave `avulso-<n>`).
   É exceção nomeada à regra 1 do ADR 0006. Ele só vale com as quatro condições
   abaixo.
2. Sempre em `approve`. Nunca `auto`, e a ação que não aceita `approve` não é
   oferecida. A pendência vai para a Fila e passa por `approval/`.
3. À vista no run: o grafo e a lista de passos mostram o avulso depois dos do
   fluxo, marcado como avulso. A definição (ação, conteúdo, de que passo deriva)
   fica em `steps.input`.
4. O alvo vem do evento do run, pelo mesmo caminho do executor para passo de
   ação. O conteúdo nunca escolhe dono, repositório, pull, commit nem conversa.
   O destino `fixo` de uma ação de conversa só entrará por parâmetro explícito, escolhido na tela ou no MCP, quando um handler de conversa ganhar `inputSchema`; hoje nenhum tem, e o avulso não escolhe destino.
5. O handler declara o que o conteúdo aceita em `inputSchema` (JSON Schema, só
   conteúdo). Handler sem `inputSchema` não é oferecido como avulso: não há lista
   de ações permitidas no código. A tela monta o formulário e o MCP valida pelo
   mesmo esquema.
6. Decidir o avulso fecha só o passo dele. Não retoma o run nem executa o que ele
   deixou para trás; a decisão olha a origem do passo, nunca o tipo da ação.
7. Recusas, na mesma transação que grava: run em andamento (`queued`, `running`),
   automação arquivada, run de ensaio e run inexistente. A proposta não muda
   status, fim nem custo do run.
8. `rerun_step` não vale sobre um avulso. Reexecutar o passo de que ele deriva
   expira a pendência dele, porque ela parte de um resultado que o run descartou.

## Consequências

- O mesmo `externalId` (`runId:stepId:attempt`) protege o avulso de publicar em
  dobro.
- O MCP ganha `propose_run_action`, que cria a pendência e não publica (ADR 0002),
  e o `describe_steps` passa a expor o `inputSchema`.
- A trava do ADR 0006 continua: a escrita sai de um handler registrado, depois
  do clique.
