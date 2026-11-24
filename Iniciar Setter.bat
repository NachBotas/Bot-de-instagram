@echo off
title Setter de Instagram
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Necesitas instalar Node.js primero: https://nodejs.org  (la version LTS^)
  pause
  exit /b
)
if not exist node_modules (
  echo Instalando por primera vez, puede tardar un par de minutos...
  call npm install
)
echo.
echo Abriendo el panel del setter. NO cierres esta ventana mientras quieras que el bot responda.
echo.
call npm run app
pause
