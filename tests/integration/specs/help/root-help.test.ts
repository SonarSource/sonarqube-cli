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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { version as VERSION } from '../../../../package.json';
import { TestHarness } from '../../harness';

const ANSI_ESCAPE_CODES = /\x1b\[[0-9;]*m/g;
const BANNER_ART = [
  '  █▀ █▀█ █▄ █ ▄▀█ █▀█ █▀█ █ █ █▄▄ █▀▀   ▄█▀ █   █',
  '  ▄█ █▄█ █ ▀█ █▀█ █▀▄ ▀▀█ █▄█ █▄█ ██▄   ▀█▄ ██▄ █',
] as const;

function stripAnsi(stdout: string): string {
  return stdout.replaceAll(ANSI_ESCAPE_CODES, '');
}

function getExpectedRootHelp(): string {
  return [
    ...BANNER_ART,
    `  v${VERSION}`,
    '',
    '  SonarQube CLI helps you detect security vulnerabilities',
    '  and code quality issues directly from your terminal.',
    '',
    '  QUICKSTART',
    '    1. Run sonar auth login to authenticate with SonarQube',
    '    2. Run sonar analyze --file <file> to scan your code for issues',
    '',
    '  COMMANDS',
    '    analyze                                                  Analyze code for quality and security issues',
    '    analyze secrets                                          Scan files or stdin for hardcoded secrets',
    '    analyze dependency-risks                                 Analyze project dependencies for security and license risks',
    '    analyze agentic                                          Run server-side agentic analysis (SonarQube Cloud only). Limitations apply.',
    '    remediate                                                Trigger AI agent remediation for eligible issues (SonarQube Cloud only)',
    '',
    '    list <issues|projects>                                   List issues and projects from SonarQube Cloud or Server',
    '    api <method> <endpoint>                                  Make authenticated API requests to SonarQube',
    '    context [action] [args...]                               Augment AI agents with context from your codebase (beta: subject to change)',
    '',
    '    integrate <git|claude|copilot|codex|antigravity|cursor>  Setup SonarQube integration for AI coding agents, git and others.',
    '',
    '    auth <login|logout|status>                               Manage authentication tokens and credentials',
    '    config <telemetry>                                       Configure CLI settings',
    '    system <status|reset>                                    System diagnostics and maintenance commands for the SonarQube CLI installation.',
    '    update                                                   Update SonarQube CLI to the latest version',
    '',
    '  OPTIONS',
    '    -h, --help     Display help for a specific command',
    '    -v, --version  Show current version',
    '',
    '  Read documentation: https://sonarsource.com/sonarqube/cli',
    '  Share feedback:     https://forms.gle/jrGic3awT5t5vf7V9',
    '',
  ].join('\n');
}

describe('root help', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'sonar shows the exact custom help screen',
    async () => {
      const result = await harness.run('');
      expect(result.exitCode).toBe(0);
      expect(stripAnsi(result.stdout)).toBe(getExpectedRootHelp());
    },
    { timeout: 15000 },
  );

  it(
    'sonar and sonar -h render the same root help output',
    async () => {
      const [bareResult, helpResult] = await Promise.all([harness.run(''), harness.run('-h')]);
      expect(bareResult.exitCode).toBe(0);
      expect(helpResult.exitCode).toBe(0);
      expect(stripAnsi(bareResult.stdout)).toBe(getExpectedRootHelp());
      expect(stripAnsi(helpResult.stdout)).toBe(getExpectedRootHelp());
    },
    { timeout: 15000 },
  );

  it(
    'sonar <unknown> reports an unknown command instead of an argument-count error',
    async () => {
      const result = await harness.run('totally-unknown-command');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain("unknown command 'totally-unknown-command'");
      expect(result.stdout + result.stderr).toContain(
        "Run 'sonar --help' to see the list of available commands.",
      );
      expect(result.stdout + result.stderr).not.toContain('Expected 0 arguments');
    },
    { timeout: 15000 },
  );

  it(
    'sonar auth -h shows subcommand help without hanging',
    async () => {
      const result = await harness.run('auth -h');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: sonar auth');
      expect(result.stdout).toContain('login');
      expect(result.stdout).toContain('logout');
    },
    { timeout: 15000 },
  );
});
