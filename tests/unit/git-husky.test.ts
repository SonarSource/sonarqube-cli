/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { installViaHusky } from '../../src/cli/commands/integrate/git/git-husky';
import {
  HOOK_MARKER,
  getHuskyPreCommitSnippet,
  getHuskyPrePushSnippet,
} from '../../src/cli/commands/integrate/git/git-shell-fragments';
import { setMockUi, getMockUiCalls, clearMockUiCalls } from '../../src/ui';

const TEMP_DIR = join(process.cwd(), 'tests', 'unit', '.git-husky-tmp');
const HOOK_PATH = join(TEMP_DIR, 'pre-commit');

// Simulating failure from `command -v sonar`
const MINIMAL_SH_PATH = '/usr/bin:/bin';

// Run a script with `sh -e`, same idea as Husky’s hook wrapper.
function shEc(script: string) {
  return Bun.spawnSync(['sh', '-ec', script], {
    env: { ...process.env, PATH: MINIMAL_SH_PATH },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('installViaHusky', () => {
  beforeEach(() => {
    mkdirSync(TEMP_DIR, { recursive: true });
    setMockUi(true);
    clearMockUiCalls();
  });

  afterEach(() => {
    setMockUi(false);
    rmSync(TEMP_DIR, { recursive: true, force: true });
  });

  it('writes the snippet when the hook file does not exist', async () => {
    await installViaHusky(HOOK_PATH, 'pre-commit');

    const content = readFileSync(HOOK_PATH, 'utf-8');
    expect(content).toContain(HOOK_MARKER);
  });

  it('appends the pre-commit snippet to an existing hook file that has no marker', async () => {
    writeFileSync(HOOK_PATH, '#!/bin/sh\necho "existing hook"\n');

    await installViaHusky(HOOK_PATH, 'pre-commit');

    const content = readFileSync(HOOK_PATH, 'utf-8');
    expect(content).toContain('existing hook');
    expect(content).toContain(HOOK_MARKER);
    expect(content).toContain(getHuskyPreCommitSnippet());
    expect(
      getMockUiCalls().some(
        (c) => c.method === 'success' && String(c.args[0]).includes('pre-commit'),
      ),
    ).toBe(true);
  });

  it('appends the pre-push snippet when hook type is pre-push', async () => {
    const hookPath = join(TEMP_DIR, 'pre-push');
    writeFileSync(hookPath, '#!/bin/sh\necho "existing hook"\n');

    await installViaHusky(hookPath, 'pre-push');

    const content = readFileSync(hookPath, 'utf-8');
    expect(content).toContain(getHuskyPrePushSnippet());
    expect(
      getMockUiCalls().some(
        (c) => c.method === 'success' && String(c.args[0]).includes('pre-push'),
      ),
    ).toBe(true);
  });

  it('does not write the file when the marker is already present', async () => {
    writeFileSync(HOOK_PATH, `#!/bin/sh\n# ${HOOK_MARKER}\necho "already installed"\n`);
    const before = readFileSync(HOOK_PATH, 'utf-8');

    await installViaHusky(HOOK_PATH, 'pre-commit');

    expect(readFileSync(HOOK_PATH, 'utf-8')).toBe(before);
    expect(getMockUiCalls().some((c) => c.method === 'info')).toBe(true);
    expect(getMockUiCalls().some((c) => c.method === 'success')).toBe(false);
  });
});

describe('git-shell-fragments (sonar resolution)', () => {
  it.each([
    [
      'native',
      'SONAR_BIN=$(command -v sonar 2>/dev/null || :); ' +
        '[ -z "$SONAR_BIN" ] && { echo skip-secrets-scan; exit 0; }; ' +
        'exit 99',
    ],
    [
      'husky CLEAN_PATH',
      String.raw`CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':' | sed 's/:$//'); ` +
        'SONAR_BIN=$(PATH=$CLEAN_PATH command -v sonar 2>/dev/null || :); ' +
        '[ -z "$SONAR_BIN" ] && { echo skip-secrets-scan; exit 0; }; ' +
        'exit 99',
    ],
  ])('under sh -e, missing sonar skips (%s)', (_, script) => {
    const r = shEc(script);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain('skip-secrets-scan');
  });

  it('regression: sonar lookup without || : aborts under sh -e before empty check', () => {
    const script =
      'SONAR_BIN=$(command -v sonar 2>/dev/null); ' +
      '[ -z "$SONAR_BIN" ] && { echo skip-secrets-scan; exit 0; }; ' +
      'exit 99';
    const r = shEc(script);
    expect(r.stdout.toString()).not.toContain('skip-secrets-scan');
    expect(r.exitCode).not.toBe(0);
  });
});
