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

import { version as VERSION } from '../../package.json';
import { DOCS_URL } from '../lib/config-constants.js';
import { softBlue, underline } from '../ui/colors.js';

const BANNER_PREFIX = '    SonarQube CLI  ';
const BANNER_TRAILING = '     ';

export function getBanner(version: string): string {
  const versionText = `v${version}`;
  const border = '─'.repeat(BANNER_PREFIX.length + versionText.length + BANNER_TRAILING.length);
  return [
    `┌${border}┐`,
    `│${BANNER_PREFIX}${softBlue(versionText)}${BANNER_TRAILING}│`,
    `└${border}┘`,
  ].join('\n');
}

export function getCustomRootHelp(): string {
  return [
    getBanner(VERSION),
    '',
    '  SonarQube CLI helps you detect security vulnerabilities',
    '  and code quality issues directly from your terminal.',
    '',
    `  ${underline('QUICKSTART')}`,
    `    1. Run ${softBlue('sonar auth login')} to authenticate with SonarQube`,
    `    2. Run ${softBlue('sonar verify --file <file>')} to scan your code for issues`,
    '',
    `  ${underline('COMMANDS')}`,
    `    ${softBlue('verify --file <file>')}    Run a comprehensive scan on a single file`,
    `    ${softBlue('analyze <secrets|sqaa>')}  Run targeted scans for specific workflows (secrets/code quality)`,
    `    ${softBlue('list')}                    List SonarQube issues and projects`,
    `    ${softBlue('api <method> <endpoint>')} Make authenticated requests to any SonarQube API`,
    '',
    `    ${softBlue('auth')}                    Manage authentication tokens and credentials`,
    `    ${softBlue('integrate <claude|git>')}  Setup SonarQube integration for AI Agents (Claude Code) and Git hooks`,
    `    ${softBlue('config')}                  Configure CLI settings`,
    `    ${softBlue('self-update')}             Update CLI to the latest version`,
    '',
    `  ${underline('OPTIONS')}`,
    `    ${softBlue('-h, --help')}              Display help for a specific command`,
    `    ${softBlue('-v, --version')}           Show current version`,
    '',
    `  Read documentation: ${underline(softBlue(DOCS_URL))}`,
    '',
  ].join('\n');
}
