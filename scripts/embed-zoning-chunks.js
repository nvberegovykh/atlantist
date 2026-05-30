#!/usr/bin/env node
/**
 * embed-zoning-chunks.js
 * Reads data/zoning/nyc/*.json, splits into chunks, embeds via OpenAI
 * text-embedding-3-small, and upserts into wallt_zoning_chunks.
 *
 * Usage: node scripts/embed-zoning-chunks.js [--rebuild]
 *   --rebuild  Clear all existing chunks before ingestion (full refresh)
 *
 * Requires: OPENAI_API_KEY, OPENAI_BASE_URL env vars (or Polsia proxy)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const CHUNK_MAX_TOKENS = 500; // ~2000 chars; leave room for context window

// ── Config ────────────────────────────────────────────────────────────────────
const ZONING_DIR = path.join(__dirname, '../data/zoning/nyc');
const { upsertChunk, clearAllChunks, countChunks, getChunksNeedingVerification } = require('../db/wallt-zoning');

// ── OpenAI client ─────────────────────────────────────────────────────────────
function getAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || 'task',
    baseURL: process.env.OPENAI_BASE_URL || 'https://ai.polsia.com/v1',
  });
}

// ── Text splitting ────────────────────────────────────────────────────────────
/**
 * Splits a JSON zoning file into chunks of ~500 tokens.
 * Each chunk captures: district, section, heading, and body text.
 */
function splitIntoChunks(zoningFile) {
  const data = typeof zoningFile === 'string' ? JSON.parse(zoningFile) : zoningFile;
  const district = data.district || data.section || 'UNKNOWN';
  const sourceUrl = data.source_url || '';

  const chunks = [];

  // Chunk 1: Summary (bulk + height + yards overview)
  if (data.bulk || data.description) {
    const lines = [];
    lines.push(`District: ${district}`);
    if (data.description) lines.push(`Description: ${data.description}`);
    if (data.bulk) {
      const b = data.bulk;
      lines.push(`FAR Standard: ${b.far_standard ?? b.far_standard_wide_st ?? 'see context'}`);
      if (b.far_qualifying) lines.push(`FAR Qualifying (UAP): ${b.far_qualifying}`);
      if (b.lot_coverage_max) lines.push(`Max Lot Coverage: ${b.lot_coverage_max}%`);
      if (b.quality_housing_mandatory !== undefined) lines.push(`Quality Housing: ${b.quality_housing_mandatory ? 'Mandatory' : b.quality_housing_optional ? 'Optional' : 'N/A'}`);
    }
    chunks.push({
      district,
      section: data.zr_sections?.[0] || 'overview',
      heading: `${district} — Bulk and FAR`,
      text: lines.join('\n'),
      source_url: sourceUrl,
      verify_flag: data.verify_far || false,
    });
  }

  // Chunk 2: Height and setback
  if (data.height_setback) {
    const hs = data.height_setback;
    const lines = [`${district} — Height and Setback Regulations (ZR §23-432)`];
    if (hs.regulation_type) lines.push(`Type: ${hs.regulation_type}`);
    if (hs.min_base_height_ft) lines.push(`Min Base Height: ${hs.min_base_height_ft} ft`);
    if (hs.max_base_height_ft) lines.push(`Max Base Height: ${hs.max_base_height_ft} ft`);
    if (hs.max_building_height_ft) lines.push(`Max Building Height: ${hs.max_building_height_ft} ft`);
    if (hs.affordable_max_building_height_ft) lines.push(`Qualifying Affordable Max Height: ${hs.affordable_max_building_height_ft} ft`);
    if (hs.street_wall_setback_wide_st) lines.push(`Setback (wide street): ${hs.street_wall_setback_wide_st}`);
    if (hs.street_wall_setback_narrow_st) lines.push(`Setback (narrow street): ${hs.street_wall_setback_narrow_st}`);
    if (hs.tower_permitted !== undefined) lines.push(`Tower Permitted: ${hs.tower_permitted}`);
    if (hs.notes) lines.push(`Notes: ${hs.notes}`);
    // Include sub-table for R9X/R8/etc that have variant rows
    if (hs.r9x1 || hs.r9x2) {
      lines.push('');
      if (hs.r9x1) lines.push(`R9X1: min base ${hs.r9x1.min_base}ft, max height ${hs.r9x1.max_height_std}ft (qualifying ${hs.r9x1.max_height_aff}ft)`);
      if (hs.r9x2) lines.push(`R9X2: min base ${hs.r9x2.min_base}ft, max height ${hs.r9x2.max_height_std}ft (qualifying ${hs.r9x2.max_height_aff}ft)`);
    }
    chunks.push({
      district,
      section: '23-432',
      heading: `${district} — Height and Setback`,
      text: lines.join('\n'),
      source_url: hs.source_url_height || sourceUrl,
      verify_flag: false,
    });
  }

  // Chunk 3: Yard requirements
  if (data.yards) {
    const y = data.yards;
    const lines = [`${district} — Yard Requirements (ZR §23-34)`];
    if (y.front?.requirement) lines.push(`Front Yard: ${y.front.requirement}`);
    if (y.front?.note) lines.push(`  Note: ${y.front.note}`);
    if (y.side?.requirement) lines.push(`Side Yard: ${y.side.requirement}`);
    if (y.side?.note) lines.push(`  Note: ${y.side.note}`);
    if (y.rear?.requirement) lines.push(`Rear Yard: ${y.rear.requirement}`);
    if (y.rear?.through_lot_alternative) lines.push(`Through Lot: ${y.rear.through_lot_alternative}`);
    if (y.rear?.note) lines.push(`  Note: ${y.rear.note}`);
    chunks.push({
      district,
      section: '23-34',
      heading: `${district} — Yard Requirements`,
      text: lines.join('\n'),
      source_url: y.source_url_yards || sourceUrl,
      verify_flag: false,
    });
  }

  // Chunk 4: Permitted uses
  if (data.permitted_uses) {
    const pu = data.permitted_uses;
    const lines = [`${district} — Permitted Uses (ZR §22-11, §35-31)`];
    if (pu.residential) lines.push(`Residential: ${Array.isArray(pu.residential) ? pu.residential.join('; ') : pu.residential}`);
    if (pu.community_facility) lines.push(`Community Facility: ${pu.community_facility}`);
    if (pu.commercial) lines.push(`Commercial: ${Array.isArray(pu.commercial) ? pu.commercial.join('; ') : pu.commercial}`);
    if (pu.manufacturing) lines.push(`Manufacturing: ${Array.isArray(pu.manufacturing) ? pu.manufacturing.join('; ') : pu.manufacturing}`);
    if (pu.adult_establishments) lines.push(`Adult Establishments: ${pu.adult_establishments}`);
    if (pu.ground_floor) lines.push(`Ground Floor: ${pu.ground_floor}`);
    chunks.push({
      district,
      section: '35-31',
      heading: `${district} — Permitted Uses`,
      text: lines.join('\n'),
      source_url: sourceUrl,
      verify_flag: false,
    });
  }

  // Chunk 5: DOB filing notes
  if (data.dob_filing_notes && data.dob_filing_notes.length > 0) {
    chunks.push({
      district,
      section: 'DOB',
      heading: `${district} — DOB Filing Notes`,
      text: `DOB Filing Notes for ${district}:\n- ${data.dob_filing_notes.join('\n- ')}`,
      source_url: sourceUrl,
      verify_flag: false,
    });
  }

  return chunks;
}

