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

import { afterEach, describe, expect, it, spyOn } from 'bun:test';

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import * as keychain from '@/core/host/keychain.ts';
import { clearSecretCache, MissingKeychainError } from '@/core/host/keychain.ts';
import { configureLogger, setMockLogger } from '@/core/observability/logger.ts';
import * as projectInfo from '@/core/project-discovery/project-info.ts';

import {
  derivePassthroughSubcommand,
  runContextPassthrough,
} from '../../../../src/commands/context';

afterEach(() => {
  spyOn(keychain, 'getToken').mockRestore();
  spyOn(projectInfo, 'discoverWorkspace').mockRestore();
  setMockLogger(null);
  configureLogger({ level: 'INFO' });
});

describe('derivePassthroughSubcommand', () => {
  it('returns null when no action and no args (bare `sonar context`)', () => {
    expect(derivePassthroughSubcommand(undefined, [])).toBeNull();
  });

  it('returns the action when only an action is provided', () => {
    expect(derivePassthroughSubcommand('status', [])).toBe('status');
  });

  it('joins leading positional args with the action', () => {
    expect(derivePassthroughSubcommand('tool', ['stop'])).toBe('tool stop');
  });

  it('stops at the first flag and never captures option values', () => {
    expect(derivePassthroughSubcommand('tool', ['stop', '--all'])).toBe('tool stop');
    expect(derivePassthroughSubcommand('get-source', ['--file', 'secret.ts', '--line', '42'])).toBe(
      'get-source',
    );
  });

  it('also stops at short flags', () => {
    expect(derivePassthroughSubcommand('get-source', ['-f', 'secret.ts'])).toBe('get-source');
  });

  it('maps --help / -h to "help"', () => {
    expect(derivePassthroughSubcommand('--help', [])).toBe('help');
    expect(derivePassthroughSubcommand('-h', [])).toBe('help');
    expect(derivePassthroughSubcommand(undefined, ['--help'])).toBe('help');
    expect(derivePassthroughSubcommand(undefined, ['-h'])).toBe('help');
  });

  it('returns null when only option flags are passed without any positional', () => {
    expect(derivePassthroughSubcommand(undefined, ['--debug'])).toBeNull();
  });

  it('collapses internal whitespace inside a quoted token', () => {
    expect(derivePassthroughSubcommand('tool  stop', [])).toBe('tool stop');
  });

  it('drops empty-string tokens instead of producing double spaces', () => {
    expect(derivePassthroughSubcommand('tool', ['', 'stop'])).toBe('tool stop');
  });

  it('returns null when all positional tokens are empty / whitespace', () => {
    expect(derivePassthroughSubcommand('', ['   '])).toBeNull();
  });
});

