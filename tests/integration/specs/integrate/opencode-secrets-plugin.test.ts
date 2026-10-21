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

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { SECRETS_INACTIVE_UNAUTHENTICATED } from '@/commands/hook/hook-dependencies.ts';
import { OPENCODE_PLUGIN_MANAGED_MARKER } from '@/commands/integrate/opencode/secrets-plugin-content.ts';

import { TestHarness } from '../../harness';
import { pathWithoutOpenCode } from '../../harness/opencode-path';
import { promptEvent, readEvent, runOpenCodePlugin } from '../../harness/opencode-plugin-host';
import { IS_WINDOWS } from '../../harness/platform';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const FAKE_TOKEN = 'fake-token';
const PLUGIN_PATH = ['.config', 'opencode', 'plugins', 'sonar-secrets.ts'];

describe('integrate opencode: secrets plugin, run against the real CLI', () => {
  let harness: TestHarness;
  let pluginPath: string;

  async function installPlugin(): Promise<void> {
    harness.state().withSecretsBinaryInstalled();
    harness.withCliInPath();
    const server = await harness
      .newFakeServer()
      .withAuthToken(FAKE_TOKEN)
      .withProject('proj')
      .start();
    harness.withAuth(server.baseUrl(), FAKE_TOKEN);
    harness.cwd.writeFile(
      'sonar-project.properties',
      [`sonar.host.url=${server.baseUrl()}`, 'sonar.projectKey=proj'].join('\n'),
    );
    const install = await harness.run('integrate opencode --non-interactive', {
      extraEnv: { PATH: pathWithoutOpenCode() },
    });
    expect(install.exitCode).toBe(0);
    pluginPath = harness.userHome.file(...PLUGIN_PATH).path;
  }

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  function installSonarSpy(): { path: string; calls: () => string[] } {
    const spyDir = join(harness.userHome.path, 'sonar-spy-bin');
    const logPath = join(spyDir, 'calls.log');
    const realSonar = join(harness.userHome.path, '.local', 'bin', 'sonar');
    mkdirSync(spyDir, { recursive: true });
    const script = join(spyDir, 'sonar');
    writeFileSync(script, `#!/bin/sh\necho "$@" >> "${logPath}"\nexec "${realSonar}" "$@"\n`);
    chmodSync(script, 0o755);
    return {
      path: `${spyDir}:${join(harness.userHome.path, '.local', 'bin')}:${process.env.PATH ?? ''}`,
      calls: () =>
        existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : [],
    };
  }

  function installFakeSonar(script: string): string {
    const fakeDir = join(harness.userHome.path, 'fake-sonar-bin');
    mkdirSync(fakeDir, { recursive: true });
    const fakeSonar = join(fakeDir, 'sonar');
    writeFileSync(fakeSonar, `#!/bin/sh\n${script}\n`);
    chmodSync(fakeSonar, 0o755);
    return `${fakeDir}:${process.env.PATH ?? ''}`;
  }

  it(
    'installs a managed plugin that registers the read and prompt hooks',
    async () => {
      await installPlugin();
      expect(harness.userHome.file(...PLUGIN_PATH).asText()).toContain(
        OPENCODE_PLUGIN_MANAGED_MARKER,
      );

      const run = await runOpenCodePlugin(harness, pluginPath, []);

      expect(run.id).toBe('sonar-secrets');
      expect(run.registered.sort()).toEqual(['session.prompt', 'tool.execute.before']);
    },
    { timeout: 60000 },
  );

  it(
    'blocks reading a file that contains a secret and tells the model not to read it another way',
    async () => {
      await installPlugin();
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const secretPath = join(harness.cwd.path, 'secret.js');

      const run = await runOpenCodePlugin(harness, pluginPath, [
        readEvent('read', { path: secretPath }),
      ]);

      expect(run.results[0].error).toStartWith(
        `Sonar detected secrets in file: ${secretPath}. Do not attempt to access this file another way`,
      );
    },
    { timeout: 60000 },
  );

  it(
    'blocks a short path even when OpenCode runs the plugin from another directory',
    async () => {
      await installPlugin();
      harness.cwd.writeFile('config/token.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [readEvent('read', { path: 'config/token.js' })],
        { processCwd: harness.userHome.path },
      );

      expect(run.results[0].error).toContain('Sonar detected secrets in file');
    },
    { timeout: 60000 },
  );

  it(
    'blocks a path that starts with ~',
    async () => {
      await installPlugin();
      harness.userHome.writeFile('token.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const run = await runOpenCodePlugin(harness, pluginPath, [
        readEvent('read', { path: '~/token.js' }),
      ]);

      expect(run.results[0].error).toContain('Sonar detected secrets in file');
    },
    { timeout: 60000 },
  );

  it(
    'blocks listing a folder that contains a file with a secret',
    async () => {
      await installPlugin();
      mkdirSync(join(harness.cwd.path, 'config'), { recursive: true });
      harness.cwd.writeFile('config/token.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const run = await runOpenCodePlugin(harness, pluginPath, [
        readEvent('read', { path: 'config' }),
      ]);

      expect(run.results[0].error).toContain('Sonar detected secrets in file');
    },
    { timeout: 60000 },
  );

  it(
    'allows reading a clean file',
    async () => {
      await installPlugin();
      harness.cwd.writeFile('clean.js', 'const greeting = "hello world";');

      const run = await runOpenCodePlugin(harness, pluginPath, [
        readEvent('read', { path: 'clean.js' }),
      ]);

      expect(run.results[0].error).toBeNull();
    },
    { timeout: 60000 },
  );

  it.skipIf(IS_WINDOWS)(
    'does not even run sonar for tools other than read',
    async () => {
      await installPlugin();
      harness.cwd.writeFile('clean.js', 'const greeting = "hello world";');
      harness.cwd.writeFile('secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      const spy = installSonarSpy();

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [readEvent('write', { path: 'secret.js' }), readEvent('read', { path: 'clean.js' })],
        { env: { PATH: spy.path } },
      );

      expect(run.results.map((result) => result.error)).toEqual([null, null]);
      expect(spy.calls()).toEqual(['hook opencode-pre-tool-use']);
    },
    { timeout: 60000 },
  );

  it(
    'blocks the read when sonar cannot be run (fail closed)',
    async () => {
      await installPlugin();
      harness.cwd.writeFile('clean.js', 'const greeting = "hello world";');

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [readEvent('read', { path: 'clean.js' })],
        { env: { PATH: harness.cwd.path } },
      );

      expect(run.results[0].error).toContain('could not verify this file for secrets');
    },
    { timeout: 60000 },
  );

  it(
    'masks a secret in a prompt and says so in the message itself',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(harness, pluginPath, [
        promptEvent(`my token is ${GITHUB_TEST_TOKEN}, can you use it`),
      ]);

      expect(run.results[0].error).toBeNull();
      const text = run.results[0].event.prompt.text as string;
      expect(text).not.toContain(GITHUB_TEST_TOKEN);
      expect(text).toContain('my token is ghp');
      expect(text).toEndWith(
        '[Sonar] A secret was detected in this message and masked before it was sent.',
      );
    },
    { timeout: 60000 },
  );

  it(
    'adds the explanation once, even when the message holds several secrets',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(harness, pluginPath, [
        promptEvent(`first ${GITHUB_TEST_TOKEN} and second ${GITHUB_TEST_TOKEN}`),
      ]);

      expect(run.results[0].error).toBeNull();
      const text = run.results[0].event.prompt.text as string;
      expect(text).not.toContain(GITHUB_TEST_TOKEN);
      expect(text.split('[Sonar] A secret was detected')).toHaveLength(2);
    },
    { timeout: 60000 },
  );

  it(
    'leaves a prompt without secrets untouched',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(harness, pluginPath, [promptEvent('fix the login bug')]);

      expect(run.results[0].error).toBeNull();
      expect(run.results[0].event.prompt.text).toBe('fix the login bug');
    },
    { timeout: 60000 },
  );

  it(
    'replaces the prompt with a placeholder when the user is not signed in',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [promptEvent(`my token is ${GITHUB_TEST_TOKEN}`)],
        { env: { SONARQUBE_CLI_KEYCHAIN_FILE: join(harness.cwd.path, 'empty-keychain.json') } },
      );

      expect(run.results[0].error).toBeNull();
      expect(run.results[0].event.prompt.text).toStartWith(
        `[Sonar] Message blocked: ${SECRETS_INACTIVE_UNAUTHENTICATED.replace(/\.$/, '')}. Blocked as a precaution`,
      );
      expect(run.results[0].event.prompt.text).not.toContain(GITHUB_TEST_TOKEN);
    },
    { timeout: 60000 },
  );

  it.skipIf(IS_WINDOWS)(
    'blocks the read when sonar answers something that is not a decision',
    async () => {
      await installPlugin();
      harness.cwd.writeFile('clean.js', 'const greeting = "hello world";');

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [readEvent('read', { path: 'clean.js' })],
        { env: { PATH: installFakeSonar(`echo '{}'`) } },
      );

      expect(run.results[0].error).toContain('could not verify this file for secrets');
    },
    { timeout: 60000 },
  );

  it.skipIf(IS_WINDOWS)(
    'replaces the prompt with a placeholder when sonar answers a redacted text that is not a string',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(harness, pluginPath, [promptEvent('fix the login bug')], {
        env: { PATH: installFakeSonar(`echo '{"block":false,"redactedText":null}'`) },
      });

      expect(run.results[0].event.prompt.text).toStartWith(
        '[Sonar] Message blocked: could not verify this message for secrets',
      );
    },
    { timeout: 60000 },
  );

  it.skipIf(IS_WINDOWS)(
    'does not crash on a very large prompt when sonar stops without reading it',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [promptEvent('x'.repeat(5_000_000))],
        { env: { PATH: installFakeSonar('exit 1') } },
      );

      expect(run.results[0].error).toBeNull();
      expect(run.results[0].event.prompt.text).toStartWith(
        '[Sonar] Message blocked: could not verify this message for secrets',
      );
    },
    { timeout: 60000 },
  );

  it(
    'drops the positions of mentioned files, agents and skills when it masks a secret',
    async () => {
      await installPlugin();
      const mention = { start: 0, end: 5 };

      const run = await runOpenCodePlugin(harness, pluginPath, [
        promptEvent(`@a.ts my token is ${GITHUB_TEST_TOKEN} @b`, {
          files: [{ uri: 'file:///a.ts', mention }],
          agents: [{ name: 'b', mention }],
          skills: [{ id: 'c', mention }],
        }),
      ]);

      const prompt = run.results[0].event.prompt;
      expect(prompt.files).toEqual([{ uri: 'file:///a.ts' }]);
      expect(prompt.agents).toEqual([{ name: 'b' }]);
      expect(prompt.skills).toEqual([{ id: 'c' }]);
    },
    { timeout: 60000 },
  );

  it(
    'drops the positions of mentioned files when the prompt is replaced by the placeholder',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [
          promptEvent('@a.ts fix it', {
            files: [{ uri: 'file:///a.ts', mention: { start: 0, end: 5 } }],
          }),
        ],
        { env: { PATH: harness.cwd.path } },
      );

      expect(run.results[0].event.prompt.files).toEqual([{ uri: 'file:///a.ts' }]);
    },
    { timeout: 60000 },
  );

  it(
    'keeps the positions of mentioned files when the prompt has no secret',
    async () => {
      await installPlugin();
      const files = [{ uri: 'file:///a.ts', mention: { start: 0, end: 5 } }];

      const run = await runOpenCodePlugin(harness, pluginPath, [
        promptEvent('@a.ts fix the login bug', { files }),
      ]);

      expect(run.results[0].event.prompt.files).toEqual(files);
    },
    { timeout: 60000 },
  );

  it(
    'replaces the prompt with a placeholder when sonar cannot be run (fail closed)',
    async () => {
      await installPlugin();

      const run = await runOpenCodePlugin(
        harness,
        pluginPath,
        [promptEvent(`my token is ${GITHUB_TEST_TOKEN}`)],
        { env: { PATH: harness.cwd.path } },
      );

      const text = run.results[0].event.prompt.text as string;
      expect(text).toStartWith(
        '[Sonar] Message blocked: could not verify this message for secrets',
      );
      expect(text).not.toContain(GITHUB_TEST_TOKEN);
    },
    { timeout: 60000 },
  );
});
