#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import Counter
from pathlib import Path

KNOWN_SECRETS_FILE = Path(__file__).with_name("known-secrets.txt")
CREDENTIAL_ENV_VARS = ("SONARQUBE_CLI_TOKEN", "PORTKEY_API_KEY")
MIN_CREDENTIAL_LENGTH = 8
MARKER_FILE = "secrets-leak.json"
REDACTION = "[REDACTED]"
PLACEHOLDER = "KNOWN_PUBLIC_FAKE_SECRET"
SCAN_SUFFIX = ".txt"
EXIT_SECRETS_FOUND = 51
SCAN_TIMEOUT_SECONDS = 900


class Issue:
    def __init__(self, raw: dict):
        self.path = Path(raw["file"][: -len(SCAN_SUFFIX)])
        self.rule = raw["ruleKey"]
        self.start = (raw["location"]["startLine"], raw["location"]["startColumn"])
        self.end = (raw["location"]["endLine"], raw["location"]["endColumn"])


def inside(root: Path, relative: Path) -> Path:
    candidate = root / relative
    resolved = candidate.resolve()
    if candidate.is_symlink() or (resolved != root and root not in resolved.parents):
        raise ValueError(f"{relative.as_posix()} is a symlink or leaves {root}")
    return resolved


def list_files(root: Path, target: Path) -> list[Path]:
    if target.is_file():
        return [Path(target.name)]
    return sorted(
        path.relative_to(root)
        for path in target.rglob("*")
        if path.is_file() and not path.is_symlink()
    )


def secrets_binary() -> Path:
    bin_dir = Path(os.environ.get("SONAR_USER_HOME") or Path.home() / ".sonar") / "sonarqube-cli" / "bin"
    if not list(bin_dir.glob("sonar-secrets-*")):
        with tempfile.NamedTemporaryFile() as probe:
            subprocess.run(["sonar", "analyze", "secrets", probe.name], check=True, stdout=subprocess.DEVNULL)
    return max(bin_dir.glob("sonar-secrets-*"))


def known_value_fillers() -> list[tuple[bytes, bytes]]:
    values = [line for line in KNOWN_SECRETS_FILE.read_text().splitlines() if line]
    return [(value.encode(), (PLACEHOLDER * len(value))[: len(value)].encode()) for value in values]


def write_scan_copy(root: Path, files: list[Path], destination: Path) -> None:
    fillers = known_value_fillers()
    for relative in files:
        copy = inside(destination, Path(str(relative) + SCAN_SUFFIX))
        copy.parent.mkdir(parents=True, exist_ok=True)
        data = inside(root, relative).read_bytes()
        for value, filler in fillers:
            data = data.replace(value, filler)
        copy.write_bytes(data)


def scan(root: Path, files: list[Path]) -> list[Issue]:
    environment = {
        **os.environ,
        "SONAR_SECRETS_AUTH_URL": os.environ["SONARQUBE_CLI_SERVER"],
        "SONAR_SECRETS_TOKEN": os.environ["SONARQUBE_CLI_TOKEN"],
    }
    with tempfile.TemporaryDirectory() as directory:
        copy_root = Path(directory).resolve() / "scan"
        copy_root.mkdir()
        write_scan_copy(root, files, copy_root)
        result = subprocess.run(
            [
                str(secrets_binary()),
                "--non-interactive",
                "--json",
                "--max-file-size=0",
                "--disable-test-file-detection",
                str(copy_root),
            ],
            env=environment,
            capture_output=True,
            text=True,
            timeout=SCAN_TIMEOUT_SECONDS,
        )
    if result.returncode not in (0, EXIT_SECRETS_FOUND):
        sys.exit(f"sonar-secrets exited with {result.returncode}: {result.stderr.strip()}")
    report = json.loads(result.stdout)
    if report["errors"]:
        sys.exit("sonar-secrets reported errors: " + "; ".join(str(error) for error in report["errors"]))
    return [Issue(raw) for raw in report["issues"]]


def record(leaks: dict, relative: Path, rule: str, count: int) -> None:
    entry = leaks.setdefault(relative, {"rules": Counter(), "redacted": True})
    entry["rules"][rule] += count