describe('runContextPassthrough', () => {
  async function runWithBunSecretsFailure(message: string): Promise<CommandFailedError> {
    const savedKeychainFile = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    clearSecretCache();
    spyOn(projectInfo, 'discoverWorkspace').mockResolvedValue({
      kind: 'project',
      project: {
        organization: 'recorded-org',
        projectKey: 'project-key',
        projectRoot: process.cwd(),
        serverUrl: 'https://regional.sonarcloud.io',
      },
    });
    const getSpy = spyOn(Bun.secrets, 'get').mockRejectedValue(new Error(message));
    const ctx = {
      console: {},
      resolveAuth: () =>
        Promise.resolve({
          isErr: () => false,
          value: {
            orgKey: 'environment-org',
            serverUrl: 'https://regional.sonarcloud.io',
            token: 'environment-token',
          },
        }),
    } as unknown as CommandInvocationContext;

    try {
      const caught = await runContextPassthrough('__hook', ['Claude'], {
        stdinPayload: '{}',
        ctx,
      }).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(caught).toBeInstanceOf(CommandFailedError);
      return caught as CommandFailedError;
    } finally {
      getSpy.mockRestore();
      if (savedKeychainFile === undefined) {
        delete process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
      } else {
        process.env.SONARQUBE_CLI_KEYCHAIN_FILE = savedKeychainFile;
      }
      clearSecretCache();
    }
  }

  it('propagates keychain access failures with repair advice', async () => {
    const error = await runWithBunSecretsFailure('keychain locked');
    expect(error.message).toContain('keychain locked');
    expect(error.message).not.toContain('Not authenticated for the recorded');
    expect(error.remediationHint).toContain('unlocked');
  });

  if (process.platform === 'linux') {
    it('uses recorded-connection advice when libsecret cannot be loaded', async () => {
      const error = await runWithBunSecretsFailure('libsecret not available');
      expect(error.message).toContain(
        'Not authenticated for the recorded Vortex Context connection',
      );
      expect(error.remediationHint).toContain('Install or repair libsecret');
      expect(error.remediationHint).toContain('SONARQUBE_CLI_TOKEN');
      expect(error.remediationHint).toContain(
        'SONARQUBE_CLI_SERVER=https://regional.sonarcloud.io',
      );
    });
  }

  it('uses the recorded-connection error when the keychain is unavailable', async () => {
    const debugMessages: string[] = [];
    configureLogger({ level: 'DEBUG' });
    setMockLogger({
      debug: (message) => debugMessages.push(message),
      error: () => {},
      info: () => {},
      log: () => {},
      success: () => {},
      warn: () => {},
    });
    spyOn(projectInfo, 'discoverWorkspace').mockResolvedValue({
      kind: 'project',
      project: {
        organization: 'recorded-org',
        projectKey: 'project-key',
        projectRoot: process.cwd(),
        serverUrl: 'https://regional.sonarcloud.io',
      },
    });
    spyOn(keychain, 'getToken').mockRejectedValue(
      new MissingKeychainError('libsecret not available'),
    );
    const ctx = {
      console: {},
      resolveAuth: () =>
        Promise.resolve({
          isErr: () => false,
          value: {
            orgKey: 'environment-org',
            serverUrl: 'https://regional.sonarcloud.io',
            token: 'environment-token',
          },
        }),
    } as unknown as CommandInvocationContext;

    const error = await runContextPassthrough('__hook', ['Claude'], {
      stdinPayload: '{}',
      ctx,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as Error).message).toContain(
      'Not authenticated for the recorded Vortex Context connection',
    );
    expect(debugMessages).toHaveLength(1);
    expect(debugMessages[0]).toContain(
      'Keychain lookup failed for https://regional.sonarcloud.io: No usable system keychain is available: libsecret could not be loaded.',
    );
    const hint = (error as CommandFailedError).remediationHint ?? '';
    expect(hint).toContain('SONARQUBE_CLI_TOKEN');
    expect(hint).toContain('SONARQUBE_CLI_SERVER=https://regional.sonarcloud.io');
    expect(hint).toContain('SONARQUBE_CLI_ORG=recorded-org');
    expect(hint).toContain('SONARQUBE_CLI_ORG');
    expect(hint).not.toContain('sonar auth login');
  });

  it('still recommends logging in when the keychain works and holds no token', async () => {
    spyOn(projectInfo, 'discoverWorkspace').mockResolvedValue({
      kind: 'project',
      project: {
        organization: 'recorded-org',
        projectKey: 'project-key',
        projectRoot: process.cwd(),
        serverUrl: 'https://regional.sonarcloud.io',
      },
    });
    spyOn(keychain, 'getToken').mockResolvedValue(null);
    const ctx = {
      console: {},
      resolveAuth: () =>
        Promise.resolve({
          isErr: () => false,
          value: {
            orgKey: 'environment-org',
            serverUrl: 'https://regional.sonarcloud.io',
            token: 'environment-token',
          },
        }),
    } as unknown as CommandInvocationContext;

    const error = await runContextPassthrough('__hook', ['Claude'], {
      stdinPayload: '{}',
      ctx,
    }).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(CommandFailedError);
    expect((error as CommandFailedError).remediationHint).toContain('sonar auth login');
  });
});
