---
name: design-review
description: Check a diff for duplicated flows, oversized pull requests, missed reuse and unearned abstractions before opening or approving a pull request. Use before opening a PR, when reviewing one, and when a diff adds a new flow, command, module or helper.
---

# Design review

Four checks, each answered by reading the code. Do not recite principles (KISS, DRY, SOLID):
they give nothing to verify and produce remarks that people stop reading. A finding exists only
when it carries the locations that prove it. If there is nothing to report, say so in one line.

Read the diff first: `git diff $(git merge-base HEAD origin/master)...HEAD`.

## 1. Is this flow already written next door?

The duplication that hurts here is not copy-paste. A detector such as jscpd finds nothing,
because the same algorithm is written again in another branch with different names. For
example, SQAA analysis was written several times as: find the affected files, group them by
project, send them to the server, process the results, present them.

For each new flow, branch or command:
1. Write its steps down in one line each.
2. Search the sibling modules (the same directory and the one next to it) for the same
   sequence of steps, not for the same text.
3. Report a match only with both locations, as `file:line` and `file:line`.

Two copies of a short sequence are acceptable. At three copies, or two copies of a long one,
the finding is to extract the shared steps and keep only the variation in each caller.

## 2. Is the pull request small enough to review?

Over about 800 changed lines, or several unrelated concerns: split it before review, not
after. State where the cut goes (for example "the helper and its tests first, then the
command that uses it"). A large diff is not reviewed, it is skimmed, and that is how repeated
flows get in.

## 3. Did the author look for existing code first?

For each new helper, option parser, formatter or HTTP call, check `src/core/` and the
neighbouring command for an existing one. The pull request description should name what was
checked. Report a new helper only when you can point to the existing one it repeats.

## 4. Is every new abstraction earned?

A new interface, base class, option or configuration key with one implementation or one caller
must say in the description why it exists. If the only reason is "it might be needed", ask to
inline it.

## How to report

- One finding per issue: what repeats or what is missing, both locations, and the concrete
  refactor (which function to extract, where it lives, what stays in each caller).
- No principle names, no style remarks, nothing a linter already says.
- Distinguish a blocking finding (a third copy, an unreviewable size) from a suggestion.
- When used by an author before opening a pull request, fix the findings or explain in the
  description why they do not apply.
