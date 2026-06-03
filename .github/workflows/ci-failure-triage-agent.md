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
    - acli.atlassian.com
    - api.atlassian.com
    - sonarsource.atlassian.net

tools:
  github:
    toolsets: [context, repos, pull_requests]

env:
  NIGHT_OWL_BASE_BRANCH: master
  NIGHT_OWL_CANDIDATE_JQL: 'project = CLI AND labels = "for-agent" AND statusCategory = "To Do" ORDER BY created ASC'
  NIGHT_OWL_JIRA_LABEL: for-agent
  NIGHT_OWL_JIRA_PROJECT: CLI
  NIGHT_OWL_JIRA_SITE: sonarsource.atlassian.net
  NIGHT_OWL_SLACK_CHANNEL_ID: C0B7GN16473

jobs:
  night_owl_prepare:
    runs-on: ubuntu-latest
    permissions:
      id-token: write
      contents: read
      pull-requests: read
    outputs:
      prep_status: ${{ steps.prepare.outputs.prep_status }}
      issue_key: ${{ steps.prepare.outputs.issue_key }}
      issue_url: ${{ steps.prepare.outputs.issue_url }}
      issue_summary: ${{ steps.prepare.outputs.issue_summary }}
      parent_key: ${{ steps.prepare.outputs.parent_key }}
      parent_url: ${{ steps.prepare.outputs.parent_url }}
      parent_summary: ${{ steps.prepare.outputs.parent_summary }}
      context_markdown: ${{ steps.prepare.outputs.context_markdown }}
      slack_message: ${{ steps.prepare.outputs.slack_message }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
      - name: Get Jira credentials from Vault
        id: secrets
        uses: SonarSource/vault-action-wrapper@c154b4a417b51cb98dd71137f49bf20e77c56820
        with:
          secrets: |
            development/kv/data/jira user | JIRA_USER;
            development/kv/data/jira token | JIRA_TOKEN;
            development/kv/data/slack token | SLACK_BOT_TOKEN;
      - name: Install Atlassian CLI
        shell: bash
        run: |
          case "${RUNNER_ARCH}" in
            X64) platform=amd64 ;;
            ARM64) platform=arm64 ;;
            *)
              echo "::error::Unsupported runner architecture: ${RUNNER_ARCH}"
              exit 1
              ;;
          esac

          curl -fsSLo "${RUNNER_TEMP}/acli" "https://acli.atlassian.com/linux/latest/acli_linux_${platform}/acli"
          chmod +x "${RUNNER_TEMP}/acli"
          install_dir="${RUNNER_TEMP}/night-owl-bin"
          mkdir -p "${install_dir}"
          mv "${RUNNER_TEMP}/acli" "${install_dir}/acli"
          echo "${install_dir}" >> "${GITHUB_PATH}"
      - name: Authenticate Atlassian CLI
        shell: bash
        run: |
          echo "::add-mask::${JIRA_TOKEN}"
          printf '%s\n' "${JIRA_TOKEN}" | acli jira auth login --email "${JIRA_USER}" --site "${NIGHT_OWL_JIRA_SITE}" --token
        env:
          JIRA_TOKEN: ${{ fromJSON(steps.secrets.outputs.vault).JIRA_TOKEN }}
          JIRA_USER: ${{ fromJSON(steps.secrets.outputs.vault).JIRA_USER }}
      - name: Prepare Jira context for Night Owl
        id: prepare
        continue-on-error: true
        shell: bash
        run: bash .github/scripts/night-owl/prepare-jira-context.sh
        env:
          GH_TOKEN: ${{ github.token }}
      - name: Post starvation message to Slack
        if: ${{ steps.prepare.outcome == 'success' && steps.prepare.outputs.prep_status == 'starving' }}
        uses: slackapi/slack-github-action@70cd7be8e40a46e8b0eced40b0de447bdb42f68e
        env:
          SLACK_BOT_TOKEN: ${{ fromJSON(steps.secrets.outputs.vault).SLACK_BOT_TOKEN }}
        with:
          channel-id: ${{ env.NIGHT_OWL_SLACK_CHANNEL_ID }}
          slack-message: ${{ steps.prepare.outputs.slack_message }}
      - name: Post preparation failure to Slack
        if: ${{ steps.prepare.outcome == 'failure' }}
        uses: slackapi/slack-github-action@70cd7be8e40a46e8b0eced40b0de447bdb42f68e
        env:
          SLACK_BOT_TOKEN: ${{ fromJSON(steps.secrets.outputs.vault).SLACK_BOT_TOKEN }}
        with:
          channel-id: ${{ env.NIGHT_OWL_SLACK_CHANNEL_ID }}
          slack-message: |
            Night Owl: :warning: preparation failure
            Outcome: Jira preparation failed before the coding agent could start.
            Action needed: Inspect the `night_owl_prepare` job logs for this workflow run and verify ACLI installation, ACLI authentication, and Jira access for `${{ env.NIGHT_OWL_JIRA_SITE }}`.
      - name: Fail job when preparation fails
        if: ${{ steps.prepare.outcome == 'failure' }}
        shell: bash
        run: exit 1

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
2. Jira preparation has already been done for you by the workflow using Atlassian CLI. Do not call Jira, Atlassian MCP, or `acli` yourself.
3. Use GitHub MCP plus the local checkout for repository context, implementation work, and PR checks.
4. Emit exactly one `slack_notify` safe output for every terminal outcome after Jira prep succeeds:
   - `blocked`: the selected ticket or its prepared parent/linked context is missing key product or implementation decisions;
   - `draft-pr-opened`: the implementation is done and a draft PR was created.
