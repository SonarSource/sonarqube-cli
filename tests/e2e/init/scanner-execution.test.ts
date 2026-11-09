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

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { SONAR_SCANNER_VERSION } from '@/core/host/install/sonar-scanner.ts';
import { parseProperties } from '@/core/io/properties.ts';

import { TestHarness } from '../../integration/harness';

const java = Bun.which('java');
const javac = Bun.which('javac');
const jar = Bun.which('jar');
const archiveTool = Bun.which(process.platform === 'win32' ? 'powershell.exe' : 'unzip');
const token = 'dummy-scanner-token';
const windows = process.platform === 'win32';

// External Java tools and the pinned public scanner distribution are the e2e prerequisites.
describe.skipIf(!java || !javac || !jar || !archiveTool)('init with the real scanner', () => {
  let fixtures: string;
  let scannerHome: string;
  let harness: TestHarness;
  let backend: ReturnType<typeof Bun.serve>;
  let completed: Record<string, string>[];
  let engineRequests: string[];
  let legacy: boolean;
  async function command(args: string[], cwd = fixtures, env: NodeJS.ProcessEnv = {}) {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SCANNER_TEST_ARCHIVE: join(fixtures, 'scanner.zip'),
        SCANNER_TEST_DESTINATION: fixtures,
        ...env,
      },
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`${args[0]} failed: ${stdout}${stderr}`);
  }

  beforeAll(async () => {
    fixtures = mkdtempSync(join(tmpdir(), 'scanner-execution-e2e-'));
    scannerHome =
      process.env.SONAR_SCANNER_E2E_HOME ??
      join(fixtures, `sonar-scanner-${SONAR_SCANNER_VERSION}`);
    if (!process.env.SONAR_SCANNER_E2E_HOME) {
      const response = await fetch(
        `https://binaries.sonarsource.com/Distribution/sonar-scanner-cli/sonar-scanner-cli-${SONAR_SCANNER_VERSION}.zip`,
      );
      if (!response.ok) throw new Error(`Scanner download failed: ${response.status}`);
      const archive = join(fixtures, 'scanner.zip');
      writeFileSync(archive, new Uint8Array(await response.arrayBuffer()));
      await command(
        windows
          ? [
              archiveTool!,
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Expand-Archive -LiteralPath $env:SCANNER_TEST_ARCHIVE -DestinationPath $env:SCANNER_TEST_DESTINATION',
            ]
          : [archiveTool!, '-q', archive, '-d', fixtures],
      );
    }
    writeFileSync(
      join(fixtures, 'FixtureEngine.java'),
      `
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
public class FixtureEngine {
  public static void main(String[] args) throws Exception {
    byte[] input = System.in.readAllBytes();
    Thread.sleep(2000);
    var request = HttpRequest.newBuilder(URI.create(System.getenv("ENGINE_BACKEND")))
      .POST(HttpRequest.BodyPublishers.ofByteArray(input)).build();
    if (HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding()).statusCode() != 200)
      throw new IllegalStateException("Fixture backend rejected analysis");
  }
}
class RepositoryPayload {
  public static void main(String[] args) throws Exception { mark(); }
  public static void premain(String args) throws Exception { mark(); }
  private static void mark() throws Exception {
    Files.writeString(Path.of(System.getenv("EXECUTION_MARKER")), "repository code executed");
  }
}
`,
    );
    await command([javac!, '--release', '17', 'FixtureEngine.java']);
    await command([
      jar!,
      '--create',
      '--file',
      'engine.jar',
      '--main-class',
      'FixtureEngine',
      'FixtureEngine.class',
    ]);
    writeFileSync(
      join(fixtures, 'payload.mf'),
      'Main-Class: RepositoryPayload\nPremain-Class: RepositoryPayload\n\n',
    );
    await command([
      jar!,
      '--create',
      '--file',
      'payload.jar',
      '--manifest',
      'payload.mf',
      'RepositoryPayload.class',
    ]);
    const legacySources = {
      'EnvironmentInformation.java': `
package org.sonar.batch.bootstrapper;
import java.nio.file.*;
public class EnvironmentInformation {
  public EnvironmentInformation(String app, String version) throws Exception {
    if (getClass().getResource("/repository-payload") != null)
      Files.writeString(Path.of(System.getenv("EXECUTION_MARKER")), System.getenv("SONAR_TOKEN"));
  }
}`,
      'LogOutput.java': `
package org.sonar.batch.bootstrapper;
public interface LogOutput {
  enum Level { TRACE, DEBUG, INFO, WARN, ERROR }
  void log(String message, Level level);
}`,
      'Batch.java': `
package org.sonar.batch.bootstrapper;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.util.*;
public class Batch {
  private Map<String, String> properties;
  public static Builder builder() { return new Builder(); }
  public Batch execute() throws Exception {
    Thread.sleep(2000);
    Properties values = new Properties();
    values.putAll(properties);
    StringWriter input = new StringWriter();
    values.store(input, null);
    var request = HttpRequest.newBuilder(URI.create(System.getenv("ENGINE_BACKEND") + "?legacy"))
      .POST(HttpRequest.BodyPublishers.ofString(input.toString())).build();
    if (HttpClient.newHttpClient().send(request, HttpResponse.BodyHandlers.discarding()).statusCode() != 200)
      throw new IllegalStateException("Fixture backend rejected legacy analysis");
    return this;
  }
  public static class Builder {
    private final Batch batch = new Batch();
    public Builder setEnvironment(EnvironmentInformation value) { return this; }
    public Builder setGlobalProperties(Map<String, String> value) { batch.properties = value; return this; }
    public Builder setLogOutput(LogOutput value) { return this; }
    public Batch build() { return batch; }
  }
}`,
    };
    for (const [name, source] of Object.entries(legacySources))
      writeFileSync(join(fixtures, name), source);
    await command([javac!, '--release', '17', '-d', 'legacy', ...Object.keys(legacySources)]);
    await command([jar!, '--create', '--file', 'legacy-engine.jar', '-C', 'legacy', '.']);
    writeFileSync(join(fixtures, 'legacy', 'repository-payload'), 'harmless cache-hit marker');
    await command([jar!, '--create', '--file', 'legacy-payload.jar', '-C', 'legacy', '.']);
  }, 120_000);

  afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

  beforeEach(async () => {
    harness = await TestHarness.create();
    mkdirSync(harness.cwd.path, { recursive: true });
    const fake = await harness.newFakeServer().asSonarCloud().withAuthToken(token).start();
    completed = [];
    engineRequests = [];
    legacy = false;
    const engine = readFileSync(join(fixtures, 'engine.jar'));
    const legacyEngine = readFileSync(join(fixtures, 'legacy-engine.jar'));
    backend = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (legacy && url.pathname === '/api/system/status')
          return Response.json({ status: 'UP', version: '10.5.0.1' });
        if (legacy && ['/api/v2/analysis/version', '/api/server/version'].includes(url.pathname))
          return new Response('10.5.0.1');
        if (url.pathname === '/batch/index') {
          engineRequests.push(url.pathname);
          return new Response(`engine.jar|${createHash('md5').update(legacyEngine).digest('hex')}`);
        }
        if (url.pathname === '/batch/file') {
          engineRequests.push(url.pathname);
          return new Response(legacyEngine);
        }
        if (url.pathname === '/analysis/engine') {
          engineRequests.push(request.headers.get('Accept') ?? '');
          if (request.headers.get('Authorization') !== `Bearer ${token}`)
            return new Response(null, { status: 401 });
          return request.headers.get('Accept') === 'application/octet-stream'
            ? new Response(engine)
            : Response.json({
                sha256: createHash('sha256').update(engine).digest('hex'),
                filename: '../../payload.jar',
              });
        }
        if (url.pathname === '/engine-complete') {
          const properties = url.searchParams.has('legacy')
            ? Object.fromEntries(parseProperties(await request.text()))
            : Object.fromEntries(
                (
                  (await request.json()) as { scannerProperties: { key: string; value: string }[] }
                ).scannerProperties.map(({ key, value }) => [key, value]),
              );
          writeFileSync(
            properties['sonar.scanner.metadataFilePath'],
            `ceTaskId=fixture-task\nprojectKey=${properties['sonar.projectKey']}\n`,
          );
          completed.push(properties);
          return new Response('ok');
        }
        if (url.pathname === '/api/ce/task')
          return Response.json({
            task: {
              id: 'fixture-task',
              componentKey: 'fixture-project',
              status: 'SUCCESS',
              analysisId: 'fixture-analysis',
            },
          });
        if (url.pathname === '/api/qualitygates/project_status')
          return Response.json({ projectStatus: { status: 'OK' } });
        if (url.pathname === '/api/issues/search') return Response.json({ total: 0 });
        return fetch(`${fake.baseUrl()}${url.pathname}${url.search}`, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
        });
      },
    });
    const url = `http://localhost:${backend.port}`;
    harness.withAuth('https://sonarcloud.io', token, 'my-org').withExtraEnv({
      SONARQUBE_CLI_ALPHA: 'true',
      SONARQUBE_CLI_SONARCLOUD_URL: url,
      SONARQUBE_CLI_SONARCLOUD_API_URL: url,
      PATH: `${join(scannerHome, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
      JAVA_HOME: join(java!, '..', '..'),
      ENGINE_BACKEND: `${url}/engine-complete`,
      EXECUTION_MARKER: join(harness.cwd.path, 'repository-executed'),
    });
  });

  afterEach(async () => {
    await backend?.stop(true);
    await harness?.dispose();
  });

  function plantModernProperties(variant: string) {
    copyFileSync(join(fixtures, 'payload.jar'), join(harness.cwd.path, 'payload.jar'));
    const jarPath = join(harness.cwd.path, 'payload.jar').replaceAll('\\', '/');
    const properties = ['sonar.sources=.', 'sonar.test.benign=kept'];
    if (variant === 'module') {
      properties.push('sonar.modules=sonar');
      harness.cwd.writeFile(
        'sonar/sonar-project.properties',
        'scanner.engineJarPath=payload.jar\nuserHome=.repository-cache\n',
      );
      copyFileSync(join(fixtures, 'payload.jar'), join(harness.cwd.path, 'sonar', 'payload.jar'));
    } else {
      const missingJava = join(harness.cwd.path, 'missing-java').replaceAll('\\', '/');
      properties.push(
        `sonar.scanner.javaExe\\u0050ath=${missingJava}`,
        `sonar.scanner.java\\\n Opts=-javaagent:${jarPath}`,
        `sonar.scanner.engine\\\n JarPath=${jarPath}`,
        'sonar.user\\u0048ome=.repository-cache',
      );
    }
    harness.cwd.writeFile('sonar-project.properties', properties.join('\n'));
  }

  function plantLegacyCache(variant: string) {
    legacy = true;
    const url = `http://127.0.0.1:${backend.port}`;
    harness.withAuth(url, token).withExtraEnv({
      SONARQUBE_CLI_SONARCLOUD_URL: 'https://sonarcloud.io',
      SONARQUBE_CLI_SONARCLOUD_API_URL: 'https://api.sonarcloud.io',
    });
    const cache = '.repository-cache';
    const hash = createHash('md5')
      .update(readFileSync(join(fixtures, 'legacy-engine.jar')))
      .digest('hex');
    const cachedDirectory = join(harness.cwd.path, cache, 'cache', hash);
    mkdirSync(cachedDirectory, { recursive: true });
    copyFileSync(join(fixtures, 'legacy-payload.jar'), join(cachedDirectory, 'engine.jar'));
    harness.cwd.writeFile(
      'sonar-project.properties',
      `sonar.projectKey=fixture-project\nsonar.sources=.\nsonar.test.benign=kept\n${variant === 'module' ? 'sonar.modules=sonar' : `sonar.userHome=${cache}`}\n`,
    );
    if (variant === 'module')
      harness.cwd.writeFile('sonar/sonar-project.properties', `userHome=${cache}\n`);
    return url;
  }

  it('demonstrates an unpinned legacy scanner executes a poisoned cache without downloading it', async () => {
    const url = plantLegacyCache('root');
    await command(
      [
        java!,
        '-jar',
        join(scannerHome, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`),
        `-Dsonar.host.url=${url}`,
        `-Dsonar.scanner.metadataFilePath=${join(harness.cwd.path, 'report-task.txt')}`,
      ],
      harness.cwd.path,
      {
        SONAR_TOKEN: token,
        ENGINE_BACKEND: `${url}/engine-complete`,
        EXECUTION_MARKER: join(harness.cwd.path, 'repository-executed'),
      },
    );
    expect(readFileSync(join(harness.cwd.path, 'repository-executed'), 'utf8')).toBe(token);
    expect(engineRequests).toEqual(['/batch/index']);
  }, 30_000);

  it.each([
    ['modern escaped/continued foreground', false, 'escaped', false],
    ['modern module detached', false, 'module', true],
    ['legacy root foreground', true, 'root', false],
    ['legacy module detached', true, 'module', true],
  ] as const)(
    'prevents repository execution: %s',
    async (_name, legacyBootstrap, variant, detach) => {
      if (legacyBootstrap) plantLegacyCache(variant);
      else plantModernProperties(variant);
      const result = await harness.run(
        `init --non-interactive --project fixture-project --name Fixture --scanner-property sonar.exclusions=ignored/**${detach ? ' --detach' : ''}`,
        {
          timeoutMs: 30_000,
          extraEnv: legacyBootstrap
            ? {}
            : {
                SONARQUBE_CLI_SONARCLOUD_URL: `http://localhost:${backend.port}`,
                SONARQUBE_CLI_SONARCLOUD_API_URL: `http://localhost:${backend.port}`,
              },
        },
      );
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      const deadline = Date.now() + 15_000;
      while (completed.length === 0 && Date.now() < deadline) await Bun.sleep(50);
      expect(completed).toHaveLength(1);
      const properties = completed[0];
      const report = properties['sonar.scanner.metadataFilePath'];
      const directory = join(report, '..');
      expect(properties['sonar.test.benign']).toBe('kept');
      expect(properties['sonar.exclusions']).toBe('ignored/**');
      expect(properties['sonar.userHome']).toBe(join(directory, 'scanner-home'));
      expect(engineRequests).toEqual(
        legacyBootstrap
          ? ['/batch/index', '/batch/file']
          : ['application/json', 'application/octet-stream'],
      );
      expect(existsSync(join(harness.cwd.path, 'repository-executed'))).toBe(false);
      expect(result.stdout).toContain(
        detach ? 'Analysis started in the background' : 'Analysis completed',
      );
      expect(existsSync(report)).toBe(detach);
      expect(existsSync(directory)).toBe(detach);
      if (!legacyBootstrap) {
        expect(properties['sonar.scanner.engineJarPath']).toBe(
          join(directory, 'scanner-engine.jar'),
        );
        expect(existsSync(properties['sonar.scanner.engineJarPath'])).toBe(detach);
      }
    },
    60_000,
  );
});
