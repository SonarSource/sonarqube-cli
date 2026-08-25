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

import { ENV_DO_NOT_TRACK } from '@/core/config-constants.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import {
  createAgentSessionSlot,
  resolveAgentSessionId,
  resolveAgentSessionIdForEmit,
  resolveAgentSessionIdFromEnv,
  resolveAgentSessionIdFromHookOrEnv,
} from '@/core/telemetry/agent-session.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { makeTelemetryState } from '../../../_common/telemetry-helpers.ts';

describe('resolveAgentSessionIdFromEnv', () => {
  it('returns null when no agent-native env source is present', () => {
    expect(resolveAgentSessionIdFromEnv({})).toBeNull();
  });

  it('prefers CLAUDE_CODE_SESSION_ID over Codex/Gemini env', () => {
    expect(
      resolveAgentSessionIdFromEnv({
        CLAUDE_CODE_SESSION_ID: 'claude-id',
        CODEX_SESSION_ID: 'codex-session',
        CODEX_THREAD_ID: 'codex-thread',
        GEMINI_SESSION_ID: 'gemini-id',
      }),
    ).toBe('claude-id');
  });

  it('prefers CODEX_SESSION_ID over CODEX_THREAD_ID and GEMINI', () => {
    expect(
      resolveAgentSessionIdFromEnv({
        CODEX_SESSION_ID: 'codex-session',
        CODEX_THREAD_ID: 'codex-thread',
        GEMINI_SESSION_ID: 'gemini-id',
      }),
    ).toBe('codex-session');
  });

  it('uses CODEX_THREAD_ID when session env is absent', () => {
    expect(
      resolveAgentSessionIdFromEnv({
        CODEX_THREAD_ID: 'codex-thread',
        GEMINI_SESSION_ID: 'gemini-id',
      }),
    ).toBe('codex-thread');
  });

  it('uses GEMINI_SESSION_ID when higher-priority sources are absent', () => {
    expect(resolveAgentSessionIdFromEnv({ GEMINI_SESSION_ID: 'gemini-id' })).toBe('gemini-id');
  });

  it('ignores whitespace-only env values and falls through', () => {
    expect(
      resolveAgentSessionIdFromEnv({
        CLAUDE_CODE_SESSION_ID: '   ',
        CODEX_SESSION_ID: '\t',
        CODEX_THREAD_ID: '  ',
        GEMINI_SESSION_ID: 'gemini-ok',
      }),
    ).toBe('gemini-ok');
  });

  it('trims resolved env values', () => {
    expect(resolveAgentSessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: '  claude-id  ' })).toBe(
      'claude-id',
    );
  });
});

describe('resolveAgentSessionId', () => {
  let tryLoadStateSpy: ReturnType<typeof spyOn>;
  let savedDoNotTrack: string | undefined;

  beforeEach(() => {
    savedDoNotTrack = process.env[ENV_DO_NOT_TRACK];
    delete process.env[ENV_DO_NOT_TRACK];
    tryLoadStateSpy = spyOn(stateManager, 'tryLoadState').mockReturnValue(makeTelemetryState());
  });

  afterEach(() => {
    tryLoadStateSpy.mockRestore();
    restoreEnv(ENV_DO_NOT_TRACK, savedDoNotTrack);
  });

  it('does not identify when telemetry is disabled', () => {
    tryLoadStateSpy.mockReturnValue(makeTelemetryState(false));
    const slot = createAgentSessionSlot();
    expect(resolveAgentSessionId(slot, { CLAUDE_CODE_SESSION_ID: 'env-id' })).toBeNull();
    expect(slot.id).toBeNull();
  });

  it('returns a hook-captured id already on the slot', () => {
    const slot = createAgentSessionSlot();
    slot.id = 'hook-id';
    expect(resolveAgentSessionId(slot, { CLAUDE_CODE_SESSION_ID: 'env-id' })).toBe('hook-id');
  });

  it('normalizes a whitespace-padded hook id on the slot', () => {
    const slot = createAgentSessionSlot();
    slot.id = '  hook-id  ';
    expect(resolveAgentSessionId(slot, {})).toBe('hook-id');
    expect(slot.id).toBe('hook-id');
  });

  it('falls through to env when the slot holds only whitespace', () => {
    const slot = createAgentSessionSlot();
    slot.id = '   ';
    expect(resolveAgentSessionId(slot, { CODEX_SESSION_ID: 'codex-id' })).toBe('codex-id');
    expect(slot.id).toBe('codex-id');
  });

  it('lazily resolves from env when the slot is empty', () => {
    const slot = createAgentSessionSlot();
    expect(resolveAgentSessionId(slot, { CODEX_SESSION_ID: 'codex-id' })).toBe('codex-id');
    expect(slot.id).toBe('codex-id');
  });
});

describe('resolveAgentSessionIdForEmit', () => {
  let tryLoadStateSpy: ReturnType<typeof spyOn>;
  let savedDoNotTrack: string | undefined;

  beforeEach(() => {
    savedDoNotTrack = process.env[ENV_DO_NOT_TRACK];
    delete process.env[ENV_DO_NOT_TRACK];
    tryLoadStateSpy = spyOn(stateManager, 'tryLoadState').mockReturnValue(makeTelemetryState());
  });

  afterEach(() => {
    tryLoadStateSpy.mockRestore();
    restoreEnv(ENV_DO_NOT_TRACK, savedDoNotTrack);
  });

  it('prefers the hook id over env', () => {
    expect(resolveAgentSessionIdForEmit('hook-id', { CLAUDE_CODE_SESSION_ID: 'env-id' })).toBe(
      'hook-id',
    );
  });

  it('normalizes a whitespace-padded hook id', () => {
    expect(resolveAgentSessionIdForEmit('  hook-id  ', {})).toBe('hook-id');
  });

  it('falls back to env when the hook id is null or blank', () => {
    expect(resolveAgentSessionIdForEmit(null, { CODEX_SESSION_ID: 'codex-id' })).toBe('codex-id');
    expect(resolveAgentSessionIdForEmit('   ', { CODEX_SESSION_ID: 'codex-id' })).toBe('codex-id');
  });

  it('returns null when telemetry is disabled', () => {
    tryLoadStateSpy.mockReturnValue(makeTelemetryState(false));
    expect(
      resolveAgentSessionIdForEmit('hook-id', { CLAUDE_CODE_SESSION_ID: 'env-id' }),
    ).toBeNull();
  });
});

describe('resolveAgentSessionIdFromHookOrEnv', () => {
  it('prefers the hook id over env without consulting telemetry state', () => {
    expect(
      resolveAgentSessionIdFromHookOrEnv('hook-id', { CLAUDE_CODE_SESSION_ID: 'env-id' }),
    ).toBe('hook-id');
  });

  it('falls back to env when the hook id is null', () => {
    expect(resolveAgentSessionIdFromHookOrEnv(null, { CODEX_SESSION_ID: 'codex-id' })).toBe(
      'codex-id',
    );
  });
});
