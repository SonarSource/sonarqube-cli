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

import logger from '@/core/observability/logger.ts';
import { phaseItem } from '@/core/ui/console.ts';
import { SilentConsole } from '@/core/ui/silent-console.ts';

describe('SilentConsole', () => {
  let silent: SilentConsole;
  let stdoutSpy: ReturnType<typeof spyOn<typeof process.stdout, 'write'>>;
  let stderrSpy: ReturnType<typeof spyOn<typeof process.stderr, 'write'>>;
  beforeEach(() => {
    silent = new SilentConsole();
    stdoutSpy = spyOn(process.stdout, 'write').mockReturnValue(true);
    stderrSpy = spyOn(process.stderr, 'write').mockReturnValue(true);
  });

  afterEach(() => {
    try {
      expect(stdoutSpy).not.toHaveBeenCalled();
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('keeps informational output and formatted responses off terminal streams', () => {
    silent.info('info');
    silent.success('success');
    silent.discreetSuccess('success', 'stderr');
    silent.text('text');
    silent.print('print');
    silent.blank();
    silent.note(['first', 'second'], 'Note');
    silent.phase('Phase', [phaseItem('Feature', 'done')]);
    silent.intro('Intro', 'subtitle');
    silent.outro('Outro', 'success', 'detail');
    silent.setFormattedOutputMode(true);
    expect(silent.isFormattedOutputMode()).toBe(false);
    expect(silent.getMessagesForFormattedOutput()).toEqual([]);
  });

  it('logs warnings and errors to the file logger', () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => {});
    try {
      silent.warn('migration warning');
      silent.error('migration error');
      expect(warnSpy).toHaveBeenCalledWith('migration warning');
      expect(errorSpy).toHaveBeenCalledWith('migration error');
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('runs spinner tasks without output and preserves results and failures', async () => {
    expect(await silent.withSpinner('Downloading', () => Promise.resolve('binary'))).toBe('binary');
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      silent.withSpinner('Verifying', () => Promise.reject(new Error('invalid signature'))),
    ).rejects.toThrow('invalid signature');
  });

  it('disables every prompt without consuming input', async () => {
    expect(silent.canPrompt()).toBe(false);
    expect(await silent.textPrompt('Text')).toBeNull();
    expect(await silent.passwordPrompt('Password')).toBeNull();
    expect(await silent.confirmPrompt('Confirm', true)).toBeNull();
    expect(await silent.selectPrompt('Select', [])).toBeNull();
    expect(
      await silent.searchPrompt('Search', {
        search: () => Promise.resolve({ options: [], total: 0 }),
      }),
    ).toBeNull();
    const tree = { roots: [], loadChildren: () => Promise.resolve([]) };
    expect(await silent.treePrompt('Tree', tree)).toBeNull();
    expect(await silent.treeMultiSelectPrompt('Trees', tree)).toBeNull();
    expect(await silent.multiSelectPrompt('Multiple', [])).toBeNull();
    expect(await silent.promptUntilValid('Valid', () => false, 'Invalid')).toBeNull();
    await silent.pressEnterKeyPrompt('Continue');
  });
});
