# Locum

*Locum: quem assume o seu posto enquanto você não está.*

Aplicativo para macOS que roda os seus agents em segundo plano e faz o trabalho
no seu lugar. Ele revisa, investiga, correlaciona e escreve, e quanto do
resultado sai sozinho é decisão sua: cada ação tem modo de aprovação, rascunho
ou automático, destravado por categoria conforme a medição sustenta.

Primeiro caso de uso: revisão dos pull requests do time, com triagem e auditoria
em modelos diferentes, contexto de deploy cruzado do ArgoCD, e convenções do
time carregadas como skill conforme os arquivos alterados.

## Estado

O núcleo headless funciona e foi verificado de ponta a ponta, e o aplicativo
Electron já sobe, carrega a interface e sai empacotado em `.dmg`. Tudo continua
alcançável pela linha de comando, com o mesmo executor que a interface usa.

```bash
cd app
npm install
npm run dev import ../examples/agents/pr-review.json   # o Locum não traz agent pronto
npm run dev demo     # pipeline completo num PR sintético, sem credencial
```

Detalhes em [docs/estado-atual.md](docs/estado-atual.md).

## Instalação

Não há release publicado: o pacote é gerado a partir deste repositório, numa
máquina com macOS.

```bash
cd app
npm install
npm run build
npm run dist         # .dmg e .zip em app/release/
```

Abra o `.dmg` e arraste o `Locum.app` para `/Applications`.

O pacote não é assinado pela Apple, então a primeira abertura é bloqueada pelo
Gatekeeper. O contorno é clicar no aplicativo com o botão direito e escolher
**Abrir**, uma vez só: o sistema registra a decisão e as próximas aberturas são
normais.

Duas consequências de não assinar: o início automático no login não é honrado
pelo sistema, e a atualização automática fica desligada, porque o macOS recusa
instalar atualização não assinada.

O caminho todo, incluindo o que muda com conta de desenvolvedor Apple, está em
[docs/empacotamento.md](docs/empacotamento.md).

## Provedores e assinatura

O Locum roda com dois runtimes atrás da mesma interface. O nativo usa o AI SDK e
fala com qualquer provedor por chave de API: Anthropic, OpenAI, Google, GLM,
Groq, OpenRouter, Ollama e qualquer endpoint compatível com OpenAI.

O segundo runtime executa o binário do Claude Code já instalado e autenticado na
máquina de quem usa, o que permite aproveitar a própria assinatura em vez de
gastar chave de API. O Locum não embute login, não intermedeia credencial e não
redistribui acesso: quem usa autentica a própria ferramenta, na própria máquina.
Sem o binário instalado, esse runtime simplesmente não é oferecido, e a tabela
de fallback redireciona os passos afetados para provedores por chave.

## Documentação

| documento | conteúdo |
|---|---|
| [ADR 0001](docs/adr/0001-arquitetura-v2.md) | as dez decisões de arquitetura e as alternativas descartadas |
| [decisoes-da-conversa.md](docs/decisoes-da-conversa.md) | o caminho até o desenho, incluindo o que mudou de ideia |
| [pesquisa.md](docs/pesquisa.md) | o que foi verificado na documentação externa, separado de suposição |
| [estado-atual.md](docs/estado-atual.md) | o que existe, o que falta, e as armadilhas encontradas |
| [ADR 0002](docs/adr/0002-camada-de-servico-e-servidor-mcp.md) | camada de serviço, servidor MCP próprio, e por que aprovação fica fora dele |
| [ADR 0003](docs/adr/0003-interface-sobre-ai-elements.md) | interface sobre AI Elements, chat como console, e a regra contra injeção de prompt |
| [ADR 0004](docs/adr/0004-iniciativas.md) | iniciativa como unidade de trabalho, escopo MCP, contexto por proposta aprovada, e idioma do projeto |
| [roadmap.md](docs/roadmap.md) | marcos M1 a M5, até o `.dmg`, e as iniciativas I1 a I5 |
| [empacotamento.md](docs/empacotamento.md) | como gerar o `.dmg`, abrir sem assinatura, e o que muda com conta Apple |
| [primeira-execucao.md](docs/primeira-execucao.md) | ligar num repositório de verdade: token, gatilho, primeira varredura e a fila |
| [prd.json](scripts/ralph/prd.json) | backlog como estado: tarefas atômicas com critério de pronto e comando de verificação |

## Idioma

O código usa identificadores em inglês. Comentários e documentação estão em
português enquanto o projeto é privado, e serão traduzidos antes da abertura do
repositório, junto com o guia de contribuição. A tarefa está no backlog.

## Loop de execução

O backlog vive em `scripts/ralph/prd.json` e é a fonte da verdade do que falta.
Para ler no terminal:

```bash
jq -r '.userStories[] | "\(if .passes then "[x]" else "[ ]" end) \(.id)  \(.title)"' scripts/ralph/prd.json
```

Para rodar o loop, um marco por vez:

```bash
./scripts/ralph/ralph.sh M1 12
```

Ele cria um worktree próprio em `../locum-loop`, usa um banco de rascunho
separado do real, e aborta se o código não compilar, se a árvore ficar suja, se
a branch for a principal ou se ela aparecer no remoto. O loop nunca faz push.

## Licença

MIT. Veja [LICENSE](LICENSE).

## Estrutura

```
app/            núcleo em TypeScript, o produto daqui para a frente
docs/           decisões, pesquisa, estado e roadmap
scripts/ralph/  loop de execução: script, prompt da iteração, backlog e progresso
examples/       agents de exemplo, para importar
```

O Locum começou como uma versão em Python, que saiu do repositório quando o que
ela fazia passou para o TypeScript. Quem quiser consultar acha no histórico, no
commit anterior à remoção.
