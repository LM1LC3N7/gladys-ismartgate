// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container), so that a restart never asks the gateway again before its time
// nor loops on refused credentials, and so that "Close" works before the
// first read:
//   - `pause`: the end of a pause asked by the gateway (429, 5xx);
//   - `block`: credentials refused, the next try, the count, and the salted
//     fingerprint of the REFUSED pair (other credentials lift the block, even
//     typed while the container was stopped); cleared at the first success;
//   - `gateway`: the address and the id of the gateway last read there (the
//     hash of its remote access name, not a secret);
//   - `lastAttemptAt`: when the gateway was last asked (written at most once
//     a minute: src/app.js waits that minute more after a restart).
// NO SECRET: neither the user name, nor the password, nor anything derived
// from a pair the gateway accepted, nor an activation code. The file is
// readable by the container user only (0600).
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { TIMINGS } from './constants.js';

export const STATE_FILE = '/data/ismartgate-state.json';

export function fileStore(path = process.env.DATA_FILE || STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(path, 'utf8');
        return text.length > 64 * 1024 ? null : JSON.parse(text);
      } catch {
        return null;
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    async load() {
      return this.data === null ? null : JSON.parse(JSON.stringify(this.data));
    },
    async save(data) {
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value) => (Number.isFinite(value) ? value : 0);

/** The salted fingerprint of a pair of credentials the gateway refused (never of a good one). */
export const fingerprintOf = (salt, credentialsKey) =>
  createHash('sha256').update(`${salt}:${credentialsKey}`).digest('hex').slice(0, 32);

/**
 * The persisted state, repaired and bounded: a pause never more than 6 h
 * away, a block never more than the longest new-try delay, a last attempt
 * never in the future (a clock that jumped, a file edited by hand).
 */
export function normalizeMemory(raw, now) {
  const data = object(raw);
  const pause = object(data.pause);
  const block = object(data.block);
  const gateway = object(data.gateway);
  const failures = Number.isInteger(block.failures) && block.failures > 0 ? block.failures : 1;
  const address = (value) =>
    typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : '';
  return {
    salt:
      typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
        ? data.salt
        : randomBytes(16).toString('hex'),
    pause:
      Number.isFinite(pause.until) && pause.until > now
        ? {
            until: Math.min(pause.until, now + TIMINGS.pauseMax),
            failures: Math.min(Math.max(1, Math.floor(finite(pause.failures))), 20),
            address: address(pause.address),
          }
        : null,
    block:
      Number.isFinite(block.until) &&
      typeof block.fp === 'string' &&
      /^[0-9a-f]{32}$/.test(block.fp)
        ? {
            // An expired block is kept (its count spaces the next tries) but no longer waits.
            until: Math.min(block.until, now + TIMINGS.authRetries.at(-1)),
            failures: Math.min(failures, 100),
            fp: block.fp,
            address: address(block.address),
          }
        : null,
    gateway:
      address(gateway.address) !== '' &&
      typeof gateway.id === 'string' &&
      /^[0-9a-f]{16}$/.test(gateway.id)
        ? { address: gateway.address, id: gateway.id }
        : null,
    lastAttemptAt: Math.min(Math.max(0, finite(data.lastAttemptAt)), now),
  };
}
