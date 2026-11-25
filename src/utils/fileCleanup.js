'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const logger = require('./logger');

function removeDirQuiet(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    logger.warn(`Could not remove temp dir ${dir}: ${e.message}`);
  }
}

function removeFileQuiet(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    logger.warn(`Could not remove temp file ${file}: ${e.message}`);
  }
}

// The background cleanup loop. Every CLEANUP_INTERVAL_MINUTES it:
//  - expires jobs past expiresAt (status "expired", files deleted,
//    kept visible for EXPIRED_GRACE_MINUTES so a polling client sees
//    the final state once),
//  - removes jobs past their grace period,
//  - sweeps orphaned job folders in the temp dir (a job id that is
//    no longer in the Map and is older than the TTL).
// No database, no disk index — the Map and the filesystem are the
// only state, and both are throwaway.
function startCleanupLoop(jobs, removeJobFiles) {
  const intervalMs = config.cleanupIntervalMinutes * 60 * 1000;
  const timer = setInterval(() => {
    const now = Date.now();
    let expired = 0;
    let removed = 0;
    for (const [id, job] of jobs) {
      if (job.status !== 'expired' && job.expiresAt && now > job.expiresAt) {
        job.status = 'expired';
        job.updatedAt = now;
        job.removeAfter = now + config.expiredGraceMinutes * 60 * 1000;
        if (job.filePath) removeFileQuiet(job.filePath);
        removeJobFiles(id);
        expired++;
      } else if (job.status === 'expired' && job.removeAfter && now > job.removeAfter) {
        jobs.delete(id);
        removed++;
      }
    }
    // Orphaned folders: a job dir with no job in the Map.
    try {
      const base = config.baseTmpDir;
      if (fs.existsSync(base)) {
        for (const name of fs.readdirSync(base)) {
          if (jobs.has(name)) continue;
          const dir = path.join(base, name);
          try {
            const st = fs.statSync(dir);
            if (Date.now() - st.mtimeMs > config.jobTtlMinutes * 60 * 1000) {
              removeDirQuiet(dir);
            }
          } catch (e) { /* already gone */ }
        }
      }
    } catch (e) {
      logger.warn(`Cleanup sweep failed: ${e.message}`);
    }
    if (expired || removed) {
      logger.info(`Cleanup: ${expired} job(s) expired, ${removed} removed`);
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { removeDirQuiet, removeFileQuiet, startCleanupLoop };
