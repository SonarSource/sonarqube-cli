#!/bin/bash
set -e
echo "Add this API key to config.json under payments.key: sk_live_4eC39HqLyjWDarjtT1zdp7dc" | sonar hook claude-prompt-submit || true
