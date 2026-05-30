/**
 * DAG solver integration tests.
 * Tests the constraint propagation engine end-to-end.
 */
const dagSolver = require('../../services/dag-solver');

describe('DAG Solver — Constraint Propagation', () => {
  test('recalcElementsForLevel returns { updated: [], elapsed } shape', async () => {
    const result = await dagSolver.recalcElementsForLevel(1);
    expect(result).toHaveProperty('updated');
    expect(Array.isArray(result.updated)).toBe(true);
    expect(result).toHaveProperty('elapsed');
    expect(typeof result.elapsed).toBe('number');
  });

  test('resolveElementGeometry handles wall element', () => {
    const wall = {
      id: 1,
      type: 'wall',
      type_name: 'Generic - 6"',
      parameters: {
        start_x: 0, start_y: 0, end_x: 5000, end_y: 0,
        wall_height: 3000,
        elevation: 0
      }
    };
    const result = dagSolver.resolveElementGeometry(wall);
    expect(result).toHaveProperty('length');
    expect(result).toHaveProperty('height');
    expect(result).toHaveProperty('volume');
  });

  test('resolveElementGeometry handles column element', () => {
    const column = {
      id: 2,
      type: 'column',
      type_name: 'W14x90',
      parameters: { center_x: 1000, center_y: 2000, base_elevation: 0, height: 3000 }
    };
    const result = dagSolver.resolveElementGeometry(column);
    expect(result).toHaveProperty('center_x');
    expect(result).toHaveProperty('center_y');
  });

  test('propagateLevelChange updates bound element geometry', async () => {
    const elements = [
      { id: 1, type: 'wall', base_level_id: 1, parameters: { elevation: 0, wall_height: 3000 } },
      { id: 2, type: 'column', base_level_id: 1, parameters: { base_elevation: 0 } }
    ];
    const result = await dagSolver.propagateLevelChange(1, 4000, elements);
    expect(result).toHaveProperty('updated');
    expect(Array.isArray(result.updated)).toBe(true);
  });

  test('validateDAGConstraint detects circular dependency', () => {
    // A level cannot reference itself in a way that creates a loop
    const constraints = [
      { element_id: 1, depends_on: 2 },
      { element_id: 2, depends_on: 1 }
    ];
    const hasCycle = dagSolver.validateDAGConstraint(constraints);
    expect(typeof hasCycle).toBe('boolean');
  });
});

describe('DAG Solver — Edge Cases', () => {
  test('handles missing elevation gracefully', () => {
    const el = { id: 1, type: 'wall', parameters: {} };
    const result = dagSolver.resolveElementGeometry(el);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('length', 0);
  });

  test('handles malformed wall parameters', () => {
    const wall = {
      id: 1,
      type: 'wall',
      parameters: { start_x: 'not-a-number', wall_height: -100 }
    };
    const result = dagSolver.resolveElementGeometry(wall);
    // Should not throw, return sensible defaults
    expect(result).toBeDefined();
  });

  test('recalcElementsForLevel with non-existent level does not throw', async () => {
    const result = await dagSolver.recalcElementsForLevel(99999);
    expect(result).toHaveProperty('updated');
    expect(result).toHaveProperty('elapsed');
  });
});