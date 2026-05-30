/**
 * Owns: Wallt action schema definitions, permission gates, and handler signatures.
 * Does NOT own: actual BIM mutations (owned by routes/elements.js etc.), UI execution (owned by wallt-bridge.js).
 *
 * Each action has:
 *   - type        string  unique action identifier
 *   - label       string  human-readable chip label sent to frontend
 *   - params      object  validated input object
 *   - destructive boolean requires explicit confirmation chip before execution
 *   - permission  string  'any' | 'logged_in' — gate checked server-side before proposing
 */

'use strict';

// ── Action type registry ──────────────────────────────────────────────────────

const ACTION_TYPES = {
  open_modal: {
    description: 'Open a named modal in the app, optionally prefilling fields.',
    jsonSchema: {
      type: 'object',
      properties: {
        modal_id: { type: 'string', enum: ['export', 'level-editor', 'element-properties', 'energy-sim', 'family-browser', 'zoning-report', 'structural-analysis', 'schedule', 'issue-create'] },
        prefill: { type: 'object', description: 'Key-value pairs to prefill form fields' },
      },
      required: ['modal_id'],
    },
    destructive: false,
    permission: 'any',
  },

  spawn_element: {
    description: 'Create one or more BIM elements (wall, column, level, floor) through the existing API.',
    jsonSchema: {
      type: 'object',
      properties: {
        element_type: { type: 'string', enum: ['wall', 'column', 'level', 'floor'] },
        count: { type: 'integer', minimum: 1, maximum: 50 },
        params: {
          type: 'object',
          description: 'Element-specific parameters (level_id, height, x, z, length, etc.)',
        },
      },
      required: ['element_type', 'count'],
    },
    // Mass-spawn is destructive; single element is not — evaluated at runtime
    destructive: false,
    permission: 'logged_in',
  },

  run_export: {
    description: 'Trigger a model export in a given format, optionally scoped to a level.',
    jsonSchema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['dxf', 'ifc', 'gbxml', 'pdf', 'csv', 'tcl'] },
        scope: {
          type: 'object',
          properties: {
            level_id: { type: ['integer', 'null'] },
            element_ids: { type: 'array', items: { type: 'integer' } },
          },
        },
      },
      required: ['format'],
    },
    destructive: false,
    permission: 'any',
  },

  navigate: {
    description: 'Navigate the app to a specific route or panel.',
    jsonSchema: {
      type: 'object',
      properties: {
        route: { type: 'string', enum: ['energy', 'structural', 'mep', 'schedules', 'issues', 'design-book', 'node-editor', 'craft-tour', 'store'] },
        params: { type: 'object' },
      },
      required: ['route'],
    },
    destructive: false,
    permission: 'any',
  },

  apply_zoning_check: {
    description: 'Run a zoning compliance check for a given district and lot, returning a report.',
    jsonSchema: {
      type: 'object',
      properties: {
        district: { type: 'string', description: 'NYC zoning district (e.g. R6A, C1-5)' },
        lot_id: { type: 'string', description: 'BBL or descriptive lot identifier, optional' },
      },
      required: ['district'],
    },
    destructive: false,
    permission: 'any',
  },

  apply_rect_check: {
    description: 'Check whether a pricing action (discount, custom tier, enterprise deal, feature gating) preserves equal-cost distribution under the cooperative model.',
    jsonSchema: {
      type: 'object',
      properties: {
        action_type: {
          type: 'string',
          enum: ['discount_code', 'custom_enterprise_price', 'free_tier_feature_gate', 'pay_to_win_feature', 'cross_subsidy_discount', 'billing_period_tier_change'],
          description: 'The pricing action being evaluated',
        },
        details: {
          type: 'object',
          description: 'Structured details of the pricing action (amount, affected_users, funded_by, etc.)',
        },
        reason: {
          type: 'string',
          description: "Plain-language explanation of why this action is being taken (for the legal engine's reasoning output)",
        },
      },
      required: ['action_type', 'details', 'reason'],
    },
    destructive: false,
    permission: 'logged_in',
  },
};

// ── OpenAI function-calling tool definitions ──────────────────────────────────
// Built once at module load so routes/wallt.js can pass them to the LLM.

