# Maintaining agent instructions

Change agent instructions only when this change makes existing guidance incorrect, introduces a durable convention, or addresses a demonstrated recurring mistake. Ordinary feature work does not require an instruction update. Prefer correcting or replacing existing guidance over appending.

## Organization

- `AGENTS.md` is canonical, as an ordinary file. Root guidance holds essential commands, repository-wide constraints, and explicit routes to scoped guidance. Add a nested source only for durable rules that differ in that scope.
- Adjacent `CLAUDE.md` files import `@AGENTS.md`. Cross-cutting rules live in `agent-guidance/`; Claude rules import them, while Cursor/Copilot adapters explicitly tell the agent to read them. Keep path selectors equivalent across adapters.
- Root-started agents must follow routes explicitly; nested discovery and editor support vary by client. `.github/copilot-instructions.md` points clients without nested support at the root router. Check both root and nested workflows after changing routes.
- Keep actionable conventions, unusual prerequisites, safety boundaries, and brief reasons. Remove feature catalogs, ticket history, copied code descriptions, and facts readily recovered from source/tests. Extract only unique design rationale into focused references.

## Review budgets

Check both whitespace-separated word count and UTF-8 byte count, not just line count:

- Root `AGENTS.md`: at most **1,000 words and 8 KiB**, including managed content.
- Each scoped/shared instruction source: at most **500 words and 4 KiB**.
- Authored compatibility adapters: at most **20 lines**, containing scope/loading metadata only. Marked tool-managed additions are excluded from this adapter limit.

Explain any exception in the PR. Wrapping a giant paragraph into fewer lines does not meet these budgets. Preserve Sonar-managed blocks and markers exactly; raw snippet writers may append a protocol after a Claude import. This repository cleanup does not change those generators.

## Reviewer checklist

Check changes to instructions **and code that can invalidate them** for unnecessary additions, budget growth, duplicated rules, implementation narration, broken references, contradictory guidance, and mismatched scopes. Verify retained constraints against current source and ensure every scoped source has a root route.

Check compatibility references/frontmatter and ordinary-file operation without symlinks. Gitar imports this policy for review; human review remains necessary because neither source loading nor prose correctness is guaranteed by review heuristics. No instruction CI gate or scheduled maintenance is required.
