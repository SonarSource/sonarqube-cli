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

// Installs tests/integration/resources/recording-stub.ts in place of a dependency binary and reads back what it
// recorded.

import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TestHarness } from './index.ts';
import { IS_WINDOWS } from './platform';

export const SECRETS_INVOCATIONS_FILE = 'secrets-invocations.jsonl';
export const SCA_SCANNER_INVOCATIONS_FILE = 'sca-scanner-invocations.jsonl';

export interface StubResponse {
  stdout?: string;
  exitCode?: number;
}

export interface RecordingStubConfig {
  invocationsFile: string;
  /** Real binary run with the recorded argv and stdio. When absent, the stub answers from `responses`. */
  delegate?: string;
  /** Keyed by the first argument (the subcommand). */
  responses?: Record<string, StubResponse>;
  fallback?: StubResponse;
}

export interface RecordedInvocation {
  argv: string[];
}

const STUB_SOURCE_DIR = join(import.meta.dir, '..', 'resources');
const EXECUTABLE_PERMS = 0o755;

export function installRecordingStub(destPath: string, config: RecordingStubConfig): void {
  const source = join(STUB_SOURCE_DIR, IS_WINDOWS ? 'recording-stub.exe' : 'recording-stub');
  if (!existsSync(source)) {
    throw new Error(
      `Recording stub binary not found at: ${source}\nRun 'bun run pretest:integration' to compile it.`,
    );
  }
  mkdirSync(join(destPath, '..'), { recursive: true });
  copyFileSync(source, destPath);
  if (!IS_WINDOWS) {
    chmodSync(destPath, EXECUTABLE_PERMS);
  }
  writeFileSync(`${destPath}.stub.json`, JSON.stringify(config), 'utf-8');
}

/** Every recorded sonar-secrets run, including `--version` probes. */
export function readSecretsInvocations(harness: TestHarness): RecordedInvocation[] {
  return readInvocations(harness, SECRETS_INVOCATIONS_FILE);
}

/** Recorded sonar-secrets scans: every run that asked for the `--json` report. */
export function readSecretsScanArgvs(harness: TestHarness): string[][] {
  return readSecretsInvocations(harness)
    .map((invocation) => invocation.argv)
    .filter((argv) => argv.includes('--json'));
}

export function readScaScannerInvocations(harness: TestHarness): RecordedInvocation[] {
  return readInvocations(harness, SCA_SCANNER_INVOCATIONS_FILE);
}

function readInvocations(harness: TestHarness, fileName: string): RecordedInvocation[] {
  const file = harness.cliHome.file(fileName);
  if (!file.exists()) return [];
  return file
    .asText()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RecordedInvocation);
}
