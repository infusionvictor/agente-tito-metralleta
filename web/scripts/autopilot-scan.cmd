@echo off
"C:\Program Files\nodejs\node.exe" "%~dp0autopilot-scan.mjs" 3000 >> "%~dp0..\data\autopilot-scan.log" 2>&1
