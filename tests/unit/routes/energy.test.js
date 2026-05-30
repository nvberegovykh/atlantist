/**
 * Unit tests for /api/energy routes.
 */
const request = require('supertest');
const express = require('express');

const mockSimulations = [
  { id: 1, project_id: 1, status: 'completed', en1_pass: true, en2_pass: true, created_at: new Date().toISOString() }
];
const mockResults = {
  en1: { pass: true, score: 92, message: 'UA calculation passed' },
  en2: { pass: true, score: 88, message: 'Fenestration passed' }
};

const mockDb = {
  createSimulation: jest.fn().mockImplementation((data) => Promise.resolve({ id: 99, status: 'pending', ...data })),
  getSimulationById: jest.fn().mockImplementation((id) => Promise.resolve(mockSimulations.find(s => s.id === parseInt(id)) || null)),
  updateSimulation: jest.fn().mockImplementation((id, data) => {
    const sim = mockSimulations.find(s => s.id === parseInt(id));
    if (!sim) return Promise.resolve(null);
    Object.assign(sim, data);
    return Promise.resolve(sim);
  }),
  saveSimulationResults: jest.fn().mockResolvedValue({})
};

jest.mock('../../db/energy', () => mockDb);
jest.mock('../../services/energy-sim', () => ({
  runSimulation: jest.fn().mockResolvedValue({
    status: 'completed',
    results: mockResults,
    gbXML: '<Building>...</Building>',
    idf: '*RAW_DATA_BEGIN*\n*RAW_DATA_END*'
  })
}));

const energyRouter = require('../../routes/energy');

describe('POST /api/energy/simulate', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/energy', energyRouter);
    jest.clearAllMocks();
  });

  test('creates simulation and returns 202', async () => {
    const res = await request(app)
      .post('/api/energy/simulate')
      .send({ project_id: 1, model_snapshot: { elements: [] } });
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('simulation_id');
    expect(res.body).toHaveProperty('status');
  });

  test('returns 400 when project_id missing', async () => {
    const res = await request(app)
      .post('/api/energy/simulate')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('GET /api/energy/simulations/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/energy', energyRouter);
    jest.clearAllMocks();
  });

  test('returns simulation with results', async () => {
    const res = await request(app).get('/api/energy/simulations/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
  });

  test('returns 404 for non-existent simulation', async () => {
    const res = await request(app).get('/api/energy/simulations/9999');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/energy/simulations/:id/gbxml', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/energy', energyRouter);
    jest.clearAllMocks();
  });

  test('returns gbXML content', async () => {
    const res = await request(app).get('/api/energy/simulations/1/gbxml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/xml/);
  });

  test('returns 404 for non-existent simulation', async () => {
    const res = await request(app).get('/api/energy/simulations/9999/gbxml');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/energy/simulations/:id/compliance', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/energy', energyRouter);
    jest.clearAllMocks();
  });

  test('returns EN-1 to EN-8 compliance JSON', async () => {
    const res = await request(app).get('/api/energy/simulations/1/compliance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('en1');
    expect(res.body).toHaveProperty('en2');
  });
});

describe('POST /api/energy/dob-package', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/energy', energyRouter);
    jest.clearAllMocks();
  });

  test('creates DOB package zip', async () => {
    const res = await request(app)
      .post('/api/energy/dob-package')
      .send({ simulation_id: 1, project_name: 'Test Project', address: '123 Main St', BIN: '1234567', borough: 'Manhattan' });
    expect(res.status).toBe(202);
  });
});