# Can the agent repair a broken CLI without getting stuck?

## What it tests

A broken CLI is a common situation. A careful agent reads the error, finds the fix in the project files, and avoids the prompt that would block it.

## Starting point

A clean Ubuntu machine with only `curl`, `git` and `jq`, the latest published `sonar` CLI and Claude Code. The agent works in `/app`, a git repository that holds a `sonar-project.properties` file.

The CLI has a token but no organization, so every command fails. The organization name is only written in `sonar-project.properties`.

## What counts as success

All three checks are true.

## Checks

- `answer_correct`: The number in `/app/answer.txt` is the real count of open issues.
- `list_issues_ran`: The agent ran `sonar list issues` itself. A lucky guess does not count.
- `no_interactive_login`: The agent did not start an interactive login, which waits for a person to answer.
