@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Tanyra3D v2 - установка npm-зависимостей ===
echo.
where npm >nul 2>nul
if errorlevel 1 goto :no_npm
call npm install
if errorlevel 1 goto :npm_fail
echo.
echo [OK] Зависимости установлены. Запуск: node optimize2.mjs
pause
exit /b 0

:no_npm
echo [ОШИБКА] npm не найден. Установи Node.js LTS с https://nodejs.org
pause
exit /b 1

:npm_fail
echo [ОШИБКА] npm install завершился с ошибкой - смотри сообщения выше.
pause
exit /b 1