// ── Embedding ─────────────────────────────────────────────────────────────────
async function embedChunk(ai, text) {
  const response = await ai.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, 8000), // cap at ~8k chars per API limit
  });
  return response.data[0].embedding;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const rebuild = process.argv.includes('--rebuild');
  const ai = getAI();

  console.log(`\n=== Wallt Zoning KB Embedder ===`);
  console.log(`Model: ${EMBED_MODEL} (${EMBED_DIM} dim)`);
  console.log(`Source: ${ZONING_DIR}`);
  console.log(`Mode: ${rebuild ? 'REBUILD (clear + re-ingest)' : 'Incremental upsert'}`);

  // Find all JSON files
  const files = fs.readdirSync(ZONING_DIR).filter(f => f.endsWith('.json'));
  console.log(`Found ${files.length} zoning files\n`);

  if (files.length === 0) {
    console.error('ERROR: No .json files found in', ZONING_DIR);
    process.exit(1);
  }

  // Clear all if rebuild
  if (rebuild) {
    console.log('Clearing existing chunks...');
    await clearAllChunks();
    console.log('Done.\n');
  }

  // Process each file
  let totalChunks = 0;
  let totalEmbedded = 0;
  let verifiedCount = 0;

  for (const file of files) {
    const filePath = path.join(ZONING_DIR, file);
    const raw = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(raw);
    const chunks = splitIntoChunks(raw);

    console.log(`Processing: ${file} → ${chunks.length} chunks`);

    for (const chunk of chunks) {
      totalChunks++;

      // Embed
      try {
        const embedding = await embedChunk(ai, chunk.text);
        totalEmbedded++;

        // Upsert to DB
        await upsertChunk({
          district: chunk.district,
          section: chunk.section,
          heading: chunk.heading,
          text: chunk.text,
          sourceUrl: chunk.source_url,
          verifyFlag: chunk.verify_flag,
          embedding,
        });

        if (chunk.verify_flag) verifiedCount++;

        // Rate limit: 1000 req/min for text-embedding-3-small — sleep briefly if needed
        await new Promise(r => setTimeout(r, 10));
      } catch (err) {
        console.error(`  ERROR embedding chunk "${chunk.heading}": ${err.message}`);
      }
    }
  }

  // Summary
  const total = await countChunks();
  const verifyNeeded = await getChunksNeedingVerification();
  console.log(`\n=== Embedding Complete ===`);
  console.log(`Files processed: ${files.length}`);
  console.log(`Chunks generated: ${totalChunks}`);
  console.log(`Chunks embedded: ${totalEmbedded}`);
  console.log(`Total chunks in DB: ${total}`);
  if (verifyNeeded.length > 0) {
    console.log(`⚠️  ${verifyNeeded.length} chunks flagged for human verification:`);
    verifyNeeded.forEach(c => console.log(`  - ${c.district} / ${c.section}: ${c.heading}`));
  } else {
    console.log(`All values verified against ZR.`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});