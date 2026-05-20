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

// Parser for sonar-secrets binary plain text stdout output.

export interface SecretsIssue {
  message: string;
  file: string;
  location: {
    startLine: number;
    startOffset: number;
    endLine: number;
    endOffset: number;
  } | null;
  secret: string | null;
}

const LOCATION_PATTERN = /\[(\d+):(\d+)-(\d+):(\d+)\]/;

/**
 * Parses the sonar-secrets binary stdout into structured issues.
 *
 * Each issue block (separated by blank lines) has up to 4 lines:
 *   <message>
 *   File: <path>
 *   Location: [startLine:startOffset-endLine:endOffset]
 *   Secret: <redacted value>
 */
export function parseSecretsOutput(stdout: string): SecretsIssue[] {
  if (!stdout.trim()) return [];

  return stdout
    .replaceAll('\r\n', '\n')
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .flatMap((block) => parseBlock(block) ?? []);
}

function parseBlock(block: string): SecretsIssue | null {
  const lines = block.split('\n');
  if (lines.length < 2) return null;

  const message = lines[0].trim();
  const file = lines[1].replace(/^File:\s*/, '').trim();

  if (!message || !file) return null;

  let location: SecretsIssue['location'] = null;
  let secret: string | null = null;

  const locationLine = lines.find((l) => l.startsWith('Location:'));
  if (locationLine) {
    const match = LOCATION_PATTERN.exec(locationLine);
    if (match) {
      const [, sl, so, el, eo] = match;
      location = {
        startLine: Number.parseInt(sl, 10),
        startOffset: Number.parseInt(so, 10),
        endLine: Number.parseInt(el, 10),
        endOffset: Number.parseInt(eo, 10),
      };
    }
  }

  const secretLine = lines.find((l) => l.startsWith('Secret:'));
  if (secretLine) {
    secret = secretLine.replace(/^Secret:\s*/, '').trim();
  }

  return { message, file, location, secret };
}
