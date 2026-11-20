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

import { TerminalConsole } from '@/core/ui/terminal-console.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('TerminalConsole user wait', () => {
  it('starts at zero', () => {
    expect(new TerminalConsole().userWaitMs()).toBe(0);
  });

  it('adds up every measured wait and returns its result', async () => {
    const console = new TerminalConsole();

    const result = await console.measureWait(async () => {
      await sleep(20);
      return 'answer';
    });
    await console.measureWait(() => sleep(20));

    expect(result).toBe('answer');
    expect(console.userWaitMs()).toBeGreaterThanOrEqual(35);
  });

  it('still counts a wait that fails', async () => {
    const console = new TerminalConsole();

    const error = await console
      .measureWait(async () => {
        await sleep(20);
        throw new Error('cancelled');
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(console.userWaitMs()).toBeGreaterThanOrEqual(15);
  });

  it('counts nothing the unmeasured view waits for, but reports the shared total', async () => {
    const console = new TerminalConsole();
    const view = console.unmeasured();

    await view.measureWait(() => sleep(20));
    await console.measureWait(() => sleep(20));

    expect(console.userWaitMs()).toBeGreaterThanOrEqual(15);
    expect(console.userWaitMs()).toBeLessThan(35);
    expect(view.userWaitMs()).toBe(console.userWaitMs());
  });

  it('keeps the wait of one console apart from another', async () => {
    const first = new TerminalConsole();
    const second = new TerminalConsole();

    await first.measureWait(() => sleep(20));

    expect(second.userWaitMs()).toBe(0);
  });
});

describe('TerminalConsole.unmeasured()', () => {
  it('writes to the same collected output as the console it comes from', () => {
    const console = new TerminalConsole();
    console.setFormattedOutputMode(true);

    console.unmeasured().info('from the view');

    expect(console.getMessagesForFormattedOutput()).toEqual(['  ℹ  from the view']);
  });
});
