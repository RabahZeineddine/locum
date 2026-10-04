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
