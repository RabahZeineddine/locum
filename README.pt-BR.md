# Locum

[English](README.md) · **Português**

*Locum: quem assume o seu posto enquanto você não está.*

Aplicativo para macOS que roda agents de IA em segundo plano e faz parte do
trabalho de engenharia no seu lugar: revisa pull requests, investiga, cruza
contexto de várias ferramentas e escreve o rascunho. O que o agent produz não
sai sozinho. Cada ação que escreve em serviço de fora (comentar no GitHub,
responder no Slack, mexer num card) para numa fila e espera a sua aprovação.

## Por que existe

Assistente de IA hoje é conversa: você abre, pede, espera, copia. O trabalho
repetitivo de quem cuida de um time (olhar todo PR que chega, ler o canal,
lembrar do card parado) continua sendo puxado à mão.

O Locum inverte isso. Você descreve o trabalho uma vez, como um agent com
passos, modelos e ferramentas, e diz quando ele roda: um PR novo, uma mensagem
num canal, um horário. Ele roda sozinho, na sua máquina, e entrega o resultado
numa fila onde você aprova, ajusta ou descarta.

Três princípios guiam o desenho:

- **Local primeiro.** Banco SQLite, credenciais no keychain do macOS, execução
  na própria máquina. Não há servidor do Locum no meio.
- **Nada sai sem você.** Toda escrita em serviço externo passa por uma porta
  única de aprovação. Cada passo tem modo `approve`, `draft` ou `auto`, e o
  automático só faz sentido quando a medição mostra que o agent acerta.
- **Configurável sem código.** Agents, gatilhos, provedores e conexões se montam
  pela interface ou por um assistente externo (Claude Code) falando com o
  servidor MCP do próprio Locum.

O primeiro caso de uso é revisão de pull request: triagem e auditoria em modelos
diferentes, contexto de deploy opcional, convenções do time carregadas como
skill conforme os arquivos alterados, e a review parada na fila até você mandar.

## O que tem hoje

| área | o que faz |
|---|---|
| Hoje | abre o app com o que espera decisão, o que está rodando e o que terminou |
| Fila | aprovações pendentes, com o diff ou o texto que vai ser publicado, editável antes de sair |
| Agents | editor de agent em passos, com grafo de dependência, modelo por passo e orçamento; o agent também pode nascer de uma descrição em texto |
| Execuções | histórico, custo, saída de cada passo, e reexecução de um passo só |
| Iniciativas | unidade de trabalho com contexto próprio, servidores MCP escopados e sessão do Claude Code aberta com esse contexto |
| Sessões | sessões do Claude Code da máquina, com as que ficaram pela metade e as que esperam resposta |
| Gatilhos | varredura de PR no GitHub, menção no Slack e no Teams, agenda |
| Conexões | vitrine com Claude Code, GitHub, Slack pelo servidor oficial (com um app criado no seu workspace), Microsoft Teams e servidores MCP remotos (Atlassian, Linear, Notion, Sentry, Figma e outros) com OAuth de um clique; a conexão Atlassian também serve de destino para as tarefas no Jira |
| Provedores | Anthropic, OpenAI, Google e qualquer endpoint compatível com OpenAI (GLM, Ollama, OpenRouter, Groq e afins), com tabela de fallback |
| Servidor MCP | `Locum --mcp` expõe as ferramentas do Locum; o Claude Code se conecta num clique e consegue montar agent, gatilho e iniciativa conversando |

Interface em português e inglês.

### Provedores e assinatura

Há três runtimes atrás da mesma interface. O nativo usa o AI SDK e fala com
qualquer provedor por chave de API. Os outros dois executam um binário já
instalado e autenticado na máquina de quem usa, o que permite aproveitar a
própria assinatura: o Claude Code, para o plano Claude, e o `codex exec`, para o
plano ChatGPT. O Locum não embute login, não intermedeia credencial e não
redistribui acesso. Sem o binário, o runtime dele não aparece, e a tabela de
fallback manda os passos afetados para provedores por chave.

## Instalação

Baixe o `.dmg` do [release mais recente](https://github.com/RabahZeineddine/locum/releases/latest)
e arraste o `Locum.app` para `/Applications`. Hoje só há pacote para Apple
Silicon (arm64).

O pacote não é assinado pela Apple, então a primeira abertura é bloqueada pelo
Gatekeeper. Clique no aplicativo com o botão direito e escolha **Abrir**, uma vez
só. Depois disso o Locum se atualiza sozinho a cada release, por um mecanismo
próprio que não depende de certificado. Detalhes em
[docs/empacotamento.md](docs/empacotamento.md).

Para ligar num repositório de verdade (token, gatilho, primeira varredura e a
fila), siga [docs/primeira-execucao.md](docs/primeira-execucao.md).

## Desenvolvimento

Precisa de macOS e Node 22 ou mais novo. Tudo roda a partir de `app/`.

```bash
cd app
npm install
npm test             # testes unitários e de integração (node:test)
npm run verify       # typecheck, paridade de i18n, build e smoke do Electron
npm start            # build e abre o app a partir do código
```

A linha de comando usa o mesmo executor da interface e é o jeito mais rápido de
testar o núcleo sem abrir janela:

```bash
npm run dev import ../examples/agents/pr-review.json
npm run dev demo     # pipeline completo num PR sintético, sem credencial
```

Como contribuir, convenções de código e o processo de release estão em
[CONTRIBUTING.pt-BR.md](CONTRIBUTING.pt-BR.md).

## Estrutura

```
app/
  electron/     processo principal: janela, ponte com a interface, bandeja, atualização, smoke
  renderer/     interface em React, Tailwind e shadcn
  src/          núcleo: banco, executor, runtimes, provedores, MCP, serviços, gatilhos
  locales/      textos da interface em pt-BR e en
  test/         testes
  scripts/      build, checagem de i18n, release
docs/           decisões (ADR), estado atual, roadmap, guias
examples/       agents de exemplo para importar
scripts/ralph/  loop de execução autônoma sobre o backlog
```

## Documentação

| documento | conteúdo |
|---|---|
| [estado-atual.md](docs/estado-atual.md) | o que existe, o que falta e as armadilhas encontradas; comece por aqui |
| [roadmap.md](docs/roadmap.md) | marcos e iniciativas |
| [ADR 0001](docs/adr/0001-arquitetura-v2.md) | as decisões de arquitetura e as alternativas descartadas |
| [ADR 0002](docs/adr/0002-camada-de-servico-e-servidor-mcp.md) | camada de serviço, servidor MCP próprio, e por que aprovação fica fora dele |
| [ADR 0003](docs/adr/0003-interface-sobre-ai-elements.md) | interface sobre AI Elements, chat como console, e a regra contra injeção de prompt |
| [ADR 0004](docs/adr/0004-iniciativas.md) | iniciativa como unidade de trabalho, escopo MCP e contexto por proposta aprovada |
| [mcp-server.md](docs/mcp-server.md) | as ferramentas do servidor MCP e como ligar no Claude Code |
| [empacotamento.md](docs/empacotamento.md) | `.dmg`, abertura sem assinatura e atualização automática |
| [primeira-execucao.md](docs/primeira-execucao.md) | primeiro uso num repositório de verdade |
| [decisoes-da-conversa.md](docs/decisoes-da-conversa.md) | o caminho até o desenho, incluindo o que mudou de ideia |
| [pesquisa.md](docs/pesquisa.md) | o que foi verificado em documentação externa, separado de suposição |

## Licença

MIT. Veja [LICENSE](LICENSE).
