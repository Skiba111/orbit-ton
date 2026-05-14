@echo off
cd /d "%~dp0"
echo Cleaning git lock files...
if exist .git\index.lock del /f .git\index.lock
if exist .git\config.lock del /f .git\config.lock
echo Configuring git user...
git config user.email "founder@skiba-systems.com"
git config user.name "Tim Skiba"
git branch -m master main
echo Staging all files...
git add -A
echo Creating first commit...
git commit -m "feat: initial release v0.1.0

- FeeCollector + Factory + Subscription contracts (Tolk)
- Keeper network with two-tier rewards
- Jetton (TEP-74) + TON native payment support
- Two-phase timelock withdrawal in FeeCollector
- React SDK with hooks and UI components
- Blueprint wrappers and integration tests
- Full documentation (WHITEPAPER, DEPLOYMENT, SECURITY, INTEGRATION)"
echo.
echo === Done! ===
echo.
git log --oneline -3
git status
pause
