# Repository instructions

`sonar` is a Bun/TypeScript CLI for SonarQube Server and Cloud. Commands live in `src/commands/`; `createCommandTree()` registers them in `src/commands/command-tree.ts`. The entry point is `src/index.ts`.

## Working and validation

- Use `package.json` scripts: `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:integration`, `bun run test:all`, and `bun run test:e2e`. Choose checks relevant to the change; fix TypeScript errors before finishing.
- After editing TypeScript, run Prettier, then ESLint autofix: `bun x prettier --write <files>` followed by `bun x eslint --fix <files>`. Complete the implementation before addressing lint.
- Use `import type` for type-only imports. Comments should explain a non-obvious reason in one line.
- Read `tests/AGENTS.md` before writing tests, including tests added for source changes. Unit files run with `bun test <file>`; integration files require `bun run pretest:integration` first.

## Repository-wide boundaries

- Only `src/core/server/fetch.ts` may call runtime `fetch`. Use `fetchAuthenticated` for credentials and `fetchAnonymous` for credential-free CDN requests. Both resolve proxy/TLS/NO_PROXY per redirect hop; authenticated redirects must never leak credentials across origins. Do not override transport options at call sites. Outward SDK traffic must use this transport or equivalent protection. Read the API guidance below before changing network code.
- Production errors use `src/core/commands/command-error.ts`: `InvalidOptionError` exits 2; `CommandFailedError` exits 1 by default or its explicit code; other errors exit 1. Preserve `CliError.remediationHint` rendering. Test mocks may throw `Error`.
- Maintain instructions under [the instruction policy](docs/development/agent-instructions.md). Ordinary feature work does not require an instruction update.

## Read before editing the relevant area

Paths are repository-relative. Read the applicable canonical files explicitly, including when starting at the root; descendant guidance is not automatically loaded by every client.

- Commands: `src/commands/AGENTS.md`; shared UI: `src/commands/components/AGENTS.md`; quality gates: `src/commands/quality-gate/AGENTS.md`.
- Integrations and their runtime `hook/`, `context/`, and `analyze/` handlers: `src/commands/integrate/AGENTS.md`; declarative resources/dependencies: `src/core/framework/AGENTS.md`.
- State, auth, project discovery, config, keychain, lookup paths, recorded-feature resolution, and caller-agent detection: `docs/development/agent-guidance/state-and-auth.md`.
- HTTP, shared or command-local API clients, and Vortex entitlement: `docs/development/agent-guidance/sonarqube-api.md`.
- Telemetry and Sentry: `src/core/telemetry/AGENTS.md`; local statistics: `src/core/stats/AGENTS.md`; updates and migrations: `src/core/update/AGENTS.md`.
- Dependency installation: `src/core/host/install/AGENTS.md`; builds/releases: `build-scripts/AGENTS.md`; installers: `user-scripts/AGENTS.md`.
- Tests: `tests/AGENTS.md`; docs site: `docs/AGENTS.md`; Harbor benchmarks and their workflow: `benchmarks/harbor/README.md`.

<!-- sonar:begin:sonarqube-agentic-analysis-protocol -->
# Vortex analysis protocol

These instructions were installed by `sonar integrate` at the user's request. Vortex analysis checks the final change set for issues before you reply.

At the end of a turn that changed file contents in the workspace (create, edit, patch, or format), run Vortex analysis before your final reply or handoff. Analyze all files changed in the turn in one command.

Pass each modified path with `--file`, relative to the project root (for example, `src/foo.ts`). Use `--depth DEEP` even for one file so the analysis includes cross-file findings.

```bash
sonar analyze agentic --depth DEEP --file <path/to/file1> --file <path/to/file2>
```

If you cannot reliably list every modified path, analyze the git change set with DEEP depth:

```bash
sonar analyze agentic --depth DEEP
```

Per-edit hooks use faster STANDARD analysis. The end-of-turn check uses DEEP depth, including when only one file changed.

After the analysis:

1. If no project is configured, stop analysis attempts for this session. A routine skip needs no mention in the final reply unless the user asks about Vortex analysis. If the user asks for Vortex analysis or configures a project, run the analysis again and report any error.
2. If analysis finds issues on lines you changed this turn, fix them and re-run the same scope. Continue until no touched-line findings remain. Leave findings on untouched lines to their existing owners unless the user asks you to address them.
3. If analysis is skipped for another reason (for example, no SonarQube Cloud connection), state the reason once in your reply and continue without retrying this session.
4. Include any remaining Vortex findings verbatim in your reply.
<!-- sonar:end:sonarqube-agentic-analysis-protocol -->
