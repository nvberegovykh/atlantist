/**
 * Unit tests for /api/auth routes.
 */
const request = require('supertest');
const express = require('express');

// Mock dependencies
jest.mock('../../db/users', () => ({
  getUserByEmail: jest.fn(),
  upsertUser: jest.fn(),
  createAnonymousUser: jest.fn(),
  getUserBySessionUuid: jest.fn(),
  getUserById: jest.fn()
}));
jest.mock('../../db/auth', () => ({
  createSession: jest.fn(),
  getSessionByToken: jest.fn(),
  invalidateSession: jest.fn()
}));
jest.mock('../../db/invites', () => ({ getPendingInvitesForEmail: jest.fn().mockResolvedValue([]) }));
jest.mock('../../db/leads', () => ({ upsertLead: jest.fn().mockResolvedValue({}) }));
jest.mock('../../db/magic-tokens', () => ({
  createMagicToken: jest.fn().mockResolvedValue('test-magic-token-abc123'),
  getMagicTokenData: jest.fn(),
  consumeMagicToken: jest.fn().mockResolvedValue({})
}));
jest.mock('../../db/roles', () => ({ getUserRole: jest.fn().mockResolvedValue('user') }));

const dbUsers = require('../../db/users');
const dbAuth = require('../../db/auth');
const dbMagic = require('../../db/magic-tokens');
const dbRoles = require('../../db/roles');

const authRouter = require('../../routes/auth');

describe('GET /api/auth/me', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
  });

  test('returns authenticated: false when no session', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('authenticated', false);
  });
});

describe('POST /api/auth/init', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
  });

  test('creates anonymous user and returns user_id', async () => {
    dbUsers.getUserBySessionUuid.mockResolvedValue(null);
    dbUsers.createAnonymousUser.mockResolvedValue({ id: 42, session_uuid: 'abc-uuid' });

    const res = await request(app)
      .post('/api/auth/init')
      .send({ session_uuid: 'abc-uuid' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user_id');
    expect(res.body).toHaveProperty('session_uuid', 'abc-uuid');
  });

  test('returns existing user if session_uuid already exists', async () => {
    dbUsers.getUserBySessionUuid.mockResolvedValue({ id: 99, session_uuid: 'abc-uuid' });

    const res = await request(app)
      .post('/api/auth/init')
      .send({ session_uuid: 'abc-uuid' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('user_id', 99);
  });

  test('returns 400 when session_uuid missing', async () => {
    const res = await request(app)
      .post('/api/auth/init')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/send-magic-link', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
  });

  test('returns success and dev_token in non-production', async () => {
    const res = await request(app)
      .post('/api/auth/send-magic-link')
      .send({ email: 'test@example.com', session_uuid: 'abc' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('dev_token');
    expect(dbMagic.createMagicToken).toHaveBeenCalledWith('test@example.com', 'abc');
  });

  test('returns 400 when email missing', async () => {
    const res = await request(app)
      .post('/api/auth/send-magic-link')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error', 'email required');
  });

  test('returns 500 on error', async () => {
    dbMagic.createMagicToken.mockRejectedValueOnce(new Error('Token error'));
    const res = await request(app)
      .post('/api/auth/send-magic-link')
      .send({ email: 'test@example.com', session_uuid: 'abc' });
    expect(res.status).toBe(500);
  });
});

describe('POST /api/auth/verify-step1', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
  });

  test('returns email and user_exists when token valid', async () => {
    dbMagic.getMagicTokenData.mockResolvedValue({ email: 'test@example.com', session_uuid: 'abc' });
    dbUsers.getUserByEmail.mockResolvedValue({ id: 1, email: 'test@example.com' });

    const res = await request(app)
      .post('/api/auth/verify-step1')
      .send({ token: 'valid-token' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('email', 'test@example.com');
    expect(res.body).toHaveProperty('user_exists', true);
  });

  test('returns 400 for invalid token', async () => {
    dbMagic.getMagicTokenData.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/auth/verify-step1')
      .send({ token: 'invalid-token' });
    expect(res.status).toBe(400);
  });

  test('returns 400 when token missing', async () => {
    const res = await request(app)
      .post('/api/auth/verify-step1')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/complete-signup', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
  });

  test('creates user session and returns success', async () => {
    dbMagic.getMagicTokenData.mockResolvedValue({ email: 'new@example.com', session_uuid: 'abc' });
    dbUsers.upsertUser.mockResolvedValue({ id: 5, email: 'new@example.com', first_name: 'Test', project_type: 'residential', onboarding_complete: false });
    dbAuth.createSession.mockResolvedValue({ session: { id: 1 }, token: 'session-token-xyz' });
    dbMagic.consumeMagicToken.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/complete-signup')
      .send({
        token: 'valid-magic-token',
        session_uuid: 'abc',
        first_name: 'Test',
        project_type: 'residential'
      });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.user).toHaveProperty('email', 'new@example.com');
    // Session cookie should be set
    expect(res.headers['set-cookie']).toBeDefined();
  });

  test('returns 400 when token missing', async () => {
    const res = await request(app)
      .post('/api/auth/complete-signup')
      .send({ first_name: 'Test' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for expired/invalid token', async () => {
    dbMagic.getMagicTokenData.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/auth/complete-signup')
      .send({ token: 'expired-token', first_name: 'Test' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/auth/logout', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
  });

  test('invalidates session and returns success', async () => {
    dbAuth.getSessionByToken.mockResolvedValue({ user_id: 1 });
    dbAuth.invalidateSession.mockResolvedValue({});

    const res = await request(app)
      .post('/api/auth/logout')
      .set('Cookie', ['session_token=test-token']);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
  });
});

describe('GET /api/auth/invite/:token', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRouter);
    jest.clearAllMocks();
  });

  test('returns invite details for valid token', async () => {
    const { getInviteByToken } = require('../../db/invites');
    getInviteByToken.mockResolvedValue({
      project_name: 'Test Project',
      invited_by_name: 'Jane Doe',
      role: 'member',
      expires_at: new Date(Date.now() + 86400000)
    });

    const res = await request(app).get('/api/auth/invite/valid-invite-token');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('project_name', 'Test Project');
    expect(res.body).toHaveProperty('role', 'member');
  });

  test('returns 404 for invalid invite token', async () => {
    const { getInviteByToken } = require('../../db/invites');
    getInviteByToken.mockResolvedValue(null);
    const res = await request(app).get('/api/auth/invite/bad-token');
    expect(res.status).toBe(404);
  });
});