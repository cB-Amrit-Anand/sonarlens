// @ts-nocheck
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
    prSort:             { col: 'date', dir: 'desc' },
    scanIssues:         /** @type {any[]} */ ([]),
    scanBranch:         /** @type {string} */ (''),
    scanDashboardUrl:   /** @type {string} */ (''),
    scanLocal:          false,
    scanFiltered:       /** @type {any[]} */ ([]),
    scanPage:           1,
    scanPageSize:       500,
    scanSelectedKeys:   /** @type {Set<string>} */ (new Set()),
    allRules:           /** @type {any[]} */ ([]),
    rulesPage:          1,
    rulesPageSize:      50,
    syncEstimate:       /** @type {string} */ (''),
    syncRequested:      false
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

/* ── Auth method tabs (Paste Token / SSO) ───────────────────────────────── */
document.querySelectorAll('.auth-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = /** @type {HTMLElement} */(btn).dataset.auth;
        document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('auth-panel-manual')?.classList.toggle('hidden', mode !== 'manual');
        document.getElementById('auth-panel-sso')?.classList.toggle('hidden', mode !== 'sso');
    });
});

/* ── SSO Login button ────────────────────────────────────────────────────── */
document.getElementById('btn-sso-login')?.addEventListener('click', () => {
    const sonarUri = val('sonar-uri');
    if (!sonarUri) {
        showToast('Enter the SonarQube URI above first', 'error');
        return;
    }
    vscode.postMessage({ type: 'ssoLogin', sonarUri });
});

/* ── SSO fallback: use manually pasted token ─────────────────────────────── */
document.getElementById('btn-sso-use-token')?.addEventListener('click', () => {
    const token = val('sso-token-paste');
    if (!token) {
        showToast('Paste the token from the browser first', 'error');
        return;
    }
    onSsoSuccess(token);
    document.getElementById('sso-fallback')?.classList.add('hidden');
    document.getElementById('sso-waiting')?.classList.add('hidden');
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
        return showToast('SonarQube URI and Project Key are required', 'error');
    }
    const ssoMode = document.getElementById('auth-tab-sso')?.classList.contains('active');
    if (!cfg.token && !ssoMode) {
        return showToast('SonarQube Token is required', 'error');
    }
    if (!cfg.token && ssoMode) {
        return showToast('Complete SSO login first — click "Open browser & Login"', 'error');
    }
    state.sonarUri   = cfg.uri.replace(/\/+$/, '');
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
        case 'ssoWaiting':      return onSsoWaiting();
        case 'ssoSuccess':      return onSsoSuccess(msg.token);
        case 'ssoError':        return onSsoError();
        case 'ssoTimeout':      return onSsoError();
        case 'toast':           return showToast(msg.message, msg.variant || 'info');
        case 'error':           return showToast(msg.message, 'error');
        case 'currentBranch':   return onCurrentBranch(msg.branch);
        case 'syncPreflight':   return onSyncPreflight(msg.profiles, msg.totalRules, msg.estimatedTime);
        case 'syncPreflightError': return closeSyncModal();
        case 'rulesLoaded':     return onRulesLoaded(msg.syncedAt, msg.ruleCount, msg.profiles, msg.rules);
        case 'scanStarted':     return onScanStarted(msg.branch, msg.expectedMs);
        case 'scanProgress':    return onScanProgress(msg.message);
        case 'scanComplete':    return onScanComplete(msg.branch, msg.issues, msg.total, msg.dashboardUrl, msg.local);
        case 'scanError':       return onScanError(msg.message);
        case 'scanStopped':     return onScanStopped();
        case 'localSetupRequired': return onLocalSetupRequired(msg.defaults, msg.scope);
    }
});

/* ── Config handlers ─────────────────────────────────────────────────────── */
function onLoadConfig(cfg) {
    if (cfg.uri)        { setVal('sonar-uri', cfg.uri);           state.sonarUri    = cfg.uri.replace(/\/+$/, ''); }
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
    if (key === 'syncRules' || key === 'preflight') {
        const btn = document.getElementById('btn-sync-rules');
        if (!btn) { return; }
        btn.querySelector('.spinner')?.classList.toggle('hidden', !active);
        const txt = btn.querySelector('.btn-text');
        if (txt) { txt.textContent = active ? (key === 'preflight' ? 'Preparing…' : 'Syncing…') : 'Sync Rules'; }
        /** @type {HTMLButtonElement} */(btn).disabled = active;
    }
    if (key === 'scan') {
        const btn = document.getElementById('btn-scan-branch');
        if (btn) {
            btn.querySelector('.spinner')?.classList.toggle('hidden', !active);
            const txt = btn.querySelector('.btn-text');
            if (txt) { txt.textContent = active ? 'Scanning…' : '▶ Scan All'; }
            /** @type {HTMLButtonElement} */(btn).disabled = active;
        }
        const changedBtn = /** @type {HTMLButtonElement} */(document.getElementById('btn-scan-changed'));
        if (changedBtn) { changedBtn.disabled = active; }
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

function onSsoWaiting() {
    const btn = document.getElementById('btn-sso-login');
    if (btn) {
        /** @type {HTMLButtonElement} */(btn).disabled = true;
        const t = btn.querySelector('.btn-text');
        if (t) { t.textContent = 'Waiting…'; }
        btn.querySelector('.spinner')?.classList.remove('hidden');
    }
    document.getElementById('sso-waiting')?.classList.remove('hidden');
    document.getElementById('sso-fallback')?.classList.add('hidden');
    document.getElementById('sso-success')?.classList.add('hidden');
    // Show paste fallback after 2 s — handles SonarQube versions that display
    // the token instead of auto-redirecting to the local callback server.
    setTimeout(() => {
        const waiting = document.getElementById('sso-waiting');
        if (waiting && !waiting.classList.contains('hidden')) {
            document.getElementById('sso-fallback')?.classList.remove('hidden');
        }
    }, 2000);
}

/** @param {string} token */
function onSsoSuccess(token) {
    const btn = document.getElementById('btn-sso-login');
    if (btn) {
        /** @type {HTMLButtonElement} */(btn).disabled = false;
        const t = btn.querySelector('.btn-text');
        if (t) { t.textContent = 'Open browser & Login'; }
        btn.querySelector('.spinner')?.classList.add('hidden');
    }
    document.getElementById('sso-waiting')?.classList.add('hidden');
    document.getElementById('sso-success')?.classList.remove('hidden');
    if (token) { setVal('sonar-token', token); }
}

function onSsoError() {
    const btn = document.getElementById('btn-sso-login');
    if (btn) {
        /** @type {HTMLButtonElement} */(btn).disabled = false;
        const t = btn.querySelector('.btn-text');
        if (t) { t.textContent = 'Open browser & Login'; }
        btn.querySelector('.spinner')?.classList.add('hidden');
    }
    document.getElementById('sso-waiting')?.classList.add('hidden');
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

/* ══════════════════════════════════════════════════════════════════
   LOCAL SCAN TAB
══════════════════════════════════════════════════════════════════ */

/* ── Load scan state on tab open ─────────────────────────────────── */
document.querySelector('[data-tab="scan"]')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'loadScanState' });
});

