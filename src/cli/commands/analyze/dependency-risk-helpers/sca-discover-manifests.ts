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

import { rmSync } from 'node:fs';

import type { SpawnResult } from '../../../../lib/process';
import { warn } from '../../../../ui';
import { CommandFailedError } from '../../_common/error';
import { formatSpawnOutput } from '../../_common/install/install-utils';
import type { ScaScannerInstaller } from '../../_common/install/sca-scanner';
import {
  SCA_SCANNER_PARSE_FAILURE_HINT,
  SCA_SCANNER_START_FAILURE_HINT,
  type ScaScannerInvocation,
} from './sca-scanner';
import { buildDiscoverManifestsArgs } from './sca-scanner-args';
import type { ScaScannerSpawner } from './sca-scanner-spawner';

// Response shape emitted on stdout by `sca-scanner discover-manifests`.
interface DiscoverManifestsPayload {
  files?: unknown;
}

/**
 * Runs the sca-scanner `discover-manifests` subcommand and returns the list of
 * discovered manifest/lockfile paths (relative to the invocation base dir).
 */
export class ScaDiscoverManifestsRunner {
  constructor(
    private readonly installer: ScaScannerInstaller,
    private readonly spawner: ScaScannerSpawner,
  ) {}

  async run(invocation: ScaScannerInvocation): Promise<string[]> {
    try {
      const binaryPath = await this.installer.install();
      let result: SpawnResult;
      try {
        result = await this.spawner.spawn(binaryPath, buildDiscoverManifestsArgs(invocation));
      } catch (err) {
        throw new CommandFailedError(`Manifest discovery error: ${(err as Error).message}`, {
          remediationHint: SCA_SCANNER_START_FAILURE_HINT,
        });
      }
      if ((result.exitCode ?? 1) !== 0) {
        throw new CommandFailedError(
          `Manifest discovery error: failed (exit code ${String(result.exitCode)}).\n` +
            formatSpawnOutput(result.stdout, result.stderr),
        );
      }
      let parsed: DiscoverManifestsPayload;
      try {
        parsed = JSON.parse(result.stdout) as DiscoverManifestsPayload;
      } catch (err) {
        throw new CommandFailedError(
          `Manifest discovery error: failed to parse output (${(err as Error).message})`,
          { remediationHint: SCA_SCANNER_PARSE_FAILURE_HINT },
        );
      }
      if (!Array.isArray(parsed.files)) {
        throw new CommandFailedError(
          `Manifest discovery error: returned unexpected output:\n${result.stdout}`,
        );
      }
      return parsed.files.filter((f): f is string => typeof f === 'string');
    } finally {
      this.cleanupWorkDir(invocation.workDir);
    }
  }

  private cleanupWorkDir(workDir: string): void {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`Failed to clean up SCA scanner working directory ${workDir}: ${reason}`);
    }
  }
}
