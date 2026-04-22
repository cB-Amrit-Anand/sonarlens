You are a senior VS Code extension developer and system architect.

Build a complete VS Code extension that integrates with SonarQube Cloud and provides AI-powered issue fixing.

## Goal
Create an extension where a user can:
1. Enter SonarQube URI and projectKey
2. Fetch and display Pull Requests (or branches)
3. Select a Pull Request
4. Fetch all SonarQube issues (paginated, 100 per request)
5. Display issues in a table UI
6. Select an issue and automatically fix it using AI
7. Apply the fix to the local file
8. Optionally mark the issue as resolved in SonarQube

---

## Technical Requirements

### 1. Tech Stack
- Language: TypeScript
- VS Code Extension API
- Webview UI (HTML + CSS + JS or React if needed)
- Fetch API / Axios for HTTP calls

---

### 2. SonarQube API Integration

Implement the following APIs:

1. Get Pull Requests:
GET /api/project_pull_requests/list?project={projectKey}

2. Get Issues (paginated):
GET /api/issues/search?componentKeys={projectKey}&pullRequest={prKey}&p={page}&ps=100

3. Mark Issue Resolved:
POST /api/issues/do_transition
Body:
- issue={issueKey}
- transition=resolve

Handle authentication using token (Basic Auth or Bearer).

---

### 3. UI Requirements (Webview)

Create a clean UI with:

#### Page 1: Configuration
- Input: SonarQube URI
- Input: Project Key
- Input: Token
- Save config

#### Page 2: Pull Request List
- Table of PRs
- Columns: PR Key, Title, Status
- Click to select PR

#### Page 3: Issues Table
- Table with:
  - Issue Key
  - File Path
  - Line Number
  - Severity
  - Message
  - Status
  - Action Button (Fix)

- Pagination support (Next / Previous)

---

### 4. AI Fix Feature

When user clicks "Fix":

1. Read the file from workspace
2. Extract relevant code snippet (based on line number)
3. Send prompt to AI (Claude/OpenAI)

### AI Prompt Template:
- Include:
  - Issue message
  - Rule (if available)
  - Code snippet
  - File context

Ask AI to:
- Fix the issue
- Return ONLY updated code (no explanation)

---

### 5. Apply Fix

- Replace the affected code in file
- Show a diff preview before applying
- Allow user to Accept / Reject

---

### 6. Git Integration

- After applying fix:
  - Option to auto-commit changes
  - Commit message: "Fix Sonar issue: {issueKey}"

---

### 7. Error Handling

- Handle API failures
- Handle missing files
- Handle AI failures

---

### 8. Project Structure

Generate full working structure:

- package.json
- extension.ts
- src/
  - api/
  - ui/
  - ai/
  - utils/
- webview/
  - index.html
  - script.js
  - styles.css

---

### 9. Code Quality

- Modular code
- Clean architecture
- Comments where necessary

---

### 10. Bonus (if possible)

- Add "Fix All Low Severity Issues" button
- Add loading states
- Add toast notifications

---

## Output Format

1. First explain architecture briefly
2. Then generate full code files
3. Ensure code is runnable with:
   npm install
   npm run compile
   F5 in VS Code

---

IMPORTANT:
- Do NOT skip any part
- Provide complete working code
- Avoid pseudo code