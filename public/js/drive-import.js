/**
 * Google Drive integration — sidebar panel + import flows.
 * Scans key Drive folders, browses files, imports .rvt (RVT pipeline) and .xlsx (schedule mapper).
 * Reads: routes/drive.js, routes/drive-schedule-import.js (backend).
 */

let _driveConnected = false;
let _driveFiles = [];
let _selectedFile = null;
let _isDownloading = false;

// ─── Pre-configured Drive folders ────────────────────────────────────────────

const DRIVE_FOLDERS = {
  'Root':           { id: '19xjC4G4Bko8ZiN4-xA7947xOpXFkh5jP', parent: null },
  'NDP/79 Winthrop': { id: '1x3wKBifuXihr5YGXsdb728kyHDtl6uCG', parent: '19xjC4G4Bko8ZiN4-xA7947xOpXFkh5jP' },
  'Bird House':      { id: '1QSxntVkBZKPXuznuegh8KYEbcxEZeMIH', parent: '19xjC4G4Bko8ZiN4-xA7947xOpXFkh5jP' },
};
const ROOT_ID = DRIVE_FOLDERS['Root'].id;

// ─── Folder state ─────────────────────────────────────────────────────────────

let _folderStack = [];   // nav stack: [{ id, name }]
let _cachedFiles = {};   // folderId → files array (for "offline" fallback)

// ─── Drive Panel — sidebar UI ─────────────────────────────────────────────────

