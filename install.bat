@echo off
chcp 65001 >nul
echo ============================================
echo  Tanyra3D — установка зависимостей
echo ============================================
echo.

echo [1/2] Установка gltf-transform (через npm)...
where npm >nul 2>nul
if errorlevel 1 (
    echo [ОШИБКА] npm не найден. Установи Node.js LTS с https://nodejs.org и запусти этот файл снова.
    pause
    exit /b 1
)
call npm install --global @gltf-transform/cli
if errorlevel 1 (
    echo [ОШИБКА] npm install завершился с ошибкой — смотри сообщения выше.
    pause
    exit /b 1
)
echo [OK] gltf-transform установлен.
echo.

echo [2/2] Проверка KTX-Software (toktx)...
where toktx >nul 2>nul
if not errorlevel 1 (
    echo [OK] toktx уже установлен и есть в PATH. Всё готово!
    pause
    exit /b 0
)
if exist "C:\Program Files\KTX-Software\bin\toktx.exe" (
    echo [OK] toktx найден в C:\Program Files\KTX-Software\bin — скрипт подхватит его сам.
    pause
    exit /b 0
)

echo toktx не найден. Скачиваю установщик KTX-Software v4.4.2 (~6 МБ)...
set "KTX_URL=https://github.com/KhronosGroup/KTX-Software/releases/download/v4.4.2/KTX-Software-4.4.2-Windows-x64.exe"
set "KTX_EXE=%TEMP%\KTX-Software-4.4.2-Windows-x64.exe"
curl.exe -L -o "%KTX_EXE%" "%KTX_URL%"
if errorlevel 1 (
    echo [ОШИБКА] Не удалось скачать. Скачай вручную: %KTX_URL%
    pause
    exit /b 1
)
echo.
echo Запускаю установщик. В окне установки, если будет предложено,
echo поставь галочку "Add to PATH" (не критично - скрипт найдёт toktx и так).
start /wait "" "%KTX_EXE%"
echo.

where toktx >nul 2>nul
if not errorlevel 1 (
    echo [OK] toktx установлен и в PATH. Всё готово!
) else if exist "C:\Program Files\KTX-Software\bin\toktx.exe" (
    echo [OK] toktx установлен в Program Files - скрипт подхватит его сам. Всё готово!
) else (
    echo [ВНИМАНИЕ] toktx не обнаружен. Если отменил установку - запусти install.bat снова.
)
pause