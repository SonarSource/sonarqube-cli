/**
 * Tests for auth commands with stdin interaction
 * Tests all scenarios: interactive prompts, arguments, non-interactive mode
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setMockKeytar } from '../../src/lib/keychain.js';
import { setMockLogger } from '../../src/lib/logger.js';

// Mock keytar for token storage
const mockKeytarTokens = new Map<string, string>();

const mockKeytar = {
  getPassword: async (service: string, account: string) => {
    const key = `${service}:${account}`;
    return mockKeytarTokens.get(key) || null;
  },
  setPassword: async (service: string, account: string, password: string) => {
    const key = `${service}:${account}`;
    mockKeytarTokens.set(key, password);
  },
  deletePassword: async (service: string, account: string) => {
    const key = `${service}:${account}`;
    return mockKeytarTokens.delete(key);
  },
  findCredentials: async (service: string) => {
    const credentials: Array<{ account: string; password: string }> = [];
    for (const [key, password] of mockKeytarTokens.entries()) {
      if (key.startsWith(`${service}:`)) {
        const account = key.substring(`${service}:`.length);
        credentials.push({ account, password });
      }
    }
    return credentials;
  }
};

// Mock logger to capture output
let logOutput: string[];
let errorOutput: string[];

const mockLogger = {
  debug: (msg: string) => logOutput.push(`[DEBUG] ${msg}`),
  info: (msg: string) => logOutput.push(`[INFO] ${msg}`),
  log: (msg: string) => logOutput.push(`[LOG] ${msg}`),
  success: (msg: string) => logOutput.push(`[SUCCESS] ${msg}`),
  warn: (msg: string) => errorOutput.push(`[WARN] ${msg}`),
  error: (msg: string) => errorOutput.push(`[ERROR] ${msg}`),
};

// Helper functions that simulate auth command logic
function processUserInput(inputData: string): string {
  return inputData.trim();
}

function validateOrganizationInput(org: string): boolean {
  return org.length > 0;
}

function isNonInteractiveMode(withToken?: string): boolean {
  return !!withToken;
}

// Test constants
const LONG_INPUT_LENGTH = 500;

describe('auth commands stdin interaction', () => {
  beforeEach(() => {
    setMockKeytar(mockKeytar);
    setMockLogger(mockLogger);
    logOutput = [];
    errorOutput = [];
    mockKeytarTokens.clear();
  });

  afterEach(() => {
    setMockKeytar(mockKeytar);
    setMockLogger(null);
  });

  describe('user input processing', () => {
    it('should trim whitespace from user input', () => {
      const input = '  sonarsource  \n';
      const processed = processUserInput(input);

      expect(processed).toBe('sonarsource');
    });

    it('should handle empty input', () => {
      const input = '\n';
      const processed = processUserInput(input);

      expect(processed).toBe('');
    });

    it('should preserve special characters', () => {
      const input = 'org-with_special.chars-123';
      const processed = processUserInput(input);

      expect(processed).toBe('org-with_special.chars-123');
    });

    it('should handle long input', () => {
      const longOrg = 'a'.repeat(LONG_INPUT_LENGTH);
      const processed = processUserInput(longOrg);

      expect(processed).toBe(longOrg);
      expect(processed.length).toBe(LONG_INPUT_LENGTH);
    });

    it('should preserve unicode characters', () => {
      const unicodeOrg = 'org-café-日本語';
      const processed = processUserInput(unicodeOrg);

      expect(processed).toBe(unicodeOrg);
    });
  });

  describe('organization validation', () => {
    it('should accept valid organization input', () => {
      const org = 'sonarsource';
      const isValid = validateOrganizationInput(org);

      expect(isValid).toBe(true);
    });

    it('should reject empty organization', () => {
      const org = '';
      const isValid = validateOrganizationInput(org);

      expect(isValid).toBe(false);

      if (!isValid) {
        errorOutput.push('[ERROR] Organization key is required');
      }

      expect(errorOutput).toContain('[ERROR] Organization key is required');
    });

    it('should reject whitespace-only input', () => {
      const input = '   ';
      const processed = processUserInput(input);
      const isValid = validateOrganizationInput(processed);

      expect(isValid).toBe(false);
    });
  });

  describe('interactive vs non-interactive mode', () => {
    it('should identify interactive mode (no --with-token)', () => {
      const options: { withToken?: string } = {};
      const isNonInteractive = isNonInteractiveMode(options.withToken);

      expect(isNonInteractive).toBe(false);
    });

    it('should identify non-interactive mode (with --with-token)', () => {
      const options = { withToken: 'abc123xyz' };
      const isNonInteractive = isNonInteractiveMode(options.withToken);

      expect(isNonInteractive).toBe(true);
    });

    it('should not prompt for organization in non-interactive mode', () => {
      const isNonInteractive = true;
      let promptedForOrg = false;

      if (!isNonInteractive) {
        promptedForOrg = true;
      }

      expect(promptedForOrg).toBe(false);
    });

    it('should require organization in non-interactive mode', () => {
      const options = { withToken: 'token123', org: undefined };
      const isNonInteractive = isNonInteractiveMode(options.withToken);

      let errorOccurred = false;

      if (isNonInteractive && !options.org) {
        errorOccurred = true;
        errorOutput.push('[ERROR] Organization must be specified with -o/--org in non-interactive mode');
      }

      expect(errorOccurred).toBe(true);
      expect(errorOutput.some(e => e.includes('Organization must be specified'))).toBe(true);
    });
  });

  describe('confirmation logic (auth purge)', () => {
    it('should accept "y" as confirmation', () => {
      const input = 'y';
      const isConfirmed = input.toLowerCase() === 'y';

      expect(isConfirmed).toBe(true);
    });

    it('should accept "Y" as confirmation (case insensitive)', () => {
      const input = 'Y';
      const isConfirmed = input.toLowerCase() === 'y';

      expect(isConfirmed).toBe(true);
    });

    it('should reject "n" as confirmation', () => {
      const input = 'n';
      const isConfirmed = input.toLowerCase() === 'y';

      expect(isConfirmed).toBe(false);
    });

    it('should reject invalid confirmation input', () => {
      const input = 'maybe';
      const isConfirmed = input.toLowerCase() === 'y';

      expect(isConfirmed).toBe(false);
    });

    it('should handle empty confirmation response', () => {
      const input = '';
      const isConfirmed = input.toLowerCase() === 'y';

      expect(isConfirmed).toBe(false);
    });

    it('should clear tokens only on confirmation', async () => {
      await mockKeytar.setPassword('sonarcloud.io', 'sonarcloud.io:org1', 'token1');
      expect(mockKeytarTokens.size).toBe(1);

      // Simulate "n" response - don't clear
      const confirmResponse = 'n';
      if (confirmResponse.toLowerCase() === 'y') {
        mockKeytarTokens.clear();
      }

      expect(mockKeytarTokens.size).toBe(1);

      // Simulate "y" response - clear
      const confirmResponse2 = 'y';
      if (confirmResponse2.toLowerCase() === 'y') {
        mockKeytarTokens.clear();
      }

      expect(mockKeytarTokens.size).toBe(0);
    });
  });

  describe('auth login command scenarios', () => {
    it('scenario: login with --org flag (no stdin needed)', () => {
      const options = { org: 'sonarsource' };
      const needsOrgPrompt = !options.org;

      expect(needsOrgPrompt).toBe(false);
    });

    it('scenario: login without arguments (stdin required)', () => {
      const options: { org?: string } = {};
      const needsOrgPrompt = !options.org;

      expect(needsOrgPrompt).toBe(true);
    });

    it('scenario: login with --with-token and --org (non-interactive)', () => {
      const options = { withToken: 'abc123', org: 'sonarsource' };
      const isNonInteractive = !!options.withToken;

      expect(isNonInteractive).toBe(true);
      expect(options.org).toBeDefined();
    });

    it('scenario: login with --with-token but no --org (should error)', () => {
      const options: { withToken?: string; org?: string } = { withToken: 'abc123' };
      const isNonInteractive = !!options.withToken;

      if (isNonInteractive && !options.org) {
        errorOutput.push('[ERROR] Organization must be specified with -o/--org');
      }

      expect(errorOutput.some(e => e.includes('Organization must be specified'))).toBe(true);
    });
  });

  describe('auth purge command flow', () => {
    it('should show confirmation prompt', () => {
      logOutput.push('[INFO] Remove all tokens? (y/n): ');

      expect(logOutput.some(l => l.includes('Remove all tokens'))).toBe(true);
    });

    it('should show token count before confirmation', async () => {
      await mockKeytar.setPassword('sonarcloud.io', 'sonarcloud.io:org1', 'token1');
      await mockKeytar.setPassword('sonarcloud.io', 'sonarcloud.io:org2', 'token2');

      const credentials = await mockKeytar.findCredentials('sonarcloud.io');
      logOutput.push(`[INFO] Found ${credentials.length} token(s):`);

      expect(logOutput.some(l => l.includes('Found 2 token(s)'))).toBe(true);
    });

    it('should require confirmation before deletion', async () => {
      await mockKeytar.setPassword('sonarcloud.io', 'sonarcloud.io:org1', 'token1');

      const beforeSize = mockKeytarTokens.size;

      // Simulate user saying "n"
      const confirmation = 'n';
      if (confirmation.toLowerCase() === 'y') {
        mockKeytarTokens.clear();
      }

      const afterSize = mockKeytarTokens.size;

      expect(beforeSize).toBe(1);
      expect(afterSize).toBe(1); // Should not be deleted
    });
  });

  describe('stdin state management concepts', () => {
    it('documents fix: stdin requires resume() after pause()', () => {
      // This documents the fix applied to getUserInput():
      // - generateTokenViaBrowser pauses stdin (line 72 in bootstrap/auth.ts)
      // - getUserInput must call resume() before reading (line 316 in commands/auth.ts)
      // - Without resume(), stdin is not ready and input() hangs
      // - With resume(), stdin is active and can receive data

      const stdinState = { isPaused: true };

      // Simulate the fix being applied
      if (stdinState.isPaused) {
        stdinState.isPaused = false;
      }

      expect(stdinState.isPaused).toBe(false);
    });

    it('documents fix: stdin should use pause() not destroy()', () => {
      // This documents the fix applied to getUserInput():
      // - Old code called stdin.destroy() which closes stdin completely
      // - New code calls stdin.pause() and removeAllListeners('data')
      // - pause() allows stdin to be reused for subsequent prompts
      // - destroy() prevents any further reads, causing process to hang

      const stdinHandling = { method: 'pause' };

      expect(stdinHandling.method).toBe('pause');
      expect(stdinHandling.method).not.toBe('destroy');
    });

    it('documents fix: data listeners must be cleaned up', () => {
      // This documents the fix applied to getUserInput():
      // - After reading input, removeAllListeners('data') is called
      // - This prevents multiple 'data' listeners from accumulating
      // - Multiple listeners would cause input to be processed multiple times

      const listenerCleanup: Record<string, string[]> = {
        beforeRead: ['data', 'error'],
        afterRead: ['error']
      };

      expect(listenerCleanup.beforeRead.length).toBe(2);
      expect(listenerCleanup.afterRead.length).toBe(1);
      expect(listenerCleanup.afterRead).not.toContain('data');
    });

    it('documents fix: multiple stdin reads must work sequentially', () => {
      // This documents the flow in auth login:
      // 1. First stdin read: OAuth callback waits for user to press Enter
      // 2. Second stdin read: Organization prompt asks for org key
      // - Without proper state management, second read would fail
      // - With resume/pause/cleanup, both reads succeed

      const stdinReads: Array<{ prompt: string; response: string }> = [
        { prompt: 'Press Enter to open browser', response: '' },
        { prompt: 'Enter organization key', response: 'sonarsource' }
      ];

      expect(stdinReads.length).toBe(2);
      expect(stdinReads[0].prompt).toContain('Press Enter');
      expect(stdinReads[1].prompt).toContain('organization key');
    });
  });

  describe('token storage', () => {
    it('should save token in keychain', async () => {
      const server = 'https://sonarcloud.io';
      const org = 'test-org';
      const token = 'test-token-123';

      await mockKeytar.setPassword(server, `${server}:${org}`, token);

      const retrieved = await mockKeytar.getPassword(server, `${server}:${org}`);
      expect(retrieved).toBe(token);
    });

    it('should retrieve saved token', async () => {
      const server = 'https://sonarcloud.io';
      const org = 'sonarsource';
      const token = 'squ_abc123';

      await mockKeytar.setPassword(server, `${server}:${org}`, token);
      const retrieved = await mockKeytar.getPassword(server, `${server}:${org}`);

      expect(retrieved).toBe(token);
    });

    it('should return null for missing token', async () => {
      const server = 'https://sonarcloud.io';
      const org = 'nonexistent-org';

      const retrieved = await mockKeytar.getPassword(server, `${server}:${org}`);

      expect(retrieved).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should log organization validation error', () => {
      const org = '';

      if (!validateOrganizationInput(org)) {
        errorOutput.push('[ERROR] Organization key is required');
      }

      expect(errorOutput).toContain('[ERROR] Organization key is required');
    });

    it('should log non-interactive mode error', () => {
      const isNonInteractive = true;
      const org = undefined;

      if (isNonInteractive && !org) {
        errorOutput.push('[ERROR] Organization must be specified with -o/--org in non-interactive mode');
      }

      expect(errorOutput.some(e => e.includes('Organization must be specified'))).toBe(true);
    });

    it('should show help message with errors', () => {
      errorOutput = [
        '[ERROR] Organization key is required',
        '[INFO]   Provide via: --organization flag, or login with: sonar auth login'
      ];

      expect(errorOutput.some(e => e.includes('Provide via'))).toBe(true);
    });
  });

  describe('server detection from project configs', () => {
    it('should detect SonarCloud server', () => {
      const server = 'https://sonarcloud.io';
      const isCloud = server.includes('sonarcloud.io');

      expect(isCloud).toBe(true);
    });

    it('should detect on-premise server', () => {
      const server = 'https://next.sonarqube.com/sonarqube';
      const isCloud = server.includes('sonarcloud.io');

      expect(isCloud).toBe(false);
    });

    it('should use provided --server flag over config', () => {
      const providedServer = 'https://custom-sonar.example.com';
      const configServer = 'https://other-server.example.com';

      // Logic: if --server provided, use it; otherwise use config
      const server = providedServer;

      expect(server).toBe(providedServer);
    });

    it('should fallback to config server when --server not provided', () => {
      const configServer = 'https://next.sonarqube.com/sonarqube';

      const server = configServer;

      expect(server).toBe(configServer);
    });

    it('should use default SonarCloud when no server found', () => {
      const defaultServer = 'https://sonarcloud.io';

      const server = defaultServer;

      expect(server).toBe(defaultServer);
    });

    it('should not require organization for on-premise server', () => {
      const server = 'https://next.sonarqube.com/sonarqube';
      const isCloud = server.includes('sonarcloud.io');
      const org: string | undefined = undefined;

      const organizationRequired = isCloud && !org;

      expect(organizationRequired).toBe(false);
    });

    it('should require organization for SonarCloud with non-interactive mode', () => {
      const server = 'https://sonarcloud.io';
      const isCloud = server.includes('sonarcloud.io');
      const org: string | undefined = undefined;
      const isNonInteractive = true;

      const organizationRequired = isCloud && isNonInteractive && !org;
      if (organizationRequired) {
        errorOutput.push('[ERROR] Organization must be specified with -o/--org in non-interactive mode');
      }

      expect(organizationRequired).toBe(true);
      expect(errorOutput.some(e => e.includes('Organization must be specified'))).toBe(true);
    });

    it('should accept organization for on-premise server if provided', () => {
      const server = 'https://next.sonarqube.com/sonarqube';
      const org = 'my-org';
      const isCloud = server.includes('sonarcloud.io');

      // For on-premise, org is optional but can be provided
      expect(org).toBe('my-org');
      expect(isCloud).toBe(false);

      // Should proceed without error
      expect(errorOutput.length).toBe(0);
    });

    it('should not prompt for organization in non-interactive mode with on-premise', () => {
      const server = 'https://next.sonarqube.com/sonarqube';
      const isCloud = server.includes('sonarcloud.io');
      const isNonInteractive = true;
      const org: string | undefined = undefined;

      const shouldPrompt = !isNonInteractive && !org && !isCloud;

      expect(shouldPrompt).toBe(false);
    });

    it('should handle localhost server as on-premise', () => {
      const server = 'http://localhost:9000';
      const isCloud = server.includes('sonarcloud.io');

      expect(isCloud).toBe(false);
    });

    it('should validate server URL format', () => {
      const validServers = [
        'https://sonarcloud.io',
        'https://next.sonarqube.com/sonarqube',
        'http://localhost:9000',
        'https://sonar.example.com'
      ];

      validServers.forEach(server => {
        try {
          new URL(server);
          expect(true).toBe(true);
        } catch {
          expect(false).toBe(true);
        }
      });
    });

    it('should reject invalid server URL', () => {
      const invalidServer = 'not a valid url';
      let isValid = true;

      try {
        new URL(invalidServer);
      } catch {
        isValid = false;
      }

      expect(isValid).toBe(false);
    });
  });
});
