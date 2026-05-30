/**
 * Atlantist Community Forum UI
 * Phase 25 — authenticated threads, AI support, auto-moderation
 */
const FORUM_CATEGORIES = [
  { id: 'issues',    emoji: '🐛', label: 'Issues',    color: '#e74c3c' },
  { id: 'features',  emoji: '✨', label: 'Features',  color: '#9b59b6' },
  { id: 'updates',   emoji: '📢', label: 'Updates',   color: '#3498db' },
  { id: 'support',   emoji: '💬', label: 'Support',   color: '#2ecc71' },
  { id: 'efficiency',emoji: '⚡', label: 'Efficiency', color: '#f39c12' },
  { id: 'general',   emoji: '🌍', label: 'General',   color: '#7f8c8d' },
];

const STATUS_MAP = {
  open:       { label: 'Open',        color: '#3498db', bg: 'rgba(52,152,219,0.15)' },
  in_progress:{ label: 'In Progress', color: '#f39c12', bg: 'rgba(243,156,18,0.15)' },
  resolved:   { label: 'Resolved',    color: '#2ecc71', bg: 'rgba(46,204,113,0.15)' },
  wont_fix:   { label: "Won't Fix",   color: '#95a5a6', bg: 'rgba(149,165,166,0.15)' },
};

let forumState = {
  threads: [],
  total: 0,
  page: 1,
  category: null,
  status: null,
  search: '',
  activeThread: null,
  loading: false,
};

function getCat(id) { return FORUM_CATEGORIES.find(c => c.id === id) || FORUM_CATEGORIES[5]; }
function getStatus(s) { return STATUS_MAP[s] || STATUS_MAP.open; }

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(ts) {
  if (!ts) return 'just now';
  const diff = (Date.now() - new Date(ts)) / 1000;
  if (diff < 60)   return 'just now';
  if (diff < 3600) return Math.floor(diff/60) + 'm ago';
  if (diff < 86400) return Math.floor(diff/3600) + 'h ago';
  return Math.floor(diff/86400) + 'd ago';
}

// ─── Render helpers ────────────────────────────────────────────────────────────

function renderThreadCard(t) {
  const cat = getCat(t.category);
  const st  = getStatus(t.status);
  const pinned = t.pinned ? '<span style="font-size:11px;color:#f39c12;margin-left:4px">📌</span>' : '';
  const team = t.is_team_post ? '<span class="forum-badge-team">Team</span>' : '';
  const ai = t.ai_response_count > 0
    ? `<span class="forum-badge-ai">AI</span>`
    : '';

  return `
  <div class="forum-thread-card" data-id="${t.id}" onclick="openThreadDetail(${t.id})" style="
    padding:14px 16px;border-bottom:1px solid var(--border);
    cursor:pointer;transition:background 0.12s">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <span style="font-size:13px">${cat.emoji}</span>
      <span style="font-size:11px;font-weight:600;color:${cat.color};letter-spacing:0.04em">${cat.label.toUpperCase()}</span>
      ${team}${ai}
      <span style="margin-left:auto;display:flex;align-items:center;gap:6px">
        <span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:600;background:${st.bg};color:${st.color}">${st.label}</span>
        ${pinned}
      </span>
    </div>
    <div style="font-size:14px;font-weight:600;color:var(--text);margin-bottom:4px">${esc(t.title)}</div>
    <div style="font-size:12px;color:var(--text-muted);display:flex;align-items:center;gap:12px">
      <span>${esc(t.author_name || t.author_email || 'Unknown')}</span>
      <span>${t.reply_count} repl${t.reply_count === 1 ? 'y' : 'ies'}</span>
      <span>${timeAgo(t.last_reply_at || t.created_at)}</span>
    </div>
  </div>`;
}

function renderStatusBadge(status) {
  const s = getStatus(status);
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:10px;font-size:11px;font-weight:600;background:${s.bg};color:${s.color}">${s.label}</span>`;
}

