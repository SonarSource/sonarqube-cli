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

export interface Example {
  command: string;
  description: string;
}

export const EXAMPLES: Record<string, Example[]> = {
  'sonar auth login': [
    {
      command: 'sonar auth login',
      description: 'Interactive login for SonarQube Cloud with browser',
    },
    {
      command: 'sonar auth login -o my-org -t squ_abc123',
      description: 'Non-interactive login with direct token',
    },
    {
      command: 'sonar auth login -s https://my-sonarqube.io --with-token squ_def456',
      description: 'Non-interactive login for custom server with token',
    },
  ],
  'sonar auth logout': [
    {
      command: 'sonar auth logout -o my-org',
      description: 'Remove token for SonarQube Cloud organization',
    },
    {
      command: 'sonar auth logout -s https://my-sonarqube.io',
      description: 'Remove token for custom SonarQube server',
    },
  ],
  'sonar auth purge': [
    { command: 'sonar auth purge', description: 'Interactively remove all saved tokens' },
  ],
  'sonar auth status': [
    {
      command: 'sonar auth status',
      description: 'Show current server connection and token status',
    },
  ],
  'sonar install secrets': [
    { command: 'sonar install secrets', description: 'Install latest sonar-secrets binary' },
    {
      command: 'sonar install secrets --force',
      description: 'Reinstall sonar-secrets (overwrite existing)',
    },
    {
      command: 'sonar install secrets --status',
      description: 'Check if sonar-secrets is installed and up to date',
    },
  ],
  'sonar integrate': [
    {
      command: 'sonar integrate claude -s https://sonarcloud.io -p my-project',
      description: 'Integrate Claude Code with interactive setup',
    },
    {
      command: 'sonar integrate claude --skip-hooks',
      description: 'Integrate without installing hooks',
    },
    {
      command: 'sonar integrate claude -g -s https://sonarcloud.io',
      description:
        'Integrate globally and install hooks to ~/.claude which will be available for all projects',
    },
  ],
  'sonar list issues': [
    { command: 'sonar list issues -p my-project', description: 'List issues in a project' },
    {
      command: 'sonar list issues -p my-project --format toon',
      description: 'Output issues in TOON format for AI agents',
    },
    {
      command: 'sonar list issues -p my-project --severity CRITICAL --all',
      description: 'Fetch all critical issues',
    },
  ],
  'sonar list projects': [
    { command: 'sonar list projects', description: 'List first 500 accessible projects' },
    {
      command: 'sonar list projects -q my-project',
      description: 'Search projects by name or key',
    },
    {
      command: 'sonar list projects --page 2 --page-size 50',
      description: 'Paginate through projects',
    },
  ],
  'sonar analyze secrets': [
    {
      command: 'sonar analyze secrets --file src/config.ts',
      description: 'Scan a file for hardcoded secrets',
    },
    {
      command: 'cat .env | sonar analyze secrets --stdin',
      description: 'Scan stdin for hardcoded secrets',
    },
  ],
  'sonar config telemetry': [
    {
      command: 'sonar config telemetry --enabled',
      description: 'Enable collection of anonymous usage statistics',
    },
    {
      command: 'sonar config telemetry --disabled',
      description: 'Disable collection of anonymous usage statistics',
    },
  ],
};
