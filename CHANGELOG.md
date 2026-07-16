# Changelog

All notable changes to SonarLens are documented here.

---

## [1.0.4] - 2026-07-16

### Added
- Local Scan — **File filter dropdown**: lists every distinct file with issues (with a per-file issue count), multi-select checkboxes, combines with the severity filter and text search
- Local Scan file filter — sort files by **Name** or by **Issue count**, and a resizable dropdown (drag the corner) for long paths

### Fixed
- Stored SonarQube token silently reused against a different server after the configured URI changed — token is now bound to the URI it was issued for; a URI change withholds the stale token, prompts for a fresh one, and blocks saving until it's replaced
- Settings form errors (missing URI/Project Key/Token, stale token after URI change) now surface as an inline banner on the Settings page in addition to the toast
- Local Scan error messages were silently cut down to only lines containing the word "ERROR" — a failure's actual cause (missing file, path, stack trace) often sits on the next line and was dropped; the full scanner failure output is now shown, in a scrollable box
- Local Scan results table was truncating file paths and issue messages with `…` — both now wrap fully instead of clipping
- Local Scan now opens to the **Local Scan tab** by default once configured (was always defaulting to Pull Requests)

### Changed
- `.vscodeignore` now also excludes `.claude/**` and `docs/**` from the packaged extension

---

## [1.0.3] - 2026-07-04

### Added

**Local Scan tab**
- New "Local Scan" tab — run `sonar-scanner` against your working copy directly from the sidebar
- Sync Rules — pulls org quality profiles + active rules from your SonarQube server, cached locally with a preflight confirmation modal (language/rule-count summary + estimated sync time; nothing runs until you approve)
- Org Rules viewer — language index page (rule count + Bug/Vulnerability/Code Smell breakdown per language) drilling into a filterable, searchable rule list with severity-colored cards
- Scan target picker — **Local (private)** or **Server**
  - **Local**: spins up a private SonarQube Community server in Docker (`sonarlens-local` container) on `127.0.0.1`; code, analysis, and issues never leave the machine. Org quality profiles are auto-imported so local rules match the org's exact rule set
  - **Server**: analyzes locally but uploads the report to the configured central SonarQube, tagged under the current git branch
- First-time local setup confirmation modal — shows host/port/username/password (editable, prefilled) and an estimated download/RAM footprint; the Docker container is only created after explicit approval, every time one doesn't already exist
- **Scan All** (full codebase) and **Scan Changes** (only files changed since the last push, via `git diff`) modes for both local and server targets
- Stop button — cancels a running scan (kills the scanner process tree) or an in-progress server-side wait, cleanly
- Live scan timer with an "expected time" estimate learned from your previous scan of the same kind
- Issue results: 500-per-page pagination, search by file path or message, per-row/select-all checkboxes, Export (JSON/CSV) and Export Selected
- Reset Local Server action — tears down the local container and its data volume for a clean re-setup if credentials ever get out of sync

### Fixed
- Double-slash (`//`) in generated SonarQube URLs when the configured host URI had a trailing slash
- Scanner hanging indefinitely ("Preprocessed 0 files") on JS/TS projects — caused by the file walker crawling `node_modules` before exclusions applied; sources are now restricted to git-tracked top-level entries
- Scan silently including dependency/build directories and `.git` — exclusions now also honor the project's `.gitignore`
- SCA dependency analysis and `sonar.qualitygate.wait` (from `sonar-project.properties`) blocking or stalling IDE-triggered scans
- Corrupted analyzer bundle cache (`.scannerwork/.sonartmp`) left behind by a killed/stopped scan breaking every subsequent run
- Issues API `400` error on projects with 10,000+ issues (pagination exceeding the API's result-window limit); also switched the deprecated `componentKeys` param to `components`
- "Changed files" scan picking up scanner artifacts (`.scannerwork/…`) as if they were source changes
- Local server setup dialog being skipped after the Docker container was deleted, due to a persisted approval flag
- Misleading "Syncing…" state shown during the (separate) preflight rule-count fetch before the user had confirmed the sync

---

## [1.0.1] - 2026-06-11

### Fixed
- Extension commands (`sonarlens.openPanel`) not found after install from VSIX
- Runtime dependencies (`@anthropic-ai/sdk`, `axios`, `openai`) missing in packaged extension

### Changed
- Build system migrated from plain `tsc` to **webpack** — all dependencies now bundled into a single `out/extension.js`; installed VSIX is fully self-contained with no external `node_modules` required

---

## [1.0.0] - 2026-05-10

### Added

**UI / Shell**
- Activity Bar sidebar — extension lives in VS Code sidebar (click sonar-wave icon)
- Settings page shown on first load; auto-skipped once configured
- Gear button (⚙) to return to Settings from main view at any time
- Two-tab main view — Pull Requests tab | Issues tab
- Open in Editor Tab (⬡) — pop-out button opens full-width editor panel
- Toast notifications — success / error / warning / info, auto-dismiss after 4s
- Persistent sidebar context (`retainContextWhenHidden`)

**Configuration**
- Auto-prefill from `sonar-project.properties` (`sonar.sonarQubeUri`, `sonar.projectKey`)
- Missing properties warning banner with setup instructions
- Secure credential storage — token and OpenAI key stored in VS Code SecretStorage (OS keychain)
- Test Connection — validates URL + token before saving
- OpenAI key optional — PR/issue viewing works without it; only AI fix requires it

**Pull Requests**
- Fetch all PRs for configured project
- PR table with key, title, branch, quality gate status, analysis date
- Sort by column (Analysis Date descending by default)
- View Issues button — switches to Issues tab scoped to selected PR
- PR filters — text search, QG multi-select, date-range from/to

**Issues**
- Paginated issue list — 10 / 25 / 50 / 100 rows per page (default 50)
- Serial number column showing absolute row number across pages
- Filter by severity — multi-select (BLOCKER, CRITICAL, MAJOR, MINOR, INFO)
- Filter by status — multi-select (OPEN, CONFIRMED, REOPENED, RESOLVED, FIXED, CLOSED)
- Filter by file — live text search on file path
- Multi-select with Select All checkbox
- Issue columns — key, file path, line, severity chip, message, status, actions
- Message link opens issue directly in SonarQube browser
- More / less toggle for truncated message and file path

**AI Fix**
- Single issue fix via OpenAI `gpt-4o` with code context
- Fix Selected — fix all checked issues in sequence
- Fix All Low Severity — fixes all INFO + MINOR issues across all pages
- Diff view — VS Code side-by-side diff before accepting
- Accept / Accept & Commit / Reject flow
- Auto git commit on Accept & Commit

**SSO Login**
- Browser-based SSO login flow — browser opens, token auto-saved
- Fallback token paste input for SonarQube versions that don't auto-redirect
- Dark theme support for SSO panel

**Mark Resolved**
- Mark issue resolved via SonarQube `resolve` transition API
- Clear 403 error guidance when token lacks "Administer Issues" permission

**Export**
- Export filtered issues as JSON, CSV/Excel, or AI prompt
- VS Code native save dialog

**Error Handling**
- Detailed API errors with URL, HTTP status, response body
- Timeout and unreachable host messages with actionable guidance
- Loading spinner always clears on error
