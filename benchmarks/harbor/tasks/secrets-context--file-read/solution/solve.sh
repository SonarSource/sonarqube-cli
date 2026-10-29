#!/bin/bash
set -e
echo "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/app/config/.env.local\"}}" | sonar hook claude-pre-tool-use || true
