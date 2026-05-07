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
  detectCallerAgent,
  isClaudeCodeAgentEnv,
  isCopilotCliAgentEnv,
  isCursorAgentEnv,
} from '../../../src/lib/agent-detector.js';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides;
}

/** Temporarily set a process.env var for a callback, restoring the original value after. */
function withProcessEnv<T>(key: string, value: string, fn: () => T): T {
  const original = process.env[key];
  process.env[key] = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
}

describe('agent-detector', () => {
  describe('isCursorAgentEnv', () => {
    it('is true when CURSOR_AGENT=1', () => {
      expect(isCursorAgentEnv(env({ CURSOR_AGENT: '1' }))).toBe(true);
    });

    it('is false when CURSOR_AGENT is not 1', () => {
      expect(isCursorAgentEnv(env({ CURSOR_AGENT: '0' }))).toBe(false);
      expect(isCursorAgentEnv(env({}))).toBe(false);
    });

    it('is true when CURSOR_PROJECT_DIR is non-empty', () => {
      expect(isCursorAgentEnv(env({ CURSOR_PROJECT_DIR: '/p' }))).toBe(true);
    });

    it('is true when CURSOR_TRACE_ID is non-empty', () => {
      expect(isCursorAgentEnv(env({ CURSOR_TRACE_ID: 'abc' }))).toBe(true);
    });

    it('is false when cursor vars are empty strings', () => {
      expect(
        isCursorAgentEnv(env({ CURSOR_PROJECT_DIR: '', CURSOR_TRACE_ID: '', CURSOR_AGENT: '' })),
      ).toBe(false);
    });

    it('reads process.env when no arg is passed', () => {
      withProcessEnv('CURSOR_AGENT', '1', () => {
        expect(isCursorAgentEnv()).toBe(true);
      });
    });
  });

  describe('isClaudeCodeAgentEnv', () => {
    it('is true when CLAUDECODE=1', () => {
      expect(isClaudeCodeAgentEnv(env({ CLAUDECODE: '1' }))).toBe(true);
    });

    it('is false when CLAUDECODE is not 1', () => {
      expect(isClaudeCodeAgentEnv(env({ CLAUDECODE: '0' }))).toBe(false);
    });

    it('is true when CLAUDE_CODE_ENTRYPOINT is non-empty', () => {
      expect(isClaudeCodeAgentEnv(env({ CLAUDE_CODE_ENTRYPOINT: 'cli' }))).toBe(true);
    });

    it('is true when CLAUDE_PROJECT_DIR is non-empty', () => {
      expect(isClaudeCodeAgentEnv(env({ CLAUDE_PROJECT_DIR: '/proj' }))).toBe(true);
    });

    it('reads process.env when no arg is passed', () => {
      withProcessEnv('CLAUDECODE', '1', () => {
        expect(isClaudeCodeAgentEnv()).toBe(true);
      });
    });
  });

  describe('isCopilotCliAgentEnv', () => {
    it('is true when COPILOT_CLI=1', () => {
      expect(isCopilotCliAgentEnv(env({ COPILOT_CLI: '1' }))).toBe(true);
    });

    it('is false when COPILOT_CLI is not 1', () => {
      expect(isCopilotCliAgentEnv(env({ COPILOT_CLI: '0' }))).toBe(false);
      expect(isCopilotCliAgentEnv(env({}))).toBe(false);
    });

    it('is true when COPILOT_PROJECT_DIR is non-empty', () => {
      expect(isCopilotCliAgentEnv(env({ COPILOT_PROJECT_DIR: '/p' }))).toBe(true);
    });

    it('is false when copilot vars are empty strings', () => {
      expect(isCopilotCliAgentEnv(env({ COPILOT_CLI: '', COPILOT_PROJECT_DIR: '' }))).toBe(false);
    });

    it('reads process.env when no arg is passed', () => {
      withProcessEnv('COPILOT_CLI', '1', () => {
        expect(isCopilotCliAgentEnv()).toBe(true);
      });
    });
  });

  describe('detectCallerAgent', () => {
    it('returns null when no markers', () => {
      expect(detectCallerAgent(env({}))).toBeNull();
    });

    it('prefers claude over cursor when both families are set', () => {
      expect(
        detectCallerAgent(env({ CLAUDECODE: '1', CURSOR_TRACE_ID: 't', CLAUDE_PROJECT_DIR: '/x' })),
      ).toBe('claude');
    });

    it('prefers copilot over claude and cursor when all are set', () => {
      expect(
        detectCallerAgent(
          env({
            COPILOT_CLI: '1',
            CLAUDECODE: '1',
            CLAUDE_PROJECT_DIR: '/x',
            CURSOR_TRACE_ID: 't',
          }),
        ),
      ).toBe('copilot');
    });
  });
});
