/**
 * Unit tests for /api/catalog routes (wall_types, column_types, door_types, window_types).
 */
const request = require('supertest');
const express = require('express');

const mockWallTypes = [
  { id: 1, name: 'Generic - 6"', function: 'exterior', layers: [{ material: 'Concrete', thickness: 150, function: 'core' }] },
  { id: 2, name: 'Generic - 8"', function: 'exterior', layers: [] }
];
const mockColumnTypes = [
  { id: 1, name: 'W14x90', section_type: 'wide_flange', depth_mm: 356, weight_kg_m: 134 }
];
const mockDoorTypes = [
  { id: 1, name: 'Single - 900x2100', width: 900, height: 2100, fire_rating: null, material: 'Wood' },
  { id: 2, name: 'Double - 1800x2100', width: 1800, height: 2100, fire_rating: '60min', material: 'Steel' }
];
const mockWindowTypes = [
  { id: 1, name: 'Fixed - 1200x1200', width: 1200, height: 1200, sill_height: 900, glazing: 'double', window_type: 'fixed' }
];

const mockDb = {
  getAllWallTypes: jest.fn().mockResolvedValue(mockWallTypes),
  getWallTypeById: jest.fn().mockImplementation((id) => Promise.resolve(mockWallTypes.find(t => t.id === parseInt(id)) || null)),
  getAllColumnTypes: jest.fn().mockResolvedValue(mockColumnTypes),
  getColumnTypeById: jest.fn().mockImplementation((id) => Promise.resolve(mockColumnTypes.find(t => t.id === parseInt(id)) || null)),
  getAllDoorTypes: jest.fn().mockResolvedValue(mockDoorTypes),
  getDoorTypeById: jest.fn().mockImplementation((id) => Promise.resolve(mockDoorTypes.find(t => t.id === parseInt(id)) || null)),
  getAllWindowTypes: jest.fn().mockResolvedValue(mockWindowTypes),
  getWindowTypeById: jest.fn().mockImplementation((id) => Promise.resolve(mockWindowTypes.find(t => t.id === parseInt(id)) || null))
};

jest.mock('../../db/wall-types', () => ({
  getAllWallTypes: mockDb.getAllWallTypes,
  getWallTypeById: mockDb.getWallTypeById
}));
jest.mock('../../db/column-types', () => ({
  getAllColumnTypes: mockDb.getAllColumnTypes,
  getColumnTypeById: mockDb.getColumnTypeById
}));
jest.mock('../../db/door-types', () => ({
  getAllDoorTypes: mockDb.getAllDoorTypes,
  getDoorTypeById: mockDb.getDoorTypeById
}));
jest.mock('../../db/window-types', () => ({
  getAllWindowTypes: mockDb.getAllWindowTypes,
  getWindowTypeById: mockDb.getWindowTypeById
}));

const catalogRouter = require('../../routes/catalog');

describe('GET /api/catalog/wall-types', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', catalogRouter);
    jest.clearAllMocks();
  });

  test('returns list of wall types', async () => {
    const res = await request(app).get('/api/catalog/wall-types');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBe(2);
  });
});

describe('GET /api/catalog/column-types', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', catalogRouter);
    jest.clearAllMocks();
  });

  test('returns list of column types', async () => {
    const res = await request(app).get('/api/catalog/column-types');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body[0]).toHaveProperty('name', 'W14x90');
  });
});

describe('GET /api/catalog/door-types', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', catalogRouter);
    jest.clearAllMocks();
  });

  test('returns door types with dimensions', async () => {
    const res = await request(app).get('/api/catalog/door-types');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body[0]).toHaveProperty('width');
    expect(res.body[0]).toHaveProperty('height');
  });
});

describe('GET /api/catalog/window-types', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', catalogRouter);
    jest.clearAllMocks();
  });

  test('returns window types with glazing info', async () => {
    const res = await request(app).get('/api/catalog/window-types');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body[0]).toHaveProperty('glazing');
  });
});