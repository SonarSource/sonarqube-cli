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

import type { CommandOptions } from 'commander';
import { Command, Help, Option } from 'commander';

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime, createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { CliError, CommandFailedError, remediationHintFor } from '@/core/commands/command-error.ts';
import { commandPathSegments, qualifiedCommandPath } from '@/core/commands/path.ts';
import {
  ALPHA_HELP_GROUP,
  deprecationWarning,
  isSameLifecycle,
  isStageVisible,
  type LifecycleState,
  resolveLifecycle,
  STABLE_LIFECYCLE,
  type StageDescriptor,
  withLifecycleTag,
} from '@/core/commands/stage.ts';
import logger from '@/core/observability/logger.ts';
import { isResult, type ResultAsync } from '@/core/result.ts';
import { loadState, saveState } from '@/core/state/state-manager.ts';
import type { Console } from '@/core/ui/console.ts';
import type { UpdateNotificationCondition } from '@/core/update/notification.ts';
import { UpdateNotifier } from '@/core/update/notification.ts';

import { version as VERSION } from '../../../package.json';
import {
  CommandAuthenticatedInvocationContext,
  CommandInvocationContext,
} from './invocation-context.ts';

export {
  type CliRuntime,
  createCliRuntime,
  isAlphaEnabledFromEnv,
} from '@/core/commands/cli-runtime.ts';
export {
  ALPHA_ENV_VAR,
  type DeprecatedStageOptions,
  deprecationDetails,
  type LifecycleState,
  Stage,
  type StageDescriptor,
  stageHelpTag,
  type StageName,
} from '@/core/commands/stage.ts';

const betaWarningsShownWithoutState = new Set<string>();

