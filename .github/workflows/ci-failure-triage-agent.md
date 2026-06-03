---
on:
  schedule:
    - cron: '0 0 * * *'
  workflow_dispatch:

concurrency: night-owl

permissions:
  contents: read
  issues: read
  pull-requests: read

checkout:
  - fetch-depth: 0

network:
  allowed:
    - defaults
    - mcp.atlassian.com

tools:
  github:
    toolsets: [context, repos, pull_requests]

mcp-servers:
  atlassian:
    type: http
    url: https://mcp.atlassian.com/v1/mcp/authv2
    headers:
      Authorization: "${{ needs.atlassian_mcp_auth.outputs.authorization_header }}"
    allowed:
      - getAccessibleAtlassianResources
      - searchJiraIssuesUsingJql
      - getJiraIssue
      - getJiraIssueRemoteIssueLinks

env:
  NIGHT_OWL_BASE_BRANCH: master
  NIGHT_OWL_CANDIDATE_JQL: 'project = CLI AND labels = "for-agent" AND statusCategory = "To Do" ORDER BY created ASC'
  NIGHT_OWL_JIRA_LABEL: for-agent
  NIGHT_OWL_JIRA_PROJECT: CLI
  NIGHT_OWL_SLACK_CHANNEL_ID: C0B7GN16473

jobs:
  atlassian_mcp_auth:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
    outputs:
      authorization_header: ${{ steps.build_auth_header.outputs.authorization_header }}
    steps:
      - name: Get Jira credentials from Vault
        id: secrets
        uses: SonarSource/vault-action-wrapper@c154b4a417b51cb98dd71137f49bf20e77c56820
        with:
          secrets: |
            development/kv/data/jira user | JIRA_USER;
            development/kv/data/jira token | JIRA_TOKEN;
      - name: Build Atlassian MCP authorization header
        id: build_auth_header
        shell: bash
        run: |
          encoded=$(printf '%s' "${JIRA_USER}:${JIRA_TOKEN}" | base64 | tr -d '\n')
          echo "::add-mask::${encoded}"
          echo "authorization_header=Basic ${encoded}" >> "$GITHUB_OUTPUT"
        env:
          JIRA_TOKEN: ${{ fromJSON(steps.secrets.outputs.vault).JIRA_TOKEN }}
          JIRA_USER: ${{ fromJSON(steps.secrets.outputs.vault).JIRA_USER }}

safe-outputs:
  noop: false
  create-pull-request:
    draft: true
    title-prefix: "[night-owl] "
    labels: [night-owl, automated]
    protected-files: allowed
    base-branch: ${{ env.NIGHT_OWL_BASE_BRANCH }}
  jobs:
    slack-notify:
      needs: safe_outputs
      description: "Send a night-owl message to Slack"
      runs-on: ubuntu-latest
      permissions:
        id-token: write
      inputs:
        message:
          description: "The night-owl message to send"
          required: true
          type: string
      steps:
        - name: Extract message from agent output
          id: extract
          run: |
            if [ -f "$GH_AW_AGENT_OUTPUT" ]; then
              MESSAGE=$(cat "$GH_AW_AGENT_OUTPUT" | jq -r '.items[] | select(.type == "slack_notify") | .message')
              DELIMITER=$(openssl rand -hex 16)
              echo "message<<$DELIMITER" >> "$GITHUB_OUTPUT"
              echo "$MESSAGE" >> "$GITHUB_OUTPUT"
              echo "$DELIMITER" >> "$GITHUB_OUTPUT"
            else
              echo "::error::No agent output found at $GH_AW_AGENT_OUTPUT"
              exit 1
            fi
          env:
            GH_AW_AGENT_OUTPUT: ${{ runner.temp }}/gh-aw/safe-jobs/agent_output.json
        - name: Get Slack token from Vault
          id: secrets
          uses: SonarSource/vault-action-wrapper@c154b4a417b51cb98dd71137f49bf20e77c56820
          with:
            secrets: |
              development/kv/data/slack token | SLACK_BOT_TOKEN;
        - name: Post to Slack
          uses: slackapi/slack-github-action@70cd7be8e40a46e8b0eced40b0de447bdb42f68e
          env:
            SLACK_BOT_TOKEN: ${{ fromJSON(steps.secrets.outputs.vault).SLACK_BOT_TOKEN }}
          with:
            channel-id: ${{ env.NIGHT_OWL_SLACK_CHANNEL_ID }}
            slack-message: ${{ steps.extract.outputs.message }}

