import asyncio
import contextlib
import os
import shutil
import signal
from pathlib import Path

from harbor.environments.base import BaseEnvironment, ExecResult
from harbor.environments.capabilities import EnvironmentCapabilities

ALLOW_ENV_VAR = "HARBOR_HOST_ENVIRONMENT_ALLOW"
CI_ENV_VAR = "GITHUB_ACTIONS"
SCRATCH_ROOTS = ("/app", "/tests", "/solution", "/logs")
LOG_DIRS = ("/logs/agent", "/logs/verifier", "/logs/artifacts")
DEFAULT_CWD = "/app"
RUNNER_ENV_PREFIXES = ("ACTIONS_", "GITHUB_", "RUNNER_")


class HostEnvironment(BaseEnvironment):
    @staticmethod
    def type() -> str:
        return "host"

    @property
    def capabilities(self) -> EnvironmentCapabilities:
        return EnvironmentCapabilities()

    def _validate_definition(self) -> None:
        if not (os.environ.get(CI_ENV_VAR) or os.environ.get(ALLOW_ENV_VAR)):
            raise RuntimeError(
                f"The host environment wipes {', '.join(SCRATCH_ROOTS)} on the machine it runs on. "
                f"It only starts when {CI_ENV_VAR} or {ALLOW_ENV_VAR} is set."
            )

    async def start(self, force_build: bool) -> None:
        for root in SCRATCH_ROOTS:
            self._reset_dir(Path(root))
        for log_dir in LOG_DIRS:
            Path(log_dir).mkdir(parents=True, exist_ok=True)

    async def stop(self, delete: bool) -> None:
        return None

    async def exec(
        self,
        command: str,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout_sec: int | None = None,
        user: str | int | None = None,
    ) -> ExecResult:
        agent_visible_env = {
            name: value
            for name, value in os.environ.items()
            if not name.startswith(RUNNER_ENV_PREFIXES)
        }
        merged_env = {**agent_visible_env, **(self._merge_env(env) or {})}
        self._resolve_user(user)
        process = await asyncio.create_subprocess_exec(
            "bash",
            "-c",
            command,
            cwd=cwd or DEFAULT_CWD,
            env=merged_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(), timeout=timeout_sec
            )
        except asyncio.TimeoutError:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
            raise
        return ExecResult(
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
            return_code=process.returncode if process.returncode is not None else -1,
        )

    async def upload_file(self, source_path: Path | str, target_path: str) -> None:
        self._copy_file(source_path, target_path)

    async def upload_dir(self, source_dir: Path | str, target_dir: str) -> None:
        self._copy_dir(source_dir, target_dir)

    async def download_file(self, source_path: str, target_path: Path | str) -> None:
        self._copy_file(source_path, target_path)

    async def download_dir(self, source_dir: str, target_dir: Path | str) -> None:
        self._copy_dir(source_dir, target_dir)

    @staticmethod
    def _copy_file(source: Path | str, target: Path | str) -> None:
        Path(target).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)

    @staticmethod
    def _copy_dir(source: Path | str, target: Path | str) -> None:
        shutil.copytree(source, target, dirs_exist_ok=True)

    @staticmethod
    def _reset_dir(directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        for entry in directory.iterdir():
            if entry.is_dir() and not entry.is_symlink():
                shutil.rmtree(entry)
            else:
                entry.unlink()
