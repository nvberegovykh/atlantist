/**
 * Unit tests for lib/wallt/persona.js — Wallt personality engine.
 * Asserts: system prompt contains identity tokens, validator rejects bland responses,
 * snapshot of completion shape.
 */
'use strict';

const { buildSystemPrompt, validate, PERSONA_VERSION } = require('../../lib/wallt/persona');

// ── buildSystemPrompt ─────────────────────────────────────────────────────────

describe('buildSystemPrompt', () => {
  it('contains the Wallt identity token', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Wallt');
  });

  it('contains wavetree principle', () => {
    const prompt = buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain('wavetree');
  });

  it('lists forbidden phrases', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('As an AI');
    expect(prompt).toContain('I cannot');
    expect(prompt).toContain('I apologize for the confusion');
  });

  it('includes context project name when provided', () => {
    const prompt = buildSystemPrompt({ projectName: 'Tower A', projectId: '42' });
    expect(prompt).toContain('Tower A');
    expect(prompt).toContain('42');
  });

  it('includes retry/tight mode notice when ctx.tight = true', () => {
    const prompt = buildSystemPrompt({ tight: true });
    expect(prompt).toContain('RETRY MODE');
  });

  it('has PERSONA_VERSION as a non-empty string', () => {
    expect(typeof PERSONA_VERSION).toBe('string');
    expect(PERSONA_VERSION.length).toBeGreaterThan(0);
  });
});

// ── validate ──────────────────────────────────────────────────────────────────

describe('validate', () => {
  it('passes a clean technical response', () => {
    const resp = 'POST `/api/dag/bind` with `{ from: levelId, to: wallId, type: "elevation" }` then trigger a solve.';
    const result = validate(resp);
    expect(result.pass).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0.4);
  });

  it('rejects a response containing "As an AI"', () => {
    const resp = 'As an AI language model, I can help you with that question about BIM.';
    const result = validate(resp);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('As an AI'))).toBe(true);
  });

  it('rejects a response containing "I cannot"', () => {
    const resp = 'I cannot assist with that type of request.';
    const result = validate(resp);
    expect(result.pass).toBe(false);
  });

  it('rejects a response containing "I apologize for the confusion"', () => {
    const resp = 'I apologize for the confusion in my previous response.';
    const result = validate(resp);
    expect(result.pass).toBe(false);
  });

  it('rejects a response containing "Great question"', () => {
    const resp = 'Great question! Let me walk you through the options.';
    const result = validate(resp);
    expect(result.pass).toBe(false);
  });

  it('rejects an empty response', () => {
    const result = validate('');
    expect(result.pass).toBe(false);
    expect(result.score).toBe(0);
  });

  it('returns score between 0 and 1', () => {
    const result = validate('Use AISC 360 for steel checks.');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('penalizes but does not zero-out a borderline response', () => {
    // No technical terms, no clear short clause — but also no forbidden phrases
    const resp = 'Sure, here is some information about your building project that you may find useful for your work.';
    const result = validate(resp);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(1);
  });

  it('response shape snapshot: returns { pass, score, reasons } keys', () => {
    const result = validate('Check the DAG solver logs.');
    expect(result).toHaveProperty('pass');
    expect(result).toHaveProperty('score');
    expect(result).toHaveProperty('reasons');
    expect(Array.isArray(result.reasons)).toBe(true);
  });
});
