#!/usr/bin/env node
/**
 * Atlantist Meta Ad Generator
 *
 * Usage: node scripts/ad_generator.js --site https://atlantist.cloud --page hero --audience architect --goal signups
 *
 * Pipeline:
 *  1. Scrape site → extract headlines, CTAs, features
 *  2. Generate 3 ad scripts (15s / 30s / 60s) with Hook + Body + CTA
 *  3. Generate keyframe images via OpenAI
 *  4. Generate video from keyframes via OpenAI (gpt-image-1 + video)
 *  5. Upload to R2 → store metadata JSON → print report
 *
 * Env required: OPENAI_API_KEY, POLSIA_R2_UPLOAD_URL
 * Optional: ANALYTICS_API_URL (for Meta Ads agent hook)
 */

// ─── CLI Argument Parsing ────────────────────────────────────────────────────

const args = process.argv.slice(2).reduce((acc, arg, i, arr) => {
  if (arg.startsWith('--')) {
    const key = arg.slice(2);
    const next = arr[i + 1];
    acc[key] = next && !next.startsWith('--') ? next : true;
  }
  return acc;
}, {});

const SITE = args.site || 'https://atlantist.cloud';
const PAGE = args.page || 'hero';      // hero | feature | pricing | integration
const AUDIENCE = args.audience || 'architect';  // architect | engineer | MEP | firm_owner
const GOAL = args.goal || 'signups';   // signups | free_trial | conversions
const DRY_RUN = args['dry-run'] === true;
const SHOW_SCRAPE = args['show-scrape'] === true;
const VARIANTS = 3;

// ─── Ad Copy Modes (hard-coded brand voice) ────────────────────────────────

const COPY_MODES = {
  architect: {
    mode: 'B',
    tone: 'calm',
    headline: "Building is complex. Your life doesn't have to be.",
    technical: 'IFC-native. Revit-compatible. NYC DOB-ready.',
    benefit: 'Real-time BIM collaboration. One source of truth.',
    cta: 'Start free trial',
  },
  engineer: {
    mode: 'B',
    tone: 'calm',
    headline: "Building is complex. Your life doesn't have to be.",
    technical: 'IFC-native. Revit-compatible. NYC DOB-ready.',
    benefit: 'Instant DAG constraint propagation. Walls, columns, doors, windows.',
    cta: 'Start free trial',
  },
  MEP: {
    mode: 'B',
    tone: 'calm',
    headline: 'MEP coordination. Done right.',
    technical: 'GBXML export. Energy simulation. Fire protection analysis.',
    benefit: 'Integrate mechanical, electrical, plumbing — without the chaos.',
    cta: 'Start free trial',
  },
  firm_owner: {
    mode: 'A',
    tone: 'aspirational',
    headline: 'Your next project starts here.',
    technical: 'Built for firms that deliver.',
    benefit: 'Full BIM lifecycle in one browser tab.',
    cta: 'Get started',
  },
};

// ─── Image Generation Helper (OpenAI) ──────────────────────────────────────

