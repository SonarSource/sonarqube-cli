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

/** Steps that belong to the whole run. */
export type RunStepId = 'login' | 'create_org' | 'detect' | 'org_bind' | 'integrate';
/** Steps that belong to one project root of the run. */
export type ProjectStepId = 'project_bind' | 'create_project' | 'link';
export type InitStepId = RunStepId | ProjectStepId;

/** How a step ended. `failed` without an error means it ended with nothing left to do. */
export type InitStepOutcome = 'success' | 'already_done' | 'skipped' | 'declined' | 'failed';

/**
 * Why a step that threw nothing still ends the run. `cancelled` lands on the last step the user
 * declined, and is dropped when nothing was declined.
 */
export type InitStopReason = 'no_org' | 'unknown' | 'cancelled';

/** The onboarding path a project root takes. */
export type InitPathId = 'already_done' | 'link_existing' | 'bound_new' | 'unbound_new';
