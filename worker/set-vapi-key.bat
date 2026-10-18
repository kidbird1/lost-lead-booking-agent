@echo off
cd /d "%~dp0"
echo.
echo Paste the Vapi PRIVATE key (not the Public one), then press Enter.
echo.
call npx.cmd wrangler secret put VAPI_API_KEY
echo.
echo All done. You can close this window.
pause
