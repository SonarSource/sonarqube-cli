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

import { describe, it, expect } from 'bun:test';
import {
  detectCallerAgent,
  isClaudeCodeAgentEnv,
  isCursorAgentEnv,
} from '../../../src/lib/agent-detector.js';

function env(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return overrides as NodeJS.ProcessEnv;
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
  });

  describe('detectCallerAgent', () => {
    it('returns null when no markers', () => {
      expect(detectCallerAgent(env({}))).toBeNull();
    });

    it('prefers claude when both families are set', () => {
      expect(
        detectCallerAgent(env({ CLAUDECODE: '1', CURSOR_TRACE_ID: 't', CLAUDE_PROJECT_DIR: '/x' })),
      ).toBe('claude');
    });
  });
});