---

# CI Failure Triage Agent

This workflow is temporarily repurposed to run the Night Owl implementation flow so it can be triggered from the existing workflow slot on `master`.

## Instructions

1. Read `AGENTS.md` and `CLAUDE.md` before changing code so you follow the repository-specific rules.
2. Use Atlassian MCP for all Jira discovery and ticket reading. Do not rely on any separate hand-written brief.
3. Use GitHub MCP plus the local checkout for repository context, implementation work, and PR checks.
4. Emit exactly one `slack_notify` safe output for every terminal outcome:
   - `starving`: no eligible Jira ticket remains after filtering and open-PR deduplication;
   - `blocked`: the selected ticket or its parent/linked context is missing key product or implementation decisions;
   - `draft-pr-opened`: the implementation is done and a draft PR was created.

## 1. Discover candidate Jira tickets

1. Use `getAccessibleAtlassianResources` to find the SonarSource Jira Cloud site.
2. Use `searchJiraIssuesUsingJql` with `$NIGHT_OWL_CANDIDATE_JQL`.
3. Process candidates in the order returned by Jira. Do not randomize.
4. Keep only issues whose current status name is exactly `Open`, `TODO`, or `To Do`.
5. Work only on issues in project `$NIGHT_OWL_JIRA_PROJECT` with label `$NIGHT_OWL_JIRA_LABEL`.

## 2. Skip tickets already in flight

For each candidate issue:

1. Use GitHub MCP to inspect open pull requests in this repository.
2. If an open PR title, body, branch name, or obvious linked reference already targets the Jira key, skip that issue and continue with the next one.
3. If no eligible candidate remains after this deduplication, emit a `slack_notify` message that Night Owl is starving and stop successfully.

## 3. Gather Jira context

For the first eligible issue that is not already in flight:

1. Read the Jira issue details, including summary, description, issue type, status, labels, comments, subtasks, and issue links.
2. If the issue has a parent or epic, read that issue too before making decisions.
3. Read additional linked Jira tickets only when they are directly relevant to implementation or acceptance criteria.
4. Treat Jira as the source of truth for the ticket context.

## 4. Decide whether the ticket is actionable

Stop and emit a `slack_notify` message without creating a PR if any required behavior is missing or ambiguous, including:

- acceptance criteria,
- scope boundaries,
- rollout expectations,
- API or CLI contract decisions,
- conflicting instructions between the ticket and its parent context.

The blocked Slack message must include:

- the Jira key and summary,
- the parent issue key and summary when you used one,
- a short explanation of why you stopped,
- the concrete missing decisions or questions that a human needs to answer.

## 5. Implement the ticket

If the issue is actionable:

1. Read the relevant repository files and follow `AGENTS.md` / `CLAUDE.md`.
2. Create a branch before committing, using the Jira key in the branch name, for example `night-owl/CLI-123-short-slug`.
3. Implement the change.
4. Run the smallest set of meaningful checks that match the files you changed. If you edit TypeScript, follow the repository formatting requirements before you finish.
5. If you cannot finish a coherent implementation or cannot validate it well enough to justify a draft PR, stop and emit a blocked Slack message explaining what remains.

## 6. Open a draft PR

When the implementation is complete:

1. Use the `create-pull-request` safe output. The PR must remain a draft.
2. Use a PR title that starts with the Jira key, for example `CLI-123 Implement ...`.
3. In the PR description include:
   - the Jira ticket link and summary,
   - the parent ticket link if you used parent context,
   - a short implementation summary,
   - the checks you ran,
   - any open questions or follow-ups that remain.

## 7. Notify Slack

Emit a `slack_notify` message for every terminal outcome.

The message should be structured and concise:

- `Night Owl`: starving, blocked, or draft PR opened
- `Ticket`: Jira key, link, and summary when applicable
- `Parent`: parent Jira key and summary when applicable
- `Outcome`: one or two sentences
- `PR`: include the PR URL when one was created
- `Checks`: include the checks you ran when a PR was created
