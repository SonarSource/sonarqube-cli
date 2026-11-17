# Repository instructions

## Working and validation

- Use the Bun version pinned in `mise.toml`: run `mise trust`, `mise install`, then `bun install --frozen-lockfile` from the repository root.
- Use `package.json` scripts: `bun run typecheck`, `bun run lint`, `bun run test:unit`, `bun run test:integration`, `bun run test:all`, and `bun run test:e2e`. Choose checks relevant to the change; fix TypeScript errors before finishing.
- After editing TypeScript, run Prettier, then ESLint autofix: `bun x prettier --write <files>` followed by `bun x eslint --fix <files>`. Complete the implementation before addressing lint.
- Use `import type` for type-only imports. Comments should explain a non-obvious reason in one line.
- Read `tests/AGENTS.md` before writing tests, including tests added for source changes. Unit files run with `bun test <file>`; integration files require `bun run pretest:integration` first.

## Repository-wide boundaries

- Only `src/core/server/fetch.ts` may call runtime `fetch`. Use `fetchAuthenticated` for credentials and `fetchAnonymous` for credential-free CDN requests. Both resolve proxy/TLS/NO_PROXY per redirect hop; authenticated redirects must never leak credentials across origins. Do not override transport options at call sites. Outward SDK traffic must use this transport or equivalent protection. Read the API guidance below before changing network code.
- Use `InvalidOptionError` and `CommandFailedError` from `src/core/commands/command-error.ts` for production errors. Preserve `CliError.remediationHint` rendering. Test mocks may throw `Error`.
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
