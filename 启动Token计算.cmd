@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "DSH_PY=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
set "BRIDGE=import runpy,sys; from pathlib import Path; project=sys.argv.pop(1); runpy.run_path(str(Path(project)/'\u672c\u5730\u670d\u52a1'/'bridge.py'),run_name='__main__')"

if not exist "%DSH_PY%" goto find_py
"%DSH_PY%" -I -B -c "%BRIDGE%" "%~dp0." --minimize-console %*
goto finished

:find_py
py -3 -I -B -c "from openpyxl.cell.rich_text import CellRichText" >nul 2>&1
if errorlevel 1 goto find_python
py -3 -I -B -c "%BRIDGE%" "%~dp0." --minimize-console %*
goto finished

:find_python
python -I -B -c "from openpyxl.cell.rich_text import CellRichText" >nul 2>&1
if errorlevel 1 goto missing
python -I -B -c "%BRIDGE%" "%~dp0." --minimize-console %*
goto finished

:missing
echo Token Billing needs the DeepSeek Harness bundled Python or Python 3 with openpyxl 3.1+.
pause
exit /b 1

:finished
set "BRIDGE_EXIT=%errorlevel%"
if not "%BRIDGE_EXIT%"=="0" pause
exit /b %BRIDGE_EXIT%
