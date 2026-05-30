/**
 * Unit tests for /api/geotechnical routes.
 */
const request = require('supertest');
const express = require('express');

const mockRuns = [
  { id: 1, project_id: 1, bearing_pass: true, settlement_pass: true, status: 'completed' }
];

const mockDb = {
  createRun: jest.fn().mockImplementation((data) => Promise.resolve({ id: 99, ...data })),
  getRunById: jest.fn().mockImplementation((id) => Promise.resolve(mockRuns.find(r => r.id === parseInt(id)) || null)),
  saveRun: jest.fn().mockResolvedValue({})
};

jest.mock('../../db/geotechnical', () => mockDb);
jest.mock('../../services/geotechnical', () => ({
  runBearingCapacity: jest.fn().mockResolvedValue({ pass: true, q_all: 250, factor_safety: 3.2, method: 'Meyerhof' }),
  runSettlement: jest.fn().mockResolvedValue({ pass: true, elastic_settlement_mm: 25, consolidation_mm: 15, total_mm: 40 }),
  runLateralEarthPressure: jest.fn().mockResolvedValue({ pass: true, k0: 0.5, ka: 0.31, kp: 3.2 }),
  runPileCapacity: jest.fn().mockResolvedValue({ pass: true, skin_kN: 800, tip_kN: 400, total_kN: 1200 }),
  runSlopeStability: jest.fn().mockResolvedValue({ pass: true, fos: 1.8, method: 'Bishop' })
}));

const geoRouter = require('../../routes/geotechnical');

describe('POST /api/geotechnical/run', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/geotechnical', geoRouter);
    jest.clearAllMocks();
  });

  test('runs geotechnical analysis and returns 200', async () => {
    const res = await request(app)
      .post('/api/geotechnical/run')
      .send({
        project_id: 1,
        analysis_type: 'bearing',
        soil_layers: [
          { name: 'Fill', type: 'Sand', depthTop: 0, depthBottom: 2, unitWeight: 18, frictionAngle: 30 }
        ],
        foundation: { type: 'spread', width: 2, length: 2, depth: 1.5, load_kN: 500 }
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('bearing_results');
  });

  test('returns 400 for missing project_id', async () => {
    const res = await request(app)
      .post('/api/geotechnical/run')
      .send({ analysis_type: 'bearing' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/geotechnical/runs/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/geotechnical', geoRouter);
    jest.clearAllMocks();
  });

  test('returns run results', async () => {
    const res = await request(app).get('/api/geotechnical/runs/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
  });

  test('returns 404 for non-existent run', async () => {
    const res = await request(app).get('/api/geotechnical/runs/9999');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/geotechnical/bearing', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/geotechnical', geoRouter);
    jest.clearAllMocks();
  });

  test('calculates bearing capacity', async () => {
    const res = await request(app)
      .post('/api/geotechnical/bearing')
      .send({
        soil_layers: [{ type: 'Sand', cohesion: 0, frictionAngle: 32, unitWeight: 18 }],
        foundation: { width: 2, depth: 1.5, load_kN: 500 }
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('q_all');
    expect(res.body).toHaveProperty('factor_safety');
  });
});

describe('POST /api/geotechnical/settlement', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/geotechnical', geoRouter);
    jest.clearAllMocks();
  });

  test('calculates settlement', async () => {
    const res = await request(app)
      .post('/api/geotechnical/settlement')
      .send({
        soil_layers: [{ type: 'Clay', modulusE: 15, depthTop: 0, depthBottom: 10 }],
        foundation: { width: 2, load_kPa: 250 },
        time_years: 10
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('total_mm');
  });
});