/* ============================================================
   Atlantist — Mobile responsive layer (Phase 24)
   Owns: bottom sheet open/close/snap, touch handlers for long-press
         and swipe, mobile bottom bar routing, node editor mobile toggles.
   Does NOT own: BIM geometry, Three.js rendering, WebSocket, DAG.
   ============================================================ */

(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────────────── */
  const SNAP_PEEK  = 'bsheet--peek';
  const SNAP_HALF  = 'bsheet--half';
  const SNAP_FULL  = 'bsheet--full';
  const SNAP_HIDDEN = 'bsheet--hidden';

  /* Breakpoint at which mobile bottom bar + bottom sheets activate */
  const MOBILE_BP = 600;

  /* Long-press threshold (ms) */
  const LONG_PRESS_MS = 400;

  /* ── State ──────────────────────────────────────────────────────── */
  let activeSheet = null; // 'tools' | 'props' | 'craft' | null

  /* ── Helpers ────────────────────────────────────────────────────── */
  function isMobile() {
    return window.innerWidth <= MOBILE_BP;
  }

  function getSheet(id) {
    return document.getElementById('bsheet-' + id);
  }

  function setSnap(sheet, snap) {
    [SNAP_PEEK, SNAP_HALF, SNAP_FULL, SNAP_HIDDEN].forEach(c => sheet.classList.remove(c));
    sheet.classList.add(snap);
  }

  /* ── Backdrop ───────────────────────────────────────────────────── */
  const backdrop = document.getElementById('bsheet-backdrop');

  function showBackdrop(onlyOnFull) {
    if (!onlyOnFull || activeSheet) {
      backdrop.classList.add('active');
    }
  }

  function hideBackdrop() {
    backdrop.classList.remove('active');
  }

  if (backdrop) {
    backdrop?.addEventListener('click', () => closeAllSheets());
    backdrop?.addEventListener('touchend', (e) => { e.preventDefault(); closeAllSheets(); });
  }

  /* ── Open / close sheets ────────────────────────────────────────── */
  function openSheet(id, snap) {
    snap = snap || SNAP_HALF;

    // Close previously open sheet if different
    if (activeSheet && activeSheet !== id) {
      const prev = getSheet(activeSheet);
      if (prev) setSnap(prev, SNAP_HIDDEN);
    }

    activeSheet = id;
    const sheet = getSheet(id);
    if (!sheet) return;

    setSnap(sheet, snap);
    // Show backdrop only when half/full
    if (snap === SNAP_FULL || snap === SNAP_HALF) {
      showBackdrop();
    } else {
      hideBackdrop();
    }

    // Update mobile bottom bar active state
    syncBottomBarActive(id);
  }

  function closeSheet(id) {
    const sheet = getSheet(id);
    if (!sheet) return;
    setSnap(sheet, SNAP_HIDDEN);
    if (activeSheet === id) activeSheet = null;
    hideBackdrop();
    syncBottomBarActive(null);
  }

  function closeAllSheets() {
    ['tools', 'props', 'craft'].forEach(id => {
      const s = getSheet(id);
      if (s) setSnap(s, SNAP_HIDDEN);
    });
    activeSheet = null;
    hideBackdrop();
    syncBottomBarActive(null);
  }

  function syncBottomBarActive(openId) {
    const map = { tools: 'mob-btn-tools', props: 'mob-btn-props', craft: 'mob-btn-craft' };
    Object.entries(map).forEach(([id, btnId]) => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.classList.toggle('active', id === openId);
    });
  }

  /* ── Close button listeners ─────────────────────────────────────── */
  function wireCloseBtn(sheetId) {
    const btn = document.getElementById('bsheet-' + sheetId + '-close');
    if (btn) btn?.addEventListener('click', () => closeSheet(sheetId));
  }
  wireCloseBtn('tools');
  wireCloseBtn('props');
  wireCloseBtn('craft');

  /* ── Bottom sheet drag-to-snap ──────────────────────────────────── */
  function initDragSnap(sheetId, handleId) {
    const sheet = document.getElementById('bsheet-' + sheetId);
    const handle = document.getElementById(handleId);
    if (!sheet || !handle) return;

    let startY = 0;
    let startTranslateY = 0;
    let isDragging = false;

    function getTranslateY(el) {
      const t = window.getComputedStyle(el).transform;
      if (!t || t === 'none') return 0;
      const m = t.match(/matrix.*\((.+)\)/);
      if (!m) return 0;
      const vals = m[1].split(',');
      return parseFloat(vals[5]) || 0;
    }

    handle?.addEventListener('touchstart', (e) => {
      startY = e.touches[0].clientY;
      startTranslateY = getTranslateY(sheet);
      isDragging = true;
      // Remove transition for live drag
      sheet.style.transition = 'none';
    }, { passive: true });

    handle?.addEventListener('touchmove', (e) => {
      if (!isDragging) return;
      const dy = e.touches[0].clientY - startY;
      const newY = Math.max(0, startTranslateY + dy);
      sheet.style.transform = `translateY(${newY}px)`;
    }, { passive: true });

    handle?.addEventListener('touchend', (e) => {
      if (!isDragging) return;
      isDragging = false;
      sheet.style.transition = '';
      sheet.style.transform = '';

      const endY = e.changedTouches[0].clientY;
      const dy = endY - startY;
      const vh = window.innerHeight;

      // Snap logic: positive dy = dragging down (closing), negative = up (expanding)
      if (dy > vh * 0.25) {
        // Dragged down > 25% viewport → close
        closeSheet(sheetId);
      } else if (dy > vh * 0.1) {
        // Dragged down slightly → peek or half depending on current state
        const cur = sheet.classList.contains(SNAP_FULL) ? SNAP_HALF :
                    sheet.classList.contains(SNAP_HALF) ? SNAP_PEEK : SNAP_HIDDEN;
        setSnap(sheet, cur);
        if (cur === SNAP_HIDDEN) { activeSheet = null; hideBackdrop(); }
        else if (cur === SNAP_PEEK) { hideBackdrop(); }
      } else if (dy < -vh * 0.1) {
        // Dragged up > 10% → expand
        const cur = sheet.classList.contains(SNAP_PEEK) ? SNAP_HALF :
                    sheet.classList.contains(SNAP_HALF) ? SNAP_FULL : SNAP_FULL;
        setSnap(sheet, cur);
        showBackdrop();
      }
      // else: small movement, stay in place
    }, { passive: true });
  }

  initDragSnap('tools', 'bsheet-tools-handle');
  initDragSnap('props', 'bsheet-props-handle');
  initDragSnap('craft', 'bsheet-craft-handle');

  /* ── Mobile bottom bar routing ──────────────────────────────────── */
  function wireBottomBar() {
    const mobTools = document.getElementById('mob-btn-tools');
    const mobLevels = document.getElementById('mob-btn-levels');
    const mobView = document.getElementById('mob-btn-view');
    const mobProps = document.getElementById('mob-btn-props');
    const mobIssues = document.getElementById('mob-btn-issues');

    if (mobTools) {
      mobTools?.addEventListener('click', () => {
        if (activeSheet === 'tools') closeSheet('tools');
        else openSheet('tools', SNAP_HALF);
      });
    }

    if (mobLevels) {
      mobLevels?.addEventListener('click', () => {
        // On mobile, open the levels sheet or trigger the desktop levels button
        if (typeof AtlantistMobile !== 'undefined' && AtlantistMobile.isMobile()) {
          // Try to open via the levels panel trigger
          const levelsBtn = document.getElementById('btn-levels');
          if (levelsBtn) levelsBtn.click();
          else openSheet('tools', SNAP_HALF); // fallback: tools sheet
        } else {
          const levelsBtn = document.getElementById('btn-levels');
          if (levelsBtn) levelsBtn.click();
        }
      });
    }

    if (mobView) {
      mobView?.addEventListener('click', () => {
        // Cycle through views: 3D → Plan → Section → RCP → 3D
        const views = ['btn-3d', 'btn-plan', 'btn-section', 'btn-rcp'];
        const active = views.find(id => document.getElementById(id)?.classList.contains('active'));
        const idx = views.indexOf(active);
        const next = views[(idx + 1) % views.length];
        const nextBtn = document.getElementById(next);
        if (nextBtn) nextBtn.click();

        // Update the bottom bar label to match
        const viewLabel = nextBtn ? nextBtn.textContent : '3D';
        const labelEl = document.getElementById('mob-view-label');
        if (labelEl) labelEl.textContent = viewLabel;
      });
    }

    if (mobProps) {
      mobProps?.addEventListener('click', () => {
        if (activeSheet === 'props') closeSheet('props');
        else {
          mirrorPropsToSheet();
          openSheet('props', SNAP_HALF);
        }
      });
    }

    if (mobIssues) {
      mobIssues?.addEventListener('click', () => {
        const issuesBtn = document.getElementById('btn-issues') || document.querySelector('[data-tab="issues"]');
        if (issuesBtn) issuesBtn.click();
        else {
          const navIssues = document.querySelector('.nav-rail-btn[data-pane="issues"]');
          if (navIssues) navIssues.click();
        }
      });
    }

    const mobCraft = document.getElementById('mob-btn-craft');
    if (mobCraft) {
      mobCraft?.addEventListener('click', () => {
        if (activeSheet === 'craft') closeSheet('craft');
        else MobileCraft.openSheet();
      });
    }
  }

  /* ── BUG-G10: Mobile toolbar FAB — opens tools sheet ─────────── */
  function wireMobileToolbarFAB() {
    const fab = document.getElementById('mobile-toolbar-fab');
    if (fab) {
      fab?.addEventListener('click', () => {
        if (activeSheet === 'tools') closeSheet('tools');
        else openSheet('tools', SNAP_HALF);
      });
    }
  }
  wireMobileToolbarFAB();

  /* Mirror desktop properties panel content into bottom sheet */
  function mirrorPropsToSheet() {
    const propsPanel = document.querySelector('.properties-panel');
    const sheetBody = document.getElementById('bsheet-props-body');
    if (!propsPanel || !sheetBody) return;
    // Live-clone the properties panel content (not the panel itself)
    sheetBody.innerHTML = propsPanel.innerHTML;
  }

  wireBottomBar();

  /* When an element is selected in the BIM, auto-open props sheet on mobile */
  document.addEventListener('atlantist:element:selected', () => {
    if (!isMobile()) return;
    mirrorPropsToSheet();
    if (activeSheet !== 'props') openSheet('props', SNAP_HALF);
  });

  /* ── Tool sheet button routing ──────────────────────────────────── */
  const toolMap = {
    wall:     'btn-add-wall',
    column:   'btn-add-column',
    door:     'btn-add-door',
    window:   'btn-add-window',
    stair:    'btn-add-stair',
    floor:    'btn-add-floor',
    ceiling:  'btn-add-ceiling',
    room:     'btn-add-room',
    grid:     'btn-add-grid',
    annotate: 'btn-annotation',
    section:  'btn-add-section-line',
    curved:   'btn-add-curved-surface',
  };

  const sheetToolsBody = document.getElementById('bsheet-tools-body');
  if (sheetToolsBody) {
    sheetToolsBody?.addEventListener('click', (e) => {
      const btn = e.target.closest('.bsheet-tool-btn');
      if (!btn) return;
      const tool = btn.dataset.tool;
      const targetId = toolMap[tool];
      if (targetId) {
        const desktopBtn = document.getElementById(targetId);
        if (desktopBtn) desktopBtn.click();
      }
      // Close sheet after selecting tool
      closeSheet('tools');
    });
  }

  /* ── Long-press handler factory ─────────────────────────────────── */
  /*
    Attaches long-press to elements matching selector.
    callback(element) fires after LONG_PRESS_MS of sustained touch.
    Cancels on touchmove > 10px.
  */
  function addLongPress(selector, callback) {
    let timer = null;
    let startX = 0;
    let startY = 0;

    document.addEventListener('touchstart', (e) => {
      const el = e.target.closest(selector);
      if (!el) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      timer = setTimeout(() => {
        timer = null;
        callback(el, e);
      }, LONG_PRESS_MS);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!timer) return;
      const dx = Math.abs(e.touches[0].clientX - startX);
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dx > 10 || dy > 10) {
        clearTimeout(timer);
        timer = null;
      }
    }, { passive: true });

    document.addEventListener('touchend', () => {
      if (timer) { clearTimeout(timer); timer = null; }
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
      if (timer) { clearTimeout(timer); timer = null; }
    }, { passive: true });
  }

  /* Long-press toolbar buttons → open tool group popover / sheet */
  addLongPress('.tool-btn', (btn) => {
    const toolId = btn.id;
    // Map tool buttons to sheets or panels
    const GROUP_DRAW = ['btn-add-wall','btn-add-column','btn-add-door','btn-add-window','btn-add-stair','btn-add-roof'];
    if (GROUP_DRAW.includes(toolId)) {
      openSheet('tools', SNAP_HALF);
    }
  });

  /* Long-press viewport tabs → open panel */
  addLongPress('.nav-rail-btn', (btn) => {
    if (!isMobile()) return;
    btn.click(); // activate the pane
  });

  /* Long-press project cards on entry screen → show context menu */
  addLongPress('.entry-card', (card) => {
    const menuBtn = card.querySelector('.entry-card-menu-btn');
    if (menuBtn) menuBtn.click();
  });

  /* ── Swipe on viewport tabs ─────────────────────────────────────── */
  /*
    Horizontal swipe on the BIM viewport cycles views on mobile.
    Only active when no sheet is open (to avoid conflict with sheet drag).
  */
  (function initViewSwipe() {
    const viewport = document.getElementById('viewport-area') ||
                     document.querySelector('.viewport-area') ||
                     document.querySelector('#viewport canvas');
    if (!viewport) return;

    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeActive = false;

    const VIEWS = ['btn-3d', 'btn-plan', 'btn-section', 'btn-rcp'];

    viewport?.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      swipeStartX = e.touches[0].clientX;
      swipeStartY = e.touches[0].clientY;
      swipeActive = true;
    }, { passive: true });

    viewport?.addEventListener('touchend', (e) => {
      if (!swipeActive || activeSheet) return;
      swipeActive = false;
      const dx = e.changedTouches[0].clientX - swipeStartX;
      const dy = e.changedTouches[0].clientY - swipeStartY;
      // Only horizontal swipes (dx dominant, > 60px)
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

      const activeView = VIEWS.find(id => document.getElementById(id)?.classList.contains('active'));
      const idx = VIEWS.indexOf(activeView);
      let next;
      if (dx < 0) {
        // Swipe left → next view
        next = VIEWS[(idx + 1) % VIEWS.length];
      } else {
        // Swipe right → prev view
        next = VIEWS[(idx - 1 + VIEWS.length) % VIEWS.length];
      }
      const nextBtn = document.getElementById(next);
      if (nextBtn) nextBtn.click();

      // Update swipe dots — viewport-manager exposes updater on window
      if (typeof window._vpUpdateSwipeDots === 'function') {
        // Map btn id to view name for dot update
        const viewMap = { 'btn-3d': '3d', 'btn-plan': 'plan', 'btn-section': 'elevation-x', 'btn-rcp': 'elevation-y' };
        window._vpUpdateSwipeDots(viewMap[next] || '3d');
      }
    }, { passive: true });

    viewport?.addEventListener('touchcancel', () => { swipeActive = false; }, { passive: true });
  })();

  /* ── Node editor mobile toggles ─────────────────────────────────── */
  function initNodeEditorMobile() {
    const neContainer = document.getElementById('ne-container');
    if (!neContainer) return;

    // Create toggle buttons if not already in DOM
    let palBtn = document.getElementById('ne-mobile-palette-btn');
    let propsBtn = document.getElementById('ne-mobile-props-btn');

    if (!palBtn) {
      palBtn = document.createElement('button');
      palBtn.id = 'ne-mobile-palette-btn';
      palBtn.setAttribute('aria-label', 'Toggle node palette');
      palBtn.innerHTML = '☰ Nodes';
      neContainer.appendChild(palBtn);
    }

    if (!propsBtn) {
      propsBtn = document.createElement('button');
      propsBtn.id = 'ne-mobile-props-btn';
      propsBtn.setAttribute('aria-label', 'Toggle node properties');
      propsBtn.innerHTML = 'Props ⚙';
      neContainer.appendChild(propsBtn);
    }

    palBtn?.addEventListener('click', () => {
      const pal = document.getElementById('ne-palette');
      if (!pal) return;
      pal.classList.toggle('ne-open');
    });

    propsBtn?.addEventListener('click', () => {
      const props = document.getElementById('ne-properties');
      if (!props) return;
      props.classList.toggle('ne-open');
    });
  }

  // Init when node editor tab is opened
  document.addEventListener('atlantist:tab:opened', (e) => {
    if (e.detail?.tab === 'scripts' || e.detail?.tab === 'node-editor') {
      initNodeEditorMobile();
    }
  });

  /* ── Resize: adjust bottom bar + sheet visibility ───────────────── */
  function onResize() {
    if (!isMobile() && activeSheet) {
      // On resize to desktop, close sheets — they're not needed
      closeAllSheets();
    }
  }

  window.addEventListener('resize', onResize, { passive: true });

  /* ── Mobile Crafting Module ─────────────────────────────────────── */
  /*
    Owns: material picker render, recipe panel slide-in, quantity stepper,
          spawn-in-model flow, spawn toast.
    Does NOT own: CraftUI state, API calls, desktop workbench layout.
    Depends on: window.CraftUI (crafting-ui.js, loaded on same page).
  */
  const MobileCraft = (function () {
    let _selectedThingId = null;
    let _selectedRecipeId = null;
    let _qty = 1;

    /* Show spawn toast then collapse sheet to peek */
    function showSpawnToast(msg) {
      let toast = document.getElementById('bcraft-spawn-toast');
      if (!toast) {
        toast = document.createElement('div');
        toast.id = 'bcraft-spawn-toast';
        document.body.appendChild(toast);
      }
      toast.textContent = msg || '✓ Spawned in model';
      toast.classList.add('visible');
      setTimeout(() => toast.classList.remove('visible'), 2400);
    }

    /* Render a single material card */
    function renderMaterialCard(thing) {
      const card = document.createElement('button');
      card.className = 'bcraft-material-card';
      card.setAttribute('role', 'listitem');
      card.setAttribute('aria-label', thing.name || 'Material');
      card.dataset.thingId = thing.id;

      const thumb = document.createElement('div');
      thumb.className = 'bcraft-material-card__thumb';
      // Use emoji fallback based on source_type
      const iconMap = { bim_model: '⬡', image: '📷', url: '🔗', pdf: '📄', text: '✍', voice: '🎙', asset_store: '🏪' };
      thumb.textContent = iconMap[thing.source_type] || '⬡';

      const name = document.createElement('span');
      name.className = 'bcraft-material-card__name';
      name.textContent = thing.name || 'Unnamed';

      const src = document.createElement('span');
      src.className = 'bcraft-material-card__source';
      src.textContent = thing.source_type || '';

      card.appendChild(thumb);
      card.appendChild(name);
      card.appendChild(src);

      card?.addEventListener('click', () => selectMaterial(thing));
      return card;
    }

    /* Load inventory and populate material grid */
    function loadMaterials(projectId) {
      const grid = document.getElementById('bcraft-material-grid');
      if (!grid) return;

      // If CraftUI is available, use it; else show empty state
      if (window.CraftUI && typeof window.CraftUI.loadInventory === 'function') {
        grid.innerHTML = '<div class="bcraft-empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg><p>Loading…</p></div>';
        window.CraftUI.loadInventory(projectId).then(() => {
          const items = window.CraftUI.inventory || [];
          grid.innerHTML = '';
          if (!items.length) {
            grid.innerHTML = '<div class="bcraft-empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg><p>No materials yet — add elements to the model first</p></div>';
            return;
          }
          items.forEach(t => grid.appendChild(renderMaterialCard(t)));
        }).catch(() => {
          grid.innerHTML = '<div class="bcraft-empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg><p>Could not load materials</p></div>';
        });
      }
      // If CraftUI not loaded yet, grid retains the static empty-state from HTML
    }

    /* Slide from material picker to recipe panel */
    function selectMaterial(thing) {
      _selectedThingId = thing.id;
      _selectedRecipeId = null;
      _qty = 1;

      // Update recipe panel header
      const nameEl = document.getElementById('bcraft-thing-name');
      const srcEl  = document.getElementById('bcraft-thing-source');
      if (nameEl) nameEl.textContent = thing.name || 'Material';
      if (srcEl)  srcEl.textContent  = thing.source_type || '';

      // Reset qty display
      const qtyVal = document.getElementById('bcraft-qty-val');
      if (qtyVal) qtyVal.textContent = '1';

      // Hide detail until recipe selected
      const detail = document.getElementById('bcraft-recipe-detail');
      if (detail) detail.classList.add('bcraft-recipe-detail--hidden');

      // Load recipes
      loadRecipes(thing.id);

      // Slide to recipe phase
      showPhase('recipe');

      // Expand sheet to full if currently at half
      const sheet = document.getElementById('bsheet-craft');
      if (sheet && sheet.classList.contains(SNAP_HALF)) {
        setSnap(sheet, SNAP_FULL);
        showBackdrop();
      }
    }

    /* Load and render recipe cards */
    function loadRecipes(thingId) {
      const list = document.getElementById('bcraft-recipe-list');
      if (!list) return;
      list.innerHTML = '<p style="padding:12px;color:var(--text-muted,#707070);font-size:13px">Loading recipes…</p>';

      if (window.CraftUI && typeof window.CraftUI.loadRecipePaths === 'function') {
        window.CraftUI.loadRecipePaths(thingId).then((paths) => {
          list.innerHTML = '';
          if (!paths || !paths.length) {
            list.innerHTML = '<p style="padding:12px;color:var(--text-muted,#707070);font-size:13px">No recipes found for this material.</p>';
            return;
          }
          paths.forEach((path, i) => renderRecipeCard(list, path, i + 1));
        }).catch(() => {
          list.innerHTML = '<p style="padding:12px;color:var(--text-error,#f44336);font-size:13px">Could not load recipes.</p>';
        });
      } else {
        list.innerHTML = '<p style="padding:12px;color:var(--text-muted,#707070);font-size:13px">Crafting module not loaded.</p>';
      }
    }

    /* Render a single recipe card */
    function renderRecipeCard(container, path, rank) {
      const card = document.createElement('div');
      card.className = 'bcraft-recipe-card';
      card.setAttribute('role', 'listitem');
      card.dataset.recipeId = path.recipe_id || path.id;

      const rankBadge = document.createElement('span');
      rankBadge.className = 'bcraft-recipe-card__rank';
      rankBadge.textContent = rank;

      const meta = document.createElement('div');
      meta.className = 'bcraft-recipe-card__meta';
      const cost = path.total_cost != null ? `$${Number(path.total_cost).toFixed(2)}` : '—';
      const time = path.total_time_min != null ? `${path.total_time_min} min` : '—';
      meta.textContent = `${cost} · ${time}`;

      const ops = document.createElement('div');
      ops.className = 'bcraft-recipe-card__ops';
      const opsList = Array.isArray(path.operations) ? path.operations.map(o => o.type || o).join(' → ') : '';
      ops.textContent = opsList || 'No operations listed';

      card.appendChild(rankBadge);
      card.appendChild(meta);
      card.appendChild(ops);

      card?.addEventListener('click', () => selectRecipe(card, path));
      container.appendChild(card);
    }

    /* Select a recipe — show detail panel */
    function selectRecipe(cardEl, path) {
      _selectedRecipeId = path.recipe_id || path.id;

      // Highlight selected card
      document.querySelectorAll('.bcraft-recipe-card').forEach(c => c.classList.remove('selected'));
      cardEl.classList.add('selected');

      // Show detail block
      const detail = document.getElementById('bcraft-recipe-detail');
      if (detail) detail.classList.remove('bcraft-recipe-detail--hidden');

      // Populate ingredients
      const ingList = document.getElementById('bcraft-ingredient-list');
      if (ingList) {
        ingList.innerHTML = '';
        const inputs = Array.isArray(path.input_things) ? path.input_things : [];
        if (!inputs.length) {
          const li = document.createElement('li');
          li.textContent = 'No ingredients listed';
          ingList.appendChild(li);
        } else {
          inputs.forEach(ing => {
            const li = document.createElement('li');
            li.textContent = ing.name || ing.thing_id || 'Item';
            const qty = document.createElement('span');
            qty.className = 'ing-qty';
            qty.textContent = `×${(ing.quantity || 1) * _qty}`;
            li.appendChild(qty);
            ingList.appendChild(li);
          });
        }
      }
    }

    /* Phase switcher — slides between material picker and recipe panel */
    function showPhase(phase) {
      const phases = { materials: 'bcraft-phase-materials', recipe: 'bcraft-phase-recipe' };
      Object.entries(phases).forEach(([name, id]) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (name === phase) el.classList.remove('bcraft-phase--hidden');
        else el.classList.add('bcraft-phase--hidden');
      });
    }

    /* Wire quantity stepper */
    function wireQtyStepper() {
      const dec = document.getElementById('bcraft-qty-dec');
      const inc = document.getElementById('bcraft-qty-inc');
      const val = document.getElementById('bcraft-qty-val');
      if (dec) dec?.addEventListener('click', () => {
        if (_qty > 1) { _qty--; if (val) val.textContent = _qty; }
      });
      if (inc) inc?.addEventListener('click', () => {
        _qty++;
        if (val) val.textContent = _qty;
      });
    }

    /* Wire back button in recipe panel */
    function wireBackBtn() {
      const btn = document.getElementById('bcraft-back-btn');
      if (btn) btn?.addEventListener('click', () => {
        showPhase('materials');
        // Shrink sheet back to half from full
        const sheet = document.getElementById('bsheet-craft');
        if (sheet && sheet.classList.contains(SNAP_FULL)) {
          setSnap(sheet, SNAP_HALF);
        }
      });
    }

    /* Wire footer buttons */
    function wireFooter() {
      const btnCancel = document.getElementById('bcraft-btn-cancel');
      const btnSave   = document.getElementById('bcraft-btn-save');
      const btnSpawn  = document.getElementById('bcraft-btn-spawn');

      if (btnCancel) btnCancel?.addEventListener('click', () => closeSheet('craft'));

      if (btnSave) btnSave?.addEventListener('click', () => {
        if (!_selectedRecipeId || !_selectedThingId) return;
        if (window.CraftUI && typeof window.CraftUI.lockRecipePath === 'function') {
          window.CraftUI.lockRecipePath(_selectedThingId, _selectedRecipeId)
            .then(() => showSpawnToast('✓ Recipe saved'))
            .catch(() => showSpawnToast('Save failed'));
        }
      });

      if (btnSpawn) btnSpawn?.addEventListener('click', () => {
        if (!_selectedThingId) return;
        // Add to assembly and trigger viewport reframe via existing API
        if (window.CraftUI && typeof window.CraftUI.addThingToAssembly === 'function') {
          window.CraftUI.addThingToAssembly(_selectedThingId, _qty);
        }
        // Collapse to peek so viewport is visible — architects iterate
        const sheet = document.getElementById('bsheet-craft');
        if (sheet) setSnap(sheet, SNAP_PEEK);
        hideBackdrop();
        showSpawnToast('✓ Spawned in model');

        // Reframe viewport on spawned object after brief delay for DOM settle
        setTimeout(() => {
          if (window._vpFocusElement) window._vpFocusElement(_selectedThingId);
          else if (window.focusOnElement) window.focusOnElement(_selectedThingId);
        }, 300);
      });
    }

    /* Public: open the crafting sheet, populate materials for current project */
    function open() {
      showPhase('materials');

      // Resolve project id from URL or global state
      const projectId = window._currentProjectId
        || new URLSearchParams(window.location.search).get('project')
        || null;

      loadMaterials(projectId);
      // Open at half-snap per spec — calls outer module openSheet
      openSheet('craft', SNAP_HALF);
    }

    /* Init */
    function init() {
      wireQtyStepper();
      wireBackBtn();
      wireFooter();
    }

    return { openSheet: open, init };
  })();

  // Boot crafting module after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => MobileCraft.init());
  } else {
    MobileCraft.init();
  }

  /* ── Expose API for app.js to call ─────────────────────────────── */
  window.AtlantistMobile = {
    openSheet,
    closeSheet,
    closeAllSheets,
    isMobile,
    mirrorPropsToSheet,
    craft: MobileCraft,
  };

})();
