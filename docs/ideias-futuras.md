# Ideias futuras

Registro de features desejadas que ainda não viraram plano. Cada uma precisa
de refinamento antes de entrar em fatia.

## Locum Pro: automações rodando no servidor

**O problema.** O Locum roda no Mac. Mac fechado (viagem, oito horas de voo)
é Locum parado: gatilho não acorda, fila não anda, nada trabalha sozinho.

**A ideia.** Um serviço do lado do servidor, sem janela, que roda agents e
automações de todos os usuários com o plano Pro. Não é um Locum por cliente
num servidor: é um serviço multiusuário, hospedado e operado por nós.

**O que precisa refinar:**

- **Multiusuário de verdade.** Hoje o banco é SQLite local de uma pessoa, e o
  segredo mora no keychain do Mac. No servidor:
  - cada usuário tem seus agents, automações, execuções e credenciais
    isolados;
  - fila de execução compartilhada com limite por usuário;
  - cofre de segredo por usuário.
- **Mesmo motor.** O executor (`src/`) é Node puro e não depende do Electron.
  O modo sem janela reaproveita o executor, a gate e os handlers. O que muda é
  a camada de dados e de segredo.
- **Sincronia com o app.** O Mac continua sendo onde a pessoa monta e aprova.
  Precisa decidir:
  - se a fonte da verdade passa a ser o servidor, com o app como cliente;
  - ou se cada automação diz onde roda (Mac ou nuvem).
- **Acesso fora da VPN.**
  - SaaS público (Slack, Teams pelo Graph, GitHub, Jira cloud) roda no
    servidor sem problema.
  - Sistema só da rede interna não alcança. Caminho provável: marcar servidor
    MCP como "só na rede interna". Passo que depende dele fica para quando o
    Mac da pessoa estiver online, que roda esse pedaço e devolve.
- **Aprovar de longe.** Com tudo em "Aprovar antes", o Pro só ajuda se a fila
  andar fora do Mac: fila no celular (web simples ou notificação com aprovar e
  recusar).
- **Dados de empresa.** Usuário que conecta Slack, Jira ou código da empresa
  leva esse dado para o servidor. Precisa de política clara, termos e,
  provavelmente, opção de manter certos apps só no Mac.
- **OAuth.** Token renovado no servidor, e não mais pelo app. Cada provedor
  precisa aceitar o redirecionamento do serviço.
- **Custo.** Execução de modelo por chave do usuário (como hoje) ou por
  assinatura nossa, com teto por plano.

## Locum self-hosted: a empresa sobe, cada pessoa tem o seu

**A ideia.** O mesmo serviço do Locum Pro, só que a empresa hospeda. A Akad,
por exemplo, sobe o Locum na própria infraestrutura. Cada pessoa entra com o
login da empresa e monta os próprios agents, automações e iniciativas. É
multiusuário por pessoa, dentro de uma organização.

**Por que pode vir antes do Pro.** Resolve dois pontos difíceis do Pro:
- **Dado de empresa:** ele não sai da casa. O servidor fica na rede da
  empresa, e o sistema interno (backoffice, InsureMO, ArgoCD) fica ao alcance
  sem VPN pessoal.
- **Credencial de modelo:** é da empresa, por gateway, Bedrock ou chave
  corporativa. Não depende da assinatura de ninguém.

**O que precisa refinar:**

- **Login e organização.**
  - SSO pelo provedor da empresa: Entra ID, Google ou OIDC genérico.
  - Uma instalação, uma organização, para começar.
  - Papel de admin: decide quais apps e modelos existem, o teto de gasto e as
    regras que valem para todos. Exemplo: o que sai para o Slack sempre pede
    aprovação.