/* ── Sync Rules button → show modal with loading state, fetch preflight ── */
document.getElementById('btn-sync-rules')?.addEventListener('click', () => {
    const profilesEl = document.getElementById('sync-modal-profiles');
    const timeEl     = document.getElementById('sync-modal-time');
    if (profilesEl) {
        profilesEl.innerHTML = '<div class="modal-loading"><span class="spinner" style="width:11px;height:11px;border-width:2px;border-top-color:var(--accent);display:inline-block"></span> Fetching profile info…</div>';
    }
    if (timeEl) { timeEl.textContent = '…'; }
    document.getElementById('sync-modal-time-row')?.classList.remove('hidden');
    const confirmBtn = /** @type {HTMLButtonElement} */(document.getElementById('sync-modal-confirm'));
    if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.textContent = 'Yes, Sync'; }
    document.getElementById('sync-modal-overlay')?.classList.remove('hidden');
    vscode.postMessage({ type: 'preflightSyncRules' });
});

/* ── View Rules button (visible once rules are synced) ───────────── */
document.getElementById('btn-view-rules')?.addEventListener('click', () => {
    if (state.allRules.length > 0) { openRulesViewer(); }
});

/* ── Scan buttons (full / changed-only) ──────────────────────────── */
function scanTarget() {
    return /** @type {HTMLSelectElement} */(document.getElementById('scan-target'))?.value || 'local';
}
document.getElementById('btn-scan-branch')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'scanBranch', scope: 'full', target: scanTarget() });
});
document.getElementById('btn-scan-changed')?.addEventListener('click', () => {
    vscode.postMessage({ type: 'scanBranch', scope: 'changed', target: scanTarget() });
});
document.getElementById('btn-reset-local')?.addEventListener('click', () => {
    if (confirm('Reset the local SonarQube server? This deletes the local container and its analysis history (org server is unaffected). Next scan sets it up fresh.')) {
        vscode.postMessage({ type: 'resetLocalServer' });
    }
});

/* ── Stop scan button ────────────────────────────────────────────── */
document.getElementById('btn-stop-scan')?.addEventListener('click', () => {
    const btn = /** @type {HTMLButtonElement} */(document.getElementById('btn-stop-scan'));
    if (btn) { btn.disabled = true; btn.textContent = 'Stopping…'; }
    vscode.postMessage({ type: 'stopScan' });
});

/* ── Copy log button ─────────────────────────────────────────────── */
document.getElementById('btn-copy-log')?.addEventListener('click', () => {
    const log = document.getElementById('scan-log');
    if (!log) { return; }
    const text = [...log.querySelectorAll('.scan-log-line')].map(el => el.textContent).join('\n');
    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('btn-copy-log');
        if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy Log'; }, 2000); }
    }).catch(() => { showToast('Copy failed — try manually selecting the log', 'warning'); });
});

/* ── Scan severity dropdown ──────────────────────────────────────── */
document.getElementById('scan-sev-dropdown-btn')?.addEventListener('click', () => {
    document.getElementById('scan-sev-dropdown-menu')?.classList.toggle('hidden');
});
document.querySelectorAll('.scan-sev-filter').forEach(cb => {
    cb.addEventListener('change', () => { updateScanSevDropdownLabel(); renderScanIssues(); });
});
function updateScanSevDropdownLabel() {
    const checked = document.querySelectorAll('.scan-sev-filter:checked');
    const total   = document.querySelectorAll('.scan-sev-filter').length;
    const btn     = document.getElementById('scan-sev-dropdown-btn');
    if (btn) {
        btn.textContent = checked.length === total
            ? 'Severity: All ▾'
            : `Severity: ${checked.length} selected ▾`;
    }
}

/* ── Scan file/message search ────────────────────────────────────── */
document.getElementById('scan-file-search')?.addEventListener('input', () => {
    state.scanPage = 1;
    renderScanIssues();
});

