/**
 * Atomic-file tests (#611).
 *
 * Real filesystem (tmp dir under HOME, same convention as
 * json-persistence.test.ts): the cross-process lock and the tmp+rename
 * contract cannot be observed through the node:fs mock. Uses short lock
 * timeouts so failure modes stay fast; nothing here spawns a process
 * (the two-process race itself is pinned by the probe transcript, not by
 * a test-side spawn).
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withFileLock, writeFileAtomicSync } from "../lib/atomic-file.ts";

const TEST_DIR = join(
	process.env.HOME || process.env.USERPROFILE || "",
	".pi-test-atomic",
);

beforeEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
	mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("writeFileAtomicSync", () => {
	it("writes exact content with no tmp residue", () => {
		const file = join(TEST_DIR, "store.json");
		writeFileAtomicSync(file, '{"n":1}\n');
		expect(readFileSync(file, "utf-8")).toBe('{"n":1}\n');
		const residue = readdirSync(TEST_DIR).filter((entry) =>
			entry.includes(".tmp."),
		);
		expect(residue).toEqual([]);
	});

	it.runIf(process.platform !== "win32")(
		"honors the requested file mode",
		() => {
			const file = join(TEST_DIR, "secret.json");
			writeFileAtomicSync(file, "{}\n", 0o600);
			// eslint-disable-next-line no-bitwise
			expect(statSync(file).mode & 0o777).toBe(0o600);
		},
	);

	it("replaces existing content atomically", () => {
		const file = join(TEST_DIR, "store.json");
		writeFileSync(file, '{"n":1}\n');
		writeFileAtomicSync(file, '{"n":2}\n');
		expect(readFileSync(file, "utf-8")).toBe('{"n":2}\n');
	});
});

describe("withFileLock", () => {
	it("serializes concurrent critical sections", async () => {
		const file = join(TEST_DIR, "store.json");
		const events: string[] = [];
		await Promise.all(
			[1, 2, 3, 4].map((i) =>
				withFileLock(file, async () => {
					events.push(`enter${i}`);
					await new Promise((resolve) => setTimeout(resolve, 5));
					events.push(`exit${i}`);
				}),
			),
		);
		let depth = 0;
		let maxDepth = 0;
		for (const event of events) {
			depth += event.startsWith("enter") ? 1 : -1;
			maxDepth = Math.max(maxDepth, depth);
		}
		expect(maxDepth).toBe(1);
	});

	it("returns the function value and releases the lock afterwards", async () => {
		const file = join(TEST_DIR, "store.json");
		const result = await withFileLock(file, async () => "ok");
		expect(result).toBe("ok");
		expect(existsSync(`${file}.lock`)).toBe(false);
	});

	it("releases the lock when the function throws", async () => {
		const file = join(TEST_DIR, "store.json");
		await expect(
			withFileLock(file, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(existsSync(`${file}.lock`)).toBe(false);
		// The next acquisition proceeds normally.
		await expect(withFileLock(file, async () => "ok")).resolves.toBe("ok");
	});

	it("busts a lock held by a dead pid", async () => {
		const file = join(TEST_DIR, "store.json");
		const lockDir = `${file}.lock`;
		mkdirSync(lockDir);
		writeFileSync(
			`${lockDir}/info.json`,
			JSON.stringify({ pid: 999999999, time: Date.now() }),
		);
		await expect(withFileLock(file, async () => "ok")).resolves.toBe("ok");
	});

	it("busts a lock older than the staleness cap", async () => {
		const file = join(TEST_DIR, "store.json");
		const lockDir = `${file}.lock`;
		mkdirSync(lockDir);
		writeFileSync(
			`${lockDir}/info.json`,
			// Live pid but ancient: the age cap decides, not pid liveness.
			JSON.stringify({ pid: process.pid, time: 0 }),
		);
		await expect(
			withFileLock(file, async () => "ok", { staleMs: 1 }),
		).resolves.toBe("ok");
	});

	it("times out instead of hanging on a wedged lock", async () => {
		const file = join(TEST_DIR, "store.json");
		// Plant a FRESH lock held by this live process directly: the contender
		// must wait on the directory (not on an in-process chain) and give up.
		const lockDir = `${file}.lock`;
		mkdirSync(lockDir);
		writeFileSync(
			`${lockDir}/info.json`,
			JSON.stringify({ pid: process.pid, time: Date.now() }),
		);
		await expect(
			withFileLock(file, async () => "ok", { timeoutMs: 60 }),
		).rejects.toThrow(/Timed out acquiring file lock/);
	});
});