def redact_credentials(root: Path, files: list[Path], leaks: dict) -> None:
    credentials = [
        (name, os.environ[name].encode())
        for name in CREDENTIAL_ENV_VARS
        if len(os.environ.get(name, "")) >= MIN_CREDENTIAL_LENGTH
    ]
    for relative in files:
        data = inside(root, relative).read_bytes()
        updated = data
        for name, value in credentials:
            count = updated.count(value)
            if count:
                updated = updated.replace(value, REDACTION.encode())
                record(leaks, relative, f"env:{name}", count)
                print(f"LEAK {relative.as_posix()} env:{name}")
        if updated != data:
            inside(root, relative).write_bytes(updated)


def text_offset(text: str, line_starts: list[int], line: int, utf16_column: int) -> int:
    index = line_starts[line - 1]
    units = 0
    while units < utf16_column and index < len(text):
        units += 2 if ord(text[index]) > 0xFFFF else 1
        index += 1
    return index


def merged(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    result: list[tuple[int, int]] = []
    for start, end in sorted(ranges):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(result[-1][1], end))
        else:
            result.append((start, end))
    return result


def redact_ranges(path: Path, issues: list[Issue]) -> None:
    text = path.read_bytes().decode("utf-8", "surrogateescape")
    line_starts = [0] + [match.end() for match in re.finditer("\n", text)]
    try:
        ranges = [
            (
                text_offset(text, line_starts, issue.start[0], issue.start[1]),
                text_offset(text, line_starts, issue.end[0], issue.end[1]),
            )
            for issue in issues
        ]
    except IndexError:
        return
    for start, end in reversed(merged(ranges)):
        text = text[:start] + REDACTION + text[end:]
    path.write_bytes(text.encode("utf-8", "surrogateescape"))


def purge_findings(root: Path, files: list[Path]) -> set[Path]:
    flagged = {issue.path for issue in scan(root, files)}
    for relative in flagged:
        inside(root, relative).unlink()
    return flagged


def marker_directory(root: Path, relative: Path) -> Path:
    return inside(root, Path(*relative.parts[: min(len(relative.parts) - 1, 2)]))


def write_markers(root: Path, leaks: dict) -> None:
    by_directory: dict[Path, list[dict]] = {}
    for relative, entry in leaks.items():
        by_directory.setdefault(marker_directory(root, relative), []).append(
            {"path": relative.as_posix(), "rules": dict(entry["rules"]), "redacted": entry["redacted"]}
        )
    for directory, entries in by_directory.items():
        (directory / MARKER_FILE).write_text(json.dumps({"files": entries}, indent=2) + "\n")


def scan_and_redact(target: Path) -> int:
    root = target.parent if target.is_file() else target
    files = list_files(root, target)
    leaks: dict[Path, dict] = {}

    redact_credentials(root, files, leaks)
    issues = scan(root, files)
    for issue in issues:
        record(leaks, issue.path, issue.rule, 1)
        print(f"LEAK {issue.path.as_posix()}:{issue.start[0]} {issue.rule}")
    for relative in {issue.path for issue in issues}:
        redact_ranges(inside(root, relative), [issue for issue in issues if issue.path == relative])

    for relative in purge_findings(root, [path for path in files if inside(root, path).exists()]):
        leaks[relative]["redacted"] = False
        print(f"NOT REDACTED, removed from the published set: {relative.as_posix()}")

    if target.is_dir():
        write_markers(root, leaks)
    final_files = list_files(root, target) if target.exists() else []
    for relative in purge_findings(root, final_files):
        print(f"Removed from the published set after redaction: {relative.as_posix()}", file=sys.stderr)
        leaks.setdefault(relative, {"rules": Counter(), "redacted": False})

    if leaks:
        print(f"Secrets found in {len(leaks)} file(s) of {target}, published copy redacted where possible")
        return 1
    print(f"No secrets found in {target}")
    return 0


def remove(target: Path) -> None:
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()


def main() -> int:
    requested = Path(sys.argv[1])
    if requested.is_symlink():
        sys.exit(f"{requested} is a symlink, refusing to scan")
    target = requested.resolve()
    if not target.exists():
        print(f"Nothing to scan: {target} does not exist")
        return 0
    try:
        return scan_and_redact(target)
    except BaseException:
        remove(target)
        print(f"Scan failed, removed {target} so that nothing from it is published", file=sys.stderr)
        raise


if __name__ == "__main__":
    sys.exit(main())
