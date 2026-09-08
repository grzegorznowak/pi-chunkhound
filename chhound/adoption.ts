import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { copyTreeCoW, indexedRootSidecarPath } from "./hotstart.js";

// Adoption copies a validated external index into a private, file-shaped slot.
// The source is sampled once, then checked before and after the copy so a
// caller-held read-only lease can make the three observations coherent.

const MAX_METADATA_BYTES = 256 * 1024;

type Source = {
	configPath: string;
	dbPath: string;
	expectedRoot: string;
};

type Options = {
	targetDbPath: string;
	sameDevice?: boolean;
	forcePlainCopy?: boolean;
	onPhase?: (phase: "beforeCopy" | "afterCopy") => void | Promise<void>;
};

type Outcome = { kind: "copied"; warnings: string[] } | { kind: "rejected"; reason: string };

// Identity fields compared for drift. ctimeMs/birthtimeMs are incarnation
// signals userland cannot restore: utimes rewrites atime/mtime but bumps
// ctime, and a recreated file gets a fresh birthtime. They keep replacement
// detectable even on filesystems that reuse inode numbers after delete.
type FileIdentity = {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
	birthtimeMs: number;
};

type MetadataIdentity = FileIdentity & { sha256: string };

type Snapshot = {
	config: MetadataIdentity;
	claim: MetadataIdentity;
	db: FileIdentity;
	claimBytes: Buffer;
};

function digest(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.birthtimeMs === right.birthtimeMs
	);
}

function readBounded(pathname: string, capBytes: number): { identity: MetadataIdentity; bytes: Buffer } {
	const fd = fs.openSync(pathname, "r");
	try {
		const before = fs.fstatSync(fd);
		if (!before.isFile()) throw new Error(`${pathname} is not a regular file`);
		const chunks: Buffer[] = [];
		const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, capBytes + 1));
		let total = 0;
		while (total <= capBytes) {
			const length = Math.min(buffer.length, capBytes + 1 - total);
			const count = fs.readSync(fd, buffer, 0, length, null);
			if (count === 0) break;
			chunks.push(Buffer.from(buffer.subarray(0, count)));
			total += count;
		}
		if (total > capBytes) throw new Error(`${pathname} exceeds 256 KiB`);
		const after = fs.fstatSync(fd);
		const identity = {
			dev: after.dev,
			ino: after.ino,
			size: after.size,
			mtimeMs: after.mtimeMs,
			ctimeMs: after.ctimeMs,
			birthtimeMs: after.birthtimeMs,
			sha256: digest(Buffer.concat(chunks, total)),
		};
		if (!sameFileIdentity(before, after) || total !== after.size) {
			throw new Error(`${pathname} changed while it was being validated`);
		}
		return { identity, bytes: Buffer.concat(chunks, total) };
	} finally {
		fs.closeSync(fd);
	}
}

function statIdentity(pathname: string): FileIdentity {
	const stat = fs.statSync(pathname);
	if (!stat.isFile()) throw new Error(`${pathname} is not a regular file`);
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, birthtimeMs: stat.birthtimeMs };
}

function sameMetadataIdentity(left: MetadataIdentity, right: MetadataIdentity): boolean {
	return sameFileIdentity(left, right) && left.sha256 === right.sha256;
}

function readSnapshot(source: Source): Snapshot {
	const config = readBounded(source.configPath, MAX_METADATA_BYTES);
	try {
		JSON.parse(config.bytes.toString("utf8"));
	} catch {
		throw new Error(`invalid adoption config: ${source.configPath}`);
	}

	const claimPath = indexedRootSidecarPath(source.dbPath);
	const claim = readBounded(claimPath, MAX_METADATA_BYTES);
	let parsed: unknown;
	try {
		parsed = JSON.parse(claim.bytes.toString("utf8"));
	} catch {
		throw new Error(`invalid indexed-root claim: ${claimPath}`);
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as { version?: unknown }).version !== 1 ||
		(parsed as { indexed_root_path?: unknown }).indexed_root_path !== source.expectedRoot
	) {
		throw new Error(`indexed-root claim does not match ${source.expectedRoot}`);
	}

	const db = statIdentity(source.dbPath);
	return { config: config.identity, claim: claim.identity, db, claimBytes: claim.bytes };
}

