# Agents de exemplo

O Locum não traz agent pronto. O banco nasce vazio, e agent, skill e servidor
MCP são de quem usa. Estes arquivos são pontos de partida: importe, rode, e
edite até virar o seu.

| arquivo | o que faz |
|---|---|
| `pr-review.json` | triagem, auditoria com veredito, contexto de deploy opcional (pede um servidor MCP chamado `argocd`) e a review no pull request, parada na fila |
| `slack-digest.json` | lê os canais observados do Slack e monta um digest, que chega na inbox como leitura |
| `slack-reply.json` | escreve a resposta a uma mensagem do Slack e para na fila antes de postar |
| `teams-reply.json` | o mesmo para o Teams: escreve a resposta à mensagem e para na fila antes de mandar |
| `support-desk.json` | central de chamados: lê as conversas das fontes da iniciativa, conta horas úteis pela ferramenta `business_hours`, classifica cada chamado e entrega o quadro na inbox, com investigação dos críticos |

## Central de chamados

O `support-desk.json` precisa de uma iniciativa e de um gatilho de horário, que
o arquivo não traz: ligue-o à iniciativa e crie você um gatilho `schedule` com
cron. Duas vezes por dia útil (por exemplo `0 9,15 * * 1-5`) costuma bastar,
porque cada execução com chamado abre uma pendência nova na inbox. Não use o
gatilho de caixa de entrada: a execução por mensagem não enxerga a conversa
inteira, e o relógio depende dela.

Quem é do time, quem é solicitante, as fontes a ler, a régua de faixas (`p1` e
`p0`, em horas úteis), a janela de expediente com o fuso e os feriados vêm do
`context.md` da iniciativa; sem eles a ferramenta usa o padrão dela (09:00 às
18:00, segunda a sexta, `America/Sao_Paulo`, `p1` em 4 h e `p0` em 8 h). O
exemplo lê Slack pelo servidor `slack` e Teams pelo servidor `ms365`, e os
nomes das ferramentas de leitura do Teams dependem do servidor que você usa:
ajuste as ferramentas e `requiresServers` dos passos `triage` e `investigate`
ao que existe na sua máquina, e tire o que não usa. Com o
`@softeria/ms-365-mcp-server` no preset `teams`, dá para ler canal e thread de
canal; mensagem de chat não tem ferramenta de listagem, então chat fica fora da
triagem. Não vem ligado a nenhum gatilho.

## Importar

Na tela **Agents**, **Importar**. Ou pela linha de comando, de dentro de `app/`:

```bash
npm run dev import ../examples/agents/pr-review.json
```

Importar de novo um arquivo com o mesmo `id` cria versão nova, com a anterior
no histórico. **Exportar**, no detalhe do agent, salva o spec no mesmo formato:
é assim que um agent vai para outra máquina.

## O formato

É o `AgentSpec` de `app/src/config/types.ts`, validado na importação. O
essencial:

- `id` em minúsculas, números e hífen;
- `steps`, cada um `model` (um prompt para um modelo, como
  `claude-code/claude-sonnet-5` ou `anthropic/claude-sonnet-5`) ou `action` (a
  saída, que passa pela fila de aprovação);
- `needs` liga um passo aos anteriores, e `{{steps.<chave>}}` no prompt traz a
  saída deles;
- `skills` carrega skills da sua máquina conforme os arquivos alterados;
- `budget` põe teto por execução e por dia.

Passo de ação importado com `draft` ou `auto` vale como está, porque quem
importa é uma pessoa. O mesmo spec gravado por um agent, pelo servidor MCP, é
rebaixado para `approve`.
