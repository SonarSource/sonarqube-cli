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

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { printGitPreflightSummary } from '@/commands/integrate/_common/preflight-summary.ts';
import * as processLib from '@/core/process/process.ts';
import type { PhaseItem } from '@/core/ui/console.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';

let fake: FakeConsole;

beforeEach(() => {
  fake = new FakeConsole();
});

describe('printGitPreflightSummary', () => {
  let spawnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    spawnSpy = spyOn(processLib, 'spawnProcess').mockImplementation((_cmd, args) => {
      if (args[0] === 'config') {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      }
      return Promise.resolve({ exitCode: 0, stdout: '.git/hooks', stderr: '' });
    });
  });

  afterEach(() => {
    spawnSpy.mockRestore();
  });

  it('renders Repository section with hooks directory and framework', async () => {
    await printGitPreflightSummary('/repo/root', fake);

    const items = getPhaseItems('Repository');
    expect(items.find((i) => i.text === 'Root')?.detail).toBe('/repo/root');
    expect(items.find((i) => i.text === 'Hooks directory')?.detail).toContain('hooks');
    expect(items.find((i) => i.text === 'Framework')?.detail).toBe('native git hooks');
  });
});

function getPhaseItems(title: string): PhaseItem[] {
  const call = fake.calls.find((c) => c.method === 'phase' && c.args[0] === title);
  return (call?.args[1] ?? []) as PhaseItem[];
}
