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

import type { SecretsScanSettings } from '@/core/secrets/scan-settings.ts';

/** Commander collector for the repeatable `--exclude` option. */
export function collectExcludeOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * `exclusionsOverride` comes from the command line: when non-empty it replaces the configured exclusions, and is
 * passed as given, so it resolves against the cwd.
 */
export function buildSecretsScanArgs(
  settings: SecretsScanSettings,
  exclusionsOverride: readonly string[] = [],
): string[] {
  const args = ['--max-file-size', String(settings.maxFileSize)];
  const exclusions = exclusionsOverride.length > 0 ? exclusionsOverride : settings.exclusions;
  for (const path of exclusions) {
    // The `=` form keeps a path that starts with `-` from being read as another option.
    args.push(`--exclude=${path}`);
  }
  if (settings.disableTestFileDetection) args.push('--disable-test-file-detection');
  if (settings.disableEntropyFilter) args.push('--disable-entropy-filter');
  if (settings.disableKnownFakeSecretFilter) args.push('--disable-known-fake-secret-filter');
  if (settings.demoMode) args.push('--demo-mode');
  return args;
}