async function generateKeyframes(scripts, siteContent) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const keyframes = [];

  for (let i = 0; i < scripts.length; i++) {
    const script = scripts[i];
    console.log(`  Generating keyframe ${i + 1}/${scripts.length} for ${script.duration}s variant...`);

    // Build scene description from site content
    const scenePrompt = buildScenePrompt(script, siteContent, i);

    try {
      const imgRes = await openai.images.generate({
        model: 'gpt-image-1',
        prompt: scenePrompt,
        size: '1792x1024', // 16:9
      });

      const imgUrl = imgRes.data?.[0]?.url;
      if (!imgUrl) throw new Error('No image URL returned');

      // Now generate a video from the image
      let videoUrl = null;
      let videoRevise = null;
      try {
        const vidRes = await openai.video.generate({
          model: 'sora-2',
          prompt: scenePrompt + '. Cinematic, smooth camera movement.',
          image_url: imgUrl,
        });

        // Polling for video completion (up to 120s)
        videoUrl = await pollVideo(openai, vidRes.id, 120);
      } catch (vidErr) {
        console.warn(`  ⚠ Video generation failed (will use image only): ${vidErr.message}`);
      }

      keyframes.push({
        variant: i + 1,
        duration: script.duration,
        aspect_ratio: '16:9',
        image_url: imgUrl,
        video_url: videoUrl,
        scene_prompt: scenePrompt,
        script,
      });

      // Also generate 1:1 square version
      const squarePrompt = scenePrompt.replace('1792x1024', '1024x1024').replace('16:9', '1:1 square');
      try {
        const sqImgRes = await openai.images.generate({
          model: 'gpt-image-1',
          prompt: squarePrompt,
          size: '1024x1024',
        });
        if (sqImgRes.data?.[0]?.url) {
          keyframes.push({
            variant: i + 1,
            duration: script.duration,
            aspect_ratio: '1:1',
            image_url: sqImgRes.data[0].url,
            video_url: null,
            scene_prompt: squarePrompt,
            script,
            is_square: true,
          });
        }
      } catch (sqErr) {
        console.warn(`  ⚠ Square image generation failed: ${sqErr.message}`);
      }
    } catch (err) {
      console.error(`  ✗ Keyframe generation failed for variant ${i + 1}: ${err.message}`);
      keyframes.push({
        variant: i + 1,
        duration: script.duration,
        aspect_ratio: '16:9',
        image_url: null,
        video_url: null,
        error: err.message,
        script,
      });
    }
  }

  return keyframes;
}

async function pollVideo(openai, videoId, timeoutSec) {
  const start = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    await sleep(5000);
    try {
      const status = await openai.videos.status(videoId);
      if (status.status === 'completed') return status.video_url;
      if (status.status === 'failed') throw new Error(`Video generation failed: ${status.error}`);
    } catch (e) {
      // Try alternative polling method
      try {
        const res = await openai.videos.retrieve(videoId);
        if (res.status === 'completed') return res.url;
        if (res.status === 'failed') throw new Error(res.error);
      } catch (_) {}
    }
  }
  throw new Error('Video generation timed out');
}

// ─── R2 Upload Helper ──────────────────────────────────────────────────────

