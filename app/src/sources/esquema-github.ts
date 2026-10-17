import type { EsquemaJson } from "../config/referencias.js";

/**
 * O formato do evento de um pull request, como `contextFromPr` (github.ts) o
 * monta. Fica em arquivo puro, sem Octokit nem banco, porque a tela e o MCP leem
 * este esquema para oferecer `{{event.campo}}`; o teste confere que o que a
 * fonte emite valida contra ele.
 */
export const CAMPOS_DO_PR: Record<string, EsquemaJson> = {
  repo: { type: "string", description: "Repository as owner/name." },
  owner: { type: "string", description: "Owner of the repository." },
  repoName: { type: "string", description: "Repository name, without the owner." },
  pull: { type: "number", description: "Pull request number." },
  title: { type: "string", description: "Pull request title." },
  description: { type: "string", description: "Pull request description." },
  headSha: { type: "string", description: "Commit at the head of the pull request." },
  changedFiles: { type: "array", items: { type: "string" }, description: "Paths of the changed files." },
  diff: { type: "string", description: "The diff, cut at the size limit." },
  omittedFiles: { type: "array", items: { type: "object", properties: { file: { type: "string" }, reason: { type: "string" } } }, description: "Files left out of the diff." },
  omittedSummary: { type: "string", description: "What was left out of the diff, in plain text." },
  ci: {
    type: "object",
    properties: { state: { type: "string" }, summary: { type: "string", description: "Checks result in plain text." }, checks: { type: "array", items: { type: "object" } } },
    description: "Checks of the head commit.",
  },
  author: { type: "string", description: "Who opened the pull request." },
  baseBranch: { type: "string", description: "Branch the pull request goes into." },
  headBranch: { type: "string", description: "Branch the pull request comes from." },
  url: { type: "string", description: "Address of the pull request." },
  additions: { type: "number", description: "Lines added." },
  deletions: { type: "number", description: "Lines removed." },
  fileCount: { type: "number", description: "Number of changed files." },
  draft: { type: "boolean", description: "Whether the pull request is a draft." },
  state: { type: "string", description: "open or closed." },
  merged: { type: "boolean", description: "Whether it was merged." },
};

/** Os campos que todo evento de PR traz (o resto depende do GitHub responder). */
const SEMPRE_NO_PR = ["repo", "owner", "repoName", "pull", "title", "description", "headSha", "changedFiles", "diff", "author", "url"];

/** Evento do gatilho `poll` do GitHub. */
export const ESQUEMA_DO_EVENTO_DE_PR: EsquemaJson = { type: "object", properties: CAMPOS_DO_PR, required: SEMPRE_NO_PR };

/** Os campos que `prOwner`/`prRepo`/`prNumber` e a lista de PRs somam quando o evento vem de link de PR. */
export const CAMPOS_DO_LINK_DE_PR: Record<string, EsquemaJson> = {
  prOwner: { type: "string", description: "Owner of the first pull request of the message." },
  prRepo: { type: "string", description: "Repository name of the first pull request." },
  prNumber: { type: "number", description: "Number of the first pull request." },
  prLinks: { type: "array", items: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull: { type: "number" } } }, description: "Every pull request the message links to." },
  prs: { type: "array", items: { type: "object", properties: { ...CAMPOS_DO_PR, prOwner: { type: "string" }, prRepo: { type: "string" }, prNumber: { type: "number" } } }, description: "The context of every pull request the message links to." },
  prsTexto: { type: "string", description: "One readable block per pull request, ready for a prompt." },
  prsFalharam: { type: "string", description: "Pull requests that could not be read, when some failed." },
  prsCortados: { type: "number", description: "How many links stayed out of the limit." },
  prsLimite: { type: "number", description: "The limit of pull requests per message." },
};
