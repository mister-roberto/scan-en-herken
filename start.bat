@echo off
rem Scan & Herken starten op Windows: dubbelklik op dit bestand.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is niet geinstalleerd. Download versie 22 of hoger op https://nodejs.org en start dit bestand opnieuw.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Eenmalige installatie, een ogenblik...
  call npm install
)
start "" http://localhost:3000
if exist .env (
  echo Scan ^& Herken start met AI. Laat dit venster open; sluit het om te stoppen.
  call npm start
) else (
  echo Geen .env-bestand met API-sleutel gevonden: het programma start in demomodus.
  call npm run demo
)
pause
