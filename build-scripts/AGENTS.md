# Builds and releases

- Use `bun run build:binary` for standalone releases. `build-binary.ts` injects the distribution and version; keep `autoloadDotenv: false` and `autoloadBunfig: false` so executables never load working-directory configuration implicitly.
- The only supported distribution is `standalone`. Use `PROJECT_VERSION`, falling back to `package.json` locally; Sentry's release must match the source-map upload version.
- Release platforms are Linux x86-64/arm64, macOS arm64, and Windows x86-64. Current CLI CDN artifacts use `.bin` on Linux/macOS and `.exe` on Windows; historical CLI releases may use `.exe` everywhere. Dependency artifact suffixes are defined separately and must not be inferred from CLI conventions.
- Preserve `full-release.yml`'s post-release update of the installers' literal compatibility version marker. Read [installer guidance](../user-scripts/AGENTS.md) when changing release publication.
- Keep dependency setup portable: Husky runs through its JavaScript entry point with Bun, rather than platform-specific `.bin` shims.
- Use the coverage scripts in `package.json`; direct Bun LCOV output reports non-executable lines incorrectly. Read [test guidance](../tests/AGENTS.md) for test resources and coverage.
- Docs generation belongs to post-release automation. Read [docs guidance](../docs/AGENTS.md) before changing the generator; do not hand-edit its outputs.
