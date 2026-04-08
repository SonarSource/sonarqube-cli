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

import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SONARCLOUD_URL, SONARCLOUD_US_URL } from '../../../src/lib/config-constants';
import logger from '../../../src/lib/logger';
import {
  discoverOrganization,
  discoverProject,
  discoverProjectInfo,
  discoverServer,
} from '../../../src/lib/project-workspace';
import * as projectWorkspace from '../../../src/lib/project-workspace';
import * as processLib from '../../../src/lib/process.js';
import { clearMockUiCalls, getMockUiCalls, setMockUi } from '../../../src/ui';

async function withCwd<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

it('discoverProjectInfo: parses sonar-project.properties (comments, empty lines, all keys)', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-props-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    const propsContent = `
# SonarQube properties
sonar.host.url=https://sonarcloud.io

# Another comment
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

it('discoverProjectInfo: no configuration files', async () => {
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

it('discoverProjectInfo: detects git repository when .git dir present', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-gitrepo-' + Date.now());
  mkdirSync(join(testDir, '.git'), { recursive: true });

  try {
    const info = await discoverProjectInfo(testDir);
    expect(info.isGitRepo).toBe(true);
    expect(info.root).toBe(realpathSync(testDir));
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discoverProjectInfo: reads git remote when git repository has origin', async () => {
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

it('discoverProjectInfo: ignores property line without equals sign', async () => {
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

it('discoverProjectInfo: uses resolve() when startDir does not exist (canonicalizePath fallback)', async () => {
  const ghostDir = join(tmpdir(), `sonarqube-cli-ghost-${Date.now()}`);
  const info = await discoverProjectInfo(ghostDir);
  expect(info.root).toBe(resolve(ghostDir));
  expect(info.hasSonarProps).toBe(false);
});

it('discoverProjectInfo: no hostURL or projectKey in file yields no props', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-norelevantkeys-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      `sonar.projectName=My Project\nsonar.organization=my-org\n`,
    );

    const info = await discoverProjectInfo(testDir);
    expect(info.hasSonarProps).toBe(false);
    expect(info.sonarPropsData).toBeNull();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discoverProjectInfo: git remote is empty when git spawn fails', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-git-spawn-fail-' + Date.now());
  mkdirSync(join(testDir, '.git'), { recursive: true });

  const spawnSpy = spyOn(processLib, 'spawnProcess').mockRejectedValue(
    new Error('git not available'),
  );

  try {
    const info = await discoverProjectInfo(testDir);
    expect(info.isGitRepo).toBe(true);
    expect(info.gitRemote).toBe('');
  } finally {
    spawnSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('discoverProjectInfo: git remote is empty when git returns non-zero exit', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-git-exit-nz-' + Date.now());
  mkdirSync(join(testDir, '.git'), { recursive: true });

  const spawnSpy = spyOn(processLib, 'spawnProcess').mockResolvedValue({
    exitCode: 1,
    stdout: '',
    stderr: 'no origin',
  });

  try {
    const info = await discoverProjectInfo(testDir);
    expect(info.isGitRepo).toBe(true);
    expect(info.gitRemote).toBe('');
  } finally {
    spawnSpy.mockRestore();
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

  it('resolves rootDir and isGitRepo from filesystem', async () => {
    expect((await discoverProject(testDir)).rootDir).toBe(realpathSync(testDir));
    expect((await discoverProject(testDir)).isGitRepo).toBe(false);

    mkdirSync(join(testDir, '.git'));
    const withGit = await discoverProject(testDir);
    expect(withGit.isGitRepo).toBe(true);
    expect(withGit.rootDir).toBe(realpathSync(testDir));
  });

  it('no config: no server fields and no text UI', async () => {
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBeUndefined();
    expect(result.projectKey).toBeUndefined();
    expect(result.organization).toBeUndefined();

    await discoverProject(testDir);
    expect(getMockUiCalls().filter((c) => c.method === 'print')).toHaveLength(0);
  });

  it('maps sonar-project.properties to DiscoveredProject and emits Found message', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://sonarcloud.io\nsonar.projectKey=my_project\nsonar.organization=my-org\n',
    );
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBe('https://sonarcloud.io');
    expect(result.projectKey).toBe('my_project');
    expect(result.organization).toBe('my-org');

    expect(
      getMockUiCalls().some(
        (c) => c.method === 'print' && String(c.args[0]) === 'Found sonar-project.properties',
      ),
    ).toBe(true);
  });

  it('maps SonarQube Server connected mode to DiscoveredProject and emits Found path', async () => {
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({
        sonarQubeUri: 'https://sonarqube.example.com',
        projectKey: 'lint_project',
        organization: 'must-be-ignored',
      }),
    );
    const result = await discoverProject(testDir);
    expect(result.serverUrl).toBe('https://sonarqube.example.com');
    expect(result.projectKey).toBe('lint_project');
    expect(result.organization).toBeUndefined();

    const expected = `Found ${join('.sonarlint', 'connectedMode.json')}`;
    expect(
      getMockUiCalls().some((c) => c.method === 'print' && String(c.args[0]) === expected),
    ).toBe(true);
  });

  it('maps SonarQube Cloud connected mode to DiscoveredProject (region EU / US)', async () => {
    for (const { region, url } of [
      { region: 'EU', url: SONARCLOUD_URL },
      { region: 'US', url: SONARCLOUD_US_URL },
    ]) {
      clearMockUiCalls();
      mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(testDir, '.sonarlint', 'connectedMode.json'),
        JSON.stringify({
          sonarCloudOrganization: 'my-org',
          projectKey: 'org_project',
          region,
        }),
      );
      const result = await discoverProject(testDir);
      expect(result.serverUrl).toBe(url);
      expect(result.projectKey).toBe('org_project');
      expect(result.organization).toBe('my-org');
      rmSync(join(testDir, '.sonarlint'), { recursive: true, force: true });
    }
  });

  it('sonar-project.properties wins over SonarLint for serverUrl and projectKey', async () => {
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
    expect(result.projectKey).toBe('props_project');
  });

  it('SonarLint fills projectKey or organization when properties omit them', async () => {
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://sonarlint-server.com', projectKey: 'from_lint' }),
    );
    expect((await discoverProject(testDir)).projectKey).toBe('from_lint');

    rmSync(join(testDir, '.sonarlint'), { recursive: true, force: true });
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://props-server.io\nsonar.projectKey=props_project\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarCloudOrganization: 'lint-org', projectKey: 'lint_project' }),
    );
    expect((await discoverProject(testDir)).organization).toBe('lint-org');
  });

  it('emits both Found messages when properties and SonarLint exist', async () => {
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
      .filter((c) => c.method === 'print')
      .map((c) => String(c.args[0]));
    expect(textCalls).toContain('Found sonar-project.properties');
    expect(textCalls).toContain(`Found ${join('.sonarlint', 'connectedMode.json')}`);
  });
});

describe('discoverOrganization', () => {
  afterEach(() => {
    clearMockUiCalls();
  });

  it('reads organization from sonar-project.properties under process.cwd()', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-props-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\nsonar.organization=from-props-org\n',
    );

    try {
      await withCwd(testDir, async () => {
        expect(await discoverOrganization()).toBe('from-props-org');
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('reads organization from .sonarlint when properties omit sonar.organization', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-lint-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarCloudOrganization: 'from-lint-org', projectKey: 'k' }),
    );

    try {
      await withCwd(testDir, async () => {
        expect(await discoverOrganization()).toBe('from-lint-org');
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns null when no organization is configured', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-org-empty-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://x.test\nsonar.projectKey=p\n',
    );

    try {
      await withCwd(testDir, async () => {
        expect(await discoverOrganization()).toBeNull();
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns null when discoverProjectInfo throws', async () => {
    const discoverSpy = spyOn(projectWorkspace, 'discoverProjectInfo').mockRejectedValue(
      new Error('simulated failure'),
    );

    try {
      expect(await discoverOrganization()).toBeNull();
    } finally {
      discoverSpy.mockRestore();
    }
  });
});

describe('discoverServer', () => {
  beforeEach(() => setMockUi(true));
  afterEach(() => {
    clearMockUiCalls();
    setMockUi(false);
  });

  it('reads server URL from sonar-project.properties under process.cwd()', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-server-props-' + Date.now());
    mkdirSync(testDir, { recursive: true });
    writeFileSync(
      join(testDir, 'sonar-project.properties'),
      'sonar.host.url=https://from-props.integration.test\nsonar.projectKey=p\n',
    );
    mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
    writeFileSync(
      join(testDir, '.sonarlint', 'connectedMode.json'),
      JSON.stringify({ sonarQubeUri: 'https://from-lint.should-not-win', projectKey: 'k' }),
    );

    try {
      await withCwd(testDir, async () => {
        expect(await discoverServer()).toBe('https://from-props.integration.test');
        const prints = getMockUiCalls()
          .filter((c) => c.method === 'print')
          .map((c) => String(c.args[0]));
        expect(prints.some((m) => m.includes('sonar-project.properties'))).toBe(true);
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('uses SonarLint when there is no sonar-project.properties (Server or Cloud binding)', async () => {
    const cases: { json: Record<string, unknown>; expectedUrl: string }[] = [
      {
        json: { sonarQubeUri: 'https://lint-only.integration.test', projectKey: 'k' },
        expectedUrl: 'https://lint-only.integration.test',
      },
      {
        json: { sonarCloudOrganization: 'my-org', projectKey: 'cloud_lint_key' },
        expectedUrl: SONARCLOUD_URL,
      },
    ];

    for (let i = 0; i < cases.length; i++) {
      const testDir = join(tmpdir(), `sonarqube-cli-discover-server-lintonly-${i}-` + Date.now());
      mkdirSync(join(testDir, '.sonarlint'), { recursive: true });
      writeFileSync(
        join(testDir, '.sonarlint', 'connectedMode.json'),
        JSON.stringify(cases[i].json),
      );

      try {
        await withCwd(testDir, async () => {
          clearMockUiCalls();
          expect(await discoverServer()).toBe(cases[i].expectedUrl);
          const prints = getMockUiCalls()
            .filter((c) => c.method === 'print')
            .map((c) => String(c.args[0]));
          expect(prints.some((m) => m.includes('.sonarlint'))).toBe(true);
          expect(prints.some((m) => m.includes('sonar-project.properties'))).toBe(false);
        });
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });

  it('returns null when cwd has no server hint', async () => {
    const testDir = join(tmpdir(), 'sonarqube-cli-test-discover-server-empty-' + Date.now());
    mkdirSync(testDir, { recursive: true });

    try {
      await withCwd(testDir, async () => {
        expect(await discoverServer()).toBeNull();
        expect(getMockUiCalls().filter((c) => c.method === 'print')).toHaveLength(0);
      });
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('returns null and logs when discoverProjectInfo throws', async () => {
    const discoverSpy = spyOn(projectWorkspace, 'discoverProjectInfo').mockRejectedValue(
      new Error('simulated failure'),
    );
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => undefined);

    try {
      expect(await discoverServer()).toBeNull();
      expect(debugSpy).toHaveBeenCalled();
      expect(String(debugSpy.mock.calls[0]?.[0] ?? '')).toContain('simulated failure');
    } finally {
      discoverSpy.mockRestore();
      debugSpy.mockRestore();
    }
  });
});
