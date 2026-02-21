// Shared mock keytar for unit tests

import { setMockKeytar, clearTokenCache } from '../../src/lib/keychain.js';

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

/**
 * Creates a Map-backed keytar mock that simulates the OS keychain.
 * Keys are stored as "service:account" composites, matching real keytar behavior.
 */
export function createMockKeytar(): MockKeytarHandle {
  const tokens = new Map<string, string>();

  const mock = {
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
    mock,
    setup() {
      tokens.clear();
      clearTokenCache();
      setMockKeytar(mock);
    },
    teardown() {
      setMockKeytar(null);
      tokens.clear();
      clearTokenCache();
    },
  };
}
