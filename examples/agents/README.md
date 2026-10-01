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
