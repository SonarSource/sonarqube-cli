# Refinement: One-Command Onboarding

**Status:** Refinement  
**Date:** 2026-07-08  
**Audience:** SQ CLI team, integrators, reviewers  

---

## 1. Context

SonarQube CLI (`sonar`) integrates SonarQube Server/Cloud into developer AI workflows through `**sonar integrate <agent>**` — a per-agent, optionally per-project installer that writes hooks, MCP config, instruction files, and skills into agent-specific directories.

The intended golden path today is:

```bash
sonar auth login
sonar integrate cursor    # from each repo, or with --global
```

In practice, developers:

- Work across many repositories and agents (Cursor, Claude Code, Codex, Copilot, Antigravity).
- Do not know whether to use **project** vs **global** scope.
- Must repeat integrate in every Sonar-linked repo for full coverage (especially SQAA instructions and CAG).
- See conflicting signals (e.g. SonarQube Claude plugin reporting “no hooks installed” while global hooks exist in `~/.claude/settings.json`).

This document refines the direction toward `**sonar onboard**` — a machine-wide setup command combined with **runtime project resolution** — and captures known gaps to address (CAG `tool integrate` at global scope, optional `--project` on hooks, SonarLint server mismatch, silent hook failures).

---

## 2. Current problem

### 2.1 User-facing pain


| Pain                        | Example                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------- |
| **Repeated setup**          | Run `sonar integrate` in every repo × every agent                                                 |
| **Scope confusion**         | “Should I use `--global`? What breaks if I don’t?”                                                |
| **Invisible prerequisites** | SQAA/CAG require org entitlement + project key; global install was blocked or degraded            |
| **Stale local config**      | `.sonarlint/connectedMode.json` points at a different server than `sonar auth login`              |
| **Silent failures**         | Post-edit SQAA hook runs but produces no agent-visible output on error                            |
| **Agent-specific gaps**     | Cursor SQAA cannot use post-edit hooks with `additionalContext`; cloud agents ignore global hooks |


### 2.2 Technical friction

- **Project key is baked at install time** into hook commands (`--project`), instruction templates, and CAG `tool integrate`.
- **Global integrate intentionally rejected** SQAA and CAG when no project key was known at install time.
- **Discovery order** could pick a SonarLint binding for the wrong server, preventing git-remote fallback.
- **No machine profile** — state tracks per-integration installs but not “this machine is onboarded.”

---

## 3. State of the art

### 3.1 Integrations overview


| Integration     | Entry point                   | Primary delivery                                                                        |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------------- |
| **Cursor**      | `sonar integrate cursor`      | `.cursor/hooks.json`, `.cursor/mcp.json`, `.cursor/rules/*.mdc`, `.agents/skills/`      |
| **Claude Code** | `sonar integrate claude`      | `.claude/settings.json`, `.claude.json` (MCP), `.claude/skills/`, `CLAUDE.md` snippet   |
| **Codex**       | `sonar integrate codex`       | `.codex/hooks.json`, `.codex/config.toml` (MCP), `.agents/skills/`                      |
| **Copilot**     | `sonar integrate copilot`     | `.github/` or `~/.copilot/` hooks/instructions/MCP, `.github/skills/` or homedir skills |
| **Antigravity** | `sonar integrate antigravity` | `~/.gemini/config/` hooks/MCP/rules/skills, `~/.agents/rules/`                          |
| **Git**         | `sonar integrate git`         | Pre-commit/pre-push hook in repo (native, husky, or pre-commit framework)               |


All agent integrations share the **declarative registry** (`integrate/_common/registry/`), install scope resolution, and feature containers (secrets, SQAA, MCP, CAG).

### 3.2 Project scope vs global scope


