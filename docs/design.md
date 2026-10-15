# Design

Referência: Linear e Raycast. Denso e calmo.

## Regras

- Corpo de 13px (`text-[13px]`), título de página 22px, seção 13px em peso 500. Escala de espaço de 4px.
- Linha de lista de 36 a 44px (`ListRow` dentro de `ListGroup`), não cartão grande.
- Três camadas quase pretas: `--background`, `--card` (painel), `--popover` (elevado). Borda de 1px com `--border`. Sem gradiente nem sombra de cartão.
- Um acento só: `--primary` (violeta). Botão primário sólido, secundário com borda, terciário fantasma. `.ia-gradiente` e `.ia-texto` existem só para telas antigas e agora são planos.
- Estado é ponto colorido (`StatusDot`: ok, aviso, erro, ocioso) com texto neutro. Cor nunca no texto. Selo (`Badge`) pequeno e neutro.
- Números com `.num` (tabular). Mono só para nome técnico (repo, branch, comando).
- Teclado primeiro: ⌘K (`paleta.tsx`), `/` em Conexões, `Kbd` para mostrar atalho.
- Tokens em `renderer/src/index.css`. O modo claro herda o bloco `:root`, ainda sem acerto.

## Componentes

Button, Badge, Card, Input, Tabs, ListRow/ListGroup, Kbd, StatusDot, EmptyState, CabecalhoDaTela.
