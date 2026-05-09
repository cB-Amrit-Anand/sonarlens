# SonarLens

View SonarQube / SonarCloud issues directly inside VS Code (and compatible editors) and fix them with AI — without leaving your editor.

---

## Features

| Feature | Description |
|---------|-------------|
| **Browse PRs & Issues** | Fetch pull requests and their SonarQube issues in a sidebar panel |
| **AI Fix** | Fix individual issues, selected issues, or all low-severity issues using OpenAI |
| **SSO Login** | Authenticate via your company SSO — browser opens, token auto-saved |
| **Local Dismiss** | Hide issues locally without needing SonarQube permissions |
| **Export** | Export issues as JSON, CSV, or AI prompt |
| **Diff View** | Review AI fixes in a side-by-side diff before accepting |
| **Accept & Commit** | Accept a fix and auto-commit in one step |

---

## Requirements

- SonarQube (v6.7+) or SonarCloud account
- A project with at least one pull request analysed
- _(Optional)_ OpenAI API key for AI-powered fixes

---

## Installation

### From VS Code Marketplace
1. Open VS Code → Extensions (`Ctrl+Shift+X` / `Cmd+Shift+X`)
2. Search **SonarLens**
3. Click **Install**

### From Open VSX (Cursor, VSCodium, Windsurf, Gitpod)
1. Open the Extensions panel in your editor
2. Search **SonarLens**
3. Click **Install**

### Manual `.vsix` install (any compatible editor)
1. Download the latest `.vsix` from [GitHub Releases](https://github.com/cB-Amrit-Anand/sonarlens/releases)
2. In your editor: `Extensions: Install from VSIX…` → select the file

---

## Setup

### 1. SonarQube project properties (recommended)

Create `sonar-project.properties` in your workspace root:

```properties
sonar.sonarQubeUri=https://your-sonarqube.example.com
sonar.projectKey=your-org_your-repo
```

The extension auto-reads these values — you only need to add your token.

### 2. Configure the extension

Click the **SonarLens icon** in the Activity Bar → open **Settings** (⚙).

**Authentication** — choose one:

- **Paste Token** — generate a user token in SonarQube → My Account → Security → Generate Token, then paste it here.
- **Login with SSO** — click *Open browser & Login*. Your browser opens the SonarQube SSO page. After login, the token is auto-saved. If SonarQube shows the token instead of redirecting, copy it from the browser and paste into the fallback input.

**OpenAI API Key** _(optional)_ — required only for AI fixes. Get one at [platform.openai.com](https://platform.openai.com/api-keys).

Click **Save** → the extension connects and you're ready.

---

## Usage

### View issues
1. **Pull Requests tab** → click **Fetch PRs**
2. Click **Issues** on any PR row

### Fix an issue with AI
- Click **Fix with AI** on any issue row
- Review the diff → **Accept**, **Accept & Commit**, or **Reject**

### Fix multiple issues
- Tick checkboxes → **Fix with AI (N)** in the toolbar
- Or click **Fix Low** to fix all INFO/MINOR issues at once

### Mark resolved
- Click **✓** on an issue row — marks it resolved in SonarQube (requires *Administer Issues* permission)
- Click **✕** to dismiss locally (hides from view; restored via Status filter → DISMISSED)

### Export
- Issues tab toolbar → **Export ▾** → JSON / CSV / AI Prompt

---

## Extension Settings

All settings are stored securely (tokens in VS Code Secret Storage, never in plain text).

| Setting | Where | Notes |
|---------|-------|-------|
| SonarQube URI | Settings page | Auto-filled from `sonar-project.properties` |
| Project Key | Settings page | Auto-filled from `sonar-project.properties` |
| Token Type | Settings page | *User Token* (Basic) or *Bearer Token* (SSO/PAT) |
| SonarQube Token | Secret Storage | Never stored in plain text |
| OpenAI API Key | Secret Storage | Optional — only needed for AI fixes |

---

## Permissions Required

| Action | SonarQube Permission |
|--------|---------------------|
| View issues | Browse |
| Mark resolved | Administer Issues |
| SSO token generation | Any authenticated user |

---

## Supported Platforms

| Platform | Install method |
|----------|---------------|
| VS Code | Marketplace / VSIX |
| Cursor | Marketplace / Open VSX / VSIX |
| VSCodium | Open VSX / VSIX |
| Windsurf (Codeium) | Open VSX / VSIX |
| Gitpod | Open VSX |
| Any VS Code fork | VSIX |

---

## License

MIT — see [LICENSE](LICENSE)
