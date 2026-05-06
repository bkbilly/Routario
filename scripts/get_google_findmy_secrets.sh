#!/usr/bin/env bash
# Generate Auth/secrets.json for the Google Find My integration.
#
# Uses https://github.com/leonboe1/GoogleFindMyTools which opens a real
# Chrome browser to complete the Google OAuth flow once, then saves the
# resulting credentials to Auth/secrets.json.
#
# Requirements: git, python3, pip, Google Chrome installed.
#
# Usage:
#   ./scripts/get_google_findmy_secrets.sh
#
# After running, paste the full contents of Auth/secrets.json into the
# "secrets.json contents" field in the Google Find My integration settings.

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/GoogleFindMyTools"
SECRETS_FILE="$TOOLS_DIR/Auth/secrets.json"

# Clone the tool if not already present
if [ ! -d "$TOOLS_DIR" ]; then
    echo "Cloning GoogleFindMyTools..."
    git clone https://github.com/leonboe1/GoogleFindMyTools "$TOOLS_DIR"
fi

cd "$TOOLS_DIR"

# Install Python dependencies into a local venv to avoid polluting the system
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment and installing dependencies..."
    python3 -m venv .venv
    .venv/bin/pip install --quiet -r requirements.txt
fi

echo ""
echo "Starting Google authentication flow."
echo "A Chrome browser window will open — sign in with the Google account"
echo "whose Find My devices you want to track."
echo ""

.venv/bin/python main.py

if [ ! -f "$SECRETS_FILE" ]; then
    echo ""
    echo "Error: $SECRETS_FILE was not created. Check the output above for errors."
    exit 1
fi

echo ""
echo "Done! secrets.json generated at:"
echo "  $SECRETS_FILE"
echo ""
echo "Copy the contents below and paste them into the"
echo "'secrets.json contents' field in Routario's Google Find My integration:"
echo ""
echo "--- BEGIN secrets.json ---"
cat "$SECRETS_FILE"
echo ""
echo "--- END secrets.json ---"
