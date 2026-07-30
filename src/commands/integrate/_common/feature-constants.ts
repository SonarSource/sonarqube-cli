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

/**
 * Short, user-facing hints appended in parentheses to the interactive install
 * prompts for `sonar integrate` features (see `FeatureDeclaration.benefitDescription`).
 */

/** Combined prompt + pre-tool-use secrets scanning. */
export const SECRETS_COMBINED_FEATURE_BENEFIT =
  'prevents leaked secrets in AI prompts and file reads';

/** Prompt-only secrets scanning. */
export const SECRETS_PROMPT_FEATURE_BENEFIT = 'prevents leaked secrets in AI prompts';

/** pre-tool-use secrets scanning. */
export const SECRETS_PRE_TOOL_USE_FEATURE_BENEFIT =
  'prevents the agent from reading files with secrets';

/** End-of-turn SQAA delivered via instructions/rules. */
export const AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_BENEFIT =
  'deep analysis of all changes at end of turn';

/** Agentic analysis and context augmentation, installed as one Vortex unit. */
export const VORTEX_FEATURE_BENEFIT = 'analyzes edits and enriches prompts';

export const MCP_SERVER_FEATURE_BENEFIT = 'gives your AI agent access to SonarQube data';

/**
 * Longer, full-sentence copy for the pre-install "What will be installed"
 * preview box (see `FeatureDeclaration.previewDescription`).
 */

/** Combined prompt + pre-tool-use secrets scanning. */
export const SECRETS_COMBINED_FEATURE_PREVIEW =
  'Scans files and prompts for hardcoded secrets before the agent can read or act on them.';

/** Prompt-only secrets scanning. */
export const SECRETS_PROMPT_FEATURE_PREVIEW =
  'Scans your prompts for hardcoded secrets before the agent can act on them.';

/** pre-tool-use secrets scanning. */
export const SECRETS_PRE_TOOL_USE_FEATURE_PREVIEW =
  'Scans files for hardcoded secrets before the agent can read them.';

/** End-of-turn SQAA delivered via instructions/rules. */
export const AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_PREVIEW =
  'Runs a deep analysis of all your changes at the end of each turn. Catches issues before they reach your main branch.';

export const VORTEX_FEATURE_PREVIEW =
  'Analyzes the code your agent writes, and enriches its prompts with SonarQube context: issues, hotspots, and rules for the file at hand.';

export const MCP_SERVER_FEATURE_PREVIEW =
  'Gives the agent direct access to your SonarQube project: issues, quality profiles, and rules.';
