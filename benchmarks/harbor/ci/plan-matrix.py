#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

TASKS_DIR = Path(__file__).resolve().parents[1] / "tasks"
ALL_AGENTS = "all agents and models"
ALL_TASKS = "all"
BOTH_OS = "both"
MAX_ATTEMPTS = 10
MAX_JOBS = 256

AGENTS = [
    {"name": "claude-code", "provider": "anthropic", "model": "claude-sonnet-5-5", "os": ["linux", "macos"]},
    {"name": "claude-code", "provider": "anthropic", "model": "claude-haiku-5-5", "os": ["linux", "macos"]},
    {"name": "codex", "provider": "openai", "model": "gpt-6.1-terra", "os": ["linux"]},
]
OPERATING_SYSTEMS = ["linux", "macos"]


def label(agent: dict) -> str:
    return f"{agent['name']} : {agent['model']}"


def fail(message: str) -> None:
    print(f"::error::{message}", file=sys.stderr)
    sys.exit(1)


def select_operating_systems(choice: str) -> list[str]:
    if choice == BOTH_OS:
        return OPERATING_SYSTEMS
    if choice not in OPERATING_SYSTEMS:
        fail(f"Unknown os '{choice}', expected one of: {', '.join([*OPERATING_SYSTEMS, BOTH_OS])}")
    return [choice]


def select_agents(choice: str) -> list[dict]:
    if choice == ALL_AGENTS:
        return AGENTS
    selected = [agent for agent in AGENTS if label(agent) == choice]
    if not selected:
        fail(f"Unknown agent '{choice}', expected one of: {', '.join([*map(label, AGENTS), ALL_AGENTS])}")
    return selected


def select_tasks(choice: str) -> list[str]:
    available = sorted(path.name for path in TASKS_DIR.iterdir() if path.is_dir())
    if choice == ALL_TASKS:
        return available
    if choice not in available:
        fail(f"Unknown task '{choice}', expected one of: {', '.join([*available, ALL_TASKS])}")
    return [choice]


def select_attempts(choice: str) -> list[int]:
    if not choice.isdigit() or not 1 <= int(choice) <= MAX_ATTEMPTS:
        fail(f"attempts must be a number from 1 to {MAX_ATTEMPTS}, got '{choice}'")
    return list(range(1, int(choice) + 1))


def plan(os_choice: str, agent_choice: str, task_choice: str, attempts_choice: str) -> tuple[list[dict], list[str]]:
    operating_systems = select_operating_systems(os_choice)
    agents = select_agents(agent_choice)
    tasks = select_tasks(task_choice)
    attempts = select_attempts(attempts_choice)
    jobs = []
    skipped = []
    for operating_system in operating_systems:
        for agent in agents:
            if operating_system not in agent["os"]:
                skipped.append(f"{label(agent)} does not run on {operating_system}")
                continue
            for task in tasks:
                for attempt in attempts:
                    jobs.append({
                        "os": operating_system,
                        "task": task,
                        "agent": {key: agent[key] for key in ("name", "provider", "model")},
                        "attempt": attempt,
                    })
    if not jobs:
        fail("; ".join(skipped))
    if len(jobs) > MAX_JOBS:
        fail(f"{len(jobs)} jobs exceed the GitHub matrix limit of {MAX_JOBS}")
    return jobs, skipped


def summary(jobs: list[dict], skipped: list[str]) -> str:
    lines = [f"### Harbor benchmark plan: {len(jobs)} jobs", ""]
    for key in ("os", "task"):
        lines.append(f"{key}: {', '.join(dict.fromkeys(job[key] for job in jobs))}")
    lines.append(f"agent: {', '.join(dict.fromkeys(label(job['agent']) for job in jobs))}")
    lines.append(f"attempts: {max(job['attempt'] for job in jobs)}")
    lines.extend(f"skipped: {reason}" for reason in skipped)
    return "\n".join(f"{line}  " if line else line for line in lines) + "\n"


def main() -> None:
    jobs, skipped = plan(
        os.environ["INPUT_OS"],
        os.environ["INPUT_AGENT"],
        os.environ["INPUT_TASK"],
        os.environ["INPUT_ATTEMPTS"],
    )
    matrix = json.dumps({"include": jobs}, separators=(",", ":"))
    Path(os.environ.get("GITHUB_OUTPUT", "/dev/stdout")).open("a").write(f"matrix={matrix}\n")
    Path(os.environ.get("GITHUB_STEP_SUMMARY", "/dev/stderr")).open("a").write(summary(jobs, skipped))


if __name__ == "__main__":
    main()