| Dimension        | **Project scope** (default)                                               | **Global scope** (`--global`)                                                              |
| ---------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Install root** | Current repo / `targetRoot` = project dir                                 | User home / agent global config dir                                                        |
| **Hooks**        | `.cursor/hooks.json`, `.claude/settings.json`, etc. in repo               | `~/.cursor/hooks.json`, `~/.claude/settings.json`, etc.                                    |
| **MCP**          | Often project-local config                                                | `~/.cursor/mcp.json`, `~/.claude.json`, etc.                                               |
| **SQAA**         | Per-edit hooks (Claude/Codex) + always-applied rules/instructions in repo | Per-edit hooks work locally; **Cursor SQAA rules do not apply to cloud/background agents** |
| **CAG skill**    | Project `.agents/skills/` or agent-specific project path                  | Global skills dir; `**tool integrate` (daemon) needs a project key**                       |
| **Secrets**      | Project hooks                                                             | Global hooks — **no project key needed**                                                   |
| **Git hooks**    | Repo-local only                                                           | **Not supported** (never global)                                                           |
| **State**        | `integrations.installed` with `scope: 'project'` + `targetRoot`           | `scope: 'global'`                                                                          |


**Today:** SQAA and CAG global installs are skipped or warned because features assume a baked project key.

### 3.3 What each feature does


| Feature                                                                        | Purpose                                                               | Needs project key?                             |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| **Secret scanning hooks**                                                      | Block secrets in prompts / before file reads                          | No                                             |
| **SQAA hooks** (Claude PostToolUse, Codex apply_patch)                         | Immediate STANDARD analysis after edits; return findings to agent     | Yes (at runtime)                               |
| **SQAA instructions/rules** (Cursor, Copilot, Antigravity, Claude end-of-turn) | Tell agent to run `sonar analyze agentic --depth DEEP` at end of turn | Yes (at runtime via CLI discovery)             |
| **MCP server**                                                                 | Agent tools for issues, quality gate, analysis                        | Yes for scoped tools (at MCP spawn / tool use) |
| **Context augmentation (CAG)**                                                 | Enrich prompts with Sonar context for current file                    | Yes (skill global; daemon per workspace)       |
| **Git pre-commit**                                                             | Secrets (+ optional SCA) on staged files                              | Yes (baked into hook)                          |


### 3.4 SQAA delivery by agent (today)


| Agent           | Per-edit feedback                      | End-of-turn DEEP                               |
| --------------- | -------------------------------------- | ---------------------------------------------- |
| **Claude**      | PostToolUse hook → `additionalContext` | Global/project `CLAUDE.md` instructions        |
| **Codex**       | PostToolUse on `apply_patch`           | N/A (hook uses change-set)                     |
| **Cursor**      | ❌ `afterFileEdit` is fire-and-forget   | Always-applied `.cursor/rules/` (project only) |
| **Copilot**     | N/A                                    | `.github/instructions/` or global instructions |
| **Antigravity** | N/A                                    | `.agents/rules/`                               |


---

## 4. Solution proposals

### 4.1 Option A — Status quo (per-repo integrate)

Keep `sonar integrate <agent>` as the only path. Document scope better.


| Pros                                | Cons                                 |
| ----------------------------------- | ------------------------------------ |
| No new architecture                 | Repeated UX; scope still confusing   |
| Project key always known at install | Does not scale to N repos × M agents |
| Full Cursor SQAA (project rules)    | Cloud Cursor agents still miss hooks |


**Assessment:** Insufficient for the stated UX goal.

---

### 4.2 Option B — Lazy per-repo bind

On first agent activity in a repo, silently run a lightweight `integrate` that writes project-level artifacts (`.cursor/rules/`, project CAG skill, etc.).


| Pros                                 | Cons                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| Project key known when writing files | **Writes into user repos** (noise, git status, review friction) |
| Cursor SQAA via project rules        | Race conditions, lock files, “what wrote this file?”            |
| Familiar integrate code paths        | Fails for repos opened read-only or before first agent turn     |


**Assessment:** Does not meet the “no per-repo file writes” constraint.

---

### 4.3 Option C — Runtime resolution (recommended)

**Install once** at machine scope (`sonar onboard`). **Resolve project context on every invocation** from `cwd` via `discoverProject()` (+ git-remote binding, state fallback).


| Pros                                     | Cons                                                        |
| ---------------------------------------- | ----------------------------------------------------------- |
| One command per machine                  | Cursor SQAA gap remains (needs MCP or project rules)        |
| No repo pollution                        | CAG daemon still bootstraps per workspace (invisible)       |
| Works for new clones immediately         | Cold-path latency on first visit (cache mitigates)          |
| Aligns with LeanCTX-style “cwd is truth” | SonarLint / multi-server repos need careful discovery rules |


