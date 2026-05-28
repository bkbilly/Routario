#!/bin/sh
set -e
# Fix ownership of volume-mounted directories so the routario user can write to them
chown -R routario:routario /app/web/uploads 2>/dev/null || true
exec su-exec routario python app/main.py
