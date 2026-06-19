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

export const DISTRIBUTIONS = ['standalone', 'homebrew'] as const;
const DEFAULT_DISTRIBUTION = 'standalone';

export type Distribution = (typeof DISTRIBUTIONS)[number];

function invalidDistributionError(rawDistribution: string): Error {
  return new Error(
    `Unknown distribution '${rawDistribution}'. Expected one of: ${DISTRIBUTIONS.join(', ')}.`,
  );
}

function assertDistribution(rawDistribution: string): asserts rawDistribution is Distribution {
  if (!(DISTRIBUTIONS as readonly string[]).includes(rawDistribution)) {
    throw invalidDistributionError(rawDistribution);
  }
}

export function resolveDistribution(rawDistribution: string | undefined): Distribution {
  if (rawDistribution === undefined) {
    return DEFAULT_DISTRIBUTION;
  }

  assertDistribution(rawDistribution);
  return rawDistribution;
}

const rawDistribution = process.env.SONARQUBE_CLI_DISTRIBUTION;
if (rawDistribution !== undefined) {
  assertDistribution(rawDistribution);
}

// Channel builds inject this env access at compile time via Bun's `define`.
export const DISTRIBUTION: Distribution = rawDistribution ?? DEFAULT_DISTRIBUTION;
export const IS_STANDALONE_DISTRIBUTION = DISTRIBUTION === 'standalone';
