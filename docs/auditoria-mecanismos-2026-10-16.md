# Auditoria: mecanismo, não política (16/10/2026)

O que o código faz sem que a pessoa tenha montado ou consiga ver, contra o
[ADR 0006](adr/0006-nada-implicito.md). Caminhos relativos a `app/`. Linhas são
de 16/10/2026 e andam com o código; procure pelo nome da função.

Estado: **pendente**, **em andamento** (PR aberto ou branch), **feito** (com o
PR), **legítimo** (fica, com o motivo).

## A. Efeito externo fora de nó

| # | onde | o que faz | estado |
|---|---|---|---|
| A1 | `src/sources/teams-inbox.ts` `reagirAoPegar` | põe 👀 na mensagem durante a varredura | feito (este PR) |
| A2 | `src/sources/github.ts` `avisarOrigem` | depois da review, reage no Teams e no Slack | feito (este PR) |
| A3 | `src/sources/github.ts` `reagirNoTeamsAoSair` | troca 👀 pelo emoji do veredito | feito (este PR) |
| A4 | `src/sources/github.ts` `reagirNoSlack` | o mesmo no Slack, com nome de tool fixo | feito (este PR) |
| A5 | `src/teams/reaction.ts` `soltarOPr` | tira 👀 (chamado por draft, discard, executor e scheduler) | feito (este PR) |
| A6 | `src/executor/executor.ts` catch de `execute` | run falho ou pausado tira 👀 | feito (este PR) |
| A7 | `src/triggers/scheduler.ts` `soltarDoEvento` | evento descartado (fila cheia, reavaliação, 24 h) tira 👀 | feito (este PR) |
| A8 | `src/approval/gate.ts` proposta nula → `discard` | cai em A5 | feito (este PR) |

## B. Decisão de fluxo escondida

| # | onde | o que faz | proposta | estado |
|---|---|---|---|---|
| B1 | `teams-inbox.ts` `prDesde` | primeira batida ignora PR de mensagem antiga | parâmetro `ignorarAntesDe` no gatilho | pendente |
| B2 | `teams-inbox.ts` dedupe | mesmo PR e commit em 24 h não volta | parâmetro `janelaDeRepeticao` | pendente |
| B3 | `teams-inbox.ts` `motivoDeDescarte` | descarta PR fechado, rascunho ou próprio, sem opção | opções do gatilho (rascunho, autoria) | pendente |
| B4 | `teams-inbox.ts` pré-checagem | descarta antes de perguntar ao modelo | declarar no nó de filtro | pendente |
| B5 | `teams-inbox.ts` filtro sem modelo | passa tudo | parâmetro `semModelo: passa / adia` | pendente |
| B6 | `teams-inbox.ts` `FALHAS_ATE_PASSAR` | 3 falhas do modelo e passa | parâmetro `emFalha` e tentativas | pendente |
| B7 | `teams-inbox.ts` tetos do filtro | 20 por batida, 90 s, 5 min, 3 em paralelo | parâmetros com padrão visível | pendente |
| B8 | `teams-inbox.ts` chats de reunião | ficam fora de DM | opção `reunioes` no gatilho | pendente |
| B9 | `teams-inbox.ts` cursor herdado | migração do cursor compartilhado | mostrar o cursor; remover a migração | pendente |
| B10 | `src/services/filtro-ia.ts` | modelo do filtro muda por máquina | mostrar o modelo efetivo ou exigir | pendente |
| B11 | `executor.ts` substituição por limite | troca o modelo (desligada de fábrica) | configurável por agent | pendente |
| B12 | `executor.ts` cadeia de fallback | vale para todo passo, sem aparecer | mostrar no nó | pendente |
| B13 | `executor.ts` skills por regra | `when` padrão `always` | mostrar no nó antes do run | pendente |
| B17 | `executor.ts` destino do evento | sobrepõe saída do modelo | dizer no nó "destino vem do evento" | feito (campo `destino` nos nós de resposta e reação) |
| B18 | `executor.ts` perfil sobrepõe passo | modelo e ferramentas vêm do agent | dizer no nó | pendente |
| B19 | `src/runtimes/claude-code.ts` | carrega config do usuário | listar ferramentas liberadas no nó | pendente |
| B21 | `config/types.ts`, `triggers/working-hours.ts` | horário com padrão silencioso | padrão no formulário do gatilho | pendente |
| B22 | `scheduler.ts` | gatilho herda horário global sem dizer | "herdado do global" | pendente |
| B23 | `scheduler.ts` pausa por limite | fila de 200, lote 5, expira 24 h | parâmetros com padrão visível | pendente |
| B24 | `scheduler.ts` `GITHUB_OWNER` | dono vem do ambiente | remover | pendente |
| B25 | `services/github-service.ts` | token cai no `GITHUB_TOKEN` | mostrar a origem do token | pendente |
| B26 | `teams/graph.ts` | escreve pelo Graph ou pelo MCP | mostrar o caminho na conexão | pendente |
| B28 | `sources/github.ts` `cursorDe` | cursor herdado ao trocar escopo | mostrar ou remover | pendente |
| B29 | `sources/diff-limit.ts` | tira lock, build e gerado do diff | parâmetro com a lista padrão | pendente |
| B30 | `actions/generic.ts` | `http.request` sem método vira POST | método obrigatório no nó | pendente |
| B31 | `trackers/issue-action.ts` | tarefa já existente fecha como publicada | mostrar "já existe" | pendente |
| B33 | `services/agent-service.ts` | rebaixa ação para aprovação ao salvar | mostrar os rebaixamentos | pendente |

