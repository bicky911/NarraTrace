@echo off
cd /d "%~dp0"
title Upload NarraTrace to GitHub
echo ================================================================
echo       NARRATRACE - 1-CLICK GITHUB UPLOAD
echo ================================================================
echo.

set "PATH=C:\Users\bicky_local\.local\bin;C:\Users\bicky_local\.local\git\cmd;%PATH%"

gh auth status >nul 2>&1
if %errorlevel% neq 0 (
    echo [1/3] Authorizing with your GitHub account...
    echo       A browser tab will open. Since you are already signed
    echo       in on Chrome, simply confirm the one-time code and click "Authorize".
    echo.
    gh auth login --web -p https
)

echo.
echo [2/3] Checking if remote repository exists...
git remote get-url origin >nul 2>&1
if %errorlevel% neq 0 (
    echo [3/3] Creating public GitHub repository 'read-aloud' and pushing...
    gh repo create read-aloud --public --source=. --remote=origin --push
) else (
    echo [3/3] Pushing to existing origin...
    git push -u origin main
)

echo.
echo ================================================================
echo   SUCCESS: Project successfully uploaded to your GitHub!
echo ================================================================
pause
