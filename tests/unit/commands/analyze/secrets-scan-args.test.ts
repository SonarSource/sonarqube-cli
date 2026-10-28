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

import { describe, expect, it } from 'bun:test';

import { buildSecretsScanArgs } from '@/commands/analyze/secrets-scan-args.ts';
import { MAX_SCANNED_FILE_SIZE } from '@/core/config-constants.ts';
import { DEFAULT_SECRETS_SCAN_SETTINGS } from '@/core/secrets/scan-settings.ts';

describe('buildSecretsScanArgs', () => {
  it('passes only the size limit with the default settings', () => {
    expect(buildSecretsScanArgs(DEFAULT_SECRETS_SCAN_SETTINGS)).toEqual([
      '--max-file-size',
      String(MAX_SCANNED_FILE_SIZE),
    ]);
  });

  it('passes command-line exclusions instead of the configured ones, then every enabled switch', () => {
    const args = buildSecretsScanArgs(
      {
        maxFileSize: 10,
        exclusions: ['/repo/vendor'],
        disableTestFileDetection: true,
        disableEntropyFilter: true,
        disableKnownFakeSecretFilter: true,
        demoMode: true,
      },
      ['fixtures'],
    );

    expect(args).toEqual([
      '--max-file-size',
      '10',
      '--exclude=fixtures',
      '--disable-test-file-detection',
      '--disable-entropy-filter',
      '--disable-known-fake-secret-filter',
      '--demo-mode',
    ]);
  });

  it('passes the configured exclusions when there is no command-line override', () => {
    const settings = { ...DEFAULT_SECRETS_SCAN_SETTINGS, exclusions: ['/repo/vendor'] };

    expect(buildSecretsScanArgs(settings)).toContain('--exclude=/repo/vendor');
    expect(buildSecretsScanArgs(settings, [])).toContain('--exclude=/repo/vendor');
  });
});
