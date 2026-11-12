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
    '    2. Run sonar integrate to connect SonarQube to your AI agent or Git',
    '',
    '  SETUP',
    '    auth <command>               Manage authentication',
    '      login, org, logout, status',
    '    link <project-key>           Link this directory to a project',
    '    import                       [BETA] Import repos from your DevOps platform',
    '    integrate [target]           Set up SonarQube with AI coding agents or Git',
    '      git, claude, copilot, codex, antigravity, cursor, opencode, devin, pi',
    '',
    '  GUIDE',
    '    context [action] [args...]   Give agents codebase context [Vortex]',
    "    architecture|arch <command>  Read and set a project's architecture",
    '      current, intended, install-skill',
    '',
    '  VERIFY',
    '    analyze                      Run secrets scan and Vortex analysis',
    '    analyze secrets              Find hardcoded secrets',
    '    analyze dependency-risks     Find dependency and license risks',
    '    analyze agentic              Run server-side analysis [Vortex]',
    "    quality-gate|qg              Check a project's quality gate",
    '    list (issues|projects|orgs)  Find issues, projects and orgs',
    '    api <method> <endpoint>      Call the SonarQube API',
    '    allowlist secrets <command>  Mark known-safe secrets as allowed',
    '      show, add, remove, clear',
    '',
    '  SOLVE',
    '    remediate                    Send issues to Remediation Agent [Cloud only]',
    '',
    '  CLI',
    '    config (get|list|set|unset)  Configure CLI settings',
    '    system (status|reset)        Inspect or reset the CLI',
    '    update [status]              Update CLI to latest version',
    '',
    '  OPTIONS',
    '    -h, --help                   Display help',
    '    -v, --version                Show current version',
    '',
    '  Run sonar <command> --help for options and examples.',
    '',
    '  Docs      https://sonarsource.com/sonarqube/cli',
    '  Feedback  https://forms.gle/jrGic3awT5t5vf7V9',
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
      const result = await harness.run('', { extraEnv: { COLUMNS: '80' } });
      expect(result.exitCode).toBe(0);
      expect(stripAnsi(result.stdout)).toBe(getExpectedRootHelp());
    },
    { timeout: 15000 },
  );

  it(
    'sonar and sonar -h render the same root help output',
    async () => {
      const [bareResult, helpResult] = await Promise.all([
        harness.run('', { extraEnv: { COLUMNS: '80' } }),
        harness.run('-h', { extraEnv: { COLUMNS: '80' } }),
      ]);
      expect(bareResult.exitCode).toBe(0);
      expect(helpResult.exitCode).toBe(0);
      expect(stripAnsi(bareResult.stdout)).toBe(getExpectedRootHelp());
      expect(stripAnsi(helpResult.stdout)).toBe(getExpectedRootHelp());
    },
    { timeout: 15000 },
  );

  it.each([60, 72, 80, 100, 140])(
    'fits display columns at width %s',
    async (columns) => {
      const result = await harness.run('--help', { extraEnv: { COLUMNS: String(columns) } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toMatch(ANSI_ESCAPE_CODES);
      for (const line of result.stdout.split('\n')) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(Math.min(columns, 100));
      }
      expect(result.stdout).toContain('[Cloud only]');
      expect(result.stdout.match(/\[Vortex\]/g)).toHaveLength(2);
      expect(result.stdout.indexOf('SETUP')).toBeLessThan(result.stdout.indexOf('GUIDE'));
      expect(result.stdout).not.toContain('targets:');
      expect(result.stdout).not.toContain('·');
      if (columns >= 80)
        expect(result.stdout).toContain(
          '      git, claude, copilot, codex, antigravity, cursor, opencode, devin, pi\n',
        );
    },
    { timeout: 15000 },
  );

  it.each(Array.from({ length: 41 }, (_, index) => 60 + index))(
    'keeps at least two names on the last targets line at width %s',
    async (columns) => {
      const result = await harness.run('--help', { extraEnv: { COLUMNS: String(columns) } });
      expect(result.exitCode).toBe(0);
      const targetLines = result.stdout.split('\n').filter((line) => /^ {6}\S/.test(line));
      expect(targetLines.length).toBeGreaterThanOrEqual(4);
      for (const line of targetLines) expect(line).toContain(',');
    },
    { timeout: 15000 },
  );

  it.skipIf(process.platform === 'win32')(
    'uses the specified styles on a real terminal',
    async () => {
      const result = await harness.runWithRealTty('--help', {
        extraEnv: { COLUMNS: '80', FORCE_COLOR: '1', TERM: 'xterm-256color' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('\x1b[4mSETUP\x1b[24m');
      expect(result.stdout).not.toContain('\x1b[1m');
      expect(result.stdout).toContain('\x1b[38;5;69msonar integrate\x1b[0m');
      expect(result.stdout).toContain(`\x1b[38;5;69mv${VERSION}\x1b[0m`);
      expect(result.stdout).toContain('\x1b[38;5;135m[BETA]\x1b[0m');
      expect(result.stdout).toContain('\x1b[36m[Cloud only]\x1b[39m');
      expect(result.stdout).toContain('\x1b[36m[Vortex]\x1b[39m');
      expect(result.stdout).toContain('\x1b[90mlogin, org, logout, status\x1b[39m');
      expect(result.stdout).toContain('\x1b[38;5;69mhttps://sonarsource.com/sonarqube/cli\x1b[0m');
      expect(stripAnsi(result.stdout).replaceAll('\r\n', '\n')).toBe(getExpectedRootHelp());
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
