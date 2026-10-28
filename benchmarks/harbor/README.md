# Harbor benchmark

Measures how coding agents use the `sonar` CLI, with [Harbor](https://docs.harborframework.com). Each directory in `tasks/` is a Harbor task: the agent works in a Docker container, a verifier writes the reward.

Run locally (Docker required, Harbor installed with `uv tool install harbor`):

```bash
harbor run --path benchmarks/harbor/tasks --agent claude-code --model anthropic/claude-sonnet-5-5 --jobs-dir /tmp/harbor-jobs --job-name local
bun benchmarks/harbor/report/summarize-job.ts linux=/tmp/harbor-jobs/local
```

Local Docker runs read the Sonar credentials from `HB_SONAR_TOKEN` and `HB_SONAR_ORG` (export them from `SONARQUBE_CLI_TOKEN` and `SONARQUBE_CLI_ORG`). `HB_SONAR_SERVER` and `HB_SONAR_API_URL` default to production SonarQube Cloud; the CI workflow sets them to staging, with the `sonarlint-it` org. The verifier variables come from `--ve EXPECTED_INTEGRATION=claude-code` (`codex` for Codex).

In CI, run the `Harbor Benchmark` workflow manually (`workflow_dispatch` only). One job per OS and task, one trial each: the runner is fresh for every task, so nothing a task installs can leak into another. Running several trials per job would make them share the runner, so `~/.sonar`, `~/.claude` and `~/.codex` would have to be reset between trials first. Each job uploads its Harbor jobs directory, and the report job merges them per OS into the run summary.

In CI both Linux and macOS run without containers: the runner is the sandbox. The Linux runners have no Docker daemon, and macOS has no containers, so the workflow runs `scripts/run-isolated.sh`, which uses `environments/host_environment.py` (`--env host_environment:HostEnvironment`). The agent runs as the `nobody` user, which has no `sudo`, so it cannot read the runner user's processes, the OIDC token request variables or the Vault role. The script creates `/app`, `/logs`, `/tests` and `/solution` (`sudo mkdir` on Linux, `/etc/synthetic.d` symlinks on macOS), installs Harbor, `sonar` and Claude Code under the agent's own home, and refuses to start if the agent user can run `sudo`. The environment wipes those directories at the start of every trial and refuses to start unless `GITHUB_ACTIONS` or `HARBOR_HOST_ENVIRONMENT_ALLOW` is set. The task's `environment/Dockerfile` is only used for local runs with the default Docker environment: on the host, `environment/setup-host.sh` does its job (it runs at the start of every trial, after the wipe, which is why it cannot be a workflow step). It rebuilds the fixture repository in `/app` (`ci/init-app-repo.sh`, the same content as the Dockerfile). Variables named `HB_*` (the Sonar token and organization) are hidden from the agent: tasks map the ones they need in `[environment.env]`. Every `sonar` call is written to `/logs/sonar-calls.log` by `ci/sonar-wrapper.sh`, which `run-isolated.sh` installs as `~/.local/bin/sonar`, ahead of the real binary in the agent's `PATH` (each task's `environment/sonar-wrapper.sh` is a copy of it for Docker). Windows is not covered: Harbor 0.25.0 does not support `claude-code` in Windows containers.

The report takes pass/fail from the verifier reward (`1` = pass) and tokens, cost and steps from the ATIF `agent/trajectory.json` of each trial. The exit code is non-zero when any task is not `PASS`.