const DrivePanel = {
  _refreshInterval: null,
  _lastSynced: null,

  init() {
    this._checkStatus();
    this._startAutoRefresh();
  },

  _startAutoRefresh() {
    if (this._refreshInterval) clearInterval(this._refreshInterval);
    // Auto-refresh every 5 minutes when panel is open
    this._refreshInterval = setInterval(() => {
      if (document.getElementById('sidebar-pane-drive')?.classList.contains('active')) {
        this.refresh();
      }
    }, 5 * 60 * 1000);
  },

  async _checkStatus() {
    try {
      const res = await fetch('/api/drive/status');
      const data = await res.json();
      _driveConnected = !!data.connected;
      this._render();
    } catch {
      this._renderOffline();
    }
  },

  _render() {
    const stateEl = document.getElementById('drive-connect-state');
    if (!stateEl) return;

    if (!_driveConnected) {
      stateEl.innerHTML = `
        <div style="text-align:center;padding:8px 0">
          <svg width="28" height="20" viewBox="0 0 48 32" fill="none" aria-hidden="true" style="margin-bottom:6px">
            <path d="M6.4 30.3L18 9.1H30l11.6 21.2H6.4z" fill="#EA4335"/>
            <path d="M30 9.1L18 30.3 6.4 9.1H30z" fill="#34A853"/>
            <path d="M42 9.1L30 30.3 18 9.1H42z" fill="#4285F4"/>
            <path d="M42 30.3L30 9.1H18L30 30.3H42z" fill="#FBBC05"/>
          </svg>
          <div style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px">Connect Google Drive</div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:12px">Import .rvt and .xlsx files directly into your model</div>
          <button id="btn-drive-connect" onclick="DrivePanel.connect()" style="background:var(--accent);border:none;color:white;cursor:pointer;font-size:13px;font-weight:600;padding:9px 20px;border-radius:8px;width:100%;max-width:200px">Connect Drive</button>
        </div>`;
      document.getElementById('drive-folder-tree').style.display = 'none';
      document.getElementById('drive-file-list').style.display = 'none';
      return;
    }

    stateEl.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <div style="width:8px;height:8px;border-radius:50%;background:#22c55e;flex-shrink:0"></div>
        <div style="font-size:11px;color:#22c55e;font-weight:600">Connected</div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <button onclick="DrivePanel.disconnect()" style="background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text-muted);font-size:10px;padding:4px 8px;border-radius:4px;cursor:pointer">Disconnect</button>
        <span style="font-size:10px;color:var(--text-muted)">Read-only</span>
      </div>`;
    document.getElementById('drive-folder-tree').style.display = 'block';
    document.getElementById('drive-file-list').style.display = 'block';
    this._loadFolderTree();
  },

  _renderOffline() {
    const stateEl = document.getElementById('drive-connect-state');
    if (!stateEl) return;
    stateEl.innerHTML = `
      <div style="background:rgba(251,188,5,0.12);border:1px solid rgba(251,188,5,0.25);border-radius:5px;padding:8px 10px;font-size:11px;color:#fbbf24;display:flex;align-items:center;gap:6px">
        <span>⚠</span> Drive unavailable — showing cached files
      </div>`;
    // Show cached root files if available
    if (_cachedFiles[ROOT_ID]) {
      document.getElementById('drive-folder-tree').style.display = 'block';
      document.getElementById('drive-file-list').style.display = 'block';
      this._renderFolderList(ROOT_ID, _cachedFiles[ROOT_ID]);
    }
  },

  async connect() {
    try {
      const res = await fetch('/api/drive/oauth/authorize');
      const data = await res.json();
      if (data.auth_url) {
        window.location.href = data.auth_url;
      } else {
        this._showError('Google Drive not configured. Contact your administrator.');
      }
    } catch {
      this._showError('Failed to connect Drive.');
    }
  },

  async disconnect() {
    try {
      await fetch('/api/drive/disconnect', { method: 'POST' });
      _driveConnected = false;
      _folderStack = [];
      _cachedFiles = {};
      this._render();
    } catch {
      this._showError('Failed to disconnect Drive.');
    }
  },

  async refresh() {
    if (!_driveConnected) return;
    const top = _folderStack[_folderStack.length - 1];
    if (top) {
      await this._navigateToFolder(top.id, top.name, false);
    } else {
      await this._navigateToFolder(ROOT_ID, 'Root', false);
    }
  },

  async _loadFolderTree() {
    // Always start at root when panel opens fresh
    if (_folderStack.length === 0) {
      await this._navigateToFolder(ROOT_ID, 'Root', true);
    }
  },

  async _navigateToFolder(folderId, folderName, resetStack) {
    const breadcrumb = document.getElementById('drive-breadcrumb');
    const folderList = document.getElementById('drive-folder-list');
    const filesContainer = document.getElementById('drive-files-container');

    if (!breadcrumb || !folderList) return;

    if (resetStack) {
      _folderStack = [{ id: folderId, name: folderName }];
    } else {
      // Dedup: if navigating to something already in stack, trim back to it
      const existingIdx = _folderStack.findIndex(f => f.id === folderId);
      if (existingIdx >= 0) {
        _folderStack = _folderStack.slice(0, existingIdx + 1);
      } else {
        _folderStack.push({ id: folderId, name: folderName });
      }
    }

    // Render breadcrumb
    breadcrumb.innerHTML = _folderStack.map((f, i) => {
      const arrow = i < _folderStack.length - 1 ? '<span style="opacity:0.4">›</span>' : '';
      const isLast = i === _folderStack.length - 1;
      return `<button onclick="DrivePanel._navigateToFolder('${f.id}','${f.name.replace(/'/g,"\\'")}',false)" style="background:none;border:none;color:${isLast ? 'var(--text)' : 'var(--accent)'};font-size:11px;cursor:pointer;font-weight:${isLast ? '600' : '400'}">${f.name}</button>${arrow}`;
    }).join('');

    // Show loading
    folderList.innerHTML = '<div style="padding:6px 14px;font-size:11px;color:var(--text-muted)">Loading…</div>';
    filesContainer.innerHTML = '<div style="padding:6px 14px;font-size:11px;color:var(--text-muted)">Loading…</div>';

    try {
      const res = await fetch(`/api/drive/folders/${folderId}/contents?page_size=200`);
      if (!res.ok) throw new Error('API error: ' + res.status);
      const data = await res.json();

      // Cache for offline fallback
      _cachedFiles[folderId] = data.files;

      const folders = data.files.filter(f => f.isFolder);
      const files = data.files.filter(f => !f.isFolder);

      this._renderFolderList(folderId, folders, files);
      this._updateLastSynced();
    } catch (err) {
      folderList.innerHTML = `<div style="padding:6px 14px;font-size:11px;color:#ef4444">Failed to load: ${err.message}</div>`;
      // Fall back to cached
      const cached = _cachedFiles[folderId];
      if (cached) {
        this._renderFolderList(folderId, cached.filter(f => f.isFolder), cached.filter(f => !f.isFolder));
      }
    }
  },

  _renderFolderList(folderId, folders, files = []) {
    const folderList = document.getElementById('drive-folder-list');
    const filesContainer = document.getElementById('drive-files-container');
    if (!folderList || !filesContainer) return;

    // Folders
    if (folders.length === 0) {
      folderList.innerHTML = '<div style="padding:4px 14px;font-size:11px;color:var(--text-muted);opacity:0.5">No subfolders</div>';
    } else {
      folderList.innerHTML = folders.map(f => `
        <button onclick="DrivePanel._navigateToFolder('${f.id}','${f.name.replace(/'/g,"\\'")}',true)" style="display:flex;align-items:center;gap:7px;width:100%;background:none;border:none;padding:5px 14px;cursor:pointer;color:var(--text);font-size:11px;border-radius:4px" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='none'">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="#f59e0b" aria-hidden="true"><path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/></svg>
          <span style="flex:1;text-align:left">${this._escapeHtml(f.name)}</span>
          <span style="font-size:10px;opacity:0.4">${(f.webViewUrl ? '↗' : '')}</span>
        </button>`).join('');
    }

    // Files
    if (files.length === 0) {
      filesContainer.innerHTML = '<div style="padding:6px 14px;font-size:11px;color:var(--text-muted);opacity:0.5">No files in this folder</div>';
    } else {
      _driveFiles = files;
      filesContainer.innerHTML = files.map(f => this._renderFileItem(f)).join('');
    }

    // Re-expose import button
    const importBtn = document.getElementById('btn-drive-import');
    if (importBtn) {
      importBtn.disabled = !_selectedFile || !this._canImport(_selectedFile);
      importBtn.style.opacity = importBtn.disabled ? '0.4' : '1';
    }
  },

  _renderFileItem(f) {
    const lc = f.name.toLowerCase();
    const isRvt = lc.endsWith('.rvt');
    const isXlsx = lc.endsWith('.xlsx');
    const isSelected = _selectedFile?.id === f.id;
    const icon = isRvt ? '📦' : isXlsx ? '📊' : '📄';
    const badge = isRvt ? '<span style="font-size:9px;background:#3b82f6;color:white;padding:1px 5px;border-radius:3px;font-weight:700">RVT</span>'
                  : isXlsx ? '<span style="font-size:9px;background:#16a34a;color:white;padding:1px 5px;border-radius:3px;font-weight:700">XLSX</span>'
                  : '<span style="font-size:9px;background:var(--border);color:var(--text-muted);padding:1px 5px;border-radius:3px">FILE</span>';
    return `
      <div class="drive-file-item${isSelected ? ' selected' : ''}" data-file-id="${f.id}" onclick="DrivePanel.selectFile('${f.id}')"
        style="display:flex;align-items:center;gap:7px;padding:6px 14px;margin:2px 0;cursor:pointer;border:1px solid ${isSelected ? 'var(--accent)' : 'transparent'};background:${isSelected ? 'rgba(59,130,246,0.08)' : 'transparent'};border-radius:5px"
        onmouseover="if(!this.classList.contains('selected'))this.style.background='rgba(255,255,255,0.03)'" onmouseout="if(!this.classList.contains('selected'))this.style.background='transparent'">
        <span style="font-size:13px">${icon}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:11px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${this._escapeHtml(f.name)}</div>
          <div style="font-size:10px;color:var(--text-muted)">${f.size ? formatFileSize(f.size) : ''} ${f.modifiedTime ? '· ' + formatDate(f.modifiedTime) : ''}</div>
        </div>
        ${badge}
      </div>`;
  },

  selectFile(fileId) {
    _selectedFile = _driveFiles.find(f => f.id === fileId) || null;

    document.querySelectorAll('.drive-file-item').forEach(el => {
      const selected = el.getAttribute('data-file-id') === fileId;
      el.style.border = selected ? '1px solid var(--accent)' : '1px solid transparent';
      el.style.background = selected ? 'rgba(59,130,246,0.08)' : 'transparent';
    });

    const importBtn = document.getElementById('btn-drive-import');
    if (importBtn) {
      const canImport = _selectedFile && this._canImport(_selectedFile);
      importBtn.disabled = !canImport;
      importBtn.style.opacity = canImport ? '1' : '0.4';
    }
  },

  _canImport(file) {
    if (!file) return false;
    const lc = file.name.toLowerCase();
    return lc.endsWith('.rvt') || lc.endsWith('.xlsx');
  },

  importSelected() {
    if (!_selectedFile) return;
    const lc = _selectedFile.name.toLowerCase();
    if (lc.endsWith('.rvt')) {
      this._importRvt(_selectedFile);
    } else if (lc.endsWith('.xlsx')) {
      this._importXlsx(_selectedFile);
    }
  },

  async _importRvt(file) {
    const progressDiv = document.getElementById('drive-download-progress');
    const progressLabel = document.getElementById('drive-progress-label');
    const progressBar = document.getElementById('drive-progress-bar');
    if (progressDiv) { progressDiv.style.display = 'block'; }
    if (progressLabel) progressLabel.textContent = `Downloading ${file.name}…`;
    if (progressBar) progressBar.style.width = '10%';
    document.getElementById('drive-import-error').style.display = 'none';

    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', `/api/drive/files/${file.id}/download`, true);
      xhr.responseType = 'blob';
      xhr.onprogress = (e) => {
        if (e.lengthComputable && progressBar) {
          progressBar.style.width = Math.round((e.loaded / e.total) * 70) + '%';
          if (progressLabel) progressLabel.textContent = `Downloading ${file.name}… ${formatFileSize(e.loaded)} / ${formatFileSize(e.total)}`;
        }
      };
      xhr.onload = async () => {
        if (xhr.status !== 200) {
          this._showError(`Download failed: ${xhr.statusText}`);
          if (progressDiv) progressDiv.style.display = 'none';
          return;
        }
        if (progressBar) progressBar.style.width = '80%';
        if (progressLabel) progressLabel.textContent = 'Starting RVT import…';
        const reader = new FileReader();
        reader.onload = async () => {
          const base64 = reader.result.split(',')[1];
          if (progressBar) progressBar.style.width = '90%';
          if (progressLabel) progressLabel.textContent = 'Starting RVT import…';
          try {
            const res = await fetch('/api/rvt-import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                project_id: window.currentProjectId || 1,
                file_name: file.name,
                file_size_bytes: xhr.response.size,
              }),
            });
            if (!res.ok) { this._showError('Import failed (HTTP ' + res.status + ')'); return; }
            const data = await res.json();
            if (progressBar) progressBar.style.width = '100%';
            if (progressLabel) progressLabel.textContent = 'Import started!';
            if (typeof showRvtProgress === 'function') showRvtProgress();
            if (data.run_id) pollRvtStatus(data.run_id);
            if (window.showToast) window.showToast(`RVT import started: ${file.name}`, 'info');
            setTimeout(() => { if (progressDiv) progressDiv.style.display = 'none'; }, 2000);
          } catch (err) {
            this._showError('Import failed: ' + err.message);
            if (progressDiv) progressDiv.style.display = 'none';
          }
        };
        reader.readAsDataURL(xhr.response);
      };
      xhr.onerror = () => {
        this._showError('Network error during download.');
        if (progressDiv) progressDiv.style.display = 'none';
      };
      xhr.send();
    } catch (err) {
      this._showError('Download error: ' + err.message);
      if (progressDiv) progressDiv.style.display = 'none';
    }
  },

  async _importXlsx(file) {
    // Open the schedule mapper modal with the selected file pre-loaded
    const previewUrl = `/api/drive/files/${file.id}/preview`;
    const modal = document.getElementById('modal-drive-schedule-mapper') || this._createScheduleMapperModal();
    modal.style.display = 'flex';
    modal.classList.remove('hidden');

    // Fetch preview data and populate mapper
    try {
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error('Preview failed');
      const data = await res.json();
      this._populateScheduleMapper(data);
    } catch (err) {
      this._showError('Failed to preview file: ' + err.message);
    }
  },

  _createScheduleMapperModal() {
    const modal = document.createElement('div');
    modal.id = 'modal-drive-schedule-mapper';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:none;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px)';
    modal.innerHTML = `
      <div style="background:var(--bg-panel);border-radius:12px;width:min(640px,90vw);max-height:80vh;overflow:auto;padding:20px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="font-size:15px;font-weight:700;margin:0">Import Excel Schedule</h3>
          <button onclick="this.closest('#modal-drive-schedule-mapper').style.display='none'" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:4px">✕</button>
        </div>
        <div id="schedule-mapper-body" style="font-size:12px;color:var(--text-muted)">Loading preview…</div>
        <div style="display:flex;gap:8px;margin-top:14px;justify-content:flex-end">
          <button onclick="this.closest('#modal-drive-schedule-mapper').style.display='none'" style="padding:8px 16px;background:rgba(255,255,255,0.06);border:1px solid var(--border);color:var(--text-muted);border-radius:6px;cursor:pointer;font-size:12px">Cancel</button>
          <button id="btn-confirm-schedule-import" style="padding:8px 16px;background:var(--accent);border:none;color:white;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600">Import Specs</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  },

  _populateScheduleMapper(data) {
    const body = document.getElementById('schedule-mapper-body');
    if (!body) return;
    body.innerHTML = `
      <div style="margin-bottom:12px;padding:10px;background:rgba(255,255,255,0.04);border-radius:6px">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px">${this._escapeHtml(data.fileName)}</div>
        <div style="font-size:11px;opacity:0.6">${data.sheets.length} sheet(s) · ${data.fileSize ? formatFileSize(data.fileSize) : ''}</div>
      </div>
      ${data.sheets.map(sheet => `
        <div style="margin-bottom:12px;padding:10px;border:1px solid var(--border);border-radius:6px">
          <div style="font-weight:600;font-size:12px;margin-bottom:6px">${this._escapeHtml(sheet.name)}</div>
          <div style="font-size:11px;margin-bottom:6px">${sheet.rowCount} rows · <span style="color:var(--accent)">${sheet.sheetType}</span></div>
          <div style="font-size:10px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sheet.headers.join(' · ')}</div>
        </div>`).join('')}`;
    document.getElementById('btn-confirm-schedule-import').onclick = () => this._confirmScheduleImport(data);
  },

  async _confirmScheduleImport(data) {
    const body = document.getElementById('schedule-mapper-body');
    if (body) body.innerHTML = '<div style="text-align:center;padding:20px;font-size:12px;color:var(--text-muted)">Importing schedule…</div>';
    try {
      const sheetConfigs = data.sheets.map(s => ({
        name: s.name,
        mapping: s.proposedMapping || {},
        scheduleTypeOverride: s.sheetType,
      }));
      const res = await fetch('/api/drive/import-schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId: data.fileId,
          fileName: data.fileName,
          projectId: window.currentProjectId || 1,
          sheets: sheetConfigs,
          preview: false,
          overwriteExisting: false,
        }),
      });
      if (!res.ok) { this._showError('Schedule import failed (HTTP ' + res.status + ')'); return; }
      const result = await res.json();
      document.getElementById('modal-drive-schedule-mapper').style.display = 'none';
      if (window.showToast) window.showToast(`Imported ${result.totalImported || 0} specs`, 'success');
    } catch (err) {
      this._showError('Import failed: ' + err.message);
    }
  },

  _showError(msg) {
    const el = document.getElementById('drive-import-error');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
  },

  _updateLastSynced() {
    const el = document.getElementById('drive-last-synced');
    if (!el) return;
    this._lastSynced = new Date();
    el.textContent = `Synced ${this._formatTime(this._lastSynced)}`;
  },

  _formatTime(d) {
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  },

  _escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  },
};

window.DrivePanel = DrivePanel;

// ─── Connection status check ──────────────────────────────────────────────────

async function checkDriveStatus() {
  try {
    const res = await fetch('/api/drive/status');
    const data = await res.json();
    _driveConnected = !!data.connected;
    const connectState = document.getElementById('drive-connect-state');
    const fileBrowser = document.getElementById('drive-file-browser');
    if (_driveConnected) {
      connectState.innerHTML = '<div style="font-size:11px;color:#22c55e;font-weight:600;display:flex;align-items:center;gap:6px"><span>●</span> Google Drive connected</div>';
      fileBrowser.style.display = 'block';
      loadDriveRvtFiles();
    } else {
      connectState.innerHTML = `
        <button id="btn-drive-connect" style="background:var(--accent);border:none;color:white;cursor:pointer;font-size:13px;font-weight:600;padding:9px 18px;border-radius:8px;width:100%">Connect Google Drive</button>
        <div style="margin-top:8px;font-size:10px;color:var(--text-muted);text-align:center">Import .rvt files from your Google Drive</div>`;
      fileBrowser.style.display = 'none';
      document.getElementById('btn-drive-connect')?.addEventListener('click', initiateDriveOAuth);
    }
  } catch {
    showDriveError('Failed to check Drive status.');
  }
}

async function initiateDriveOAuth() {
  try {
    const res = await fetch('/api/drive/oauth/authorize');
    const data = await res.json();
    if (data.auth_url) {
      window.location.href = data.auth_url;
    } else {
      showDriveError('Google Drive not configured. Contact your administrator.');
    }
  } catch {
    showDriveError('Failed to initiate Drive connection.');
  }
}

// ─── Load .rvt/.rfa files from Drive ─────────────────────────────────────────

async function loadDriveRvtFiles() {
  const fileList = document.getElementById('drive-file-list');
  fileList.innerHTML = '<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-muted)">Scanning Drive folders…</div>';
  clearDriveError();

  try {
    const res = await fetch('/api/drive/rvt-files');
    const data = await res.json();

    if (!data.files || data.files.length === 0) {
      fileList.innerHTML = '<div style="padding:12px;text-align:center;font-size:12px;color:var(--text-muted)">No .rvt or .rfa files found in Drive.</div>';
      return;
    }

    _driveFiles = data.files;
    renderDriveFileList(data.files);

  } catch (err) {
    showDriveError('Failed to load Drive files: ' + err.message);
  }
}

function renderDriveFileList(files) {
  const fileList = document.getElementById('drive-file-list');

  // Group by parent folder
  const byFolder = {};
  for (const f of files) {
    if (!byFolder[f.parentFolderName]) byFolder[f.parentFolderName] = [];
    byFolder[f.parentFolderName].push(f);
  }

  let html = '';
  for (const [folder, folderFiles] of Object.entries(byFolder)) {
    html += `<div style="font-size:10px;font-weight:700;color:var(--text-muted);padding:4px 2px 2px;letter-spacing:0.05em;text-transform:uppercase">${folder}</div>`;
    for (const f of folderFiles) {
      const isRvt = f.fileType === 'rvt';
      const sizeLabel = f.size ? formatFileSize(f.size) : 'Unknown size';
      const dateLabel = f.modifiedTime ? formatDate(f.modifiedTime) : '';
      const isSelected = _selectedFile?.id === f.id;
      html += `
        <div class="drive-file-item${isSelected ? ' selected' : ''}" data-file-id="${f.id}" onclick="window._selectDriveFile('${f.id}')"
          style="display:flex;align-items:center;gap:8px;padding:7px 8px;margin:2px 0;border-radius:6px;cursor:pointer;border:1px solid ${isSelected ? 'var(--accent)' : 'transparent'};background:${isSelected ? 'rgba(59,130,246,0.08)' : 'var(--bg-panel)'}">
          <span style="font-size:14px">${isRvt ? '📦' : '🔧'}</span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${f.name}</div>
            <div style="font-size:10px;color:var(--text-muted)">${sizeLabel} · ${dateLabel}</div>
          </div>
          ${isRvt ? '<span style="font-size:9px;background:var(--accent);color:white;padding:1px 5px;border-radius:3px;font-weight:700">RVT</span>' : '<span style="font-size:9px;background:var(--text-muted);color:var(--bg-panel);padding:1px 5px;border-radius:3px;font-weight:700">RFA</span>'}
        </div>`;
    }
  }

  fileList.innerHTML = html;

  // Wire click for selection
  fileList.querySelectorAll('.drive-file-item').forEach(el => {
    el.addEventListener('click', () => {
      const fileId = el.getAttribute('data-file-id');
      selectDriveFile(fileId);
    });
  });
}

window._selectDriveFile = function(fileId) {
  selectDriveFile(fileId);
};

function selectDriveFile(fileId) {
  _selectedFile = _driveFiles.find(f => f.id === fileId) || null;

  // Update UI selection state
  document.querySelectorAll('.drive-file-item').forEach(el => {
    el.style.border = el.getAttribute('data-file-id') === fileId ? '1px solid var(--accent)' : '1px solid transparent';
    el.style.background = el.getAttribute('data-file-id') === fileId ? 'rgba(59,130,246,0.08)' : 'var(--bg-panel)';
  });

  const importBtn = document.getElementById('btn-drive-import');
  if (_selectedFile && _selectedFile.fileType === 'rvt') {
    importBtn.disabled = false;
    importBtn.style.opacity = '1';
    importBtn.title = `Import ${_selectedFile.name} from Drive →`;
  } else {
    importBtn.disabled = true;
    importBtn.style.opacity = '0.4';
    importBtn.title = _selectedFile ? '.rfa family files are for reference only' : 'Select a file above to enable';
  }
}

// ─── Import: download from Drive → kick off RVT pipeline ──────────────────────

document.getElementById('btn-drive-import')?.addEventListener('click', async () => {
  if (!_selectedFile || _isDownloading) return;

  _isDownloading = true;
  const progressDiv = document.getElementById('drive-download-progress');
  const progressLabel = document.getElementById('drive-progress-label');
  const progressBar = document.getElementById('drive-progress-bar');
  const importBtn = document.getElementById('btn-drive-import');
  const errorDiv = document.getElementById('drive-import-error');

  progressDiv.style.display = 'block';
  errorDiv.style.display = 'none';
  progressLabel.textContent = `Downloading ${_selectedFile.name}…`;
  progressBar.style.width = '10%';
  importBtn.disabled = true;
  importBtn.textContent = 'Downloading…';

  try {
    // Stream download from Drive
    const xhr = new XMLHttpRequest();
    xhr.open('GET', `/api/drive/files/${_selectedFile.id}/download`, true);
    xhr.responseType = 'blob';

    xhr.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 80);
        progressBar.style.width = pct + '%';
        progressLabel.textContent = `Downloading ${_selectedFile.name}… ${formatFileSize(e.loaded)} / ${formatFileSize(e.total)}`;
      }
    };

    xhr.onload = async () => {
      if (xhr.status !== 200) {
        showDriveError(`Download failed: ${xhr.statusText}`);
        _isDownloading = false;
        importBtn.disabled = false;
        importBtn.textContent = 'Import from Drive →';
        return;
      }

      progressBar.style.width = '80%';
      progressLabel.textContent = 'Sending to Forge…';

      const fileBlob = xhr.response;

      // Read as base64 for transport
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result.split(',')[1]; // strip data:application/octet-stream;base64,

        progressBar.style.width = '90%';
        progressLabel.textContent = 'Starting RVT import…';

        // Kick off RVT import pipeline
        try {
          const res = await fetch('/api/rvt-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: window.currentProjectId || 1,
              file_name: _selectedFile.name,
              file_size_bytes: fileBlob.size,
            })
          });

          if (!res.ok) { this._showError('APS import failed (HTTP ' + res.status + ')'); return; }
          const data = await res.json();

          progressBar.style.width = '100%';
          progressLabel.textContent = 'Import started!';

          // Close APS modal, show RVT progress UI
          document.getElementById('modal-aps').style.display = 'none';

          if (typeof showRvtProgress === 'function') showRvtProgress();
          if (data.run_id) pollRvtStatus(data.run_id);

          toast(`RVT import started: ${_selectedFile.name}`, 'info');

        } catch (err) {
          showDriveError('Import failed: ' + err.message);
          progressDiv.style.display = 'none';
        }

        _isDownloading = false;
        importBtn.disabled = false;
        importBtn.textContent = 'Import from Drive →';
      };

      reader.onerror = () => {
        showDriveError('Failed to read downloaded file.');
        _isDownloading = false;
        importBtn.disabled = false;
        importBtn.textContent = 'Import from Drive →';
      };

      reader.readAsDataURL(fileBlob);
    };

    xhr.onerror = () => {
      showDriveError('Network error during download.');
      _isDownloading = false;
      importBtn.disabled = false;
      importBtn.textContent = 'Import from Drive →';
    };

    xhr.send();

  } catch (err) {
    showDriveError('Download error: ' + err.message);
    progressDiv.style.display = 'none';
    _isDownloading = false;
    importBtn.disabled = false;
    importBtn.textContent = 'Import from Drive →';
  }
});

async function pollRvtStatus(runId) {
  let polls = 0;
  const maxPolls = 120; // ~10 min at 5s intervals

  const interval = setInterval(async () => {
    polls++;
    try {
      const res = await fetch(`/api/rvt-import/${runId}`);
      const data = await res.json();

      const status = data.status;
      const pct = data.progress_pct || 0;

      if (typeof advanceRvtStage === 'function') {
        if (status === 'uploading') advanceRvtStage(0, pct);
        else if (status === 'converting') advanceRvtStage(1, pct);
        else if (status === 'extracting') advanceRvtStage(2, pct);
        else if (status === 'mapping') advanceRvtStage(3, pct);
        else if (status === 'completed') advanceRvtStage(4, 100);
      }

      if (status === 'completed' || status === 'failed') {
        clearInterval(interval);
        if (typeof hideRvtProgress === 'function') hideRvtProgress();

        if (status === 'completed') {
          toast(`RVT import complete: ${data.elements_created || 0} elements mapped`, 'success');
          if (typeof loadAll === 'function') loadAll().then(renderAll);
        } else {
          toast('RVT import failed: ' + (data.error_log || 'Unknown error'), 'error');
        }
      }
    } catch {
      clearInterval(interval);
    }

    if (polls >= maxPolls) {
      clearInterval(interval);
      if (typeof hideRvtProgress === 'function') hideRvtProgress();
      toast('RVT import timed out — check status later', 'warning');
    }
  }, 5000);
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function showDriveError(msg) {
  const el = document.getElementById('drive-import-error');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function clearDriveError() {
  const el = document.getElementById('drive-import-error');
  if (el) { el.style.display = 'none'; }
}

function formatFileSize(bytes) {
  if (!bytes) return '—';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return isoStr.slice(0, 10);
  }
}

// ─── Init — check connection status when APS modal opens ───────────────────────

window.initDriveImport = checkDriveStatus;

// Wire DrivePanel init when the Drive sidebar pane becomes active
document.addEventListener('visibilitychange', () => {
  const pane = document.getElementById('sidebar-pane-drive');
  if (pane && pane.classList.contains('active') && !_driveConnected) {
    DrivePanel.init();
  }
});

// Also init when nav button is clicked (belt-and-suspenders)
const origToggle = window.toggleNavTab;
window.toggleNavTab = function(tabId) {
  if (typeof origToggle === 'function') origToggle.apply(this, arguments);
  if (tabId === 'drive' && !_driveConnected) {
    setTimeout(() => DrivePanel.init(), 100);
  }
};