function renderReply(r, depth = 0) {
  const team = r.is_team_post ? '<span class="forum-badge-team">Team</span>' : '';
  const indent = Math.min(depth, 3) * 24;
  return `
  <div class="forum-reply" data-id="${r.id}" style="margin-left:${indent}px;padding:12px 0;border-bottom:1px solid rgba(255,255,255,0.05)">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <div style="width:28px;height:28px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:white">${(r.author_name || '?')[0].toUpperCase()}</div>
      <span style="font-size:13px;font-weight:600;color:var(--text)">${esc(r.author_name || r.author_email || 'Unknown')}</span>
      ${team}
      <span style="font-size:11px;color:var(--text-muted);margin-left:auto">${timeAgo(r.created_at)}</span>
    </div>
    <div style="font-size:13px;color:var(--text);line-height:1.6;white-space:pre-wrap">${esc(r.body)}</div>
  </div>`;
}

// ─── Modal open / close ─────────────────────────────────────────────────────────

let forumModal, forumListView, forumDetailView, newThreadForm;

function openForumModal() {
  if (!forumModal) return;
  forumModal.style.display = 'flex';
  loadForumThreads();
}

function closeForumModal() {
  if (forumModal) {
    forumModal.style.display = 'none';
    forumModal.classList.add('hidden');
    showForumList();
    forumState.activeThread = null;
  }
}

function showForumList() {
  if (forumListView) forumListView.style.display = 'flex';
  if (forumDetailView) forumDetailView.style.display = 'none';
  if (newThreadForm) newThreadForm.style.display = 'none';
}

function showForumDetail() {
  if (forumListView) forumListView.style.display = 'none';
  if (forumDetailView) forumDetailView.style.display = 'flex';
  if (newThreadForm) newThreadForm.style.display = 'none';
}

function showNewThreadForm() {
  if (forumListView) forumListView.style.display = 'none';
  if (forumDetailView) forumDetailView.style.display = 'none';
  if (newThreadForm) newThreadForm.style.display = 'flex';
}

// ─── Thread loading ─────────────────────────────────────────────────────────────

async function loadForumThreads(opts = {}) {
  if (opts.category !== undefined) forumState.category = opts.category;
  if (opts.status !== undefined)   forumState.status = opts.status;
  if (opts.search !== undefined)   forumState.search = opts.search;
  if (opts.page !== undefined)     forumState.page = opts.page;

  forumState.loading = true;
  renderForumLoading();

  try {
    const params = new URLSearchParams({
      page: forumState.page,
      limit: 20,
    });
    if (forumState.category) params.set('category', forumState.category);
    if (forumState.status)   params.set('status', forumState.status);
    if (forumState.search)   params.set('search', forumState.search);

    const res = await authApi('GET', `/api/forum/threads?${params}`);
    forumState.threads = res.threads;
    forumState.total = res.total;
    renderForumList();
  } catch (e) {
    renderForumError('Failed to load threads: ' + e.message);
  } finally {
    forumState.loading = false;
  }
}

function renderForumLoading() {
  const container = document.getElementById('forum-threads-list');
  if (container) container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">Loading…</div>';
}

function renderForumError(msg) {
  const container = document.getElementById('forum-threads-list');
  if (container) container.innerHTML = `<div style="padding:32px;text-align:center;color:#e74c3c">${esc(msg)}</div>`;
}