**Recommendation:** **Primary approach.** Best balance of one-time setup, no repo pollution, and immediate coverage for new clones. Requires auth-aware discovery and visible hook error handling.

---

### 4.4 Option D — Hybrid (onboard + optional project enhance)

Runtime resolution as default; optional `sonar integrate <agent>` (no `--global`) for **Cursor SQAA rules** or git hooks only.


| Pros                      | Cons              |
| ------------------------- | ----------------- |
| Best Cursor SQAA coverage | Two mental models |
| Git hooks stay explicit   | Power users only  |


**Recommendation:** **Complementary escape hatch**, not the primary path. Document in help: prefer `sonar onboard`; use project-scoped `integrate` for Cursor SQAA rules or git hooks.

---

## 5. Recommended solution

### 5.1 Golden path

```bash
sonar auth login
sonar onboard --yes
# Restart AI tools once
```

Open any Sonar-linked repo → secrets, MCP, SQAA (where agent supports it), and CAG work without a second CLI command in that repo.

### 5.2 Design principles

1. **Machine onboard, runtime context** — global artifacts are project-agnostic; project key resolved at hook/analyze/MCP/context time.
2. **Fail visibly in hooks** — analysis errors surface in `additionalContext`, not debug-only logs.
3. **Auth-aware discovery** — ignore SonarLint bindings whose server URL does not match the active auth session; fall through to git-remote binding.
4. **Cache with invalidation** — per git-root cache (1h positive, 24h negative); invalidate on server mismatch or missing server metadata.
5. **Partial success** — onboard per agent; warn and continue if one agent fails (e.g. invalid `~/.cursor/mcp.json`).
6. **Legacy compatible** — `sonar integrate <agent>` and per-repo state remain; resolver falls back to integration state.

### 5.3 Project key resolution order

```
projectKey =
  explicit --project
  ?? discoverProject(cwd, { auth })     // properties → sonarlint (if server matches) → git-remote
  ?? integration state fallback         // legacy per-repo install
```

### 5.4 Agent coverage under onboard


| Agent           | Onboard installs globally                                    | Runtime SQAA                                    | Known gap                                                                         |
| --------------- | ------------------------------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| **Claude**      | Secrets, MCP, SQAA hook, CAG skill, end-of-turn instructions | ✅ PostToolUse + instructions                    | —                                                                                 |
| **Codex**       | Secrets, MCP, SQAA hook, CAG skill                           | ✅ PostToolUse                                   | —                                                                                 |
| **Copilot**     | Hooks, instructions, MCP, CAG skill                          | ✅ End-of-turn instructions                      | —                                                                                 |
| **Antigravity** | Hooks, rules, MCP, CAG skill                                 | ✅ End-of-turn rules                             | —                                                                                 |
| **Cursor**      | Secrets, MCP, CAG skill                                      | ⚠️ Instructions only (project rules not global) | SQAA per-edit + always-on rule → **MCP instructions (v1)** or project `integrate` |
| **Git**         | Not included                                                 | N/A                                             | Explicit `sonar integrate git -p <key>` per repo                                  |


### 5.5 CAG at global onboard

- Install binary + **global skill file** at onboard.
- **Skip `tool integrate`** when `scope === 'global'` and no project key (daemon bootstrap deferred).
- First `sonar context` in a Sonar-linked repo runs daemon integration with resolved project.

### 5.6 Out of scope (v1)

- `sonar projects list`, `sonar doctor --fix` (spec phase 3).
- Auto git hook install.
- Writing per-repo agent files during onboard or background bind.

---

## 6. Repository layouts (monorepo, multi-repo folder)

Runtime resolution keys off the **git root**, not the parent folder or individual subfolders. Different workspace shapes behave differently; onboard treats them the same — only discovery and cache scope change.

### 6.1 Definitions


