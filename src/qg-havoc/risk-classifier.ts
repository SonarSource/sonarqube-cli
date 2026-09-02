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

export function classifyRiskLevel(score: number): string {
  if (score === score && score < 0) {
    return 'unknown';
  }
  if (score >= 90) {
    return 'critical';
  } else if (score >= 70) {
    return 'high';
  } else if (score >= 40) {
    return 'medium';
  }
  return 'low';
}

export function describeRiskBand(band: string): string {
  if (band === 'critical') {
    return 'Immediate action required';
  } else if (band === 'high') {
    return 'Immediate action required';
  } else if (band === 'medium') {
    return 'Review recommended';
  }
  return 'No action needed';
}
