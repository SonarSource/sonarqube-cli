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

import type { PatStatus } from './pat-status.ts';

export const DEFAULT_PAT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_PAT_WAIT_TIMEOUT_MS = 300_000;

export type WaitForPatResult = 'valid' | 'invalid' | 'timeout' | 'aborted';

export interface WaitForPatOptions {
  check: () => Promise<PatStatus>;
  /** The status that sent the user to the browser. */
  initial: Exclude<PatStatus, 'valid'>;
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Must resolve early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

const ABORTED = Symbol('aborted');
const TIMED_OUT = Symbol('timed-out');

/**
 * Polls `check` until the user has connected a usable token in the web UI. Errors thrown by
 * `check` propagate unchanged. When the wait started from `missing`, a later `invalid` means the
 * user connected a bad token and the wait stops; when it started from `invalid`, `invalid` is
 * the stale token and the wait continues.
 *
 * Both the abort signal and the deadline apply to a check in flight too: the wait ends as soon as
 * either happens, and whatever that check answers afterwards is ignored.
 */
export async function waitForPat(options: WaitForPatOptions): Promise<WaitForPatResult> {
  const {
    check,
    initial,
    intervalMs = DEFAULT_PAT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_PAT_WAIT_TIMEOUT_MS,
    signal,
    sleep = abortableSleep,
    now = Date.now,
  } = options;
  const deadline = now() + timeoutMs;
  const stopped = () => stopReason(signal, deadline, now);

  const poll = async (): Promise<WaitForPatResult> => {
    const before = stopped();
    if (before) return before;
    await sleep(Math.min(intervalMs, deadline - now()), signal);
    const afterSleep = stopped();
    if (afterSleep) return afterSleep;
    const status = await settleBeforeEnd(check(), signal, deadline - now());
    return stopped() ?? outcomeOf(status, initial) ?? poll();
  };
  return poll();
}

function stopReason(
  signal: AbortSignal | undefined,
  deadline: number,
  now: () => number,
): 'aborted' | 'timeout' | undefined {
  if (signal?.aborted) return 'aborted';
  if (now() >= deadline) return 'timeout';
  return undefined;
}

/** `undefined` means the wait goes on. */
function outcomeOf(
  status: PatStatus | typeof ABORTED | typeof TIMED_OUT,
  initial: WaitForPatOptions['initial'],
): WaitForPatResult | undefined {
  if (status === ABORTED) return 'aborted';
  if (status === TIMED_OUT) return 'timeout';
  if (status === 'valid') return 'valid';
  if (status === 'invalid' && initial === 'missing') return 'invalid';
  return undefined;
}

/** Settles like `pending`, or early when `signal` aborts or `timeoutMs` elapses. */
async function settleBeforeEnd<T>(
  pending: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T | typeof ABORTED | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const ended = new Promise<typeof ABORTED | typeof TIMED_OUT>((resolve) => {
    onAbort = () => {
      resolve(ABORTED);
    };
    timer = setTimeout(
      () => {
        resolve(TIMED_OUT);
      },
      Math.max(timeoutMs, 0),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([pending, ended]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