Legítimos: B14 (recusa sem evento, mostrada), B15 (`optional`), B16 (ensaio,
sinalizado), B20 (classificação de leitura gravada na conexão), B27 e B34
(proteções padrão, configuráveis), B32 (veredito que pede clique, segurança),
B35 (tentativas de GET, transporte).

## C. Valor fixo que é política

| # | onde | o que é | proposta | estado |
|---|---|---|---|---|
| C2, C3 | `sources/github.ts` | "LGTM!", "Sugestão:", rótulos de severidade | template no nó `github.review_comment` | pendente |
| C4 | `teams/reaction.ts`, `sources/github.ts` | emojis fixos | parâmetro do nó de reação | feito (este PR) |
| C5 | `sources/github-pr-link.ts` | 5 PRs por mensagem, o resto some | parâmetro e aviso no detalhe | feito (este PR) |
| C7 | `services/github-service.ts` | diff de 200 000 caracteres, setter sem chamador | parâmetro do nó | pendente |
| C8 | `services/filtro-ia.ts` | prazo e corte de texto do filtro | parâmetros | pendente |
| C9 | `executor.ts` | contexto da iniciativa cortado em 40 000 | aviso no run | pendente |
| C21 | `trackers/proposal.ts`, `services/approval-service.ts` | dois modelos de texto de tarefa | template no nó `tracker.create_issue` | feito (este PR): o segundo modelo saiu junto com o botão |

Legítimos ou só precisam aparecer: C1 (marca técnica `<!-- locum -->`), C6, C10,
C11, C12, C13, C14, C15, C16, C17, C18, C19, C20, C22, C23, C24, C25 (tetos e
validações; mostrar quando cortam).

## D. Efeito interno sem visibilidade

| # | onde | o que faz | proposta | estado |
|---|---|---|---|---|
| D1 | `teams-inbox.ts` | conta do Teams fixada na primeira batida | mostrar e trocar no gatilho | pendente |
| D4 | `teams-inbox.ts` `VEREDITOS_POR_BANCO` | veredito do filtro só em memória | persistir ou declarar | pendente |
| D5 | `scheduler.ts`, `services/reconcile-service.ts` | conferência roda em toda batida | tarefa visível e desligável | pendente |
| D6 | `electron/notify.ts`, `services/notice-service.ts` | notificação do macOS sem interruptor | configuração desligável | pendente |
| D7 | `electron/updater.ts` | troca a versão ao sair sem perguntar | padrão explícito | pendente |
| D8 | `services/limites-service.ts` | consulta gateways a cada 10 min | listar em Limites | pendente |
| D10 | `renderer/src/telas/revisao.tsx`, `approval-service.ts`, MCP `propose_tracker_issue` | botão "Criar história no Shortcut" na Fila, fixo num tracker | tirar; abrir tarefa é o nó `tracker.create_issue` | feito (este PR) |
| D11 | `services/execution-service.ts` | alvo demo grava evento no banco real | marcar como ensaio | pendente |
| D12 | `scheduler.ts` `pausadas` | aviso de pausa some ao reiniciar | persistir | pendente |
| D13 | `services/trigger-service.ts` `remove` | deixa os cursores do gatilho | limpar | pendente |

Legítimos: D2, D3 (estado do evento e gasto, mostrar no detalhe), D9 (segurança),
D14 (chat do agent: escrita por cartão de confirmação,
exceção nomeada na trava).

## E. Paleta por conexão (feat/paleta-por-conexao)

| # | onde | o que acontece | proposta | estado |
|---|---|---|---|---|
| E1 | `approval/gate.ts` `submitComSaida`, `executor.ts` | no caminho `auto`, a queda entre `close(approved)` e a atualização do passo deixa o passo sem saída e a retomada pode submeter a escrita de novo | gravar a resposta na pendência antes de fechar, ou reconhecer a pendência `auto` já aprovada na retomada | pendente |
| E2 | `renderer/lib/paleta-conexoes.ts` `desligada` | a paleta por app (feat/no-por-app) não usa mais `secoesDaPaleta`: o ponto de encaixe passa a ser `operacoesDoApp` em `renderer/lib/apps-da-paleta.ts`. Antes: a paleta tem o ponto de encaixe para esmaecer ferramenta de escrita em conexão só de leitura, sem fonte ligada: `scope` é `read` por padrão e não há tela para mudá-lo | tela de escopo por conexão, e então ligar `desligada` e a recusa no executor | pendente |
