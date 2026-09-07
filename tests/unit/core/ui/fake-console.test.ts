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

import { FakeConsole } from '../../../_common/fake-console.ts';

describe('FakeConsole', () => {
  it('records message calls without writing', () => {
    const fake = new FakeConsole();
    fake.info('hello');
    fake.warn('caution');
    expect(fake.findCall('info', 'hello')).toBeDefined();
    expect(fake.findCall('warn', 'caution')).toBeDefined();
  });

  it('returns queued prompt responses in order', async () => {
    const fake = new FakeConsole();
    fake.queueResponse('first');
    fake.queueResponse('second');
    expect(await fake.textPrompt('a')).toBe('first');
    expect(await fake.textPrompt('b')).toBe('second');
    expect(fake.calls.filter((c) => c.method === 'textPrompt')).toHaveLength(2);
  });
});
