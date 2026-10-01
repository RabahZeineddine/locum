import prReview from "../../../examples/agents/pr-review.json";
import slackDigest from "../../../examples/agents/slack-digest.json";
import slackReply from "../../../examples/agents/slack-reply.json";
import teamsReply from "../../../examples/agents/teams-reply.json";
import { AgentSpec } from "../config/types.js";

/**
 * Os agents de exemplo, lidos de `examples/agents/` na raiz do repositório.
 *
 * O Locum não traz agent de fábrica: o banco nasce vazio e cada pessoa importa
 * os seus. Estes arquivos são o que alguém importaria para começar, e moram fora
 * do app para deixar isso claro. Entram aqui para os testes, as fumaças e o
 * `demo` da linha de comando, que precisam de um agent conhecido, e para a
 * resposta pronta de `REPLY_SPECS`.
 *
 * Passar pelo `AgentSpec.parse` na carga faz o exemplo quebrado falhar no
 * teste, e não na mão de quem o importou.
 */
export const prReviewSpec = AgentSpec.parse(prReview);
export const slackDigestSpec = AgentSpec.parse(slackDigest);
export const slackReplySpec = AgentSpec.parse(slackReply);
export const teamsReplySpec = AgentSpec.parse(teamsReply);

/**
 * A resposta pronta de cada conversa, que a tela da conexão oferece para quem
 * ainda não tem agent nenhum que responda. É a única gravação feita a partir
 * deste módulo, e só acontece no clique de quem conectou.
 */
export const REPLY_SPECS = { slack: slackReplySpec, teams: teamsReplySpec } as const;
