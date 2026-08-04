@echo off
rem Lanzado por el Programador de tareas de Windows (equivalente local a com.tito.watchlist-sync.plist
rem en macOS). El Programador arranca con un PATH minimo que no incluye Git Bash, el binario de
rem `claude` (instalado via npm/.local\bin) ni `python3` (Windows Apps), asi que se arma aqui antes
rem de invocar el script real. Ver docs/superpowers/specs/2026-07-24-sync-automatico-robinhood-design.md.
set "PATH=C:\Program Files\Git\usr\bin;C:\Users\emiay\AppData\Roaming\npm;C:\Users\emiay\.local\bin;C:\Users\emiay\AppData\Local\Microsoft\WindowsApps;%PATH%"
set "LOGDIR=C:\Users\emiay\Downloads\Agente Tito Metralleta (1)\Agente Tito Metralleta\web\data"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
"C:\Program Files\Git\usr\bin\bash.exe" "C:\Users\emiay\Downloads\Agente Tito Metralleta (1)\Agente Tito Metralleta\web\scripts\sync-watchlist.sh" >> "%LOGDIR%\sync-task.log" 2>&1
