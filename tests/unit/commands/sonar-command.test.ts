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

import { CliAuthenticatedContext, CliContext } from '@/commands/cli-context.ts';
import { getCustomRootHelp } from '@/commands/root-help.ts';
import { ALPHA_ENV_VAR, SonarCommand, Stage } from '@/commands/sonar-command.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import * as authResolver from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/command-error.ts';
import { RateLimitError, ServiceUnavailableError } from '@/core/server/errors.ts';
import { getDefaultState } from '@/core/state/state.ts';
import * as stateManager from '@/core/state/state-manager.ts';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '@/core/ui';

import { version as VERSION } from '../../../package.json';

const FAKE_AUTH: ResolvedAuth = {
  token: 'fake-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
};

describe('SonarCommand', () => {
  let resolveAuthSpy: ReturnType<typeof spyOn>;
  let originalAlphaEnv: string | undefined;
  let loadStateSpy: ReturnType<typeof spyOn>;
  let saveStateSpy: ReturnType<typeof spyOn>;
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
    loadStateSpy?.mockRestore();
    saveStateSpy?.mockRestore();
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

  // ─── stage(Stage.Stable) ──────────────────────────────────────────────────

  describe('stage(Stage.Stable)', () => {
    it('uses Stable as the default stage', () => {
      const command = new SonarCommand('stable');

      expect(command.isStable).toBe(true);
      expect(command.isAlpha).toBe(false);
      expect(command.isBeta).toBe(false);
    });

    it('allows Stable to be declared explicitly', () => {
      const command = new SonarCommand('stable').description('Stable command').stage(Stage.Stable);

      expect(command.isStable).toBe(true);
      expect(command.helpInformation()).not.toContain('[ALPHA]');
      expect(command.helpInformation()).not.toContain('[BETA]');
    });

    it('uses the last stage assigned after Stable was declared explicitly', () => {
      const command = new SonarCommand('stable').stage(Stage.Stable).stage(Stage.Beta());

      expect(command.isStable).toBe(false);
      expect(command.isBeta).toBe(true);
    });
  });

  // ─── stage(Stage.Alpha) ───────────────────────────────────────────────────

  describe('stage(Stage.Alpha)', () => {
    it('marks the command as alpha', () => {
      const cmd = new SonarCommand('experimental');

      expect(cmd.isAlpha).toBe(false);
      expect(cmd.stage(Stage.Alpha).isAlpha).toBe(true);
    });

    it('uses Alpha when it is assigned after Beta', () => {
      const command = new SonarCommand('experimental').stage(Stage.Beta()).stage(Stage.Alpha);

      expect(command.isAlpha).toBe(true);
      expect(command.isBeta).toBe(false);
    });

    it('unregisters the command when SONARQUBE_CLI_ALPHA is not set', () => {
      const root = new SonarCommand('sonar');
      root.command('experimental').description('Experimental command').stage(Stage.Alpha);

      expect(root.commands.map((command) => command.name())).not.toContain('experimental');
      expect(root.helpInformation()).not.toContain('Experimental command');
    });

    it.each(['false', '0', '', 'yes', 'TRUE'])(
      'unregisters the command when SONARQUBE_CLI_ALPHA is set to %s',
      (value) => {
        process.env[ALPHA_ENV_VAR] = value;
        const root = new SonarCommand('sonar');
        root.command('experimental').description('Experimental command').stage(Stage.Alpha);

        expect(root.commands.map((command) => command.name())).not.toContain('experimental');
        expect(root.helpInformation()).not.toContain('Experimental command');
      },
    );

    it('does not execute an unregistered alpha command', async () => {
      const rootHandler = mock((_ctx: CliContext, _command?: string) => {});
      const alphaHandler = mock((_ctx: CliContext) => {});
      const root = new SonarCommand('sonar').argument('[command]').anonymousAction(rootHandler);
      root.command('experimental').stage(Stage.Alpha).anonymousAction(alphaHandler);

      await root.parseAsync(['experimental'], { from: 'user' });

      expect(rootHandler.mock.calls[0]?.[1]).toBe('experimental');
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
          .stage(Stage.Alpha);

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
        .stage(Stage.Alpha);

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
        .stage(Stage.Alpha);
      root
        .command('stable-management')
        .description('Stable management command')
        .rootHelp({ category: 'cli-management' });
      root
        .command('alpha-data')
        .description('Alpha data command')
        .rootHelp({ category: 'data' })
        .stage(Stage.Alpha);

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
      system.command('alpha-example').description('Nested alpha command').stage(Stage.Alpha);
      system.command('reset').description('Stable reset command');

      const help = getCustomRootHelp(root, root.createHelp());

      expect(help).toContain('system <status|reset|alpha-example[ALPHA]>');
    });

    it('lists alpha subcommands in a separate group at the bottom of their parent help', () => {
      process.env[ALPHA_ENV_VAR] = '1';
      const parent = new SonarCommand('parent');
      parent.command('alpha-one').description('First alpha command').stage(Stage.Alpha);
      parent.command('stable-one').description('First stable command');
      parent.command('alpha-two').description('Second alpha command').stage(Stage.Alpha);
      parent.command('stable-two').description('Second stable command');

      expect(parent.helpInformation()).toBe(
        [
          'Usage: parent [options] [command]',
          '',
          'Options:',
          '  -h, --help      display help for command',
          '',
          'Commands:',
          '  stable-one      First stable command',
          '  stable-two      Second stable command',
          '  help [command]  display help for command',
          '',
          '  alpha-one       First alpha command [ALPHA]',
          '  alpha-two       Second alpha command [ALPHA]',
          '',
        ].join('\n'),
      );
    });

    it('warns on stderr before invoking the command handler', async () => {
      process.env[ALPHA_ENV_VAR] = '1';
      const handler = mock(() => {});
      const root = new SonarCommand('sonar');
      root.command('experimental').stage(Stage.Alpha).anonymousAction(handler);

      await root.parseAsync(['experimental'], { from: 'user' });

      expect(handler).toHaveBeenCalledTimes(1);
      const warning = getMockUiCalls().find((call) => call.method === 'info');
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
      cmd.anonymousAction((_ctx) => {});
      expect(cmd.requiresAuth).toBe(false);
    });

    it('is true after authenticatedAction()', () => {
      const cmd = new SonarCommand();
      cmd.authenticatedAction(() => Promise.resolve());
      expect(cmd.requiresAuth).toBe(true);
    });
  });

  // ─── stage(Stage.Beta()) ────────────────────────────────────────────────────

  describe('stage(Stage.Beta())', () => {
    it('marks the command as Beta and keeps it visible', () => {
      const parent = new SonarCommand('sonar');
      const betaCommand = parent
        .command('preview')
        .description('Run the preview')
        .stage(Stage.Beta());

      expect(betaCommand.isBeta).toBe(true);
      expect(parent.createHelp().visibleCommands(parent)).toContain(betaCommand);
    });

    it('uses Beta when it is assigned after a disabled Alpha stage', () => {
      const parent = new SonarCommand('sonar');
      const command = parent.command('preview').description('Preview command');
      command.stage(Stage.Alpha);

      expect(parent.commands).not.toContain(command);

      command.stage(Stage.Beta());

      expect(command.isAlpha).toBe(false);
      expect(command.isBeta).toBe(true);
      expect(parent.commands).toContain(command);
      expect(parent.helpInformation()).toContain('Preview command [BETA]');
      expect(parent.helpInformation()).not.toContain('[ALPHA]');
    });

    it('leaves commands Stable by default', () => {
      expect(new SonarCommand('stable').isStable).toBe(true);
    });

    it('adds the Beta tag to command help', () => {
      const command = new SonarCommand('preview')
        .description('Run the preview')
        .stage(Stage.Beta());

      expect(command.helpInformation()).toContain('Run the preview [BETA]');
    });

    it('adds the Beta tag to a parent command subcommand list', () => {
      const parent = new SonarCommand('sonar');
      parent.command('preview').description('Run the preview').stage(Stage.Beta());

      expect(parent.helpInformation()).toContain('Run the preview [BETA]');
    });

    it('adds the Beta tag to an explicit command summary', () => {
      const parent = new SonarCommand('sonar');
      parent
        .command('preview')
        .description('Long preview description')
        .summary('Preview summary')
        .stage(Stage.Beta());

      expect(parent.helpInformation()).toContain('Preview summary [BETA]');
    });

    it('tags Beta subcommands in a root-help label', () => {
      const root = new SonarCommand('sonar');
      const system = root
        .command('system')
        .description('System commands')
        .rootHelp({ category: 'cli-management' });
      system.command('status').description('Stable status command');
      system.command('preview').description('Preview command').stage(Stage.Beta());

      const help = getCustomRootHelp(root, root.createHelp());

      expect(help).toContain('system <status|preview[BETA]>');
    });

    it('keeps Beta commands in category declaration order', () => {
      const root = new SonarCommand('sonar');
      root.command('first').description('First command').rootHelp({ category: 'data' });
      root
        .command('preview')
        .description('Preview command')
        .rootHelp({ category: 'data' })
        .stage(Stage.Beta());
      root.command('last').description('Last command').rootHelp({ category: 'data' });

      const help = getCustomRootHelp(root, root.createHelp());

      expect(help.indexOf('First command')).toBeLessThan(help.indexOf('Preview command [BETA]'));
      expect(help.indexOf('Preview command [BETA]')).toBeLessThan(help.indexOf('Last command'));
    });

    it('warns once for the command in the current CLI version', async () => {
      const state = getDefaultState(VERSION);
      loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
      saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
      const command = new SonarCommand('preview').stage(Stage.Beta()).anonymousAction((_ctx) => {});

      await command.parseAsync([], { from: 'user' });
      await command.parseAsync([], { from: 'user' });

      const warnings = getMockUiCalls().filter((call) => call.method === 'info');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.args[0]).toBe("'preview' is in beta and may change.");
      expect(state.config.betaCommandWarnings).toEqual({ preview: VERSION });
      expect(saveStateSpy).toHaveBeenCalledTimes(1);
    });

    it('warns independently for each Beta command', async () => {
      const state = getDefaultState(VERSION);
      loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
      saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
      const first = new SonarCommand('first').stage(Stage.Beta()).anonymousAction((_ctx) => {});
      const second = new SonarCommand('second').stage(Stage.Beta()).anonymousAction((_ctx) => {});

      await first.parseAsync([], { from: 'user' });
      await second.parseAsync([], { from: 'user' });

      expect(
        getMockUiCalls()
          .filter((call) => call.method === 'info')
          .map((call) => call.args[0]),
      ).toEqual(["'first' is in beta and may change.", "'second' is in beta and may change."]);
    });

    it('warns again after the CLI version changes', async () => {
      const state = getDefaultState(VERSION);
      state.config.betaCommandWarnings = { preview: '0.0.1' };
      loadStateSpy = spyOn(stateManager, 'loadState').mockReturnValue(state);
      saveStateSpy = spyOn(stateManager, 'saveState').mockImplementation(() => {});
      const command = new SonarCommand('preview').stage(Stage.Beta()).anonymousAction((_ctx) => {});

      await command.parseAsync([], { from: 'user' });

      expect(getMockUiCalls().filter((call) => call.method === 'info')).toHaveLength(1);
      expect(state.config.betaCommandWarnings).toEqual({ preview: VERSION });
    });

    it('warns once per process when state cannot be loaded', async () => {
      loadStateSpy = spyOn(stateManager, 'loadState').mockImplementation(() => {
        throw new Error('State is unreadable');
      });
      const command = new SonarCommand('preview-with-unreadable-state')
        .stage(Stage.Beta())
        .anonymousAction((_ctx) => {});

      await command.parseAsync([], { from: 'user' });
      await command.parseAsync([], { from: 'user' });

      const warnings = getMockUiCalls().filter((call) => call.method === 'info');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.args[0]).toBe(
        "'preview-with-unreadable-state' is in beta and may change.",
      );
    });

    it('stores an optional LaunchDarkly flag key for Private Beta', () => {
      const open = new SonarCommand('open').stage(Stage.Beta());
      const gated = new SonarCommand('gated', {
        runtime: {
          auth: null,
          isAlphaEnabled: false,
          isPrivateBetaEnabled: () => true,
        },
      }).stage(Stage.Beta('cli.beta.preview'));

      expect(open.isBeta).toBe(true);
      expect(open.isPrivateBeta).toBe(false);
      expect(open.betaFlagKey).toBeUndefined();

      expect(gated.isBeta).toBe(true);
      expect(gated.isPrivateBeta).toBe(true);
      expect(gated.betaFlagKey).toBe('cli.beta.preview');
    });

    it('registers Private Beta only when the runtime gate allows it', () => {
      const enabled = new SonarCommand('root', {
        runtime: {
          auth: null,
          isAlphaEnabled: false,
          isPrivateBetaEnabled: (key) => key === 'cli.beta.preview',
        },
      });
      enabled.command('gated').stage(Stage.Beta('cli.beta.preview'));
      expect(enabled.commands.map((c) => c.name())).toContain('gated');

      const denied = new SonarCommand('root', {
        runtime: {
          auth: null,
          isAlphaEnabled: false,
          isPrivateBetaEnabled: () => false,
        },
      });
      denied.command('gated').stage(Stage.Beta('cli.beta.preview'));
      expect(denied.commands.map((c) => c.name())).not.toContain('gated');
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
    it('calls the handler with CliContext as first argument', async () => {
      const handler = mock((_ctx: CliContext) => {});
      const cmd = new SonarCommand();
      cmd.anonymousAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).toHaveBeenCalledTimes(1);
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext).toBeInstanceOf(CliContext);
      expect(receivedContext.isAlpha()).toBe(false);
      expect(receivedContext.isBeta()).toBe(false);
    });

    it('sets isAlpha() when command has Stage.Alpha and alpha is enabled', async () => {
      process.env[ALPHA_ENV_VAR] = 'true';
      const handler = mock((_ctx: CliContext) => {});
      const cmd = new SonarCommand({
        runtime: { auth: null, isAlphaEnabled: true, isPrivateBetaEnabled: () => false },
      });
      cmd.stage(Stage.Alpha).anonymousAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext.isAlpha()).toBe(true);
      expect(receivedContext.isBeta()).toBe(false);
    });

    it('sets isBeta() for Open Beta', async () => {
      const handler = mock((_ctx: CliContext) => {});
      const cmd = new SonarCommand();
      cmd.stage(Stage.Beta()).anonymousAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext.isAlpha()).toBe(false);
      expect(receivedContext.isOpenBeta()).toBe(true);
      expect(receivedContext.isBeta()).toBe(true);
    });

    it('sets isBeta() for Private Beta when the user is entitled', async () => {
      const handler = mock((_ctx: CliContext) => {});
      const cmd = new SonarCommand({
        runtime: {
          auth: null,
          isAlphaEnabled: false,
          isPrivateBetaEnabled: (key) => key === 'cli.beta.demo',
        },
      });
      cmd.stage(Stage.Beta('cli.beta.demo')).anonymousAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext.isOpenBeta()).toBe(false);
      expect(receivedContext.isPrivateBeta()).toBe(true);
      expect(receivedContext.isBeta()).toBe(true);
    });

    it('catches handler errors and sets process.exitCode to 1', async () => {
      const cmd = new SonarCommand();
      cmd.anonymousAction((_ctx) => {
        throw new Error('handler error');
      });
      await cmd.parseAsync([], { from: 'user' });
      expect(process.exitCode).toBe(1);
    });

    it('catches handler errors and outputs the error message', async () => {
      const cmd = new SonarCommand();
      cmd.anonymousAction((_ctx) => {
        throw new Error('handler error');
      });
      await cmd.parseAsync([], { from: 'user' });
      const errCall = getMockUiCalls().find((c) => c.method === 'error');
      expect(errCall?.args[0]).toBe('handler error');
    });
  });

  // ─── authenticatedAction() ────────────────────────────────────────────────

  describe('authenticatedAction()', () => {
    it('calls handler with CliAuthenticatedContext as first argument', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
      const handler = mock((_ctx: CliAuthenticatedContext) => Promise.resolve());
      const cmd = new SonarCommand();
      cmd.authenticatedAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).toHaveBeenCalledTimes(1);
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext.auth).toBe(FAKE_AUTH);
      expect(receivedContext.isAlpha()).toBe(false);
      expect(receivedContext.isBeta()).toBe(false);
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

    it('sets isAlpha() when command has Stage.Alpha and alpha is enabled', async () => {
      process.env[ALPHA_ENV_VAR] = 'true';
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
      const handler = mock((_ctx: CliAuthenticatedContext) => Promise.resolve());
      const cmd = new SonarCommand({
        runtime: { auth: null, isAlphaEnabled: true, isPrivateBetaEnabled: () => false },
      });
      cmd.stage(Stage.Alpha).authenticatedAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).toHaveBeenCalledTimes(1);
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext.isAlpha()).toBe(true);
      expect(receivedContext.isBeta()).toBe(false);
    });

    it('sets isBeta() for Open Beta', async () => {
      resolveAuthSpy = spyOn(authResolver, 'resolveAuth').mockResolvedValue(FAKE_AUTH);
      const handler = mock((_ctx: CliAuthenticatedContext) => Promise.resolve());
      const cmd = new SonarCommand();
      cmd.stage(Stage.Beta()).authenticatedAction(handler);
      await cmd.parseAsync([], { from: 'user' });
      expect(handler).toHaveBeenCalledTimes(1);
      const receivedContext = handler.mock.calls[0][0];
      expect(receivedContext.isAlpha()).toBe(false);
      expect(receivedContext.isOpenBeta()).toBe(true);
      expect(receivedContext.isBeta()).toBe(true);
    });
  });
});