export const COMMAND_CATEGORIES = ['core', 'data', 'integrate', 'cli-management'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

/** @deprecated Use {@link createCliRuntime} instead. */
export { createCliRuntime as createDefaultCliRuntime } from '@/core/commands/cli-runtime.ts';

function isPrivateBetaGated(lifecycle: LifecycleState): boolean {
  return lifecycle.stage === 'beta' && lifecycle.betaFlagKey !== undefined;
}

function recordPrivateBetaFlagKey(runtime: CliRuntime, lifecycle: LifecycleState): void {
  if (lifecycle.stage !== 'beta' || lifecycle.betaFlagKey === undefined) {
    return;
  }
  runtime.privateBetaFlags.record(lifecycle.betaFlagKey);
}

/**
 * Commander Option subclass that can be marked Alpha, Beta, or Deprecated.
 *
 * `.option()` returns the command, so `.option().stage()` cannot type-check.
 * Stage options by passing a {@link SonarOption} to {@link SonarCommand.addOption}:
 *
 * @example
 * .addOption(
 *   new SonarOption('--preview', 'Preview the plan without applying it')
 *     .stage(Stage.Alpha),
 * )
 */
export class SonarOption extends Option {
  private _lifecycle = STABLE_LIFECYCLE;

  /**
   * Mark this option as Stable, Alpha, Beta (optionally Private Beta via a flag
   * key), or Deprecated. Required options cannot be staged as Alpha or Beta;
   * when the caller is not entitled the option is omitted from help and treated
   * as unknown. Deprecated options stay registered and warn on every use.
   */
  stage(stage: StageDescriptor): this {
    if (this.mandatory && (stage.name === 'alpha' || stage.name === 'beta')) {
      throw new Error(`Cannot stage a required option as Alpha or Beta: '${this.flags}'`);
    }

    const next = resolveLifecycle(stage);
    if (isSameLifecycle(this._lifecycle, next)) {
      return this;
    }
    this._lifecycle = next;

    if (next.stage === 'alpha') {
      this.helpGroup(ALPHA_HELP_GROUP);
    } else {
      this.helpGroupHeading = undefined;
    }
    return this;
  }

  get lifecycle(): LifecycleState {
    return this._lifecycle;
  }
}

export interface RootHelpMetadata {
  category?: CommandCategory;
  expandSubcommands?: boolean;
  label?: string;
}

/** Shared state for a SonarCommand and its subtree. `console` is required; production passes the process console from `buildCommandTree`. */
export interface SonarCommandOptions {
  updateNotifier?: UpdateNotifier;
  runtime?: CliRuntime;
  console: Console;
}

type CommandArgs = unknown[];
type CommandResult = void | Promise<void>;
/** {@link CommandResult} plus the Result rail, which only `authenticatedAction` collapses. */
type AuthenticatedCommandResult = Promise<void> | ResultAsync<void, Error>;

class SonarHelp extends Help {
  override visibleCommands(command: Command): Command[] {
    const visibleCommands = super.visibleCommands(command) as SonarCommand[];
    return [
      ...visibleCommands.filter((child) => child.lifecycle.stage !== 'alpha'),
      ...visibleCommands.filter((child) => child.lifecycle.stage === 'alpha'),
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

  override optionDescription(option: Option): string {
    const description = super.optionDescription(option);
    return option instanceof SonarOption
      ? withLifecycleTag(description, option.lifecycle.stage)
      : description;
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
 *  - stage()               marks a command as Stable, Alpha, Beta, or Deprecated,
 *                          controlling its availability, help, documentation, and warnings
 *  - createOption()        returns {@link SonarOption}; stage via addOption(), not .option()
 *  - addOption()           accepts {@link SonarOption} only; omits Alpha/Private Beta options
 *                          the caller is not entitled to use
 *  - commandAndSubcommand() top-level command + remainder (passthrough override when set)
 */
export class SonarCommand extends Command {
  // Valid because Commander declares `options` as readonly (covariant), so we can narrow Option to SonarOption.
  declare readonly options: readonly SonarOption[];
  private _lifecycle = STABLE_LIFECYCLE;
  private _requiresAuth = false;
  private _rootHelp: RootHelpMetadata = {};
  private readonly _updateNotifier: UpdateNotifier;
  private readonly _runtime: CliRuntime;
  private readonly _console: Console;
  private _invocationContext: CommandInvocationContext | undefined;
  private _passthroughSubcommand?: string | null;
  private readonly deferredPrivateBetaOptions: SonarOption[] = [];
  private readonly deferredPrivateBetaCommands: SonarCommand[] = [];

  /**
   * `updateNotifier` / `runtime` default so the root command owns the
   * instances the whole tree shares; every subcommand inherits them via
   * createCommand(). `console` is required and is passed through the same way.
   */
  constructor(options: SonarCommandOptions);
  constructor(name: string, options: SonarCommandOptions);
  constructor(nameOrOptions: string | SonarCommandOptions, maybeOptions?: SonarCommandOptions) {
    const hasName = typeof nameOrOptions === 'string';
    const name = hasName ? nameOrOptions : undefined;
    const options = typeof nameOrOptions === 'object' ? nameOrOptions : maybeOptions;
    if (options?.console === undefined) {
      throw new TypeError('SonarCommand requires a console');
    }
    super(name);
    this._console = options.console;
    this._updateNotifier = options.updateNotifier ?? new UpdateNotifier(this._console);
    this._runtime = options.runtime ?? createCliRuntime({ console: options.console });
    this.hook('preAction', () => {
      if (this._lifecycle.stage === 'alpha') {
        this._console.info(
          `'${qualifiedCommandPath(this)}' is in alpha; may change or be removed without notice.`,
          'stderr',
        );
      }
      this.warnIfDeprecated();
      this.warnIfStagedOptionsUsed();
    });
  }

  /** Ensures subcommands created via .command() are also SonarCommand instances. */
  createCommand(name: string): SonarCommand {
    return new SonarCommand(name, {
      updateNotifier: this._updateNotifier,
      runtime: this._runtime,
      console: this._console,
    });
  }

  /** Options created via `.option()` / `.requiredOption()` are {@link SonarOption}s. */
  createOption(flags: string, description?: string): SonarOption {
    return new SonarOption(flags, description);
  }

  /**
   * Register a {@link SonarOption}. Alpha and Private Beta options are omitted when the caller
   * is not entitled, so they do not appear in help and parse as unknown.
   */
  addOption(option: SonarOption): this {
    const stage = option.lifecycle.stage;
    if (option.mandatory && (stage === 'alpha' || stage === 'beta')) {
      throw new Error(`Cannot stage a required option as Alpha or Beta: '${option.flags}'`);
    }
    recordPrivateBetaFlagKey(this._runtime, option.lifecycle);
    if (!isStageVisible(option.lifecycle, this._runtime)) {
      if (isPrivateBetaGated(option.lifecycle)) {
        this.deferredPrivateBetaOptions.push(option);
      }
      return this;
    }
    return super.addOption(option);
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
   * createCommandTree() registers every .showUpdateNotification() call into this
   * instance while building the tree. External code (the postAction hook, unit
   * tests) reads that already-populated instance via this getter on the root.
   */
  get updateNotifier(): UpdateNotifier {
    return this._updateNotifier;
  }

  /** Startup auth / Private Beta gate shared by this command and its subtree. */
  get runtime(): CliRuntime {
    return this._runtime;
  }

  /**
   * Context for the action that just ran. Set when `anonymousAction` /
   * `authenticatedAction` invoke the handler; `postAction` reads recorded
   * telemetry facts from it.
   */
  get invocationContext(): CommandInvocationContext | undefined {
    return this._invocationContext;
  }

  /**
   * Top-level command and remaining path, as recorded in CliCommandExecuted.
   *
   * `command` is the first segment after the program name (`auth` in
   * `sonar auth login`). `subcommand` is the remainder (`login`), or a
   * passthrough override when {@link setPassthroughSubcommand} was called
   * (including an explicit `null`).
   */
  commandAndSubcommand(): { command: string | undefined; subcommand: string | null } {
    const names = commandPathSegments(this);
    const derivedSubcommand = names.length > 1 ? names.slice(1).join(' ') : null;
    let subcommand = derivedSubcommand;
    // Explicit null means "no remainder"; ?? would collapse that to the derived path.
    if (this._passthroughSubcommand !== undefined) {
      subcommand = this._passthroughSubcommand;
    }
    return { command: names[0], subcommand };
  }

  /**
   * Override the remaining path used by {@link commandAndSubcommand}.
   * Passthrough commands (e.g. `sonar context`) stash the forwarded action here
   * because it is not a Commander subcommand. Pass `null` to record no
   * subcommand even when the command chain has children.
   */
  setPassthroughSubcommand(subcommand: string | null): this {
    this._passthroughSubcommand = subcommand;
    return this;
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

  /** Mark this command as Stable, Alpha, Beta (optionally Private Beta via a flag key), or Deprecated. */
  stage(stage: StageDescriptor): this {
    const next = resolveLifecycle(stage);
    if (isSameLifecycle(this._lifecycle, next)) {
      return this;
    }
    this._lifecycle = next;

    if (next.stage === 'alpha') {
      this.helpGroup(ALPHA_HELP_GROUP);
    } else if (this.helpGroup() === ALPHA_HELP_GROUP) {
      this.helpGroup('');
    }

    recordPrivateBetaFlagKey(this._runtime, next);

    // Commander already attached this command via .command(); keep or detach.
    if (this.isStageVisible()) {
      this.attachToParent();
    } else {
      this.detachFromParent();
      if (isPrivateBetaGated(next)) {
        (this.parent as SonarCommand | undefined)?.deferPrivateBetaChild(this);
      }
    }
    return this;
  }

  /** Tracks Private Beta subcommands detached at build time until flags resolve. */
  deferPrivateBetaChild(child: SonarCommand): void {
    if (!this.deferredPrivateBetaCommands.includes(child)) {
      this.deferredPrivateBetaCommands.push(child);
    }
  }

  private isStageVisible(): boolean {
    return isStageVisible(this._lifecycle, this._runtime);
  }

  /** Re-attach after a stage change that makes this command visible again. */
  private attachToParent(): void {
    const siblings = this.parent?.commands as Command[] | undefined;
    if (siblings && !siblings.includes(this)) {
      siblings.push(this);
    }
  }

  /**
   * Remove this command from its parent's registration array.
   * Commander has no public command-removal API, and attaches eagerly on
   * `.command()` before `.stage()` can decide visibility.
   */
  private detachFromParent(): void {
    const siblings = this.parent?.commands as Command[] | undefined;
    const commandIndex = siblings?.indexOf(this) ?? -1;
    if (commandIndex >= 0) {
      siblings?.splice(commandIndex, 1);
    }
  }

  /** Re-evaluate Private Beta (and other staged) visibility after LaunchDarkly resolves flags. */
  refreshStagedVisibility(): void {
    const stillDeferredCommands: SonarCommand[] = [];
    for (const command of this.deferredPrivateBetaCommands) {
      if (isStageVisible(command.lifecycle, this._runtime)) {
        command.attachToParent();
      } else {
        stillDeferredCommands.push(command);
      }
    }
    this.deferredPrivateBetaCommands.length = 0;
    this.deferredPrivateBetaCommands.push(...stillDeferredCommands);

    if (this.isStageVisible()) {
      this.attachToParent();
    } else {
      this.detachFromParent();
      if (isPrivateBetaGated(this._lifecycle)) {
        (this.parent as SonarCommand | undefined)?.deferPrivateBetaChild(this);
      }
    }

    const stillDeferredOptions: SonarOption[] = [];
    for (const option of this.deferredPrivateBetaOptions) {
      if (isStageVisible(option.lifecycle, this._runtime)) {
        super.addOption(option);
      } else {
        stillDeferredOptions.push(option);
      }
    }
    this.deferredPrivateBetaOptions.length = 0;
    this.deferredPrivateBetaOptions.push(...stillDeferredOptions);

    const children = new Set<SonarCommand>([
      ...(this.commands as SonarCommand[]),
      ...stillDeferredCommands,
    ]);
    for (const child of children) {
      child.refreshStagedVisibility();
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

    return withLifecycleTag(super.description(), this._lifecycle.stage);
  }

  summary(str: string): this;
  summary(): string;
  summary(str?: string): this | string {
    if (str !== undefined) {
      return super.summary(str);
    }

    const summary = super.summary();
    return summary ? withLifecycleTag(summary, this._lifecycle.stage) : summary;
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
   * A {@link CommandInvocationContext} is passed as the first argument to fn (stage accessors
   * resolve alpha/beta for this execution); Commander's own arguments follow.
   * Record telemetry with `ctx.recordTelemetry(...)` — drained in `postAction`
   * together with `CliCommandExecuted`.
   *
   * The `this` context set by Commander is forwarded to the handler, so
   * `function(this: Command, _ctx: CommandInvocationContext) { this.outputHelp(); }` works.
   */
  anonymousAction<TArgs extends CommandArgs>(
    this: this & { __commandArgs?: TArgs },
    fn: (ctx: CommandInvocationContext, ...args: TArgs) => CommandResult,
  ): this {
    super.action(function (this: SonarCommand, ...args: TArgs) {
      return this.runCommand(() =>
        Promise.resolve(fn.call(this, this.createCommandInvocationContext(), ...args)),
      );
    });
    return this;
  }

  /**
   * Register an action that requires authentication. Auth is resolved before
   * the handler is invoked; if no auth is configured the command fails with a
   * clear message. A {@link CommandAuthenticatedInvocationContext} is passed as the first
   * argument to fn (auth plus stage accessors for this execution); Commander's
   * own arguments (options, positional args) follow. Record telemetry with
   * `ctx.recordTelemetry(...)` — drained in `postAction`.
   *
   * Sets requiresAuth = true on this command for documentation purposes.
   *
   * A handler that fails on the Result rail has its error rethrown here rather than
   * handled, so `runCommand()` stays the one place a failure becomes an exit code.
   */
  authenticatedAction<TArgs extends CommandArgs>(
    this: this & { __commandArgs?: TArgs },
    fn: (ctx: CommandAuthenticatedInvocationContext, ...args: TArgs) => AuthenticatedCommandResult,
  ): this {
    this._requiresAuth = true;
    super.action((...args: TArgs) =>
      this.runCommand(async () => {
        const ctx = this.createCommandInvocationContext();
        const authResult = await ctx.resolveAuth();
        if (authResult.isErr()) {
          throw authResult.error;
        }
        if (!authResult.value) {
          throw new CommandFailedError('Not authenticated.', {
            remediationHint: "Run 'sonar auth login' to authenticate.",
          });
        }
        const outcome = await fn(
          this.createCommandAuthenticatedInvocationContext(authResult.value),
          ...args,
        );
        if (isResult(outcome) && outcome.isErr()) {
          throw outcome.error;
        }
      }),
    );
    return this;
  }

  private createCommandInvocationContext(): CommandInvocationContext {
    const ctx = new CommandInvocationContext(this._console, this._lifecycle, this._runtime);
    this._invocationContext = ctx;
    return ctx;
  }

  private createCommandAuthenticatedInvocationContext(
    auth: ResolvedAuth,
  ): CommandAuthenticatedInvocationContext {
    const ctx = new CommandAuthenticatedInvocationContext(
      auth,
      this._console,
      this._lifecycle,
      this._runtime,
    );
    this._invocationContext = ctx;
    return ctx;
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

  get lifecycle(): LifecycleState {
    return this._lifecycle;
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

      this._console.blank();
      this._console.error(thrownError.message);
      const hint = remediationHintFor(err);
      if (hint) {
        this._console.print(`  → ${hint}`, 'stderr');
      }
      logger.error(thrownError.message);
      process.exitCode = cliError?.exitCode ?? 1;
    }
  }

  private warnIfStagedOptionsUsed(): void {
    for (const option of this.options) {
      if (option.lifecycle.stage === 'stable') {
        continue;
      }
      if (this.getOptionValueSource(option.attributeName()) !== 'cli') {
        continue;
      }

      const flag = option.long ?? option.flags;
      const lifecycle = option.lifecycle;
      if (lifecycle.stage === 'alpha') {
        this._console.info(
          `'${flag}' is in alpha; may change or be removed without notice.`,
          'stderr',
        );
      } else if (lifecycle.stage === 'beta') {
        this.warnIfBetaOnce(
          `${qualifiedCommandPath(this)} ${flag}`,
          `'${flag}' is in beta and may change.`,
        );
      } else {
        this._console.warn(deprecationWarning(flag, lifecycle.sinceVersion, lifecycle.replacement));
      }
    }
  }

  private warnIfDeprecated(): void {
    if (this._lifecycle.stage !== 'deprecated') {
      return;
    }

    this._console.warn(
      deprecationWarning(
        qualifiedCommandPath(this),
        this._lifecycle.sinceVersion,
        this._lifecycle.replacement,
      ),
    );
  }

  private warnIfBeta(): void {
    if (this._lifecycle.stage !== 'beta') {
      return;
    }

    const commandPath = qualifiedCommandPath(this);
    this.warnIfBetaOnce(commandPath, `'${commandPath}' is in beta and may change.`);
  }

  private warnIfBetaOnce(warningKey: string, message: string): void {
    let state;

    try {
      state = loadState();
    } catch {
      if (betaWarningsShownWithoutState.has(warningKey)) {
        return;
      }
      betaWarningsShownWithoutState.add(warningKey);
      this._console.info(message, 'stderr');
      return;
    }

    if (state.config.betaCommandWarnings?.[warningKey] === VERSION) {
      return;
    }

    this._console.info(message, 'stderr');
    state.config.betaCommandWarnings = {
      ...state.config.betaCommandWarnings,
      [warningKey]: VERSION,
    };

    try {
      saveState(state);
    } catch (err) {
      logger.debug(`Failed to persist Beta command warning: ${(err as Error).message}`);
    }
  }
}

function collectPrivateBetaFlagKey(keys: Set<string>, lifecycle: LifecycleState): void {
  if (lifecycle.stage === 'beta' && lifecycle.betaFlagKey !== undefined) {
    keys.add(lifecycle.betaFlagKey);
  }
}

/** Returns Private Beta flag keys recorded while building `root`. */
export function collectPrivateBetaFlagKeys(root: SonarCommand): string[] {
  return [...root.runtime.privateBetaFlags.flagKeys()];
}

/** @deprecated Walks the tree; prefer {@link SonarCommand.runtime}.privateBetaFlags. */
export function walkPrivateBetaFlagKeys(root: SonarCommand): string[] {
  const keys = new Set<string>();

  const visit = (command: SonarCommand): void => {
    collectPrivateBetaFlagKey(keys, command.lifecycle);
    for (const option of command.options) {
      collectPrivateBetaFlagKey(keys, option.lifecycle);
    }
    for (const child of command.commands as SonarCommand[]) {
      visit(child);
    }
  };

  visit(root);
  return [...keys];
}
