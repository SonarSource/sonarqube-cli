Approve only when the whole-PR risk assessment is Low and the code review has zero open, unresolved, or unaddressed findings of any severity.

## Changes that must not be automatically approved

Leave these for a human reviewer, even when the risk assessment is Low:

- Any pull request labelled `review:human`.
- Large or broad changes: more than about 800 changed lines or 15 files, or several unrelated concerns in one pull request. The two numbers are hard limits, not targets: above them the answer is always a human, and breadth and impact are judged only below them.
- New files under `src/` (a new module, command or integration).
- Changes to `user-scripts/` (`sonar update` fetches them from master at run time), `src/core/auth`, or the agent hooks and secret handling: `src/commands/hook/` (including `agent-secrets-masking/` and the git pre-commit and pre-push secrets hooks), `src/core/secrets/` and `src/commands/analyze/secrets*.ts`.
- Changes to `.github/`, `.gitar/`, `AGENTS.md` or a `CLAUDE.md`.

## Changes that can still be approved

- Renovate and analyzer updates, documentation-only changes, test-only changes, and small focused fixes inside existing files that match none of the cases in the list above. That list wins: a Renovate update of `.github/` workflows, a documentation edit of `AGENTS.md` or a `CLAUDE.md`, or a lockfile regeneration over the limits still goes to a human.

Judge size by breadth and impact. A low-risk file does not cancel a higher-risk change elsewhere in the pull request. If the complete change does not confidently qualify, leave it for human review. Automatic approval does not authorize automatic merge.
