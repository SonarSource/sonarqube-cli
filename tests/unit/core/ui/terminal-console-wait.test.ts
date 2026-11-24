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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { TerminalConsole } from '@/core/ui/terminal-console.ts';

let restoreClock: (() => void) | undefined;

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
});

/** `measureWait` reads `performance.now`, so tests advance this clock instead of sleeping. */
function installClock(): { advance(ms: number): void } {
  let now = 0;
  const spy = spyOn(performance, 'now').mockImplementation(() => now);
  restoreClock = () => {
    spy.mockRestore();
  };
  return {
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe('TerminalConsole user wait', () => {
  it('starts at zero', () => {
    expect(new TerminalConsole().userWaitMs()).toBe(0);
  });

  it('adds up every measured wait and returns its result', async () => {
    const clock = installClock();
    const console = new TerminalConsole();

    const result = await console.measureWait(() => {
      clock.advance(20.4);
      return Promise.resolve('answer');
    });
    await console.measureWait(() => {
      clock.advance(20.4);
      return Promise.resolve();
    });

    expect(result).toBe('answer');
    expect(console.userWaitMs()).toBe(41);
  });

  it('still counts a wait that fails', async () => {
    const clock = installClock();
    const console = new TerminalConsole();

    const error = await console
      .measureWait(() => {
        clock.advance(20.6);
        return Promise.reject(new Error('cancelled'));
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect(console.userWaitMs()).toBe(21);
  });

  it('counts nothing the unmeasured view waits for, but reports the shared total', async () => {
    const clock = installClock();
    const console = new TerminalConsole();
    const view = console.unmeasured();

    await view.measureWait(() => {
      clock.advance(50);
      return Promise.resolve();
    });
    expect(console.userWaitMs()).toBe(0);

    await console.measureWait(() => {
      clock.advance(12.2);
      return Promise.resolve();
    });

    expect(console.userWaitMs()).toBe(12);
    expect(view.userWaitMs()).toBe(12);
  });

  it('keeps the wait of one console apart from another', async () => {
    const clock = installClock();
    const first = new TerminalConsole();
    const second = new TerminalConsole();

    await first.measureWait(() => {
      clock.advance(8);
      return Promise.resolve();
    });

    expect(first.userWaitMs()).toBe(8);
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