function renderForumList() {
  const container = document.getElementById('forum-threads-list');
  if (!container) return;

  const searchInput = document.getElementById('forum-search-input');
  const selectedCat = document.getElementById('forum-cat-filter');

  if (!forumState.threads.length) {
    container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">No threads yet. Be the first to post!</div>';
    return;
  }

  container.innerHTML = forumState.threads.map(renderThreadCard).join('');

  // Pagination
  const totalPages = Math.ceil(forumState.total / 20);
  let pagHTML = '';
  if (totalPages > 1) {
    pagHTML = `<div style="padding:12px;display:flex;gap:8px;align-items:center;justify-content:center;border-top:1px solid var(--border)">`;
    if (forumState.page > 1) {
      pagHTML += `<button onclick="gotoForumPage(${forumState.page - 1})" style="padding:6px 12px;background:var(--bg-hover);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;cursor:pointer">← Prev</button>`;
    }
    pagHTML += `<span style="font-size:12px;color:var(--text-muted)">Page ${forumState.page} of ${totalPages}</span>`;
    if (forumState.page < totalPages) {
      pagHTML += `<button onclick="gotoForumPage(${forumState.page + 1})" style="padding:6px 12px;background:var(--bg-hover);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;cursor:pointer">Next →</button>`;
    }
    pagHTML += `</div>`;
  }
  container.innerHTML += pagHTML;
}

// Global functions for onclick
window.openForumDetail = openThreadDetail;
window.gotoForumPage = (p) => loadForumThreads({ page: p });
window.filterForumCategory = (cat) => loadForumThreads({ category: cat === 'all' ? null : cat, page: 1 });
window.filterForumStatus = (s) => loadForumThreads({ status: s === 'all' ? null : s, page: 1 });
window.searchForum = () => {
  const q = document.getElementById('forum-search-input')?.value?.trim();
  loadForumThreads({ search: q || '', page: 1 });
};

// ─── Thread detail ─────────────────────────────────────────────────────────────

async function openThreadDetail(id) {
  forumState.activeThread = id;
  showForumDetail();

  const container = document.getElementById('forum-detail-content');
  if (container) container.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted)">Loading…</div>';

  try {
    const res = await authApi('GET', `/api/forum/threads/${id}`);
    renderThreadDetail(res.thread, res.replies, res.statusHistory);
  } catch (e) {
    if (container) container.innerHTML = `<div style="padding:32px;color:#e74c3c">Failed to load thread: ${esc(e.message)}</div>`;
  }
}

