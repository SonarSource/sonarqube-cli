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

import { detectPlatform } from '@/core/host/environment/platform-detector.ts';
import { scannerArchive, SONAR_SCANNER_VERSION } from '@/core/host/install/sonar-scanner.ts';
import type { CliState } from '@/core/state/state.ts';

import { IS_WINDOWS, normalizePath, TestHarness } from '../../harness';
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

  it('reuses an installed scanner on PATH with its own version and runtime', async () => {
    const server = await harness.newFakeServer().start();
    const binaries = await harness.newFakeBinariesServer().noArtifacts().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const home = seedExternalScanner();
    harness.withExtraEnv({ SONARQUBE_CLI_BINARIES_URL: binaries.baseUrl() });
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Using installed SonarScanner 7.3.0.5189');
    expect(invocations()[0].args).toContain(join(home, 'lib', 'sonar-scanner-cli-7.3.0.5189.jar'));
    expect(binaries.getRecordedRequests().some((r) => r.path.endsWith('.zip'))).toBe(false);
    expect(harness.cliHome.file('bin').exists()).toBe(false);
    const state = harness.stateJsonFile.asJson() as CliState;
    expect(state.dependencies.installed.some((d) => d.id === 'sonar-scanner')).toBe(false);
    harness.state().withRawState(harness.stateJsonFile.asText());
    expect((await harness.run('system reset --force')).exitCode).toBe(0);
    expect(existsSync(home)).toBe(true);
  });

  it('prefers a usable PATH scanner over the cached managed scanner', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    seedExternalScanner();
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Using installed SonarScanner 7.3.0.5189');
    expect(invocations()[0].args.join(' ')).toContain('sonar-scanner-cli-7.3.0.5189.jar');
  });

  it('falls back to the managed cache when the PATH scanner is too old', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    seedExternalScanner('5.0.1.3006');
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('Using cached SonarScanner');
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
      const result = await harness.run('onboard --project-key new-project');
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('Using cached SonarScanner');
    },
  );

  it('requires authentication', async () => {
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('Not authenticated');
  });

  it('generates a stable folder-based key without Git or project configuration', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard');
    expect(result.exitCode).toBe(0);
    const creation = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!;
    const params = new URLSearchParams(creation.body);
    const key = params.get('project')!;
    expect(key).toMatch(/^cwd-[a-f0-9]{12}$/);
    expect(params.get('name')).toBe('cwd');
    expect(result.stdout + result.stderr).toContain(`Generated project key '${key}'`);
    expect(invocations()[0].args).toContain(`-Dsonar.projectKey=${key}`);
    expect(harness.cwd.file('.sonar-config.json').exists()).toBe(false);
    const repeated = await harness.run('onboard');
    expect(repeated.exitCode).toBe(1);
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
    expect((await harness.run('onboard', { cwd: directory })).exitCode).toBe(0);
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
      const result = await harness.run('onboard', { cwd: checkout });
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
        expect(result.exitCode).toBe(1);
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
    expect((await harness.run('onboard')).exitCode).toBe(0);
    git(['remote', 'set-url', 'origin', 'https://example.test/bob/my-app.git'], harness.cwd.path);
    expect((await harness.run('onboard')).exitCode).toBe(0);
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
    const result = await harness.run('onboard', { cwd: join(harness.cwd.path, 'src') });
    expect(result.exitCode).toBe(0);
    const creation = server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!;
    const params = new URLSearchParams(creation.body);
    const key = params.get('project')!;
    expect(key).toMatch(/^cwd-[a-f0-9]{12}$/);
    expect(params.get('name')).toBe('cwd');
    expect(invocations()[0].cwd).toBe(harness.cwd.path);
    const worktree = join(harness.userHome.path, 'different-worktree-name');
    git(['worktree', 'add', '-b', 'onboard-test', worktree], harness.cwd.path);
    const repeated = await harness.run('onboard', { cwd: worktree });
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${key}' already exists`);
  });

  it('namespaces generated keys by the active Cloud organization', async () => {
    const server = await harness.newFakeServer().asSonarCloud().start();
    seedScanner();
    for (const organization of ['org-a', 'org-b']) {
      harness.withAuth(server.baseUrl(), TOKEN, organization);
      expect((await harness.run('onboard')).exitCode).toBe(0);
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
    const result = await harness.run('onboard', { cwd: join(harness.cwd.path, name) });
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
      expect((await harness.run('onboard', { cwd: join(harness.cwd.path, name) })).exitCode).toBe(
        0,
      );
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
      (await harness.run('onboard', { cwd: join(harness.cwd.path, 'one', 'my-app') })).exitCode,
    ).toBe(0);
    const key = new URLSearchParams(
      server.getRecordedRequests().find((r) => r.path === '/api/projects/create')!.body,
    ).get('project');
    const repeated = await harness.run('onboard', { cwd: join(harness.cwd.path, 'two', 'my-app') });
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stdout + repeated.stderr).toContain(`Project '${key}' already exists`);
  });

  it.each(['1234', 'bad/key', ' ', ''])(
    'rejects invalid key %j before making changes',
    async (key) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      const result = await harness.run(
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
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Created private unbound project');
    expect(result.stdout).toContain('Analysis uploaded.');
    expect(result.stdout).toContain('Analysis processed.');
    expect(result.stdout).toContain('Quality gate: OK');
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
    const result = await harness.run('onboard --project-key my-org_app');
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
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('organization is required');
    expect(harness.cliHome.file('bin').exists()).toBe(false);
  });

  it('detects a key in local scanner configuration and preserves that file', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const properties = 'sonar.projectKey=configured-key\nsonar.sources=src\n';
    harness.cwd.writeFile('sonar-project.properties', properties);
    const result = await harness.run('onboard');
    expect(result.exitCode).toBe(0);
    expect(invocations()[0].args).toContain('-Dsonar.projectKey=configured-key');
    expect(harness.cwd.file('sonar-project.properties').asText()).toBe(properties);
  });

  it('uses the detected project directory when called from a subdirectory', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    initGitRepo(harness.cwd.path);
    harness.cwd.writeFile('sonar-project.properties', 'sonar.projectKey=parent-key');
    harness.cwd.writeFile('src/app.js', '');
    const result = await harness.run('onboard', { cwd: join(harness.cwd.path, 'src') });
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
    const result = await harness.run('onboard --project-key explicit-key');
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
    const result = await harness.run('onboard');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('does not match the active connection');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
  });

  it('rejects existing projects without installing or scanning', async () => {
    const server = await harness.newFakeServer().withProject('existing-key').start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const result = await harness.run('onboard --project-key existing-key');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("Project 'existing-key' already exists");
    expect(harness.cliHome.file('bin').exists()).toBe(false);
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
  });

  it.each(['pom.xml', 'build.gradle.kts', 'app.csproj'])(
    'rejects builds requiring dedicated scanners: %s',
    async (file) => {
      const server = await harness.newFakeServer().start();
      harness.withAuth(server.baseUrl(), TOKEN);
      harness.cwd.writeFile(file, '');
      const result = await harness.run('onboard --project-key new-project');
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('requires SonarScanner for');
      expect(harness.cliHome.file('bin').exists()).toBe(false);
    },
  );

  it('does not scan when project creation is denied', async () => {
    const server = await harness
      .newFakeServer()
      .withOnboarding({
        createError: { status: 403, message: 'Create Projects permission required' },
      })
      .start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --project-key new-project');
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
    const result = await harness.run('onboard --project-key new-project');
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
    const result = await harness.run('onboard --project-key new-project');
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
    const result = await harness.run('onboard --project-key new-project');
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
      const result = await harness.run('onboard --project-key new-project');
      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(status.toLowerCase());
    },
  );

  it('reports a failed quality gate after successful analysis', async () => {
    const server = await harness.newFakeServer().withOnboarding({ qualityGate: 'ERROR' }).start();
    harness.withAuth(server.baseUrl(), TOKEN);
    seedScanner();
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Quality gate: ERROR');
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
    const result = await harness.run('onboard --project-key new-project');
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
      const result = await harness.run('onboard --project-key new-project', { timeoutMs: 120000 });
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
      const result = await harness.run('onboard --project-key bootstrap-test', {
        timeoutMs: 120000,
      });
      expect(result.stdout).toContain('Simulation mode.');
      expect(result.stdout).toContain('EXECUTION SUCCESS');
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
    const result = await harness.run('onboard --project-key new-project');
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain('checksum verification failed');
    expect(server.getRecordedRequests().some((r) => r.path === '/api/projects/create')).toBe(false);
    expect(readdirSync(join(harness.cliHome.path, 'bin'))).toHaveLength(0);
  });

  it('system reset removes the entire managed scanner installation', async () => {
    const server = await harness.newFakeServer().start();
    harness.withAuth(server.baseUrl(), TOKEN);
    const home = seedScanner();
    expect((await harness.run('onboard --project-key new-project')).exitCode).toBe(0);
    harness.state().withRawState(harness.stateJsonFile.asText());
    const reset = await harness.run('system reset --force');
    expect(reset.exitCode).toBe(0);
    expect(existsSync(home), reset.stdout + reset.stderr).toBe(false);
  });
});
