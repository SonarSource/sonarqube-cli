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

import { spawnProcess, spawnProcessCapturingBytes } from '@/core/process/process.ts';

// Three bytes per character, so the boundaries of power-of-two sized chunks fall inside one.
const WIDE_CHAR = '€';
const CHAR_COUNT = 200_000;
const EXPECTED = WIDE_CHAR.repeat(CHAR_COUNT);

function emitTo(stream: 'stdout' | 'stderr'): string[] {
  return ['-e', `process.${stream}.write('${WIDE_CHAR}'.repeat(${String(CHAR_COUNT)}))`];
}

describe('spawnProcess', () => {
  it('keeps a character whose bytes straddle two stdout chunks intact', async () => {
    const result = await spawnProcess(process.execPath, emitTo('stdout'), { stdout: 'pipe' });

    expect(result.stdout).toBe(EXPECTED);
  });

  it('keeps a character whose bytes straddle two stderr chunks intact', async () => {
    const result = await spawnProcess(process.execPath, emitTo('stderr'), { stderr: 'pipe' });

    expect(result.stderr).toBe(EXPECTED);
  });
});

describe('spawnProcessCapturingBytes', () => {
  it('keeps a character whose bytes straddle two stderr chunks intact', async () => {
    const result = await spawnProcessCapturingBytes(process.execPath, emitTo('stderr'), {
      stderr: 'pipe',
    });

    expect(result.stderr).toBe(EXPECTED);
  });
});
