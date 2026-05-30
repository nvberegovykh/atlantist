/**
 * Unit tests for /api/fire-protection routes.
 */
const request = require('supertest');
const express = require('express');

const mockRuns = [
  { id: 1, occupancy_type: 'A2', status: 'completed', sprinkler_pass: true, egress_pass: true, smoke_pass: true }
];

const mockDb = {
  createRun: jest.fn().mockImplementation((data) => Promise.resolve({ id: 99, ...data })),
  getRunById: jest.fn().mockImplementation((id) => Promise.resolve(mockRuns.find(r => r.id === parseInt(id)) || null)),
  updateRun: jest.fn().mockImplementation((id, data) => {
    const run = mockRuns.find(r => r.id === parseInt(id));
    if (!run) return Promise.resolve(null);
    Object.assign(run, data);
    return Promise.resolve(run);
  })
};

jest.mock('../../db/fire-protection', () => mockDb);
jest.mock('../../services/fire-protection', () => ({
  runSprinklerAnalysis: jest.fn().mockResolvedValue({ pass: true, density: 0.3, coverage: '100%' }),
  runEgressAnalysis: jest.fn().mockResolvedValue({ pass: true, travel_time: 45, min_width: 915 }),
  runSmokeControl: jest.fn().mockResolvedValue({ pass: true, exhaust_rate: 2.5 }),
  runFireResistance: jest.fn().mockResolvedValue({ pass: true, rating_hours: 2.0 }),
  runFDNYAnalysis: jest.fn().mockResolvedValue({ pass: true, type: 'non-separated' })
}));

const fpRouter = require('../../routes/fire-protection');

describe('POST /api/fire-protection/analyze', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/fire-protection', fpRouter);
    jest.clearAllMocks();
  });

  test('runs all fire protection analyses and returns 200', async () => {
    const res = await request(app)
      .post('/api/fire-protection/analyze')
      .send({ occupancy_type: 'A2', project_id: 1, floor_area: 500, occupant_load: 200, ceiling_height: 3.5 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('sprinkler');
    expect(res.body).toHaveProperty('egress');
    expect(res.body).toHaveProperty('smoke');
    expect(res.body).toHaveProperty('resistance');
    expect(res.body).toHaveProperty('fdny');
  });

  test('returns 400 when occupancy_type missing', async () => {
    const res = await request(app)
      .post('/api/fire-protection/analyze')
      .send({ project_id: 1 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/fire-protection/runs/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/fire-protection', fpRouter);
    jest.clearAllMocks();
  });

  test('returns run with results', async () => {
    const res = await request(app).get('/api/fire-protection/runs/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
  });

  test('returns 404 for non-existent run', async () => {
    const res = await request(app).get('/api/fire-protection/runs/9999');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/fire-protection/nfpa-13', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/fire-protection', fpRouter);
    jest.clearAllMocks();
  });

  test('returns sprinkler design parameters', async () => {
    const res = await request(app)
      .get('/api/fire-protection/nfpa-13')
      .query({ occupancy: 'A2', hazard: 'ordinary' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('density');
    expect(res.body).toHaveProperty('area');
  });
});

describe('GET /api/fire-protection/nfpa-101', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/fire-protection', fpRouter);
    jest.clearAllMocks();
  });

  test('returns egress requirements', async () => {
    const res = await request(app)
      .get('/api/fire-protection/nfpa-101')
      .query({ occupancy: 'A2', floor_area: 500 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('occupant_load_factor');
  });
});