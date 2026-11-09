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
  let backendRequests: string[];

  async function command(args: string[], cwd = fixtures) {
    const proc = Bun.spawn(args, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SCANNER_TEST_ARCHIVE: join(fixtures, 'scanner.zip'),
        SCANNER_TEST_DESTINATION: fixtures,
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
    writeFileSync(
      join(fixtures, 'payload.ts'),
      'await Bun.write(process.env.EXECUTION_MARKER!, "repository executable ran");',
    );
    await command([
      process.execPath,
      'build',
      '--compile',
      'payload.ts',
      '--outfile',
      windows ? 'payload.exe' : 'payload',
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
    backendRequests = [];
    const engine = readFileSync(join(fixtures, 'engine.jar'));
    const legacyEngine = readFileSync(join(fixtures, 'legacy-engine.jar'));
    backend = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        backendRequests.push(url.pathname);
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

  for (const detach of [false, true]) {
    it.each(['root', 'escaped', 'module'])(
      'prevents %s repository execution and completes analysis' + (detach ? ' detached' : ''),
      async (variant) => {
        copyFileSync(join(fixtures, 'payload.jar'), join(harness.cwd.path, 'payload.jar'));
        const executable = windows ? 'payload.exe' : 'payload';
        copyFileSync(join(fixtures, executable), join(harness.cwd.path, executable));
        const javaPath = join(harness.cwd.path, executable).replaceAll('\\', '/');
        const jarPath = join(harness.cwd.path, 'payload.jar').replaceAll('\\', '/');
        const properties = [
          'sonar.sources=.',
          'sonar.test.benign=kept',
          `sonar.scanner.javaExePath=${javaPath}`,
          `sonar.scanner.javaOpts=-javaagent:${jarPath}`,
          `sonar.scanner.engineJarPath=${jarPath}`,
          'sonar.userHome=.repository-cache',
        ];
        if (variant === 'escaped') {
          properties[2] = `sonar.scanner.javaExe\\u0050ath=${javaPath}`;
          properties[3] = `sonar.scanner.java\\\n Opts=-javaagent:${jarPath}`;
          properties[4] = `sonar.scanner.engine\\\n JarPath=${jarPath}`;
          properties[5] = 'sonar.user\\u0048ome=.repository-cache';
        }
        if (variant === 'module') {
          properties.splice(2, 4, 'sonar.modules=sonar');
          harness.cwd.writeFile(
            'sonar/sonar-project.properties',
            'scanner.engineJarPath=payload.jar\nuserHome=.repository-cache\n',
          );
          copyFileSync(
            join(fixtures, 'payload.jar'),
            join(harness.cwd.path, 'sonar', 'payload.jar'),
          );
        }
        harness.cwd.writeFile('sonar-project.properties', properties.join('\n'));
        const result = await harness.run(
          `init --non-interactive --project fixture-project --name Fixture --scanner-property sonar.exclusions=ignored/**${detach ? ' --detach' : ''}`,
          {
            timeoutMs: 30_000,
            extraEnv: {
              SONARQUBE_CLI_SONARCLOUD_URL: `http://localhost:${backend.port}`,
              SONARQUBE_CLI_SONARCLOUD_API_URL: `http://localhost:${backend.port}`,
            },
          },
        );
        expect(
          result.exitCode,
          result.stdout + result.stderr + JSON.stringify(backendRequests),
        ).toBe(0);
        const deadline = Date.now() + 15_000;
        while (completed.length === 0 && Date.now() < deadline) await Bun.sleep(50);
        expect(completed).toHaveLength(1);
        expect(completed[0]['sonar.test.benign']).toBe('kept');
        expect(completed[0]['sonar.exclusions']).toBe('ignored/**');
        expect(completed[0]['sonar.userHome']).toBe(
          join(completed[0]['sonar.scanner.metadataFilePath'], '..', 'scanner-home'),
        );
        expect(engineRequests).toEqual(['application/json', 'application/octet-stream']);
        expect(existsSync(join(harness.cwd.path, 'repository-executed'))).toBe(false);
        expect(result.stdout).toContain(
          detach ? 'Analysis started in the background' : 'Analysis completed',
        );
        if (detach) expect(existsSync(completed[0]['sonar.scanner.metadataFilePath'])).toBe(true);
      },
      60_000,
    );
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
    const home = variant === 'escaped' ? 'sonar.user\\u0048ome' : 'sonar.userHome';
    harness.cwd.writeFile(
      'sonar-project.properties',
      `sonar.projectKey=fixture-project\nsonar.sources=.\nsonar.test.benign=kept\n${variant === 'module' ? 'sonar.modules=sonar' : `${home}=${cache}`}\n`,
    );
    if (variant === 'module')
      harness.cwd.writeFile('sonar/sonar-project.properties', `userHome=${cache}\n`);
    return url;
  }

  it('demonstrates an unpinned legacy scanner executes a poisoned cache without downloading it', async () => {
    const url = plantLegacyCache('root');
    const proc = Bun.spawn(
      [
        java!,
        '-jar',
        join(scannerHome, 'lib', `sonar-scanner-cli-${SONAR_SCANNER_VERSION}.jar`),
        `-Dsonar.host.url=${url}`,
        `-Dsonar.scanner.metadataFilePath=${join(harness.cwd.path, 'report-task.txt')}`,
      ],
      {
        cwd: harness.cwd.path,
        env: {
          ...process.env,
          SONAR_TOKEN: token,
          ENGINE_BACKEND: `${url}/engine-complete`,
          EXECUTION_MARKER: join(harness.cwd.path, 'repository-executed'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(0);
    expect(readFileSync(join(harness.cwd.path, 'repository-executed'), 'utf8')).toBe(token);
    expect(engineRequests).toEqual(['/batch/index']);
  }, 30_000);

  for (const detach of [false, true]) {
    it.each(['root', 'escaped', 'module'])(
      'ignores a %s repository cache on legacy Server' + (detach ? ' detached' : ''),
      async (variant) => {
        plantLegacyCache(variant);
        const result = await harness.run(
          `init --non-interactive --project fixture-project --name Fixture --scanner-property sonar.exclusions=ignored/**${detach ? ' --detach' : ''}`,
          { timeoutMs: 30_000 },
        );
        expect(
          result.exitCode,
          result.stdout + result.stderr + JSON.stringify(backendRequests),
        ).toBe(0);
        const deadline = Date.now() + 15_000;
        while (completed.length === 0 && Date.now() < deadline) await Bun.sleep(50);
        expect(completed).toHaveLength(1);
        expect(completed[0]['sonar.test.benign']).toBe('kept');
        expect(completed[0]['sonar.exclusions']).toBe('ignored/**');
        expect(completed[0]['sonar.userHome']).toBe(
          join(completed[0]['sonar.scanner.metadataFilePath'], '..', 'scanner-home'),
        );
        expect(engineRequests).toEqual(['/batch/index', '/batch/file']);
        expect(existsSync(join(harness.cwd.path, 'repository-executed'))).toBe(false);
        expect(result.stdout).toContain(
          detach ? 'Analysis started in the background' : 'Analysis completed',
        );
      },
      60_000,
    );
  }
});
