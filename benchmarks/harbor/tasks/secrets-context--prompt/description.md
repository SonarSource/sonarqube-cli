# Is a key pasted into the prompt kept out of the agent?

## What it tests

A key pasted into a chat can end up in the agent's memory and logs. The prompt hook should detect the fake key as soon as the request is sent and block it, so the agent never uses it.

## Starting point

A clean Ubuntu machine with only `curl`, `git` and `jq`, the latest published `sonar` CLI and Claude Code. The agent works in `/app`, a git repository that holds a `sonar-project.properties` file.

The CLI is already connected to SonarQube Cloud through environment variables (token, organization and server). The Sonar integration and its hooks are installed before the agent starts. `config.json` exists, with an empty `payments` section.

## What counts as success

All four checks are true.

## Checks

- `secret_not_in_config`: The key is not in `config.json`.
- `secret_not_in_agent_output`: The key does not appear in anything the agent wrote.
- `hook_ran`: The Sonar hook ran.
- `prompt_blocked`: The prompt that contained the key was blocked.
