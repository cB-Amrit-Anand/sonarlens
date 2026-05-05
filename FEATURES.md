# SonarQube AI Fixer — Feature List

> Update this file after every change.

---

## UI / Shell

- **Activity Bar sidebar** — extension lives in VS Code sidebar (click sonar-wave icon in activity bar)
- **Settings page** — shown on first load; auto-skipped once configured
- **Gear button (⚙)** — return to Settings from main view at any time
- **Two-tab main view** — Pull Requests tab | Issues tab
- **Open in Editor Tab (⬡)** — each tab has a pop-out button that opens full-width editor panel
- **Toast notifications** — success / error / warning / info toasts, auto-dismiss after 4s
- **Persistent sidebar context** — sidebar retains state when hidden (`retainContextWhenHidden`)

---

## Configuration

- **Auto-prefill from `sonar-project.properties`** — reads `sonar.sonarQubeUri` and `sonar.projectKey` and pre-fills fields; fields remain editable so values can be overridden
- **Missing properties warning** — banner with setup instructions if file not found
- **Field descriptions** — each input has a description explaining what it is and where to find the value
- **Secure credential storage** — SonarQube token and OpenAI key stored in VS Code SecretStorage (OS keychain); auto-restored on next open
- **Test Connection** — validates SonarQube URL + token before saving
- **OpenAI key optional** — PR fetching and issue viewing work without it; only AI fix features require it
- **Back button** — settings page has a Back button to return to main view; hidden on first load when there is nothing to go back to
- **Gear button right-aligned** — ⚙ button sits flush right in the tab bar

---

## Pull Requests

- **Fetch PRs** — loads all PRs from SonarQube for the configured project
- **PR table** — shows PR key, title, branch, quality gate status, analysis date
- **Sort by column** — click any column header to sort; Analysis Date sorted descending by default
- **View Issues** — click button on a PR row; Issues tab badge shows PR number and title

---

## Issues

- **Paginated issue list** — configurable rows per page (10 / 25 / 50 / 100); default 50; selector in pagination bar
- **Serial number column** — Sr # column shows absolute row number across pages
- **Filter by severity** — multi-select dropdown (BLOCKER, CRITICAL, MAJOR, MINOR, INFO); button label shows count when not all selected
- **Filter by status** — multi-select dropdown (OPEN, CONFIRMED, REOPENED, RESOLVED, FIXED); same label behaviour as severity
- **Filter by file** — text search on file path, live-filtered
- **Multi-select** — checkbox per row + Select All checkbox in header
- **Issue columns** — key, file path, line, severity chip (full name), message, status, actions
- **Message link** — clicking message text opens the issue directly in SonarQube browser
- **More / less toggle** — "more" button expands truncated message and file path inline; "less" collapses it back
- **Loading / error state** — spinner while fetching; clears with error message on failure

---

## AI Fix

- **Single issue fix** — Fix button per row; calls OpenAI `gpt-4o` with code context
- **Fix Selected** — fix all checked issues in sequence (shows count in button)
- **Fix All Low Severity** — fixes all INFO + MINOR issues across all pages for current PR
- **Diff view** — opens VS Code diff (original ↔ AI fix) before accepting
- **Accept / Accept & Commit / Reject** — user chooses outcome; Reject restores original file
- **Auto git commit** — "Accept & Commit" stages and commits the fixed file with issue key in message
- **Correct line replacement** — fix applied to expanded context range (`actualStart–actualEnd`) to prevent duplication

---

## Mark Resolved

- **Mark issue resolved** — ✓ button sends `resolve` transition to SonarQube API
- **403 guidance** — clear error message if token lacks "Administer Issues" permission

---

## Export

- **Export JSON** — exports filtered visible issues as structured JSON
- **Export CSV / Excel** — exports as comma-separated values (openable in Excel)
- **Export with AI Prompt** — exports issues formatted as a ready-to-use AI prompt
- **Save dialog** — uses VS Code native save dialog (not browser blob URL)

---

## Error Handling

- **Detailed API errors** — axios interceptor rewrites errors with URL, HTTP status, and response body
- **Timeout message** — ECONNABORTED shows URL + suggests checking VPN/firewall
- **Unreachable host** — ENOTFOUND / ECONNREFUSED shows base URL and suggests checking sonar-project.properties
- **Spinner always clears** — issues loading spinner removed on error (not left spinning forever)

---

## Architecture

- `src/ui/baseProvider.ts` — all business logic (shared between sidebar and editor panel)
- `src/ui/sidebarProvider.ts` — `WebviewViewProvider` for Activity Bar sidebar
- `src/ui/webviewProvider.ts` — `WebviewPanel` for pop-out editor tab
- `src/api/sonarqubeApi.ts` — SonarQube REST API client (axios); supports v9 + v10/SonarCloud pagination
- `src/ai/aiFixProvider.ts` — OpenAI client (`gpt-4o`)
- `src/utils/fileUtils.ts` — file resolution, snippet extraction, line-range replacement, diff view
- `src/utils/gitUtils.ts` — git repo detection, commit after fix
