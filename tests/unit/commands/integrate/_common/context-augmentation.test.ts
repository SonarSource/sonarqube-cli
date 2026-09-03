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

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { resolveContextAugmentationSessionStartText } from '@/commands/integrate/_common/context-augmentation.ts';

const IS_WINDOWS = process.platform === 'win32';
const BASE_PARAMS = {
  organization: 'my-org',
  projectKey: 'my-project',
  serverUrl: 'https://sonarcloud.io',
  token: 'tok',
  timeoutMs: 5000,
};

describe.skipIf(IS_WINDOWS)('resolveContextAugmentationSessionStartText', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sonar-session-start-context-test-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function writeScript(name: string, body: string): string {
    const scriptPath = join(workDir, name);
    writeFileSync(scriptPath, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    return scriptPath;
  }

  it('returns the CAG process stdout on a clean success', async () => {
    const binaryPath = writeScript('success.sh', 'echo -n "Vortex context"');

    const result = await resolveContextAugmentationSessionStartText({
      ...BASE_PARAMS,
      binaryPath,
    });

    expect(result).toBe('Vortex context');
  });

  it('resolves null when the process exits non-zero', async () => {
    const binaryPath = writeScript('fail.sh', 'echo "boom" >&2\nexit 1');

    const result = await resolveContextAugmentationSessionStartText({
      ...BASE_PARAMS,
      binaryPath,
    });

    expect(result).toBeNull();
  });

  it('resolves null on an exit-0 process with empty stdout', async () => {
    const binaryPath = writeScript('empty.sh', 'exit 0');

    const result = await resolveContextAugmentationSessionStartText({
      ...BASE_PARAMS,
      binaryPath,
    });

    expect(result).toBeNull();
  });

  it('resolves null when the binary does not exist (spawn ENOENT)', async () => {
    const result = await resolveContextAugmentationSessionStartText({
      ...BASE_PARAMS,
      binaryPath: join(workDir, 'does-not-exist'),
    });

    expect(result).toBeNull();
  });

  it('kills a subprocess that outlives timeoutMs and resolves null promptly', async () => {
    const binaryPath = writeScript('slow.sh', 'sleep 5\necho "too late"');

    const start = Date.now();
    const result = await resolveContextAugmentationSessionStartText({
      ...BASE_PARAMS,
      binaryPath,
      timeoutMs: 200,
    });
    const elapsedMs = Date.now() - start;

    expect(result).toBeNull();
    // Generous upper bound (well under the unkilled process's 5s sleep) — proves the
    // subprocess was actually killed rather than merely abandoned by a promise race.
    expect(elapsedMs).toBeLessThan(3000);
  });
});
