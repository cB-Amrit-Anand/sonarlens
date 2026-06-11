# Changelog

All notable changes to SonarLens are documented here.

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
