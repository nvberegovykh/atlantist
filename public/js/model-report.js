/**
 * Trust & Safety: Report Model + Lock Overlay
 * Handles the report modal, submission, "you reported" banner, and model lock overlay.
 */
(function () {
  'use strict';

  const modal = document.getElementById('modal-report-model');
  const lockOverlay = document.getElementById('model-lock-overlay');
  const btnReport = document.getElementById('btn-report-model');
  const closeBtn = document.getElementById('report-modal-close');
  const alreadyBanner = document.getElementById('report-already-banner');
  const formBody = document.getElementById('report-form-body');
  const reasonSelect = document.getElementById('report-reason');
  const descTextarea = document.getElementById('report-description');
  const charCount = document.getElementById('report-char-count');
  const errorDiv = document.getElementById('report-error');
  const submitBtn = document.getElementById('report-submit-btn');

  // Current active project ID — read from app's global state if available
  function getActiveProjectId() {
    if (window.atlantistState && window.atlantistState.activeProjectId) {
      return window.atlantistState.activeProjectId;
    }
    // Fall back to URL param or localStorage
    const params = new URLSearchParams(window.location.search);
    if (params.get('project')) return parseInt(params.get('project'), 10);
    const stored = localStorage.getItem('atlantist_active_project_id');
    return stored ? parseInt(stored, 10) : null;
  }

  // Check lock status on page load and when a project opens
  async function checkLockStatus(projectId) {
    if (!projectId) return;
    try {
      const res = await fetch(`/api/models/${projectId}/lock-status`);
      if (!res.ok) return;
      let data;
      try { data = await res.json(); } catch {
        console.warn(`[model-report] /lock-status returned non-JSON (${res.status})`);
        return;
      }

      const { lock_status, is_owner, my_report } = data;

      // Non-owners seeing a locked model get the full lock overlay
      if (!is_owner && (lock_status === 'under_review' || lock_status === 'banned')) {
        lockOverlay.classList.remove('hidden');
        lockOverlay.style.display = 'flex';
        return;
      }

      // Reporter seeing a model they reported: show banner on next modal open
      if (my_report && my_report.status !== 'dismissed') {
        // Store flag for modal open
        btnReport._alreadyReported = true;
      }

      // Owner whose model is reported: show banner in topbar
      if (is_owner && lock_status !== 'none') {
        showOwnerLockBanner(lock_status);
      }
    } catch (_) { /* non-fatal */ }
  }

  function showOwnerLockBanner(lockStatus) {
    let existing = document.getElementById('model-lock-owner-banner');
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'model-lock-owner-banner';
      existing.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:1000;background:#451a03;border:1px solid #92400e;border-radius:8px;padding:10px 20px;color:#fde68a;font-size:13px;font-weight:500;pointer-events:none';
      document.body.appendChild(existing);
    }
    const labels = {
      reported: 'Your model has been reported and is being reviewed.',
      under_review: 'Your model is under safety review.',
      banned: 'Your model has been removed following a safety review.'
    };
    existing.textContent = labels[lockStatus] || '';
  }

  // Open modal
  btnReport && btnReport?.addEventListener('click', () => {
    const projectId = getActiveProjectId();
    if (!projectId) {
      alert('Open a project first to report it.');
      return;
    }

    if (btnReport._alreadyReported) {
      // Show already-reported state
      alreadyBanner.classList.remove('hidden');
      formBody.classList.add('hidden');
    } else {
      alreadyBanner.classList.add('hidden');
      formBody.classList.remove('hidden');
    }

    // Reset form
    reasonSelect.value = '';
    descTextarea.value = '';
    charCount.textContent = '0 / 30 min';
    errorDiv.classList.add('hidden');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Submit Report';

    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  });

  closeBtn && closeBtn?.addEventListener('click', () => {
    modal.classList.add('hidden');
    modal.style.display = '';
  });

  modal && modal?.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.add('hidden');
      modal.style.display = '';
    }
  });

  // Live char count
  descTextarea && descTextarea?.addEventListener('input', () => {
    const len = descTextarea.value.trim().length;
    charCount.textContent = `${len} / 30 min`;
    charCount.style.color = len >= 30 ? '#22c55e' : 'var(--text-muted)';
  });

  // Submit
  submitBtn && submitBtn?.addEventListener('click', async () => {
    const projectId = getActiveProjectId();
    const reason = reasonSelect.value;
    const description = descTextarea.value.trim();

    errorDiv.classList.add('hidden');

    if (!reason) {
      showError('Please select a reason.');
      return;
    }
    if (description.length < 30) {
      showError('Description must be at least 30 characters.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting…';

    try {
      const res = await fetch(`/api/models/${projectId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason, description })
      });
      if (!res.ok) {
        let msg = 'Submission failed. Try again.';
        try { msg = (await res.json()).error || msg; } catch { msg = `HTTP ${res.status}`; }
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit Report';
        showError(msg);
        return;
      }
      let data;
      try { data = await res.json(); } catch {
        showError('Invalid server response.');
        return;
      }

      // Success — show "you reported" banner
      btnReport._alreadyReported = true;
      alreadyBanner.classList.remove('hidden');
      formBody.classList.add('hidden');
    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit Report';
      showError('Network error. Please try again.');
    }
  });

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.classList.remove('hidden');
  }

  // Hook into project open events. The app broadcasts 'atlantist:project:open' when a project loads.
  window.addEventListener('atlantist:project:open', (e) => {
    const projectId = e.detail?.project_id;
    if (projectId) checkLockStatus(projectId);
  });

  // Also check on initial load if a project is already open
  window.addEventListener('DOMContentLoaded', () => {
    const projectId = getActiveProjectId();
    if (projectId) checkLockStatus(projectId);
  });

  // Expose for external triggering (e.g., app.js calls this after opening a project)
  window.checkProjectLockStatus = checkLockStatus;
})();
