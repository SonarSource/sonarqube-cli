#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

TASKS_DIR = Path(__file__).resolve().parents[1] / "tasks"
MAX_ATTEMPTS = 10
MAX_JOBS = 256

ALL_AGENTS = "all agents and models"
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


def select_agents(choice: str) -> list[dict]:
    if choice == ALL_AGENTS:
        return AGENTS
    selected = [agent for agent in AGENTS if label(agent) == choice]
    if not selected:
        fail(f"Unknown agent '{choice}', expected one of: {', '.join([*map(label, AGENTS), ALL_AGENTS])}")
    return selected


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
        for agent in select_agents(inputs["agent"])
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
