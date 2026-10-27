# Harbor benchmark

Measures how coding agents use the `sonar` CLI, with [Harbor](https://docs.harborframework.com). Each directory in `tasks/` is a Harbor task: the agent works in a Docker container, a verifier writes the reward.

Run locally (Docker required, Harbor installed with `uv tool install harbor`):

```bash
harbor run --path benchmarks/harbor/tasks --agent claude-code --model anthropic/claude-sonnet-5-5 --jobs-dir /tmp/harbor-jobs --job-name local
bun benchmarks/harbor/report/summarize-job.ts linux=/tmp/harbor-jobs/local
```

In CI, run the `Harbor Benchmark` workflow manually (`workflow_dispatch` only). It uploads the Harbor jobs directory per OS and writes the report to the run summary.

Linux runs in a Docker container built from the task's `environment/Dockerfile`. macOS has no containers, so it runs on the runner itself through `environments/host_environment.py` (`--env host_environment:HostEnvironment`): the workflow creates `/app`, `/logs`, `/tests` and `/solution` with `/etc/synthetic.d`, installs `sonar` and Claude Code on the host, and the environment wipes those directories at the start of every trial. It refuses to start unless `GITHUB_ACTIONS` or `HARBOR_HOST_ENVIRONMENT_ALLOW` is set. Windows is not covered: Harbor 0.25.0 does not support `claude-code` in Windows containers.

The report takes pass/fail from the verifier reward (`1` = pass) and tokens, cost and steps from the ATIF `agent/trajectory.json` of each trial. The exit code is non-zero when any task is not `PASS`.
