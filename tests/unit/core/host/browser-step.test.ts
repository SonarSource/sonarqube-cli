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

import { waitInBrowser } from '@/core/host/browser.ts';
import type { Console } from '@/core/ui/console.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

/** Records the order of opening, measuring and waiting, and hands out a distinct unmeasured view. */
class RecordingConsole extends FakeConsole {
  readonly events: string[] = [];
  readonly view = new FakeConsole();

  override measureWait<T>(wait: () => Promise<T>): Promise<T> {
    this.events.push('measure');
    return wait();
  }

  override unmeasured(): Console {
    return this.view;
  }
}

describe('waitInBrowser()', () => {
  it('opens the URL and waits inside one measured step, returning what the wait resolves to', async () => {
    const console = new RecordingConsole();

    const result = await waitInBrowser(
      'https://example.test/authorize',
      console,
      () => {
        console.events.push('wait');
        return Promise.resolve('authorized');
      },
      (url) => {
        console.events.push(`open ${url}`);
        return Promise.resolve();
      },
    );

    expect(result).toBe('authorized');
    expect(console.events).toEqual(['measure', 'open https://example.test/authorize', 'wait']);
  });

  it('gives the wait an unmeasured console, so its prompts are not counted again', async () => {
    const console = new RecordingConsole();

    const received = await waitInBrowser(
      'https://example.test/authorize',
      console,
      (stepConsole) => Promise.resolve(stepConsole),
      () => Promise.resolve(),
    );

    expect(received).toBe(console.view);
  });
});