/* ── Scan pagination ─────────────────────────────────────────────── */
document.getElementById('scan-btn-prev')?.addEventListener('click', () => {
    if (state.scanPage > 1) { state.scanPage--; renderScanIssues(); }
});
document.getElementById('scan-btn-next')?.addEventListener('click', () => {
    state.scanPage++;
    renderScanIssues();
});

/* ── Scan export dropdown ────────────────────────────────────────── */
document.getElementById('scan-btn-export')?.addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('scan-export-menu')?.classList.toggle('hidden');
});
document.addEventListener('click', e => {
    if (!/** @type {HTMLElement} */(e.target).closest('.export-wrap')) {
        document.getElementById('scan-export-menu')?.classList.add('hidden');
    }
});
document.getElementById('scan-export-menu')?.addEventListener('click', e => {
    const btn = /** @type {HTMLElement} */(e.target).closest('[data-export]');
    if (!btn) { return; }
    document.getElementById('scan-export-menu')?.classList.add('hidden');
    exportScanIssues(/** @type {HTMLElement} */(btn).dataset.export || '', state.scanFiltered);
});
document.getElementById('scan-btn-export-selected')?.addEventListener('click', () => {
    const issues = state.scanIssues.filter(i => state.scanSelectedKeys.has(i.key));
    if (!issues.length) { return; }
    exportScanIssues('csv', issues);
});

/* ── Scan issues container delegation ───────────────────────────── */
document.getElementById('scan-issues-container')?.addEventListener('click', e => {
    const target    = /** @type {HTMLElement} */(e.target);
    const openBtn   = target.closest('[data-action="openScanIssue"]');
    const checkbox  = target.closest('[data-action="selectScan"]');
    const selectAll = target.closest('#select-all-scan-issues');

    if (openBtn) {
        vscode.postMessage({ type: 'openUrl', url: /** @type {HTMLElement} */(openBtn).dataset.url });
        return;
    }
    if (checkbox) {
        const key = /** @type {HTMLElement} */(checkbox).dataset.issueKey || '';
        /** @type {HTMLInputElement} */(checkbox).checked
            ? state.scanSelectedKeys.add(key)
            : state.scanSelectedKeys.delete(key);
        updateScanSelectionUI();
        return;
    }
    if (selectAll) {
        const checked = /** @type {HTMLInputElement} */(selectAll).checked;
        state.scanFiltered.forEach(i => {
            checked ? state.scanSelectedKeys.add(i.key) : state.scanSelectedKeys.delete(i.key);
        });
        renderScanIssues();
        updateScanSelectionUI();
    }
});
document.getElementById('scan-results-summary')?.addEventListener('click', e => {
    const link = /** @type {HTMLElement} */(e.target).closest('[data-action="openScanUrl"]');
    if (link) {
        e.preventDefault();
        vscode.postMessage({ type: 'openUrl', url: /** @type {HTMLElement} */(link).dataset.url || state.scanDashboardUrl });
    }
});

function updateScanSelectionUI() {
    const count = state.scanSelectedKeys.size;
    const btn   = document.getElementById('scan-btn-export-selected');
    const span  = document.getElementById('scan-sel-count');
    btn?.classList.toggle('hidden', count === 0);
    if (span) { span.textContent = String(count); }
}

/** @param {string} format @param {any[]} issues */
function exportScanIssues(format, issues) {
    let content = '', filename = '';
    if (format === 'json') {
        content = JSON.stringify(issues.map(i => ({
            key: i.key,
            file: i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component,
            line: i.textRange?.startLine ?? i.line ?? null,
            severity: i.severity, type: i.type, rule: i.rule, message: i.message, status: i.status
        })), null, 2);
        filename = 'sonar-scan-issues.json';
    } else {
        const rows = [['Key', 'File', 'Line', 'Severity', 'Type', 'Rule', 'Message', 'Status']];
        issues.forEach(i => {
            const f = i.component.includes(':') ? i.component.split(':').slice(1).join(':') : i.component;
            rows.push([i.key, f, String(i.textRange?.startLine ?? i.line ?? ''), i.severity, i.type || '', i.rule, `"${(i.message || '').replaceAll('"', '""')}"`, i.status]);
        });
        content = rows.map(r => r.join(',')).join('\n');
        filename = 'sonar-scan-issues.csv';
    }
    vscode.postMessage({ type: 'export', format, content, filename });
}

/* ── Message handlers ────────────────────────────────────────────── */
function onCurrentBranch(branch) {
    state.scanBranch = branch;
    const el = document.getElementById('scan-current-branch');
    if (el) { el.textContent = branch; }
    const scanBtn = /** @type {HTMLButtonElement} */(document.getElementById('btn-scan-branch'));
    if (scanBtn) { scanBtn.disabled = false; }
    const changedBtn = /** @type {HTMLButtonElement} */(document.getElementById('btn-scan-changed'));
    if (changedBtn) { changedBtn.disabled = false; }
}

function onSyncPreflight(profiles, totalRules, estimatedTime) {
    const profilesEl = document.getElementById('sync-modal-profiles');
    const timeEl     = document.getElementById('sync-modal-time');
    if (profilesEl) {
        const langCount = new Set(profiles.map(/** @param {any} p */ p => p.language)).size;
        profilesEl.innerHTML = `<div class="modal-summary">
            <div class="modal-summary-item"><span class="modal-summary-num">${langCount}</span><span class="modal-summary-label">languages</span></div>
            <div class="modal-summary-item"><span class="modal-summary-num">${totalRules}</span><span class="modal-summary-label">active rules</span></div>
        </div>`;
    }
    if (timeEl) { timeEl.textContent = estimatedTime; }
    state.syncEstimate = estimatedTime || '';
    document.getElementById('sync-modal-time-row')?.classList.remove('hidden');
    const confirmBtn = /** @type {HTMLButtonElement} */(document.getElementById('sync-modal-confirm'));
    if (confirmBtn) { confirmBtn.disabled = false; }
}

