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

import { describe, expect, it } from 'bun:test';
import * as yaml from 'js-yaml';

import {
  buildUpdatedCiYml,
  generateCiYml,
  generateMrDescription,
  generateTemplateMrDescription,
  renderJobTemplate,
  validateJobTemplate,
} from '@/commands/admin/onboard-ci/gitlab/templates.ts';
import { TriggerOn } from '@/commands/admin/onboard-ci/gitlab/types.ts';

interface GeneratedCiConfig {
  stages?: string[];
  'sonarqube-analysis': {
    script: string[];
    stage?: string;
    variables: {
      SONAR_HOST_URL: string;
    };
  };
}

function parseGeneratedCiYml(yml: string): GeneratedCiConfig {
  return yaml.load(yml) as GeneratedCiConfig;
}

describe('generateCiYml', () => {
  const base = {
    sonarTokenVarName: 'SONAR_TOKEN',
    triggerOn: TriggerOn.Both,
    allowFailure: true,
    scannerProperty: [] as string[],
  };

  it('omits the stage line when stage is not provided', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', base);
    expect(yml).not.toContain('stage:');
  });

  it('includes the stage line when stage is provided', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', {
      ...base,
      stage: 'quality',
    });
    expect(yml).toContain("  stage: 'quality'");
  });

  it('emits a stages block for a custom stage when creating a new file', () => {
    const yml = generateCiYml(
      'my_project',
      'https://sonar.example.com',
      { ...base, stage: 'security' },
      true,
    );
    expect(yml).toMatch(/^stages:\n  - 'security'\n/);
    expect(yml).toContain("  stage: 'security'");
  });

  it('does not emit a stages block for a GitLab default stage even when creating a new file', () => {
    for (const stage of ['build', 'test', 'deploy', '.pre', '.post']) {
      const yml = generateCiYml(
        'my_project',
        'https://sonar.example.com',
        { ...base, stage },
        true,
      );
      expect(yml).not.toContain('stages:');
    }
  });

  it('does not emit a stages block for a custom stage when appending to an existing file', () => {
    const yml = generateCiYml(
      'my_project',
      'https://sonar.example.com',
      { ...base, stage: 'security' },
      false,
    );
    expect(yml).not.toContain('stages:');
    expect(yml).toContain("  stage: 'security'");
  });

  it('includes both MR and main branch rules for trigger-on both', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', base);
    expect(yml).toContain("$CI_PIPELINE_SOURCE == 'merge_request_event'");
    expect(yml).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  it('includes only MR rule for trigger-on mr', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', {
      ...base,
      triggerOn: TriggerOn.Mr,
    });
    expect(yml).toContain("$CI_PIPELINE_SOURCE == 'merge_request_event'");
    expect(yml).not.toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  });

  it('includes only main branch rule for trigger-on main', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', {
      ...base,
      triggerOn: TriggerOn.Main,
    });
    expect(yml).not.toContain("$CI_PIPELINE_SOURCE == 'merge_request_event'");
    expect(yml).not.toContain('$CI_COMMIT_BRANCH && $CI_OPEN_MERGE_REQUESTS');
    expect(yml).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(yml).not.toContain('$CI_COMMIT_BRANCH\n');
  });

  it('includes allow_failure: true when enabled', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', base);
    expect(yml).toContain('allow_failure: true');
  });

  it('omits allow_failure when disabled', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', {
      ...base,
      allowFailure: false,
    });
    expect(yml).not.toContain('allow_failure');
  });

  it('injects project key and server URL', () => {
    const yml = generateCiYml('mygroup_myrepo', 'https://sonar.example.com', base);
    const config = parseGeneratedCiYml(yml)['sonarqube-analysis'];
    expect(config.script[0]).toBe("sonar-scanner -Dsonar.projectKey='mygroup_myrepo'");
    expect(config.variables.SONAR_HOST_URL).toBe('https://sonar.example.com');
  });

  it('keeps special characters in generated CI values inside their fields', () => {
    const projectKey = `project'; echo unexpected`;
    const serverUrl = `https://sonar.example.com/'$(echo unexpected)`;

    const config = parseGeneratedCiYml(generateCiYml(projectKey, serverUrl, base))[
      'sonarqube-analysis'
    ];

    expect(config.script[0]).toContain(`-Dsonar.projectKey='project'\\''; echo unexpected'`);
    expect(config.variables.SONAR_HOST_URL).toBe(serverUrl);
  });

  it('rejects line breaks in generated CI values', () => {
    expect(() => generateCiYml('project\nkey', 'https://sonar.example.com', base)).toThrow(
      'project key must be a single line',
    );
    expect(() => generateCiYml('project', 'https://sonar.example.com\n', base)).toThrow(
      'server URL must be a single line',
    );
  });

  it('uses custom sonar token variable name', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', {
      ...base,
      sonarTokenVarName: 'MY_SONAR_TOKEN',
    });
    expect(yml).toContain('SONAR_TOKEN: $MY_SONAR_TOKEN');
  });

  it('always includes GIT_DEPTH 0', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', base);
    expect(yml).toContain('GIT_DEPTH: "0"');
  });

  it('appends no extra properties when scannerProperty is empty', () => {
    const yml = generateCiYml('my_project', 'https://sonar.example.com', base);
    expect(parseGeneratedCiYml(yml)['sonarqube-analysis'].script).toEqual([
      "sonar-scanner -Dsonar.projectKey='my_project'",
    ]);
  });

  it('appends a single scanner property after the project key, shell-quoted', () => {
    const config = parseGeneratedCiYml(
      generateCiYml('my_project', 'https://sonar.example.com', {
        ...base,
        scannerProperty: ['sonar.scanner.engineJarPath=/path/to/engine.jar'],
      }),
    )['sonarqube-analysis'];
    expect(config.script[0]).toBe(
      "sonar-scanner -Dsonar.projectKey='my_project' -Dsonar.scanner.engineJarPath='/path/to/engine.jar'",
    );
  });

  it('appends multiple scanner properties in order, each shell-quoted', () => {
    const config = parseGeneratedCiYml(
      generateCiYml('my_project', 'https://sonar.example.com', {
        ...base,
        scannerProperty: [
          'sonar.scanner.engineJarPath=/path/to/engine.jar',
          'sonar.buildsystem.autoconfig.disabled=false',
        ],
      }),
    )['sonarqube-analysis'];
    expect(config.script[0]).toBe(
      "sonar-scanner -Dsonar.projectKey='my_project' -Dsonar.scanner.engineJarPath='/path/to/engine.jar' -Dsonar.buildsystem.autoconfig.disabled='false'",
    );
  });

  it('escapes single quotes inside a property value', () => {
    const config = parseGeneratedCiYml(
      generateCiYml('my_project', 'https://sonar.example.com', {
        ...base,
        scannerProperty: [`sonar.projectName=It's a test`],
      }),
    )['sonarqube-analysis'];
    expect(config.script[0]).toContain(String.raw`-Dsonar.projectName='It'\''s a test'`);
  });

  it('rejects invalid scanner property keys', () => {
    expect(() =>
      generateCiYml('my_project', 'https://sonar.example.com', {
        ...base,
        scannerProperty: ['sonar.foo; rm -rf /=x'],
      }),
    ).toThrow("invalid scanner property key 'sonar.foo; rm -rf /'");
  });

  it('yaml-quotes stage names that would otherwise be parsed as booleans', () => {
    const yml = generateCiYml(
      'my_project',
      'https://sonar.example.com',
      { ...base, stage: 'no' },
      true,
    );
    const config = parseGeneratedCiYml(yml);
    expect(yml).toContain("stage: 'no'");
    expect(yml).toMatch(/^stages:\n  - 'no'\n/);
    expect(config.stages).toEqual(['no']);
    expect(config['sonarqube-analysis'].stage).toBe('no');
  });
});

