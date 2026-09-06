@echo off
setlocal
title Prism 3D Viewer - build

echo.
echo   Prism 3D Viewer - Windows build
echo   ================================
echo.

where node >nul 2>nul || (echo [X] Node.js not found. Install it from https://nodejs.org & goto fail)
where cargo >nul 2>nul || (echo [X] Rust not found. Install it from https://rustup.rs & goto fail)

for /f "tokens=2" %%v in ('rustc -V') do set RUSTV=%%v
echo   node   %%  & node -v
echo   rustc  %RUSTV%
echo.

REM Tauri 2 needs Rust 1.77 or newer.
for /f "tokens=1,2 delims=." %%a in ("%RUSTV%") do (
  if %%a LSS 1 goto oldrust
  if %%a EQU 1 if %%b LSS 77 goto oldrust
)

echo   [1/2] Installing dependencies...
call npm ci --no-audit --no-fund || goto fail

echo.
echo   [2/2] Building. The first run compiles ~400 crates and can take
echo         10-15 minutes. Later runs are much faster.
echo.
call npm run build || goto fail

echo.
echo   Done. Installer:
dir /b "src-tauri\target\release\bundle\nsis\*.exe" 2>nul
echo.
choice /c yn /n /m "   Open the output folder? [y/n] "
if errorlevel 2 goto end
start "" "src-tauri\target\release\bundle\nsis"
goto end

:oldrust
echo   [X] Rust %RUSTV% is too old - Tauri 2 needs 1.77 or newer.
echo       Run:  rustup update stable
goto fail

:fail
echo.
echo   Build did not complete. Scroll up for the first error.
echo   If it is a Rust error, the file and line number are in the message.
pause
exit /b 1

:end
echo.
pause
exit /b 0
