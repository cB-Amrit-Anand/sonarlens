# Publishing SonarLens

Step-by-step guide to publish on VS Code Marketplace, Open VSX (Cursor / VSCodium / Windsurf), and distribute as a VSIX.

---

## Prerequisites

```bash
npm install -g @vscode/vsce   # VS Code extension packager
npm install -g ovsx           # Open VSX publisher
```

---

## Step 1 — Build the production VSIX

```bash
# from the repo root
npm run compile          # compile TypeScript
vsce package             # produces sonarlens-1.0.0.vsix
```

The `.vsix` file is the universal distributable — it works for all platforms.

---

## Step 2 — Publish to VS Code Marketplace

> Covers: **VS Code**, **GitHub Codespaces**, **Cursor** (can install from Marketplace)

### 2a. Create a publisher account

1. Go to [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage)
2. Sign in with a Microsoft account
3. Click **Create publisher**
4. Set publisher ID to `sonarlens` (must match `"publisher"` in `package.json`)

### 2b. Generate a Personal Access Token (PAT)

1. Go to [dev.azure.com](https://dev.azure.com) → your organisation
2. Top-right → **User Settings** → **Personal Access Tokens**
3. Click **New Token**
   - Name: `vsce-publish`
   - Organisation: **All accessible organisations**
   - Expiration: 1 year
   - Scopes: **Marketplace → Manage**
4. Copy the token — you'll only see it once

### 2c. Login and publish

```bash
vsce login sonarlens        # paste PAT when prompted
vsce publish                # reads version from package.json
```

Or publish and bump version in one command:

```bash
vsce publish minor          # bumps 1.0.0 → 1.1.0
vsce publish patch          # bumps 1.0.0 → 1.0.1
```

### 2d. Verify

Visit `https://marketplace.visualstudio.com/items?itemName=sonarlens.sonarlens`

It takes ~5 minutes to go live after publishing.

---

## Step 3 — Publish to Open VSX Registry

> Covers: **Cursor**, **VSCodium**, **Windsurf (Codeium)**, **Gitpod**, **Eclipse Theia**

### 3a. Create an Open VSX account

1. Go to [open-vsx.org](https://open-vsx.org)
2. Sign in with GitHub
3. Go to **User Settings** → **Access Tokens** → **Generate New Token**
4. Copy the token

### 3b. Publish

```bash
ovsx publish sonarlens-1.0.0.vsix -p <your-ovsx-token>
```

Or publish from source (auto-packages first):

```bash
ovsx publish -p <your-ovsx-token>
```

### 3c. Verify

Visit `https://open-vsx.org/extension/sonarlens/sonarlens`

---

## Step 4 — GitHub Release (VSIX download)

Lets users install manually in any compatible editor.

```bash
# Tag the release
git tag v1.0.0
git push origin v1.0.0
```

Then on GitHub:
1. Go to **Releases** → **Draft a new release**
2. Select tag `v1.0.0`
3. Title: `SonarLens v1.0.0`
4. Drag and drop `sonarlens-1.0.0.vsix` into the assets area
5. Click **Publish release**

---

## Step 5 — Install in each editor

### VS Code
```
Extensions panel → Search "SonarLens" → Install
```
Or from CLI:
```bash
code --install-extension sonarlens.sonarlens
```

### Cursor
Cursor supports VS Code Marketplace extensions directly:
```
Extensions panel → Search "SonarLens" → Install
```
Or install the VSIX:
```
Ctrl+Shift+P → Extensions: Install from VSIX → select sonarlens-1.0.0.vsix
```

### VSCodium / Windsurf / other VS Code forks
```
Extensions panel → Search "SonarLens" (pulls from Open VSX)
```
Or install the VSIX:
```
Ctrl+Shift+P → Extensions: Install from VSIX → select sonarlens-1.0.0.vsix
```

### Gitpod
Add to `.gitpod.yml`:
```yaml
vscode:
  extensions:
    - sonarlens.sonarlens
```

---

## Updating an existing release

```bash
# Bump version in package.json manually, or let vsce do it:
vsce publish patch           # VS Code Marketplace
ovsx publish -p <token>      # Open VSX (always uses version in package.json)
```

Create a new GitHub Release with the new `.vsix` as well.

---

## Checklist before publishing

- [ ] `npm run compile` passes with no errors
- [ ] `vsce package` produces a valid `.vsix`
- [ ] `README.md` is complete (shown on marketplace pages)
- [ ] `package.json` has correct `version`, `publisher`, `description`, `repository`
- [ ] Icon exists at `resources/icon.svg`
- [ ] `LICENSE` file present
- [ ] Tested the `.vsix` by installing locally: `code --install-extension sonarlens-1.0.0.vsix`