describe('generateMrDescription', () => {
  const base = {
    projectKey: 'mygroup_myrepo',
    serverUrl: 'https://sonar.example.com',
    ciFilePath: '.gitlab-ci.yml',
    sonarTokenVarName: 'SONAR_TOKEN',
  };

  it('mentions only merge request pipelines for trigger-on mr', () => {
    const desc = generateMrDescription(
      base.projectKey,
      base.serverUrl,
      base.ciFilePath,
      base.sonarTokenVarName,
      TriggerOn.Mr,
    );
    expect(desc).toContain('merge request pipelines');
    expect(desc).not.toContain('pushes to the default branch');
  });

  it('mentions only default branch pushes for trigger-on main', () => {
    const desc = generateMrDescription(
      base.projectKey,
      base.serverUrl,
      base.ciFilePath,
      base.sonarTokenVarName,
      TriggerOn.Main,
    );
    expect(desc).toContain('pushes to the default branch');
    expect(desc).not.toContain('merge request pipelines');
  });

  it('mentions both triggers for trigger-on both', () => {
    const desc = generateMrDescription(
      base.projectKey,
      base.serverUrl,
      base.ciFilePath,
      base.sonarTokenVarName,
      TriggerOn.Both,
    );
    expect(desc).toContain('merge request pipelines and pushes to the default branch');
  });
});

