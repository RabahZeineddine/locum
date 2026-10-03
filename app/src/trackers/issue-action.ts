import type { ActionHandler } from "../approval/gate.js";
import { trackerService, type TrackerService } from "../services/tracker-service.js";
import { buildIssueProposal, TrackerIssueProposal } from "./proposal.js";

/**
 * O handler da ação `tracker.create_issue`.
 *
 * Nasce em `approve`: abrir card é o tipo de coisa que aparece assinada por
 * uma pessoa para o time dela. O automático é para o fluxo que a pessoa montou
 * e quer rodando sozinho, e só uma pessoa liga: versão escrita por agent volta
 * para `approve` ao ser gravada. Sem `draft` porque rascunho de tarefa não existe nos dois
 * trackers, e emular um criando e fechando deixaria o card no histórico.
 *
 * A montagem do item acontece em `propose`, antes de a pendência ser gravada,
 * então o que a fila mostra é exatamente o que sairia. O handler não escreve
 * prosa: o corpo vem do passo de modelo anterior, e aqui ele só ganha título,
 * seções e links.
 */
export function trackerIssueHandler(service: TrackerService = trackerService): ActionHandler {
  return {
    modes: ["approve", "auto"],

    async propose(payload, target) {
      if (target === null || target.trim().length === 0) {
        throw new Error('o passo de "tracker.create_issue" nao disse em "target" qual tracker usar');
      }

      const project = await service.defaultProject(target);
      if (project === null) {
        throw new Error(`o tracker "${target}" esta sem projeto de destino`);
      }

      return buildIssueProposal(payload, target, project);
    },

    async publish(payload) {
      const proposta = TrackerIssueProposal.parse(payload);

      // A pendência pode ficar dias na fila, e nesse tempo alguém abre a tarefa
      // à mão, ou uma segunda execução sobre o mesmo pull request é aprovada
      // antes desta. O `externalId` da gate não cobre isso: ele protege contra
      // a mesma pendência ser publicada duas vezes, e não contra duas
      // pendências para o mesmo pull request.
      const existente = await service.findIssueForPullRequest(
        proposta.tracker,
        proposta.pullRequestUrl,
        proposta.project,
      );
      if (existente !== null) return;

      await service.createIssue(proposta.tracker, {
        project: proposta.project,
        title: proposta.title,
        body: proposta.body,
        ...(proposta.labels === undefined ? {} : { labels: proposta.labels }),
        pullRequestUrl: proposta.pullRequestUrl,
      });
    },
  };
}
