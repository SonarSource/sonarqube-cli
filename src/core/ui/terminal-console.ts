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

import {
  ConfirmPrompt,
  getColumns,
  isCancel,
  PasswordPrompt,
  Prompt,
  SelectPrompt,
  TextPrompt,
} from '@clack/core';

import {
  bold,
  cyan,
  dim,
  green,
  isTTY,
  red,
  STATUS_COLORS,
  STATUS_ICONS,
  stripAnsi,
  visibleLength,
  yellow,
} from './colors.ts';
import type { Console } from './console.ts';
import { channelStream, write } from './streams.ts';
import type {
  ColorFn,
  MultiSelectOption,
  MultiSelectPromptOptions,
  NoteOptions,
  OutputChannel,
  PhaseItem,
  PhaseOptions,
  SelectOption,
  StepStatus,
} from './types.ts';

const NOTE_MIN_WIDTH = 40;
const NOTE_MAX_WIDTH = 80;
const TITLE_BORDER_PREFIX = '┌─ ';

const DIVIDER_BASE_WIDTH = 40;
const DIVIDER_WIDTH = DIVIDER_BASE_WIDTH + 2; // + 2 for indent alignment
const DIVIDER = '━'.repeat(DIVIDER_WIDTH);

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

const CTRL_C = 0x03;
const ENTER_CR = 0x0d;
const ENTER_LF = 0x0a;
const EXIT_CODE_SIGINT = 130;

const MULTISELECT_VIEWPORT_SIZE = 12;
const MULTISELECT_MAX_SELECTED = 20;

function noteWidth(): number {
  const cols = isTTY ? getColumns(process.stdout) : NOTE_MIN_WIDTH;
  return Math.min(Math.max(cols - 4, NOTE_MIN_WIDTH), NOTE_MAX_WIDTH);
}

function formatNoteTty(lines: string[], title: string | undefined, opts: NoteOptions): string {
  const borderColor: ColorFn = opts.borderColor ?? dim;
  const titleColor: ColorFn = opts.titleColor ?? bold;
  const contentColor: ColorFn = opts.contentColor ?? ((s) => s);

  const width = noteWidth();
  const innerWidth = width - 2; // subtract border chars

  const top = title
    ? borderColor(TITLE_BORDER_PREFIX) +
      titleColor(title) +
      borderColor(' ' + '─'.repeat(Math.max(0, innerWidth - title.length - 1)) + '┐')
    : borderColor('┌' + '─'.repeat(width) + '┐');

  const empty = borderColor('│') + ' '.repeat(width) + borderColor('│');
  const bottom = borderColor('└' + '─'.repeat(width) + '┘');

  const contentLines = lines.map((line) => {
    // Truncate on visible text so a cut never leaves a dangling "style on"
    // escape that bleeds into the border. Styling is dropped on cut lines.
    const truncated =
      visibleLength(line) > width - 1 ? stripAnsi(line).slice(0, width - 4) + '...' : line;
    const padded = truncated + ' '.repeat(Math.max(0, width - 1 - visibleLength(truncated)));
    return borderColor('│') + ' ' + contentColor(padded) + borderColor('│');
  });

  return [top, empty, ...contentLines, empty, bottom].join('\n');
}

function formatNotePlain(lines: string[], title: string | undefined): string {
  const header = title ? `[${title}]` : '';
  return [header, ...lines].filter(Boolean).join('\n');
}

function formatPhaseItem(
  item: PhaseItem,
  iconColors: Partial<Record<StepStatus, ColorFn>>,
): string {
  const colorFn: ColorFn = iconColors[item.status] ?? STATUS_COLORS[item.status];
  const icon = colorFn(STATUS_ICONS[item.status]);
  const detail = item.detail ? dim(`: ${item.detail}`) : '';
  const lines = [`    ${icon}  ${item.text}${detail}`];
  for (const subItem of item.subItems ?? []) {
    lines.push(dim(`       ${subItem}`));
  }
  return lines.join('\n');
}

/** Selection hint line shown while the multi-select prompt is active (not submitted/cancelled). */
function buildSelectHint(countLabel: string, atCap: boolean): string {
  if (atCap) {
    return dim(`(${countLabel} - at max, deselect to choose others)`);
  }
  return dim(`(${countLabel} - space to toggle, enter to confirm, q to quit)`);
}

