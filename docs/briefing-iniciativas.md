# Briefing: iniciativas no Locum

Entrada para o planejamento (ADR 0004 e marcos I1 a I5). Escrito em 27/09/2026, a partir da
conversa de organização do dia a dia do Rabah. Não é decisão: o plano pode mudar o que está aqui,
desde que registre o porquê.

## Problema

Quem toca várias frentes em paralelo (serviços, plataforma, gestão de time, on-call) abre uma
sessão de agente por frente e perde o fio entre elas: contexto espalhado em arquivos de passagem,
board desatualizado, cobranças esquecidas, agents que não sabem a que frente servem. O Locum já
roda agents em segundo plano com aprovação; falta a camada que organiza tudo por frente de
trabalho.

## Ideia central

A **iniciativa** vira a entidade que agrupa o resto:

```
iniciativa
├─ objetivo, critério de pronto, prazo, status, meta ligada (opcional)
├─ contexto        markdown vivo: estado, decisões, próximo passo
├─ workspace       repositórios, worktrees e branch
├─ integrações     quais servidores MCP a iniciativa enxerga
├─ agents          observers ligados a ela, rodando com o escopo dela
├─ prompts         ações rápidas (status, preparar reunião, abrir sessão)
└─ links           épico no tracker, PRs, páginas, threads
```

## Regras propostas

1. **MCP por iniciativa.** O cadastro de servidores continua global; a iniciativa escolhe quais usa,
   e um agent ligado a ela só enxerga esses. Decidir a regra para agent em mais de uma iniciativa
   (proposta: união, com `external_write` sempre aprovado).
2. **Integração é MCP.** GitHub, Jira, Confluence e Notion entram por um catálogo de presets
   (URL, transporte, autenticação, classe de cada ferramenta). Sem cliente próprio por serviço.
   O `github-service` nativo continua onde já está (PR review).
3. **Contexto em arquivo local.** Uma pasta por iniciativa (proposta:
   `~/Locum/iniciativas/<slug>/`), markdown com frontmatter. O banco só indexa. Uma sessão de
   Claude Code lê direto, a pessoa edita à mão, e a pasta já funciona como vault do Obsidian.
   O acesso passa por uma interface de armazenamento, para que versionar em git, sincronizar com
   Notion ou guardar em banco entrem depois como adaptadores, sem mexer no resto.
4. **Agent escreve no contexto só por proposta.** A escrita no contexto é `internal_write` e
   passa pela fila de aprovação, para o contexto não acumular erro de modelo.
5. **Prompt é entidade versionada**, como o agent, mas sem gatilho. Pode ser ação da iniciativa
   ou passo de agent.
6. **Nada específico de empresa no repositório.** Presets genéricos; iniciativas, prompts, fontes
   e credenciais ficam só no banco e na pasta local de quem usa. O projeto é open-source.

## Abrir sessão

O botão da iniciativa gera o `CLAUDE.md` dela (contexto, workspace, links) e abre o `claude` no
worktree, no terminal de quem usa (Warp, Terminal, iTerm), por deep link ou `open`. Terminal
embutido fica fora da primeira versão. Quando a sessão termina, o Locum lê a passagem que ela
escreveu e propõe a atualização do contexto.

## Marcos sugeridos

- **I1, núcleo:** esquema (iniciativa, workspace, MCP da iniciativa, prompt, vínculo com agent),
  migração drizzle, `InitiativeService`, armazenamento de contexto em arquivo, ferramentas no
  servidor MCP do Locum. Pronto quando o chat interno criar e configurar uma iniciativa completa.
- **I2, interface:** lista com painel (o que andou, o que está parado há N dias, o que espera a
  pessoa) e detalhe da iniciativa.
- **I3, sessão:** abrir sessão e voltar a passagem como proposta.
- **I4, catálogo de integrações:** presets de GitHub, Jira, Confluence e Notion, com OAuth pelo
  deep link existente.
- **I5, uso real:** três iniciativas de verdade rodando (uma de gestão de time com prazo, uma de
  biblioteca interna, uma de plataforma), cada uma com pelo menos um agent.

## Fora de escopo por enquanto

Backlog e board próprios (o tracker externo continua sendo o registro do time), terminal embutido,
gerenciador de worktree próprio, sincronização com Notion ou git do contexto.

## Primeiro caso real

Uma iniciativa de gestão interina com prazo (cobrir um gestor em férias por duas semanas):
acompanhar as iniciativas de cada pessoa do time, montar a pauta do refinamento, rascunhar
cobranças e status. Tudo que for mensagem para outra pessoa sai como rascunho, nunca automático.
