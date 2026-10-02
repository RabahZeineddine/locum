# Contributing to Locum

**English** · [Português](CONTRIBUTING.pt-BR.md)

Thanks for helping. This guide covers what you need to run the project, how the
code is organized, the rules the project does not bend on, and how a change
reaches the installed app.

## Before you start

Read [docs/estado-atual.md](docs/estado-atual.md). It says what exists, what is
missing and, above all, the pitfalls that have already cost time. The
[roadmap](docs/roadmap.md) says where the project is going, and the ADRs in
[docs/adr/](docs/adr/) explain why things are the way they are. A change that
goes against an ADR is welcome, but it starts with a conversation, not a PR.
The project documents are in Portuguese.

## Environment

- macOS (the app uses the macOS keychain, tray and packaging)
- Node 22 or newer, with npm
- optional: the Claude Code binary, for the subscription runtime and to test the
  MCP server

```bash
cd app
npm install
cp .env.example .env   # only for the command line; the interface keeps everything in the keychain
```

The database lives in `~/Library/Application Support/locum`. To keep it apart
from your real use, point `LOCUM_HOME` to another folder while you develop.

## Everyday commands

All of them run inside `app/`.

| command | what it does |
|---|---|
| `npm start` | build and open the app from source |
| `npm test` | tests in `test/**/*.test.ts`, with `node:test` |
| `npm run typecheck` | TypeScript for the main process and the interface |
| `npm run check:i18n` | checks that `locales/pt-BR.json` and `locales/en.json` have the same keys |
| `npm run smoke` | starts Electron in smoke mode, walks through the screens and does the MCP handshake |
| `npm run verify` | typecheck, i18n, build and smoke in one go |
| `npm run dev <command>` | the core's command line (`import`, `demo`, `review`, `poll`, `inbox`, ...) |
| `npm run dist:dir` | packages without building a `.dmg`, to test the packaged app |

Before opening a PR, `npm test` and `npm run verify` must exit with zero.

## Where things live

- `app/src/services/` is the service layer. The interface, the command line and
  the MCP server call the same services; business rules live here and nowhere
  else.
- `app/src/executor/` is the state machine that runs an agent step by step, with
  budget and resume.
- `app/src/approval/` is the single exit to outside services.
- `app/src/runtimes/` holds the native runtime (AI SDK) and the subscription ones
  (Claude Code and Codex).
- `app/src/mcp-server/` holds the tools Locum exposes over MCP.
- `app/electron/bridge-contract.ts` declares each channel between the interface
  and the main process; `bridge.ts` wires the channel to the service.
- `app/renderer/src/telas/` holds the screens.

## Rules without exceptions

**External writes go through approval.** No new code publishes, comments, sends
or changes anything outside the machine without going through `approval/`.
Locum's own MCP tools neither approve nor publish; that is the decision in
ADR 0002.

**Credentials live in the keychain.** Tokens, API keys and OAuth secrets go
through `SecretService`. Never in the database, a log, a config file or an error
message.

**Outside content is data, not instructions.** PR text, a Slack message or an
MCP server response enters the prompt marked as data. See ADR 0003.

**Every interface string comes from i18n.** No string literals on screen. A new
key goes into both files in `locales/`, and `check:i18n` enforces it.

**New or changed screens go into the smoke test.** The smoke test in
`electron/main.ts` looks for `data-locum-*` markers on the screens. If your
change moves an element it looks for, adjust the smoke test with it.

**No company data in the repository.** Examples, fixtures and tests use generic
names. No customer names, internal repositories, corporate URLs or real tokens.

## Style

- Identifiers in English. Comments, documentation and commit messages in
  Portuguese, for now.
- A comment explains why, it does not repeat what the code says.
- Follow the style of the file you are touching before any personal
  preference.
- A new test follows the pattern of the existing ones: scratch database and
  vault in a temporary folder, fake outside service listening on `127.0.0.1`.

## Commits and PRs

- One branch per topic, off `main`.
- Message in the form `type: what changed`, with `feat`, `fix`, `chore`,
  `docs`, `refactor` or `test`. Example: `feat: vitrine de conexões com OAuth de
  um clique`.
- Small PRs with a single topic. The description says what changes, why, and
  how you checked it.
- If the change alters what exists or what is missing, update
  `docs/estado-atual.md` in the same PR.

## Release

Releases are made by the maintainer, from `main`:

```bash
cd app
npm run release              # patch: 0.1.4 becomes 0.1.5
npm run release -- minor
npm run release -- --dry-run # everything except commit, push and publishing
```

The script requires a clean tree and `main` equal to `origin/main`, refuses to
run if a Locum started from `app/release/` is open, runs the full battery,
packages, and publishes the GitHub release with `locum-update.json`. Installed
apps pick up the new version on their own.

## Questions or ideas

Open an issue describing the problem before writing a lot of code. For a design
change, a short issue with what you want to change and why saves rework on both
sides.