| Layout | Structure | Typical Sonar mapping |
| ------ | --------- | --------------------- |
| **Monorepo** | One `.git` at the root; many packages/apps underneath | One Sonar project for the whole repo (most common) |
| **Multi-project monorepo** | One `.git`; multiple `sonar-project.properties` in subfolders | Several Sonar projects inside one git root (uncommon) |
| **Multi-repo folder** | Parent folder (often not a git repo) containing several sibling git repos | One Sonar project **per git repo** |


These are distinct: a monorepo is **one git root**; a multi-repo folder is **many git roots** under one workspace.

### 6.2 Monorepo — one git repo, one Sonar project

```
my-monorepo/                    ← single git root (cache key)
├── sonar-project.properties    ← discovery reads here only
├── packages/api/
└── packages/web/
```

**Supported.** This is the primary monorepo case:

- One cache entry per git root; every edit under the tree resolves the same project key.
- Matches existing SQAA change-set semantics (whole-repo git context).
- No per-package onboard; `sonar onboard` once on the machine is enough.

Auth-aware discovery (ignore SonarLint bindings for a different server, fall back to git-remote) applies here as for any repo.

### 6.3 Monorepo — one git repo, multiple Sonar projects

```
my-monorepo/                    ← single git root
├── packages/api/
│   └── sonar-project.properties   → project A
└── packages/web/
    └── sonar-project.properties   → project B
```

**Not fully supported in v1.** Discovery reads `sonar-project.properties` and SonarLint config **at the git root only**, not in subfolders. The runtime cache holds **one project key per git root**, so edits in `packages/web/` may still analyze against project A, or discovery may fail if only subfolders have config.

**Workaround:** pass `--project` explicitly, or run project-scoped `sonar integrate` for that package.

