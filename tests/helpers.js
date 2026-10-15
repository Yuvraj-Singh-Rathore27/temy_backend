// Must be the first import of every test file: configures the test environment
// before any application module reads its configuration.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(serverRoot, '.env')); // reuse local DB credentials
} catch {
  // CI: rely on real environment variables.
}
process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'temu_test';
process.env.JWT_ACCESS_SECRET ||= 'test-secret-that-is-definitely-longer-than-32-chars';
process.env.BCRYPT_ROUNDS = '4';
// Codes are returned in responses only when explicitly enabled (never in production).
process.env.OTP_DEV_DISPLAY = 'true';
// Test uploads go to a throwaway folder, never the real server/uploads.
process.env.UPLOAD_DIR = path.join((await import('node:os')).tmpdir(), 'temu-test-uploads');
// Small limits so size checks can be tested quickly.
process.env.MAX_IMAGE_MB = '1';
process.env.MAX_AUDIO_MB = '1';
// Push is tested with its own keys; the real ones in .env are never used by tests.
process.env.VAPID_PUBLIC_KEY = '';
process.env.VAPID_PRIVATE_KEY = '';
// Calls: unanswered calls time out, and dropped tabs are given up on, after 1 second.
process.env.CALL_RING_SECONDS = '1';
process.env.CALL_RECONNECT_GRACE_SECONDS = '1';
process.env.STUN_URLS = 'stun:stun.example.test:3478';
process.env.TURN_URLS = 'turn:turn.example.test:3478';
process.env.TURN_SECRET = 'turn-test-secret';

const http = await import('node:http');
const { io: ioClient } = await import('socket.io-client');
const { default: supertest } = await import('supertest');
const { createApp } = await import('../src/app.js');
const { pool, closePool } = await import('../src/db/pool.js');
const { createDatabase, migrateUp } = await import('../src/db/migrator.js');
const { createSocketServer } = await import('../src/sockets/index.js');
const { presenceService } = await import('../src/services/presenceService.js');
const { realtime } = await import('../src/sockets/realtime.js');
const { callService } = await import('../src/services/callService.js');
const { settlePresence } = await import('../src/sockets/handlers/presenceHandlers.js');

export { pool };

/** Fresh, migrated, empty test database. */
export async function resetDatabase() {
  await createDatabase();
  await migrateUp({ log: () => {} });
  // Every table except the migration bookkeeping, so new tables can never be forgotten here.
  const [tables] = await pool.query(
    "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name <> 'schema_migrations'",
  );
  await pool.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const { name } of tables) await pool.query(`TRUNCATE TABLE \`${name}\``);
  await pool.query('SET FOREIGN_KEY_CHECKS = 1');
  presenceService.reset();
  callService.reset();
}

/** Start the full HTTP + Socket.IO stack on a random port. */
export async function startServer() {
  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);
  await new Promise((resolve) => server.listen(0, resolve));
  const url = `http://localhost:${server.address().port}`;
  const sockets = new Set();

  return {
    url,
    request: supertest(app),
    /** Connect a socket client and wait until the server finished its setup. */
    async connect(token, { onSocket, ...options } = {}) {
      const socket = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, ...options });
      sockets.add(socket);
      onSocket?.(socket); // attach listeners for events sent together with session:ready
      await new Promise((resolve, reject) => {
        socket.once('session:ready', resolve);
        socket.once('connect_error', reject);
      });
      return socket;
    },
    async close() {
      for (const socket of sockets) socket.disconnect();
      io.close();
      callService.reset();
      await settlePresence();
      realtime.detach();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function closeAll() {
  await closePool();
}

let counter = 0;
/** Register a user, verify the email with the development OTP and return { user, token, cookie, password }. */
export async function registerUser(request, overrides = {}) {
  counter += 1;
  const body = {
    name: overrides.name ?? `User ${counter}`,
    email: overrides.email ?? `user${counter}_${Date.now()}@example.com`,
    password: overrides.password ?? 'password123',
  };
  const registered = await request.post('/api/auth/register').send(body).expect(201);
  const res = await request
    .post('/api/auth/verify-email')
    .send({ email: body.email, code: registered.body.devOtp })
    .expect(200);
  return {
    user: res.body.user,
    token: res.body.accessToken,
    cookie: res.headers['set-cookie'][0].split(';')[0],
    password: body.password,
  };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

/** Resolve with the next `event` payload matching `predicate`, or reject after `timeout`. */
export function waitFor(socket, event, predicate = () => true, timeout = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}"`));
    }, timeout);
    function handler(payload) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Assert that `event` is NOT received within `ms`. */
export function expectNoEvent(socket, event, ms = 300) {
  return new Promise((resolve, reject) => {
    const handler = (payload) => {
      socket.off(event, handler);
      reject(new Error(`Unexpected "${event}": ${JSON.stringify(payload)}`));
    };
    socket.on(event, handler);
    setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, ms);
  });
}

/** Emit with acknowledgement as a promise. */
export function emitAck(socket, event, payload) {
  return socket.timeout(2000).emitWithAck(event, payload);
}

/** Make `a` and `b` contacts of each other and open their conversation. */
export async function connectUsers(request, a, b) {
  await request.post('/api/contacts').set(auth(a.token)).send({ userId: b.user.id }).expect(201);
  await request.post('/api/contacts').set(auth(b.token)).send({ userId: a.user.id }).expect(201);
  const res = await request.post('/api/conversations').set(auth(a.token)).send({ userId: b.user.id }).expect(201);
  return res.body.conversation;
}
