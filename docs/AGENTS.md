# Documentation site

- `commands.json`, `llms.txt`, and `sitemap.xml` are generated from CLI source by post-release automation. Do not edit them by hand or regenerate them for routine command changes.
- The generator also stamps the release version into navigation badges, JSON-LD `softwareVersion`, and `meta-version`; preserve a single release-derived version source.
- Keep `<base href="/sonarqube/cli/">` in site HTML. Assets and internal links resolve under the production mount point; previews served at `/` do not override this contract.
- Developer references live under `development/`. Follow [the instruction maintenance policy](development/agent-instructions.md) for agent guidance; move only unique design rationale into references, not implementation inventories.
