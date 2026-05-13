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

// Unit tests for SonarCommand

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import {
  CommandFailedError,
  InvalidOptionError,
} from '../../../../../src/cli/commands/_common/error';
import { SonarCommand } from '../../../../../src/cli/commands/_common/sonar-command';
import type { ResolvedAuth } from '../../../../../src/lib/auth-resolver';
import * as authResolver from '../../../../../src/lib/auth-resolver';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../../../src/ui';

const FAKE_AUTH: ResolvedAuth = {
  token: 'fake-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

describe('SonarCommand', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let originalExitCode: number | string | undefined;

  beforeEach(() => {
    setMockUi(true);
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    process.exitCode = originalExitCode ?? 0;
    resolveAuthSpy?.mockRestore();
  });

  // ─── action() ────────────────────────────────────────────────────────────

  describe('action()', () => {
    it('throws to enforce use of anonymousAction() or authenticatedAction()', () => {
      const cmd = new SonarCommand();
      expect(() => cmd.action(() => {})).toThrow(
        'action() should not be called direclty, use anonymousAction() or authenticatedAction() instead',
      );
    });
  });

  // ─── runCommand() ─────────────────────────────────────────────────────────

  describe('runCommand()', () => {
    it('executes the given function', async () => {
      const cmd = new SonarCommand();
      let called = false;
      await cmd.runCommand(() => {
        called = true;
        return Promise.resolve();
      });
      expect(called).toBe(true);
    });

    it('sets process.exitCode to 1 on generic error', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new Error('boom');
      });
      expect(process.exitCode).toBe(1);
    });

    it('sets process.exitCode to 2 on InvalidOptionError', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new InvalidOptionError('bad flag');
      });
      expect(process.exitCode).toBe(2);
    });

    it('uses the exit code from CommandFailedError', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new CommandFailedError('fail', { exitCode: 42 });
      });
      expect(process.exitCode).toBe(42);
    });

    it('outputs the error message to the UI', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new Error('something went wrong');
      });
      const errCall = getMockUiCalls().find((c) => c.method === 'error');
      expect(errCall?.args[0]).toBe('something went wrong');
    });

    it('outputs the remediation hint when the CLI error provides one', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new CommandFailedError('Authentication check failed', {
          remediationHint: "Run 'sonar auth login' to reauthenticate.",
        });
      });

      const hintCall = getMockUiCalls().find((c) => c.method === 'print');
      expect(hintCall?.args[0]).toBe("💡 Run 'sonar auth login' to reauthenticate.");
    });
  });

  // ─── requiresAuth ─────────────────────────────────────────────────────────

  describe('requiresAuth', () => {
    it('is false by default', () => {
      expect(new SonarCommand().requiresAuth).toBe(false);
    });

    it('is false after anonymousAction()', () => {
      const cmd = new SonarCommand();
      cmd.anonymousAction(() => {});
      expect(cmd.requiresAuth).toBe(false);
    });

    it('is true after authenticatedAction()', () => {
      const cmd = new SonarCommand();
      cmd.authenticatedAction(() => Promise.resolve());
      expect(cmd.requiresAuth).toBe(true);
    });
  });

  // ─── createCommand() ──────────────────────────────────────────────────────

  describe('createCommand()', () => {
    it('returns a SonarCommand instance', () => {
      expect(new SonarCommand().createCommand('sub')).toBeInstanceOf(SonarCommand);
    });
  });

  // ─── anonymousAction() ────────────────────────────────────────────────────

  describe('anonymousAction()', () => {
    it('calls the handler when the command is invoked', async () => {
      const handler = mock(() => {});
      const cmd = new SonarCommand();
      cmd.anonymousAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('catches handler errors and sets process.exitCode to 1', async () => {
      const cmd = new SonarCommand();
      cmd.anonymousAction(() => {
        throw new Error('handler error');
      });
      await cmd.parseAsync([], { from: 'user' });
      expect(process.exitCode).toBe(1);
    });

    it('catches handler errors and outputs the error message', async () => {
      const cmd = new SonarCommand();
      cmd.anonymousAction(() => {
        throw new Error('handler error');
      });
      await cmd.parseAsync([], { from: 'user' });
      const errCall = getMockUiCalls().find((c) => c.method === 'error');
      expect(errCall?.args[0]).toBe('handler error');
    });
  });

  // ─── authenticatedAction() ────────────────────────────────────────────────

  describe('authenticatedAction()', () => {
    it('calls handler with resolved auth as first argument', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
      const handler = mock((_auth: typeof FAKE_AUTH) => Promise.resolve());
      const cmd = new SonarCommand();
      cmd.authenticatedAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toBe(FAKE_AUTH);
    });

    it('does not call handler when not authenticated', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(null);
      const handler = mock(() => Promise.resolve());
      const cmd = new SonarCommand();
      cmd.authenticatedAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).not.toHaveBeenCalled();
    });

    it('sets process.exitCode to 1 when not authenticated', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(null);
      const cmd = new SonarCommand();
      cmd.authenticatedAction(() => Promise.resolve());
      await cmd.parseAsync([], { from: 'user' });
      expect(process.exitCode).toBe(1);
    });

    it('outputs a descriptive error message when not authenticated', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(null);
      const cmd = new SonarCommand();
      cmd.authenticatedAction(() => Promise.resolve());
      await cmd.parseAsync([], { from: 'user' });
      const errCall = getMockUiCalls().find((c) => c.method === 'error');
      expect(errCall?.args[0]).toContain('Not authenticated');
      const hintCall = getMockUiCalls().find((c) => c.method === 'print');
      expect(hintCall?.args[0]).toBe("💡 Run 'sonar auth login' to authenticate.");
    });

    it('catches handler errors and sets process.exitCode', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
      const cmd = new SonarCommand();
      cmd.authenticatedAction(() => {
        throw new CommandFailedError('handler failed', { exitCode: 5 });
      });
      await cmd.parseAsync([], { from: 'user' });
      expect(process.exitCode).toBe(5);
    });
  });
});