function formatLoadMoreRow(isCursor: boolean, loading: boolean, error: string | null): string {
  if (loading) {
    return `    ${dim('…')}    ${dim('Loading...')}`;
  }
  const arrow = isCursor ? cyan('❯') : ' ';
  let label = 'Load more...';
  if (error) {
    const retryHint = dim(`(${error} - press enter to retry)`);
    label = `Load more... ${retryHint}`;
  }
  return `    ${arrow}    ${isCursor ? label : dim(label)}`;
}

function formatOptionRow(
  label: string,
  isCursor: boolean,
  isSelected: boolean,
  atCap: boolean,
  disabled: boolean,
): string {
  const unavailable = disabled || (atCap && !isSelected);
  const checkbox = checkboxComponent(isSelected, unavailable);
  const arrow = isCursor ? cyan('❯') : ' ';
  const displayLabel = isCursor && !unavailable ? label : dim(label);
  return `    ${arrow} ${checkbox}  ${displayLabel}`;
}

export function calculateViewport(
  cursor: number,
  total: number,
  viewportSize: number,
): { start: number; end: number } {
  const start = Math.min(
    Math.max(0, cursor - Math.floor(viewportSize / 2)),
    Math.max(0, total - viewportSize),
  );
  const end = Math.min(start + viewportSize, total);
  return { start, end };
}

export function toggleSelected<T>(selected: T[], val: T, max: number): void {
  const idx = selected.indexOf(val);
  if (idx >= 0) {
    selected.splice(idx, 1);
  } else if (selected.length < max) {
    selected.push(val);
  }
}

export function checkboxComponent(isSelected: boolean, unavailable: boolean): string {
  if (isSelected) {
    return cyan('◉');
  }

  if (unavailable) {
    return dim('◯');
  }

  return '◯';
}

class MultiSelectLoadMorePrompt extends Prompt<unknown[]> {
  private pendingLoadMoreSubmitBlock = false;

  blockSubmit(): void {
    this.pendingLoadMoreSubmitBlock = true;
  }

  allowSubmit(): void {
    this.pendingLoadMoreSubmitBlock = false;
  }

  protected override _shouldSubmit(): boolean {
    return !this.pendingLoadMoreSubmitBlock;
  }

  /**
   * Forces a redraw outside of a keypress (needed once an async `onLoadMore()` resolves).
   * `render` is private on the base class, but `output` is protected and the base
   * constructor already wires `output.on('resize', this.render)` for terminal resizes —
   * reusing that plumbing to trigger a render is simpler than re-implementing it.
   */
  refresh(): void {
    this.output.emit('resize');
  }
}

/** Production {@link Console}: writes to stdout/stderr. */
export class TerminalConsole implements Console {
  private formattedOutputMode = false;
  private readonly collectedMessages: string[] = [];

