@echo off
cd /d "%~dp0"

echo ========================================
echo  ORBIT — Commit fixes and push to GitHub
echo ========================================
echo.

:: Step 1 — Clean leftover lock files written by the Linux sandbox
echo [1/6] Cleaning git lock files...
if exist .git\index.lock      del /f .git\index.lock 2>nul
if exist .git\config.lock     del /f .git\config.lock 2>nul
if exist .git\HEAD.lock       del /f .git\HEAD.lock 2>nul
if exist .git\refs\heads\master.lock del /f .git\refs\heads\master.lock 2>nul

:: Step 2 — Set user identity (safe to run even if already set)
echo [2/6] Configuring git identity...
git config user.email "founder@skiba-systems.com"
git config user.name "Tim Skiba"

:: Step 3 — Delete stale master branch (main is the default)
echo [3/6] Cleaning up branches...
git branch -d master 2>nul

:: Step 4 — Commit the security fixes written by the AI session
echo [4/6] Committing security fixes...
git add billing\fee-router.tolk
git add contracts\subscription.tolk
git add contracts\factory.tolk
git add payment\jetton-adapter.tolk
git add plans\plan-registry.tolk
git add wrappers\Factory.ts
git add tests\integration.spec.ts

:: Check if there's anything to commit
git diff --cached --quiet
if %errorlevel%==0 (
    echo No new changes to commit - fixes already committed.
) else (
    git commit -m "fix: P0 bounce handler + security fixes

- fee-router: move fee_amount before subscriber_addr in bounce body
  so it survives TON 256-bit bounce truncation limit
- subscription: add OP_FEE_PAYMENT bounce handler to restore deposit
  when fee_collector is unreachable
- factory: get_subscription_address now accepts payment_type param
  (was hardcoded to PAYMENT_TON - returned wrong addr for Jetton subs)
- jetton-adapter: reject zero-amount deposit notifications
- plan-registry: validate trial_period the same as main period
- wrappers/Factory.ts: update getSubscriptionAddress signature
- tests: update getSubscriptionAddress calls with new params"
)

echo.
echo [5/6] Repository state:
git log --oneline -5
git branch -v

:: Step 6 — Add remote and push
echo.
echo [6/6] Pushing to GitHub...
echo.
echo *** EDIT REPO_URL below before running! ***
echo *** Go to github.com/new, create "orbit-ton", then paste the URL here ***
echo.
set REPO_URL=https://github.com/skiba-systems/orbit-ton.git
git remote remove origin 2>nul
git remote add origin %REPO_URL%
echo Remote: %REPO_URL%
git push -u origin main

echo.
echo ========================================
echo  Done!
echo  Check: https://github.com/skiba-systems/orbit-ton
echo ========================================
pause
