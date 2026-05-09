// @ts-check
'use strict';

const vscode = acquireVsCodeApi();

/* ── State ───────────────────────────────────────────────────────────────── */
const state = {
    currentPRKey:       /** @type {string|null} */ (null),
    sonarUri:           /** @type {string} */ (''),
    projectKey:         /** @type {string} */ (''),
    issuesMap:          /** @type {Record<string, any>} */ ({}),
    currentPageIssues:  /** @type {any[]} */ ([]),
    currentPage:        1,
    totalIssues:        0,
    pageSize:           50,
    filteredIssues:     /** @type {any[]} */ ([]),
    hasAiKey:           false,
    fixingKeys:         /** @type {Set<string>} */ (new Set()),
    resolvingKeys:      /** @type {Set<string>} */ (new Set()),
    selectedKeys:       /** @type {Set<string>} */ (new Set()),
    locallyDismissed:   /** @type {Set<string>} */ (new Set()),
    prsList:            /** @type {any[]} */ ([]),
    prSort:             { col: 'date', dir: 'desc' }
};

/* ── Page navigation (settings ↔ main) ──────────────────────────────────── */
function showPage(id) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(`page-${id}`)?.classList.add('active');
}

/* ── Tab switching (prs ↔ issues) ───────────────────────────────────────── */
function showTab(id) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-tab="${id}"]`)?.classList.add('active');
    document.getElementById(`tab-${id}`)?.classList.add('active');
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(/** @type {HTMLElement} */(btn).dataset.tab));
});

/* ── Settings button + Back button ──────────────────────────────────────── */
document.getElementById('btn-settings')?.addEventListener('click', () => showPage('settings'));
document.getElementById('btn-back')?.addEventListener('click', () => showPage('main'));

/* ── Open in Editor Tab buttons ──────────────────────────────────────────── */
document.getElementById('btn-open-prs-editor')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openInPanel' });
});
document.getElementById('btn-open-issues-editor')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'openInPanel' });
});

/* ── Eye toggle buttons ──────────────────────────────────────────────────── */
document.querySelectorAll('.eye-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const targetId = /** @type {HTMLElement} */(btn).dataset.target;
        const input = /** @type {HTMLInputElement} */(document.getElementById(targetId || ''));
        if (!input) { return; }
        input.type = input.type === 'password' ? 'text' : 'password';
        btn.innerHTML = input.type === 'password' ? '&#128065;' : '&#128584;';
    });
});

/* ── Config form ─────────────────────────────────────────────────────────── */
document.getElementById('btn-save-config')?.addEventListener('click', () => {
    const cfg = {
        uri:        val('sonar-uri'),
        projectKey: val('project-key'),
        token:      val('sonar-token'),
        aiApiKey:   val('ai-api-key'),
        tokenType:  /** @type {HTMLSelectElement} */(document.getElementById('token-type'))?.value || 'basic'
    };
    if (!cfg.uri || !cfg.projectKey) {
        return showToast('sonar-project.properties not found or missing required keys', 'error');
    }
    if (!cfg.token) {
        return showToast('SonarQube Token is required', 'error');
    }
    state.sonarUri   = cfg.uri;
    state.projectKey = cfg.projectKey;
    state.hasAiKey   = !!cfg.aiApiKey;
    vscode.postMessage({ type: 'saveConfig', data: cfg });
});

document.getElementById('btn-test-conn')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'testConnection' });
});

/* ── Fetch PRs ───────────────────────────────────────────────────────────── */
document.getElementById('btn-fetch-prs')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'fetchPRs' });
});

/* ── QG dropdown ─────────────────────────────────────────────────────────── */
document.getElementById('qg-dropdown-btn')?.addEventListener('click', () => {
    document.getElementById('qg-dropdown-menu')?.classList.toggle('hidden');
});
document.querySelectorAll('.qg-filter').forEach(cb => {
    cb.addEventListener('change', () => { updateQgDropdownLabel(); renderPRs(); });
});
function updateQgDropdownLabel() {
    const checked = document.querySelectorAll('.qg-filter:checked');
    const total   = document.querySelectorAll('.qg-filter').length;
    const btn     = document.getElementById('qg-dropdown-btn');
    if (btn) {
        btn.textContent = checked.length === total
            ? 'QG: All ▾'
            : `QG: ${checked.length} selected ▾`;
    }
}

/* ── PR search + date filters ────────────────────────────────────────────── */
document.getElementById('pr-search')?. addEventListener('input', () => renderPRs());
document.getElementById('pr-date-from')?.addEventListener('change', () => renderPRs());
document.getElementById('pr-date-to')?.addEventListener('change',   () => renderPRs());

/* ── PR table delegation (sort headers + View Issues) ────────────────────── */
document.getElementById('prs-container')?.addEventListener('click', e => {
    const sortTh  = /** @type {HTMLElement} */(e.target)?.closest('[data-sort-col]');
    if (sortTh) { sortPRsBy(/** @type {HTMLElement} */(sortTh).dataset.sortCol); return; }

    const viewBtn = /** @type {HTMLElement} */(e.target)?.closest('[data-action="view-issues"]');
    if (viewBtn) {
        selectPR(
            /** @type {HTMLElement} */(viewBtn).dataset.prKey,
            /** @type {HTMLElement} */(viewBtn).dataset.prTitle
        );
    }
});

/* ── Issues table delegation ─────────────────────────────────────────────── */
document.getElementById('issues-container')?.addEventListener('click', e => {
    const target     = /** @type {HTMLElement} */(e.target);
    const fixBtn     = target.closest('[data-action="fix"]');
    const resolveBtn = target.closest('[data-action="resolve"]');
    const dismissBtn = target.closest('[data-action="dismiss"]');
    const checkbox   = target.closest('[data-action="select"]');
    const selectAll  = target.closest('#select-all-issues');
    const openBtn    = target.closest('[data-action="openIssue"]');
    const moreBtn    = target.closest('[data-action="showMore"]');

    if (fixBtn)     { doFix(/** @type {HTMLElement} */(fixBtn).dataset.issueKey || ''); return; }
    if (resolveBtn) { doResolve(/** @type {HTMLElement} */(resolveBtn).dataset.issueKey || ''); return; }
    if (dismissBtn) { doDismiss(/** @type {HTMLElement} */(dismissBtn).dataset.issueKey || ''); return; }
    if (openBtn)    { vscode.postMessage({ type: 'openUrl', url: /** @type {HTMLElement} */(openBtn).dataset.url }); return; }
    if (moreBtn) {
        const cell = moreBtn.closest('.msg-cell');
        cell?.classList.toggle('msg-expanded');
        /** @type {HTMLElement} */(moreBtn).textContent = cell?.classList.contains('msg-expanded') ? 'less' : 'more';
        return;
    }
    if (checkbox) {
        const key = /** @type {HTMLElement} */(checkbox).dataset.issueKey || '';
        /** @type {HTMLInputElement} */(checkbox).checked
            ? state.selectedKeys.add(key)
            : state.selectedKeys.delete(key);
        updateSelectionUI();
        return;
    }
    if (selectAll) {
        const checked = /** @type {HTMLInputElement} */(selectAll).checked;
        state.filteredIssues.forEach(/** @param {any} i */ i => {
            checked ? state.selectedKeys.add(i.key) : state.selectedKeys.delete(i.key);
        });
        applyFiltersAndRender();
        updateSelectionUI();
    }
});

/* ── Fix All Low ─────────────────────────────────────────────────────────── */
document.getElementById('btn-fix-all-low')?.addEventListener('click', () => {
    if (!state.currentPRKey) { return showToast('Select a PR first', 'warning'); }
    vscode.postMessage({ type: 'fixAllLow', prKey: state.currentPRKey });
});

/* ── Fix Selected ────────────────────────────────────────────────────────── */
document.getElementById('btn-fix-selected')?.addEventListener('click', () => {
    const issues = [...state.selectedKeys].map(k => state.issuesMap[k]).filter(Boolean);
    if (!issues.length) { return; }
    vscode.postMessage({ type: 'fixSelected', issues });
});

/* ── Export dropdown ─────────────────────────────────────────────────────── */
document.getElementById('btn-export')?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('export-menu')?.classList.toggle('hidden');
});
document.addEventListener('click', e => {
    if (!/** @type {HTMLElement} */(e.target).closest('.export-wrap')) {
        document.getElementById('export-menu')?.classList.add('hidden');
    }
});
document.getElementById('export-menu')?.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */(e.target).closest('[data-export]');
    if (!btn) { return; }
    document.getElementById('export-menu')?.classList.add('hidden');
    exportIssues(/** @type {HTMLElement} */(btn).dataset.export || '');
});

/* ── Severity dropdown ───────────────────────────────────────────────────── */
document.getElementById('sev-dropdown-btn')?.addEventListener('click', () => {
    document.getElementById('sev-dropdown-menu')?.classList.toggle('hidden');
});
document.addEventListener('click', e => {
    const t = /** @type {HTMLElement} */(e.target);
    if (!t.closest('.sev-dropdown-wrap')) {
        document.getElementById('sev-dropdown-menu')?.classList.add('hidden');
        document.getElementById('stat-dropdown-menu')?.classList.add('hidden');
        document.getElementById('qg-dropdown-menu')?.classList.add('hidden');
    }
});

/* ── Status dropdown ─────────────────────────────────────────────────────── */
document.getElementById('stat-dropdown-btn')?.addEventListener('click', () => {
    document.getElementById('stat-dropdown-menu')?.classList.toggle('hidden');
    document.getElementById('sev-dropdown-menu')?.classList.add('hidden');
});
document.querySelectorAll('.stat-filter').forEach(cb => {
    cb.addEventListener('change', () => { updateStatDropdownLabel(); applyFiltersAndRender(); });
});

function updateStatDropdownLabel() {
    const checked = document.querySelectorAll('.stat-filter:checked');
    const total   = document.querySelectorAll('.stat-filter').length;
    const btn     = document.getElementById('stat-dropdown-btn');
    if (btn) {
        btn.textContent = checked.length === total
            ? 'Status: All ▾'
            : `Status: ${checked.length} selected ▾`;
    }
}
document.querySelectorAll('.sev-filter').forEach(cb => {
    cb.addEventListener('change', () => { updateSevDropdownLabel(); applyFiltersAndRender(); });
});

function updateSevDropdownLabel() {
    const checked = document.querySelectorAll('.sev-filter:checked');
    const total   = document.querySelectorAll('.sev-filter').length;
    const btn     = document.getElementById('sev-dropdown-btn');
    if (btn) {
        btn.textContent = checked.length === total
            ? 'Severity: All ▾'
            : `Severity: ${checked.length} selected ▾`;
    }
}

/* ── File filter ─────────────────────────────────────────────────────────── */
document.getElementById('file-search')?.addEventListener('input', () => applyFiltersAndRender());

/* ── Pagination ──────────────────────────────────────────────────────────── */
document.getElementById('btn-prev')?.addEventListener('click', () => {
    if (state.currentPage > 1) {
        state.currentPage--;
        vscode.postMessage({ type: 'fetchIssues', prKey: state.currentPRKey, page: state.currentPage, pageSize: state.pageSize });
    }
});
document.getElementById('btn-next')?.addEventListener('click', () => {
    const total = Math.ceil(state.totalIssues / state.pageSize);
    if (state.currentPage < total) {
        state.currentPage++;
        vscode.postMessage({ type: 'fetchIssues', prKey: state.currentPRKey, page: state.currentPage, pageSize: state.pageSize });
    }
});
document.getElementById('page-size-select')?.addEventListener('change', e => {
    state.pageSize = Number(/** @type {HTMLSelectElement} */(e.target).value);
    state.currentPage = 1;
    vscode.postMessage({ type: 'fetchIssues', prKey: state.currentPRKey, page: 1, pageSize: state.pageSize });
});

/* ── Extension → Webview messages ───────────────────────────────────────── */
window.addEventListener('message', e => {
    const msg = e.data;
    switch (msg.type) {
        case 'loadConfig':      return onLoadConfig(msg.data);
        case 'noPropertiesFile': return onNoPropertiesFile();
        case 'configStatus':    return onConfigStatus(msg.configured);
        case 'configSaved':     return onConfigSaved();
        case 'loading':         return onLoading(msg.key, msg.value);
        case 'prsLoaded':       state.prsList = msg.data || []; return renderPRs();
        case 'issuesLoaded':    return renderIssues(msg.data);
        case 'fixStarted':      return setFixing(msg.issueKey, true);
        case 'fixApplied':      return onFixApplied(msg.issueKey);
        case 'fixRejected':     return setFixing(msg.issueKey, false);
        case 'fixError':        return onFixError(msg.issueKey, msg.message);
        case 'resolveStarted':  return onResolveStarted(msg.issueKey);
        case 'resolveError':    return onResolveError(msg.issueKey);
        case 'issueResolved':   return onIssueResolved(msg.issueKey);
        case 'toast':           return showToast(msg.message, msg.variant || 'info');
        case 'error':           return showToast(msg.message, 'error');
    }
});

/* ── Config handlers ─────────────────────────────────────────────────────── */
function onLoadConfig(cfg) {
    if (cfg.uri)        { setVal('sonar-uri', cfg.uri);           state.sonarUri    = cfg.uri; }
    if (cfg.projectKey) { setVal('project-key', cfg.projectKey);  state.projectKey  = cfg.projectKey; }
    if (cfg.token)      setVal('sonar-token', cfg.token);
    if (cfg.aiApiKey)   { setVal('ai-api-key', cfg.aiApiKey); state.hasAiKey = true; }
    if (cfg.tokenType) {
        const sel = /** @type {HTMLSelectElement} */(document.getElementById('token-type'));
        if (sel) { sel.value = cfg.tokenType; }
    }
    if (cfg.fromFile)   document.getElementById('missing-props-warning')?.classList.add('hidden');
}

function onNoPropertiesFile() {
    document.getElementById('missing-props-warning')?.classList.remove('hidden');
}

function onConfigStatus(configured) {
    showPage(configured ? 'main' : 'settings');
    // Hide Back button when opening settings for the first time (nothing to go back to)
    document.getElementById('btn-back')?.classList.toggle('hidden', !configured);
}

function onConfigSaved() {
    showPage('main');
    showTab('prs');
}

/* ── Loading states ──────────────────────────────────────────────────────── */
function onLoading(key, active) {
    if (key === 'prs') {
        const btn = document.getElementById('btn-fetch-prs');
        if (!btn) { return; }
        btn.querySelector('.spinner')?.classList.toggle('hidden', !active);
        const txt = btn.querySelector('.btn-text');
        if (txt) { txt.textContent = active ? 'Fetching…' : 'Fetch PRs'; }
        /** @type {HTMLButtonElement} */(btn).disabled = active;
    }
    if (key === 'issues') {
        const container = document.getElementById('issues-container');
        if (!container) { return; }
        if (active) {
            container.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading issues…</span></div>`;
        } else if (container.querySelector('.loading-state')) {
            container.innerHTML = '<div class="empty-state">Failed to load issues. Check the error message above.</div>';
        }
    }
    if (key === 'test') {
        const btn = document.getElementById('btn-test-conn');
        if (!btn) { return; }
        btn.querySelector('.spinner')?.classList.toggle('hidden', !active);
        const txt = btn.querySelector('.btn-text');
        if (txt) { txt.textContent = active ? 'Testing…' : 'Test'; }
        /** @type {HTMLButtonElement} */(btn).disabled = active;
    }
}

