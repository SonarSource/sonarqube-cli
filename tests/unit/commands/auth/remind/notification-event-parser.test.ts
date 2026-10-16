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

import { createNotificationEventParser } from '@/commands/auth/remind/linux.ts';

const SIGNAL_HEADER =
  'signal time=1759999999.123456 sender=:1.42 -> destination=(null destination) serial=57 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=';

function feed(lines: string[]) {
  const parse = createNotificationEventParser();
  return lines.map((line) => parse(line)).filter((event) => event !== null);
}

describe('createNotificationEventParser', () => {
  it('reports the notification id of an invoked action', () => {
    const events = feed([`${SIGNAL_HEADER}ActionInvoked`, '   uint32 42', '   string "default"']);

    expect(events).toEqual([{ kind: 'ActionInvoked', id: 42 }]);
  });

  it('reports the notification id of a closed notification, ignoring the close reason', () => {
    const events = feed([`${SIGNAL_HEADER}NotificationClosed`, '   uint32 42', '   uint32 2']);

    expect(events).toEqual([{ kind: 'NotificationClosed', id: 42 }]);
  });

  it('ignores ids that follow other signals', () => {
    const events = feed([
      `${SIGNAL_HEADER}NotificationClosed`,
      '   uint32 7',
      '   uint32 1',
      'method call time=1759999999.5 sender=:1.50 -> destination=:1.2 serial=3 path=/org/freedesktop/Notifications; interface=org.freedesktop.Notifications; member=Notify',
      '   uint32 99',
    ]);

    expect(events).toEqual([{ kind: 'NotificationClosed', id: 7 }]);
  });

  it('reports consecutive events for different notifications', () => {
    const events = feed([
      `${SIGNAL_HEADER}ActionInvoked`,
      '   uint32 5',
      `${SIGNAL_HEADER}NotificationClosed`,
      '   uint32 5',
    ]);

    expect(events).toEqual([
      { kind: 'ActionInvoked', id: 5 },
      { kind: 'NotificationClosed', id: 5 },
    ]);
  });
});
