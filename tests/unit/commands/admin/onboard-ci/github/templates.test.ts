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
  CHECKOUT_ACTION,
  generatePrContent,
  generateTemplatePrContent,
  generateWorkflow,
  renderWorkflowTemplate,
  SCAN_ACTION,
  validateWorkflowOptions,
  validateWorkflowTemplate,
} from '@/commands/admin/onboard-ci/github/templates.ts';

const template = `name: Custom
on: pull_request
jobs:
  scan:
    runs-on: self-hosted
    steps:
      - run: echo {{SONAR_PROJECT_KEY}}
        env:
          SONAR_TOKEN: \${{ secrets.CUSTOM_TOKEN }}
          SONAR_HOST_URL: \${{ vars.SERVER_URL }}
`;

function workflow(triggerOn: 'main' | 'pr' | 'both' = 'both') {
  return yaml.load(
    generateWorkflow('org:repo', 'https://sonar.example.com/context', 'trunk', { triggerOn }),
  ) as {
    on: Record<string, unknown>;
    jobs: {
      sonarqube: {
        'runs-on': string;
        steps: {
          name?: string;
          uses: string;
          env?: Record<string, string>;
          with: Record<string, unknown>;
        }[];
      };
    };
  };
}

describe('generated GitHub workflow', () => {
  it.each(['main', 'pr', 'both'] as const)(
    'supports %s triggers and the actual default branch',
    (mode) => {
      expect(workflow(mode).on).toEqual({
        ...(mode !== 'pr' ? { push: { branches: ['trunk'] } } : {}),
        ...(mode !== 'main'
          ? { pull_request: { types: ['opened', 'synchronize', 'reopened'] } }
          : {}),
      });
    },
  );

  it('sets Server attribution, action versions, full checkout and a secret reference', () => {
    const job = workflow().jobs.sonarqube;
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.steps[0]).toEqual({ uses: CHECKOUT_ACTION, with: { 'fetch-depth': 0 } });
    expect(job.steps[1]).toEqual({
      name: 'SonarQube scan',
      uses: SCAN_ACTION,
      env: {
        SONAR_HOST_URL: 'https://sonar.example.com/context',
        SONAR_TOKEN: '${{ secrets.SONAR_TOKEN }}',
      },
      with: { args: '"-Dsonar.projectKey=org:repo" "-Dsonar.scanner.autoconfig.enabled=true"' },
    });
  });

  it('preserves YAML-sensitive values and quotes complete scanner arguments', () => {
    const result = generateWorkflow('org:repo', 'https://sonar.example.com', 'feature: special', {
      sonarTokenVarName: 'ANALYSIS_TOKEN',
      scannerProperty: [
        "sonar.projectName=Team: Bob's app #1",
        'sonar.exclusions=a/**,b/**',
        'sonar.projectVersion=${{ github.sha }}',
      ],
    });
    expect(result).toContain('${{ secrets.ANALYSIS_TOKEN }}');
    expect(result).toContain('${{ github.sha }}');
    const parsed = yaml.load(result) as ReturnType<typeof workflow>;
    expect(parsed.on.push).toEqual({ branches: ['feature: special'] });
    expect(parsed.jobs.sonarqube.steps[1].with.args).toContain(
      '"-Dsonar.projectName=Team: Bob\'s app #1"',
    );
  });

  it.each(['bad', '=value', 'sonar.x=a\nb', `sonar.x=both'"`])(
    'rejects unsafe property %s before repository processing',
    (property) => {
      expect(() => validateWorkflowOptions({ scannerProperty: [property] })).toThrow();
    },
  );

  it.each(['bad-name', '1TOKEN', 'GITHUB_TOKEN'])(
    'rejects invalid analysis-secret name %s',
    (name) => {
      expect(() => validateWorkflowOptions({ sonarTokenVarName: name })).toThrow();
    },
  );

  it('rejects GitHub expressions in the connection URL', () => {
    expect(() => generateWorkflow('key', '${{ secrets.PAT }}', 'main')).toThrow();
  });
});

describe('complete workflow templates', () => {
  it('substitutes only the project key and preserves customer settings and GitHub expressions', () => {
    validateWorkflowOptions({}, template);
    expect(renderWorkflowTemplate(template, 'org:repo')).toBe(
      template.replace('{{SONAR_PROJECT_KEY}}', 'org:repo'),
    );
  });

  it.each([
    { triggerOn: 'pr' as const },
    { sonarTokenVarName: 'SONAR_TOKEN' },
    { scannerProperty: [] },
  ])('rejects explicit generation settings %j', (options) => {
    expect(() => validateWorkflowOptions(options, template)).toThrow(
      'Change these settings in the template',
    );
  });

  it.each([
    '',
    'jobs: {}',
    'on: [\n{{SONAR_PROJECT_KEY}}',
    '{{SONAR_PROJECT_KEY}}',
    '- {{SONAR_PROJECT_KEY}}',
    template + '\n---\nother: document',
  ])('rejects incomplete or invalid templates', (content) => {
    expect(() => validateWorkflowTemplate(content)).toThrow();
  });

  it('rejects unsafe substitutions', () => {
    expect(() => renderWorkflowTemplate(template, 'key\nother: value')).toThrow();
    expect(() =>
      renderWorkflowTemplate(
        template.replace('echo {{SONAR_PROJECT_KEY}}', '{{SONAR_PROJECT_KEY}}'),
        'key:',
      ),
    ).toThrow();
  });
});

describe('PR content', () => {
  it('explains generated prerequisites and PR validation', () => {
    const { body } = generatePrContent('project', 'https://sonar.example.com', {
      sonarTokenVarName: 'ANALYSIS_TOKEN',
    });
    for (const text of [
      'ANALYSIS_TOKEN',
      'https://sonar.example.com',
      'before merge',
      'Actions policies',
      'compiled outputs',
      'Quality Gate',
      'Fork',
      'Dependabot',
      'replacing edits',
    ]) {
      expect(body).toContain(text);
    }
  });

  it('distinguishes default-branch and template behavior', () => {
    expect(
      generatePrContent('project', 'https://sonar.example.com', { triggerOn: 'main' }).body,
    ).toContain('after merge');
    const custom = generateTemplatePrContent('project');
    expect(custom.title).toContain('template');
    expect(custom.body).toContain('template controls');
    expect(custom.body).not.toContain('pre-existing Actions secret `SONAR_TOKEN`');
  });
});