**Future:** see [§6.7](#67-multi-project-monorepo-future-work) — this is a discovery and SQAA batching change, not an onboard change.

### 6.4 Multi-repo folder — several git repos, several project keys

```
~/work/                         ← parent folder (may not be a git repo)
├── client-api/                 ← git root A → project key A
│   ├── .git
│   └── sonar-project.properties
└── client-web/                 ← git root B → project key B
    ├── .git
    └── sonar-project.properties
```

**Supported in principle.** Each repo is an independent git root with its own cache entry and project key — the intended polyrepo pattern for consultants and multi-client folders.

**Resolution anchor matters:**

| How the agent workspace is opened | Behavior today | Recommended |
| --------------------------------- | -------------- | ----------- |
| One repo at a time (`cd client-api && claude`) | Resolves key A or B from that repo’s git root | Works |
| Parent folder `~/work/` as workspace; edits `client-api/src/...` | Hooks resolve from `process.cwd()` on the parent → often **no** git root, no project key | Resolve from the **edited file’s git root** |

We recommend resolving the project key from the **edited file’s path** (git root of the file), with `process.cwd()` as fallback — same cache and discovery logic, different starting point for `findGitRoot`. This is required for parent-folder workspaces and does not change monorepo behavior when `cwd` is already inside the repo.

### 6.5 Performance impact of file-based resolution

File-based git-root resolution does **not** materially slow post-edit hooks:

- **Warm path (cache hit):** a short walk up to `.git` plus a disk cache read — on the order of **1–10 ms**.
- **Cold path (first edit in a repo per hour):** read local config; optionally one git-remote API call — **~100–500 ms once per repo**, then cached.
- **Dominant cost:** SQAA analysis over the network — **seconds** — far larger than discovery.

Using the edited file’s directory instead of `cwd` adds negligible overhead (one `dirname` and the same `findGitRoot` walk).

### 6.6 Summary


| Layout | Onboard once | Auto project key | v1 gap |
| ------ | ------------ | ---------------- | ------ |
| Monorepo, one Sonar project | Yes | Yes (any path under git root) | — |
| Monorepo, multiple Sonar projects | Yes | No (v1) | See [§6.7](#67-multi-project-monorepo-future-work) |
| Multi-repo folder, cwd inside each repo | Yes | Yes | — |
| Multi-repo folder, parent workspace | Yes | After file-based resolution | Today: `cwd`-only hooks miss nested repos |

### 6.7 Multi-project monorepo (future work)

Supporting several Sonar project keys inside **one git root** requires breaking the current assumption:

```
git root  →  one discoverProject()  →  one projectKey  →  all SQAA / MCP / CAG
```

`sonar onboard` does not need to change; the work is **path-aware discovery**, **cache shape**, and **SQAA batching**.

#### Path-aware discovery

Introduce a resolver such as `resolveProjectKeyForPath(filePath, auth)`:

1. Find the git root (unchanged).
2. Walk from `dirname(filePath)` **up to** the git root.
3. At each directory, check for `sonar-project.properties` (and optionally `.sonarlint/`).
4. **Innermost match wins** — the deepest config on the path to the file.

```
my-monorepo/                          ← root props → key ROOT (fallback only)
├── packages/api/
│   ├── sonar-project.properties      → key API
│   └── src/foo.ts                    → resolves to API
└── packages/web/
    ├── sonar-project.properties      → key WEB
    └── src/bar.ts                    → resolves to WEB
```

Additional rules:

- Apply **auth-aware SonarLint** per binding file when several exist under `.sonarlint/`.
- Use **git-remote fallback** only when no properties file matches the file’s path (single default for the whole repo).
- Optionally **index** all `sonar-project.properties` under the git root on first cold resolution (better for large monorepos than per-file walk-up).

#### Cache model

Replace `gitRoot → projectKey` with a key that identifies the **binding**, e.g. `(gitRoot, configRoot)` where `configRoot` is the directory that owns the winning properties file. TTL and server-URL invalidation stay as today.

#### Work by layer


| Layer | Change | Relative effort |
| ----- | ------ | --------------- |
| Path-aware discovery + cache | New resolver; update `runtime-project-context.ts` and `project-info.ts` | Medium |
| Post-edit hooks (Claude) | `resolveProjectKeyForPath(editedFile)`; single-file SQAA already takes one key per call | Small (after discovery) |
| Multi-repo parent workspace | File-based git root (subset of path-aware resolution) | Small |
| Change-set SQAA (Codex hook, end-of-turn DEEP) | Partition changed files **by project key**; run one analysis per group; merge hook/CLI output | Large |
| `sonar analyze agentic` | Single `--file`: path-aware key; multiple files or default change-set: partition like change-set | Medium–large |
| MCP | Resolve from active file or tool path when available; document `cwd` limitations otherwise | Medium |
| CAG | Multiple project keys may require daemon re-bootstrap or per-key context when switching packages | Medium |
| SonarLint multi-binding | Match file path to solution binding if schema exposes module paths; otherwise rely on per-package properties | Small–medium |


The **minimum viable** slice is discovery + cache + single-file hooks (per-edit SQAA correct per package). The **complete** slice adds change-set partitioning for patches that touch more than one Sonar project in the same turn.

#### Design decisions to settle


| # | Question | Recommendation |
| - | -------- | -------------- |
| 1 | Config precedence | Innermost `sonar-project.properties` on the path from file to git root wins |
| 2 | Root + nested configs | Files under a nested package never use the root key if a nested config exists |
| 3 | Change-set spanning projects | One hook message with sections labeled by project key |
| 4 | File with no matching config | Skip SQAA for that file, or fall back to repo-root / git-remote key (document choice) |
| 5 | Performance | Index property files per git root on cold path; cache by binding |

#### Tests

- Unit: walk-up discovery, innermost wins, cache keys, auth-aware SonarLint.
- Integration: monorepo fixture with two property files; hook and change-set edits across both packages.

---

## 7. Risks and mitigations


| Risk                                          | Mitigation                                                           |
| --------------------------------------------- | -------------------------------------------------------------------- |
| Wrong project from SonarLint dev server       | Auth-aware SonarLint skip + git-remote binding                       |
| Hook silent no-op                             | Emit failure text in `additionalContext`; never swallow API errors   |
| Cursor SQAA weaker globally                   | MCP instructions v1; document project `integrate` for full SQAA      |
| Stale runtime cache                           | TTL + serverUrl on cache entries + doctor clear                      |
| Multi-repo parent workspace                   | Resolve project from edited file’s git root, not only `process.cwd()` |
| Invalid user MCP config blocks Cursor onboard | Clear remediation hint; optional merge/repair later                  |
| CAG first-call latency                        | Deferred daemon; user-visible info line after onboard                |

