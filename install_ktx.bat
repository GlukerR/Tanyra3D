@echo off
chcp 65001 >nul
echo === Установка KTX-Software toktx v4.4.2 ===
echo.

set "KTX_URL=https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Windows-x64.exe"
set "KTX_EXE=%TEMP%\KTX-Software-4.4.2-Windows-x64.exe"

echo [1/3] Скачивание установщика, ~6 МБ...
curl.exe -L --fail -o "%KTX_EXE%" "%KTX_URL%"
if errorlevel 1 goto :dl_fail

set "KTX_SIZE=0"
for %%A in ("%KTX_EXE%") do set "KTX_SIZE=%%~zA"
if %KTX_SIZE% LSS 1000000 goto :dl_small
echo [OK] Скачано: %KTX_SIZE% байт.
echo.

echo [2/3] Тихая установка. Сейчас появится запрос UAC -
echo       "Разрешить приложению внести изменения?" - нажми ДА.
start /wait "" "%KTX_EXE%" /S
echo.

echo [3/3] Проверка...
if exist "C:\Program Files\KTX-Software\bin\toktx.exe" goto :ok

echo toktx не найден в стандартной папке, ищу по Program Files...
dir "C:\Program Files\toktx.exe" /s /b 2>nul
echo.
echo [ВНИМАНИЕ] Если выше напечатался путь - скажи его Клоду.
echo Если пусто - вероятно, отклонён запрос UAC. Запусти файл снова.
pause
exit /b 1

:ok
echo [OK] toktx установлен: C:\Program Files\KTX-Software\bin\toktx.exe
echo Всё готово! Можно запускать optimize.py
pause
exit /b 0

:dl_fail
echo [ОШИБКА] Скачивание не удалось. Проверь интернет и попробуй снова.
echo Либо скачай вручную в браузере:
echo %KTX_URL%
pause
exit /b 1

:dl_small
echo [ОШИБКА] Файл скачался неполным: %KTX_SIZE% байт. Попробуй снова.
pause
exit /b 1