const WALLT_TOOLS = Object.entries(ACTION_TYPES).map(([type, def]) => ({
  type: 'function',
  function: {
    name: `wallt_action_${type}`,
    description: def.description,
    parameters: def.jsonSchema,
  },
}));

// ── Permission gate ───────────────────────────────────────────────────────────

/**
 * Returns true if the action is allowed given the request context.
 * @param {string} actionType
 * @param {object} ctx  { userId, isLoggedIn }
 */
function isAllowed(actionType, ctx) {
  const def = ACTION_TYPES[actionType];
  if (!def) return false;
  if (def.permission === 'logged_in' && !ctx.userId) return false;
  return true;
}

// ── Destructive gate ──────────────────────────────────────────────────────────

/**
 * Returns true if this action invocation requires explicit confirmation.
 * spawn_element >10 is always destructive; otherwise uses schema default.
 */
function requiresConfirmation(actionType, params) {
  if (actionType === 'spawn_element' && (params.count || 1) > 10) return true;
  return ACTION_TYPES[actionType]?.destructive === true;
}

// ── Parse raw LLM tool-call output into typed action array ───────────────────

/**
 * Given OpenAI's tool_calls array (from a chat completion choice),
 * parse into Wallt action objects.
 *
 * @param {Array} toolCalls  OpenAI tool_calls from completion.choices[0].message.tool_calls
 * @param {object} permCtx   { userId }
 * @returns {Array<{type, label, params, destructive, needsConfirm}>}
 */
function parseToolCalls(toolCalls, permCtx) {
  if (!Array.isArray(toolCalls)) return [];

  const actions = [];
  for (const call of toolCalls) {
    const fnName = call.function?.name || '';
    const actionType = fnName.replace('wallt_action_', '');
    const def = ACTION_TYPES[actionType];
    if (!def) continue;
    if (!isAllowed(actionType, permCtx)) continue;

    let params = {};
    try {
      params = JSON.parse(call.function.arguments || '{}');
    } catch (_) {
      continue; // Skip malformed tool calls
    }

    actions.push({
      type: actionType,
      label: buildLabel(actionType, params),
      params,
      destructive: def.destructive,
      needsConfirm: requiresConfirmation(actionType, params),
    });
  }
  return actions;
}

// ── Label builder — human-readable chip text ──────────────────────────────────

function buildLabel(type, params) {
  switch (type) {
    case 'open_modal': {
      const names = {
        export: 'Open export panel',
        'level-editor': 'Open level editor',
        'element-properties': 'Open element properties',
        'energy-sim': 'Open energy simulation',
        'family-browser': 'Open family browser',
        'zoning-report': 'Open zoning report',
        'structural-analysis': 'Open structural analysis',
        schedule: 'Open schedule',
        'issue-create': 'Create issue',
      };
      return names[params.modal_id] || 'Open panel';
    }
    case 'spawn_element': {
      const count = params.count || 1;
      const t = params.element_type || 'element';
      return count === 1 ? `Add ${t}` : `Add ${count} ${t}s`;
    }
    case 'run_export': {
      const fmt = (params.format || 'file').toUpperCase();
      return `Export as ${fmt}`;
    }
    case 'navigate': {
      const names = {
        energy: 'Go to Energy',
        structural: 'Go to Structural',
        mep: 'Go to MEP',
        schedules: 'Go to Schedules',
        issues: 'Go to Issues',
        'design-book': 'Go to Design Book',
        'node-editor': 'Open Node Editor',
        'craft-tour': 'Start Craft Tour',
        store: 'Open Asset Store',
      };
      return names[params.route] || 'Navigate';
    }
    case 'apply_zoning_check': {
      return `Run ${params.district} zoning check`;
    }
    case 'apply_rect_check': {
      const labelMap = {
        discount_code: 'Apply discount code',
        custom_enterprise_price: 'Set enterprise price',
        free_tier_feature_gate: 'Gate free tier feature',
        pay_to_win_feature: 'Add pay-to-win feature',
        cross_subsidy_discount: 'Apply cross-subsidy discount',
        billing_period_tier_change: 'Change billing tier',
      };
      return labelMap[params.action_type] || 'RECT pricing check';
    }
    default:
      return 'Do action';
  }
}

module.exports = {
  ACTION_TYPES,
  WALLT_TOOLS,
  isAllowed,
  requiresConfirmation,
  parseToolCalls,
  buildLabel,
};
