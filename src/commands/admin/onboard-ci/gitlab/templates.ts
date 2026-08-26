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

import type { OnboardCiGitlabOptions } from './types.ts';
import { GITLAB_DEFAULT_STAGES, TriggerOn } from './types.ts';

const SCANNER_IMAGE = 'sonarsource/sonar-scanner-cli:latest';

export function generateCiYml(
  projectKey: string,
  serverUrl: string,
  options: Pick<
    OnboardCiGitlabOptions,
    'sonarTokenVarName' | 'triggerOn' | 'stage' | 'allowFailure' | 'scannerProperty'
  >,
  isNewFile = false,
): string {
  const rules: string[] = [];
  if (options.triggerOn === TriggerOn.Mr || options.triggerOn === TriggerOn.Both) {
    rules.push("    - if: $CI_PIPELINE_SOURCE == 'merge_request_event'");
  }
  if (options.triggerOn === TriggerOn.Main || options.triggerOn === TriggerOn.Both) {
    rules.push('    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
  }

  const stageLine = options.stage != null ? `\n  stage: ${options.stage}` : '';
  const allowFailureLine = options.allowFailure ? '\n  allow_failure: true' : '';

  const tokenLine =
    options.sonarTokenVarName !== 'SONAR_TOKEN'
      ? `\n    SONAR_TOKEN: $${options.sonarTokenVarName}`
      : '';

  const stagesBlock =
    options.stage && isNewFile && !GITLAB_DEFAULT_STAGES.has(options.stage)
      ? `stages:\n  - ${options.stage}\n\n`
      : '';

  const extraProps =
    options.scannerProperty.length > 0
      ? options.scannerProperty
          .map((p) => {
            const eqIdx = p.indexOf('=');
            const key = p.slice(0, eqIdx);
            const value = p.slice(eqIdx + 1).replaceAll("'", "'\\''");
            return ` -D${key}='${value}'`;
          })
          .join('')
      : '';

  return `${stagesBlock}sonarqube-analysis:
  image: ${SCANNER_IMAGE}${stageLine}
  script:
    - sonar-scanner -Dsonar.projectKey="${projectKey}"${extraProps}
  variables:
    SONAR_HOST_URL: "${serverUrl}"
    GIT_DEPTH: "0"${tokenLine}
  rules:
${rules.join('\n')}${allowFailureLine}
`;
}

export function buildUpdatedCiYml(existingCi: string | null, ciYml: string): string {
  if (!existingCi) {
    return ciYml;
  }
  // Strip trailing YAML document-start markers so the appended job isn't silently placed
  // in a second document that GitLab ignores.
  const normalized = existingCi.trimEnd().replace(/(\n---)+$/, '');
  return `${normalized}\n\n${ciYml}`;
}

function triggerDescription(triggerOn: TriggerOn): string {
  if (triggerOn === TriggerOn.Mr) return 'merge request pipelines';
  if (triggerOn === TriggerOn.Main) return 'pushes to the default branch';
  return 'merge request pipelines and pushes to the default branch';
}

export function generateMrDescription(
  projectKey: string,
  serverUrl: string,
  ciFilePath: string,
  sonarTokenVarName: string,
  triggerOn: TriggerOn,
): string {
  return `## Add SonarQube CI analysis

This MR configures SonarQube analysis for this repository by adding a \`sonarqube-analysis\` job to \`${ciFilePath}\`.

**Before merging:** ensure \`${sonarTokenVarName}\` is set as a CI/CD variable on your GitLab group (Group → Settings → CI/CD → Variables). All repos in the group inherit it automatically.

The job runs on ${triggerDescription(triggerOn)}, and reports results back to SonarQube.

- SonarQube project key: \`${projectKey}\`
- SonarQube instance: ${serverUrl}

[SonarQube CI integration docs](https://docs.sonarsource.com/sonarqube-server/latest/analyzing-source-code/ci-integration/gitlab-cicd-integration/)
`;
}
