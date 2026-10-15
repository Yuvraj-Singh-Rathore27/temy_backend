import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { attachmentRepository } from '../repositories/attachmentRepository.js';
import { logger } from '../utils/logger.js';

/**
 * Attachment files on disk, outside any public folder. Files are stored under
 * random 128-bit keys (never the user's file name) in two-level folders:
 * uploads/attachments/ab/ab12…ef
 */
const ROOT = path.join(config.uploads.dir, 'attachments');
export const TEMP_DIR = path.join(config.uploads.dir, 'tmp');
const KEY_PATTERN = /^[a-f0-9]{32}$/;

export const attachmentStorage = {
  newKey: () => crypto.randomBytes(16).toString('hex'),

  pathFor(key) {
    if (!KEY_PATTERN.test(key)) throw new Error('Invalid storage key');
    return path.join(ROOT, key.slice(0, 2), key);
  },

  /** Move an uploaded temp file into storage; returns its new key. */
  async store(tempPath) {
    const key = this.newKey();
    const target = this.pathFor(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(tempPath, target);
    } catch (error) {
      if (error.code !== 'EXDEV') throw error;
      // Different disk: copy, then remove the temp file.
      await fs.copyFile(tempPath, target);
      await fs.unlink(tempPath);
    }
    return key;
  },

  async remove(key) {
    if (!key || !KEY_PATTERN.test(key)) return;
    try {
      await fs.unlink(this.pathFor(key));
    } catch (error) {
      if (error.code !== 'ENOENT') logger.warn('Could not delete attachment file', { error });
    }
  },

  /** First bytes of a file, for type detection. */
  async readHead(filePath, bytes = 4096) {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  },

  /** Delete stored files that no attachment row uses any more (forwarded copies share files). */
  async releaseFiles(keys) {
    for (const key of new Set(keys)) {
      if (!(await attachmentRepository.isKeyInUse(key))) await this.remove(key);
    }
  },

  async discardTemp(filePath) {
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
  },
};
