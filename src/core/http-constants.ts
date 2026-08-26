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

// Shared HTTP status code constants used across API clients.

export const HTTP_STATUS_BAD_REQUEST = 400;
export const HTTP_STATUS_FORBIDDEN = 403;
export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_BAD_GATEWAY = 502;
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
export const HTTP_STATUS_GATEWAY_TIMEOUT = 504;
