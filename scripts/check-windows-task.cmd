@echo off
rem check-windows-task: prove folder-sync runs from Task Scheduler on this box
rem (docs/peps/0001 section 7: "the install proves itself from a scheduled run
rem that writes a log into ~/.folder-sync/").
rem
rem Usage:  scripts\check-windows-task.cmd C:\path\to\synced\folder [C:\path\to\folder-sync.exe]
rem
rem Before: run "folder-sync init" in that folder and "folder-sync login". A scheduled
rem task does not see your shell's environment variables, so the key must be stored.
rem It registers a one-off task, runs it once, waits for its round, checks the result,
rem checks nothing landed in AppData, and deletes the task. A .cmd file, not PowerShell,
rem so the AllSigned execution policy does not block it.
setlocal EnableExtensions EnableDelayedExpansion

set "FOLDER=%~1"
if "%FOLDER%"=="" (
  echo usage: %~nx0 FOLDER [folder-sync.exe]
  exit /b 2
)
set "EXE=%~2"
if "%EXE%"=="" set "EXE=%USERPROFILE%\.folder-sync\bin\folder-sync.exe"
if not exist "%EXE%" (
  echo check-windows-task: %EXE% not found
  exit /b 2
)
set "STATE=%USERPROFILE%\.folder-sync"
set "TMPD=%STATE%\tmp"
if not exist "%TMPD%" mkdir "%TMPD%"
set "TASK=folder-sync-check-%RANDOM%"
set "RESULT=0"

set "APPDATA_BEFORE=0"
if exist "%APPDATA%\rclone" set "APPDATA_BEFORE=1"
if exist "%LOCALAPPDATA%\rclone" set "APPDATA_BEFORE=1"

call :last_round BEFORE
echo check-windows-task: last round before: !BEFORE!

rem /ST is required by /SC ONCE; the task only ever runs through /Run below.
schtasks /Create /TN "%TASK%" /SC ONCE /ST 23:59 /F /RL LIMITED /TR "\"%EXE%\" sync --once --dir \"%FOLDER%\"" >nul
if errorlevel 1 (
  echo FAIL  could not register the task %TASK%
  exit /b 1
)
echo PASS  registered task %TASK%
schtasks /Run /TN "%TASK%" >nul
if errorlevel 1 (
  echo FAIL  could not start the task
  set "RESULT=1"
  goto :cleanup
)

set /a WAITED=0
:wait
timeout /t 2 /nobreak >nul
set /a WAITED+=2
call :last_round AFTER
if not "!AFTER!"=="!BEFORE!" goto :ran
if !WAITED! GEQ 90 (
  echo FAIL  the scheduled round did not finish within 90 s
  set "RESULT=1"
  goto :cleanup
)
goto :wait

:ran
echo       last round after:  !AFTER! !AFTER_RESULT!
if /i "!AFTER_RESULT!"=="ok" (
  echo PASS  a Task Scheduler run of folder-sync finished a round
) else (
  echo FAIL  the scheduled round did not succeed; run "%EXE%" status --dir "%FOLDER%"
  set "RESULT=1"
)
dir /b "%STATE%\logs\*.log" >nul 2>&1
if errorlevel 1 (
  echo FAIL  no log in %STATE%\logs
  set "RESULT=1"
) else (
  echo PASS  the run wrote its log into %STATE%\logs
)
if "%APPDATA_BEFORE%"=="0" (
  if exist "%APPDATA%\rclone" (
    echo FAIL  rclone wrote to %APPDATA%\rclone
    set "RESULT=1"
  ) else if exist "%LOCALAPPDATA%\rclone" (
    echo FAIL  rclone wrote to %LOCALAPPDATA%\rclone
    set "RESULT=1"
  ) else (
    echo PASS  nothing appeared under %%APPDATA%% or %%LOCALAPPDATA%%
  )
) else (
  echo NOTE  an rclone folder already existed under AppData before this run; not judged
)

:cleanup
schtasks /Delete /TN "%TASK%" /F >nul 2>&1
echo       deleted task %TASK%
if "%RESULT%"=="0" (echo check-windows-task: all checks passed) else (echo check-windows-task: FAILED)
exit /b %RESULT%

rem :last_round VAR  sets VAR to "<date> <time>" and VAR_RESULT to "ok" or "FAILED:"
rem from the "last round:" line of `folder-sync status`.
:last_round
set "%1=none"
set "%1_RESULT="
rem The outer pair of quotes survives cmd /c's quote stripping.
for /f "tokens=3,4,7" %%a in ('""%EXE%" status --dir "%FOLDER%" 2^>nul ^| findstr /C:"last round:""') do (
  set "%1=%%a %%b"
  set "%1_RESULT=%%c"
)
exit /b 0
