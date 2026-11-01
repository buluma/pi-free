/**
 * Cross-process file locking + atomic writes for shared JSON state.
 *
 * Two pi processes sharing one home (TUI + background run, two terminals)
 * perform read-modify-write on the same files (`~/.pi/free.json`, the JSON
 * stores). The old in-process promise-chain mutexes (`ConfigLock`,
 * `json-persistence.ts#Lock`) serialize writers *within* one process only,
 * and plain `writeFileSync` overwrites in place — so a second process's
 * update was silently lost, and a crash mid-write left a torn file (#611).
 *
 * This module is the single seam both call sites use:
 * - `writeFileAtomicSync` — tmp file in the same directory + fsync + rename.
 *   Readers never see a partial file; a crash leaves either the old or the
 *   new file, never a torn one. (Dir fsync is deliberately skipped: without
 *   it a crash can only surface the *old* file, which is the safe direction.)
 * - `withFileLock` — per-path in-process chaining (same shape as the removed
 *   mutexes) layered over a cross-process lockdir (`<file>.lock/`).
 *
 * No new runtime dependency: the lock uses `mkdirSync` atomicity from
 * `node:fs` (this package ships zero runtime deps, so `proper-lockfile` is
 * not on the table without a dependency discussion).
 *
 * Stale locks (crashed holder) are busted when the lock info is older than
 * `STALE_MS` or names a dead pid; the window between `mkdirSync` and the
 * info write is synchronous (microseconds), and an info-less lock is waited
 * on rather than busted. Acquisition gives up after `TIMEOUT_MS` and throws
 * so a wedged lock can never hang a session forever — callers keep their
 * existing catch-and-log behavior.
 */

import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "./logger.ts";
import { ensureDir } from "./paths.ts";

const _logger = createLogger("atomic-file");

/** Suffix for the lock directory guarding a state file. */
const LOCK_SUFFIX = ".lock";
/** Lock info payload written by the holder. */
const LOCK_INFO = "info.json";
/** A lock older than this is treated as crashed-holder residue and busted. */
const STALE_MS = 30_000;
/** Give up acquiring after this long rather than hanging the session. */
const TIMEOUT_MS = 15_000;
/** Poll interval while waiting for a held lock. */
const RETRY_MS = 10;

export interface FileLockOptions {
	/** Override the stale-lock age (tests only). */
	staleMs?: number;
	/** Override the acquisition timeout (tests only). */
	timeoutMs?: number;
}

interface LockInfo {
	pid: number;
	time: number;
}

let _tmpCounter = 0;
/** In-process chains keyed by absolute lock path (replaces ConfigLock/Lock). */
const _chains = new Map<string, Promise<void>>();
/** Per-path once-per-session contention log (bounded observability). */
const _waitLogged = new Set<string>();

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process (dead). Anything else (EPERM, EINVAL) is
		// inconclusive — treat as alive and let the age cap decide instead.
		if (
			err !== null &&
			typeof err === "object" &&
			(err as { code?: unknown }).code === "ESRCH"
		) {
			return false;
		}
		return true;
	}
}

function readLockInfo(lockDir: string): LockInfo | undefined {
	try {
		if (!existsSync(lockDir)) return undefined;
		const raw = readFileSync(`${lockDir}/${LOCK_INFO}`, "utf-8");
		const info = JSON.parse(raw) as Partial<LockInfo>;
		if (typeof info.pid !== "number" || typeof info.time !== "number") {
			return undefined;
		}
		return { pid: info.pid, time: info.time };
	} catch {
		return undefined;
	}
}

function removeLockDir(lockDir: string): void {
	try {
		rmSync(lockDir, { recursive: true, force: true });
	} catch (err) {
		_logger.debug("Could not remove lock directory", {
			lockDir,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

async function acquireDirLock(
	lockDir: string,
	options: FileLockOptions,
): Promise<void> {
	const staleMs = options.staleMs ?? STALE_MS;
	const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
	ensureDir(dirname(lockDir));
	const deadline = Date.now() + timeoutMs;
	let waited = false;

	for (;;) {
		try {
			mkdirSync(lockDir);
			// Holder marker. Written synchronously in the same tick as the
			// mkdir, so the info-less window is microseconds; waiters treat
			// an info-less lock as held (never bust it).
			writeFileSync(
				`${lockDir}/${LOCK_INFO}`,
				JSON.stringify({ pid: process.pid, time: Date.now() }),
				"utf-8",
			);
			return;
		} catch (err) {
			if (
				err === null ||
				typeof err !== "object" ||
				(err as { code?: unknown }).code !== "EEXIST"
			) {
				throw err;
			}
		}

		const info = readLockInfo(lockDir);
		if (
			info !== undefined &&
			(Date.now() - info.time > staleMs || !isPidAlive(info.pid))
		) {
			// Crashed-holder residue. Anomalies log every occurrence — busts
			// are rare by construction (holders only do sync work + rename).
			_logger.warn("Busting stale file lock", {
				lockDir,
				holderPid: info.pid,
				ageMs: Date.now() - info.time,
			});
			removeLockDir(lockDir);
			continue;
		}

		if (!waited) {
			waited = true;
			if (!_waitLogged.has(lockDir)) {
				_waitLogged.add(lockDir);
				_logger.debug("Waiting on a file lock held by another process", {
					lockDir,
				});
			}
		}
		if (Date.now() > deadline) {
			throw new Error(
				`Timed out acquiring file lock for ${lockDir} after ${timeoutMs}ms`,
			);
		}
		await sleep(RETRY_MS);
	}
}

/**
 * Run `fn` with exclusive cross-process ownership of `filePath`'s lock.
 * In-process callers are chained per path first, so this also replaces the
 * old promise-chain mutexes with identical within-process semantics.
 */
export async function withFileLock<T>(
	filePath: string,
	fn: () => T | Promise<T>,
	options: FileLockOptions = {},
): Promise<T> {
	const lockDir = `${filePath}${LOCK_SUFFIX}`;
	const previous = _chains.get(lockDir) ?? Promise.resolve();
	let releaseChain: () => void = () => {};
	const current = new Promise<void>((resolve) => {
		releaseChain = resolve;
	});
	_chains.set(
		lockDir,
		previous.then(() => current),
	);
	await previous;
	try {
		await acquireDirLock(lockDir, options);
		try {
			return await fn();
		} finally {
			removeLockDir(lockDir);
		}
	} finally {
		releaseChain();
		if (_chains.get(lockDir) === current) _chains.delete(lockDir);
	}
}

/**
 * Write `content` to `filePath` atomically: tmp file in the same directory
 * (same filesystem, so the rename is atomic) + fsync + rename. Readers see
 * either the old or the new file, never a prefix of either. `mode` sets the
 * tmp file's permissions (used for 0600 secret-bearing files); the rename
 * preserves them.
 */
export function writeFileAtomicSync(
	filePath: string,
	content: string,
	mode?: number,
): void {
	ensureDir(dirname(filePath));
	const tmpPath = `${filePath}.tmp.${process.pid}.${_tmpCounter++}`;
	try {
		if (mode !== undefined) {
			writeFileSync(tmpPath, content, { encoding: "utf-8", mode });
		} else {
			writeFileSync(tmpPath, content, "utf-8");
		}
		// Open read/write: Windows refuses to flush a read-only handle
		// (EPERM from FlushFileBuffers), so fsync needs write access.
		const fd = openSync(tmpPath, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			rmSync(tmpPath, { force: true });
		} catch {
			// Best effort: a leftover tmp file is harmless (ignored by readers,
			// overwritten on the next write) and must not mask the real error.
		}
		throw err;
	}
}
