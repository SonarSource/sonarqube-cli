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

import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateRepository from '@/core/state/state-repository.ts';

import { configureStats } from '../../../../src/commands/config/stats.ts';
import { FakeConsole } from '../../../_common/fake-console.ts';

let loadStateSpy: ReturnType<typeof spyOn>;
let saveStateSpy: ReturnType<typeof spyOn>;
let fake: FakeConsole;
let ctx: CommandInvocationContext;

beforeEach(() => {
  fake = new FakeConsole();
  ctx = new CommandInvocationContext(fake);
  loadStateSpy = spyOn(stateRepository, 'loadState').mockReturnValue(getDefaultState('1.0.0'));
  saveStateSpy = spyOn(stateRepository, 'saveState').mockImplementation(() => undefined);
});

afterEach(() => {
  loadStateSpy.mockRestore();
  saveStateSpy.mockRestore();
});

describe('configureStats', () => {
  it('rejects when both --enabled and --disabled are given', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(configureStats({ enabled: true, disabled: true }, ctx)).rejects.toThrow(
      'Cannot use both --enabled and --disabled',
    );
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('reports the current status when no flags are given', async () => {
    await configureStats({}, ctx);

    expect(fake.findCall('info', 'Stats collection is currently enabled.')).toBeDefined();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  it('persists enabled and reports success when --enabled is given', async () => {
    await configureStats({ enabled: true }, ctx);

    expect(saveStateSpy).toHaveBeenCalled();
    expect(saveStateSpy.mock.calls[0][0].stats).toEqual({ enabled: true });
    expect(fake.findCall('success', 'Stats collection enabled.')).toBeDefined();
  });

  it('persists disabled and reports success when --disabled is given', async () => {
    await configureStats({ disabled: true }, ctx);

    expect(saveStateSpy).toHaveBeenCalled();
    expect(saveStateSpy.mock.calls[0][0].stats).toEqual({ enabled: false });
    expect(fake.findCall('success', 'Stats collection disabled.')).toBeDefined();
  });
});
