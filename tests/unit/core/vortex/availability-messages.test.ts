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

import {
  VORTEX_OVER_CONSUMPTION_MESSAGE,
  vortexUnavailableCommandMessage,
  vortexUnavailableHookMessage,
} from '@/core/vortex/availability-messages.ts';

describe('vortexUnavailableHookMessage / vortexUnavailableCommandMessage', () => {
  it('returns the shared usage-limit copy for over_consumption in both contexts', () => {
    expect(vortexUnavailableHookMessage('over_consumption')).toBe(VORTEX_OVER_CONSUMPTION_MESSAGE);
    expect(vortexUnavailableCommandMessage('over_consumption')).toBe(
      VORTEX_OVER_CONSUMPTION_MESSAGE,
    );
  });

  it('never suggests re-running sonar integrate for over_consumption', () => {
    expect(VORTEX_OVER_CONSUMPTION_MESSAGE).not.toContain('sonar integrate');
  });

  it('returns the hook variant for not_entitled in a hook (mentions removing hooks)', () => {
    const message = vortexUnavailableHookMessage('not_entitled');
    expect(message).toContain('sonar integrate');
    expect(message).toContain('remove the analysis hooks');
  });

  it('returns the command variant for not_entitled in a command (no integrate hint)', () => {
    const message = vortexUnavailableCommandMessage('not_entitled');
    expect(message).toContain('not available on this connection');
    expect(message).not.toContain('sonar integrate');
  });

  it('returns undefined for ambiguous statuses in a hook so callers skip silently', () => {
    expect(vortexUnavailableHookMessage('enabled')).toBeUndefined();
    expect(vortexUnavailableHookMessage('check_failed')).toBeUndefined();
  });

  it('returns a fallback message for ambiguous statuses in a command', () => {
    expect(vortexUnavailableCommandMessage('enabled')).toBe(
      'Vortex analysis is temporarily unavailable. Please try again later.',
    );
    expect(vortexUnavailableCommandMessage('check_failed')).toBe(
      'Vortex analysis is temporarily unavailable. Please try again later.',
    );
  });
});
