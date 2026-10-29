/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Deadlines for spawnProcessWithTimeout. A caller picks the bucket that matches the command.

/** `--version` and other "does this tool answer" checks. */
export const VERSION_PROBE_TIMEOUT_MS = 10_000;

/** `docker`/`podman`/`nerdctl info`, including the same check through WSL. */
export const RUNTIME_INFO_TIMEOUT_MS = 3_000;

/** Local git metadata: config, rev-parse, branch, remote, status-sized diffs. */
export const GIT_METADATA_TIMEOUT_MS = 15_000;

/** `git log` of a push range and `git cat-file --batch`. */
export const GIT_CONTENT_TIMEOUT_MS = 60_000;

/** sonar-secrets scan of a file list or a single text payload. */
export const SECRETS_SCAN_TIMEOUT_MS = 30_000;

/** sonar-secrets scan of every blob on a push. */
export const SECRETS_PUSH_SCAN_TIMEOUT_MS = 2 * 60 * 1000;

/** Full dependency-risk scan. */
export const SCA_SCAN_TIMEOUT_MS = 3 * 60 * 1000;

/** `sca-scanner watch-patterns`. A pattern list, not a scan. */
export const SCA_WATCH_PATTERNS_TIMEOUT_MS = 15_000;

/** `pre-commit install` / `gc` and the shorter uninstall and clean steps. */
export const PRE_COMMIT_TIMEOUT_MS = 2 * 60 * 1000;

/** Interactive `sonar-secrets allowlist`. A hang ceiling, not a guess at how long a prompt takes. */
export const INTERACTIVE_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** Vortex Context commands that print a result (`print-session-start-context`, `print-skill`, `stop`). */
export const CONTEXT_COMMAND_TIMEOUT_MS = 30_000;

/** `sonar-context-augmentation tool integrate`, which may set up a workspace on first run. */
export const CONTEXT_INTEGRATE_TIMEOUT_MS = 2 * 60 * 1000;
