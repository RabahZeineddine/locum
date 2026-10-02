# Contribuindo com o Locum

[English](CONTRIBUTING.md) · **Português**

Obrigado por ajudar. Este guia cobre o que precisa para rodar o projeto, como o
código está organizado, as regras que o projeto não abre mão e como uma mudança
chega até o aplicativo instalado.

## Antes de começar

Leia [docs/estado-atual.md](docs/estado-atual.md). Ele diz o que existe, o que
falta e, principalmente, as armadilhas que já custaram tempo. O
[roadmap](docs/roadmap.md) diz para onde o projeto vai, e os ADRs em
[docs/adr/](docs/adr/) explicam por que as coisas são como são. Mudança que
contraria um ADR é bem-vinda, mas começa por uma conversa, não por um PR.

## Ambiente

- macOS (o app usa keychain, bandeja e empacotamento do macOS)
- Node 22 ou mais novo, com npm
- opcional: o binário do Claude Code, para o runtime por assinatura e para
  testar o servidor MCP

```bash
cd app
npm install
cp .env.example .env   # só para a linha de comando; a interface guarda tudo no keychain
```

O banco fica em `~/Library/Application Support/locum`. Para não misturar com o
seu uso real, aponte `LOCUM_HOME` para outra pasta enquanto desenvolve.

## Comandos do dia a dia

Todos rodam dentro de `app/`.

| comando | o que faz |
|---|---|
| `npm start` | build e abre o app a partir do código |
| `npm test` | testes em `test/**/*.test.ts`, com `node:test` |
| `npm run typecheck` | TypeScript do processo principal e da interface |
| `npm run check:i18n` | confere se `locales/pt-BR.json` e `locales/en.json` têm as mesmas chaves |
| `npm run smoke` | sobe o Electron em modo de smoke, percorre as telas e faz o handshake MCP |
| `npm run verify` | typecheck, i18n, build e smoke de uma vez |
| `npm run dev <comando>` | linha de comando do núcleo (`import`, `demo`, `review`, `poll`, `inbox`, ...) |
| `npm run dist:dir` | empacota sem gerar `.dmg`, para testar o app empacotado |

Antes de abrir um PR, `npm test` e `npm run verify` precisam sair zero.

## Onde fica cada coisa

- `app/src/services/` é a camada de serviço. Interface, linha de comando e
  servidor MCP chamam os mesmos serviços; regra de negócio mora aqui e em mais
  nenhum lugar.
- `app/src/executor/` é a máquina de estado que roda um agent passo a passo, com
  orçamento e retomada.
- `app/src/approval/` é a porta única de saída para serviço externo.
- `app/src/runtimes/` tem o runtime nativo (AI SDK) e o do Claude Code.
- `app/src/mcp-server/` são as ferramentas que o Locum expõe por MCP.
- `app/electron/bridge-contract.ts` declara cada canal entre interface e
  processo principal; `bridge.ts` liga o canal ao serviço.
- `app/renderer/src/telas/` são as telas.

## Regras que não abrem exceção

**Escrita externa passa pela aprovação.** Nenhum código novo publica, comenta,
envia ou altera nada fora da máquina sem passar por `approval/`. Ferramenta MCP
do próprio Locum não aprova nem publica; isso é decisão do ADR 0002.

**Credencial mora no keychain.** Token, chave de API e segredo de OAuth vão pelo
`SecretService`. Nunca em banco, log, arquivo de configuração ou mensagem de
erro.

**Conteúdo de fora é dado, não instrução.** Texto de PR, mensagem de Slack ou
resposta de servidor MCP entra no prompt marcado como dado. Veja o ADR 0003.

**Todo texto da interface vem do i18n.** Nada de string literal na tela. Chave
nova entra nos dois arquivos de `locales/`, e o `check:i18n` cobra.

**Tela nova ou mudada entra no smoke.** O smoke em `electron/main.ts` procura
marcadores `data-locum-*` nas telas. Se a sua mudança move um elemento que ele
procura, ajuste o smoke junto.

**Sem dado de empresa no repositório.** Exemplo, fixture e teste usam nomes
genéricos. Nada de nome de cliente, repositório interno, URL corporativa ou
token de verdade.

## Estilo

- Identificadores em inglês. Comentários, documentação e mensagens de commit em
  português.
- Comentário explica o porquê, não repete o que o código diz.
- Siga o jeito do arquivo que você está mexendo antes de qualquer preferência
  pessoal.
- Teste novo segue o padrão dos que existem: banco e cofre de rascunho em pasta
  temporária, serviço externo falso subindo em `127.0.0.1`.

## Commits e PRs

- Um ramo por assunto, saindo do `main`.
- Mensagem no formato `tipo: o que mudou`, com `feat`, `fix`, `chore`, `docs`,
  `refactor` ou `test`. Exemplo: `feat: vitrine de conexões com OAuth de um
  clique`.
- PR pequeno e com um assunto só. A descrição diz o que muda, por que, e como
  você verificou.
- Se a mudança altera o que existe ou o que falta, atualize
  `docs/estado-atual.md` no mesmo PR.

## Release

Release é feita pelo mantenedor, a partir do `main`:

```bash
cd app
npm run release              # patch: 0.1.4 vira 0.1.5
npm run release -- minor
npm run release -- --dry-run # tudo menos commit, push e publicação
```

O script exige árvore limpa e `main` igual ao `origin/main`, recusa se houver um
Locum aberto a partir de `app/release/`, roda a bateria inteira, empacota e
publica o release no GitHub com o `locum-update.json`. Os apps instalados pegam a
versão nova sozinhos.

## Dúvida ou ideia

Abra uma issue descrevendo o problema antes de escrever muito código. Para
mudança de desenho, uma issue curta com o que você quer mudar e por quê poupa
retrabalho dos dois lados.
