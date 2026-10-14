@echo off
cd /d "%~dp0"
title Character Direct - Higgsfield Genjutsu
echo ========================================================
echo   Iniciando Character Direct (100% Higgsfield Direto)
echo ========================================================
start http://localhost:3333/app
node server.js
if %errorlevel% neq 0 (
  echo.
  echo [ERRO] Ocorreu uma falha ao iniciar o servidor Node.js.
  pause
)
