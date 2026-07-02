@echo off
setlocal enabledelayedexpansion

echo Checking for local Python installations...

:: 1. Search in WindowsApps for PythonSoftwareFoundation
set "REAL_PYTHON="
for /d %%d in ("%USERPROFILE%\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.*") do (
    if exist "%%d\python.exe" (
        set "REAL_PYTHON=%%d\python.exe"
    )
)

:: 2. If found, run it
if not "!REAL_PYTHON!"=="" (
    echo [INFO] Found Microsoft Store Python at: "!REAL_PYTHON!"
    echo [INFO] Launching Vesper SMTP Relay Server...
    echo ---------------------------------------------------
    "!REAL_PYTHON!" -u "%~dp0server.py" %1
    goto :end
)

:: 3. Try standard python in PATH
echo [INFO] Trying system 'python' command...
python -u "%~dp0server.py" %1
if %ERRORLEVEL% equ 0 goto :end

:: 4. Try system 'py' command
echo [INFO] Trying system 'py' command...
py -u "%~dp0server.py" %1
if %ERRORLEVEL% equ 0 goto :end

:: 5. Display troubleshooting if all failed
echo.
echo ============================================================
echo [ERROR] Python could not be detected.
echo ============================================================
echo Please resolve the Microsoft Store App Execution Alias issue:
echo 1. Click Start and type "App execution aliases".
echo 2. Open "App execution aliases" settings.
echo 3. Turn OFF the toggles for "python.exe" and "python3.exe".
echo 4. Restart this script.
echo ============================================================
echo.
pause

:end
