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

import type { ResolvedAuth } from '@/core/host/auth-resolver.ts';
import { resolveAuth } from '@/core/host/auth-resolver.ts';
import logger from '@/core/observability/logger.ts';
import { blank, error, print } from '@/core/ui';

import { CliError, CommandFailedError, remediationHintFor } from './error.ts';

export const COMMAND_CATEGORIES = ['core', 'data', 'integrate', 'cli-management'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export interface RootHelpMetadata {
  category?: CommandCategory;
  expandSubcommands?: boolean;
  label?: string;
}

/** When to show the post-command update notice for a opted-in command. */
export type UpdateNotificationCondition = (opts: Record<string, unknown>) => boolean;

type CommandArgs = unknown[];
type CommandResult = void | Promise<void>;

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
  private _rootHelp: RootHelpMetadata = {};
  private _showUpdateNotification?: true | UpdateNotificationCondition;

  /** Ensures subcommands created via .command() are also SonarCommand instances. */
  createCommand(name?: string): SonarCommand {
    return new SonarCommand(name);
  }

  /**
   * Configure how this command appears in the custom root help menu.
   * Top-level commands can control category, labels, and whether
   * visible subcommands are also rendered individually.
   */
  rootHelp(metadata: RootHelpMetadata): this {
    this._rootHelp = { ...this._rootHelp, ...metadata };
    return this;
  }

  /**
   * Opt in to the post-command "new version available" stderr notice.
   * Pass a condition to show the notice only when it returns true for the
   * merged action-command options (parsed by Commander).
   */
  showUpdateNotification(when?: UpdateNotificationCondition): this {
    this._showUpdateNotification = when ?? true;
    return this;
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
  anonymousAction<TArgs extends CommandArgs>(
    this: this & { __commandArgs?: TArgs },
    fn: (...args: TArgs) => CommandResult,
  ): this {
    super.action(function (this: SonarCommand, ...args: TArgs) {
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
  authenticatedAction<TArgs extends CommandArgs>(
    this: this & { __commandArgs?: TArgs },
    fn: (auth: ResolvedAuth, ...args: TArgs) => Promise<void>,
  ): this {
    this._requiresAuth = true;
    super.action((...args: TArgs) =>
      this.runCommand(async () => {
        const auth = await resolveAuth();
        if (!auth) {
          throw new CommandFailedError('Not authenticated.', {
            remediationHint: "Run 'sonar auth login' to authenticate.",
          });
        }
        await fn(auth, ...args);
      }),
    );
    return this;
  }

  action(_: (...args: CommandArgs) => CommandResult): this {
    throw new Error(
      'action() should not be called direclty, use anonymousAction() or authenticatedAction() instead',
    );
  }

  /**
   * For a parent command that has both an action and subcommands, make unknown
   * subcommands report a proper "unknown command 'X'" error (with Commander's
   * "Did you mean?" suggestion) instead of "too many arguments".
   *
   * Commander v15 (allowExcessArguments defaults to false) errors early with
   * "too many arguments" for unknown subcommands. This enables allowExcessArguments
   * so Commander doesn't error early, then a preAction hook re-raises excess args
   * on the parent as unknownCommand().
   */
  rejectUnknownSubcommands(): this {
    this.allowExcessArguments(true).hook('preAction', (thisCommand, actionCommand) => {
      if (actionCommand.name() === thisCommand.name() && thisCommand.args.length > 0) {
        // unknownCommand() is public in Commander 15 but absent from its typings.
        (thisCommand as Command & { unknownCommand(): void }).unknownCommand();
      }
    });
    return this;
  }

  /** True when this command was registered with authenticatedAction(). */
  get requiresAuth(): boolean {
    return this._requiresAuth;
  }

  /** Metadata used by the custom root help menu. */
  get rootHelpMetadata(): RootHelpMetadata {
    return this._rootHelp;
  }

  /** Update-notification opt-in and optional show condition for this command. */
  get showUpdateNotificationWhen(): true | UpdateNotificationCondition | undefined {
    return this._showUpdateNotification;
  }

  async runCommand(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const thrownError = err instanceof Error ? err : new Error(String(err));
      const cliError = err instanceof CliError ? err : undefined;

      blank();
      error(thrownError.message);
      const hint = remediationHintFor(err);
      if (hint) {
        print(`  → ${hint}`, 'stderr');
      }
      logger.error(thrownError.message);
      process.exitCode = cliError?.exitCode ?? 1;
    }
  }
}