function onRulesLoaded(syncedAt, ruleCount, profiles, rules) {
    if (/** @type {any} */(window).__syncTimer) { clearInterval(/** @type {any} */(window).__syncTimer); /** @type {any} */(window).__syncTimer = null; }
    const bar  = document.getElementById('scan-rules-status');
    const info = document.getElementById('scan-rules-info');
    if (bar) { bar.classList.remove('hidden'); }

    const date  = syncedAt ? new Date(syncedAt).toLocaleString() : 'unknown';
    const langs = profiles ? profiles.map(/** @param {any} p */ p => p.languageName || p.language).join(', ') : '';
    if (info) {
        info.innerHTML = `✔ <strong>${ruleCount}</strong> rules synced (${esc(langs)}) — last synced ${esc(date)}`;
    }

    if (rules && rules.length > 0) {
        state.allRules = rules;
        populateLangFilter(rules);
        document.getElementById('btn-view-rules')?.classList.remove('hidden');
        // Redirect to the language index only when triggered by a fresh user sync
        // (not when the cached rules are restored on webview load)
        if (state.syncRequested) { openRulesViewer(); }
    }
    state.syncRequested = false;
}

/* ── Scan elapsed timer ──────────────────────────────────────────── */
let _scanTimerInt = null;

function fmtDur(ms) {
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function startScanTimer(expectedMs) {
    stopScanTimer();
    const el = document.getElementById('scan-timer');
    const startTs = Date.now();
    const expected = expectedMs ? ` / expected ~${fmtDur(expectedMs)}` : '';
    const tick = () => { if (el) { el.textContent = `${fmtDur(Date.now() - startTs)}${expected}`; } };
    tick();
    _scanTimerInt = setInterval(tick, 1000);
}

function stopScanTimer() {
    if (_scanTimerInt) { clearInterval(_scanTimerInt); _scanTimerInt = null; }
}

function onScanStarted(branch, expectedMs) {
    state.scanBranch = branch;
    state.scanPage = 1;
    state.scanSelectedKeys.clear();
    startScanTimer(expectedMs);
    document.getElementById('scan-progress-box')?.classList.remove('hidden');
    document.getElementById('scan-results-summary')?.classList.add('hidden');
    document.getElementById('scan-issue-filters')?.classList.add('hidden');
    document.getElementById('scan-error-box')?.classList.add('hidden');
    const spinner = document.getElementById('scan-progress-spinner');
    const title   = document.getElementById('scan-progress-title');
    if (spinner) { spinner.classList.remove('hidden'); }
    if (title)   { title.textContent = 'Scanning…'; title.style.color = ''; }
    setStopScanBtn('visible');
    const log = document.getElementById('scan-log');
    if (log) { log.innerHTML = ''; }
    const container = document.getElementById('scan-issues-container');
    if (container) { container.innerHTML = '<div class="empty-state">Scanning…</div>'; }
}

/** @param {'visible'|'hidden'} mode */
function setStopScanBtn(mode) {
    const btn = /** @type {HTMLButtonElement} */(document.getElementById('btn-stop-scan'));
    if (!btn) { return; }
    btn.classList.toggle('hidden', mode !== 'visible');
    btn.disabled = false;
    btn.innerHTML = '&#9632; Stop';
}

/* ── Local SonarQube setup modal ─────────────────────────────────── */
/** @type {'full'|'changed'} */
let _localSetupScope = 'full';

function onLocalSetupRequired(defaults, scope) {
    _localSetupScope = scope === 'changed' ? 'changed' : 'full';
    setVal('local-setup-host', defaults?.host || '127.0.0.1');
    setVal('local-setup-port', String(defaults?.port || 9876));
    setVal('local-setup-user', defaults?.username || 'admin');
    setVal('local-setup-pass', defaults?.password || '');
    const note = document.getElementById('local-setup-image-note');
    if (note) { note.textContent = `Image: ${defaults?.image || 'sonarqube:community'}`; }
    document.getElementById('local-setup-overlay')?.classList.remove('hidden');
}

function closeLocalSetupModal() {
    document.getElementById('local-setup-overlay')?.classList.add('hidden');
}

document.getElementById('local-setup-close')?.addEventListener('click', closeLocalSetupModal);
document.getElementById('local-setup-cancel')?.addEventListener('click', closeLocalSetupModal);
document.getElementById('local-setup-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('local-setup-overlay')) { closeLocalSetupModal(); }
});
document.getElementById('local-setup-confirm')?.addEventListener('click', () => {
    const port = Number(val('local-setup-port'));
    const password = val('local-setup-pass');
    if (!port || port < 1024 || port > 65535) {
        return showToast('Enter a valid port (1024–65535)', 'error');
    }
    if (!password || password.length < 8) {
        return showToast('Admin password must be at least 8 characters', 'error');
    }
    closeLocalSetupModal();
    vscode.postMessage({ type: 'confirmLocalSetup', port, password, scope: _localSetupScope });
});

function onScanStopped() {
    const spinner = document.getElementById('scan-progress-spinner');
    const title   = document.getElementById('scan-progress-title');
    if (spinner) { spinner.classList.add('hidden'); }
    if (title)   { title.textContent = 'Scan stopped'; title.style.color = 'var(--warning)'; }
    stopScanTimer();
    setStopScanBtn('hidden');
    const container = document.getElementById('scan-issues-container');
    if (container) { container.innerHTML = '<div class="empty-state">Scan stopped. Click "Scan Branch" to start again.</div>'; }
}

