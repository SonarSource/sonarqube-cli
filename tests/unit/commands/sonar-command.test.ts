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

import { getCustomRootHelp } from '@/commands/root-help.ts';
import { ALPHA_ENV_VAR, SonarCommand } from '@/commands/sonar-command.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { RateLimitError, ServiceUnavailableError } from '@/core/server/errors.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

const FAKE_AUTH: ResolvedAuth = {
  token: 'fake-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

describe('SonarCommand', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let originalAlphaEnv: string | undefined;
  let originalExitCode: number | string | null | undefined;

  beforeEach(() => {
    setMockUi(true);
    originalAlphaEnv = process.env[ALPHA_ENV_VAR];
    delete process.env[ALPHA_ENV_VAR];
    originalExitCode = process.exitCode;
    process.exitCode = 0;
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    process.exitCode = originalExitCode ?? 0;
    resolveAuthSpy?.mockRestore();
    if (originalAlphaEnv === undefined) {
      delete process.env[ALPHA_ENV_VAR];
    } else {
      process.env[ALPHA_ENV_VAR] = originalAlphaEnv;
    }
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

  // ─── addCommand() ────────────────────────────────────────────────────────

  describe('addCommand()', () => {
    it('throws to enforce use of .command() instead', () => {
      const cmd = new SonarCommand();
      const sub = new SonarCommand('sub');
      expect(() => cmd.addCommand(sub)).toThrow(
        'addCommand() is disallowed; use .command() instead',
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
      expect(hintCall?.args[0]).toBe("  → Run 'sonar auth login' to reauthenticate.");
    });

    it('derives remediation hint from RateLimitError cause when no explicit hint is given', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new CommandFailedError('API call failed', { cause: new RateLimitError() });
      });

      const hintCall = getMockUiCalls().find((c) => c.method === 'print');
      expect(hintCall?.args[0]).toBe('  → Wait a moment and try again.');
    });

    it('derives remediation hint from ServiceUnavailableError cause when no explicit hint is given', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new CommandFailedError('API call failed', {
          cause: new ServiceUnavailableError(),
        });
      });

      const hintCall = getMockUiCalls().find((c) => c.method === 'print');
      expect(hintCall?.args[0]).toBe('  → Check your network connection and try again later.');
    });

    it('cause-derived hint takes precedence over generic remediationHint', async () => {
      const cmd = new SonarCommand();
      await cmd.runCommand(() => {
        throw new CommandFailedError('API call failed', {
          cause: new RateLimitError(),
          remediationHint: 'Custom hint.',
        });
      });

      const hintCall = getMockUiCalls().find((c) => c.method === 'print');
      expect(hintCall?.args[0]).toBe('  → Wait a moment and try again.');
    });
  });

  // ─── alpha() ──────────────────────────────────────────────────────────────

  describe('alpha()', () => {
    it('marks the command as alpha', () => {
      const cmd = new SonarCommand('experimental');

      expect(cmd.isAlpha).toBe(false);
      expect(cmd.alpha().isAlpha).toBe(true);
    });

    it('unregisters the command when SONARQUBE_CLI_ALPHA is not set', () => {
      const root = new SonarCommand('sonar');
      root.command('experimental').description('Experimental command').alpha();

      expect(root.commands.map((command) => command.name())).not.toContain('experimental');
      expect(root.helpInformation()).not.toContain('Experimental command');
    });

    it.each(['false', '0', '', 'yes', 'TRUE'])(
      'unregisters the command when SONARQUBE_CLI_ALPHA is set to %s',
      (value) => {
        process.env[ALPHA_ENV_VAR] = value;
        const root = new SonarCommand('sonar');
        root.command('experimental').description('Experimental command').alpha();

        expect(root.commands.map((command) => command.name())).not.toContain('experimental');
        expect(root.helpInformation()).not.toContain('Experimental command');
      },
    );

    it('does not execute an unregistered alpha command', async () => {
      const rootHandler = mock((_command?: string) => {});
      const alphaHandler = mock(() => {});
      const root = new SonarCommand('sonar').argument('[command]').anonymousAction(rootHandler);
      root.command('experimental').alpha().anonymousAction(alphaHandler);

      await root.parseAsync(['experimental'], { from: 'user' });

      expect(rootHandler.mock.calls[0]?.[0]).toBe('experimental');
      expect(alphaHandler).not.toHaveBeenCalled();
    });

    it.each(['true', '1'])(
      'registers the command and tags help when SONARQUBE_CLI_ALPHA is set to %s',
      (value) => {
        process.env[ALPHA_ENV_VAR] = value;
        const root = new SonarCommand('sonar');
        const alphaCommand = root
          .command('experimental')
          .description('Experimental command')
          .alpha();

        expect(root.commands.map((command) => command.name())).toContain('experimental');
        expect(root.helpInformation()).toContain('Experimental command [ALPHA]');
        expect(alphaCommand.helpInformation()).toContain('Experimental command [ALPHA]');
      },
    );

    it('tags an explicit command summary', () => {
      process.env[ALPHA_ENV_VAR] = '1';
      const root = new SonarCommand('sonar');
      root
        .command('experimental')
        .description('Long experimental description')
        .summary('Experimental summary')
        .alpha();

      expect(root.helpInformation()).toContain('Experimental summary [ALPHA]');
    });

    it('groups alpha commands together after all stable root-help categories', () => {
      process.env[ALPHA_ENV_VAR] = '1';
      const root = new SonarCommand('sonar');
      root.command('stable-core').description('Stable core command').rootHelp({ category: 'core' });
      root
        .command('alpha-core')
        .description('Alpha core command')
        .rootHelp({ category: 'core' })
        .alpha();
      root
        .command('stable-management')
        .description('Stable management command')
        .rootHelp({ category: 'cli-management' });
      root
        .command('alpha-data')
        .description('Alpha data command')
        .rootHelp({ category: 'data' })
        .alpha();

      const help = getCustomRootHelp(root, root.createHelp());
      const stableCoreIndex = help.indexOf('Stable core command');
      const stableManagementIndex = help.indexOf('Stable management command');
      const alphaCoreIndex = help.indexOf('Alpha core command [ALPHA]');
      const alphaDataIndex = help.indexOf('Alpha data command [ALPHA]');

      expect(stableCoreIndex).toBeGreaterThan(-1);
      expect(stableManagementIndex).toBeGreaterThan(stableCoreIndex);
      expect(alphaCoreIndex).toBeGreaterThan(stableManagementIndex);
      expect(alphaDataIndex).toBeGreaterThan(alphaCoreIndex);
      expect(help.slice(stableManagementIndex, alphaCoreIndex)).toContain('\n\n');
    });

    it('tags alpha subcommands in an expanded root-help label', () => {
      process.env[ALPHA_ENV_VAR] = '1';
      const root = new SonarCommand('sonar');
      const system = root
        .command('system')
        .description('System commands')
        .rootHelp({ category: 'cli-management' });
      system.command('status').description('Stable status command');
      system.command('reset').description('Stable reset command');
      system.command('alpha-example').description('Nested alpha command').alpha();

      const help = getCustomRootHelp(root, root.createHelp());

      expect(help).toContain('system <status|reset|alpha-example[ALPHA]>');
    });

    it('warns on stderr before invoking the command handler', async () => {
      process.env[ALPHA_ENV_VAR] = '1';
      const handler = mock(() => {});
      const root = new SonarCommand('sonar');
      root.command('experimental').alpha().anonymousAction(handler);

      await root.parseAsync(['experimental'], { from: 'user' });

      expect(handler).toHaveBeenCalledTimes(1);
      const warning = getMockUiCalls().find((call) => call.method === 'warn');
      expect(warning?.args[0]).toBe(
        "'experimental' is in alpha; may change or be removed without notice.",
      );
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

  // ─── rejectUnknownSubcommands() ───────────────────────────────────────────

  describe('rejectUnknownSubcommands()', () => {
    let parent: SonarCommand;
    let parentAction: ReturnType<typeof mock>;
    let subAction: ReturnType<typeof mock>;

    beforeEach(() => {
      parentAction = mock(() => {});
      subAction = mock(() => {});
      parent = new SonarCommand('parent');
      parent.exitOverride().configureOutput({ writeErr: () => {} });
      parent.rejectUnknownSubcommands().anonymousAction(parentAction);
      parent.command('build').anonymousAction(subAction);
    });

    it('reports an unknown subcommand with a "Did you mean?" suggestion', async () => {
      let caught: { code?: string; message?: string } | undefined;
      try {
        await parent.parseAsync(['buil'], { from: 'user' });
      } catch (err) {
        caught = err as { code?: string; message?: string };
      }
      expect(caught?.code).toBe('commander.unknownCommand');
      expect(caught?.message).toContain("unknown command 'buil'");
      expect(caught?.message).toContain('(Did you mean build?)');
    });

    it('still runs the parent action when no excess args are given', async () => {
      await parent.parseAsync([], { from: 'user' });
      expect(parentAction).toHaveBeenCalledTimes(1);
    });

    it('still dispatches to a known subcommand', async () => {
      await parent.parseAsync(['build'], { from: 'user' });
      expect(subAction).toHaveBeenCalledTimes(1);
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
      expect(hintCall?.args[0]).toBe("  → Run 'sonar auth login' to authenticate.");
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
