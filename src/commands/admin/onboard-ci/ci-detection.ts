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

const SONAR_CI_MARKERS = [
  'sonar-scanner',
  'sonarscanner',
  'sonar:sonar',
  'sonarqube-scan-action',
  'sonarcloud-github-action',
  'sonarqube-github-action',
  'SONAR_HOST_URL',
  'SONAR_TOKEN',
  'sonar.projectKey',
  'sonarqube-analysis:',
];

// Wrapper scripts without a literal Sonar marker cannot be detected.
export function hasSonarAnalysis(content: string): boolean {
  return (
    SONAR_CI_MARKERS.some((marker) => content.includes(marker)) ||
    /\bgradlew?\b[^\r\n;&|]*[ \t]+sonar\b/.test(content)
  );
}