function onScanProgress(message) {
    const log = document.getElementById('scan-log');
    if (!log) { return; }
    const line = document.createElement('div');
    line.className = 'scan-log-line';
    line.textContent = message;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
}

function onScanComplete(branch, issues, total, dashboardUrl, isLocal) {
    // Keep log visible but update header to show done
    const spinner = document.getElementById('scan-progress-spinner');
    const title   = document.getElementById('scan-progress-title');
    if (spinner) { spinner.classList.add('hidden'); }
    if (title)   { title.textContent = isLocal ? 'Scan complete (local)' : 'Scan complete'; title.style.color = 'var(--success)'; }
    stopScanTimer();
    setStopScanBtn('hidden');

    state.scanIssues     = issues || [];
    state.scanDashboardUrl = dashboardUrl || '';
    state.scanLocal      = !!isLocal;

    const summary = document.getElementById('scan-results-summary');
    const resultText = document.getElementById('scan-result-text');
    const dashLink   = /** @type {HTMLElement} */(document.getElementById('scan-dashboard-link'));

    if (summary) { summary.classList.remove('hidden'); }
    if (resultText) {
        resultText.textContent = total === 0
            ? `✔ No issues found on branch “${branch}”`
            : `⚠ ${total} issue(s) found on branch “${branch}”`;
        resultText.className = `scan-result-text ${total === 0 ? 'scan-result-ok' : 'scan-result-warn'}`;
    }
    if (dashLink) {
        if (dashboardUrl) {
            dashLink.classList.remove('hidden');
            dashLink.dataset.url = dashboardUrl;
        } else {
            dashLink.classList.add('hidden');
        }
    }

    if (issues && issues.length > 0) {
        document.getElementById('scan-issue-filters')?.classList.remove('hidden');
        renderScanIssues();
    } else {
        const container = document.getElementById('scan-issues-container');
        if (container) { container.innerHTML = '<div class="empty-state">✔ No issues found — your branch is clean!</div>'; }
        document.getElementById('scan-issue-filters')?.classList.add('hidden');
    }
}

function onScanError(message) {
    // Keep log visible — update header, show structured error below log
    const spinner = document.getElementById('scan-progress-spinner');
    const title   = document.getElementById('scan-progress-title');
    if (spinner) { spinner.classList.add('hidden'); }
    if (title)   { title.textContent = 'Scan failed'; title.style.color = 'var(--error)'; }
    stopScanTimer();
    setStopScanBtn('hidden');

    const errBox = document.getElementById('scan-error-box');
    if (errBox) {
        errBox.classList.remove('hidden');
        // Format the message into a readable card
        const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
        const isInstallMsg = message.includes('brew install') || message.includes('sonar-scanner not found');
        if (isInstallMsg) {
            // Format install instructions with sections
            const sections = [];
            let current = null;
            for (const line of lines) {
                if (line.endsWith(':')) {
                    current = { heading: line.slice(0, -1), lines: [] };
                    sections.push(current);
                } else if (current) {
                    current.lines.push(line);
                } else {
                    sections.push({ heading: null, lines: [line] });
                }
            }
            errBox.innerHTML = `
                <div class="scan-err-header">&#10007; sonar-scanner not found</div>
                <div class="scan-err-body">
                    ${sections.map(s => `
                        ${s.heading ? `<div class="scan-err-section">${esc(s.heading)}</div>` : ''}
                        ${s.lines.map(l => `<div class="scan-err-line"><code>${esc(l)}</code></div>`).join('')}
                    `).join('')}
                </div>`;
        } else {
            // General error — pull out key lines
            const errorLines = lines.filter(l => l.includes('ERROR') || l.includes('mandatory') || l.includes('must define'));
            const display = errorLines.length > 0 ? errorLines : lines.slice(0, 6);
            errBox.innerHTML = `
                <div class="scan-err-header">&#10007; Scan failed</div>
                <div class="scan-err-body">
                    ${display.map(l => `<div class="scan-err-line">${esc(l)}</div>`).join('')}
                </div>`;
        }
    }

    const container = document.getElementById('scan-issues-container');
    if (container) { container.innerHTML = ''; }
}

