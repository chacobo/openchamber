// Per-machine relay-host claim. Every OpenChamber instance on a machine shares
// the same data dir and therefore the same relay signing key / serverId, so if
// two processes run a relay host at once they fight over the single host slot
// at the relay worker (each new connection closes the previous one with
// "4001: Control replaced") and paired devices land on whichever instance won
// last — often a dev/worktree instance running different code.
//
// The claim file (`relay-host.lock` in the shared data dir) makes the contest
// deterministic instead of a network race:
//   - an instance only starts its relay host when there is no LIVE claimant
//     (a dead claimant's stale file is ignored);
//   - explicit user intent (creating a pairing link) claims unconditionally —
//     the instance the user is interacting with must be the one devices reach;
//   - a running host that discovers another live process has claimed backs off
//     instead of reconnecting, which is what ends the replace/reconnect fight.
//
// This is a cooperative claim, not an OS lock: correctness does not depend on
// atomicity (the relay worker still enforces a single host); the claim only
// decides which process KEEPS retrying and which stands down.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// CreationDate is available even when a service's command line is inaccessible.
const readWindowsProcessStartedAt = async (pid) => {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$ProgressPreference = 'SilentlyContinue'; $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction Stop; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') }`;
  const { stdout } = await execFileAsync(powershell, [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  return Date.parse(stdout.trim());
};

/**
 * @param {{
 *   lockFilePath: string,
 *   fs?: typeof import('node:fs'),
 *   process?: NodeJS.Process,
 *   logger?: Pick<Console, 'warn'>,
 *   readProcessStartedAt?: (pid: number) => Promise<number>,
 * }} deps
 */
export const createRelayHostLock = ({ lockFilePath, fs, process: proc, logger = console, readProcessStartedAt = readWindowsProcessStartedAt }) => {
  const fsImpl = fs;
  const selfPid = proc.pid;

  const isPidAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      proc.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user — treat as
      // alive; only ESRCH (no such process) means the claim is stale.
      return error?.code === 'EPERM';
    }
  };

  const readClaim = () => {
    try {
      const raw = fsImpl.readFileSync(lockFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const pid = Number(parsed?.pid);
      return Number.isInteger(pid) && pid > 0 ? { pid, claimedAt: parsed.claimedAt } : null;
    } catch {
      // Missing file or unparsable content: no valid claim.
      return null;
    }
  };

  const writeClaim = () => {
    try {
      fsImpl.writeFileSync(lockFilePath, JSON.stringify({ pid: selfPid, claimedAt: new Date().toISOString() }));
      return true;
    } catch (error) {
      // An unwritable data dir must not take the relay down with it — fall back
      // to pre-lock behavior (start the host, let the relay worker arbitrate).
      logger.warn(`[Relay] could not write host claim file: ${error?.message ?? error}`);
      return true;
    }
  };

  /** The pid of the current live claimant, or null when the claim is free/stale. */
  const liveClaimantPid = async () => {
    const claim = readClaim();
    if (!claim || !isPidAlive(claim.pid)) return null;
    const claimedAt = Date.parse(claim.claimedAt);
    if (proc.platform !== 'win32' || claim.pid === selfPid || !Number.isFinite(claimedAt)) return claim.pid;
    let startedAt;
    try {
      startedAt = await readProcessStartedAt(claim.pid);
    } catch {
      // Access denied, timeout, or unavailable CIM: preserve a possible live host.
      return readClaim()?.pid ?? null;
    }
    const current = readClaim();
    // An explicit force-claim during the probe must win over its stale result.
    if (current?.pid !== claim.pid || current?.claimedAt !== claim.claimedAt) return current?.pid ?? null;
    return Number.isFinite(startedAt) && startedAt > claimedAt ? null : claim.pid;
  };

  /** Claim unless another LIVE process already holds it. Re-claiming our own is a no-op refresh. */
  const tryClaim = async ({ signal } = {}) => {
    const before = readClaim();
    const holder = await liveClaimantPid();
    if (signal?.aborted) return false;
    if (holder !== null && holder !== selfPid) return false;
    const current = readClaim();
    if (current?.pid !== before?.pid || current?.claimedAt !== before?.claimedAt) return false;
    return writeClaim();
  };

  /** Unconditional claim — explicit user intent (pairing) overrides any holder. */
  const forceClaim = () => writeClaim();

  /** True while this process is the live claimant. */
  const holdsClaim = () => readClaim()?.pid === selfPid;

  /** Release only our own claim; never delete another process's. */
  const release = () => {
    const claim = readClaim();
    if (!claim || claim.pid !== selfPid) return;
    try {
      fsImpl.unlinkSync(lockFilePath);
    } catch {
      // Already gone or unwritable — nothing to do.
    }
  };

  return { tryClaim, forceClaim, holdsClaim, liveClaimantPid, release };
};
