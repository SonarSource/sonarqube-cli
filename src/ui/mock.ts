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

// Test mock utilities for the UI module

export interface UiCall {
  method: string;
  args: unknown[];
}

export type UiMethod =
  | 'blank'
  | 'discreetSuccess'
  | 'error'
  | 'info'
  | 'print'
  | 'success'
  | 'text'
  | 'warn';

let mockActive = false;
const calls: UiCall[] = [];
const responseQueue: unknown[] = [];

export function setMockUi(active: boolean): void {
  mockActive = active;
  if (!active) {
    calls.length = 0;
    responseQueue.length = 0;
  }
}

export function isMockActive(): boolean {
  return mockActive;
}

export function recordCall(method: string, ...args: unknown[]): void {
  calls.push({ method, args });
}

export function getMockUiCalls(): UiCall[] {
  return [...calls];
}

export function clearMockUiCalls(): void {
  calls.length = 0;
}

/**
 * Find the first recorded UI call of `method` whose first argument (the
 * message text) contains `substring`. Returns `undefined` when no match is
 * found, which pairs naturally with `expect(...).toBeDefined()` /
 * `expect(...).toBeUndefined()` assertions in tests.
 */
export function findMockUiCall(method: UiMethod, substring: string): UiCall | undefined {
  return calls.find(
    (c) => c.method === method && typeof c.args[0] === 'string' && c.args[0].includes(substring),
  );
}

/**
 * Queue a response value for the next prompt call (textPrompt / confirmPrompt).
 * Values are consumed in order.
 */
export function queueMockResponse(value: unknown): void {
  responseQueue.push(value);
}

/**
 * Dequeue the next queued response, or return fallback if queue is empty.
 */
export function dequeueMockResponse<T>(fallback: T): T {
  if (responseQueue.length > 0) {
    return responseQueue.shift() as T;
  }
  return fallback;
}

export function clearMockResponses(): void {
  responseQueue.length = 0;
}
