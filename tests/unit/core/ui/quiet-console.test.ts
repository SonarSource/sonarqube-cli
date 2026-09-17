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

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import logger from '@/core/observability/logger.ts';
import { phaseItem } from '@/core/ui/console.ts';
import { QuietConsole } from '@/core/ui/quiet-console.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('QuietConsole', () => {
  let delegate: FakeConsole;
  let quiet: QuietConsole;
  let debugSpy: Mock<typeof logger.debug>;
  let debugLines: string[];

  beforeEach(() => {
    delegate = new FakeConsole();
    quiet = new QuietConsole(delegate);
    debugLines = [];
    debugSpy = spyOn(logger, 'debug').mockImplementation((message: string, ...args: unknown[]) => {
      debugLines.push([message, ...args.map(String)].join(' '));
    });
  });

  afterEach(() => {
    debugSpy.mockRestore();
  });

  it('forwards warnings and errors to the wrapped console', () => {
    quiet.warn('something looks off');
    quiet.error('something failed');

    expect(delegate.findCall('warn', 'something looks off')).toBeDefined();
    expect(delegate.findCall('error', 'something failed')).toBeDefined();
  });

  it('keeps informational output off the wrapped console, mirroring it to the debug log', () => {
    quiet.info('info message');
    quiet.success('success message');
    quiet.discreetSuccess('discreet message');
    quiet.text('text message');
    quiet.print('print message');
    quiet.blank();
    quiet.note('note content', 'Note title');
    quiet.phase('Installed', [phaseItem('Feature', 'done')]);
    quiet.intro('Intro title', 'subtitle');
    quiet.outro('Outro message', 'success');

    expect(delegate.calls).toEqual([]);
    expect(debugLines).toEqual([
      '[quiet] info info message',
      '[quiet] success success message',
      '[quiet] discreetSuccess discreet message',
      '[quiet] text text message',
      '[quiet] print print message',
      '[quiet] blank',
      '[quiet] note Note title note content',
      '[quiet] phase Installed Feature [done]',
      '[quiet] intro Intro title subtitle',
      '[quiet] outro Outro message success',
    ]);
  });

  it('flattens multi-line note content into a single log line', () => {
    quiet.note(['first line', 'second line'], 'Title');

    expect(debugLines).toEqual(['[quiet] note Title first line | second line']);
  });

  it('logs optional message parts when present and omits them when absent', () => {
    quiet.note('content', 'Note title');
    quiet.note('content');
    quiet.intro('Intro title', 'subtitle');
    quiet.intro('Intro title');
    quiet.outro('Outro message', 'success', 'detail');
    quiet.outro('Outro message');
    quiet.text('text message');
    quiet.text('');

    expect(debugLines).toEqual([
      '[quiet] note Note title content',
      '[quiet] note content',
      '[quiet] intro Intro title subtitle',
      '[quiet] intro Intro title',
      '[quiet] outro Outro message success detail',
      '[quiet] outro Outro message',
      '[quiet] text text message',
      '[quiet] text',
    ]);
  });

  it('runs spinner tasks through the wrapped console, propagating their outcome', async () => {
    const result = await quiet.withSpinner('Downloading', () => Promise.resolve('downloaded'));

    expect(result).toBe('downloaded');
    expect(delegate.findCall('spinner', 'Downloading')).toBeDefined();

    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(
      quiet.withSpinner('Verifying signature', () => Promise.reject(new Error('network down'))),
    ).rejects.toThrow('network down');
    expect(delegate.findCall('spinner', 'Verifying signature')).toBeDefined();
  });

  it('forwards prompts to the wrapped console', async () => {
    delegate.queueResponse('typed answer');

    expect(await quiet.textPrompt('What is your name?')).toBe('typed answer');
    expect(await quiet.confirmPrompt('Proceed?', true)).toBe(true);
    expect(await quiet.selectPrompt('Pick one', [{ value: 'a', label: 'A' }])).toBe('a');
    expect(await quiet.multiSelectPrompt('Pick many', [{ value: 'a', label: 'A' }])).toEqual([]);
    await quiet.pressEnterKeyPrompt('Press Enter to install');

    expect(delegate.calls.map((call) => call.method)).toEqual([
      'textPrompt',
      'confirmPrompt',
      'selectPrompt',
      'multiSelectPrompt',
      'pressAnyKeyPrompt',
    ]);
  });

  it('forwards the validation callbacks of promptUntilValid', async () => {
    delegate.queueResponse('');
    delegate.queueResponse('valid');

    const answer = await quiet.promptUntilValid(
      'Enter a value',
      (value) => value.length > 0,
      'Value must not be empty',
    );

    expect(answer).toBe('valid');
    expect(delegate.findCall('print', 'Value must not be empty')).toBeDefined();
  });

  it('does not expose a formatted-output mode', () => {
    quiet.setFormattedOutputMode(true);
    quiet.setFormattedOutputMode(false);

    expect(quiet.isFormattedOutputMode()).toBe(false);
    expect(quiet.getMessagesForFormattedOutput()).toEqual([]);
    expect(delegate.calls).toEqual([]);
    expect(debugLines).toEqual([
      '[quiet] setFormattedOutputMode true',
      '[quiet] setFormattedOutputMode false',
    ]);
  });
});
