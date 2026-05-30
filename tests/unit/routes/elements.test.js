/**
 * Unit tests for /api/elements routes.
 */
const request = require('supertest');
const express = require('express');

// Mock modules
const mockElements = [
  { id: 1, type: 'wall', type_name: 'Generic - 6"', base_level_id: 1, parameters: { length: 4000, height: 3000, wall_height: 3000 } },
  { id: 2, type: 'wall', type_name: 'Generic - 6"', base_level_id: 1, parameters: { length: 5000, height: 3000, wall_height: 3000 } }
];
const mockWalls = [];
const mockColumns = [];

const mockDb = {
  getElementsByProject: jest.fn().mockResolvedValue(mockElements),
  getElementById: jest.fn().mockImplementation((id) => {
    const el = mockElements.find(e => e.id === parseInt(id));
    return Promise.resolve(el || null);
  }),
  createElement: jest.fn().mockImplementation((data) => {
    const el = { id: 999, ...data };
    mockElements.push(el);
    return Promise.resolve(el);
  }),
  updateElement: jest.fn().mockImplementation((id, data) => {
    const el = mockElements.find(e => e.id === parseInt(id));
    if (!el) return Promise.resolve(null);
    Object.assign(el, data);
    return Promise.resolve(el);
  }),
  deleteElement: jest.fn().mockImplementation((id) => {
    const idx = mockElements.findIndex(e => e.id === parseInt(id));
    if (idx >= 0) mockElements.splice(idx, 1);
    return Promise.resolve();
  }),
  getElementsByLevel: jest.fn().mockResolvedValue(mockElements)
};

jest.mock('../../db/elements', () => mockDb);
jest.mock('../../db/events', () => ({ appendEvent: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/ws-server', () => ({ broadcastElementCreated: jest.fn(), broadcastElementUpdate: jest.fn(), broadcastElementDeleted: jest.fn() }));

const elementsRouter = require('../../routes/elements');

describe('GET /api/elements', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/elements', elementsRouter);
    jest.clearAllMocks();
  });

  test('returns 200 with elements array', async () => {
    const res = await request(app).get('/api/elements?project_id=1');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  test('returns 500 on db error', async () => {
    mockDb.getElementsByProject.mockRejectedValueOnce(new Error('DB error'));
    const res = await request(app).get('/api/elements?project_id=1');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/elements/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/elements', elementsRouter);
    jest.clearAllMocks();
  });

  test('returns 200 with element', async () => {
    const res = await request(app).get('/api/elements/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
  });

  test('returns 404 for non-existent element', async () => {
    const res = await request(app).get('/api/elements/9999');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/elements', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/elements', elementsRouter);
    jest.clearAllMocks();
    mockElements.length = 2;
  });

  test('creates wall element with 201', async () => {
    const wall = { type: 'wall', type_name: 'Generic - 6"', base_level_id: 1, parameters: { length: 3000 } };
    const res = await request(app)
      .post('/api/elements')
      .send(wall);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  test('returns 400 for missing type', async () => {
    const res = await request(app)
      .post('/api/elements')
      .send({ base_level_id: 1 });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/elements/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/elements', elementsRouter);
    jest.clearAllMocks();
  });

  test('updates element parameters', async () => {
    const res = await request(app)
      .patch('/api/elements/1')
      .send({ parameters: { length: 5000 } });
    expect(res.status).toBe(200);
    expect(mockDb.updateElement).toHaveBeenCalledWith('1', expect.objectContaining({ parameters: { length: 5000 } }));
  });

  test('returns 404 for non-existent element', async () => {
    const res = await request(app)
      .patch('/api/elements/9999')
      .send({ parameters: { length: 1000 } });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/elements/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/elements', elementsRouter);
    jest.clearAllMocks();
    mockElements.length = 2;
  });

  test('deletes element and returns ok', async () => {
    const res = await request(app).delete('/api/elements/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });

  test('returns 404 for non-existent element', async () => {
    const res = await request(app).delete('/api/elements/9999');
    expect(res.status).toBe(404);
  });
});