- **O que é da pessoa e o que é da empresa.**
  - **Da pessoa:** agents, automações, iniciativas, fila e credenciais
    pessoais (OAuth do Slack, do M365, do GitHub em nome dela).
  - **Da empresa:**
    - servidores MCP compartilhados, cadastrados uma vez pelo admin (New
      Relic, Waroom, backoffice);
    - toolsets e agents da biblioteca publicados para todos, como o
      `pr-review` da squad;
    - prompts e regras da casa.
  - **Compartilhar:** uma pessoa publica um agent ou toolset para o time, e
    quem usa recebe a versão nova. É a biblioteca de hoje, com dono e
    visibilidade.
- **Assinatura não vale aqui.** Os termos não permitem oferecer o login do
  claude.ai a terceiros. No servidor, o modelo vem só por API, via gateway ou
  provedor da empresa. Conectores do claude.ai e o runtime de assinatura ficam
  no Locum do Mac, que segue existindo.
- **O app do Mac.** Ele vira cliente do servidor da empresa e mantém o motor
  local para o que só o Mac alcança: assinatura, terminal embutido, arquivo
  local, rede da casa da pessoa. A automação diz onde roda, como no Pro.
- **Mesmo motor, outra camada de dados.**
  - O banco troca de SQLite para Postgres, com `user_id` em tudo e consultas
    sempre escopadas.
  - O cofre troca de keychain para cofre do servidor: KMS, Vault ou Secrets
    Manager.
  - O executor, a gate e os handlers já são Node puro (`src/`) e servem igual.
- **Fila e aprovação na web.** O que hoje é tela do Electron vira página. A
  aprovação continua sendo clique da pessoa, agora também pelo celular.
- **Auditoria.** A empresa precisa ver quem rodou o quê, com qual
  credencial, e o que saiu para fora. As execuções e as decisões da fila já
  são esse registro; falta expor ao admin.
- **Isolamento de execução.** Agent de uma pessoa não enxerga dado nem
  ferramenta de outra:
  - processo ou contêiner por execução;
  - servidor MCP stdio subindo com a credencial de quem pediu, nunca
    compartilhado entre usuários.
- **Entrega.** Imagem de contêiner e chart Helm, para subir no EKS do jeito
  que o OneUptime subiu, com as configurações por variável de ambiente.

**Relação com o Pro.** O self-hosted e o Pro são o mesmo serviço. O Pro é a
instalação que nós operamos, com várias organizações. Construir o
self-hosted primeiro, com uma organização só, deixa o multi-organização para
quando houver mais de um cliente.

## Locum Deck: plugin de Stream Deck

**Inspiração.** Plugin de Stream Deck para Claude Code, que mostra:
- o uso do plano (cinco horas e semanal);
- as sessões ativas e qual está esperando;
- botões de permitir e negar;
- atalhos para abrir projeto e colar prompt.

**O que o Locum põe nas teclas:**

- **Fila:** contagem de pendências. Apertar abre a próxima, com teclas de
  aprovar e recusar. É decisão física da pessoa, cabe na regra da gate.
- **Executar agora** por automação. O ícone acende enquanto roda e fica
  vermelho se falhar.
- **Pausa geral:** desliga todos os gatilhos (reunião, viagem) e religa os
  mesmos depois.
- **Gasto do dia** contra o teto, e o uso do plano do Claude.
- **Sessões do Claude** que o Locum já classifica: qual espera você. Apertar
  foca a janela.
- **Iniciativa em foco:** abre o contexto e mostra os runs dela.
- **Prompt salvo:** cola um prompt da biblioteca na sessão em foco.

**Técnica.**
- Plugin Node do SDK do Stream Deck.
- Fala com o Locum por uma API local em localhost, com token gerado pelo app.
  Essa API não existe hoje: o app só tem a ponte interna da janela e o MCP por
  stdio.
- A API local serve também a outros clientes (atalho do Raycast, widget).
  Aprovar por ela continua passando pela gate.

**Tamanho.** Uma ou duas fatias, porque usa tudo que já existe. Uma fatia para
a API local, outra para o plugin.
