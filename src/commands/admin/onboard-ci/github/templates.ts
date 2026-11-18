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

import * as yaml from 'js-yaml';

import { InvalidOptionError } from '@/core/commands/command-error.ts';
import { PROJECT_KEY_SAFE_PATTERN } from '@/core/project-key.ts';

export const WORKFLOW_PATH = '.github/workflows/sonarqube.yml';
const DEFAULT_SONAR_TOKEN_VAR_NAME = 'SONAR_TOKEN';
export const CHECKOUT_ACTION = 'actions/checkout@v7.0.1';
export const SCAN_ACTION = 'SonarSource/sonarqube-scan-action@v8.5.0';
const PROJECT_KEY_PLACEHOLDER = '{{SONAR_PROJECT_KEY}}';

export interface WorkflowOptions {
  triggerOn?: 'main' | 'pr' | 'both';
  sonarTokenVarName?: string;
  scannerProperty?: readonly string[];
}

export function validateWorkflowOptions(options: WorkflowOptions, template?: string): void {
  if (template !== undefined) {
    const conflicts = [
      options.triggerOn !== undefined && '--trigger-on',
      options.sonarTokenVarName !== undefined && '--sonar-token-var-name',
      options.scannerProperty !== undefined && '--scanner-property',
    ].filter(Boolean);
    if (conflicts.length) {
      throw new InvalidOptionError(
        `--workflow-template cannot be combined with ${conflicts.join(', ')}. Change these settings in the template.`,
      );
    }
    validateWorkflowTemplate(template);
    return;
  }
  const secret = options.sonarTokenVarName ?? DEFAULT_SONAR_TOKEN_VAR_NAME;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(secret) || /^GITHUB_/i.test(secret)) {
    throw new InvalidOptionError(
      'Invalid analysis-secret name. Use letters, digits and underscores, without a GITHUB_ prefix.',
    );
  }
  if (options.triggerOn !== undefined && !['main', 'pr', 'both'].includes(options.triggerOn)) {
    throw new InvalidOptionError('Trigger mode must be main, pr or both.');
  }
  options.scannerProperty?.forEach(scannerArgument);
}

