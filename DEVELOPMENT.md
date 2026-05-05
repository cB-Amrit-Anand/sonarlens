# Development Guide

## Prerequisites

- Node.js 18+
- VS Code 1.85+
- Git

---

## Setup

```bash
git clone <repo-url>
cd sonarqube-ai-fixer
npm install
```

---

## Run (Development)

1. Open folder in VS Code:
   ```bash
   code .
   ```

2. Compile TypeScript:
   ```bash
   npm run compile
   ```

3. Press **F5** — launches Extension Development Host (new VS Code window with extension loaded)

4. In the new window, click the **sonar-wave icon** in the Activity Bar (left sidebar)

> Re-compile after every code change: `npm run compile` then reload the Extension Development Host window with **Ctrl+R** (or **Cmd+R** on Mac).

### Watch mode (auto-recompile on save)

```bash
npm run watch
```

Then just **Ctrl+R** the Extension Development Host after each save — no manual compile needed.

---

## Build (Distributable `.vsix`)

Install the VS Code extension packager once:

```bash
npm install -g @vscode/vsce
```

Package the extension:

```bash
vsce package
```

Produces: `sonarqube-ai-fixer-0.1.0.vsix`

---

## Install `.vsix` in VS Code

**Option A — UI:**
Extensions sidebar → `···` menu (top-right) → **Install from VSIX…** → pick the file

**Option B — Terminal:**
```bash
code --install-extension sonarqube-ai-fixer-0.1.0.vsix
```

---

## Share with Other Developers

```bash
# They clone and install deps
git clone <repo-url>
cd sonarqube-ai-fixer
npm install

# Either run in dev mode (F5)
# Or package and install the .vsix
vsce package
code --install-extension sonarqube-ai-fixer-0.1.0.vsix
```

> Credentials (SonarQube token, OpenAI key) are stored in each developer's VS Code SecretStorage — never in the repo.

---

## Project Structure

```
sonarqube-ai-fixer/
├── src/
│   ├── extension.ts          # Entry point — registers sidebar + panel
│   ├── ui/
│   │   ├── baseProvider.ts   # Shared business logic
│   │   ├── sidebarProvider.ts# Activity Bar sidebar (WebviewViewProvider)
│   │   └── webviewProvider.ts# Pop-out editor tab (WebviewPanel)
│   ├── api/
│   │   └── sonarqubeApi.ts   # SonarQube REST client
│   ├── ai/
│   │   └── aiFixProvider.ts  # OpenAI gpt-4o fix client
│   └── utils/
│       ├── fileUtils.ts      # File read/write, snippet extraction, diff view
│       └── gitUtils.ts       # Git commit after fix
├── webview/
│   ├── index.html            # Sidebar UI markup
│   ├── script.js             # Frontend state machine
│   └── styles.css            # UI styles
├── resources/
│   └── icon.svg              # Activity Bar icon
├── FEATURES.md               # Living feature list — update after every change
└── package.json
```

---

## Useful Commands

| Command | What it does |
|---------|-------------|
| `npm run compile` | One-time TypeScript build |
| `npm run watch` | Auto-recompile on save |
| `vsce package` | Build `.vsix` distributable |
| `code --install-extension *.vsix` | Install packaged extension |
