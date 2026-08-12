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

import type { CommandOptions, Option } from 'commander';
import { Command, Help } from 'commander';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { resolveAuth } from '@/core/auth/auth-resolver.ts';
import { CliError, CommandFailedError, remediationHintFor } from '@/core/command-error.ts';
import logger from '@/core/observability/logger.ts';
import { loadState, saveState } from '@/core/state/state-manager.ts';
import { blank, error, info, print } from '@/core/ui';
import type { UpdateNotificationCondition } from '@/core/update/notification.ts';
import { UpdateNotifier } from '@/core/update/notification.ts';

import { version as VERSION } from '../../package.json';

export const ALPHA_ENV_VAR = 'SONARQUBE_CLI_ALPHA';
export const ALPHA_HELP_TAG = '[ALPHA]';
export const BETA_HELP_TAG = '[BETA]';

export type StageName = 'stable' | 'alpha' | 'beta';

/** Descriptor passed to {@link SonarCommand.stage}. */
export type StageDescriptor =
  | { readonly name: 'stable' }
  | { readonly name: 'alpha' }
  | { readonly name: 'beta'; readonly flagKey?: string };

function betaStage(flagKey?: string): StageDescriptor {
  return flagKey === undefined ? { name: 'beta' } : { name: 'beta', flagKey };
}

/**
 * Command lifecycle stage.
 * Stable/Alpha are constants; Beta is a function so an optional LaunchDarkly
 * flag key can only be attached to Private Beta commands.
 */
export const Stage = {
  Stable: { name: 'stable' } as const satisfies StageDescriptor,
  Alpha: { name: 'alpha' } as const satisfies StageDescriptor,
  Beta: betaStage,
};

const ALPHA_HELP_GROUP = '__SONARQUBE_CLI_ALPHA_COMMANDS__';
const betaWarningsShownWithoutState = new Set<string>();