function renderThreadDetail(thread, replies, statusHistory) {
  const container = document.getElementById('forum-detail-content');
  if (!container) return;

  const cat = getCat(thread.category);

  container.innerHTML = `
    <div style="padding:16px 20px;border-bottom:1px solid var(--border)">
      <button onclick="showForumList(); forumState.activeThread=null" style="background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:12px;margin-bottom:12px">← Back to threads</button>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:14px">${cat.emoji}</span>
        <span style="font-size:11px;font-weight:600;color:${cat.color}">${cat.label.toUpperCase()}</span>
        ${renderStatusBadge(thread.status)}
        ${thread.pinned ? '<span style="font-size:11px;color:#f39c12">📌 Pinned</span>' : ''}
        ${thread.locked ? '<span style="font-size:11px;color:#e74c3c">🔒 Locked</span>' : ''}
      </div>
      <h2 style="font-size:18px;font-weight:700;color:var(--text);margin:0 0 8px">${esc(thread.title)}</h2>
      <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted)">
        <div style="width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:white">${(thread.author_name || '?')[0].toUpperCase()}</div>
        <span style="font-weight:600;color:var(--text)">${esc(thread.author_name || thread.author_email)}</span>
        ${thread.is_team_post ? '<span class="forum-badge-team">Team</span>' : ''}
        <span>·</span>
        <span>${timeAgo(thread.created_at)}</span>
        ${thread.body ? `<span>·</span><span style="max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(thread.body).substring(0, 80)}…</span>` : ''}
      </div>
    </div>

    <div id="forum-replies-list" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:0">
      ${replies.length === 0 ? '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px">No replies yet. Be first!</div>' : replies.map(r => renderReply(r, r.depth || 0)).join('')}
    </div>

    <div style="padding:16px 20px;border-top:1px solid var(--border)">
      ${thread.locked
        ? '<div style="text-align:center;color:var(--text-muted);font-size:13px">🔒 This thread is locked</div>'
        : `<div style="display:flex;flex-direction:column;gap:10px">
            <textarea id="reply-body" placeholder="Write a reply… (Markdown supported)" style="width:100%;min-height:80px;padding:10px;background:var(--bg-viewport);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:13px;resize:vertical;font-family:inherit"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:8px">
              <button onclick="submitReply(${thread.id})" style="padding:8px 20px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:13px;font-weight:600;cursor:pointer">Post Reply</button>
            </div>
          </div>`
      }
    </div>`;
}

window.submitReply = async (threadId) => {
  const body = document.getElementById('reply-body')?.value?.trim();
  if (!body) return;

  try {
    const res = await authApi('POST', `/api/forum/threads/${threadId}/reply`, { body });
    document.getElementById('reply-body').value = '';
    // Reload thread to show new reply
    openThreadDetail(threadId);
  } catch (e) {
    if (e.message.includes('flagged')) {
      alert('⚠️ Your reply was flagged by auto-moderation: ' + e.message);
    } else {
      alert('Failed to post reply: ' + e.message);
    }
  }
};

// ─── New thread form ───────────────────────────────────────────────────────────

function openNewThread() {
  showNewThreadForm();
}

window.submitNewThread = async () => {
  const title = document.getElementById('forum-new-title')?.value?.trim();
  const body  = document.getElementById('forum-new-body')?.value?.trim();
  const catEl = document.getElementById('forum-new-category');
  const category = catEl?.value || 'general';

  if (!title) {
    alert('Title is required');
    return;
  }

  try {
    const res = await authApi('POST', '/api/forum/threads', { title, body, category });
    showForumList();
    openThreadDetail(res.thread.id);
  } catch (e) {
    if (e.message.includes('flagged')) {
      alert('⚠️ Content flagged by auto-moderation: ' + e.message);
    } else {
      alert('Failed to create thread: ' + e.message);
    }
  }
};

window.cancelNewThread = showForumList;

// ─── WebSocket ──────────────────────────────────────────────────────────────────

window.wsHandlers = window.wsHandlers || {};

window.wsHandlers['forum.thread_created'] = (data) => {
  if (forumState.category === null && forumState.page === 1) {
    // Prepend to list if on first page, no filter
    forumState.threads.unshift(data.thread);
    if (forumState.threads.length > 20) forumState.threads.pop();
    renderForumList();
  }
  // Toast notification
  if (document.getElementById('modal-forum')?.style?.display !== 'none') {
    toast(`New thread: ${data.thread.title.substring(0, 50)}…`, 'info');
  }
};

window.wsHandlers['forum.reply_created'] = (data) => {
  if (forumState.activeThread === data.reply.thread_id) {
    const list = document.getElementById('forum-replies-list');
    if (list) {
      list.insertAdjacentHTML('beforeend', renderReply(data.reply, data.reply.depth || 0));
      list.scrollTop = list.scrollHeight;
    }
  }
};

window.wsHandlers['forum.status_changed'] = (data) => {
  if (forumState.activeThread === data.threadId) {
    // Update status badge
    const badge = document.querySelector('.forum-detail-status-badge');
    if (badge) badge.outerHTML = renderStatusBadge(data.status);
  }
  // Update in list if visible
  const card = document.querySelector(`.forum-thread-card[data-id="${data.threadId}"]`);
  if (card) {
    const badge = card.querySelector('.forum-status-chip');
    if (badge) badge.outerHTML = renderStatusBadge(data.status);
  }
};

// ─── Init ───────────────────────────────────────────────────────────────────────

function initForum() {
  forumModal = document.getElementById('modal-forum');
  forumListView = document.getElementById('forum-list-view');
  forumDetailView = document.getElementById('forum-detail-view');
  newThreadForm = document.getElementById('forum-new-thread-view');

  // Toolbar button
  document.getElementById('btn-forum')?.addEventListener('click', openForumModal);

  // Tab button
  document.getElementById('btn-forum-tab')?.addEventListener('click', openForumModal);

  // Search on Enter
  document.getElementById('forum-search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchForum();
  });

  // ESC closes modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('modal-forum')?.style?.display !== 'none') {
      closeForumModal();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initForum);
} else {
  initForum();
}