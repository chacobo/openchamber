import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRelayHostLock } from './host-lock.js';

// In-memory fs standing in for the shared data dir.
const makeFakeFs = () => {
  const files = new Map();
  return {
    readFileSync: (p) => {
      if (!files.has(p)) {
        const error = new Error('ENOENT');
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(p);
    },
    writeFileSync: (p, data) => {
      files.set(p, data);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    peek: (p) => files.get(p),
  };
};

// Fake process: `alive` is the set of pids that respond to kill(pid, 0).
const makeFakeProcess = (pid, alive = new Set([pid])) => ({
  pid,
  kill: (target) => {
    if (!alive.has(target)) {
      const error = new Error('ESRCH');
      error.code = 'ESRCH';
      throw error;
    }
    return true;
  },
});

const LOCK = '/data/relay-host.lock';
const silentLogger = { warn: () => {} };

describe('relay host lock', () => {
  it('claims a free lock and reports holding it', async () => {
    const fs = makeFakeFs();
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100), logger: silentLogger });

    expect(await lock.tryClaim()).toBe(true);
    expect(await lock.holdsClaim()).toBe(true);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(100);
  });

  it('refuses to claim while another LIVE process holds it', async () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100, alive), logger: silentLogger });
    const second = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(await first.tryClaim()).toBe(true);
    expect(await second.tryClaim()).toBe(false);
    expect(await second.holdsClaim()).toBe(false);
    expect(await second.liveClaimantPid()).toBe(100);
  });

  it('treats a dead claimant as free (stale claim takeover)', async () => {
    const fs = makeFakeFs();
    const alive = new Set([200]); // pid 100 is gone
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100 }));
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(await lock.liveClaimantPid()).toBe(null);
    expect(await lock.tryClaim()).toBe(true);
    expect(await lock.holdsClaim()).toBe(true);
  });

  it('forceClaim overrides a live holder; the loser sees the takeover', async () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100, alive), logger: silentLogger });
    const second = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(await first.tryClaim()).toBe(true);
    expect(second.forceClaim()).toBe(true);
    expect(await second.holdsClaim()).toBe(true);
    expect(await first.holdsClaim()).toBe(false);
    expect(await first.liveClaimantPid()).toBe(200);
  });

  it('release removes only its own claim', async () => {
    const fs = makeFakeFs();
    const alive = new Set([100, 200]);
    const first = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100, alive), logger: silentLogger });
    const second = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(200, alive), logger: silentLogger });

    expect(await first.tryClaim()).toBe(true);
    second.release(); // not the holder — must be a no-op
    expect(await first.holdsClaim()).toBe(true);

    first.release();
    expect(fs.peek(LOCK)).toBeUndefined();
    expect(await first.liveClaimantPid()).toBe(null);
  });

  it('treats an unparsable claim file as free', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, 'not-json');
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: makeFakeProcess(100), logger: silentLogger });

    expect(await lock.liveClaimantPid()).toBe(null);
    expect(await lock.tryClaim()).toBe(true);
  });

  it('an EPERM kill probe still counts as a live holder', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100 }));
    const proc = {
      pid: 200,
      kill: () => {
        const error = new Error('EPERM');
        error.code = 'EPERM';
        throw error;
      },
    };
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: proc, logger: silentLogger });

    expect(await lock.liveClaimantPid()).toBe(100);
    expect(await lock.tryClaim()).toBe(false);
  });

  const claimedAt = '2026-10-15T10:00:00.000Z';
  const makeWindowsLock = (fs, readProcessStartedAt, options = {}) => createRelayHostLock({
    lockFilePath: LOCK, fs,
    process: { ...makeFakeProcess(200, new Set([100, 200, 300])), platform: 'win32' },
    logger: silentLogger, readProcessStartedAt, ...options,
  });

  it('caches creation-time results by pid and claimedAt while still checking liveness', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let probes = 0;
    let kills = 0;
    const originalKill = makeFakeProcess(200, new Set([100, 200, 300])).kill;
    // Count the kill(pid, 0) liveness checks separately from cached inspection.
    const proc = { pid: 200, platform: 'win32', kill: (...args) => { kills += 1; return originalKill(...args); } };
    const countedLock = createRelayHostLock({ lockFilePath: LOCK, fs, process: proc, logger: silentLogger, readProcessStartedAt: async () => { probes += 1; return NaN; } });

    expect(await countedLock.liveClaimantPid()).toBe(100);
    expect(await countedLock.liveClaimantPid()).toBe(100);
    expect(probes).toBe(1);
    expect(kills).toBe(2);
  });

  it('expires a cached result at the TTL so a reused PID can be reclaimed', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let now = 0;
    let startedAt = Date.parse(claimedAt);
    let probes = 0;
    const lock = makeWindowsLock(fs, async () => { probes += 1; return startedAt; }, { now: () => now });
    expect(await lock.liveClaimantPid()).toBe(100);
    startedAt = Date.parse(claimedAt) + 1000;
    now = 299_999;
    expect(await lock.liveClaimantPid()).toBe(100);
    now = 300_000;
    expect(await lock.liveClaimantPid()).toBeNull();
    expect(probes).toBe(2);
  });

  it('probes immediately when claimedAt changes for the same PID', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let probes = 0;
    const lock = makeWindowsLock(fs, async () => { probes += 1; return NaN; });
    expect(await lock.liveClaimantPid()).toBe(100);
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt: '2026-10-15T11:00:00.000Z' }));
    expect(await lock.liveClaimantPid()).toBe(100);
    expect(probes).toBe(2);
  });

  it('caches inspection failures until expiry, then retries', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let now = 0;
    let probes = 0;
    const lock = makeWindowsLock(fs, async () => { probes += 1; throw new Error('Access denied'); }, { now: () => now });
    expect(await lock.liveClaimantPid()).toBe(100);
    expect(await lock.liveClaimantPid()).toBe(100);
    expect(probes).toBe(1);
    now = 300_000;
    expect(await lock.liveClaimantPid()).toBe(100);
    expect(probes).toBe(2);
  });

  it('shares a pending creation-time probe for concurrent identical claims', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let finish;
    let probes = 0;
    const lock = makeWindowsLock(fs, () => { probes += 1; return new Promise((resolve) => { finish = resolve; }); });
    const first = lock.liveClaimantPid();
    const second = lock.liveClaimantPid();
    expect(probes).toBe(1);
    finish(NaN);
    expect(await Promise.all([first, second])).toEqual([100, 100]);
  });

  it('clears cached probes when a claim is missing or the PID is dead', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    const alive = new Set([100, 200]);
    let probes = 0;
    const lock = createRelayHostLock({ lockFilePath: LOCK, fs, process: { ...makeFakeProcess(200, alive), platform: 'win32' }, logger: silentLogger, readProcessStartedAt: async () => { probes += 1; return NaN; } });
    expect(await lock.liveClaimantPid()).toBe(100);
    fs.unlinkSync(LOCK);
    expect(await lock.liveClaimantPid()).toBeNull();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    expect(await lock.liveClaimantPid()).toBe(100);
    alive.delete(100);
    expect(await lock.liveClaimantPid()).toBeNull();
    alive.add(100);
    expect(await lock.liveClaimantPid()).toBe(100);
    expect(probes).toBe(3);
  });

  it('reclaims a live Windows PID created after the persisted claim', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    const lock = makeWindowsLock(fs, async () => Date.parse(claimedAt) + 1000);
    expect(await lock.liveClaimantPid()).toBeNull();
    expect(await lock.tryClaim()).toBe(true);
    expect(await lock.holdsClaim()).toBe(true);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(200);
  });

  for (const startedAt of [Date.parse(claimedAt) - 1000, Date.parse(claimedAt), NaN]) {
    it(`preserves a Windows claim when creation time is ${startedAt}`, async () => {
      const fs = makeFakeFs();
      fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
      const lock = makeWindowsLock(fs, async () => startedAt);
      expect(await lock.liveClaimantPid()).toBe(100);
      expect(await lock.tryClaim()).toBe(false);
    });
  }

  it('preserves a Windows claim when process inspection fails', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    const lock = makeWindowsLock(fs, async () => { throw new Error('Access denied'); });
    expect(await lock.tryClaim()).toBe(false);
  });

  for (const timestamp of [undefined, 'invalid']) {
    it(`preserves legacy Windows claims with timestamp ${timestamp}`, async () => {
      const fs = makeFakeFs();
      fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt: timestamp }));
      const lock = makeWindowsLock(fs, async () => { throw new Error('must not probe'); });
      expect(await lock.tryClaim()).toBe(false);
    });
  }

  it('preserves a force-claim written while process inspection is pending', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let finish;
    const lock = makeWindowsLock(fs, () => new Promise((resolve) => { finish = resolve; }));
    const pending = lock.tryClaim();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 300, claimedAt: '2026-10-15T11:00:00.000Z' }));
    finish(Date.parse(claimedAt) + 1000);
    expect(await pending).toBe(false);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(300);
  });

  it('does not claim after cancellation during process inspection', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    let finish;
    const lock = makeWindowsLock(fs, () => new Promise((resolve) => { finish = resolve; }));
    const abort = new AbortController();
    const pending = lock.tryClaim({ signal: abort.signal });
    abort.abort();
    finish(Date.parse(claimedAt) + 1000);
    expect(await pending).toBe(false);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(100);
  });

  it('preserves a new claim written after a free-claim probe', async () => {
    const fs = makeFakeFs();
    const lock = makeWindowsLock(fs, async () => NaN);
    const pending = lock.tryClaim();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 300, claimedAt }));
    expect(await pending).toBe(false);
    expect(JSON.parse(fs.peek(LOCK)).pid).toBe(300);
  });

  it('retains the unwritable-directory fallback', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync = () => { throw new Error('EACCES'); };
    const lock = makeWindowsLock(fs, async () => NaN);
    expect(await lock.tryClaim()).toBe(true);
    expect(lock.forceClaim()).toBe(true);
  });

  it('does not inspect processes on other platforms', async () => {
    const fs = makeFakeFs();
    fs.writeFileSync(LOCK, JSON.stringify({ pid: 100, claimedAt }));
    const lock = createRelayHostLock({
      lockFilePath: LOCK, fs, process: { ...makeFakeProcess(200, new Set([100, 200])), platform: 'linux' },
      readProcessStartedAt: async () => { throw new Error('must not probe'); },
    });
    expect(await lock.tryClaim()).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('checks a real Windows process creation time', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-host-lock-'));
    const lockFilePath = path.join(dir, 'relay-host.lock');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
    try {
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      const lock = createRelayHostLock({ lockFilePath, fs, process });
      fs.writeFileSync(lockFilePath, JSON.stringify({ pid: child.pid, claimedAt: '2000-01-01T00:00:00.000Z' }));
      expect(await lock.liveClaimantPid()).toBeNull();
      expect(await lock.tryClaim()).toBe(true);
      expect(await lock.holdsClaim()).toBe(true);
      fs.writeFileSync(lockFilePath, JSON.stringify({ pid: child.pid, claimedAt: new Date().toISOString() }));
      expect(await lock.liveClaimantPid()).toBe(child.pid);
      expect(await lock.tryClaim()).toBe(false);
    } finally {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
