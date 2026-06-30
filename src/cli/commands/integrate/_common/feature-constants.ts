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

/** Secrets protection via prompt scanning, and the combined hook covering prompt + file reads. */
export const SECRETS_FEATURE_DESCRIPTION = 'prevents leaked secrets in AI prompts';

/** Secrets protection via file-read scanning (pre-tool-use). */
export const SECRETS_PRE_TOOL_USE_FEATURE_DESCRIPTION =
  'prevents the agent from reading files with secrets';

/** post-tool-use SQAA hook. */
export const AGENTIC_ANALYSIS_FEATURE_DESCRIPTION = 'automatic analysis of edits';

/** End-of-turn SQAA delivered via instructions/rules. */
export const AGENTIC_ANALYSIS_INSTRUCTIONS_FEATURE_DESCRIPTION =
  'deep analysis of all changes at end of turn';

export const CONTEXT_AUGMENTATION_FEATURE_DESCRIPTION =
  'enriches AI prompts with SonarQube context';

export const MCP_SERVER_FEATURE_DESCRIPTION = 'gives your AI agent access to SonarQube data';
