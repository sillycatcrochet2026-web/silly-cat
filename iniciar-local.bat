@echo off
setlocal
cd /d "%~dp0"

if not exist "worker\node_modules" (
  echo Instalando Wrangler na primeira execucao...
  pushd worker
  call npm install
  popd
)

if not exist "worker\.dev.vars" (
  echo.
  echo ATENCAO: copie worker\.dev.vars.example para worker\.dev.vars e configure os segredos.
  echo.
)

start "Silly Cat Worker" cmd /k "cd /d ""%~dp0worker"" && npx wrangler dev --port 8787"
start "Silly Cat Frontend" cmd /k "cd /d ""%~dp0"" && python -m http.server 8000"
timeout /t 2 >nul
start http://127.0.0.1:8000