export const COMMAND_CATEGORIES = ['core', 'data', 'integrate', 'cli-management'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/** Shared per-invocation context for command-tree construction and execution. */
export interface CliRuntime {
  /** Auth resolved once at startup; `null` when unauthenticated. */
  auth: ResolvedAuth | null;
  /** Private Beta registration gate; Open Beta ignores this. */
  isPrivateBetaEnabled: (flagKey: string) => boolean;
}

export function createDefaultCliRuntime(): CliRuntime {
  return {
    auth: null,
    isPrivateBetaEnabled: () => false,
  };
}

function isAlphaEnabled(): boolean {
  const value = process.env[ALPHA_ENV_VAR];
  return value === 'true' || value === '1';
}

export interface RootHelpMetadata {
  category?: CommandCategory;
  expandSubcommands?: boolean;
  label?: string;
}

/** Optional shared state for a SonarCommand and its subtree. */
export interface SonarCommandOptions {
  updateNotifier?: UpdateNotifier;
  runtime?: CliRuntime;
}

type CommandArgs = unknown[];
type CommandResult = void | Promise<void>;

class SonarHelp extends Help {
  override visibleCommands(command: Command): Command[] {
    const visibleCommands = super.visibleCommands(command) as SonarCommand[];
    return [
      ...visibleCommands.filter((child) => !child.isAlpha),
      ...visibleCommands.filter((child) => child.isAlpha),
    ];
  }

  override groupItems<T extends Command | Option>(
    unsortedItems: T[],
    visibleItems: T[],
    getGroup: (item: T) => string,
  ): Map<string, T[]> {
    const groups = super.groupItems(unsortedItems, visibleItems, getGroup);
    const alphaCommands = groups.get(ALPHA_HELP_GROUP);
    if (alphaCommands) {
      groups.delete(ALPHA_HELP_GROUP);
      groups.set(ALPHA_HELP_GROUP, alphaCommands);
    }
    return groups;
  }

  override formatItemList(heading: string, items: string[], helper: Help): string[] {
    if (heading === ALPHA_HELP_GROUP) {
      return items.length === 0 ? [] : [...items, ''];
    }
    return super.formatItemList(heading, items, helper);
  }
}

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
 *  - stage()               marks a command as Stable, Alpha, or Beta, controlling its
 *                          availability, help, documentation, and warnings
 */
export class SonarCommand extends Command {
  private _stage: StageName = 'stable';
  private _betaFlagKey: string | undefined;
  private _requiresAuth = false;
  private _rootHelp: RootHelpMetadata = {};
  private readonly _updateNotifier: UpdateNotifier;
  private readonly _runtime: CliRuntime;

  /**
   * `updateNotifier` / `runtime` default so the root command owns the instances
   * the whole tree shares; every subcommand inherits them via createCommand().
   */
  constructor(options?: SonarCommandOptions);
  constructor(name?: string, options?: SonarCommandOptions);
  constructor(
    nameOrOptions?: string | SonarCommandOptions,
    maybeOptions: SonarCommandOptions = {},
  ) {
    const hasName = typeof nameOrOptions === 'string';
    const name = hasName ? nameOrOptions : undefined;
    const options = (hasName ? maybeOptions : nameOrOptions) ?? {};
    super(name);
    this._updateNotifier = options.updateNotifier ?? new UpdateNotifier();
    this._runtime = options.runtime ?? createDefaultCliRuntime();
    this.hook('preAction', () => {
      if (this.isAlpha) {
        info(`'${this.name()}' is in alpha; may change or be removed without notice.`, 'stderr');
      }
    });
  }

  /** Ensures subcommands created via .command() are also SonarCommand instances. */
  createCommand(name?: string): SonarCommand {
    return new SonarCommand(name, {
      updateNotifier: this._updateNotifier,
      runtime: this._runtime,
    });
  }

  createHelp(): Help {
    return Object.assign(new SonarHelp(), this.configureHelp());
  }

  /**
   * Disallowed: addCommand() attaches a command constructed independently of
   * this tree's createCommand(), bypassing the shared per-tree state it sets up.
   * Use .command() instead.
   */
  addCommand(_cmd: Command, _opts?: CommandOptions): this {
    throw new Error('addCommand() is disallowed; use .command() instead');
  }

  /**
   * The update-notification registry shared by this command and its whole subtree.
   * External code (the postAction hook, unit tests) reads it via this getter on
   * the root command.
   */
  get updateNotifier(): UpdateNotifier {
    return this._updateNotifier;
  }

  /** Startup auth / Private Beta gate shared by this command and its subtree. */
  get runtime(): CliRuntime {
    return this._runtime;
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

  /** Mark this command as Stable, Alpha, or Beta (optionally Private Beta via a flag key). */
  stage(stage: StageDescriptor): this {
    const newStage = stage.name;
    const newFlagKey = stage.name === 'beta' ? stage.flagKey : undefined;
    if (this._stage === newStage && this._betaFlagKey === newFlagKey) {
      return this;
    }

    this._stage = newStage;
    this._betaFlagKey = newFlagKey;

    if (
      newStage === 'beta' &&
      newFlagKey !== undefined &&
      !this._runtime.isPrivateBetaEnabled(newFlagKey)
    ) {
      if (this.helpGroup() === ALPHA_HELP_GROUP) {
        this.helpGroup('');
      }
      this.unregisterFromParent();
      return this;
    }

    if (newStage !== 'alpha') {
      if (this.helpGroup() === ALPHA_HELP_GROUP) {
        this.helpGroup('');
      }
      this.registerWithParent();
      return this;
    }

    this.helpGroup(ALPHA_HELP_GROUP);
    if (!isAlphaEnabled()) {
      this.unregisterFromParent();
      return this;
    }

    return this;
  }

  /** Re-attach this command to its parent if it was previously unregistered. */
  registerWithParent(): void {
    const siblings = this.parent?.commands as Command[] | undefined;
    if (siblings && !siblings.includes(this)) {
      siblings.push(this);
    }
  }

  /**
   * Remove this command from its parent's registration array.
   * Commander has no public command-removal API.
   */
  unregisterFromParent(): void {
    const siblings = this.parent?.commands as Command[] | undefined;
    const commandIndex = siblings?.indexOf(this) ?? -1;
    if (commandIndex >= 0) {
      siblings?.splice(commandIndex, 1);
    }
  }

  description(str: string, argsDescription?: Record<string, string>): this;
  description(): string;
  description(str?: string, argsDescription?: Record<string, string>): this | string {
    if (str !== undefined) {
      // Preserve Commander's deprecated argument-description overload for substitutability.
      return argsDescription === undefined
        ? super.description(str)
        : // eslint-disable-next-line @typescript-eslint/no-deprecated
          super.description(str, argsDescription);
    }

    return this.withLifecycleTag(super.description());
  }

  summary(str: string): this;
  summary(): string;
  summary(str?: string): this | string {
    if (str !== undefined) {
      return super.summary(str);
    }

    const summary = super.summary();
    return summary ? this.withLifecycleTag(summary) : summary;
  }

  /**
   * Opt in to the post-command "new version available" stderr notice.
   * Pass a condition to show the notice only when it returns true for the
   * merged action-command options (parsed by Commander).
   */
  showUpdateNotification(when?: UpdateNotificationCondition): this {
    this._updateNotifier.register(this, when);
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
        // Prefer auth resolved once at startup; fall back for isolated unit tests.
        const auth = this._runtime.auth ?? (await resolveAuth());
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

  /** True when this command is Stable. */
  get isStable(): boolean {
    return this._stage === 'stable';
  }

  /** True when this command is Alpha. */
  get isAlpha(): boolean {
    return this._stage === 'alpha';
  }

  /** True when this command is Beta (Open or Private). */
  get isBeta(): boolean {
    return this._stage === 'beta';
  }

  /** True when this Beta command is gated by a LaunchDarkly flag key. */
  get isPrivateBeta(): boolean {
    return this._stage === 'beta' && this._betaFlagKey !== undefined;
  }

  /** LaunchDarkly flag key for Private Beta; undefined for Open Beta / non-Beta. */
  get betaFlagKey(): string | undefined {
    return this._betaFlagKey;
  }

  /** Metadata used by the custom root help menu. */
  get rootHelpMetadata(): RootHelpMetadata {
    return this._rootHelp;
  }

  async runCommand(fn: () => Promise<void>): Promise<void> {
    this.warnIfBeta();

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

  private withLifecycleTag(description: string): string {
    if (this._stage === 'alpha') {
      return `${description} ${ALPHA_HELP_TAG}`;
    }
    if (this._stage === 'beta') {
      return `${description} ${BETA_HELP_TAG}`;
    }
    return description;
  }

  private commandPath(): string {
    const names = [this.name()];

    for (let parent = this.parent; parent?.parent; parent = parent.parent) {
      names.unshift(parent.name());
    }

    return names.join(' ');
  }

  private warnIfBeta(): void {
    if (this._stage !== 'beta') {
      return;
    }

    const commandPath = this.commandPath();
    let state;

    try {
      state = loadState();
    } catch {
      if (betaWarningsShownWithoutState.has(commandPath)) {
        return;
      }
      betaWarningsShownWithoutState.add(commandPath);
      info(`'${commandPath}' is in beta and may change.`, 'stderr');
      return;
    }

    if (state.config.betaCommandWarnings?.[commandPath] === VERSION) {
      return;
    }

    info(`'${commandPath}' is in beta and may change.`, 'stderr');
    state.config.betaCommandWarnings = {
      ...state.config.betaCommandWarnings,
      [commandPath]: VERSION,
    };

    try {
      saveState(state);
    } catch (err) {
      logger.debug(`Failed to persist Beta command warning: ${(err as Error).message}`);
    }
  }
}
