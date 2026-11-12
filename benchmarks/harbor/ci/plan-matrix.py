#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

TASKS_DIR = Path(__file__).resolve().parents[1] / "tasks"
MAX_ATTEMPTS = 10
MAX_JOBS = 256

HARNESS_INPUTS = {"harness_claude_code": "claude-code", "harness_codex": "codex"}
MODEL_INPUTS = {
    "model_claude_sonnet_5_5": "claude-sonnet-5-5",
    "model_claude_haiku_5_5": "claude-haiku-5-5",
    "model_gpt_6_1_terra": "gpt-6.1-terra",
}
AGENTS = [
    {"name": "claude-code", "provider": "anthropic", "model": "claude-sonnet-5-5"},
    {"name": "claude-code", "provider": "anthropic", "model": "claude-haiku-5-5"},
    {"name": "codex", "provider": "openai", "model": "gpt-6.1-terra"},
]


def label(agent: dict) -> str:
    return f"{agent['name']} : {agent['model']}"


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    sys.exit(1)


def task_input(task: str) -> str:
    return "task_" + task.replace("--", "_").replace("-", "_")


def selected(inputs: dict, keys: dict[str, str]) -> list[str]:
    return [value for key, value in keys.items() if inputs[key] is True]


def select_agents(inputs: dict) -> list[dict]:
    harnesses = selected(inputs, HARNESS_INPUTS)
    models = selected(inputs, MODEL_INPUTS)
    if not harnesses:
        fail("Select at least one harness")
    if not models:
        fail("Select at least one model")
    for model in models:
        if not any(agent["model"] == model and agent["name"] in harnesses for agent in AGENTS):
            fail(f"Model {model} has no selected harness that can run it, select its harness too")
    return [agent for agent in AGENTS if agent["name"] in harnesses and agent["model"] in models]


def select_tasks(inputs: dict) -> list[str]:
    available = sorted(path.name for path in TASKS_DIR.iterdir() if path.is_dir())
    missing = [task for task in available if task_input(task) not in inputs]
    if missing:
        fail(f"No checkbox in the workflow for task(s): {', '.join(missing)}")
    tasks = [task for task in available if inputs[task_input(task)] is True]
    if not tasks:
        fail("Select at least one task")
    return tasks


def select_attempts(choice: str) -> list[int]:
    if not choice.isdigit() or not 1 <= int(choice) <= MAX_ATTEMPTS:
        fail(f"attempts must be a number from 1 to {MAX_ATTEMPTS}, got '{choice}'")
    return list(range(1, int(choice) + 1))


def plan(inputs: dict) -> list[dict]:
    jobs = [
        {"os": "linux", "task": task, "agent": agent, "attempt": attempt}
        for agent in select_agents(inputs)
        for task in select_tasks(inputs)
        for attempt in select_attempts(inputs["attempts"])
    ]
    if len(jobs) > MAX_JOBS:
        fail(f"{len(jobs)} jobs exceed the GitHub matrix limit of {MAX_JOBS}")
    return jobs


def summary(jobs: list[dict]) -> str:
    lines = [
        f"### Harbor benchmark plan: {len(jobs)} jobs",
        "",
        f"task: {', '.join(dict.fromkeys(job['task'] for job in jobs))}",
        f"agent: {', '.join(dict.fromkeys(label(job['agent']) for job in jobs))}",
        f"attempts: {max(job['attempt'] for job in jobs)}",
    ]
    return "\n".join(f"{line}  " if line else line for line in lines) + "\n"


def main() -> None:
    jobs = plan(json.loads(os.environ["INPUT_SELECTION"]))
    matrix = json.dumps({"include": jobs}, separators=(",", ":"))
    Path(os.environ.get("GITHUB_OUTPUT", "/dev/stdout")).open("a").write(f"matrix={matrix}\n")
    Path(os.environ.get("GITHUB_STEP_SUMMARY", "/dev/stderr")).open("a").write(summary(jobs))


if __name__ == "__main__":
    main()