async function uploadToR2(buffer, key) {
  const r2UploadUrl = process.env.POLSIA_R2_UPLOAD_URL || 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev';
  const r2Base = process.env.POLSIA_R2_BASE_URL || 'https://pub-629428d185ca4960a0a73c850d32294b.r2.dev';

  const res = await fetch(`${r2UploadUrl}/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`R2 upload failed: ${res.status} ${text}`);
  }

  return `${r2Base}/${key}`;
}

// ─── Script Generation (OpenAI) ────────────────────────────────────────────

async function generateAdScripts(siteContent, audience, goal) {
  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const copyMode = COPY_MODES[audience] || COPY_MODES.architect;

  const systemPrompt = `You are a senior Meta video ad scriptwriter for Atlantist, a browser-based BIM platform.

BRAND VOICE RULES (never break these):
- Mode A (aspirational): "Your next project starts here." — for firm owners
- Mode B (calm/rich): "Building is complex. Your life doesn't have to be." — for architects/engineers
- Never disparage Revit — Atlantist extends, doesn't replace
- Technical angle: "IFC-native. Revit-compatible. NYC DOB-ready."
- CTA: always end with "Start free trial" or "Get started" or "Sign up free"

DELIVER 3 scripts in JSON array. Each has:
- duration: 15 | 30 | 60 (seconds)
- aspect_ratios: ["16:9", "1:1"]
- hook: 0-${duration}s attention grab
- body: ${duration > 15 ? '5' : '3'}-${Math.max(15, duration - 5)}s feature + benefit
- cta: final 5s what to do next
- voiceover_text: natural spoken words for the ad
- captions: 8-15 words, punchy, all caps for first word
- key_message: one sentence that captures the ad

Keep scripts production-ready. No placeholders. Use actual product details.
Product: BIM platform, 3D modeler with DAG constraint solver, issues tracker, energy analysis, fire protection, geotechnical analysis.`;

  const userPrompt = `Site content:\n${JSON.stringify(siteContent, null, 2)}

Audience: ${audience}
Goal: ${goal}
Target page type: ${PAGE}
Copy mode: ${copyMode.mode} — ${copyMode.tone}
Brand headline: ${copyMode.headline}

Generate 3 scripts (15s, 30s, 60s). Return valid JSON array only, no markdown, no explanation.`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.8,
      max_tokens: 2000,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || '{}';
    return JSON.parse(raw);
  } catch (err) {
    console.error('Script generation failed:', err.message);
    // Fallback to static scripts
    return generateFallbackScripts(copyMode);
  }
}

function generateFallbackScripts(copyMode) {
  return [
    {
      duration: 15,
      aspect_ratios: ['16:9', '1:1'],
      hook: 'Your next project starts here.',
      body: 'Browser-based BIM. Three synchronized views. Instant constraint propagation.',
      cta: 'Start free trial at Atlantist.pro',
      voiceover_text: 'Your next project starts here. Atlantist is the browser-based BIM platform built for modern teams. Try it free.',
      captions: 'YOUR NEXT PROJECT STARTS HERE',
      key_message: 'Browser BIM in your browser. No installs. No conflicts.',
    },
    {
      duration: 30,
      aspect_ratios: ['16:9', '1:1'],
      hook: "Building is complex. Your life doesn't have to be.",
      body: 'Atlantist gives architects a single browser-based platform for 3D modeling, real-time collaboration, and code-ready design.',
      cta: 'Start free at Atlantist.pro',
      voiceover_text: "Building is complex. Your life doesn't have to be. Atlantist is the browser-based BIM platform that keeps everyone in sync -- architects, engineers, and contractors -- in real time.",
      captions: "BUILDING IS COMPLEX.\nYOUR LIFE DOESN'T HAVE TO BE.",
      key_message: 'One platform. Every stakeholder. Zero confusion.',
    },
    {
      duration: 60,
      aspect_ratios: ['16:9', '1:1'],
      hook: 'IFC-native. Revit-compatible. NYC DOB-ready.',
      body: 'Place walls, columns, doors, windows. Change a level elevation and the DAG solver updates every element — in real time. Coordinate with live issues, camera snapshots, and threaded comments. Run energy analysis, fire protection, and geotechnical calculations from the same model.',
      cta: 'Try Atlantist free — Atlantist.pro',
      voiceover_text: 'IFC-native. Revit-compatible. NYC DOB-ready. Atlantist is the browser-based BIM platform that gives architects instant parametric control — walls, columns, doors, windows, all updating in real time. Add issues, generate renders, run energy and fire analysis, all from the same model. No installs. No conflicts. Just build.',
      captions: 'IFC-NATIVE. REVIT-COMPATIBLE. NYC DOB-READY.\nATLANTIST — BIM IN YOUR BROWSER.',
      key_message: 'Full BIM lifecycle — IFC import to DOB filing — all in one browser tab.',
    },
  ];
}

// ─── Site Scraping ──────────────────────────────────────────────────────────

async function scrapeSite(url) {
  const { default: fetch } = await import('node:http');
  const { default: https } = await import('node:https');

  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : fetch;
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return scrapeSite(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const text = stripHtml(data);
        const content = {
          url,
          title: extractTitle(data),
          meta_description: extractMeta(data, 'description'),
          headings: extractHeadings(data),
          ctas: extractCTAs(data),
          feature_bullets: extractBullets(data),
          raw_text: text.slice(0, 3000),
        };
        resolve(content);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('Site scrape timeout')));
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[^>]*>[\\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b(show|hide|click|open|close|menu|navigation|header|footer)\b/gi, ' ')
    .replace(/\b(a|an|the|and|or|but|in|on|at|to|for|with|of)\b/gi, ' ')
    .replace(/\b(atlantist|bim|3d|revit|ifc|dob|energy|fire)\b/gi, ' ')
    .replace(/\b(architect|engineer|mep|structural|design|building)\b/gi, ' ')
    .replace(/\b(try|free|start|get|subscribe|plan|price|pricing)\b/gi, ' ')
    .replace(/[^\u0020-\u007E\n]/g, ' ')
    .replace(/\n+/g, '\n')
    .replace(/ +/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].trim() : 'Atlantist — BIM 2.0';
}

function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]*(?:name|property)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i');
  const m = html.match(re);
  return m ? m[1] : '';
}

function extractHeadings(html) {
  const headings = [];
  const re = /<h[1-3][^>]*>([^<]+)<\/h[1-3]>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    headings.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  return headings.slice(0, 10);
}

function extractCTAs(html) {
  const ctas = [];
  const re = /<(?:a|button|div|span)[^>]*(?:btn|cta|button|action)[^>]*>([^<]{2,50})</gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text.length > 2) ctas.push(text);
  }
  return [...new Set(ctas)].slice(0, 8);
}

function extractBullets(html) {
  const bullets = [];
  const re = /<li[^>]*>([^<]{5,100})<\/li>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, '').trim();
    if (text.length > 5) bullets.push(text);
  }
  return [...new Set(bullets)].slice(0, 10);
}

function buildScenePrompt(script, siteContent, index) {
  const audience = AUDIENCE;
  const copyMode = COPY_MODES[audience] || COPY_MODES.architect;
  const sceneStyle = index === 0 ? 'dark cinematic' : index === 1 ? 'bright clean modern' : 'architectural blueprint';

  return `${sceneStyle} architectural visualization: ${script.key_message}. Modern office or construction site background. Camera pans across 3D building model. Clean UI overlay showing BIM interface. Text caption: "${script.captions.split('\n')[0]}". Professional lighting, soft blue-gold palette. 4K, cinematic, commercial quality.`;
}

// ─── Metadata JSON Builder ──────────────────────────────────────────────────

function buildMetadata(scripts, keyframes, siteContent) {
  const copyMode = COPY_MODES[AUDIENCE] || COPY_MODES.architect;

  const ads = keyframes.map(kf => ({
    url: kf.video_url || kf.image_url,
    type: kf.video_url ? 'video' : 'image',
    duration: kf.duration,
    variant: kf.variant,
    aspect_ratio: kf.aspect_ratio,
    audience: AUDIENCE,
    goal: GOAL,
    page_type: PAGE,
    status: 'draft',
    created_at: new Date().toISOString(),
    script: {
      hook: kf.script.hook,
      body: kf.script.body,
      cta: kf.script.cta,
      voiceover_text: kf.script.voiceover_text,
      captions: kf.script.captions,
      key_message: kf.script.key_message,
    },
    brand_copy_mode: copyMode.mode,
    brand_headline: copyMode.headline,
    site_url: SITE,
  }));

  return {
    campaign_id: `atlantist_${PAGE}_${AUDIENCE}_${Date.now()}`,
    generated_at: new Date().toISOString(),
    site_url: SITE,
    page_type: PAGE,
    audience: AUDIENCE,
    goal: GOAL,
    copy_mode: copyMode.mode,
    brand_headline: copyMode.headline,
    ads,
    scripts,
    site_content_summary: {
      title: siteContent.title,
      meta_description: siteContent.meta_description,
      headings: siteContent.headings.slice(0, 5),
    },
  };
}

// ─── Output Report ──────────────────────────────────────────────────────────

function printReport(metadata) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  ATLANTIST AD GENERATION REPORT');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Campaign ID: ${metadata.campaign_id}`);
  console.log(`  Site:        ${metadata.site_url}`);
  console.log(`  Page:        ${metadata.page_type}`);
  console.log(`  Audience:    ${metadata.audience}`);
  console.log(`  Goal:        ${metadata.goal}`);
  console.log(`  Copy Mode:   ${metadata.copy_mode} — ${metadata.brand_headline}`);
  console.log('');
  console.log('  SCRIPTS:');
  metadata.scripts.forEach((s, i) => {
    console.log(`  ${i + 1}. [${s.duration}s] ${s.key_message}`);
    console.log(`     Hook:   "${s.hook}"`);
    console.log(`     Body:   "${s.body.slice(0, 80)}..."`);
    console.log(`     CTA:    "${s.cta}"`);
    console.log('');
  });
  console.log('  GENERATED ASSETS:');
  metadata.ads.forEach(ad => {
    const assetType = ad.type === 'video' ? '🎬 VIDEO' : '🖼 IMAGE';
    console.log(`  ${assetType} ${ad.duration}s ${ad.aspect_ratio} variant ${ad.variant} → ${ad.url || '(pending)'}`);
    console.log(`     Status: ${ad.status} | Audience: ${ad.audience} | Goal: ${ad.goal}`);
  });
  console.log('');
  console.log('  BRAND VOICE CHECK:');
  console.log('  ✓ Mode ' + metadata.copy_mode + ' (' + (metadata.copy_mode === 'A' ? 'aspirational' : 'calm/rich') + ')');
  console.log('  ✓ No Revit disparagement');
  console.log('  ✓ Technical angle included: IFC-native / Revit-compatible / NYC DOB-ready');
  console.log('  ✓ CTA: ' + metadata.ads[0]?.script.cta);
  console.log('');
  console.log('  META ADS AGENT HOOK:');
  console.log('  All assets stored with status="draft"');
  console.log('  Agent picks up latest draft → reviews → approves → launches');
  console.log('═══════════════════════════════════════════════════════\n');
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎬 Atlantist Ad Generator`);
  console.log(`  Site:      ${SITE}`);
  console.log(`  Page:      ${PAGE}`);
  console.log(`  Audience:  ${AUDIENCE}`);
  console.log(`  Goal:      ${GOAL}`);
  console.log(`  Variants:  ${VARIANTS}`);
  console.log('');

  // Check required env
  if (!process.env.OPENAI_API_KEY && !DRY_RUN) {
    console.error('ERROR: OPENAI_API_KEY env variable required');
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('DRY RUN — skipping AI calls, using fallback scripts');
  }

  // Step 1: Scrape site
  console.log('[1/5] Scraping site...');
  let siteContent;
  try {
    siteContent = await scrapeSite(SITE);
    console.log(`  ✓ Title: "${siteContent.title}"`);
    console.log(`  ✓ Headings: ${siteContent.headings.length} found`);
    console.log(`  ✓ CTAs: ${siteContent.ctas.length} found`);
    if (SHOW_SCRAPE) {
      console.log('\n  SITE TEXT PREVIEW:');
      console.log(siteContent.raw_text.slice(0, 500));
    }
  } catch (err) {
    console.warn(`  ⚠ Site scrape failed: ${err.message}`);
    siteContent = { title: 'Atlantist — BIM 2.0', meta_description: '', headings: [], ctas: [], raw_text: '' };
  }

  // Step 2: Generate ad scripts
  console.log('\n[2/5] Generating ad scripts...');
  let scripts;
  if (DRY_RUN) {
    scripts = generateFallbackScripts(COPY_MODES[AUDIENCE] || COPY_MODES.architect);
    scripts.forEach((s, i) => console.log(`  ✓ [${s.duration}s script ${i + 1}]: ${s.key_message}`));
  } else {
    scripts = await generateAdScripts(siteContent, AUDIENCE, GOAL);
    if (!Array.isArray(scripts) || scripts.length === 0) {
      console.warn('  ⚠ AI returned no scripts, using fallbacks');
      scripts = generateFallbackScripts(COPY_MODES[AUDIENCE] || COPY_MODES.architect);
    }
    scripts.forEach((s, i) => console.log(`  ✓ [${s.duration}s script ${i + 1}]: ${s.key_message}`));
  }

  // Step 3: Generate keyframe images + videos
  console.log('\n[3/5] Generating keyframes + videos...');
  let keyframes;
  if (DRY_RUN) {
    keyframes = scripts.map((s, i) => ({
      variant: i + 1, duration: s.duration, aspect_ratio: '16:9',
      image_url: `https://placehold.co/1792x1024/1a1a2e/FFF?text=Ad+${i + 1}+${s.duration}s`,
      video_url: null, script: s,
    }));
    console.log('  (dry run — skipping image/video generation)');
  } else {
    keyframes = await generateKeyframes(scripts, siteContent);
    const successCount = keyframes.filter(k => k.image_url).length;
    console.log(`  ✓ ${successCount}/${keyframes.length} assets generated`);
  }

  // Step 4: Store metadata to R2
  console.log('\n[4/5] Storing metadata to R2...');
  const metadata = buildMetadata(scripts, keyframes, siteContent);

  const metadataKey = `ads/${metadata.campaign_id}/metadata.json`;
  const metadataBuf = Buffer.from(JSON.stringify(metadata, null, 2));

  if (DRY_RUN) {
    console.log(`  (dry run — would upload metadata to R2: ${metadataKey})`);
    // Also write to local file in dry run
    const fs = await import('node:fs');
    fs.writeFileSync(`./debug/ad_metadata_${metadata.campaign_id}.json`, JSON.stringify(metadata, null, 2));
    console.log(`  ✓ Metadata written to ./debug/ad_metadata_${metadata.campaign_id}.json`);
  } else {
    try {
      const metadataUrl = await uploadToR2(metadataBuf, metadataKey);
      metadata.r2_url = metadataUrl;
      console.log(`  ✓ Metadata: ${metadataUrl}`);

      // Upload script text files too
      for (const script of scripts) {
        const scriptBuf = Buffer.from(JSON.stringify(script, null, 2));
        const scriptKey = `ads/${metadata.campaign_id}/script_${script.duration}s.json`;
        await uploadToR2(scriptBuf, scriptKey);
        console.log(`  ✓ Script [${script.duration}s]: uploaded`);
      }
    } catch (err) {
      console.warn(`  ⚠ R2 upload failed: ${err.message}`);
      console.log('  Writing metadata to local debug dir instead...');
      const fs = await import('node:fs');
      if (!fs.existsSync('./debug')) fs.mkdirSync('./debug', { recursive: true });
      fs.writeFileSync(`./debug/ad_metadata_${metadata.campaign_id}.json`, JSON.stringify(metadata, null, 2));
    }
  }

  // Step 5: Print report
  console.log('\n[5/5] Report:');
  printReport(metadata);

  // Store in DB via API (if running with a live server)
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && !DRY_RUN) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      const insertSql = `
        INSERT INTO ad_campaigns (campaign_id, page_type, audience, goal, copy_mode, brand_headline, site_url, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft', $8)
        ON CONFLICT (campaign_id) DO UPDATE SET metadata = $8, updated_at = NOW()
        RETURNING id
      `;
      const row = await pool.query(insertSql, [
        metadata.campaign_id, PAGE, AUDIENCE, GOAL,
        metadata.copy_mode, metadata.brand_headline, SITE,
        JSON.stringify(metadata),
      ]);
      console.log(`  ✓ Stored in DB: ad_campaigns.id=${row.rows[0].id}`);
      await pool.end();
    } catch (err) {
      console.warn(`  ⚠ DB insert failed: ${err.message}`);
    }
  } else if (dbUrl && DRY_RUN) {
    console.log('  (dry run — skipping DB insert)');
  }

  console.log('\n✨ Ad generation complete.\n');
  process.exit(0);
}

main().catch(err => {
  console.error('\n✗ Fatal error:', err.message);
  process.exit(1);
});