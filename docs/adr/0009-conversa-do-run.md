# ADR 0009: conversa do run

Data: 17/10/2026
Status: aceito
Complementa: ADR 0006 (nada implícito), ADR 0007 (passo avulso), ADR 0008 (reexecução com instrução)

## Contexto

A pessoa quer conversar sobre um run que já rodou, como no Claude Code, e ver o
resultado mudar ("libera aí sem comentários", "faltou revisar X"). Um chat com
ferramentas de escrita seria o efeito escondido que o ADR 0006 proíbe.

## Decisão

1. A conversa do run usa o mesmo motor de turno do chat de agent (trava entre
   processos, falas guardadas, cancelamento, compactação, eventos). O que muda é o
   provedor de contexto: chave, system, ferramentas, modelo e destino do gasto. O
   agent e o run são dois provedores.
2. As ferramentas da conversa são só estas: `ler_run`, `propor_acao`,
   `reexecutar_passo` e `editar_pendencia`. `propor_acao` é o passo avulso (ADR
   0007) e `reexecutar_passo` é a reexecução com instrução (ADR 0008). Não há
   escrita externa direta, cartão, ferramenta de escrita do perfil do agent nem
   conexão MCP na conversa. O que sai de lá passa pela Fila e pelo clique.
3. As ferramentas moram no processo do Locum. Pelo Claude Code da assinatura sobem
   num servidor MCP local com token de uma volta só, como o de aprovação.
4. O contexto inicial é o evento, a saída de cada passo e as pendências, entre as
   marcas de dado de fora. Há um teto de tamanho, que é limite técnico; o que ele
   corta aparece no estado, na tela e no MCP, e o modelo lê o resto com `ler_run`.
5. Quem responde é um parâmetro da conversa. O padrão é o agent do primeiro passo
   de modelo do run, ou o modelo dele, escrito na tela e no MCP.
6. O gasto vai para `runs.conversa_usd` e `runs.conversa_tokens`, separado dos
   passos: o `reset` de uma reexecução não o desconta. Vai também para o gasto
   diário da automação e, havendo agent, para o dele. O teto por execução
   (`perRunUsd` e `perRunTokens`) mede o gravado: `runs.conversa_*` mais o custo dos
   passos do run, contra o orçamento da versão atual da automação. Reiniciar o app
   ou limpar a conversa não devolve o que ela gastou.
7. Run de automação arquivada: a conversa só lê. `propor_acao` e
   `reexecutar_passo` conferem o arquivamento na própria transação.
8. Uma volta em andamento bloqueia arquivar e deletar a automação. Deletar apaga a
   conversa junto com o run.

10. Os limites técnicos de uma volta aparecem no estado e no MCP com o valor
    escrito: passos do laço (12, ou o `maxSteps` do agent quando ele responde, e o
    estado diz qual dos dois vale) e o teto de leitura do `ler_run` (20 000
    caracteres). A `instrucao` dos passos que `ler_run` devolve vai entre as marcas
    de dado de fora.
11. Escolher um modelo para a conversa vale só para um id que o catálogo dos
    provedores lista. A descrição das ferramentas para o modelo segue o idioma do
    app, como o system.
12. Os erros de serviço que chegam à tela levam código (`<código>:<argumento>:
    <texto>`, em `erro-com-codigo.ts`) e a tela os traduz, como já fazia com
    `proposta_recusada`. `run_chat_take` assume a conversa de um processo que
    parou de responder, como `agent_chat_take`.

## Consequências

- O passo avulso que a conversa propõe grava `propostoPor: "conversa"` em
  `steps.input` (a proposta à mão grava `"pessoa"`). A Fila, a tela do run e o MCP
  (`get_approval`, `list_pending_approvals`, `get_run`) mostram "proposta pela
  conversa".
- Edição de pendência pela conversa fica marcada como alterada por ela, e a
  decisão com o hash do payload visto antes da edição é recusada.
- Prompt injection em saída de passo, PR ou mensagem não ganha ferramenta de
  escrita: no pior caso propõe uma pendência, que a pessoa lê antes de decidir.
