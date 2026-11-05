# Maintaining agent instructions

Change agent instructions only when this change makes existing guidance incorrect, introduces a durable convention, or addresses a demonstrated recurring mistake. Ordinary feature work does not require an instruction update. Prefer correcting or replacing existing guidance over appending.

## Organization

- `AGENTS.md` is canonical, as an ordinary file. Root guidance holds essential commands, repository-wide constraints, and explicit routes to scoped guidance. Add a nested source only for durable rules that differ in that scope.
- Cross-cutting rules live in `agent-guidance/` and are routed explicitly from the root. Keep one source for each rule; do not duplicate it in client-specific directories.
- Root-started agents must follow routes explicitly; nested discovery and editor support vary by client. Check both root and nested workflows after changing routes.
- Use native `AGENTS.md` loading. [Claude Code](https://code.claude.com/docs/en/memory#agents-md) supports it from v2.1.277; [Cursor](https://cursor.com/docs/rules#agentsmd) supports root and nested files. Claude's default loads `AGENTS.md` only when no project/ancestor `CLAUDE.md`, `.claude/CLAUDE.md`, or `CLAUDE.local.md` takes precedence. If personal project instructions suppress loading, select `claude-md-and-agents-md` in Claude's Project instructions setting. Do not add compatibility files without a demonstrated need in a client the team uses.
- Keep actionable conventions, unusual prerequisites, safety boundaries, and brief reasons. Remove feature catalogs, ticket history, copied code descriptions, and facts readily recovered from source/tests. Extract only unique design rationale into focused references.

## Review budgets

Check both whitespace-separated word count and UTF-8 byte count, not just line count:

- Root `AGENTS.md`: at most **1,000 words and 8 KiB**, including managed content.
- Each scoped/shared instruction source: at most **500 words and 4 KiB**.
- Any necessary tool adapter: at most **20 lines**, containing scope/loading metadata only. Marked tool-managed additions are excluded from this adapter limit.

Explain any exception in the PR. Wrapping a giant paragraph into fewer lines does not meet these budgets. Preserve Sonar-managed blocks and markers exactly. Tool installers may create client-specific instruction files; this repository cleanup does not change those generators. Verify native instruction loading if such a file is created.

## Reviewer checklist

Check changes to instructions **and code that can invalidate them** for unnecessary additions, budget growth, duplicated rules, implementation narration, broken references, contradictory guidance, and mismatched scopes. Verify retained constraints against current source and ensure every scoped source has a root route.

Check references, root routing, native instruction loading, and ordinary-file operation without symlinks. Reject unnecessary client adapters. Gitar imports this policy for review; human review remains necessary because neither source loading nor prose correctness is guaranteed by review heuristics. No instruction CI gate or scheduled maintenance is required.
