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

import { resolve } from 'node:path';

import { canonicalizePath } from '@/core/io/fs-utils.ts';
import type { SecretsScanSettings } from '@/core/secrets/scan-settings.ts';

/** Commander collector for the repeatable `--exclude` option. */
export function collectExcludeOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** Options of a single `analyze secrets` run; hooks and the other scanners never set them. */
export interface SecretsScanRunOptions {
  /**
   * When non-empty, replaces the configured exclusions, resolving against the cwd and canonicalized like them, since
   * sonar-secrets only matches canonical paths.
   */
  exclusionsOverride?: readonly string[];
  /** Makes sonar-secrets add the raw value to each issue as `secret`. */
  dangerousShowSecrets?: boolean;
}

export function buildSecretsScanArgs(
  settings: SecretsScanSettings,
  runOptions: SecretsScanRunOptions = {},
): string[] {
  const args = ['--max-file-size', String(settings.maxFileSize)];
  const exclusionsOverride = runOptions.exclusionsOverride ?? [];
  const exclusions =
    exclusionsOverride.length > 0
      ? exclusionsOverride.map((path) => canonicalizePath(resolve(process.cwd(), path)))
      : settings.exclusions;
  for (const path of exclusions) {
    // The `=` form keeps a path that starts with `-` from being read as another option.
    args.push(`--exclude=${path}`);
  }
  if (settings.disableTestFileDetection) args.push('--disable-test-file-detection');
  if (settings.disableEntropyFilter) args.push('--disable-entropy-filter');
  if (settings.disableKnownFakeSecretFilter) args.push('--disable-known-fake-secret-filter');
  if (settings.demoMode) args.push('--demo-mode');
  if (runOptions.dangerousShowSecrets) args.push('--dangerous-show-secrets');
  return args;
}
