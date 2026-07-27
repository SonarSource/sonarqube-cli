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

import { CommandFailedError } from '@/core/command-error.ts';
import type { SpawnResult } from '@/core/process/process.ts';

import { type ScaScannerInvocation, ScaScannerRunnerBase } from './sca-scanner-runner-base.ts';

// Response shape emitted on stdout by `sca-scanner discover-manifests`.
interface DiscoverManifestsPayload {
  files?: unknown;
}

/**
 * Runs the sca-scanner `discover-manifests` subcommand and returns the list of
 * discovered manifest/lockfile paths (relative to the invocation base dir).
 */
export class ScaDiscoverManifestsRunner extends ScaScannerRunnerBase<string[]> {
  protected readonly spinnerLabel = 'Discovering dependency manifests';
  protected readonly errorPrefix = 'Manifest discovery error';

  buildArgs(invocation: ScaScannerInvocation): string[] {
    return this.buildBaseArgs('discover-manifests', invocation);
  }

  protected parseResult(result: SpawnResult): string[] {
    const parsed = this.parseJson(result) as DiscoverManifestsPayload;
    if (!Array.isArray(parsed.files)) {
      throw new CommandFailedError(
        `${this.errorPrefix}: returned unexpected output:\n${result.stdout}`,
      );
    }
    return parsed.files.filter((f): f is string => typeof f === 'string');
  }
}
