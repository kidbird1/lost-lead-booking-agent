@echo off
cd /d "%~dp0"
echo.
echo Paste each key when asked, then press Enter.
echo (Right-click pastes in this window. The key will not show on screen.)
echo.
echo === 1 of 3: Vapi PRIVATE key (dashboard.vapi.ai - API Keys) ===
call npx.cmd wrangler secret put VAPI_API_KEY
echo.
echo === 2 of 3: Twilio Account SID (console.twilio.com home page) ===
call npx.cmd wrangler secret put TWILIO_ACCOUNT_SID
echo.
echo === 3 of 3: Twilio Auth Token (console.twilio.com home page) ===
call npx.cmd wrangler secret put TWILIO_AUTH_TOKEN
echo.
echo All done. You can close this window.
pause
