/**
 * Unit tests for /api/issues routes.
 */
const request = require('supertest');
const express = require('express');

const mockIssues = [
  { id: 1, title: 'Wall alignment issue', status: 'open', priority: 'high', element_id: 5, created_at: new Date().toISOString() },
  { id: 2, title: 'Door placement', status: 'resolved', priority: 'medium', element_id: 8, created_at: new Date().toISOString() }
];

const mockComments = [
  { id: 1, issue_id: 1, author: 'Alice', content: 'Check the elevation', created_at: new Date().toISOString() }
];

const mockDb = {
  getIssuesByProject: jest.fn().mockResolvedValue(mockIssues),
  getIssueById: jest.fn().mockImplementation((id) => Promise.resolve(mockIssues.find(i => i.id === parseInt(id)) || null)),
  createIssue: jest.fn().mockImplementation((data) => Promise.resolve({ id: 99, ...data })),
  updateIssue: jest.fn().mockImplementation((id, data) => {
    const issue = mockIssues.find(i => i.id === parseInt(id));
    if (!issue) return Promise.resolve(null);
    Object.assign(issue, data);
    return Promise.resolve(issue);
  }),
  deleteIssue: jest.fn().mockImplementation((id) => Promise.resolve()),
  getCommentsByIssue: jest.fn().mockResolvedValue(mockComments),
  createComment: jest.fn().mockImplementation((data) => Promise.resolve({ id: 99, ...data }))
};

jest.mock('../../db/issues', () => mockDb);
jest.mock('../../db/events', () => ({ appendEvent: jest.fn().mockResolvedValue({}) }));
jest.mock('../../services/ws-server', () => ({
  broadcastIssueCreated: jest.fn(),
  broadcastIssueUpdate: jest.fn(),
  broadcastCommentAdded: jest.fn()
}));

const issuesRouter = require('../../routes/issues');

describe('GET /api/issues', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
    jest.clearAllMocks();
  });

  test('returns 200 with issues array', async () => {
    const res = await request(app).get('/api/issues?project_id=1');
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Array);
  });

  test('returns 500 on db error', async () => {
    mockDb.getIssuesByProject.mockRejectedValueOnce(new Error('DB error'));
    const res = await request(app).get('/api/issues?project_id=1');
    expect(res.status).toBe(500);
  });
});

describe('GET /api/issues/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
    jest.clearAllMocks();
  });

  test('returns issue with comments', async () => {
    const res = await request(app).get('/api/issues/1');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
    expect(res.body).toHaveProperty('comments');
  });

  test('returns 404 for non-existent issue', async () => {
    const res = await request(app).get('/api/issues/9999');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/issues', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
    jest.clearAllMocks();
  });

  test('creates issue with 201', async () => {
    const issue = { title: 'New issue', status: 'open', priority: 'low', element_id: 10 };
    const res = await request(app).post('/api/issues').send(issue);
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  test('returns 400 when title missing', async () => {
    const res = await request(app).post('/api/issues').send({ status: 'open' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/issues/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
    jest.clearAllMocks();
  });

  test('updates issue status', async () => {
    const res = await request(app)
      .patch('/api/issues/1')
      .send({ status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('status', 'resolved');
  });

  test('returns 404 for non-existent issue', async () => {
    const res = await request(app)
      .patch('/api/issues/9999')
      .send({ status: 'resolved' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/issues/:id', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
    jest.clearAllMocks();
  });

  test('deletes issue', async () => {
    const res = await request(app).delete('/api/issues/2');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
  });
});

describe('POST /api/issues/:id/comments', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/issues', issuesRouter);
    jest.clearAllMocks();
  });

  test('adds comment to issue', async () => {
    const res = await request(app)
      .post('/api/issues/1/comments')
      .send({ content: 'Looks good to me', author: 'Bob' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
  });

  test('returns 400 when content missing', async () => {
    const res = await request(app)
      .post('/api/issues/1/comments')
      .send({});
    expect(res.status).toBe(400);
  });
});