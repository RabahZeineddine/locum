# ADR 0002: Camada de serviço e servidor MCP próprio

Data: 2026-09-19
Status: aceito
Complementa: ADR 0001

## Contexto

A lógica de cadastro vive hoje dentro de `src/cli.ts`. Três consumidores
diferentes vão precisar dela: a linha de comando, a interface do aplicativo, e
um servidor MCP que exponha o próprio produto a agents externos.

O pedido que motiva este registro é que a ferramenta nasça com servidor MCP, de
modo que um assistente possa configurá-la e operá-la de fora. Isso não é um
extra: enquanto a interface não existe, o servidor MCP é o que torna o produto
utilizável.

## Decisões

### 1. Camada de serviço antes de qualquer novo consumidor

Toda operação de cadastro e consulta passa a viver em serviços
(`AgentService`, `McpService`, `ProviderService`, `RunService`,
`ApprovalService`). Linha de comando, servidor MCP e interface são casca fina
sobre eles.

Sem isso, cada regra seria escrita três vezes e divergiria na terceira.

### 2. A ferramenta é cliente e servidor MCP ao mesmo tempo

Como **cliente**, ela consome GitHub, ArgoCD, Sonar e o que mais for cadastrado,
para dar ferramentas aos passos dos seus agents.

Como **servidor**, ela se expõe a agents externos por transporte stdio, lendo o
mesmo banco SQLite. O modo WAL permite leitura e escrita concorrentes com o
aplicativo aberto.

Os dois papéis são nomeados explicitamente no código e na documentação, porque
confundi-los gera desenho errado.

### 3. O servidor MCP expõe leitura, configuração e execução

Leitura: listar e detalhar agents, execuções, passos, achados, métricas,
servidores MCP cadastrados, provedores e o perfil da máquina.

Configuração: gravar versão de agent, cadastrar e testar servidor MCP, listar as
ferramentas de um servidor com contagem de tokens, definir tabela de fallback,
orçamento e gatilho.

Execução: disparar um agent contra um pull request ou contra evento sintético, e
reexecutar um passo isolado.

### 4. O servidor MCP não expõe aprovação nem publicação

`approve`, `reject` e qualquer ação que publique ficam fora, sem exceção.

O motivo é a invariante central do produto: se um agent pode aprovar, o portão
deixa de existir, porque passa a ser um agent liberando a saída de outro. A
garantia de que nada sai no nome do usuário viraria decoração. Aprovar continua
sendo ato humano, pela bandeja, pela interface ou pela linha de comando.

Gravar agent é diferente e fica permitido: toda gravação cria versão nova e
imutável, nenhuma versão entra em execução agendada sem o gatilho ser habilitado,
e o histórico permite desfazer. Editar é reversível e auditável; publicar no nome
de outra pessoa não é.

Excluir é em dois passos: primeiro arquivar, depois deletar. Arquivar (`archive_automation`, `danger`) tira os
gatilhos e o estado deles e deixa runs, aprovações, achados e versões, que são o
registro do que foi publicado em nome da pessoa e o que a dedupe de review lê.
Recusa enquanto houver run na fila ou rodando, ou aprovação pendente ou em
publicação, e, pelo MCP, quando a automação está ligada a uma iniciativa (decisão
de uma pessoa, na tela). `unarchive_automation` desfaz, sem os gatilhos. A
confirmação fica com o cliente, que pergunta a cada chamada de ferramenta `danger`.

Deletar (`delete_automation`, `danger`) só vale para a arquivada e apaga tudo que
pertence a ela, numa transação que confere dentro dela que segue arquivada: versões,
gatilhos e o estado deles, runs com passos, aprovações e achados, orçamento, gasto e
os eventos colados à mão. O agent da biblioteca e as skills ficam, por serem
compartilhados. Recusa com run na fila ou rodando, aprovação em publicação e, pelo
MCP, automação ligada a iniciativa, como o arquivar. A prévia (`deletePreview`)
vem na recusa da ferramenta, como no arquivar.

### 5. O servidor MCP antecede a interface na ordem de construção

A ordem passa a ser: camada de serviço, servidor MCP, casca Electron, interface,
empacotamento.

Com o servidor MCP pronto, a configuração completa do produto pode ser feita por
um assistente externo enquanto a interface está sendo construída. Isso transforma
a interface em conforto, não em pré-requisito, e reduz o risco de o projeto
parar antes de ser útil.

### 6. Gravar agent também não pode publicar

Emenda de 19 de setembro de 2026, escrita depois da revisão do primeiro lote de
implementação.

Não expor aprovação não bastava. O `upsert_agent` grava o spec inteiro, e um
passo de ação carrega o modo. Gravar um passo em automático e chamar `run_agent`
publicaria sem clique nenhum, contornando a decisão 4 em dois movimentos.

A gravação passa a declarar quem está gravando. Vinda de agent, todo passo de
ação em rascunho ou automático volta rebaixado para aprovação, e o rebaixamento
é declarado na resposta. Passo que já estava naquele modo na versão anterior
segue como está: uma pessoa autorizou antes, e reeditar outra parte do spec não
derruba essa autorização.

O padrão do parâmetro é agent, de modo que um ponto de chamada novo que esqueça
de declarar cai no lado restritivo.

A lição vale para o resto do projeto: a invariante não é "não existe ferramenta
de aprovar", é "nada sai sem uma pessoa ter dito que sai". Cada capacidade nova
precisa ser conferida contra a segunda formulação, não contra a primeira.

### 7. Paridade total com a tela, e a confirmação é do cliente

Emenda de 15 de outubro de 2026: por decisão do usuário, o MCP tem paridade
total com a tela; a confirmação de cada escrita é do cliente (Claude Code) pelas
anotações das ferramentas. Ele usa o Locum só pelo Claude Code, e o servidor que
recusava o que a tela faz decidia por ele. A decisão 4 fica substituída nisso:
`decide_approval` existe, pela mesma gate do executor, anotada como destrutiva e
de mundo aberto, e o Claude Code pergunta antes de cada chamada. A regra que
continua valendo é a mesma: nada sai sem uma pessoa ter dito que sai.

O rebaixamento do `upsert_agent` (passo de ação gravado como agent nasce em
`approve`) deixou de ser uma garantia do servidor. A classe da ferramenta é
declarada por quem grava, e `save_agent_edited`, `save_automation`,
`import_agent` e `restore_agent_version` gravam como a tela, com `auto`
preservado. Quem segura é a confirmação do cliente: cada uma sai anotada como
destrutiva (e, quando liga gatilho ou sai para a rede, de mundo aberto), e
`decide_approval` e `agent_chat_decide` exigem o hash do conteúdo que o cliente
viu, para a confirmação ficar amarrada a ele.

## Consequências

O cadastro de servidores MCP sai da lista fixa em `src/cli.ts` e passa para o
banco, atendido pelo `McpService`. Isso destrava o passo de contexto de deploy,
hoje pulado por ausência do ArgoCD.

O empacotamento ganha duas dependências de plataforma que precisam ser tratadas
no marco correspondente: módulo nativo recompilado para o runtime do Electron, e
assinatura com notarização para que a atualização automática funcione. Sem conta
de desenvolvedor Apple, o aplicativo ainda roda em uso pessoal, com aviso na
primeira abertura.

## Alternativas consideradas

Expor a aprovação pelo servidor MCP com um destravamento explícito por
configuração. Descartado: a exceção existiria justamente para o caso em que ela
é mais perigosa, e a invariante vale mais que a conveniência.

Construir a interface antes do servidor MCP. Descartado porque adia a
usabilidade do produto em várias semanas sem necessidade.
