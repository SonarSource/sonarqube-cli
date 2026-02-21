// Test mock utilities for the UI module

export interface UiCall {
  method: string;
  args: unknown[];
}

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
