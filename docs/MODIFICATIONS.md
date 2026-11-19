# Files modified from sparkDash

ComputeDash is a modified version of [sparkDash](https://github.com/MiaAI-Lab/sparkDash) by Mia's AI Lab, licensed under the Apache License 2.0. Section 4(b) of that license asks that modified files carry a notice that they were changed. This page is that notice: every file below exists in sparkDash and **has been modified in ComputeDash**. Files that ComputeDash added are not listed; they are ComputeDash's own (for example `server/fleet/`, `src/components/ModelsPage/`, `src/components/FleetBoard/`, `scripts/setup.mjs`).

The list compares this tree with sparkDash commit `791a0837a6ed` (the version ComputeDash is based on). The repository history records each change in detail. To refresh it after merging a newer sparkDash:

```bash
git diff --name-only --diff-filter=M "$(git merge-base HEAD upstream/main)"
```

## (repository root)

- `.env.example`
- `.gitignore`
- `CHANGELOG.md`
- `CODEBASE.md`
- `NOTICE`
- `README.md`
- `docker-compose.dev.yml`
- `docker-compose.image.yml`
- `docker-compose.yml`
- `package-lock.json`
- `package.json`

## agents/

- `agents/macos/README.md`

## docs/

- `docs/REMOTE-ACCESS.md`

## public/

- `public/sw.js`

## server/

- `server/__tests__/inference-activity-route.test.js`
- `server/__tests__/isolatedEnv.js`
- `server/auth.js`
- `server/collectors/__tests__/llmTunnel.test.js`
- `server/collectors/__tests__/ssh.multiplex.test.js`
- `server/collectors/__tests__/ssh.test.js`
- `server/collectors/llmTunnel.js`
- `server/collectors/ssh.js`
- `server/config.js`
- `server/health.js`
- `server/index.js`
- `server/models/__tests__/discovery.test.js`
- `server/settings.js`
- `server/sparks/SparkRegistry.js`
- `server/sparks/__tests__/auth-and-targets.test.js`
- `server/sparks/__tests__/auth-status.test.js`
- `server/sparks/__tests__/health.test.js`
- `server/sparks/__tests__/startup-preflight.test.js`
- `server/startupPreflight.js`

## src/

- `src/App.tsx`
- `src/api/client.ts`
- `src/api/types.ts`
- `src/components/AddSparkDialog.test.tsx`
- `src/components/AddSparkDialog.tsx`
- `src/components/EditSparkDialog.test.tsx`
- `src/components/EditSparkDialog.tsx`
- `src/components/OverviewPage/ActivityFeed.tsx`
- `src/components/OverviewPage/FleetEnergyCard.test.tsx`
- `src/components/OverviewPage/FleetEnergyCard.tsx`
- `src/components/OverviewPage/InferenceTrafficCard.test.tsx`
- `src/components/OverviewPage/InferenceTrafficCard.tsx`
- `src/components/OverviewPage/OverviewPage.tsx`
- `src/components/OverviewPage/SparkCard.tsx`
- `src/components/SettingRows.tsx`
- `src/components/SettingsDialog.tsx`
- `src/components/addSparkSteps.test.ts`
- `src/components/addSparkSteps.ts`
- `src/components/shell/AppSidebar.tsx`
- `src/components/shell/MobileTabBar.tsx`
- `src/components/shell/shell.test.tsx`
- `src/components/ui/ConnectionBanner.tsx`
- `src/components/ui/icons.tsx`
- `src/constants.test.ts`
- `src/constants.ts`
- `src/hooks/useRoute.test.tsx`
- `src/hooks/useRoute.ts`
- `src/i18n/index.test.ts`
- `src/i18n/index.ts`
- `src/locales/en/devices.json`
- `src/locales/en/overview.json`
- `src/locales/en/settings.json`
- `src/locales/en/shell.json`
- `src/locales/zh-CN/devices.json`
- `src/locales/zh-CN/overview.json`
- `src/locales/zh-CN/settings.json`
- `src/locales/zh-CN/shell.json`
- `src/main.tsx`
- `src/styles/overview.css`
- `src/styles/shell.css`
- `src/testing/setup.ts`

