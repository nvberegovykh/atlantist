/**
 * Owns: Google Drive OAuth 2.0 flow + folder browser API.
 * Does NOT own: user session management, billing, project data.
 * Uses Node.js built-in https — no external packages required.
 */
const router = require('express').Router();
const https = require('https');
const { getSessionByToken } = require('../db/auth');
const { getIntegration, upsertIntegration, updateTokens, disconnectIntegration, getConnectionStatus } = require('../db/user-integrations');
const { saveContextSnapshot, getLatestContextSnapshot } = require('../db/wallt');

// ─── Config ───────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_DRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_DRIVE_CLIENT_SECRET;
const CANONICAL_ORIGIN = process.env.CANONICAL_ORIGIN || 'https://atlantist.cloud';
const REDIRECT_URI  = process.env.GOOGLE_DRIVE_REDIRECT_URI || `${CANONICAL_ORIGIN}/api/drive/oauth/callback`;
const SCOPES        = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_API     = 'https://www.googleapis.com';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_ROOT_ID = '19xjC4G4Bko8ZiN4-xA7947xOpXFkh5jP';

const KEY_SUBFOLDERS = {
  'NDP/79 Winthrop': '1x3wKBifuXihr5YGXsdb728kyHDtl6uCG',
  'Bird House':      '1QSxntVkBZKPXuznuegh8KYEbcxEZeMIH',
};

// ─── Auth middleware ───────────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.cookies?.session_token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  const session = await getSessionByToken(token);
  if (!session) return res.status(401).json({ error: 'Session expired' });
  req.userId = session.user_id;
  next();
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────
function httpsRequest(method, hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method, headers };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ─── Token cache + refresh ───────────────────────────────────────────────────
const tokenCache = new Map(); // userId → { accessToken, expiry }
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

async function getValidToken(userId) {
  const cached = tokenCache.get(userId);
  if (cached && cached.expiry - Date.now() > TOKEN_REFRESH_WINDOW_MS) {
    return cached.accessToken;
  }
  const integration = await getIntegration(userId, 'google_drive');
  if (!integration?.refresh_token) return null;

  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: integration.refresh_token,
    grant_type:    'refresh_token',
  }).toString();

  try {
    const res = await httpsRequest('POST', 'oauth2.googleapis.com', '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (res.status !== 200) {
      console.error('[drive] token refresh failed:', res.data?.error_description);
      tokenCache.delete(userId);
      return null;
    }
    const { access_token, refresh_token, expiry_date } = res.data;
    const expiry = expiry_date || Date.now() + 3600 * 1000;
    tokenCache.set(userId, { accessToken: access_token, expiry });
    await updateTokens(userId, 'google_drive', {
      access_token,
      refresh_token: refresh_token || integration.refresh_token,
      token_type: 'Bearer',
      expires_at: new Date(expiry),
    });
    return access_token;
  } catch (err) {
    console.error('[drive] token refresh error:', err.message);
    tokenCache.delete(userId);
    return null;
  }
}

