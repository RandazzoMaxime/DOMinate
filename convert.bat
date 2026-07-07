@echo off
setlocal
cd /d "%~dp0"

set PORT=5173

echo Lancement du serveur HTML vers PDF...
start "html-to-pdf-server" /min cmd /c "node scripts\serve-demo.mjs"

timeout /t 1 /nobreak >nul

start "" "http://localhost:%PORT%/demo/converter.html"

echo.
echo Serveur lance sur http://localhost:%PORT%/
echo Glisse-depose un fichier .html dans la page qui vient de s'ouvrir.
echo Ferme cette fenetre pour arreter le serveur.
echo.
pause >nul
taskkill /fi "WindowTitle eq html-to-pdf-server*" /t /f >nul 2>&1
