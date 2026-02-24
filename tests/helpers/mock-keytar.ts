/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Shared mock keytar for unit tests

import { mock } from 'bun:test';
import { clearTokenCache } from '../../src/lib/keychain.js';

export interface MockKeytarImpl {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

export interface MockKeytarHandle {
  readonly tokens: Map<string, string>;
  readonly mock: MockKeytarImpl;
  setup(): void;
  teardown(): void;
}

// Mutable implementation delegate — updated per test via setKeytarImpl()
let currentImpl: MockKeytarImpl | null = null;

// Intercept 'keytar' module for all tests that import this helper.
// The proxy delegates to currentImpl so each test can swap implementations.
mock.module('keytar', () => ({
  default: {
    getPassword: (s: string, a: string) => currentImpl?.getPassword(s, a) ?? Promise.resolve(null),
    setPassword: (s: string, a: string, p: string) => currentImpl?.setPassword(s, a, p) ?? Promise.resolve(),
    deletePassword: (s: string, a: string) => currentImpl?.deletePassword(s, a) ?? Promise.resolve(false),
    findCredentials: (s: string) => currentImpl?.findCredentials(s) ?? Promise.resolve([]),
  },
}));

/**
 * Set the active keytar implementation for the current test.
 * Pass null to deactivate (all operations become no-ops).
 * Always clears the token cache to prevent cross-test contamination.
 */
export function setKeytarImpl(impl: MockKeytarImpl | null): void {
  currentImpl = impl;
  clearTokenCache();
}

/**
 * Creates a Map-backed keytar mock that simulates the OS keychain.
 * Keys are stored as "service:account" composites, matching real keytar behavior.
 */
export function createMockKeytar(): MockKeytarHandle {
  const tokens = new Map<string, string>();

  const mockImpl: MockKeytarImpl = {
    getPassword: async (service: string, account: string) =>
      tokens.get(`${service}:${account}`) ?? null,

    setPassword: async (service: string, account: string, password: string) => {
      tokens.set(`${service}:${account}`, password);
    },

    deletePassword: async (service: string, account: string) =>
      tokens.delete(`${service}:${account}`),

    findCredentials: async (service: string) => {
      const credentials: Array<{ account: string; password: string }> = [];
      for (const [key, password] of tokens.entries()) {
        if (key.startsWith(`${service}:`)) {
          credentials.push({ account: key.slice(`${service}:`.length), password });
        }
      }
      return credentials;
    },
  };

  return {
    tokens,
    mock: mockImpl,
    setup() {
      tokens.clear();
      setKeytarImpl(mockImpl);
    },
    teardown() {
      tokens.clear();
      setKeytarImpl(null);
    },
  };
}