  info(message: string, channel: OutputChannel = 'stdout'): void {
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(`  ℹ  ${message}`);
      return;
    }
    write(channelStream(channel), `  ${cyan('ℹ')}  ${message}`);
  }

  success(message: string): void {
    if (this.formattedOutputMode) {
      this.collectedMessages.push(`✅ ${message}`);
      return;
    }
    write(process.stdout, `✅ ${green(message)}`);
  }

  discreetSuccess(message: string, channel: OutputChannel = 'stdout'): void {
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(`  ✓  ${message}`);
      return;
    }
    write(channelStream(channel), `  ${green('✓')}  ${message}`);
  }

  warn(message: string): void {
    write(process.stderr, `⚠️ ${yellow(message)}`);
  }

  error(message: string): void {
    write(process.stderr, `❌ ${red(message)}`);
  }

  text(message: string, color?: ColorFn, channel: OutputChannel = 'stdout'): void {
    if (channel === 'stdout' && this.formattedOutputMode) {
      this.collectedMessages.push(message);
      return;
    }
    const formatted = color ? color(message) : message;
    write(channelStream(channel), formatted);
  }

  print(message: string, channel: OutputChannel = 'stdout'): void {
    channelStream(channel).write(message + (message.endsWith('\n') ? '' : '\n'));
  }

  blank(): void {
    if (this.formattedOutputMode) {
      return;
    }
    if (isTTY) {
      process.stdout.write('\n');
    }
  }

  note(content: string | string[], title?: string, opts: NoteOptions = {}): void {
    const lines = Array.isArray(content) ? content : content.split('\n');
    const output = isTTY ? formatNoteTty(lines, title, opts) : formatNotePlain(lines, title);
    process.stdout.write(output + '\n');
  }

  phase(title: string, items: PhaseItem[], opts: PhaseOptions = {}): void {
    const titleColor: ColorFn = opts.titleColor ?? bold;
    const iconColors = opts.iconColors ?? {};

    if (isTTY) {
      process.stdout.write(`\n  ${titleColor(title)}\n`);
      for (const item of items) {
        process.stdout.write(formatPhaseItem(item, iconColors) + '\n');
      }
      process.stdout.write('\n');
      return;
    }

    process.stdout.write(`\n${title}\n`);
    for (const item of items) {
      const icon = STATUS_ICONS[item.status];
      const detail = item.detail ? `: ${item.detail}` : '';
      process.stdout.write(`  ${icon}  ${item.text}${detail}\n`);
      for (const subItem of item.subItems ?? []) {
        process.stdout.write(`       ${subItem}\n`);
      }
    }
    process.stdout.write('\n');
  }

  intro(title: string, subtitle?: string): void {
    if (isTTY) {
      process.stdout.write(`\n  ${DIVIDER}\n`);
      process.stdout.write(`  ${bold(title)}\n`);
      if (subtitle) process.stdout.write(`       ${subtitle}\n`);
      process.stdout.write(`  ${DIVIDER}\n\n`);
      return;
    }
    const subtitlePart = subtitle ? ` — ${subtitle}` : '';
    process.stdout.write(`\n=== ${title}${subtitlePart} ===\n\n`);
  }

  outro(message: string, status: 'success' | 'error' = 'success', detail?: string): void {
    const icon = status === 'success' ? '✅' : '❌';
    const colorFn = status === 'success' ? green : red;

    if (isTTY) {
      process.stdout.write(`\n  ${DIVIDER}\n`);
      process.stdout.write(`  ${icon}  ${bold(colorFn(message))}\n`);
      // Aligns under the message text: 2 leading + 2-col emoji icon + 2 gap.
      if (detail) process.stdout.write(`      ${bold(cyan(detail))}\n`);
      process.stdout.write(`  ${DIVIDER}\n\n`);
      return;
    }
    process.stdout.write(`\n=== ${message} ===\n`);
    if (detail) process.stdout.write(`${detail}\n`);
    process.stdout.write('\n');
  }

  async withSpinner<T>(
    message: string,
    task: () => Promise<T>,
    channel: OutputChannel = 'stdout',
  ): Promise<T> {
    const stream = channelStream(channel);

    if (!stream.isTTY) {
      stream.write(`${message}...\n`);
      return await task();
    }

    let frame = 0;
    const interval = setInterval(() => {
      stream.write(`\r  ${cyan(SPINNER_FRAMES[frame])}  ${message}`);
      frame = (frame + 1) % SPINNER_FRAMES.length;
    }, SPINNER_INTERVAL_MS);

    try {
      const result = await task();
      clearInterval(interval);
      stream.write(`\r  ${green('✓')}  ${message}\n`);
      return result;
    } catch (err) {
      clearInterval(interval);
      stream.write(`\r  ${red('✗')}  ${message}\n`);
      throw err;
    }
  }

  async textPrompt(message: string): Promise<string | null> {
    const prompt = new TextPrompt({
      render() {
        if (this.state === 'submit') return `  ${green('✓')}  ${message} ${dim(this.value ?? '')}`;
        if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
        return [`  ${cyan('?')}  ${message}`, `  ${dim('›')} ${this.userInputWithCursor}`].join(
          '\n',
        );
      },
    });

    const result = await prompt.prompt();
    if (isCancel(result)) return null;
    return result ?? null;
  }

  async passwordPrompt(message: string): Promise<string | null> {
    const prompt = new PasswordPrompt({
      render() {
        if (this.state === 'submit') return `  ${green('✓')}  ${message}`;
        if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
        return [`  ${cyan('?')}  ${message}`, `  ${dim('›')} ${this.userInputWithCursor}`].join(
          '\n',
        );
      },
    });

    const result = await prompt.prompt();
    if (isCancel(result)) return null;
    return result ?? null;
  }

  async confirmPrompt(message: string, defaultValue: boolean): Promise<boolean | null> {
    const prompt = new ConfirmPrompt({
      active: 'Yes',
      inactive: 'No',
      initialValue: defaultValue,
      render() {
        if (this.state === 'submit')
          return `  ${green('✓')}  ${message} ${dim(this.value ? 'Yes' : 'No')}`;
        if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
        const yes = this.cursor === 0 ? cyan('[Yes]') : ' Yes ';
        const no = this.cursor === 1 ? cyan('[No] ') : ' No  ';
        return `  ${cyan('?')}  ${message}  ${yes} / ${no}`;
      },
    });

    const result = await prompt.prompt();
    if (isCancel(result)) return null;
    return result ?? null;
  }

  async selectPrompt<T>(message: string, options: SelectOption<T>[]): Promise<T | null> {
    const prompt = new SelectPrompt({
      options,
      render() {
        if (this.state === 'submit') {
          const selected = options.find((o) => o.value === this.value);
          return `  ${green('✓')}  ${message} ${dim(selected?.label ?? String(this.value))}`;
        }
        if (this.state === 'cancel') return `  ${red('✗')}  ${message}`;
        const lines = [`  ${cyan('?')}  ${message}`];
        for (let i = 0; i < options.length; i++) {
          const opt = options[i];
          const selected = i === this.cursor;
          lines.push(`    ${selected ? cyan('›') : ' '} ${selected ? opt.label : dim(opt.label)}`);
        }
        return lines.join('\n');
      },
    });

    const result = await prompt.prompt();
    if (isCancel(result)) return null;
    return result as T;
  }

  /**
   * Multi-select prompt. Space to toggle, Enter to confirm. Max 20 selections by default
   * (override via `loadMoreOpts.maxSelected`). Options with `disabled: true` are shown (dimmed,
   * like an at-cap row) but the cursor can't toggle them.
   * Returns the selected values array (may be empty) or null if cancelled (Ctrl+C or q).
   * Renders a scrolling viewport when the option list exceeds MULTISELECT_VIEWPORT_SIZE.
   *
   * When `loadMoreOpts` is given, a non-toggleable "Load more..." row is appended while
   * `hasMore()` is true; pressing Enter on that row calls `onLoadMore()` instead of submitting.
   * Selections are preserved across a load-more because they're tracked by value identity
   * (`===`) rather than by index — callers must return `===`-stable values for options that
   * were already present before the reload. When `onLoadMore` returns a `Promise`, the row shows
   * a loading indicator until it resolves; Enter is ignored on every other row while it's pending.
   */
  async multiSelectPrompt<T>(
    message: string,
    initialOptions: MultiSelectOption<T>[],
    loadMoreOpts?: MultiSelectPromptOptions<T>,
  ): Promise<T[] | null> {
    let options = initialOptions;
    const selected: T[] = [];
    let cursor = 0;
    let loadingMore = false;
    let loadMoreError: string | null = null;
    const maxSelected = loadMoreOpts?.maxSelected ?? MULTISELECT_MAX_SELECTED;

    const onLoadMore = loadMoreOpts?.onLoadMore;
    const hasMore = (): boolean => onLoadMore !== undefined && (loadMoreOpts?.hasMore?.() ?? false);
    const isOnLoadMoreRow = (): boolean => hasMore() && cursor === options.length;
    const getTotal = (): number => loadMoreOpts?.total?.() ?? options.length;

    const prompt = new MultiSelectLoadMorePrompt(
      {
        render() {
          if (this.state === 'submit') {
            const selectedLabel = `${selected.length} of ${getTotal()} selected`;
            return `  ${green('✓')}  ${message} ${dim(selectedLabel)}`;
          }
          if (this.state === 'cancel') {
            return `  ${red('✗')}  ${message}`;
          }

          const atCap = selected.length >= maxSelected;
          const countLabel = `${selected.length}/${getTotal()} selected`;
          const hint = buildSelectHint(countLabel, atCap);

          const loadMoreRowVisible = hasMore() || loadingMore;
          const total = options.length + (loadMoreRowVisible ? 1 : 0);
          const { start, end } = calculateViewport(cursor, total, MULTISELECT_VIEWPORT_SIZE);

          const lines = [`  ${cyan('?')}  ${message}  ${hint}`];

          if (start > 0) {
            const more = `↑ ${start} more`;
            lines.push(`      ${dim(more)}`);
          }

          for (let i = start; i < end; i++) {
            const isCursor = i === cursor;

            if (loadMoreRowVisible && i === options.length) {
              lines.push(formatLoadMoreRow(isCursor, loadingMore, loadMoreError));
              continue;
            }

            const opt = options[i];
            const isSelected = selected.includes(opt.value);
            lines.push(
              formatOptionRow(opt.label, isCursor, isSelected, atCap, opt.disabled ?? false),
            );
          }

          const more = `↓ ${total - end} more`;
          if (end < total) lines.push(`      ${dim(more)}`);

          return lines.join('\n');
        },
      },
      false,
    );

    prompt.on('cursor', (dir) => {
      const total = options.length + (hasMore() ? 1 : 0);
      if (dir === 'up') cursor = Math.max(0, cursor - 1);
      else if (dir === 'down') cursor = Math.min(total - 1, cursor + 1);
      else if (dir === 'space') {
        const val = options[cursor]?.value;
        if (val !== undefined && !options[cursor]?.disabled) {
          toggleSelected(selected, val, maxSelected);
        }
      }
    });

    prompt.on('key', (_key, s) => {
      if (s.name === 'return') {
        if (loadingMore) {
          // A load is already in flight — ignore Enter entirely rather than letting it submit
          // (or start a second overlapping load) while `options` is about to be replaced.
          prompt.blockSubmit();
          return;
        }
        if (isOnLoadMoreRow() && onLoadMore) {
          prompt.blockSubmit();
          loadingMore = true;
          loadMoreError = null;
          void Promise.resolve(onLoadMore())
            .then((loaded) => {
              options = loaded;
            })
            .catch((err: unknown) => {
              // Leave `options`/`hasMore()` untouched so the row reappears and Enter retries.
              loadMoreError = err instanceof Error ? err.message : String(err);
            })
            .finally(() => {
              loadingMore = false;
              prompt.refresh();
            });
          return;
        }
        prompt.allowSubmit();
        prompt.value = [...selected];
      } else if (s.name === 'q') {
        prompt.state = 'cancel';
      }
    });

    const result = await prompt.prompt();
    if (isCancel(result)) return null;
    return (result ?? []) as T[];
  }

  async promptUntilValid(
    message: string,
    isValid: (value: string) => boolean,
    errorMessage: string,
  ): Promise<string | null> {
    for (;;) {
      const value = await this.textPrompt(message);
      if (value === null) {
        return null;
      }
      if (isValid(value)) {
        return value;
      }
      this.print(errorMessage);
    }
  }

  async pressEnterKeyPrompt(message: string): Promise<void> {
    if (process.env.CI === 'true') {
      return;
    }

    if (!process.stdin.isTTY) return;

    process.stdout.write(`  ${dim('›')}  ${message}`);

    return new Promise<void>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const onData = (chunk: Buffer): void => {
        const byte = chunk[0];
        if (byte === CTRL_C) {
          cleanup();
          process.stdout.write('\n');
          process.exit(EXIT_CODE_SIGINT);
        }
        if (byte === ENTER_CR || byte === ENTER_LF) {
          cleanup();
          process.stdout.write('\n');
          resolve();
        }
      };

      function cleanup(): void {
        process.stdin.removeListener('data', onData);
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }

      process.stdin.on('data', onData);
    });
  }

  setFormattedOutputMode(active: boolean): void {
    this.formattedOutputMode = active;
    if (!active) {
      this.collectedMessages.length = 0;
    }
  }

  isFormattedOutputMode(): boolean {
    return this.formattedOutputMode;
  }

  getMessagesForFormattedOutput(): string[] {
    return [...this.collectedMessages];
  }
}