5. If the prepared Jira status below is not `ready`, stop immediately without emitting any safe outputs. The workflow already handled starvation or infrastructure notification.

## Prepared Jira Inputs

- Prep status: `${{ needs.night_owl_prepare.outputs.prep_status }}`
- Ticket: `${{ needs.night_owl_prepare.outputs.issue_key }}`
- Ticket URL: `${{ needs.night_owl_prepare.outputs.issue_url }}`
- Ticket summary: `${{ needs.night_owl_prepare.outputs.issue_summary }}`
- Parent: `${{ needs.night_owl_prepare.outputs.parent_key }}`
- Parent URL: `${{ needs.night_owl_prepare.outputs.parent_url }}`
- Parent summary: `${{ needs.night_owl_prepare.outputs.parent_summary }}`

${{ needs.night_owl_prepare.outputs.context_markdown }}

Treat the prepared Jira content above as the source of truth. Do not invent missing Jira details and do not assume you can fetch more Jira data later.

## 1. Decide whether the ticket is actionable

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

## 2. Implement the ticket

If the issue is actionable:

1. Read the relevant repository files and follow `AGENTS.md` / `CLAUDE.md`.
2. Create a branch before committing, using the Jira key in the branch name, for example `night-owl/CLI-123-short-slug`.
3. Implement the change.
4. Run the smallest set of meaningful checks that match the files you changed. If you edit TypeScript, follow the repository formatting requirements before you finish.
5. If you cannot finish a coherent implementation or cannot validate it well enough to justify a draft PR, stop and emit a blocked Slack message explaining what remains.

## 3. Open a draft PR

When the implementation is complete:

1. Use the `create-pull-request` safe output. The PR must remain a draft.
2. Use a PR title that starts with the Jira key, for example `CLI-123 Implement ...`.
3. In the PR description include:
   - the Jira ticket link and summary,
   - the parent ticket link if you used parent context,
   - a short implementation summary,
   - the checks you ran,
   - any open questions or follow-ups that remain.

## 4. Notify Slack

Emit a `slack_notify` message for every terminal outcome you handle in the agent.

The message should be structured and concise:

- `Night Owl`: blocked or draft PR opened
- `Ticket`: Jira key, link, and summary when applicable
- `Parent`: parent Jira key and summary when applicable
- `Outcome`: one or two sentences
- `PR`: include the PR URL when one was created
- `Checks`: include the checks you ran when a PR was created