function renderScanIssues() {
    const container  = document.getElementById('scan-issues-container');
    const pagination = document.getElementById('scan-pagination');
    if (!container) { return; }

    const activeSevs = new Set(
        [...document.querySelectorAll('.scan-sev-filter:checked')]
            .map(el => /** @type {HTMLInputElement} */(el).value)
    );
    const q = (/** @type {HTMLInputElement} */(document.getElementById('scan-file-search'))?.value || '').toLowerCase().trim();

    const filtered = state.scanIssues.filter(issue => {
        if (!activeSevs.has(issue.severity)) { return false; }
        if (q) {
            const file = issue.component.includes(':') ? issue.component.split(':').slice(1).join(':') : issue.component;
            const haystack = `${file} ${issue.message || ''}`.toLowerCase();
            if (!haystack.includes(q)) { return false; }
        }
        return true;
    });
    state.scanFiltered = filtered;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No issues match the current filters.</div>';
        pagination?.classList.add('hidden');
        return;
    }

    const totalPages = Math.ceil(filtered.length / state.scanPageSize);
    if (state.scanPage > totalPages) { state.scanPage = totalPages; }
    if (state.scanPage < 1) { state.scanPage = 1; }
    const pageOffset = (state.scanPage - 1) * state.scanPageSize;
    const pageIssues = filtered.slice(pageOffset, pageOffset + state.scanPageSize);

    // Local scans link to the local container UI (no branch param — local
    // analysis is unbranched); server scans link to the central server.
    const localBase = state.scanLocal && state.scanDashboardUrl
        ? state.scanDashboardUrl.split('/dashboard')[0] : '';

    const allSelected = pageIssues.every(i => state.scanSelectedKeys.has(i.key));

    const rows = pageIssues.map((issue, idx) => {
        const filePath = issue.component.includes(':') ? issue.component.split(':').slice(1).join(':') : issue.component;
        const line     = issue.textRange?.startLine ?? issue.line ?? '—';
        const projectId = issue.project || state.projectKey;
        const selected = state.scanSelectedKeys.has(issue.key);
        let issueUrl = '';
        if (state.scanLocal && localBase) {
            issueUrl = `${localBase}/project/issues?id=${encodeURIComponent(projectId)}&issues=${encodeURIComponent(issue.key)}&open=${encodeURIComponent(issue.key)}`;
        } else if (state.sonarUri && state.projectKey) {
            issueUrl = `${state.sonarUri}/project/issues?id=${encodeURIComponent(state.projectKey)}&issues=${encodeURIComponent(issue.key)}&open=${encodeURIComponent(issue.key)}&branch=${encodeURIComponent(state.scanBranch)}`;
        }
        return `<tr class="${selected ? 'row-selected' : ''}">
            <td><input type="checkbox" class="row-check" data-action="selectScan" data-issue-key="${esc(issue.key)}" ${selected ? 'checked' : ''}></td>
            <td class="cell-sr">${pageOffset + idx + 1}</td>
            <td><span class="sev sev-${issue.severity}">${issue.severity}</span></td>
            <td class="msg-cell">
                <span class="cell-msg">${issueUrl
                    ? `<a class="issue-link" data-action="openScanIssue" data-url="${esc(issueUrl)}" href="#" title="Open in SonarQube">${esc(issue.message)}</a>`
                    : esc(issue.message)}</span>
                <span class="cell-file">${esc(filePath)}:${line}</span>
            </td>
            <td><span class="stat stat-${issue.status}">${issue.status}</span></td>
            <td><code class="rule-key">${esc(issue.rule)}</code></td>
        </tr>`;
    }).join('');

    const filterNote = filtered.length < state.scanIssues.length
        ? ` (${filtered.length} shown after filters)` : '';
    const from = pageOffset + 1;
    const to   = Math.min(pageOffset + state.scanPageSize, filtered.length);

    container.innerHTML = `
        <div class="issues-summary">Showing ${from}–${to} of ${filtered.length} issue(s) on branch “${esc(state.scanBranch)}”${filterNote}</div>
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th><input type="checkbox" id="select-all-scan-issues" ${allSelected ? 'checked' : ''}></th>
                        <th class="cell-sr">#</th>
                        <th>Sev</th>
                        <th>Message / File</th>
                        <th>Status</th>
                        <th>Rule</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

    const pageInfo = document.getElementById('scan-page-info');
    const btnPrev  = /** @type {HTMLButtonElement} */(document.getElementById('scan-btn-prev'));
    const btnNext  = /** @type {HTMLButtonElement} */(document.getElementById('scan-btn-next'));
    if (pageInfo) { pageInfo.textContent = `${state.scanPage} / ${totalPages}`; }
    if (btnPrev)  { btnPrev.disabled = state.scanPage <= 1; }
    if (btnNext)  { btnNext.disabled = state.scanPage >= totalPages; }
    pagination?.classList.toggle('hidden', totalPages <= 1);
    updateScanSelectionUI();
}

/* ══════════════════════════════════════════════════════════════════
   SYNC CONFIRMATION MODAL
══════════════════════════════════════════════════════════════════ */

document.getElementById('sync-modal-close')?.addEventListener('click', closeSyncModal);
document.getElementById('sync-modal-cancel')?.addEventListener('click', closeSyncModal);
document.getElementById('sync-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('sync-modal-overlay')) { closeSyncModal(); }
});
document.getElementById('sync-modal-confirm')?.addEventListener('click', () => {
    closeSyncModal();
    state.syncRequested = true;
    const bar  = document.getElementById('scan-rules-status');
    const info = document.getElementById('scan-rules-info');
    if (bar)  { bar.classList.remove('hidden'); }
    // Show elapsed timer + estimate while syncing
    const est = state.syncEstimate ? ` <span style="color:var(--text-muted)">(estimated: ${esc(state.syncEstimate)})</span>` : '';
    const syncLine = s => `<span class="spinner" style="width:11px;height:11px;border-width:2px;border-top-color:var(--accent);display:inline-block;vertical-align:middle;margin-right:6px"></span> Syncing rules… ${s}s${est}`;
    let elapsed = 0;
    const syncTimer = setInterval(() => {
        elapsed++;
        if (info) { info.innerHTML = syncLine(elapsed); }
    }, 1000);
    if (info) { info.innerHTML = syncLine(0); }
    // Store timer id so rulesLoaded can clear it
    /** @type {any} */(window).__syncTimer = syncTimer;
    vscode.postMessage({ type: 'syncRules' });
});

function closeSyncModal() {
    document.getElementById('sync-modal-overlay')?.classList.add('hidden');
}

/* ══════════════════════════════════════════════════════════════════
   RULES VIEWER PAGE
══════════════════════════════════════════════════════════════════ */

const RULES_PAGE_SIZE = 50;

function openRulesViewer() {
    state.rulesPage = 1;
    renderLangIndex();
    showPage('rules-index');
}

function openRulesForLang(lang) {
    // Pre-set the language filter then show rules page
    const sel = /** @type {HTMLSelectElement} */(document.getElementById('rules-filter-lang'));
    if (sel) { sel.value = lang; }
    const typeSel = /** @type {HTMLSelectElement} */(document.getElementById('rules-filter-type'));
    if (typeSel) { typeSel.value = ''; }
    const sevSel = /** @type {HTMLSelectElement} */(document.getElementById('rules-filter-severity'));
    if (sevSel) { sevSel.value = ''; }
    const search = /** @type {HTMLInputElement} */(document.getElementById('rules-search'));
    if (search) { search.value = ''; }
    state.rulesPage = 1;
    showPage('rules');
    renderRules();
}

document.getElementById('btn-rules-index-back')?.addEventListener('click', () => showPage('main'));
document.getElementById('btn-rules-back')?.addEventListener('click', () => {
    showPage('rules-index');
});

// Rules container delegation — open rule in browser on click
document.getElementById('rules-list-container')?.addEventListener('click', e => {
    const card = /** @type {HTMLElement} */(e.target)?.closest('[data-rule-url]');
    if (card) {
        const url = /** @type {HTMLElement} */(card).dataset.ruleUrl;
        if (url) { vscode.postMessage({ type: 'openUrl', url }); }
    }
});

// Lang grid delegation
document.getElementById('rules-lang-grid')?.addEventListener('click', e => {
    const tile = /** @type {HTMLElement} */(e.target)?.closest('[data-lang]');
    if (tile) { openRulesForLang(/** @type {HTMLElement} */(tile).dataset.lang || ''); }
});

const LANG_ICONS = {
    java: '☕', js: '🟨', ts: '🔷', py: '🐍', cs: 'C#', go: '🐹',
    php: '🐘', ruby: '💎', kotlin: 'K', swift: '🦅', scala: 'Sc',
    cpp: 'C++', c: 'C', xml: 'XML', css: 'CSS', web: '🌐',
    html: 'HTML', docker: '🐳', terraform: 'TF', cloudformation: 'CF'
};

function renderLangIndex() {
    const grid  = document.getElementById('rules-lang-grid');
    const total = document.getElementById('rules-index-total');
    if (!grid) { return; }

    // Count rules per language
    /** @type {Map<string, {langName: string, count: number, bugs: number, vulns: number, smells: number}>} */
    const langMap = new Map();
    for (const r of state.allRules) {
        const lang = r.lang || 'other';
        if (!langMap.has(lang)) {
            langMap.set(lang, { langName: r.langName || lang, count: 0, bugs: 0, vulns: 0, smells: 0 });
        }
        const entry = langMap.get(lang);
        entry.count++;
        if (r.type === 'BUG')           { entry.bugs++; }
        if (r.type === 'VULNERABILITY' || r.type === 'SECURITY_HOTSPOT') { entry.vulns++; }
        if (r.type === 'CODE_SMELL')    { entry.smells++; }
    }

    if (total) { total.textContent = `${state.allRules.length} total rules`; }

    const sorted = [...langMap.entries()].sort((a, b) => b[1].count - a[1].count);
    grid.innerHTML = sorted.map(([lang, info]) => {
        const icon = LANG_ICONS[lang] || lang.substring(0, 2).toUpperCase();
        return `<div class="lang-tile" data-lang="${esc(lang)}" title="View ${esc(info.langName)} rules">
            <div class="lang-tile-icon">${icon}</div>
            <div class="lang-tile-name">${esc(info.langName)}</div>
            <div class="lang-tile-count">${info.count} rules</div>
            <div class="lang-tile-breakdown">
                ${info.bugs    ? `<span class="lt-bug">${info.bugs}B</span>` : ''}
                ${info.vulns   ? `<span class="lt-vuln">${info.vulns}V</span>` : ''}
                ${info.smells  ? `<span class="lt-smell">${info.smells}S</span>` : ''}
            </div>
        </div>`;
    }).join('');
}

document.getElementById('rules-search')?.addEventListener('input', () => {
    state.rulesPage = 1;
    renderRules();
});
document.getElementById('rules-filter-type')?.addEventListener('change', () => {
    state.rulesPage = 1;
    renderRules();
});
document.getElementById('rules-filter-severity')?.addEventListener('change', () => {
    state.rulesPage = 1;
    renderRules();
});
document.getElementById('rules-filter-lang')?.addEventListener('change', () => {
    state.rulesPage = 1;
    renderRules();
});

document.getElementById('rules-btn-prev')?.addEventListener('click', () => {
    if (state.rulesPage > 1) { state.rulesPage--; renderRules(); }
});
document.getElementById('rules-btn-next')?.addEventListener('click', () => {
    state.rulesPage++;
    renderRules();
});

function populateLangFilter(rules) {
    const langs = [...new Map(rules.map(/** @param {any} r */ r => [r.lang, r.langName || r.lang])).entries()]
        .sort((a, b) => a[1].localeCompare(b[1]));
    const sel = document.getElementById('rules-filter-lang');
    if (!sel) { return; }
    sel.innerHTML = '<option value="">All Languages</option>';
    for (const [lang, langName] of langs) {
        const opt = document.createElement('option');
        opt.value = lang;
        opt.textContent = langName;
        sel.appendChild(opt);
    }
}

function getRulesFiltered() {
    const q    = (/** @type {HTMLInputElement} */(document.getElementById('rules-search'))?.value || '').toLowerCase().trim();
    const type = (/** @type {HTMLSelectElement} */(document.getElementById('rules-filter-type'))?.value || '');
    const sev  = (/** @type {HTMLSelectElement} */(document.getElementById('rules-filter-severity'))?.value || '');
    const lang = (/** @type {HTMLSelectElement} */(document.getElementById('rules-filter-lang'))?.value || '');

    return state.allRules.filter(/** @param {any} r */ r => {
        if (type && r.type !== type)    { return false; }
        if (sev  && r.severity !== sev) { return false; }
        if (lang && r.lang !== lang)    { return false; }
        if (q) {
            const text = `${r.key} ${r.name}`.toLowerCase();
            if (!text.includes(q))      { return false; }
        }
        return true;
    });
}

const TYPE_LABELS = { BUG: 'Bug', VULNERABILITY: 'Vulnerability', CODE_SMELL: 'Code Smell', SECURITY_HOTSPOT: 'Hotspot' };
const TYPE_CLASS  = { BUG: 'type-bug', VULNERABILITY: 'type-vuln', CODE_SMELL: 'type-smell', SECURITY_HOTSPOT: 'type-hotspot' };

const TYPE_ORDER = ['BUG', 'VULNERABILITY', 'SECURITY_HOTSPOT', 'CODE_SMELL'];

function renderRules() {
    const container  = document.getElementById('rules-list-container');
    const pagination = document.getElementById('rules-pagination');
    const badge      = document.getElementById('rules-count-badge');
    if (!container) { return; }

    const filtered = getRulesFiltered();
    if (badge) { badge.textContent = `${filtered.length} rules`; }

    if (filtered.length === 0) {
        container.innerHTML = '<div class="empty-state">No rules match the current filters.</div>';
        pagination?.classList.add('hidden');
        return;
    }

    // When no type filter active → group by category, no pagination
    const typeFilter = (/** @type {HTMLSelectElement} */(document.getElementById('rules-filter-type'))?.value || '');
    if (!typeFilter) {
        pagination?.classList.add('hidden');
        // Group by type
        /** @type {Record<string, any[]>} */
        const groups = {};
        for (const r of filtered) {
            const t = r.type || 'OTHER';
            if (!groups[t]) { groups[t] = []; }
            groups[t].push(r);
        }
        const orderedTypes = [
            ...TYPE_ORDER.filter(t => groups[t]),
            ...Object.keys(groups).filter(t => !TYPE_ORDER.includes(t))
        ];
        container.innerHTML = orderedTypes.map(type => {
            const rules     = groups[type];
            const typeLabel = TYPE_LABELS[type] || type;
            const typeCls   = TYPE_CLASS[type]  || 'type-other';
            const rows = rules.map(r => ruleCardHtml(r)).join('');
            return `<div class="rules-category">
                <div class="rules-category-header">
                    <span class="rule-type-badge ${typeCls}">${esc(typeLabel)}</span>
                    <span class="rules-category-count">${rules.length} rules</span>
                </div>
                ${rows}
            </div>`;
        }).join('');
        return;
    }

    // Type filter active → flat paginated list
    const totalPages = Math.ceil(filtered.length / RULES_PAGE_SIZE);
    if (state.rulesPage > totalPages) { state.rulesPage = totalPages; }
    const start = (state.rulesPage - 1) * RULES_PAGE_SIZE;
    container.innerHTML = filtered.slice(start, start + RULES_PAGE_SIZE).map(r => ruleCardHtml(r)).join('');

    const pageInfo = document.getElementById('rules-page-info');
    const btnPrev  = /** @type {HTMLButtonElement} */(document.getElementById('rules-btn-prev'));
    const btnNext  = /** @type {HTMLButtonElement} */(document.getElementById('rules-btn-next'));
    if (pageInfo) { pageInfo.textContent = `${state.rulesPage} / ${totalPages}`; }
    if (btnPrev)  { btnPrev.disabled = state.rulesPage <= 1; }
    if (btnNext)  { btnNext.disabled = state.rulesPage >= totalPages; }
    pagination?.classList.toggle('hidden', totalPages <= 1);
}

/** @param {any} r */
function ruleCardHtml(r) {
    const typeLabel = TYPE_LABELS[r.type] || r.type || '—';
    const typeCls   = TYPE_CLASS[r.type]  || 'type-other';
    const sev       = r.severity || 'INFO';
    const desc = r.htmlDesc
        ? r.htmlDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 200)
        : '';
    const ruleUrl = state.sonarUri
        ? `${state.sonarUri}/coding_rules?rule_key=${encodeURIComponent(r.key)}`
        : '';
    return `<div class="rule-card rule-sev-${sev}" data-rule-url="${esc(ruleUrl)}" title="Click to open rule in SonarQube">
        <div class="rule-card-header">
            <span class="rule-card-name">${esc(r.name)}</span>
            <span class="rule-card-badges">
                <span class="sev sev-${sev}">${sev}</span>
                <span class="rule-type-badge ${typeCls}">${esc(typeLabel)}</span>
                <span class="rule-lang-badge">${esc(r.langName || r.lang)}</span>
            </span>
        </div>
        <div class="rule-card-key">${esc(r.key)}</div>
        ${desc ? `<div class="rule-card-desc">${esc(desc)}${r.htmlDesc && r.htmlDesc.replace(/<[^>]+>/g,'').trim().length > 200 ? '…' : ''}</div>` : ''}
        ${ruleUrl ? `<div class="rule-card-link">Open in SonarQube ↗</div>` : ''}
    </div>`;
}