describe('validateJobTemplate', () => {
  it('accepts a template containing the placeholder', () => {
    expect(() =>
      validateJobTemplate('script:\n  - sonar-scanner -Dsonar.projectKey={{SONAR_PROJECT_KEY}}\n'),
    ).not.toThrow();
  });

  it('rejects a template missing the placeholder', () => {
    expect(() => validateJobTemplate('script:\n  - sonar-scanner\n')).toThrow(
      '--job-template: the template must contain the placeholder {{SONAR_PROJECT_KEY}}',
    );
  });

  it('rejects a template that is not valid YAML', () => {
    expect(() =>
      validateJobTemplate(
        'script:\n  - sonar-scanner -Dsonar.projectKey={{SONAR_PROJECT_KEY}}\n\tbad indent:',
      ),
    ).toThrow('--job-template: the file is not valid YAML');
  });
});

describe('renderJobTemplate', () => {
  const template = 'script:\n  - sonar-scanner -Dsonar.projectKey={{SONAR_PROJECT_KEY}}\n';

  it('substitutes every occurrence of the placeholder with the project key', () => {
    const withTwoPlaceholders = `${template}  - echo {{SONAR_PROJECT_KEY}}\n`;
    const rendered = renderJobTemplate(withTwoPlaceholders, 'my_project');
    expect(rendered).toBe(
      'script:\n  - sonar-scanner -Dsonar.projectKey=my_project\n  - echo my_project\n',
    );
  });

  it('rejects a project key containing characters unsafe to embed unquoted', () => {
    expect(() => renderJobTemplate(template, "project'; echo unexpected")).toThrow(
      "Cannot substitute {{SONAR_PROJECT_KEY}}: project key 'project'; echo unexpected' contains characters unsafe to embed in the job template.",
    );
  });
});

describe('generateTemplateMrDescription', () => {
  it('mentions the project key and CI file path without the CLI-generated specifics', () => {
    const desc = generateTemplateMrDescription('mygroup_myrepo', '.gitlab-ci.yml');
    expect(desc).toContain('mygroup_myrepo');
    expect(desc).toContain('.gitlab-ci.yml');
    expect(desc).toContain("organization's job template");
    expect(desc).not.toContain('SONAR_TOKEN');
  });
});

describe('buildUpdatedCiYml', () => {
  const jobYml = 'sonarqube-analysis:\n  script:\n    - sonar-scanner\n';

  it('returns the job YAML directly when no CI file exists', () => {
    const result = buildUpdatedCiYml(null, jobYml);
    expect(result).toBe(jobYml);
  });

  it('appends the job to an existing CI file with a blank line separator', () => {
    const existing = 'stages:\n  - test\n';
    const result = buildUpdatedCiYml(existing, jobYml);
    expect(result).toBe(`stages:\n  - test\n\n${jobYml}`);
  });

  it('trims trailing whitespace from existing CI before appending', () => {
    const existing = 'stages:\n  - test\n\n\n';
    const result = buildUpdatedCiYml(existing, jobYml);
    expect(result).toBe(`stages:\n  - test\n\n${jobYml}`);
  });

  it('preserves existing CI content', () => {
    const existing = 'build:\n  script:\n    - make\n';
    const result = buildUpdatedCiYml(existing, jobYml);
    expect(result).toContain('build:');
    expect(result).toContain('sonarqube-analysis:');
    expect(result.indexOf('build:')).toBeLessThan(result.indexOf('sonarqube-analysis:'));
  });

  it('strips a trailing --- document-start marker before appending', () => {
    const existing = 'stages:\n  - test\n---';
    const result = buildUpdatedCiYml(existing, jobYml);
    expect(result).not.toContain('---');
    expect(result).toContain('sonarqube-analysis:');
  });

  it('strips multiple trailing --- markers before appending', () => {
    const existing = 'stages:\n  - test\n---\n---';
    const result = buildUpdatedCiYml(existing, jobYml);
    expect(result).not.toContain('---');
    expect(result).toContain('sonarqube-analysis:');
  });
});
