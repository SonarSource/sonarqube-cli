---
on:
  workflow_run:
    workflows: ["*"]
    types: [completed]
    branches:
      - 'ci-triage-test/**'
      - master
  workflow_dispatch:
    inputs:
      workflow_conclusion:
        description: 'Conclusion of the failed workflow run'
        default: 'failure'
      head_branch:
        description: 'Head branch of the failed workflow run'

permissions:
  contents: read
  actions: read
  issues: read
  pull-requests: read

if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'failure'
concurrency: ci-triage-${{ github.run_id }}

imports:
  - uses: SonarSource/awesome-ai/workflows/ci-failure-triage-agent.md@ci-failure-triage-agent-1.0.1
    with:
      workflow_conclusion: ${{ inputs.workflow_conclusion || github.event.workflow_run.conclusion }}
      head_branch: ${{ inputs.head_branch || github.event.workflow_run.head_branch }}
      slack_channel: squad-devex-flow-interrupts
---

Triage CI failures for sonarqube-cli.
