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

import { isWithinCooldown, ONE_DAY_MS } from '@/core/time/cooldown.ts';

describe('isWithinCooldown', () => {
  it('is not in cooldown when the timestamp is missing', () => {
    expect(isWithinCooldown(undefined, ONE_DAY_MS)).toBe(false);
  });

  it('is not in cooldown when the timestamp is unparseable', () => {
    expect(isWithinCooldown('not-a-date', ONE_DAY_MS)).toBe(false);
  });

  it('is in cooldown for a recent past timestamp', () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    expect(isWithinCooldown(oneHourAgo, ONE_DAY_MS)).toBe(true);
  });

  it('is not in cooldown once the window has fully elapsed', () => {
    const wellPast = new Date(Date.now() - 2 * ONE_DAY_MS).toISOString();
    expect(isWithinCooldown(wellPast, ONE_DAY_MS)).toBe(false);
  });

  it('is not in cooldown for a future timestamp (clock skew is not a cooldown)', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    expect(isWithinCooldown(future, ONE_DAY_MS)).toBe(false);
  });

  it('treats the exact window boundary as expired (elapsed === cooldown)', () => {
    const exactlyOneDayAgo = new Date(Date.now() - ONE_DAY_MS).toISOString();
    // elapsed >= cooldownMs → false; the tiny scheduling delay only widens the gap.
    expect(isWithinCooldown(exactlyOneDayAgo, ONE_DAY_MS)).toBe(false);
  });
});