function validateWorkflow(content: string): void {
  let parsed: unknown;
  try {
    parsed = yaml.load(content);
  } catch {
    throw new InvalidOptionError('The workflow must contain valid, single-document YAML.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidOptionError('The workflow must be a YAML mapping.');
  }
}

export function validateWorkflowTemplate(template: string): void {
  if (!template.includes(PROJECT_KEY_PLACEHOLDER)) {
    throw new InvalidOptionError(`--workflow-template must contain ${PROJECT_KEY_PLACEHOLDER}.`);
  }
  // Replace the placeholder only for parsing: unquoted {{...}} is YAML mapping syntax.
  validateWorkflow(template.replaceAll(PROJECT_KEY_PLACEHOLDER, 'template_validation_key'));
}

export function renderWorkflowTemplate(template: string, projectKey: string): string {
  if (!PROJECT_KEY_SAFE_PATTERN.test(projectKey)) {
    throw new InvalidOptionError(
      'Project key contains characters unsafe to embed in the workflow template.',
    );
  }
  validateWorkflowTemplate(template);
  const rendered = template.replaceAll(PROJECT_KEY_PLACEHOLDER, projectKey);
  validateWorkflow(rendered);
  return rendered;
}

function scannerArgument(property: string): string {
  const separator = property.indexOf('=');
  const key = property.slice(0, separator);
  if (separator < 1 || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(key) || /[\r\n\0]/.test(property)) {
    throw new InvalidOptionError('Scanner properties must be single-line key=value pairs.');
  }
  // The scan action parses quoted arguments with string-argv, without executing a shell.
  const quote = property.includes('"') ? "'" : '"';
  if (property.includes(quote)) {
    throw new InvalidOptionError(`Scanner property '${key}' cannot contain both quote styles.`);
  }
  return `${quote}-D${property}${quote}`;
}

export function generateWorkflow(
  projectKey: string,
  serverUrl: string,
  defaultBranch: string,
  options: WorkflowOptions = {},
): string {
  validateWorkflowOptions(options);
  if (
    [serverUrl, defaultBranch].some(
      (value) => !value || /[\r\n\0]/.test(value) || value.includes('${{'),
    )
  ) {
    throw new InvalidOptionError(
      'Server URL and default branch must be nonempty single-line values without GitHub expressions.',
    );
  }
  const secret = options.sonarTokenVarName ?? DEFAULT_SONAR_TOKEN_VAR_NAME;
  const trigger = options.triggerOn ?? 'both';
  const on: Record<string, unknown> = {};
  if (trigger === 'main' || trigger === 'both') {
    on.push = { branches: [defaultBranch] };
  }
  if (trigger === 'pr' || trigger === 'both') {
    on.pull_request = { types: ['opened', 'synchronize', 'reopened'] };
  }
  const args = [
    ...(options.scannerProperty ?? []),
    `sonar.projectKey=${projectKey}`,
    'sonar.scanner.autoconfig.enabled=true',
  ]
    .map(scannerArgument)
    .join(' ');
  return yaml.dump(
    {
      name: 'SonarQube analysis',
      on,
      permissions: { contents: 'read' },
      jobs: {
        sonarqube: {
          'runs-on': 'ubuntu-latest',
          steps: [
            { uses: CHECKOUT_ACTION, with: { 'fetch-depth': 0 } },
            {
              name: 'SonarQube scan',
              uses: SCAN_ACTION,
              env: { SONAR_HOST_URL: serverUrl, SONAR_TOKEN: `\${{ secrets.${secret} }}` },
              with: { args },
            },
          ],
        },
      },
    },
    { lineWidth: -1, noRefs: true },
  );
}

export function generatePrContent(
  projectKey: string,
  serverUrl: string,
  options: WorkflowOptions = {},
): { title: string; body: string } {
  const secret = options.sonarTokenVarName ?? DEFAULT_SONAR_TOKEN_VAR_NAME;
  const triggers =
    options.triggerOn === 'main'
      ? 'The first automatic analysis runs after merge on a push to the default branch; this mode does not run on the onboarding PR.'
      : 'The onboarding PR can run this new workflow before merge, subject to Actions policies and credentials. Inspect its run before merging.';
  return {
    title: 'Add SonarQube analysis',
    body: prDescription(
      projectKey,
      `This workflow uses the official SonarQube scan action with scanner auto-configuration. It sends analysis to ${serverUrl} using the pre-existing Actions secret \`${secret}\`.`,
      triggers,
    ),
  };
}

export function generateTemplatePrContent(projectKey: string): { title: string; body: string } {
  return {
    title: 'Add SonarQube analysis from workflow template',
    body: prDescription(
      projectKey,
      'This workflow comes from your organization’s complete template. Review its scanner, triggers, runner, Server URL and secret references; the command only substitutes the project key.',
      'The template controls when analysis runs.',
    ),
  };
}

function prDescription(projectKey: string, description: string, triggers: string): string {
  return `## Add SonarQube CI analysis

Adds \`${WORKFLOW_PATH}\` for SonarQube project \`${projectKey}\`.

${description}

${triggers}

Before merging:
- [ ] Allow the referenced actions under repository/organization Actions policies.
- [ ] Make the analysis secret available to this repository. It is a SonarQube analysis token, separate from the GitHub PAT used to open this PR and the CLI Server credential.
- [ ] Ensure the selected runner can reach SonarQube Server and meets the scan action’s prerequisites. Use a complete workflow template for self-hosted runners or a different scanner.
- [ ] Supply required builds, compiled outputs and coverage reports. This independent workflow does not inherit other workflows’ build outputs.
- [ ] Inspect the Actions workflow run, the SonarQube analysis and Quality Gate result, and PR decoration through the existing Server integration. A failing Quality Gate alone does not enforce merge blocking.

If a run is missing, check triggers and Actions policies. For failed analysis or missing feedback, check logs, analysis-secret availability, runner connectivity and the Server project binding/integration. Fork PRs do not receive repository secrets; Dependabot runs require appropriate Dependabot secrets and remain subject to GitHub restrictions.

Rerunning onboarding preserves an open PR. Without an open PR, it may recreate the onboarding branch from the current default branch, replacing edits on that branch.
`;
}
