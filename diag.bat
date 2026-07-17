@echo off
chcp 65001 >nul
set "REPORT=%~dp0diag_report.txt"
echo === diag glb_web_optimize === > "%REPORT%"
echo. >> "%REPORT%"

echo [where toktx] >> "%REPORT%"
where toktx >> "%REPORT%" 2>&1
echo. >> "%REPORT%"

echo [where gltf-transform] >> "%REPORT%"
where gltf-transform >> "%REPORT%" 2>&1
echo. >> "%REPORT%"

echo [Program Files - папки с KTX в имени] >> "%REPORT%"
dir "C:\Program Files" /b /ad 2>nul | findstr /i ktx >> "%REPORT%"
dir "C:\Program Files (x86)" /b /ad 2>nul | findstr /i ktx >> "%REPORT%"
echo. >> "%REPORT%"

echo [поиск toktx.exe в Program Files - может занять секунд 20] >> "%REPORT%"
dir "C:\Program Files\toktx.exe" /s /b 2>nul >> "%REPORT%"
dir "C:\Program Files (x86)\toktx.exe" /s /b 2>nul >> "%REPORT%"
echo. >> "%REPORT%"

echo [PATH из реестра - есть ли там KTX] >> "%REPORT%"
reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2>nul | findstr /i ktx >> "%REPORT%"
reg query "HKCU\Environment" /v Path 2>nul | findstr /i ktx >> "%REPORT%"
echo. >> "%REPORT%"
echo === конец отчёта === >> "%REPORT%"

echo Отчёт записан в diag_report.txt рядом с этим файлом.
echo Можно закрыть окно и сказать Клоду, что диагностика готова.
pause