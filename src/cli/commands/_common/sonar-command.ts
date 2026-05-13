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

// SonarCommand — Commander Command subclass with built-in error handling and auth support

import { Command } from 'commander';

import type { ResolvedAuth } from '../../../lib/auth-resolver.js';
import { resolveAuth } from '../../../lib/auth-resolver.js';
import logger from '../../../lib/logger.js';
import { blank, error, print } from '../../../ui';
import { CliError, CommandFailedError } from './error.js';

/**
 * Commander Command subclass for the Sonar CLI.
 *
 * Differences from the base Command:
 *  - action()              disabled — throws to enforce use of the two methods below
 *  - anonymousAction()     wraps the handler with runCommand() automatically so
 *                          callers never have to do so themselves
 *  - authenticatedAction() resolves auth before calling the handler; also wraps
 *                          with runCommand(); auth is prepended to the handler args
 *  - requiresAuth          metadata flag, set to true by authenticatedAction();
 *                          useful for documentation generation
 */
export class SonarCommand extends Command {
  private _requiresAuth = false;

  /** Ensures subcommands created via .command() are also SonarCommand instances. */
  createCommand(name?: string): SonarCommand {
    return new SonarCommand(name);
  }

  /**
   * Register an action handler that does not need authentication.
   * Errors are caught and formatted consistently;
   * process.exitCode is set on failure. Wraps Commander's action() so callers
   * do not need to invoke runCommand() themselves.
   *
   * The `this` context set by Commander is forwarded to the handler, so
   * `function(this: Command) { this.outputHelp(); }` works as expected.
   */
  anonymousAction(fn: (...args: any[]) => void | Promise<void>): this {
    super.action(function (this: SonarCommand, ...args: any[]) {
      return this.runCommand(() => Promise.resolve(fn.apply(this, args)));
    });
    return this;
  }

  /**
   * Register an action that requires authentication. Auth is resolved before
   * the handler is invoked; if no auth is configured the command fails with a
   * clear message. Auth is passed as the first argument to fn; Commander's own
   * arguments (options, positional args) follow.
   *
   * Sets requiresAuth = true on this command for documentation purposes.
   */
  authenticatedAction(fn: (auth: ResolvedAuth, ...args: any[]) => Promise<void>): this {
    this._requiresAuth = true;
    super.action((...args: any[]) =>
      this.runCommand(async () => {
        const auth = await resolveAuth();
        if (!auth) {
          throw new CommandFailedError('Not authenticated. Run: sonar auth login');
        }
        await fn(auth, ...args);
      }),
    );
    return this;
  }

  action(_: (...args: any[]) => void | Promise<void>): this {
    throw new Error(
      'action() should not be called direclty, use anonymousAction() or authenticatedAction() instead',
    );
  }

  /** True when this command was registered with authenticatedAction(). */
  get requiresAuth(): boolean {
    return this._requiresAuth;
  }

  async runCommand(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const thrownError = err instanceof Error ? err : new Error(String(err));
      const cliError = err instanceof CliError ? err : undefined;

      blank();
      error(thrownError.message);
      if (cliError?.remediationHint) {
        print(`💡 ${cliError.remediationHint}`, process.stderr);
      }
      logger.error(thrownError.message);
      process.exitCode = cliError?.exitCode ?? 1;
    }
  }
}