// ─── Drive API helper ─────────────────────────────────────────────────────────
async function driveApi(path, accessToken) {
  return httpsRequest('GET', 'www.googleapis.com', path,
    { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' });
}

function driveListFiles(accessToken, folderId, { pageSize = 100, pageToken } = {}) {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  let path = `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size,thumbnailLink,webViewLink),nextPageToken&pageSize=${Math.min(pageSize, 500)}&orderBy=folder,name`;
  if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
  return driveApi(path, accessToken);
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/drive/oauth/authorize — initiate OAuth flow
router.get('/oauth/authorize', requireAuth, (req, res) => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google Drive OAuth not configured' });
  }
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: 'code',
    scope:         SCOPES,
    access_type:   'offline',
    prompt:        'consent',
    state:         String(req.userId),
  });
  res.json({ auth_url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

// GET /api/drive/oauth/callback — OAuth2 callback
router.get('/oauth/callback', async (req, res) => {
  const { code, state: userIdStr, error } = req.query;
  if (error) return res.redirect(`/?drive_error=${encodeURIComponent(error)}`);
  if (!code || !userIdStr) return res.redirect('/?drive_error=missing_params');
  const userId = parseInt(userIdStr, 10);
  if (!userId) return res.redirect('/?drive_error=invalid_state');

  const body = new URLSearchParams({
    code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI, grant_type: 'authorization_code',
  }).toString();

  try {
    const resp = await httpsRequest('POST', 'oauth2.googleapis.com', '/token',
      { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (resp.status !== 200) {
      console.error('[drive] token exchange failed:', resp.data);
      return res.redirect('/?drive_error=token_exchange_failed');
    }
    const { access_token, refresh_token, token_type, expires_in, scope } = resp.data;
    const expiry = expires_in ? Date.now() + expires_in * 1000 : null;
    await upsertIntegration(userId, 'google_drive', {
      access_token, refresh_token, token_type: token_type || 'Bearer',
      expires_at: expiry ? new Date(expiry) : null, scope,
    });
    tokenCache.delete(userId);
    res.redirect('/app?panel=drive&connected=1');
  } catch (err) {
    console.error('[drive] oauth callback error:', err.message);
    res.redirect('/?drive_error=token_exchange_failed');
  }
});

// GET /api/drive/status — connection status
router.get('/status', requireAuth, async (req, res) => {
  const status = await getConnectionStatus(req.userId, 'google_drive');
  res.json({ connected: !!status, connected_at: status?.connected_at || null });
});

// POST /api/drive/disconnect — revoke Drive access
router.post('/disconnect', requireAuth, async (req, res) => {
  tokenCache.delete(req.userId);
  await disconnectIntegration(req.userId, 'google_drive');
  res.json({ disconnected: true });
});

// GET /api/drive/folders/:folderId/contents
router.get('/folders/:folderId/contents', requireAuth, async (req, res) => {
  const { folderId } = req.params;
  const { page_size: pageSize, page_token: pageToken } = req.query;

  const accessToken = await getValidToken(req.userId);
  if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected.' });

  try {
    const result = await driveListFiles(accessToken, folderId, {
      pageSize: parseInt(pageSize, 10) || 100, pageToken,
    });
    if (result.status === 401) { tokenCache.delete(req.userId); return res.status(401).json({ error: 'Token expired.' }); }
    if (result.status === 403) return res.status(403).json({ error: 'Access denied.' });
    if (result.status === 404) return res.status(404).json({ error: 'Folder not found.' });
    if (result.status === 429) return res.status(429).json({ error: 'Rate limited.' });
    if (result.status !== 200) return res.status(500).json({ error: 'Drive API error.' });

    const files = (result.data.files || []).map(f => ({
      id: f.id, name: f.name, mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: f.size ? parseInt(f.size, 10) : null,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
      thumbnailUrl: f.thumbnailLink || null,
      webViewUrl: f.webViewLink || null,
      parentId: folderId,
    }));
    res.json({ folderId, files, nextPageToken: result.data.nextPageToken || null });
  } catch (err) {
    console.error('[drive] folder contents error:', err.message);
    res.status(500).json({ error: 'Failed to list folder contents.' });
  }
});

// GET /api/drive/root/contents
router.get('/root/contents', requireAuth, async (req, res) => {
  const { page_size: pageSize, page_token: pageToken } = req.query;
  req.params.folderId = DRIVE_ROOT_ID;
  const { page_size, page_token } = { page_size: pageSize, page_token: pageToken };
  const accessToken = await getValidToken(req.userId);
  if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected.' });
  try {
    const result = await driveListFiles(accessToken, DRIVE_ROOT_ID, {
      pageSize: parseInt(pageSize, 10) || 100, pageToken,
    });
    if (result.status !== 200) return res.status(result.status).json({ error: result.data?.error?.message || 'Drive API error.' });
    const files = (result.data.files || []).map(f => ({
      id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime,
      size: f.size ? parseInt(f.size, 10) : null,
      isFolder: f.mimeType === 'application/vnd.google-apps.folder',
      thumbnailUrl: f.thumbnailLink || null, webViewUrl: f.webViewLink || null,
      parentId: DRIVE_ROOT_ID,
    }));
    res.json({ folderId: DRIVE_ROOT_ID, files, nextPageToken: result.data.nextPageToken || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list root folder contents.' });
  }
});

// GET /api/drive/subfolders
router.get('/subfolders', requireAuth, (req, res) => {
  res.json({
    root: DRIVE_ROOT_ID,
    subfolders: Object.fromEntries(
      Object.entries(KEY_SUBFOLDERS).map(([name, id]) => [name, { id, contents_url: `/api/drive/folders/${id}/contents` }])
    ),
  });
});

// GET /api/drive/rvt-files — scans all key folders for .rvt and .rfa files
router.get('/rvt-files', requireAuth, async (req, res) => {
  const accessToken = await getValidToken(req.userId);
  if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected.' });

  const targetExtensions = new Set(['.rvt', '.rfa']);

  async function scanFolder(folderId, folderName) {
    const rvtFiles = [];
    let pageToken;
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      let path = `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size,parents),nextPageToken&pageSize=500&orderBy=name`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      try {
        const result = await httpsRequest('GET', 'www.googleapis.com', path,
          { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' });
        if (result.status !== 200) break;
        for (const f of (result.data.files || [])) {
          const lc = f.name.toLowerCase();
          if ([...targetExtensions].some(ext => lc.endsWith(ext))) {
            rvtFiles.push({
              id: f.id,
              name: f.name,
              mimeType: f.mimeType,
              modifiedTime: f.modifiedTime,
              size: f.size ? parseInt(f.size, 10) : null,
              parentFolderId: folderId,
              parentFolderName: folderName,
              fileType: lc.endsWith('.rvt') ? 'rvt' : 'rfa',
            });
          }
        }
        pageToken = result.data.nextPageToken || null;
      } catch {
        break;
      }
    } while (pageToken);
    return rvtFiles;
  }

  try {
    const folders = [
      { id: DRIVE_ROOT_ID, name: 'Root' },
      ...Object.entries(KEY_SUBFOLDERS).map(([name, id]) => ({ id, name })),
    ];

    const results = await Promise.allSettled(
      folders.map(f => scanFolder(f.id, f.name))
    );

    const allFiles = results
      .flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));

    res.json({ files: allFiles, scanned_folders: folders.length });

    // Non-blocking: push Drive file list into wallt_context_snapshots
    // Does NOT block the response — any error here is logged only.
    setImmediate(async () => {
      try {
        const projectId = req.query.project_id ? parseInt(req.query.project_id, 10) : null;
        const snapshot = buildDriveContextSnapshot(allFiles, projectId);
        await saveContextSnapshot(req.userId, projectId, snapshot);
      } catch (e) {
        console.warn('[drive] wallt context snapshot write failed (non-fatal):', e.message);
      }
    });

  } catch (err) {
    console.error('[drive] rvt-files error:', err.message);
    res.status(500).json({ error: 'Failed to scan for .rvt files.' });
  }
});

// POST /api/drive/wallt-context — explicit Drive context push into wallt_context_snapshots
// Called by client after any Drive action (import, file pick, folder browse).
// project_id optional. Returns snapshot id.
router.post('/wallt-context', requireAuth, async (req, res) => {
  try {
    const { project_id, files, project_name } = req.body;
    const projectId = project_id ? parseInt(project_id, 10) : null;

    // If files not provided, re-scan rvt-files on demand
    let driveFiles = files;
    if (!driveFiles) {
      const accessToken = await getValidToken(req.userId);
      if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected.' });
      // minimal scan: root folder only
      const q = encodeURIComponent(`'${DRIVE_ROOT_ID}' in parents and trashed = false`);
      const path = `/drive/v3/files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)&pageSize=100&orderBy=modifiedTime+desc`;
      const result = await httpsRequest('GET', 'www.googleapis.com', path,
        { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' });
      driveFiles = result.status === 200
        ? (result.data.files || []).filter(f => f.name.toLowerCase().match(/\.(rvt|rfa|xlsx|xls)$/))
        : [];
    }

    const snapshot = buildDriveContextSnapshot(driveFiles, projectId, project_name);
    const saved = await saveContextSnapshot(req.userId, projectId, snapshot);
    res.status(201).json({ snapshot_id: saved.id, created_at: saved.created_at, file_count: driveFiles.length });
  } catch (err) {
    console.error('[drive] wallt-context push error:', err.message);
    res.status(500).json({ error: 'Failed to push context snapshot.' });
  }
});

// GET /api/drive/wallt-context/latest — read the latest context snapshot for the current user
router.get('/wallt-context/latest', requireAuth, async (req, res) => {
  try {
    const snapshot = await getLatestContextSnapshot(req.userId);
    if (!snapshot) return res.status(404).json({ error: 'No context snapshot found.' });
    res.json(snapshot);
  } catch (err) {
    console.error('[drive] wallt-context read error:', err.message);
    res.status(500).json({ error: 'Failed to read context snapshot.' });
  }
});

// ─── Context snapshot builder ──────────────────────────────────────────────────
// Structures Drive file metadata into a Wallt-consumable context payload.
// Wallt agents read this to understand what BIM assets are available for the project.
function buildDriveContextSnapshot(files, projectId = null, projectName = null) {
  const rvtFiles  = files.filter(f => f.name?.toLowerCase().endsWith('.rvt'));
  const rfaFiles  = files.filter(f => f.name?.toLowerCase().endsWith('.rfa'));
  const xlsFiles  = files.filter(f => f.name?.toLowerCase().match(/\.xlsx?$/));
  const otherFiles = files.filter(f => !f.name?.toLowerCase().match(/\.(rvt|rfa|xlsx?)$/));

  return {
    source: 'google_drive',
    pushed_at: new Date().toISOString(),
    project_id: projectId,
    project_name: projectName || null,
    drive_root: DRIVE_ROOT_ID,
    summary: {
      total_files: files.length,
      rvt_count: rvtFiles.length,
      rfa_count: rfaFiles.length,
      schedule_count: xlsFiles.length,
      other_count: otherFiles.length,
      // Largest RVT — likely the primary model
      primary_model: rvtFiles
        .sort((a, b) => (b.size || 0) - (a.size || 0))[0]
        ? {
            name: rvtFiles[0].name,
            id:   rvtFiles[0].id,
            size_mb: rvtFiles[0].size ? Math.round(rvtFiles[0].size / 1024 / 1024) : null,
            modified: rvtFiles[0].modifiedTime,
            folder: rvtFiles[0].parentFolderName || null,
          }
        : null,
    },
    // Full file list — Wallt agents can reference specific files by id/name
    files: {
      rvt: rvtFiles.map(f => ({ id: f.id, name: f.name, size_mb: f.size ? Math.round(f.size/1024/1024) : null, modified: f.modifiedTime, folder: f.parentFolderName || null })),
      rfa: rfaFiles.map(f => ({ id: f.id, name: f.name, modified: f.modifiedTime })),
      schedules: xlsFiles.map(f => ({ id: f.id, name: f.name, modified: f.modifiedTime })),
    },
  };
}

// GET /api/drive/files/:fileId/download — streams a Drive file to the client
// Large files (50-500MB): chunked transfer with progress, 5-min timeout per chunk
router.get('/files/:fileId/download', requireAuth, async (req, res) => {
  const { fileId } = req.params;
  const accessToken = await getValidToken(req.userId);
  if (!accessToken) return res.status(401).json({ error: 'Google Drive not connected.' });

  // First, fetch file metadata so we can set Content-Length and filename
  try {
    const metaResult = await httpsRequest('GET', 'www.googleapis.com',
      `/drive/v3/files/${fileId}?fields=id,name,mimeType,size`,
      { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' });
    if (metaResult.status !== 200) {
      return res.status(metaResult.status).json({ error: 'File not found or inaccessible.' });
    }
    const { name: fileName, size } = metaResult.data;
    const fileSize = size ? parseInt(size, 10) : null;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    if (fileSize) res.setHeader('Content-Length', fileSize);
    res.setHeader('Accept-Ranges', 'bytes');

    // Stream directly from Drive using https — pipe through Express response
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 300000, // 5-min timeout
    };

    const driveReq = https.request(options, driveRes => {
      // Handle API-level errors (e.g., 403, 404 while streaming)
      if (driveRes.statusCode >= 400) {
        // If headers already sent (streaming already started), we can't send JSON
        // Just abort and log
        console.error(`[drive] download stream error: ${driveRes.statusCode} for file ${fileId}`);
        if (!res.headersSent) res.status(driveRes.statusCode).json({ error: 'Drive file inaccessible.' });
        driveRes.destroy();
        return;
      }
      driveRes.pipe(res);
    });

    driveReq.on('error', err => {
      console.error('[drive] download req error:', err.message);
      if (!res.headersSent) res.status(500).json({ error: 'Download failed.' });
    });

    driveReq.on('timeout', () => {
      console.error('[drive] download timeout for file', fileId);
      driveReq.destroy();
      if (!res.headersSent) res.status(504).json({ error: 'Download timed out.' });
    });

    driveReq.end();

  } catch (err) {
    console.error('[drive] download error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to initiate download.' });
  }
});

module.exports = router;