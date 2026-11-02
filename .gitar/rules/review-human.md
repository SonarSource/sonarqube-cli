---
title: Flag pull requests that need a human reviewer
description: Label the pull requests that are too large, too new or too sensitive to be approved without a person reading them.
type: automation
when: >
  A pull request changes more than about 800 lines or 15 files, adds files under
  src/, or touches user-scripts/, src/core/auth, the agent hooks, secret handling,
  .github/, .gitar/, AGENTS.md or a CLAUDE.md.
actions: Apply the review:human label and post one short comment stating why a human is needed.
---

Apply `review:human` when the pull request does any of the following. Judge by what the
changed files show; do not guess about intent.

- Changes more than about 800 lines or more than 15 files, or combines several unrelated
  concerns. Judge breadth and impact, and treat the numbers as a hard stop, not a target.
- Adds files under `src/`: a new module, command or integration.
- Touches code that is live for every user as soon as it merges or that guards credentials:
  `user-scripts/` (`sonar update` fetches it from master at run time), `src/core/auth`, the
  agent hooks, secret handling.
- Touches `.github/`, `.gitar/`, `AGENTS.md` or a `CLAUDE.md`: agents follow these
  instructions literally.

Do not apply it to Renovate or analyzer updates, documentation-only or test-only changes, or
small focused fixes that stay inside existing files.

In the comment, name the trigger and what the human reviewer needs to judge, for example
"adds a new module under `src/commands/`: check that the flow does not repeat one that
already exists next to it". One comment per pull request: update it instead of posting again.

Manage only this rule's label. The label is a signal, not a merge gate, a defect verdict or
proof of human acceptance. It does not change the code review verdict.
