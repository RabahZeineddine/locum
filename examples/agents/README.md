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

## Marketplace

O marketplace do app lê esta pasta na branch `main` do repositório remoto, e usa
a cópia empacotada no app só se o remoto não responder. Agent novo ou ajustado
aqui chega a quem já tem o app instalado sem release. O contrapeso: app antigo
ignora campo novo do spec que não conhece, então um template que dependa de
campo recente pode instalar sem ele em versão velha.

## PR review por link no Teams

O `pr-review.json` também roda a partir de um link de pull request colado no
Teams, com reação na própria mensagem: 👀 quando o Locum pega o PR, e no fim ✅
(APPROVE), ⚠️ (REQUEST_CHANGES) ou 💬 (COMMENT). Para montar:

1. Conecte o Teams em Apps com os **canais ligados**. Ler canal pede
   `ChannelMessage.Read.All`, que só o administrador do tenant libera: o painel
   abre o consentimento do administrador quando precisa. Sem canais, o link só
   vale em chat em grupo e direto.
2. Crie uma automação com o `pr-review` e um gatilho **Menção ou DM no Teams**.
   Escolha os canais em **Listar canais** e ligue **Mensagem com link de PR**
   (`"prLinks": true`). Menções e conversas diretas podem ficar desligadas se
   só o link interessa.
3. Cole um link como `https://github.com/<dono>/<repo>/pull/<n>` (vale
   `/files` e query). Chat de reunião só acorda com menção.

Uma mensagem com vários links gera um evento por PR, até cinco, e editar a
mensagem não gera evento repetido. O evento leva o contexto do PR nos mesmos
campos que o agent lê (`repo`, `title`, `description`, `diff`, `omittedSummary`,
`ci.summary`), buscado com o token do GitHub da configuração; se a busca falhar
o evento segue sem diff, com `prError`, e o erro aparece no resultado do
gatilho. A mensagem do próprio usuário também conta.

Aprovar e pedir mudanças continuam parando na fila: a reação do veredito sai
quando a review é publicada, não quando o agent termina. O `repo` do evento é o
do PR, então este fluxo não serve ao `teams-reply`, que acha a conversa pelo
`repo`.

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
- `budget` põe teto por execução e por dia nos provedores por API. No runtime
  `claude-code` (assinatura) o gasto não é medido e o `maxSteps` não vale: o
  freio é o prompt, como faz o `support-desk`.

Passo de ação importado com `draft` ou `auto` vale como está, porque quem
importa é uma pessoa. O mesmo spec gravado por um agent, pelo servidor MCP, é
rebaixado para `approve`.
