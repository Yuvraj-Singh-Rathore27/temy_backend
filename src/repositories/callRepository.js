import { pool } from '../db/pool.js';

const SELECT = `
  SELECT cl.id, cl.conversation_id, cl.caller_id, cl.callee_id, cl.type, cl.status,
         cl.answered_at, cl.ended_at, cl.ended_by, cl.created_at
    FROM calls cl`;

export const callRepository = {
  async create({ conversationId, callerId, calleeId, type, status = 'ringing', at }) {
    const [result] = await pool.execute(
      `INSERT INTO calls (conversation_id, caller_id, callee_id, type, status, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [conversationId, callerId, calleeId, type, status, status === 'ringing' ? null : at, at, at],
    );
    return result.insertId;
  },

  async findById(id) {
    const [rows] = await pool.execute(`${SELECT} WHERE cl.id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  },

  /** ringing → ongoing. False if the call is no longer ringing (cancelled, timed out…). */
  async markAnswered(id, at) {
    const [result] = await pool.execute(
      "UPDATE calls SET status = 'ongoing', answered_at = ? WHERE id = ? AND status = 'ringing'",
      [at, id],
    );
    return result.affectedRows === 1;
  },

  /** Finish a ringing/ongoing call. False if it had already finished. */
  async finish(id, { status, endedBy, at }) {
    const [result] = await pool.execute(
      `UPDATE calls SET status = ?, ended_by = ?, ended_at = ?
        WHERE id = ? AND status IN ('ringing', 'ongoing')`,
      [status, endedBy, at, id],
    );
    return result.affectedRows === 1;
  },

  /** After a restart no call can still be live: close what was left open. */
  async finishStale(at) {
    const [result] = await pool.execute(
      `UPDATE calls SET status = IF(status = 'ringing', 'missed', 'ended'), ended_at = ?
        WHERE status IN ('ringing', 'ongoing')`,
      [at],
    );
    return result.affectedRows;
  },

  /** My call history, newest first, with the other person's public details. */
  async listForUser(userId, { before, limit }) {
    const params = [userId, userId, userId, userId, userId];
    let where = '';
    if (before) {
      where = 'AND cl.id < ?';
      params.push(before);
    }
    params.push(limit);
    const [rows] = await pool.query(
      `SELECT cl.id, cl.conversation_id, cl.caller_id, cl.callee_id, cl.type, cl.status,
              cl.answered_at, cl.ended_at, cl.created_at,
              u.id AS peer_id, u.name AS peer_name, u.avatar_path AS peer_avatar_path,
              EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = ?) AS peer_blocked_me
         FROM calls cl
         JOIN users u ON u.id = IF(cl.caller_id = ?, cl.callee_id, cl.caller_id)
        WHERE (cl.caller_id = ? OR cl.callee_id = ?)
          AND cl.status NOT IN ('ringing', 'ongoing')
          AND NOT EXISTS (SELECT 1 FROM call_hidden h WHERE h.call_id = cl.id AND h.user_id = ?)
          ${where}
        ORDER BY cl.id DESC
        LIMIT ?`,
      params,
    );
    return rows;
  },

  async hide(userId, callIds) {
    if (callIds.length === 0) return;
    await pool.query(
      `INSERT IGNORE INTO call_hidden (call_id, user_id)
       SELECT id, ? FROM calls WHERE id IN (?) AND (caller_id = ? OR callee_id = ?)`,
      [userId, callIds, userId, userId],
    );
  },

  async hideAll(userId) {
    await pool.query(
      `INSERT IGNORE INTO call_hidden (call_id, user_id)
       SELECT id, ? FROM calls WHERE (caller_id = ? OR callee_id = ?) AND status NOT IN ('ringing', 'ongoing')`,
      [userId, userId, userId],
    );
  },
};
