/**
 * Unit tests for /api/levels routes.
 */
const request = require('supertest');

// Mock the db/levels module before requiring the app
const mockLevels = [
  { id: 1, name: 'Level 1', elevation: 0, element_count: 12, wall_count: 4 },
  { id: 2, name: 'Level 2', elevation: 3000, element_count: 8, wall_count: 3 }
];

const mockDb = {
  getAllLevels: jest.fn().mockResolvedValue(mockLevels),
  getLevelById: jest.fn().mockImplementation((id) => {
    const level = mockLevels.find(l => l.id === parseInt(id));
    return level ? Promise.resolve(level) : Promise.resolve(null);
  }),
  createLevel: jest.fn().mockImplementation((data) => {
    const newLevel = { id: 99, ...data, element_count: 0, wall_count: 0 };
    mockLevels.push(newLevel);
    return Promise.resolve(newLevel);
  }),
  updateLevel: jest.fn().mockImplementation((id, data) => {
    const level = mockLevels.find(l => l.id === parseInt(id));
    if (!level) return Promise.resolve(null);
    Object.assign(level, data);
    return Promise.resolve(level);
  }),
  deleteLevel: jest.fn().mockImplementation((id) => {
    const idx = mockLevels.findIndex(l => l.id === parseInt(id));
    if (idx >= 0) mockLevels.splice(idx, 1);
    return Promise.resolve();
  }),
  getLevelElementCounts: jest.fn().mockResolvedValue({ element_count: 5, wall_count: 2 })
};

jest.mock('../../db/levels', () => mockDb);
jest.mock('../../db/events', () => ({ appendEvent: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/ws-server', () => ({ broadcastLevelCreated: jest.fn(), broadcastLevelUpdate: jest.fn(), broadcastLevelDeleted: jest.fn() }));
jest.mock('../../services/dag-solver', () => ({ recalcElementsForLevel: jest.fn().mockResolvedValue({ updated: [], elapsed: 0 }) }));

// Build minimal express app for testing
const express = require('express');
const levelsRouter = require('../../routes/levels');

describe('GET /api/levels', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/levels', levelsRouter);
    jest.clearAllMocks();
  });

  test('returns 200 and list of levels', async () => {
    const res = await request(app).get('/api/levels');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
    expect(res.body.length).toBeGreaterThan(0);
    expect(mockDb.getAllLevels).toHaveBeenCalled();
  });

  test('returns 500 on db error', async () => {
    mockDb.getAllLevels.mockRejectedValueOnce(new Error('DB error'));
    const res = await request(app).get('/api/levels');
    expect(res.status).toBe(500);
    expect(res.body).toHaveProperty('error');
  });
});

describe('GET /api/levels/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/levels', levelsRouter);
    jest.clearAllMocks();
  });

  test('returns 200 with level data', async () => {
    const res = await request(app).get('/api/levels/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('element_count');
  });

  test('returns 404 for non-existent level', async () => {
    const res = await request(app).get('/api/levels/9999');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/levels', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/levels', levelsRouter);
    jest.clearAllMocks();
    mockLevels.length = 2; // reset to initial state
  });

  test('creates a new level with 201', async () => {
    const newLevel = { name: 'Level 3', elevation: 6000 };
    const res = await request(app)
      .post('/api/levels')
      .send(newLevel);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', 'Level 3');
  });

  test('returns 500 on db error during create', async () => {
    mockDb.createLevel.mockRejectedValueOnce(new Error('DB write error'));
    const res = await request(app)
      .post('/api/levels')
      .send({ name: 'Bad', elevation: 0 });
    expect(res.status).toBe(500);
  });
});

describe('PATCH /api/levels/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/levels', levelsRouter);
    jest.clearAllMocks();
  });

  test('updates elevation and triggers DAG recalc', async () => {
    const res = await request(app)
      .patch('/api/levels/1')
      .send({ elevation: 4000 });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('level');
    // DAG recalc should have been triggered since elevation changed
  });

  test('returns 400 for non-numeric elevation', async () => {
    const res = await request(app)
      .patch('/api/levels/1')
      .send({ elevation: 'not-a-number' });
    expect(res.status).toBe(400);
  });

  test('returns 404 for non-existent level', async () => {
    const res = await request(app)
      .patch('/api/levels/9999')
      .send({ elevation: 1000 });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/levels/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/levels', levelsRouter);
    jest.clearAllMocks();
    mockLevels.length = 2;
  });

  test('deletes level and returns ok', async () => {
    const res = await request(app).delete('/api/levels/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(mockDb.deleteLevel).toHaveBeenCalledWith('1');
  });

  test('returns 404 for non-existent level', async () => {
    const res = await request(app).delete('/api/levels/9999');
    expect(res.status).toBe(404);
  });
});