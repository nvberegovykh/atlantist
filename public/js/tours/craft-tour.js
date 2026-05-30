/**
 * craft-tour.js — Phase 33 Crafting System guided demo overlay for /app.
 * Owns: 6-stage tour, deep-link (?tour=craft), ESC/resume, ghost cursor, mobile tap-pulse, telemetry.
 * Does NOT own: Three.js BIM engine, crafting API, auth.
 */
(function () {
  'use strict';

  const STAGES = [
    { id:1, label:'Stage 1 of 6', title:'Universal Crafting',
      body:'BIM model, photo, retail link, PDF, voice, or asset store — any input becomes a craftable Thing.',
      sel:'#mob-btn-craft, #ctx-craft-trigger', cx:'14%', cy:'82%', color:'#4a7dbd', icon:'⚒' },
    { id:2, label:'Stage 2 of 6', title:'Thing Recognizer',
      body:"Paste a retail URL, drop a photo, or speak a description — the AI normalizer extracts material, dimensions, and connections with confidence scores. Here's an Eames chair seeded from a product page.",
      sel:'#craft-tour-recognizer-demo', cx:'50%', cy:'50%', color:'#7c3aed', icon:'🔍', showRecognizer:true },
    { id:3, label:'Stage 3 of 6', title:'Recipe Graph Solver',
      body:'The DAG expands — sub-parts, operations (cut / join / fasten / paint / mount), and sourcing channels surface automatically. Every node is a decision point you can override.',
      sel:'#craft-tour-dag-demo', cx:'50%', cy:'48%', color:'#059669', icon:'⬡', showDAG:true },
    { id:4, label:'Stage 4 of 6', title:'Asset in Your Model',
      body:'The resolved assembly spawns into the 3D viewport. The camera frames it automatically — dimensions, material, and family parameters are live-bound to the BIM model.',
      sel:null, cx:'50%', cy:'42%', color:'#f59e0b', icon:'📦', animateViewport:true },
    { id:5, label:'Stage 5 of 6', title:'Multi-Channel Sourcing',
      body:'Retail, secondary market, and fabrication channels ranked by your workbench constraints — skill level, budget, and lead time. Smart pricing chips update in real time.',
      sel:'#craft-tour-sourcing-demo', cx:'50%', cy:'54%', color:'#e0714d', icon:'🛒', showSourcing:true },
    { id:6, label:'Stage 6 of 6', title:'Your Turn',
      body:'Drop a model element, paste a retail URL, or describe something in voice to start your first crafting recipe.',
      sel:null, cx:'50%', cy:'50%', color:'#4a7dbd', icon:'🚀', isCTA:true },
  ];

  let _stage=0, _paused=false, _autoTimer=null, _active=false, _autoplay=false, _mobile=false, _prevHL=null;

  // ─── Telemetry ────────────────────────────────────────────────────────────
  function log(name, props) {
    try {
      fetch('/api/app-events', { method:'POST', credentials:'same-origin',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ event_name:name, session_uuid:localStorage.getItem('atl_session_uuid')||'',
          properties:props||{}, url:location.href, referrer:document.referrer })
      }).catch(()=>{});
    } catch(_){}
  }

  // ─── Highlight ────────────────────────────────────────────────────────────
  function highlight(sel) {
    if (_prevHL) { _prevHL.classList.remove('craft-tour-highlight'); _prevHL=null; }
    if (!sel) return;
    for (const s of sel.split(',')) {
      const el = document.querySelector(s.trim());
      if (el) { el.classList.add('craft-tour-highlight'); _prevHL=el; el.scrollIntoView({behavior:'smooth',block:'nearest'}); break; }
    }
  }

  // ─── Demo content builders ────────────────────────────────────────────────
  function buildRecognizer() {
    const el = document.getElementById('craft-tour-recognizer-demo');
    if (!el) return;
    el.innerHTML = `<div style="background:rgba(124,58,237,.1);border:1px solid rgba(124,58,237,.35);border-radius:12px;padding:14px 16px;max-width:380px;margin:0 auto;animation:ct-demo-in .35s cubic-bezier(.34,1.56,.64,1) both">
      <div style="font-size:11px;font-weight:700;color:#a78bfa;letter-spacing:.05em;margin-bottom:10px">THING RECOGNIZER — SAMPLE</div>
      <div style="display:flex;gap:10px;align-items:flex-start">
        <div style="width:56px;height:56px;background:rgba(124,58,237,.18);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:28px;flex-shrink:0">🪑</div>
        <div><div style="font-size:13px;font-weight:600;color:#e2e8f0;margin-bottom:2px">Eames Side Chair DSW</div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:8px">hermanmiller.com → fiberglass shell, chrome base</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <span style="background:rgba(124,58,237,.2);border:1px solid rgba(124,58,237,.4);color:#c4b5fd;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px">material: fiberglass</span>
          <span style="background:rgba(124,58,237,.2);border:1px solid rgba(124,58,237,.4);color:#c4b5fd;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px">550×500×830mm</span>
          <span style="background:rgba(74,173,110,.2);border:1px solid rgba(74,173,110,.4);color:#6ee7b7;font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px">confidence: 94%</span>
        </div></div>
      </div></div>`;
  }

  function buildDAG() {
    const el = document.getElementById('craft-tour-dag-demo');
    if (!el) return;
    el.innerHTML = `<div style="background:rgba(5,150,105,.08);border:1px solid rgba(5,150,105,.3);border-radius:12px;padding:14px 16px;max-width:420px;margin:0 auto;animation:ct-demo-in .35s cubic-bezier(.34,1.56,.64,1) both">
      <div style="font-size:11px;font-weight:700;color:#34d399;letter-spacing:.05em;margin-bottom:10px">RECIPE GRAPH — EAMES CHAIR</div>
      <div style="font-size:12px;display:flex;flex-direction:column;gap:5px">
        <span style="background:rgba(5,150,105,.25);border:1px solid rgba(5,150,105,.5);color:#6ee7b7;padding:3px 8px;border-radius:6px;font-weight:600;align-self:flex-start">🪑 Eames Chair → 3 parts · 2 ops</span>
        <div style="padding-left:20px;display:flex;flex-direction:column;gap:4px;color:#a7f3d0;font-size:11px">
          <span>├─ Fiberglass Shell <span style="color:#64748b">mount</span></span>
          <span>├─ Eiffel Base Chrome <span style="color:#64748b">assemble</span></span>
          <span>└─ Felt Glides ×4 <span style="color:#64748b">fasten</span></span>
        </div></div></div>`;
  }

  function buildSourcing() {
    const el = document.getElementById('craft-tour-sourcing-demo');
    if (!el) return;
    el.innerHTML = `<div style="background:rgba(224,113,77,.08);border:1px solid rgba(224,113,77,.3);border-radius:12px;padding:14px 16px;max-width:420px;margin:0 auto;animation:ct-demo-in .35s cubic-bezier(.34,1.56,.64,1) both">
      <div style="font-size:11px;font-weight:700;color:#fb923c;letter-spacing:.05em;margin-bottom:10px">SOURCING CHANNELS — RANKED</div>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:12px">
        <div style="display:flex;justify-content:space-between;background:rgba(74,173,110,.1);border:1px solid rgba(74,173,110,.3);border-radius:8px;padding:8px 12px">
          <div><div style="font-weight:600;color:#e2e8f0">Herman Miller Store</div><div style="font-size:10px;color:#94a3b8">retail · 4 days</div></div>
          <div style="text-align:right"><div style="font-size:14px;font-weight:700;color:#6ee7b7">$495</div><div style="font-size:10px;color:#34d399;font-weight:600">● Best match</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 12px">
          <div><div style="font-weight:600;color:#e2e8f0">Chairish (secondary)</div><div style="font-size:10px;color:#94a3b8">2 days</div></div>
          <div style="text-align:right"><div style="font-size:14px;font-weight:700;color:#e2e8f0">$310</div></div>
        </div>
        <div style="display:flex;justify-content:space-between;border:1px solid rgba(255,255,255,.1);border-radius:8px;padding:8px 12px">
          <div><div style="font-weight:600;color:#e2e8f0">Local Fab Shop</div><div style="font-size:10px;color:#94a3b8">fabrication · 3 weeks</div></div>
          <div style="text-align:right"><div style="font-size:14px;font-weight:700;color:#e2e8f0">$220</div></div>
        </div>
      </div></div>`;
  }

  // ─── Render stage ─────────────────────────────────────────────────────────
  function render(idx) {
    const s = STAGES[idx];
    if (!s) return;
    const card = document.getElementById('craft-tour-caption');
    if (!card) return;
    card.classList.add('ct-transitioning');
    setTimeout(() => {
      document.getElementById('craft-tour-stage-label').textContent = s.label;
      document.getElementById('craft-tour-title').textContent = s.title;
      document.getElementById('craft-tour-body').textContent = s.body;
      document.getElementById('craft-tour-icon').textContent = s.icon;
      const pct = Math.round(idx/(STAGES.length-1)*100);
      const fill = document.getElementById('craft-tour-progress-fill');
      if (fill) { fill.style.width=pct+'%'; fill.style.background=s.color; }
      document.getElementById('craft-tour-counter').textContent=(idx+1)+' / '+STAGES.length;
      const prev=document.getElementById('craft-tour-prev'), next=document.getElementById('craft-tour-next');
      if (prev) prev.disabled = idx===0;
      if (next) next.textContent = idx<STAGES.length-1 ? 'Next →' : 'Done ✓';
      const cta=document.getElementById('craft-tour-cta');
      if (cta) cta.style.display = s.isCTA?'block':'none';
      // Demo area
      const da=document.getElementById('craft-tour-demo-area');
      if (da) da.innerHTML='<div id="craft-tour-recognizer-demo"></div><div id="craft-tour-dag-demo"></div><div id="craft-tour-sourcing-demo"></div>';
      if (s.showRecognizer) buildRecognizer();
      if (s.showDAG) buildDAG();
      if (s.showSourcing) buildSourcing();
      // Viewport hint
      const vh=document.getElementById('craft-tour-viewport-hint');
      if (vh) vh.style.display = s.animateViewport?'flex':'none';
      // Dots
      document.querySelectorAll('.craft-tour-dot').forEach((d,i)=>d.classList.toggle('active',i===idx));
      // Highlight & cursor
      highlight(s.sel);
      const gc=document.getElementById('craft-tour-ghost-cursor');
      if (gc&&!_mobile) { gc.style.left=s.cx; gc.style.top=s.cy; }
      const tp=document.getElementById('craft-tour-tap-pulse');
      if (tp&&_mobile) { tp.style.left=s.cx; tp.style.top=s.cy; }
      _stage=idx;
      card.classList.remove('ct-transitioning');
    }, 200);
  }

  // ─── Autoplay ─────────────────────────────────────────────────────────────
  function clearAuto() { if(_autoTimer){clearTimeout(_autoTimer);_autoTimer=null;} }
  function schedAuto() {
    if (!_autoplay||_paused) return; clearAuto();
    _autoTimer=setTimeout(()=>{ if(!_paused&&_active) _stage<STAGES.length-1?render(_stage+1)&&schedAuto():endTour('completed'); }, 6000);
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────
  function startTour(opts) {
    opts=opts||{}; _autoplay=!!opts.autoplay; _stage=0; _paused=false; _active=true;
    _mobile=window.innerWidth<=640;
    const ov=document.getElementById('craft-tour-overlay');
    if (!ov) return;
    ov.classList.add('ct-active');
    const gc=document.getElementById('craft-tour-ghost-cursor');
    if (gc) gc.style.display=_mobile?'none':'block';
    const tp=document.getElementById('craft-tour-tap-pulse');
    if (tp) tp.style.display=_mobile?'block':'none';
    document.getElementById('craft-tour-resume')?.style && (document.getElementById('craft-tour-resume').style.display='none');
    render(0);
    log('tour_started',{source:opts.source||'direct',autoplay:_autoplay});
    if (_autoplay) schedAuto();
  }

  function pauseTour() {
    if (!_active) return; _paused=true; clearAuto();
    document.getElementById('craft-tour-overlay')?.classList.remove('ct-active');
    const rb=document.getElementById('craft-tour-resume');
    if (rb) rb.style.display='flex';
    log('tour_dismissed',{at_stage:_stage+1});
  }

  function resumeTour() {
    if (!_active) return; _paused=false;
    document.getElementById('craft-tour-overlay')?.classList.add('ct-active');
    const rb=document.getElementById('craft-tour-resume');
    if (rb) rb.style.display='none';
    if (_autoplay) schedAuto();
  }

  function endTour(reason) {
    clearAuto(); _active=false; _paused=false; highlight(null);
    const ov=document.getElementById('craft-tour-overlay');
    if (ov) ov.classList.remove('ct-active');
    ['craft-tour-ghost-cursor','craft-tour-tap-pulse','craft-tour-resume'].forEach(id=>{
      const el=document.getElementById(id); if(el) el.style.display='none';
    });
    const rb=document.getElementById('craft-tour-replay-btn');
    if (rb) rb.style.display='flex';
    localStorage.setItem('atl_craft_tour_seen','1');
    log(reason==='completed'?'tour_completed':'tour_dismissed',{at_stage:_stage+1});
  }

  // ─── Deep link ────────────────────────────────────────────────────────────
  function checkDeepLink() {
    const p=new URLSearchParams(location.search);
    if (p.get('tour')!=='craft') return;
    setTimeout(()=>startTour({source:'deeplink',autoplay:p.get('autoplay')==='1'}), 1200);
  }

  document.addEventListener('keydown', e=>{ if(e.key==='Escape'&&_active&&!_paused) pauseTour(); });

  // ─── Wire controls ────────────────────────────────────────────────────────
  function init() {
    document.getElementById('craft-tour-overlay')?.addEventListener('click', e=>{
      if(e.target===document.getElementById('craft-tour-overlay')) pauseTour();
    });
    document.getElementById('craft-tour-prev')?.addEventListener('click',()=>{ clearAuto(); log('tour_stage_'+_stage,{dir:'prev'}); if(_stage>0) render(_stage-1); });
    document.getElementById('craft-tour-next')?.addEventListener('click',()=>{ clearAuto(); log('tour_stage_'+(_stage+1),{dir:'next'}); if(_stage<STAGES.length-1){render(_stage+1);}else{endTour('completed');} });
    document.getElementById('craft-tour-skip')?.addEventListener('click',()=>{ clearAuto(); log('tour_dismissed',{at_stage:_stage+1,via:'skip'}); endTour('dismissed'); });
    document.getElementById('craft-tour-resume')?.addEventListener('click', resumeTour);
    document.getElementById('craft-tour-replay-btn')?.addEventListener('click',()=>startTour({source:'replay'}));
  }

  window.CraftTour = { start:startTour, pause:pauseTour, resume:resumeTour, end:endTour };

  if (document.readyState==='loading') {
    document.addEventListener('DOMContentLoaded',()=>{ init(); checkDeepLink(); });
  } else { init(); checkDeepLink(); }
})();
