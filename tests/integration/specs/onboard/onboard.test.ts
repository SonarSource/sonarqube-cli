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
 * You should have received a copy of the GNU Lesser General Public
 * License along with this program; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { rootCertificates } from 'node:tls';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { OnboardReport } from '@/commands/onboard/output.ts';
import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { scannerArchive, SONAR_SCANNER_VERSION } from '@/core/host/install/sonar-scanner.ts';
import type { CliState } from '@/core/state/state.ts';

import { IS_WINDOWS, normalizePath, TestHarness } from '../../harness';
import type { RunOptions } from '../../harness/types.ts';
import { commitFile, git, initGitRepo } from '../hook/git-test-helpers.ts';

const TOKEN = 'onboard-test-token';

interface Invocation {
  args: string[];
  cwd: string;
  token: string;
  network: { proxyHost: string; proxyPort: string; proxyUser: string; proxyPassword: string };
}

describe('sonar onboard', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    // Keep user-installed scanners out of tests that exercise the managed installation.
    const bin = join(harness.userHome.path, 'path-bin');
    mkdirSync(bin, { recursive: true });
    const launcher = join(bin, IS_WINDOWS ? 'sonar-scanner.bat' : 'sonar-scanner');
    writeFileSync(launcher, IS_WINDOWS ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n');
    if (!IS_WINDOWS) chmodSync(launcher, 0o755);
    harness.withExtraEnv({ PATH: bin + delimiter + (process.env.PATH ?? '') });
  });
  afterEach(async () => {
    await harness.dispose();
  });

  function runText(command: string, options?: RunOptions) {
    return harness.run(
      command.startsWith('onboard') ? command + ' --format text' : command,
      options,
    );
  }

  function seedScanner(): string {
    const home = join(harness.cliHome.path, 'bin', scannerArchive(detectPlatform()).directoryName);
    const java = join(home, 'jre', 'bin', IS_WINDOWS ? 'java.exe' : 'java');
    mkdirSync(join(home, 'jre', 'bin'), { recursive: true });
    mkdirSync(join(home, 'lib'), { recursive: true });
    copyFileSync(
      join(
        import.meta.dir,
        '../../resources',
        IS_WINDOWS ? 'sonar-scanner-stub.exe' : 'sonar-scanner-stub',
      ),
      java,
    );
    if (!IS_WINDOWS) chmodSync(java, 0o755);
    writeFileSync(join(home, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`), '');
    harness.withExtraEnv({
      ONBOARD_STUB_LOG_PATH: harness.cliHome.file('scanner-invocations.jsonl').path,
    });
    return home;
  }

  function invocations(): Invocation[] {
    const log = harness.cliHome.file('scanner-invocations.jsonl');
    return log.exists()
      ? log
          .asText()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Invocation)
      : [];
  }

  function scannerLogs(): string {
    const logs = join(harness.cliHome.path, 'logs');
    return readdirSync(logs)
      .filter((name) => name.startsWith('sonar-scanner-'))
      .map((name) => readFileSync(join(logs, name), 'utf8'))
      .join('\n');
  }

  function seedExternalScanner(version = '7.3.0.5189'): string {
    const home = join(harness.userHome.path, 'external scanner');
    const bin = join(home, 'bin');
    const javaHome = join(home, 'custom java');
    const java = join(javaHome, 'bin', IS_WINDOWS ? 'java.exe' : 'java');
    const embeddedJavaHome = IS_WINDOWS ? join(home, 'jre') : javaHome;
    const runtime = join(embeddedJavaHome, 'bin', IS_WINDOWS ? 'java.exe' : 'java');
    const jar = join(home, 'lib', `sonar-scanner-cli-${version}.jar`);
    mkdirSync(bin, { recursive: true });
    mkdirSync(join(embeddedJavaHome, 'bin'), { recursive: true });
    mkdirSync(join(home, 'lib'), { recursive: true });
    const stub = join(
      import.meta.dir,
      '../../resources',
      IS_WINDOWS ? 'sonar-scanner-stub.exe' : 'sonar-scanner-stub',
    );
    copyFileSync(stub, runtime);
    if (!IS_WINDOWS) chmodSync(java, 0o755);
    writeFileSync(jar, '');
    if (IS_WINDOWS) writeFileSync(join(bin, 'sonar-scanner.bat'), '@echo off\r\n');
    else {
      copyFileSync(stub, join(bin, 'sonar-scanner'));
      chmodSync(join(bin, 'sonar-scanner'), 0o755);
    }
    harness.withExtraEnv({
      PATH: bin + delimiter + (process.env.PATH ?? ''),
      ONBOARD_STUB_SCANNER_HOME: home,
      ONBOARD_STUB_JAVA_HOME: embeddedJavaHome,
      ONBOARD_STUB_SCANNER_CLASSPATH: jar,
      ONBOARD_STUB_SCANNER_VERSION: version,
      ONBOARD_STUB_LOG_PATH: harness.cliHome.file('scanner-invocations.jsonl').path,
    });
    return home;
  }

  it('supports path, name and public visibility together and reports the chosen name in JSON', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    harness.cwd.writeFile('pom.xml', '');
    harness.cwd.writeFile('services/api/app.js', '');
    harness.cwd.writeFile('services/api/sonar-project.properties', 'sonar.projectName=Old name');
    const result = await harness.run(
      'onboard --path services/api --project-key api-key --name "Public API" --visibility public --format json',
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const params = new URLSearchParams(
      server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!.body,
    );
    expect(Object.fromEntries(params)).toEqual({
      project: 'api-key',
      name: 'Public API',
      visibility: 'public',
    });
    const [invocation] = invocations();
    expect(invocation.cwd).toBe(join(harness.cwd.path, 'services', 'api'));
    expect(invocation.args).toContain('-Dsonar.projectName=Public API');
    expect(invocation.args).toContain(`-Dsonar.projectBaseDir=${invocation.cwd}`);
    const report = JSON.parse(result.stdout) as OnboardReport;
    expect(report.projectName).toBe('Public API');
    expect(report.projectKey).toBe('api-key');
    expect(harness.cwd.file('services/api/sonar-project.properties').asText()).toBe(
      'sonar.projectName=Old name',
    );
  });

  it('accepts an absolute path outside the invocation directory and discovers its configuration', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const directory = join(harness.userHome.path, 'outside-app');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'sonar-project.properties'), 'sonar.projectKey=outside-key');
    const result = await runText(`onboard --path "${directory}"`);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(invocations()[0].cwd).toBe(directory);
    expect(invocations()[0].args).toContain('-Dsonar.projectKey=outside-key');
  });

  it('keeps an explicit subdirectory scan root when configuration is discovered in its parent', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=parent-key');
    harness.cwd.writeFile('services/api/app.js', '');
    const result = await runText('onboard --path services/api');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(invocations()[0].cwd).toBe(join(harness.cwd.path, 'services', 'api'));
    expect(invocations()[0].args).toContain('-Dsonar.projectKey=parent-key');
  });

  it('generates distinct stable keys for explicitly selected monorepo directories', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    git(['remote', 'add', 'origin', 'https://example.test/team/monorepo.git'], harness.cwd.path);
    for (const directory of ['services/api', 'services/web', 'other/api']) {
      harness.cwd.writeFile(`${directory}/app.js`, '');
      const result = await runText(`onboard --path ${directory}`);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    }
    const keys = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/projects/create')
      .map((r) => new URLSearchParams(r.body).get('project'));
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^api-[a-f0-9]{12}$/);
    expect(keys[1]).toMatch(/^web-[a-f0-9]{12}$/);
    expect(keys[2]).toMatch(/^api-[a-f0-9]{12}$/);
    const repeated = await runText(`onboard --path "${join(harness.cwd.path, 'services', 'api')}"`);
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${keys[0]}' already exists`);
    expect(
      server.getRecordedRequests().filter((r) => r.path === '/api/projects/create'),
    ).toHaveLength(3);
    expect(invocations().map((i) => i.cwd)).toEqual(
      ['services/api', 'services/web', 'other/api'].map((p) => join(harness.cwd.path, p)),
    );
  }, 15000);

  it('generates the same subproject key across Git clones with different local names', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    for (const name of ['first-clone', 'second-clone']) {
      const root = join(harness.cwd.path, name);
      initGitRepo(root);
      git(['remote', 'add', 'origin', 'git@example.test:team/monorepo.git'], root);
      harness.cwd.writeFile(`${name}/services/api/app.js`, '');
    }
    expect((await runText('onboard --path first-clone/services/api')).exitCode).toBe(0);
    const key = new URLSearchParams(
      server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!.body,
    ).get('project');
    const repeated = await runText('onboard --path second-clone/services/api');
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${key}' already exists`);
    expect(
      server.getRecordedRequests().filter((r) => r.path === '/api/projects/create'),
    ).toHaveLength(1);
  });

  it('changes the display name without changing the generated key', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const first = await harness.run('onboard --name "First display name" --format json');
    expect(first.exitCode).toBe(0);
    const firstReport = JSON.parse(first.stdout) as OnboardReport;
    expect(firstReport.projectName).toBe('First display name');
    expect(invocations()[0].args).toContain('-Dsonar.projectName=First display name');
    const second = await harness.run('onboard --name "Another display name" --format json');
    expect(second.exitCode).toBe(0);
    const secondReport = JSON.parse(second.stdout) as OnboardReport;
    expect(secondReport.projectKey).toBe(firstReport.projectKey);
    expect(secondReport.projectName).toBe(firstReport.projectName);
    expect(secondReport.analysis.status).toBe('skipped');
    expect(
      server.getRecordedRequests().filter((r) => r.path === '/api/projects/create'),
    ).toHaveLength(1);
  });

  it('defaults visibility to private with a name override', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await runText('onboard --project-key new-project --name "  API Service  "');
    expect(result.exitCode).toBe(0);
    const params = new URLSearchParams(
      server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!.body,
    );
    expect(params.get('visibility')).toBe('private');
    expect(params.get('name')).toBe('API Service');
  });

  it.each(['--path=', '--path " "', '--path missing-directory', '--path app.js'])(
    'rejects invalid source directory %s before changing anything',
    async (argument) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      harness.cwd.writeFile('app.js', '');
      const result = await runText(`onboard --project-key new-project ${argument}`);
      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--path');
      expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(
        false,
      );
      expect(harness.cliHome.file('bin').exists()).toBe(false);
    },
  );

  it.each(['--name=', '--name " "', '--name "Bad\nName"'])(
    'rejects invalid display name %s before changing anything',
    async (argument) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      const result = await runText(`onboard --project-key new-project ${argument}`);
      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--name');
      expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(
        false,
      );
      expect(harness.cliHome.file('bin').exists()).toBe(false);
    },
  );

  it('rejects unsupported visibility and documents the new flags', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await runText('onboard --visibility internal');
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('--visibility');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
    const help = await harness.run('onboard --help');
    expect(help.stdout).toContain('--path <directory>');
    expect(help.stdout).toContain('--name <name>');
    expect(help.stdout).toContain('--visibility <visibility>');
    expect(help.stdout).toContain('private');
  });

  it('reuses an installed scanner on PATH with its own version and runtime', async () => {
    const server = await harness.newFakeServer().start();
    const binaries = await harness.newFakeBinariesServer().noArtifacts().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const home = seedExternalScanner();
    harness.withExtraEnv({ SONARQUBE_CLI_BINARIES_URL: binaries.baseUrl() });
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Using installed SonarScanner 7.3.0.5189');
    expect(invocations()[0].args).toContain(join(home, 'lib', 'sonar-scanner-cli-7.3.0.5189.jar'));
    expect(binaries.getRecordedRequests().some((r) => r.path.endsWith('.zip'))).toBe(false);
    expect(harness.cliHome.file('bin').exists()).toBe(false);
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.dependencies.installed.some((d) => d.id === 'sonar-scanner')).toBe(false);
    harness.state().withRawState(harness.stateJsonFile.asText());
    expect((await runText('system reset --force')).exitCode).toBe(0);
    expect(existsSync(home)).toBe(true);
  });

  it('prefers a usable PATH scanner over the cached managed scanner', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    seedExternalScanner();
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Using installed SonarScanner 7.3.0.5189');
    expect(invocations()[0].args.join(' ')).toContain('sonar-scanner-cli-7.3.0.5189.jar');
  });

  it('falls back to the managed cache when the PATH scanner is too old', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    seedExternalScanner('5.0.1.3006');
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout + result.stderr).toContain('Using cached SonarScanner');
    expect(invocations()[0].args.join(' ')).toContain(
      `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`,
    );
  });

  it.skipIf(IS_WINDOWS)(
    'falls back to the managed cache when the PATH launcher cannot run',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      seedScanner();
      seedExternalScanner();
      harness.withExtraEnv({ ONBOARD_STUB_PATH_VERSION_EXIT_CODE: '1' });
      const result = await runText('onboard --project-key new-project');
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stdout + result.stderr).toContain('Using cached SonarScanner');
    },
  );

  it.each([' --format json', ' --format=json'])(
    'includes messages while omitting scanner logs without verbose%s',
    async (format) => {
      const server = await harness
        .newFakeServer()
        .withOnboarding({
          issues: [
            {
              ruleKey: 'javascript:S100',
              message: 'Rename this function',
              component: 'new-project:src/app.js',
              line: 12,
            },
          ],
        })
        .start();
      harness.withAuth(server.baseUrl(), TOKEN);
      seedScanner();
      harness.withExtraEnv({
        ONBOARD_STUB_STDOUT: 'SCANNER-RAW-OUTPUT',
        ONBOARD_STUB_STDERR: 'SCANNER-RAW-DIAGNOSTIC',
      });
      const result = await harness.run('onboard --project-key new-project' + format);
      expect(result.exitCode, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as OnboardReport;
      expect(report.projectKey).toBe('new-project');
      expect(report.analysis).toEqual({ status: 'completed', id: 'onboard-analysis' });
      expect(report.qualityGate).toBe('OK');
      expect(report.dashboardUrl).toBe(server.baseUrl() + '/dashboard?id=new-project');
      expect(report.issues).toHaveLength(1);
      expect(report.issues?.[0]).toMatchObject({
        rule: 'javascript:S100',
        message: 'Rename this function',
        line: 12,
      });
      expect(report.paging).toEqual({ pageIndex: 1, pageSize: 20, total: 1 });
      expect(report.warnings).toEqual([]);
      expect(report.scannerOutput).toBeUndefined();
      expect(result.stdout).not.toContain('SCANNER-RAW');
      expect(result.stderr).not.toContain('SCANNER-RAW');
      expect(report.messages.some((message) => message.includes('Analysis processed.'))).toBe(true);
      expect(result.stderr).toBe('');
      expect(readFileSync(report.scannerLogPath!, 'utf8')).toContain('SCANNER-RAW-OUTPUT');
      const calls = server.getRecordedRequests();
      const issues = calls.find((r) => r.path === '/api/issues/search')!;
      expect(issues.query).toMatchObject({
        components: 'new-project',
        issueStatuses: 'OPEN,CONFIRMED',
        ps: '20',
        p: '1',
      });
      expect(calls.findIndex((r) => r.path === '/api/ce/task')).toBeLessThan(
        calls.findIndex((r) => r.path === '/api/issues/search'),
      );
      expect(calls.some((r) => r.path === '/api/project_pull_requests/list')).toBe(false);
    },
  );

  it('prints a human summary and a wrapped issue table with scanner logs omitted by default', async () => {
    const message =
      'A detailed issue message containing all the context needed to understand and fix this problem without losing any of the explanatory text.';
    const server = await harness
      .newFakeServer()
      .withOnboarding({
        qualityGate: 'ERROR',
        issues: [
          {
            ruleKey: 'javascript:S100',
            message,
            component: 'new-project:src/routes/app.js',
            line: 42,
            severity: 'CRITICAL',
          },
          { ruleKey: 'javascript:S200', message: 'Confirmed issue', status: 'CONFIRMED' },
          { ruleKey: 'javascript:S300', message: 'Hidden accepted issue', status: 'ACCEPTED' },
        ],
      })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({ CODEX_CI: '1', COLUMNS: '72', ONBOARD_STUB_STDOUT: 'RAW-SCANNER-LOG' });
    const result = await harness.run('onboard --project-key new-project --format text');
    expect(result.exitCode, result.stderr).toBe(0);
    const output = Bun.stripANSI(result.stdout);
    expect(output).toContain('Analysis complete — cwd');
    expect(output).toMatch(/Quality gate\s+Failed/);
    expect(output).toMatch(/Active issues\s+2/);
    expect(output).toContain('Full results');
    expect(output).toContain('SEVERITY');
    expect(output).toContain('FILE:LINE');
    expect(output).toContain('src/routes/app.js:42');
    expect(output).toContain('javascript:S100');
    expect(output).not.toContain('Hidden accepted issue');
    expect(output).not.toContain('RAW-SCANNER-LOG');
    expect(result.stderr).not.toContain('RAW-SCANNER-LOG');
    expect(output).toContain('Analyzing source code...');
    const table = output.slice(output.indexOf('SEVERITY'), output.indexOf('Showing'));
    expect(table.split('\n').every((line) => Bun.stringWidth(line) <= 72)).toBe(true);
    expect(table.replace(/\s+/g, '')).toContain(message.replace(/\s+/g, ''));
  });

  it('streams verbose logs before the scanner finishes and redacts tokens across chunks', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({ ONBOARD_STUB_STREAMING: 'true' });
    const session = harness.runInteractive('onboard --project-key new-project --verbose');
    await session.waitText('SCANNER-FIRST');
    expect(session.output()).not.toContain('SCANNER-LAST');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/ce/task')).toBe(false);
    const result = await session.waitFinish();
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('SCANNER-LAST');
    expect(result.stdout).toContain('SCANNER-STDERR');
    expect(result.stdout).toContain('[REDACTED]');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(result.stdout).not.toContain('Analyzing source code...');
    expect(result.stdout.indexOf('SCANNER-LAST')).toBeLessThan(
      result.stdout.indexOf('Analysis complete'),
    );
  });

  it('streams verbose JSON logs to stderr and keeps stdout as one JSON document', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({ ONBOARD_STUB_STREAMING: 'true' });
    const result = await harness.run('onboard --project-key new-project --verbose --format json');
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as OnboardReport;
    expect(report.analysis.status).toBe('completed');
    expect(report.scannerOutput?.stdout).toContain('SCANNER-FIRST');
    expect(report.scannerOutput?.stdout).toContain('SCANNER-LAST');
    expect(result.stderr).toContain('SCANNER-FIRST');
    expect(result.stderr).toContain('SCANNER-STDERR');
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
  });

  it('reports pagination and an exact command to retrieve the next issue page', async () => {
    const server = await harness
      .newFakeServer()
      .withOnboarding({
        issues: Array.from({ length: 23 }, (_, i) => ({
          ruleKey: 'javascript:S100',
          message: 'Issue ' + i,
        })),
      })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --project-key new-project --format text');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Showing 20 of 23 active issues.');
    expect(result.stdout).toContain(
      'sonar list issues --project=new-project --format table --page-size 20 --page 2',
    );
  });

  it('distinguishes zero issues from a failed issue request in JSON', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --project-key new-project --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      issues: [],
      paging: { total: 0 },
      warnings: [],
    });
  });

  it.each(['json', 'text'])(
    'keeps analysis completed when issue retrieval fails (%s)',
    async (format) => {
      const server = await harness
        .newFakeServer()
        .withOnboarding({
          issuesSearchError: { status: 503, message: 'Issue service unavailable' },
        })
        .start();
      harness.withAuth(server.baseUrl(), TOKEN);
      seedScanner();
      const result = await harness.run('onboard --project-key new-project --format ' + format);
      expect(result.exitCode, result.stderr).toBe(0);
      if (format === 'text') expect(result.stderr).toContain('Could not retrieve issues');
      else expect(result.stderr).toBe('');
      expect(result.stderr).not.toContain('first analysis could not be completed');
      if (format === 'json') {
        const report = JSON.parse(result.stdout);
        expect(report.analysis.status).toBe('completed');
        expect(report.issues).toBeNull();
        expect(report.paging).toBeNull();
        expect(report.warnings).toHaveLength(1);
        expect(report.dashboardUrl).toContain('/dashboard?id=new-project');
      } else {
        expect(result.stdout).toContain('Analysis complete');
        expect(result.stdout).toMatch(/Active issues\s+Unavailable/);
        expect(result.stdout).toContain('Issues could not be loaded.');
      }
    },
  );

  it('keeps completed analysis and issues when the quality gate cannot be retrieved', async () => {
    const server = await harness
      .newFakeServer()
      .withOnboarding({
        qualityGateError: { status: 503, message: 'Gate service unavailable' },
      })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --project-key new-project --format json');
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      analysis: { status: 'completed' },
      qualityGate: null,
      issues: [],
    });
    expect(JSON.parse(result.stdout).warnings[0]).toContain('Could not retrieve the quality gate');
    expect(result.stderr).toBe('');
  });

  it('saves redacted scanner diagnostics and prints their location on failure', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({
      ONBOARD_STUB_EXIT_CODE: '1',
      ONBOARD_STUB_STDOUT: 'LOG-MARKER ' + TOKEN,
    });
    const result = await harness.run('onboard --project-key new-project --format json');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Inspect ');
    expect(result.stderr).toContain('.log');
    expect(result.stdout).not.toContain('LOG-MARKER');
    expect(result.stderr).not.toContain('LOG-MARKER');
    expect(scannerLogs()).toContain('LOG-MARKER [REDACTED]');
    expect(scannerLogs()).not.toContain(TOKEN);
  });

  it('rejects unsupported output formats before making changes', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await harness.run('onboard --project-key new-project --format yaml');
    expect(result.exitCode).not.toBe(0);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
  });

  it.skipIf(IS_WINDOWS)(
    'defaults to text with an issue table in an interactive human terminal',
    async () => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      seedScanner();
      const result = await harness.runWithRealTty('onboard --project-key new-project');
      expect(result.exitCode, result.stderr + result.stdout).toBe(0);
      expect(result.stdout).toContain('Analysis complete');
      expect(result.stdout).toContain('Full results');
      expect(result.stdout).not.toContain('"analysis":');
    },
  );

  it('defaults to text even for an agent using piped output', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --project-key new-project', {
      extraEnv: { CODEX_CI: '1' },
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).not.toContain('"analysis":');
    expect(result.stdout).toContain('Full results');
  });

  it('requires authentication', async () => {
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Not authenticated');
  });

  it('generates a stable folder-based key without Git or project configuration', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await runText('onboard');
    expect(result.exitCode).toBe(0);
    const creation = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!;
    const params = new URLSearchParams(creation.body);
    const key = params.get('project')!;
    expect(key).toMatch(/^cwd-[a-f0-9]{12}$/);
    expect(params.get('name')).toBe('cwd');
    expect(result.stdout + result.stderr).toContain(`Generated project key '${key}'`);
    expect(invocations()[0].args).toContain(`-Dsonar.projectKey=${key}`);
    expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
    const repeated = await runText('onboard');
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${key}' already exists`);
    expect(
      server.getRecordedRequests().filter((r) => r.path === '/api/projects/create'),
    ).toHaveLength(1);
  });

  it('uses the invocation folder when a parent contains an invalid Git marker', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.cwd.writeFile('.git', 'invalid worktree marker');
    harness.cwd.writeFile('nested/app.js', '');
    const directory = join(harness.cwd.path, 'nested');
    expect((await runText('onboard', { cwd: directory })).exitCode).toBe(0);
    const creation = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!;
    expect(new URLSearchParams(creation.body).get('project')).toMatch(/^nested-[a-f0-9]{12}$/);
    expect(invocations()[0].cwd).toBe(directory);
  });

  it('uses credential-free Git origin identity consistently across HTTPS and SSH clones', async () => {
    const server = await harness.newFakeServer().asSonarCloud().start();
    harness.withAuth(server.baseUrl(), TOKEN, 'my-org');
    seedScanner();
    const remotes = [
      'https://user:fake-password@EXAMPLE.test/owner/My-App.git?ignored=yes#fragment',
      'git@example.test:owner/My-App.git',
      'ssh://git@example.test:22/owner/My-App.git/',
    ];
    let key: string | undefined;
    for (const [index, remote] of remotes.entries()) {
      const checkout = join(harness.cwd.path, `checkout-${index}`);
      initGitRepo(checkout);
      git(['remote', 'add', 'origin', remote], checkout);
      const result = await runText('onboard', { cwd: checkout });
      expect(result.stdout + result.stderr).not.toContain('fake-password');
      if (index === 0) {
        expect(result.exitCode).toBe(0);
        const creation = server
          .getRecordedRequests()
          .find((r) => r.path === '/api/projects/create')!;
        const params = new URLSearchParams(creation.body);
        key = params.get('project')!;
        expect(key).toMatch(/^my-org_my-app-[a-f0-9]{12}$/);
        expect(params.get('name')).toBe('My-App');
        expect(invocations()[0].cwd).toBe(checkout);
      } else {
        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(`Project '${key}' already exists`);
      }
    }
    expect(
      server.getRecordedRequests().filter((r) => r.path === '/api/projects/create'),
    ).toHaveLength(1);
  });

  it('distinguishes repositories with the same name under different owners', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    git(['remote', 'add', 'origin', 'https://example.test/alice/my-app.git'], harness.cwd.path);
    expect((await runText('onboard')).exitCode).toBe(0);
    git(['remote', 'set-url', 'origin', 'https://example.test/bob/my-app.git'], harness.cwd.path);
    expect((await runText('onboard')).exitCode).toBe(0);
    const keys = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/projects/create')
      .map((r) => new URLSearchParams(r.body).get('project'));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('uses the main Git directory name without an origin, consistently from subdirectories and worktrees', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    commitFile(harness.cwd.path, 'README.md', 'test');
    harness.cwd.writeFile('src/app.js', '');
    const result = await runText('onboard', { cwd: join(harness.cwd.path, 'src') });
    expect(result.exitCode).toBe(0);
    const creation = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!;
    const params = new URLSearchParams(creation.body);
    const key = params.get('project')!;
    expect(key).toMatch(/^cwd-[a-f0-9]{12}$/);
    expect(params.get('name')).toBe('cwd');
    expect(invocations()[0].cwd).toBe(harness.cwd.path);
    const worktree = join(harness.userHome.path, 'different-worktree-name');
    git(['worktree', 'add', '-b', 'onboard-test', worktree], harness.cwd.path);
    const repeated = await runText('onboard', { cwd: worktree });
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${key}' already exists`);
  });

  it('namespaces generated keys by the active Cloud organization', async () => {
    const server = await harness.newFakeServer().asSonarCloud().start();
    seedScanner();
    for (const organization of ['org-a', 'org-b']) {
      harness.withAuth(server.baseUrl(), TOKEN, organization);
      expect((await runText('onboard')).exitCode).toBe(0);
    }
    const creations = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/projects/create')
      .map((r) => new URLSearchParams(r.body));
    expect(creations[0].get('project')).toMatch(/^org-a_cwd-[a-f0-9]{12}$/);
    expect(creations[1].get('project')).toMatch(/^org-b_cwd-[a-f0-9]{12}$/);
    expect(creations.map((params) => params.get('organization'))).toEqual(['org-a', 'org-b']);
  });

  it.each([
    ['12345', '12345'],
    ['Crème brûlée!!!', 'creme-brulee'],
    ['🚀', 'project'],
  ])('generates a valid key for directory %s', async (name, prefix) => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.cwd.writeFile(`${name}/.keep`, '');
    const result = await runText('onboard', { cwd: join(harness.cwd.path, name) });
    expect(result.exitCode).toBe(0);
    const creation = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!;
    expect(new URLSearchParams(creation.body).get('project')).toMatch(
      new RegExp(`^${prefix}-[a-f0-9]{12}$`),
    );
  });

  it('distinguishes folder names that normalize to the same readable key prefix', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    for (const name of ['My App', 'My-App']) {
      harness.cwd.writeFile(`${name}/.keep`, '');
      expect((await runText('onboard', { cwd: join(harness.cwd.path, name) })).exitCode).toBe(0);
    }
    const keys = server
      .getRecordedRequests()
      .filter((r) => r.path === '/api/projects/create')
      .map((r) => new URLSearchParams(r.body).get('project'));
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.every((key) => /^my-app-[a-f0-9]{12}$/.test(key!))).toBe(true);
  });

  it('generates the same key for the same directory name in different locations', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    for (const parent of ['one', 'two']) harness.cwd.writeFile(`${parent}/my-app/.keep`, '');
    expect(
      (await runText('onboard', { cwd: join(harness.cwd.path, 'one', 'my-app') })).exitCode,
    ).toBe(0);
    const key = new URLSearchParams(
      server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!.body,
    ).get('project');
    const repeated = await runText('onboard', { cwd: join(harness.cwd.path, 'two', 'my-app') });
    expect(repeated.exitCode).toBe(0);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${key}' already exists`);
  });

  it.each(['1234', 'bad/key', ' ', ''])(
    'rejects invalid key %j before making changes',
    async (key) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      const result = await runText(
        key === '' ? 'onboard --project-key=' : `onboard --project-key "${key}"`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--project-key must contain');
      expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(
        false,
      );
    },
  );

  it('creates a private unbound Server project and analyzes without creating configuration', async () => {
    const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.cwd.writeFile('app.js', 'const x = 1;');
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain('Created private unbound project');
    expect(result.stdout + result.stderr).toContain('Analysis uploaded.');
    expect(result.stdout + result.stderr).toContain('Analysis processed.');
    expect(result.stdout).toMatch(/Quality gate\s+Passed/);
    expect(result.stdout).toContain(`${server.baseUrl()}/dashboard?id=new-project`);
    const requests = server.getRecordedRequests();
    const creation = requests.find((r) => r.path === '/api/projects/create')!;
    expect(Object.fromEntries(new URLSearchParams(creation.body))).toEqual({
      project: 'new-project',
      name: 'cwd',
      visibility: 'private',
    });
    expect(creation.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(
      requests.some((r) => r.path.includes('alm_integration') || r.path.includes('autoscan')),
    ).toBe(false);
    expect(requests.find((r) => r.path === '/api/qualitygates/project_status')?.query).toEqual({
      analysisId: 'onboard-analysis',
    });
    const [invocation] = invocations();
    expect(invocation.token).toBe(TOKEN);
    expect(invocation.args.join(' ')).not.toContain(TOKEN);
    expect(invocation.args).toContain('-Dsonar.projectKey=new-project');
    expect(invocation.cwd).toBe(harness.cwd.path);
    expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
    expect(harness.cwd.file('sonar-project.properties').exists()).toBe(false);
    expect(harness.cwd.file('.scannerwork').exists()).toBe(false);
  });

  it('uses the Cloud organization and authenticated US server URL', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN, 'my-org');
    harness.withExtraEnv({ SONARQUBE_CLI_SONARCLOUD_US_URL: server.baseUrl() });
    seedScanner();
    const result = await runText('onboard --project-key my-org_app');
    expect(result.exitCode).toBe(0);
    const body = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')?.body;
    expect(new URLSearchParams(body).get('organization')).toBe('my-org');
    expect(invocations()[0].args).toContain('-Dsonar.organization=my-org');
    expect(invocations()[0].args).toContain(`-Dsonar.host.url=${server.baseUrl()}`);
    expect(invocations()[0].args.some((arg) => arg.startsWith('-Dsonar.region='))).toBe(false);
  });

  it('rejects a Cloud connection without an organization before installing', async () => {
    const server = await harness.newFakeServer().asSonarCloud().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('organization is required');
    expect(harness.cliHome.file('bin').exists()).toBe(false);
  });

  it('detects a key in local scanner configuration and preserves that file', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const properties = 'sonar.projectKey=configured-key\nsonar.scanner.autoconfig.enabled=false\n';
    harness.cwd.writeFile('sonar-project.properties', properties);
    const result = await runText('onboard');
    expect(result.exitCode).toBe(0);
    expect(invocations()[0].args).toContain('-Dsonar.projectKey=configured-key');
    expect(invocations()[0].args).toContain('-Dsonar.scanner.autoconfig.enabled=true');
    expect(harness.cwd.file('sonar-project.properties').asText()).toBe(properties);
  });

  it('uses the detected project directory when called from a subdirectory', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=parent-key');
    harness.cwd.writeFile('src/app.js', '');
    const result = await runText('onboard', { cwd: join(harness.cwd.path, 'src') });
    expect(result.exitCode).toBe(0);
    expect(invocations()[0].cwd).toBe(harness.cwd.path);
  });

  it('lets the explicit key override local configuration and uses the active server', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.cwd.writeFile(
      'sonar-project.properties',
      'sonar.projectKey=old-key\nsonar.host.url=https://other.example.com',
    );
    const result = await runText('onboard --project-key explicit-key');
    expect(result.exitCode).toBe(0);
    expect(invocations()[0].args).toContain('-Dsonar.projectKey=explicit-key');
    expect(invocations()[0].args).toContain(`-Dsonar.host.url=${server.baseUrl()}`);
  });

  it('rejects auto-detected configuration for a different connection', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    harness.cwd.writeFile(
      'sonar-project.properties',
      'sonar.projectKey=key\nsonar.host.url=https://other.example.com',
    );
    const result = await runText('onboard');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('does not match the active connection');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
  });

  it.each(['text', 'json'])(
    'warns and stops for existing Cloud projects in %s format',
    async (format) => {
      const key = 'existing:key';
      const server = await harness.newFakeServer().asSonarCloud().withProject(key).start();
      harness.withAuth(server.baseUrl(), TOKEN, 'my-org');
      harness.cwd.writeFile('pom.xml', '<project/>');
      const result = await harness.run(`onboard --project-key ${key} --format ${format}`);
      const warning = `Project '${key}' already exists. Onboarding skipped; no analysis was run.`;
      const dashboardUrl = server.baseUrl() + '/dashboard?id=existing%3Akey';
      expect(result.exitCode).toBe(0);
      if (format === 'json') {
        expect(JSON.parse(result.stdout)).toMatchObject({
          projectKey: key,
          analysis: { status: 'skipped', id: null },
          dashboardUrl,
          qualityGate: null,
          issues: null,
          paging: null,
          scannerLogPath: null,
          warnings: [warning],
        });
        expect(result.stderr).toBe('');
      } else {
        expect(result.stdout + result.stderr).toContain(warning);
        expect(result.stdout).toContain(`Project dashboard: ${dashboardUrl}`);
        expect(result.stdout).not.toContain('Analysis complete');
      }
      expect(harness.cliHome.file('bin').exists()).toBe(false);
      expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
      expect(server.getRecordedRequests().some((r) => r.method === 'POST')).toBe(false);
      expect(server.getRecordedRequests().some((r) => r.path === '/api/ce/task')).toBe(false);
    },
  );

  it.each(['pom.xml', 'build.gradle.kts', 'app.csproj'])(
    'uses Scanner CLI automatic configuration regardless of build marker: %s',
    async (file) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      seedScanner();
      harness.cwd.writeFile(file, '');
      const result = await runText('onboard --project-key new-project');
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(invocations()).toHaveLength(1);
      expect(invocations()[0].args).toContain('-Dsonar.scanner.autoconfig.enabled=true');
      expect(result.stdout).toContain('Analysis complete');
      expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(
        true,
      );
    },
  );

  it('passes repeatable scanner settings unchanged, with the last value for duplicate keys', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const properties = 'sonar.projectKey=properties-key\nsonar.exclusions=old/**\n';
    harness.cwd.writeFile('sonar-project.properties', properties);
    const result = await runText(
      'onboard --scanner-property "sonar.exclusions=first/**" --scanner-property "sonar.exclusions=**/generated/**,**/vendor/**" --scanner-property "sonar.coverage.jacoco.xmlReportPaths=coverage reports/jacoco.xml" --scanner-property "sonar.java.binaries=target/classes" --scanner-property "sonar.projectDescription=alpha=beta with spaces" --scanner-property "sonar.test.exclusions="',
    );
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const [invocation] = invocations();
    expect(invocation.args).toContain('-Dsonar.exclusions=**/generated/**,**/vendor/**');
    expect(invocation.args.filter((arg) => arg.startsWith('-Dsonar.exclusions='))).toHaveLength(1);
    expect(invocation.args).toContain(
      '-Dsonar.coverage.jacoco.xmlReportPaths=coverage reports/jacoco.xml',
    );
    expect(invocation.args).toContain('-Dsonar.java.binaries=target/classes');
    expect(invocation.args).toContain('-Dsonar.projectDescription=alpha=beta with spaces');
    expect(invocation.args).toContain('-Dsonar.test.exclusions=');
    expect(harness.cwd.file('sonar-project.properties').asText()).toBe(properties);
  });

  it.each(['', '=value', 'sonar.exclusions', 'bad key=value', 'sonar.exclusions=a\nb'])(
    'rejects malformed scanner setting %j before changing anything',
    async (property) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      const result = await runText(
        `onboard --project-key new-project --scanner-property="${property}"`,
      );
      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain('--scanner-property');
      expect(harness.cliHome.file('bin').exists()).toBe(false);
      expect(
        server.getRecordedRequests().some((request) => request.path === '/api/projects/create'),
      ).toBe(false);
    },
  );

  it.each([
    'sonar.host.url',
    'sonar.region',
    'sonar.organization',
    'sonar.projectKey',
    'sonar.projectName',
    'sonar.projectBaseDir',
    'sonar.working.directory',
    'sonar.scanner.metadataFilePath',
    'sonar.qualitygate.wait',
    'sonar.scanner.autoconfig.enabled',
    'sonar.token',
    'sonar.login',
    'sonar.password',
    'sonar.scanner.proxyPassword',
    'sonar.scanner.truststorePath',
  ])('rejects overriding managed scanner setting %s without printing its value', async (key) => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await runText(
      `onboard --project-key new-project --scanner-property ${key}=private-value`,
    );
    expect(result.exitCode).toBe(2);
    expect(result.stdout + result.stderr).toContain(
      `Scanner property '${key}' is managed by onboard`,
    );
    expect(result.stdout + result.stderr).not.toContain('private-value');
    expect(harness.cliHome.file('bin').exists()).toBe(false);
    expect(
      server.getRecordedRequests().some((request) => request.path === '/api/projects/create'),
    ).toBe(false);
  });

  it('does not scan when project creation is denied', async () => {
    const server = await harness
      .newFakeServer()
      .withOnboarding({
        createError: { status: 403, message: 'Create Projects permission required' },
      })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Create Projects permission required');
    expect(invocations()).toHaveLength(0);
  });

  it('retains the project and installation after scanner failure and redacts the token', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const home = seedScanner();
    harness.withExtraEnv({
      ONBOARD_STUB_EXIT_CODE: '1',
      ONBOARD_STUB_STDOUT: TOKEN,
      ONBOARD_STUB_STDERR: TOKEN,
    });
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain(
      'project and scanner installation have been retained',
    );
    expect(result.stdout + result.stderr).not.toContain(TOKEN);
    expect(existsSync(home)).toBe(true);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/ce/task')).toBe(false);
  });

  it.each<Record<string, string>>([
    { ONBOARD_STUB_SKIP_REPORT: 'true' },
    { ONBOARD_STUB_REPORT_PROJECT: 'wrong-project' },
  ])('rejects a missing or mismatched task report', async (env) => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv(env);
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('analysis task report');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/ce/task')).toBe(false);
  });

  it('waits for the submitted task rather than treating upload as completion', async () => {
    const server = await harness
      .newFakeServer()
      .withOnboarding({ taskStatuses: ['IN_PROGRESS', 'SUCCESS'] })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(0);
    expect(server.getRecordedRequests().filter((r) => r.path === '/api/ce/task')).toHaveLength(2);
  }, 15000);

  it.each(['FAILED', 'CANCELED'] as const)(
    'reports task status %s as a failed first analysis',
    async (status) => {
      const server = await harness
        .newFakeServer()
        .withOnboarding({ taskStatuses: [status] })
        .start();
      harness.withAuth(server.baseUrl(), TOKEN);
      seedScanner();
      const result = await runText('onboard --project-key new-project');
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(status.toLowerCase());
    },
  );

  it('reports a failed quality gate after successful analysis', async () => {
    const server = await harness.newFakeServer().withOnboarding({ qualityGate: 'ERROR' }).start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Quality gate\s+Failed/);
  });

  it('honors NO_PROXY when configuring the Java scanner', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    harness.withExtraEnv({
      SONAR_HTTP_PROXY_URL: 'http://127.0.0.1:1',
      SONAR_NO_PROXY: 'localhost',
      SONAR_SCANNER_PROXY_HOST: 'stale-proxy',
      SONAR_SCANNER_PROXY_PORT: 'not-a-port',
    });
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(0);
    expect(invocations()[0].network.proxyHost).toBeUndefined();
    expect(invocations()[0].network.proxyPort).toBeUndefined();
  });

  it.each(['SONAR_CA_CERT', 'NODE_EXTRA_CA_CERTS'])(
    'installs the real scanner and imports a CA bundle without a keytool executable (%s)',
    async (caVariable) => {
      const server = await harness
        .newFakeServer()
        .withOnboarding({
          createError: { status: 403, message: 'Create Projects permission required' },
        })
        .start();
      const binaries = await harness.newFakeBinariesServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      harness.cwd.writeFile(
        'ca-bundle.pem',
        readFileSync(
          join(import.meta.dir, '../../../fixtures/client-cert/client-cert.pem'),
          'utf8',
        ) +
          '\n' +
          rootCertificates[0],
      );
      harness.withExtraEnv({
        SONARQUBE_CLI_BINARIES_URL: binaries.baseUrl(),
        [caVariable]: harness.cwd.file('ca-bundle.pem').path,
      });
      const result = await runText('onboard --project-key new-project', { timeoutMs: 120000 });
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('Create Projects permission required');
      expect(binaries.getRecordedRequests().some((r) => r.path.endsWith('.zip'))).toBe(true);
      const state = harness.stateJsonFile.asJson() as CliState;
      const install = state.dependencies.installed.find((d) => d.id === 'sonar-scanner');
      expect(install?.version).toBe(SONAR_SCANNER_VERSION);
      expect(existsSync(join(install!.path!, 'jre', 'bin', IS_WINDOWS ? 'java.exe' : 'java'))).toBe(
        true,
      );
      expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
    },
    120000,
  );

  it.each(['eu', 'us'])(
    'the real scanner accepts the authenticated URL despite inherited region settings (%s)',
    async (region) => {
      const server = await harness.newFakeServer().asSonarCloud().start();
      const binaries = await harness.newFakeBinariesServer().start();
      harness.withAuth(server.baseUrl(), TOKEN, 'my-org');
      const dumpPath = harness.cliHome.file('scanner-bootstrap.properties').path;
      harness.cwd.writeFile(
        'sonar-project.properties',
        `sonar.scanner.internal.dumpToFile=${normalizePath(dumpPath)}`,
      );
      harness.withExtraEnv({
        SONARQUBE_CLI_BINARIES_URL: binaries.baseUrl(),
        SONAR_REGION: 'us',
        ...(region === 'us' ? { SONARQUBE_CLI_SONARCLOUD_US_URL: server.baseUrl() } : {}),
      });
      const result = await runText('onboard --project-key bootstrap-test', {
        timeoutMs: 120000,
      });
      expect(scannerLogs()).toContain('Simulation mode.');
      expect(scannerLogs()).toContain('EXECUTION SUCCESS');
      expect(harness.cliHome.file('scanner-bootstrap.properties').exists()).toBe(true);
      expect(result.stdout + result.stderr).not.toContain('Inconsistent values');
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('did not produce an analysis task report');
    },
    120000,
  );

  it('rejects a corrupt download before extraction or project creation', async () => {
    const server = await harness.newFakeServer().start();
    const archiveName = scannerArchive(detectPlatform()).url.split('/').at(-1)!;
    const binaries = await harness
      .newFakeBinariesServer()
      .noArtifacts()
      .withArtifact(archiveName, Buffer.from('corrupt'))
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    harness.withExtraEnv({ SONARQUBE_CLI_BINARIES_URL: binaries.baseUrl() });
    const result = await runText('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('checksum verification failed');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
    expect(readdirSync(join(harness.cliHome.path, 'bin'))).toHaveLength(0);
  });

  it('system reset removes the entire managed scanner installation', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const home = seedScanner();
    expect((await runText('onboard --project-key new-project')).exitCode).toBe(0);
    harness.state().withRawState(harness.stateJsonFile.asText());
    const reset = await runText('system reset --force');
    expect(reset.exitCode).toBe(0);
    expect(existsSync(home), reset.stdout + reset.stderr).toBe(false);
  });
});
