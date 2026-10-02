# Locum

**English** · [Português](README.pt-BR.md)

*Locum: the one who covers your post while you are away.*

A macOS app that runs AI agents in the background and takes over part of the
engineering work for you: it reviews pull requests, investigates, pulls context
from several tools and writes the draft. Nothing an agent produces goes out on
its own. Every action that writes to an outside service (commenting on GitHub,
replying in Slack, touching a card) stops in a queue and waits for your
approval.

## Why it exists

AI assistants today are conversations: you open one, ask, wait, copy. The
repetitive work of looking after a team (reading every incoming PR, following
the channel, remembering the stalled card) is still pulled by hand.

Locum flips that. You describe the work once, as an agent with steps, models
and tools, and say when it runs: a new PR, a message in a channel, a schedule.
It runs by itself, on your machine, and delivers the result to a queue where
you approve, adjust or discard it.

Three principles drive the design:

- **Local first.** SQLite database, credentials in the macOS keychain,
  execution on your own machine. There is no Locum server in the middle.
- **Nothing leaves without you.** Every write to an outside service goes
  through a single approval gate. Each step has an `approve`, `draft` or `auto`
  mode, and automatic only makes sense once measurement shows the agent gets it
  right.
- **Configurable without code.** Agents, triggers, providers and connections
  are set up in the interface or by an external assistant (Claude Code) talking
  to Locum's own MCP server.

The first use case is pull request review: triage and audit on different
models, optional deploy context, team conventions loaded as skills based on the
files changed, and the review held in the queue until you send it.

## What it does today

| area | what it does |
|---|---|
| Today | opens the app on what needs a decision, what is running and what finished |
| Queue | pending approvals, with the diff or the text that will be published, editable before it goes out |
| Agents | step-based agent editor with a dependency graph, a model per step and a budget; an agent can also be drafted from a plain description |
| Runs | history, cost, output of each step, and rerunning a single step |
| Initiatives | a unit of work with its own context, scoped MCP servers and a Claude Code session opened with that context |
| Sessions | the machine's Claude Code sessions, including the ones left halfway and the ones waiting for an answer |
| Triggers | GitHub PR polling, mentions in Slack and Microsoft Teams, schedules |
| Connections | a catalog with Claude Code, GitHub, Slack through the official server (with an app created in your workspace), Microsoft Teams, and remote MCP servers (Atlassian, Linear, Notion, Sentry, Figma and others) with one-click OAuth; the Atlassian connection also works as the destination for Jira issues |
| Providers | Anthropic, OpenAI, Google and any OpenAI-compatible endpoint (GLM, Ollama, OpenRouter, Groq and the like), with a fallback table |
| MCP server | `Locum --mcp` exposes Locum's tools; Claude Code connects in one click and can build agents, triggers and initiatives by conversation |

Interface in English and Portuguese.

### Providers and subscription

There are three runtimes behind the same interface. The native one uses the AI
SDK and talks to any provider through an API key. The other two run a binary
already installed and signed in on the user's machine, which lets you use your
own subscription: Claude Code for a Claude plan, and `codex exec` for a ChatGPT
plan. Locum does not embed a login, does not broker credentials and does not
resell access. Without the binary, its runtime does not show up, and the
fallback table sends the affected steps to key-based providers.

## Installation

Download the `.dmg` from the [latest release](https://github.com/RabahZeineddine/locum/releases/latest)
and drag `Locum.app` into `/Applications`. Only Apple Silicon (arm64) builds
exist for now.

The package is not signed by Apple, so Gatekeeper blocks the first launch.
Right-click the app and choose **Open**, once. After that Locum updates itself
on every release, through its own mechanism that does not depend on a
certificate. Details in [docs/empacotamento.md](docs/empacotamento.md)
(Portuguese).

To hook it up to a real repository (token, trigger, first poll and the queue),
follow [docs/primeira-execucao.md](docs/primeira-execucao.md) (Portuguese).

## Development

Requires macOS and Node 22 or newer. Everything runs from `app/`.

```bash
cd app
npm install
npm test             # unit and integration tests (node:test)
npm run verify       # typecheck, i18n parity, build and Electron smoke test
npm start            # build and open the app from source
```

The command line uses the same executor as the interface and is the fastest way
to exercise the core without opening a window:

```bash
npm run dev import ../examples/agents/pr-review.json
npm run dev demo     # full pipeline on a synthetic PR, no credentials needed
```

How to contribute, code conventions and the release process are in
[CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
app/
  electron/     main process: window, bridge to the interface, tray, updates, smoke test
  renderer/     React, Tailwind and shadcn interface
  src/          core: database, executor, runtimes, providers, MCP, services, triggers
  locales/      interface strings in pt-BR and en
  test/         tests
  scripts/      build, i18n check, release
docs/           decisions (ADR), current state, roadmap, guides
examples/       example agents to import
scripts/ralph/  autonomous execution loop over the backlog
```

## Documentation

The documents are in Portuguese.

| document | content |
|---|---|
| [estado-atual.md](docs/estado-atual.md) | what exists, what is missing and the pitfalls found; start here |
| [roadmap.md](docs/roadmap.md) | milestones and initiatives |
| [ADR 0001](docs/adr/0001-arquitetura-v2.md) | the architecture decisions and the alternatives ruled out |
| [ADR 0002](docs/adr/0002-camada-de-servico-e-servidor-mcp.md) | service layer, Locum's own MCP server, and why approval stays out of it |
| [ADR 0003](docs/adr/0003-interface-sobre-ai-elements.md) | interface on AI Elements, chat as a console, and the rule against prompt injection |
| [ADR 0004](docs/adr/0004-iniciativas.md) | initiatives as a unit of work, MCP scope and context changed only by approved proposals |
| [mcp-server.md](docs/mcp-server.md) | the MCP server tools and how to connect Claude Code |
| [empacotamento.md](docs/empacotamento.md) | `.dmg`, opening without a signature and automatic updates |
| [primeira-execucao.md](docs/primeira-execucao.md) | first use on a real repository |
| [decisoes-da-conversa.md](docs/decisoes-da-conversa.md) | the path to the design, including what changed along the way |
| [pesquisa.md](docs/pesquisa.md) | what was checked against external documentation, kept apart from assumptions |

## License

MIT. See [LICENSE](LICENSE).
