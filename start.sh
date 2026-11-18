#!/bin/sh
# Scan & Herken starten op Mac of Linux: ./start.sh
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null || { echo "Node.js is niet geinstalleerd. Download versie 22 of hoger op https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install
(sleep 2; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1) &
if [ -f .env ]; then npm start; else echo "Geen .env met API-sleutel gevonden: demomodus."; npm run demo; fi