/* ── Selection UI ────────────────────────────────────────────────────────── */
function updateSelectionUI() {
    const count = state.selectedKeys.size;
    const btn   = document.getElementById('btn-fix-selected');
    const span  = document.getElementById('sel-count');
    btn?.classList.toggle('hidden', count === 0);
    if (span) { span.textContent = String(count); }
}

/* ── PR rendering ────────────────────────────────────────────────────────── */
function sortPRsBy(col) {
    if (state.prSort.col === col) {
        state.prSort.dir = state.prSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        state.prSort.col = col;
        state.prSort.dir = col === 'date' ? 'desc' : 'asc';
    }
    renderPRs();
}

function renderPRs() {
    const container = document.getElementById('prs-container');
    if (!container) { return; }
    if (!state.prsList || state.prsList.length === 0) {
        container.innerHTML = '<div class="empty-state">No Pull Requests found for this project.</div>';
        return;
    }

    // Show filter bar once PRs are loaded
    document.getElementById('pr-filters')?.classList.remove('hidden');

    // Collect active filters
    const activeQgs = new Set(
        [...document.querySelectorAll('.qg-filter:checked')]
            .map(el => /** @type {HTMLInputElement} */(el).value)
    );
    const searchQ    = (/** @type {HTMLInputElement} */(document.getElementById('pr-search'))?.value || '').toLowerCase().trim();
    const dateFrom   = (/** @type {HTMLInputElement} */(document.getElementById('pr-date-from'))?.value || '');
    const dateTo     = (/** @type {HTMLInputElement} */(document.getElementById('pr-date-to'))?.value || '');

    const filtered = state.prsList.filter(pr => {
        const qg = pr.status?.qualityGateStatus || 'NONE';
        if (!activeQgs.has(qg)) { return false; }
        if (searchQ) {
            const text = `${pr.key} ${pr.title || ''}`.toLowerCase();
            if (!text.includes(searchQ)) { return false; }
        }
        if (dateFrom || dateTo) {
            const d = pr.analysisDate ? pr.analysisDate.substring(0, 10) : '';
            if (dateFrom && d < dateFrom) { return false; }
            if (dateTo   && d > dateTo)   { return false; }
        }
        return true;
    });

    const { col, dir } = state.prSort;
    const sorted = [...filtered].sort((a, b) => {
        let av, bv;
        if (col === 'key')   { av = Number(a.key) || a.key;  bv = Number(b.key) || b.key; }
        if (col === 'title') { av = (a.title || a.key).toLowerCase(); bv = (b.title || b.key).toLowerCase(); }
        if (col === 'qg')    { av = a.status?.qualityGateStatus || ''; bv = b.status?.qualityGateStatus || ''; }
        if (col === 'date')  {
            av = a.analysisDate ? new Date(a.analysisDate).getTime() : 0;
            bv = b.analysisDate ? new Date(b.analysisDate).getTime() : 0;
        }
        if (av < bv) { return dir === 'asc' ? -1 : 1; }
        if (av > bv) { return dir === 'asc' ?  1 : -1; }
        return 0;
    });

    if (sorted.length === 0) {
        container.innerHTML = '<div class="empty-state">No PRs match the current filters.</div>';
        return;
    }

    const arrow = c => col === c ? (dir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = (c, label) =>
        `<th class="sortable-th${col === c ? ' sort-active' : ''}" data-sort-col="${c}">${label}${arrow(c)}</th>`;

    const rows = sorted.map(pr => {
        const qg     = pr.status?.qualityGateStatus || 'NONE';
        const qgIcon = { OK: '✓', ERROR: '✗', WARN: '⚠', NONE: '—' }[qg] || '—';
        const date   = pr.analysisDate ? new Date(pr.analysisDate).toLocaleDateString() : '—';
        return `<tr>
            <td><strong>${esc(pr.key)}</strong><br><span class="cell-file" title="${esc(pr.branch || '')}">${esc(pr.title || pr.key)}</span></td>
            <td><span class="qg-${qg}" title="${qg}">${qgIcon}</span></td>
            <td>${date}</td>
            <td><button class="btn btn-primary btn-sm" data-action="view-issues"
                data-pr-key="${esc(String(pr.key))}"
                data-pr-title="${esc(pr.title || String(pr.key))}">Issues</button></td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        ${th('title', 'PR')}
                        ${th('qg', 'QG')}
                        ${th('date', 'Date')}
                        <th>Action</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function selectPR(prKey, prTitle) {
    state.currentPRKey = prKey;
    state.currentPage  = 1;

    const badge = document.getElementById('pr-badge');
    if (badge) {
        badge.textContent = `PR #${prKey}${prTitle ? ` — ${prTitle}` : ''}`;
        badge.classList.remove('hidden');
    }

    showTab('issues');
    vscode.postMessage({ type: 'fetchIssues', prKey, page: 1, pageSize: state.pageSize });
}

/* ── Issues rendering ────────────────────────────────────────────────────── */
function renderIssues(data) {
    state.totalIssues       = data.total;
    state.currentPage       = data.p;
    state.pageSize          = data.ps;
    state.issuesMap         = {};
    state.currentPageIssues = data.issues || [];
    state.currentPageIssues.forEach(/** @param {any} i */ i => { state.issuesMap[i.key] = i; });

    if (state.currentPageIssues.length === 0) {
        const c = document.getElementById('issues-container');
        if (c) { c.innerHTML = '<div class="empty-state">No issues found for this PR.</div>'; }
        document.getElementById('pagination')?.classList.add('hidden');
        return;
    }
    applyFiltersAndRender();
}

function applyFiltersAndRender() {
    const activeSevs = new Set(
        [...document.querySelectorAll('.sev-filter:checked')]
            .map(el => /** @type {HTMLInputElement} */(el).value)
    );
    const activeStats = new Set(
        [...document.querySelectorAll('.stat-filter:checked')]
            .map(el => /** @type {HTMLInputElement} */(el).value)
    );
    const fileQ = (/** @type {HTMLInputElement} */(document.getElementById('file-search'))?.value || '').toLowerCase().trim();

    const showDismissed = activeStats.has('DISMISSED');
    const filtered = state.currentPageIssues.filter(issue => {
        const isDismissed = state.locallyDismissed.has(issue.key);
        if (isDismissed) { return showDismissed; }
        if (!activeSevs.has(issue.severity)) { return false; }
        if (!activeStats.has(issue.status))  { return false; }
        if (fileQ) {
            const file = issue.component.includes(':') ? issue.component.split(':').slice(1).join(':') : issue.component;
            if (!file.toLowerCase().includes(fileQ)) { return false; }
        }
        return true;
    });
    state.filteredIssues = filtered;
    renderIssueRows(filtered);
}

/** @param {any[]} issues */
function renderIssueRows(issues) {
    const container  = document.getElementById('issues-container');
    const pagination = document.getElementById('pagination');

    if (!issues || issues.length === 0) {
        if (container) { container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>'; }
        pagination?.classList.add('hidden');
        return;
    }

    const allSelected = issues.every(/** @param {any} i */ i => state.selectedKeys.has(i.key));

    const pageOffset = (state.currentPage - 1) * state.pageSize;
    const rows = issues.map(/** @param {any} issue */ (issue, idx) => {
        const sr         = pageOffset + idx + 1;
        const filePath   = issue.component.includes(':') ? issue.component.split(':').slice(1).join(':') : issue.component;
        const line       = issue.textRange?.startLine ?? issue.line ?? '—';
        const fixing     = state.fixingKeys.has(issue.key);
        const resolving  = state.resolvingKeys.has(issue.key);
        const dismissed  = state.locallyDismissed.has(issue.key);
        const selected   = state.selectedKeys.has(issue.key);
        const issueUrl   = state.sonarUri && state.projectKey
            ? `${state.sonarUri}/project/issues?id=${encodeURIComponent(state.projectKey)}&issues=${encodeURIComponent(issue.key)}&open=${encodeURIComponent(issue.key)}${state.currentPRKey ? `&pullRequest=${encodeURIComponent(state.currentPRKey)}` : ''}`
            : '';
        const statusKey  = dismissed ? 'DISMISSED' : issue.status;
        const statusText = dismissed ? 'DISMISSED' : issue.status;
        const rowStyle   = dismissed ? ' style="opacity:.45"' : '';

        const resolveBtn = dismissed ? '' :
            resolving
                ? `<button class="btn btn-secondary btn-sm" disabled title="Resolving…"><span class="spinner" style="border-top-color:currentColor;width:10px;height:10px;border-width:1.5px"></span></button>`
                : `<button class="btn btn-secondary btn-sm" data-action="resolve" data-issue-key="${esc(issue.key)}" title="Mark resolved in SonarQube">&#10003;</button>`;

        const dismissBtn = dismissed
            ? `<button class="btn btn-secondary btn-sm" data-action="dismiss" data-issue-key="${esc(issue.key)}" title="Restore issue">&#8635;</button>`
            : `<button class="btn btn-secondary btn-sm" data-action="dismiss" data-issue-key="${esc(issue.key)}" title="Dismiss locally">&#10005;</button>`;

        return `<tr id="irow-${esc(issue.key)}"${rowStyle} class="${fixing ? 'row-fixing' : ''}${selected ? ' row-selected' : ''}">
            <td><input type="checkbox" class="row-check" data-action="select" data-issue-key="${esc(issue.key)}" ${selected ? 'checked' : ''}></td>
            <td class="cell-sr">${sr}</td>
            <td><span class="sev sev-${issue.severity}">${issue.severity}</span></td>
            <td class="msg-cell">
                <span class="cell-msg">${issueUrl ? `<a class="issue-link" data-action="openIssue" data-url="${esc(issueUrl)}" href="#" title="Open in SonarQube">${esc(issue.message)}</a>` : esc(issue.message)}</span>
                <button class="more-btn" data-action="showMore">more</button>
                <span class="cell-file">${esc(filePath)}:${line}</span>
            </td>
            <td><span class="stat stat-${statusKey}" id="stat-${esc(issue.key)}">${statusText}</span></td>
            <td>
                <div class="action-cell">
                    ${dismissed ? '' : `<button class="btn btn-primary btn-sm" id="fix-btn-${esc(issue.key)}"
                        data-action="fix" data-issue-key="${esc(issue.key)}" ${fixing ? 'disabled' : ''}>
                        ${fixing ? '<span class="spinner" style="border-top-color:#fff"></span>' : 'Fix with AI'}
                    </button>`}
                    ${resolveBtn}
                    ${dismissBtn}
                </div>
            </td>
        </tr>`;
    }).join('');

    const from = (state.currentPage - 1) * state.pageSize + 1;
    const to   = Math.min(state.currentPage * state.pageSize, state.totalIssues);
    const filteredNote = issues.length < state.currentPageIssues.length
        ? ` (${issues.length} shown after filters)` : '';

    if (container) {
        container.innerHTML = `
            <div class="issues-summary">Showing ${from}–${to} of ${state.totalIssues} issues${filteredNote}</div>
            <div class="table-wrapper">
                <table>
                    <thead>
                        <tr>
                            <th><input type="checkbox" id="select-all-issues" ${allSelected ? 'checked' : ''}></th>
                            <th class="cell-sr">#</th><th>Sev</th><th>Message / File</th><th>Status</th><th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    const totalPages = Math.ceil(state.totalIssues / state.pageSize);
    const pageInfo   = document.getElementById('page-info');
    const btnPrev    = document.getElementById('btn-prev');
    const btnNext    = document.getElementById('btn-next');
    if (pageInfo) { pageInfo.textContent = `${state.currentPage} / ${totalPages}`; }
    if (btnPrev)  { /** @type {HTMLButtonElement} */(btnPrev).disabled = state.currentPage <= 1; }
    if (btnNext)  { /** @type {HTMLButtonElement} */(btnNext).disabled = state.currentPage >= totalPages; }
    pagination?.classList.toggle('hidden', Math.ceil(state.totalIssues / state.pageSize) <= 1);
}

/* ── Export ──────────────────────────────────────────────────────────────── */
/** @param {string} format */
function exportIssues(format) {
    const activeSevs = new Set([...document.querySelectorAll('.sev-filter:checked')].map(el => /** @type {HTMLInputElement} */(el).value));
    const fileQ = (/** @type {HTMLInputElement} */(document.getElementById('file-search'))?.value || '').toLowerCase().trim();
    const issues = state.currentPageIssues.filter(issue => {
        if (!activeSevs.has(issue.severity)) { return false; }
        if (fileQ) {
            const f = issue.component.includes(':') ? issue.component.split(':').slice(1).join(':') : issue.component;
            if (!f.toLowerCase().includes(fileQ)) { return false; }
        }
        return true;
    });

    let content = '', filename = '';
    if (format === 'json') {
        content  = JSON.stringify(issues.map(i => ({
            key: i.key,
            file: i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component,
            line: i.textRange?.startLine ?? i.line ?? null,
            severity: i.severity, type: i.type, rule: i.rule, message: i.message, status: i.status
        })), null, 2);
        filename = 'sonar-issues.json';
    } else if (format === 'csv') {
        const rows = [['Key','File','Line','Severity','Type','Rule','Message','Status']];
        issues.forEach(i => {
            const f = i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component;
            rows.push([i.key, f, String(i.textRange?.startLine ?? i.line ?? ''), i.severity, i.type||'', i.rule, `"${(i.message||'').replaceAll('"','""')}"`, i.status]);
        });
        content  = rows.map(r => r.join(',')).join('\n');
        filename = 'sonar-issues.csv';
    } else if (format === 'prompt') {
        const lines = ['Fix the following SonarQube issues:\n'];
        issues.forEach((/** @param {any} i */ i, idx) => {
            const f = i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component;
            lines.push(`Issue ${idx + 1}:`, `  File: ${f}`, `  Line: ${i.textRange?.startLine ?? i.line ?? '?'}`,
                `  Severity: ${i.severity}`, `  Rule: ${i.rule}`, `  Message: ${i.message}\n`);
        });
        lines.push('For each issue, provide the corrected code snippet.');
        content  = lines.join('\n');
        filename = 'sonar-issues-prompt.txt';
    }
    if (content) { vscode.postMessage({ type: 'export', format, content, filename }); }
}

/* ── Issue actions ───────────────────────────────────────────────────────── */
function doFix(issueKey) {
    if (!state.hasAiKey) { return showToast('OpenAI API key not configured — add it in Settings (⚙)', 'error'); }
    const issue = state.issuesMap[issueKey];
    if (!issue) { return showToast('Issue data not found — refresh the issues', 'error'); }
    vscode.postMessage({ type: 'fixIssue', issue });
}

function doResolve(issueKey) {
    state.resolvingKeys.add(issueKey);
    applyFiltersAndRender();
    vscode.postMessage({ type: 'markResolved', issueKey });
}

function doDismiss(issueKey) {
    if (state.locallyDismissed.has(issueKey)) {
        state.locallyDismissed.delete(issueKey);
    } else {
        state.locallyDismissed.add(issueKey);
        state.selectedKeys.delete(issueKey);
    }
    applyFiltersAndRender();
    updateSelectionUI();
}

function onResolveStarted(issueKey) {
    state.resolvingKeys.add(issueKey);
    applyFiltersAndRender();
}

function onResolveError(issueKey) {
    state.resolvingKeys.delete(issueKey);
    applyFiltersAndRender();
}

function setFixing(issueKey, active) {
    if (active) { state.fixingKeys.add(issueKey); } else { state.fixingKeys.delete(issueKey); }
    const row = document.getElementById(`irow-${issueKey}`);
    const btn = document.getElementById(`fix-btn-${issueKey}`);
    if (row) { row.classList.toggle('row-fixing', active); }
    if (btn) {
        /** @type {HTMLButtonElement} */(btn).disabled = active;
        btn.innerHTML = active ? '<span class="spinner" style="border-top-color:#fff"></span>' : 'Fix with AI';
    }
}

function onFixApplied(issueKey) {
    setFixing(issueKey, false);
    const stat = document.getElementById(`stat-${issueKey}`);
    if (stat) { stat.className = 'stat stat-FIXED'; stat.textContent = 'FIXED'; }
    const row = document.getElementById(`irow-${issueKey}`);
    if (row) { row.style.opacity = '.5'; }
}

function onFixError(issueKey, message) {
    setFixing(issueKey, false);
    showToast(`Fix failed: ${message}`, 'error');
}

function onIssueResolved(issueKey) {
    state.resolvingKeys.delete(issueKey);
    const issue = state.issuesMap[issueKey];
    if (issue) { issue.status = 'RESOLVED'; }
    applyFiltersAndRender();
}

/* ── Toast ───────────────────────────────────────────────────────────────── */
const TOAST_ICONS = { success: '✓', error: '✗', warning: '⚠', info: 'ℹ' };

function showToast(message, variant = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) { return; }
    const el = document.createElement('div');
    el.className = `toast toast-${variant}`;
    el.innerHTML = `<span class="toast-icon">${TOAST_ICONS[variant] || 'ℹ'}</span><span>${esc(message)}</span>`;
    container.appendChild(el);
    setTimeout(() => {
        el.style.animation = 'toast-out .3s ease forwards';
        setTimeout(() => el.remove(), 300);
    }, 4000);
}

/* ── Utilities ───────────────────────────────────────────────────────────── */
function esc(str) {
    if (typeof str !== 'string') { return String(str ?? ''); }
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function val(id)      { return /** @type {HTMLInputElement} */(document.getElementById(id))?.value?.trim() ?? ''; }
function setVal(id, v) { const el = document.getElementById(id); if (el) /** @type {HTMLInputElement} */(el).value = v; }
