# Implementation Prompt: Option A — Fully Local Scanning via Docker SonarQube

> Status: IMPLEMENTED (2026-07-04) — local Docker scanning is live with a
> Local/Server target picker and Full/Changed scan scopes. This document is
> kept as the reference spec. Not yet built from the spec: a
> `sonarlens.stopLocalServer` command and a container status row in the UI.

---

## Prompt

Implement a fully local scan mode for the SonarLens VS Code extension
(this repository). Goal: a developer can scan his working copy entirely on
his own machine — no code, analysis report, or issues ever reach the
central/cloud SonarQube server.

### Background (current state)

- The extension has a "Local Scan" tab (`webview/index.html`, `webview/script.js`)
  with Sync Rules / View Rules / Scan Branch. Scan currently runs
  `sonar-scanner` against the central server configured in extension settings
  (`src/utils/scannerUtils.ts`, `handleScanBranch` in `src/ui/baseProvider.ts`),
  polls the CE task, and fetches issues from that server.
- Rules from the org's quality profiles are already synced and cached in
  `globalState` under `sonarRulesCache` (see `handleSyncRules`).
- sonar-scanner cannot work offline: it downloads analyzers from a server and
  the server computes issues. Therefore "fully local" = run a SonarQube
  server locally in Docker and point the scanner at it.

### What to build

1. **Local server lifecycle (new module `src/utils/localSonarUtils.ts`)**
   - Detect Docker: `docker info` (fail with friendly install instructions
     per OS if missing, same style as `SCANNER_NOT_FOUND_MSG`).
   - Start container if not running:
     `docker run -d --name sonarlens-local -p 127.0.0.1:9876:9000 -v sonarlens-data:/opt/sonarqube/data sonarqube:community`
     (fixed non-default port to avoid clashing with anything on 9000; named
     volume so analyses/config survive restarts).
   - Wait for readiness by polling `http://127.0.0.1:9876/api/system/status`
     until `status: "UP"` (timeout ~120s first run, ~60s warm). Stream progress
     lines to the existing scan log UI (`scanProgress` messages).
   - First-run bootstrap: change default admin password (SonarQube forces it),
     generate a user token via `POST /api/user_tokens/generate`, store it in
     `context.secrets` under `localSonarToken`. Never hardcode credentials in
     code that gets committed; generate a random admin password and store it
     in secrets too.
   - Provide `stopLocalSonar()` (docker stop) exposed as a command
     `sonarlens.stopLocalServer` so devs can reclaim RAM.

2. **Quality profile import (rules parity with the org server)**
   - When the user syncs rules, additionally download each profile's backup
     XML from the central server: `GET /api/qualityprofiles/backup?qualityProfile=<name>&language=<lang>`.
     Cache the XMLs in `globalState` (or workspace storage if too big).
   - Before the first local scan (or when the cache changes), restore each
     profile into the local server: `POST /api/qualityprofiles/restore` with
     the XML, then set as default for its language:
     `POST /api/qualityprofiles/set_default`.
   - This makes local analysis use the SAME active rules as CI. If a plugin
     for some language isn't available in Community edition (e.g. C#, VB.NET,
     JSP need commercial editions or extra plugins), skip those profiles and
     surface a one-line warning listing skipped languages.

3. **Local project provisioning**
   - Create the project on first scan: `POST /api/projects/create` with
     `project=<projectKey-from-sonar-project.properties>&name=<workspace name>`.
     Idempotent: ignore "already exists" errors.

4. **Scan modes — two buttons in the Local Scan tab**
   - **Scan Full (Local)**: run `sonar-scanner` with
     `-Dsonar.host.url=http://127.0.0.1:9876` and the local token via
     `SONAR_TOKEN` env (reuse `runSonarScanner`, it already accepts
     `ScannerOptions`). No `sonar.branch.name` — Community edition rejects
     branch analysis; always analyze as main.
   - **Scan New Code (Local)**: compute changed files:
     `git diff --name-only @{push}..HEAD` plus `git status --porcelain`
     untracked/modified files (fall back to `origin/<default-branch>...HEAD`
     if `@{push}` has no upstream). Pass them as
     `-Dsonar.inclusions="<comma-separated relative paths>"`.
     If the list is empty, toast "No changed files since last push" and skip.
   - After the CE task completes on the LOCAL server (reuse `pollCeTask`),
     fetch issues from the LOCAL server (`/api/issues/search?componentKeys=...`)
     and render them in the existing scan results UI (severity filters, file
     filter, cards). Add a badge "LOCAL" so it's obvious no central server
     was involved.

5. **Settings / UX**
   - New setting toggle in the Settings page: "Scan mode: Central server /
     Local Docker" (persist in `globalState`). Scan Branch button behavior
     switches accordingly; label changes to "Scan (Local)".
   - Status row showing local server state: stopped / starting / up
     (poll `/api/system/status` on tab open).
   - All progress (docker pull, server boot, profile restore, scanner output,
     CE processing) streams into the existing `scan-log` box.

6. **Non-goals / constraints**
   - Do not remove or break the existing central-server scan path (Option C);
     the toggle selects between them.
   - Container is per-machine, shared across workspaces; project key
     namespaces the analyses.
   - Community edition only — no branch analysis locally, no PR decoration.
   - Windows: docker command identical; readiness polling identical. Test path
     handling in `sonar.inclusions` (forward slashes work on all platforms).

### Acceptance checks

- With Docker installed and central server UNREACHABLE (e.g. VPN off), a full
  local scan completes and shows issues in the tab.
- Issues list matches the org rule set for JS/TS projects (spot-check a rule
  that is customized in the org profile).
- "Scan New Code" on a branch with 3 modified files scans exactly those files
  (verify in scanner log: "3 files indexed").
- Central SonarQube shows NO new analyses/branches after local scans.
- `tsc --noEmit` and `npm run compile` pass; webview JS passes `node --check`.

### Estimated RAM/disk on dev machines

- Image ~700MB disk; container ~2–3GB RAM while running; volume grows slowly.
