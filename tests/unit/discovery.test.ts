/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Discovery module tests

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverProject, discoverProjectInfo } from '../../src/cli/commands/_common/discovery';
import * as processLib from '../../src/lib/process.js';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../src/ui';

it('discovery: sonar-project.properties parsing', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-discovery-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `
# SonarQube properties
sonar.host.url=https://sonarcloud.io
sonar.projectKey=my_project
sonar.projectName=My Project
sonar.organization=my-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProjectInfo(testDir);

    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData).toMatchObject({
      hostURL: 'https://sonarcloud.io',
      projectKey: 'my_project',
      projectName: 'My Project',
      organization: 'my-org',
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint/connectedMode.json parsing', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-sonarlint-' + Date.now());
  const sonarlintDir = join(testDir, '.sonarlint');
  mkdirSync(sonarlintDir, { recursive: true });

  try {
    const configContent = {
      sonarQubeUri: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org',
    };
    writeFileSync(join(sonarlintDir, 'connectedMode.json'), JSON.stringify(configContent, null, 2));

    const info = await discoverProjectInfo(testDir);

    expect(info.hasSonarLintConfig).toBe(true);
    expect(info.sonarLintData).toMatchObject({
      serverURL: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org',
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: sonar-project.properties with comments and empty lines', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-comments-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `
# This is a comment
sonar.host.url=https://test.com

# Another comment
sonar.projectKey=test_key

# Empty line above
sonar.organization=test-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProjectInfo(testDir);

    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData).toMatchObject({
      hostURL: 'https://test.com',
      projectKey: 'test_key',
      organization: 'test-org',
    });
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: no configuration files', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-empty-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const info = await discoverProjectInfo(testDir);

    expect(info.hasSonarProps).toBe(false);
    expect(info.hasSonarLintConfig).toBe(false);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: detects git repository when .git dir present', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-gitrepo-' + Date.now());
  mkdirSync(join(testDir, '.git'), { recursive: true });

  try {
    const info = await discoverProjectInfo(testDir);
    expect(info.isGitRepo).toBe(true);
    expect(info.root).toBe(testDir);
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: reads git remote when git repository has origin', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-gitremote-' + Date.now());
  mkdirSync(join(testDir, '.git'), { recursive: true });

  const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
    exitCode: 0,
    stdout: 'https://github.com/example/test-project.git',
    stderr: '',
  });

  try {
    const info = await discoverProjectInfo(testDir);
    expect(info.isGitRepo).toBe(true);
    expect(info.gitRemote).toBe('https://github.com/example/test-project.git');
  } finally {
    spawnSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: sonar-project.properties with line missing equals sign', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-noeq-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_key\nINVALID_LINE_NO_EQUALS\n`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarProps).toBe(true);
    expect(info.sonarPropsData?.projectKey).toBe('my_key');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: sonar-project.properties with no hostURL or projectKey returns null props', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-norelevantkeys-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `sonar.projectName=My Project\nsonar.organization=my-org\n`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarProps).toBe(false);
    expect(info.sonarPropsData).toBeNull();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint/settings.json with serverId schema', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-serverid-' + Date.now());
  mkdirSync(join(testDir, '.sonarlint'), { recursive: true });

  try {
    const configContent = {
      serverId: 'my-sonarqube-server',
      projectKey: 'my_project',
      organization: '',
    };
    writeFileSync(join(testDir, '.sonarlint', 'settings.json'), JSON.stringify(configContent));

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarLintConfig).toBe(true);
    expect(info.sonarLintData?.serverURL).toBe('my-sonarqube-server');
    expect(info.sonarLintData?.projectKey).toBe('my_project');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint/connected-mode.json with connectionId schema', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-connid-' + Date.now());
  mkdirSync(join(testDir, '.sonarlint'), { recursive: true });

  try {
    const configContent = {
      connectionId: 'https://sonarqube.example.com',
      projectKey: 'conn_project',
      organization: 'conn-org',
    };
    writeFileSync(
      join(testDir, '.sonarlint', 'connected-mode.json'),
      JSON.stringify(configContent),
    );

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarLintConfig).toBe(true);
    expect(info.sonarLintData?.serverURL).toBe('https://sonarqube.example.com');
    expect(info.sonarLintData?.projectKey).toBe('conn_project');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint config with no matching schema returns null', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-nomatch-' + Date.now());
  mkdirSync(join(testDir, '.sonarlint'), { recursive: true });

  try {
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ unknownField: 'value', anotherField: 123 }),
    );

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarLintConfig).toBe(false);
    expect(info.sonarLintData).toBeNull();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discovery: .sonarlint config with invalid JSON returns null', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-invalidjson-' + Date.now());
  mkdirSync(join(testDir, '.sonarlint'), { recursive: true });

  try {
    writeFileSync(join(testDir, '.sonarlint', 'connectedMode.json'), '{ not valid json ]');

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarLintConfig).toBe(false);
    expect(info.sonarLintData).toBeNull();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('discoverProject', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sonarqube-cli-test-discover-project-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
    setMockUi(true);
  });

  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns current dir as rootDir when not in a git repo', async () => {
    const result = await discoverProject(testDir);
    expect(result.rootDir).toBe(testDir);
  });

  it('returns isGitRepo false when no .git directory is present', async () => {
    const result = await discoverProject(testDir);
    expect(result.isGitRepo).toBe(false);
  });

  it('returns isGitRepo true and rootDir as git root when .git directory is present', async () => {
    mkdirSync(join(testDir, '.git'));
    const result = await discoverProject(testDir);
    expect(result.isGitRepo).toBe(true);
    expect(result.rootDir).toBe(testDir);
  });

  it('returns no serverUrl, projectKey, or organization when no config files are present', async () => {
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBeUndefined();
    expect(result.projectKey).toBeUndefined();
    expect(result.organization).toBeUndefined();
  });

  it('shows no config-found messages when no config files are present', async () => {
    await discoverProject(testDir);
    const textCalls = getMockUiCalls().filter((c) => c.method === 'text');
    expect(textCalls).toHaveLength(0);
  });

  it('maps sonar-project.properties hostURL to serverUrl', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_project\n',
    );
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBe('https://sonarcloud.io');
  });

  it('maps sonar-project.properties projectKey', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_project\n',
    );
    const result = await discoverProject(testDir);
    expect(result.projectKey).toBe('my_project');
  });

  it('maps sonar-project.properties organization', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_project\nsonar.organization=my-org\n',
    );
    const result = await discoverProject(testDir);
    expect(result.organization).toBe('my-org');
  });

  it('shows "Found sonar-project.properties" UI message when sonar properties are found', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_project\n',
    );
    await discoverProject(testDir);
    const msg = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Found sonar-project.properties',
    );
    expect(msg).toBeDefined();
  });

  it('maps sonarlint serverURL to serverUrl', async () => {
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarqube.example.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBe('https://sonarqube.example.com');
  });

  it('maps sonarlint projectKey', async () => {
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarqube.example.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir);
    expect(result.projectKey).toBe('lint_project');
  });

  it('maps sonarlint organization', async () => {
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({
        sonarQubeUri: 'https://sonarqube.example.com',
        projectKey: 'lint_project',
        organization: 'lint-org',
      }),
    );
    const result = await discoverProject(testDir);
    expect(result.organization).toBe('lint-org');
  });

  it('shows "Found .sonarlint/connectedMode.json" UI message when sonarlint config is found', async () => {
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarqube.example.com', projectKey: 'lint_project' }),
    );
    await discoverProject(testDir);
    const msg = getMockUiCalls().find(
      (c) => c.method === 'text' && String(c.args[0]) === 'Found .sonarlint/connectedMode.json',
    );
    expect(msg).toBeDefined();
  });

  it('sonar-project.properties takes precedence over sonarlint for serverUrl', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBe('https://props-server.io');
  });

  it('sonar-project.properties takes precedence over sonarlint for projectKey', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir);
    expect(result.projectKey).toBe('props_project');
  });

  it('sonarlint fills in projectKey when sonar-project.properties does not define one', async () => {
    // sonar props with only hostURL (passes the null-check, but projectKey is absent)
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'lint_project' }),
    );
    const result = await discoverProject(testDir);
    expect(result.projectKey).toBe('lint_project');
  });

  it('sonarlint fills in organization when sonar-project.properties does not define one', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({
        sonarQubeUri: 'https://sonarlint-server.com',
        projectKey: 'lint_project',
        organization: 'lint-org',
      }),
    );
    const result = await discoverProject(testDir);
    expect(result.organization).toBe('lint-org');
  });

  it('shows both config-found messages when both configs are present', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'lint_project' }),
    );
    await discoverProject(testDir);
    const textCalls = getMockUiCalls()
      .filter((c) => c.method === 'text')
      .map((c) => String(c.args[0]));
    expect(textCalls).toContain('Found sonar-project.properties');
    expect(textCalls).toContain('Found .sonarlint/connectedMode.json');
  });
});
