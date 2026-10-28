# Harbor benchmark

Measures how coding agents use the `sonar` CLI, with [Harbor](https://docs.harborframework.com). Each directory in `tasks/` is a Harbor task: the agent works in a Docker container, a verifier writes the reward.

Run locally (Docker required, Harbor installed with `uv tool install harbor`):

```bash
harbor run --path benchmarks/harbor/tasks --agent claude-code --model anthropic/claude-sonnet-5-5 --jobs-dir /tmp/harbor-jobs --job-name local
bun benchmarks/harbor/report/summarize-job.ts linux=/tmp/harbor-jobs/local
```

In CI, run the `Harbor Benchmark` workflow manually (`workflow_dispatch` only). It uploads the Harbor jobs directory per OS and writes the report to the run summary.

In CI both Linux and macOS run without containers: the runner is the sandbox. The Linux runners have no Docker daemon, and macOS has no containers, so the workflow runs `scripts/run-isolated.sh`, which uses `environments/host_environment.py` (`--env host_environment:HostEnvironment`). The agent runs as the `nobody` user, which has no `sudo`, so it cannot read the runner user's processes, the OIDC token request variables or the Vault role. The script creates `/app`, `/logs`, `/tests` and `/solution` (`sudo mkdir` on Linux, `/etc/synthetic.d` symlinks on macOS), installs Harbor, `sonar` and Claude Code under the agent's own home, and refuses to start if the agent user can run `sudo`. The environment wipes those directories at the start of every trial and refuses to start unless `GITHUB_ACTIONS` or `HARBOR_HOST_ENVIRONMENT_ALLOW` is set. The task's `environment/Dockerfile` is only used for local runs with the default Docker environment. Windows is not covered: Harbor 0.25.0 does not support `claude-code` in Windows containers.

The report takes pass/fail from the verifier reward (`1` = pass) and tokens, cost and steps from the ATIF `agent/trajectory.json` of each trial. The exit code is non-zero when any task is not `PASS`.
