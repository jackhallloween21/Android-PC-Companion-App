@echo off
REM ---------------------------------------------------------------------------
REM Build softcam-bridge.exe (x64) against a freshly built copy of tshino/softcam.
REM
REM Must run inside an "x64 Native Tools" environment (vcvars64.bat already
REM called) so cl.exe / link.exe are on PATH. The CI workflow arranges this via
REM vswhere + vcvars64; to build by hand, open "x64 Native Tools Command Prompt
REM for VS 2022" and run this script.
REM
REM Inputs (env vars, or the positional args which take precedence):
REM   SOFTCAM_INC  folder containing softcam.h        (arg 1)
REM   SOFTCAM_LIB  full path to softcam.lib           (arg 2)
REM   OUT_DIR      output folder (default: this dir)  (arg 3, optional)
REM ---------------------------------------------------------------------------
setlocal enabledelayedexpansion

if not "%~1"=="" set "SOFTCAM_INC=%~1"
if not "%~2"=="" set "SOFTCAM_LIB=%~2"
if not "%~3"=="" set "OUT_DIR=%~3"
if "%OUT_DIR%"=="" set "OUT_DIR=%~dp0"

if "%SOFTCAM_INC%"=="" (
  echo [build.bat] ERROR: SOFTCAM_INC ^(folder containing softcam.h^) is not set.
  exit /b 1
)
if "%SOFTCAM_LIB%"=="" (
  echo [build.bat] ERROR: SOFTCAM_LIB ^(path to softcam.lib^) is not set.
  exit /b 1
)

where cl.exe >nul 2>nul
if errorlevel 1 (
  echo [build.bat] ERROR: cl.exe not found. Run from an x64 Native Tools prompt ^(vcvars64.bat^).
  exit /b 1
)

echo [build.bat] Compiling softcam-bridge.exe
echo [build.bat]   include: %SOFTCAM_INC%
echo [build.bat]   lib:     %SOFTCAM_LIB%
echo [build.bat]   out:     %OUT_DIR%

REM /MT statically links the CRT so the shipped exe needs no VC++ redistributable.
cl /nologo /std:c++17 /EHsc /O2 /MT /DNDEBUG ^
   /I "%SOFTCAM_INC%" ^
   "%~dp0softcam-bridge.cpp" ^
   /Fe:"%OUT_DIR%\softcam-bridge.exe" ^
   /Fo:"%OUT_DIR%\softcam-bridge.obj" ^
   /link "%SOFTCAM_LIB%"

if errorlevel 1 (
  echo [build.bat] ERROR: compilation failed.
  exit /b 1
)

echo [build.bat] OK -^> %OUT_DIR%\softcam-bridge.exe
endlocal
