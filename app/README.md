# Locum, aplicativo

Código do aplicativo: processo principal do Electron, interface e núcleo. Visão
geral do projeto no [README da raiz](../README.md); ambiente, comandos e regras
de contribuição no [CONTRIBUTING.md](../CONTRIBUTING.md).

## Linha de comando

O núcleo roda sem janela, com o mesmo executor que a interface usa. Útil para
testar um agent ou um passo sem abrir o app.

```bash
cp .env.example .env    # GITHUB_TOKEN e MACHINE_ID, só para a linha de comando
npm run dev import ../examples/agents/pr-review.json
npm run dev demo                     # pipeline completo num PR sintético, sem credencial
npm run dev review owner/repo#123    # revisa um PR de verdade
npm run dev inbox                    # fila de aprovação
npm run dev approve <id>
npm run dev poll 'api-.*'            # varredura de PRs nos repos de GITHUB_OWNER que casam
npm run dev resume                   # retoma execução interrompida
```

A varredura usa cursor de tempo, não intervalo fixo, então uma janela perdida
com a máquina dormindo é recuperada na próxima execução. O índice único de
evento impede que o mesmo commit seja revisado duas vezes.

## Máquina sem assinatura

Os passos podem declarar modelos do runtime `claude-code`. Numa máquina sem o
binário do Claude Code, a tabela `model_fallbacks` redireciona para modelos por
chave de API. A definição do agent não muda.

## Estrutura

```
electron/       janela, ponte com a interface, bandeja, atualização, smoke
renderer/       interface em React, Tailwind e shadcn
src/
  db/           schema e conexão SQLite
  config/       AgentSpec em zod, herança de ferramentas, ordenação topológica
  services/     camada de serviço, usada por interface, linha de comando e MCP
  executor/     máquina de estado durável e orçamento
  approval/     porta única de saída
  runtimes/     native (AI SDK) e claude-code (assinatura)
  providers/    registro de provedores e resolução de fallback
  mcp/          servidores MCP sob demanda, encerrados após ocioso
  mcp-server/   ferramentas que o próprio Locum expõe por MCP
  sources/      GitHub: ingestão determinística e ação de review
  triggers/     varredura, Slack e agenda
  skills/       descoberta no acervo e seleção por regra de arquivo
  update/       atualização automática sem certificado
locales/        textos da interface em pt-BR e en
test/           testes
```
