# Can the agent connect SonarQube to itself?

## What it tests

The agent is only told to connect SonarQube. It is not told which command to use. A developer should be able to do this without reading the documentation, and installing the wrong integration is also a mistake.

## Starting point

A clean Ubuntu machine with only `curl`, `git` and `jq`, the latest published `sonar` CLI and Claude Code. The agent works in `/app`, a git repository that holds a `sonar-project.properties` file.

The CLI is already connected to SonarQube Cloud through environment variables (token, organization and server). No agent integration is installed yet.

## What counts as success

The right integration is installed, and no other one.

## Checks

- `integration_installed`: The integration for this agent is installed.
- `no_other_integration`: No other integration is installed.