function snapshotMatches(captured: Snapshot, current: Snapshot): boolean {
	return (
		sameMetadataIdentity(captured.config, current.config) &&
		sameMetadataIdentity(captured.claim, current.claim) &&
		sameFileIdentity(captured.db, current.db) &&
		captured.claimBytes.equals(current.claimBytes)
	);
}

function atomicWrite(pathname: string, bytes: Buffer): void {
	fs.mkdirSync(path.dirname(pathname), { recursive: true });
	const tmp = `${pathname}.${process.pid}.${Date.now()}.adopt-tmp`;
	try {
		fs.writeFileSync(tmp, bytes);
		fs.renameSync(tmp, pathname);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function plainCopy(sourcePath: string, targetPath: string): void {
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	const tmp = `${targetPath}.${process.pid}.${Date.now()}.adopt-tmp`;
	try {
		fs.copyFileSync(sourcePath, tmp);
		fs.renameSync(tmp, targetPath);
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
}

function cleanTarget(targetDbPath: string): void {
	const dir = path.dirname(targetDbPath);
	const base = path.basename(targetDbPath);
	const owned = new Set([base, path.basename(indexedRootSidecarPath(targetDbPath))]);
	try {
		for (const name of fs.readdirSync(dir)) {
			if (
				name.startsWith(`${base}.`) &&
				(name.endsWith(".cow-tmp") || name.endsWith(".cow-bak") || name.endsWith(".adopt-tmp"))
			) {
				owned.add(name);
			}
		}
	} catch {
		// A missing or unreadable target directory does not prevent exact-path cleanup.
	}
	for (const name of owned) {
		try {
			fs.rmSync(path.join(dir, name), { recursive: true, force: true });
		} catch {
			// Continue so one failed removal cannot prevent cleanup of the others.
		}
	}
	for (const name of owned) {
		const pathname = path.join(dir, name);
		try {
			if (fs.existsSync(pathname)) fs.rmSync(pathname, { recursive: true, force: true });
		} catch {
			// Cleanup is best-effort and must not replace the rejected outcome.
		}
	}
}

function rejectionReason(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function copyAdoptedIndex(source: Source, options: Options): Promise<Outcome> {
	const warnings: string[] = [];
	try {
		const captured = readSnapshot(source);
		await options.onPhase?.("beforeCopy");

		const beforeCopy = readSnapshot(source);
		if (!snapshotMatches(captured, beforeCopy)) throw new Error("adoption source changed before copy");

		fs.mkdirSync(path.dirname(options.targetDbPath), { recursive: true });
		const sameDevice =
			options.sameDevice ??
			fs.statSync(source.dbPath).dev === fs.statSync(path.dirname(options.targetDbPath)).dev;
		const usePlainCopy = options.forcePlainCopy === true || !sameDevice;
		if (usePlainCopy) {
			warnings.push("cross-device or forced plain copy used; copy-on-write unavailable.");
			warnings.push(`plain copy size: ${captured.db.size} bytes.`);
			plainCopy(source.dbPath, options.targetDbPath);
		} else {
			copyTreeCoW(source.dbPath, options.targetDbPath);
		}

		atomicWrite(indexedRootSidecarPath(options.targetDbPath), captured.claimBytes);
		await options.onPhase?.("afterCopy");

		const afterCopy = readSnapshot(source);
		if (!snapshotMatches(captured, afterCopy)) throw new Error("adoption source changed during copy");
		const target = statIdentity(options.targetDbPath);
		if (target.size !== captured.db.size) throw new Error("adoption target does not match source size");
		const targetClaim = readBounded(indexedRootSidecarPath(options.targetDbPath), MAX_METADATA_BYTES).bytes;
		if (!targetClaim.equals(captured.claimBytes)) throw new Error("adoption target claim is missing or changed");

		return { kind: "copied", warnings };
	} catch (error) {
		cleanTarget(options.targetDbPath);
		return { kind: "rejected", reason: rejectionReason(error) };
	}
}
