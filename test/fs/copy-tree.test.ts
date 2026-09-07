import { describe, test } from "node:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { copyTreeCoW } from "../../chhound/hotstart.js";
import { check } from "../lib/checks.js";
import { makeFixtureRoot } from "../lib/isolation.js";

// Inventory: 9 legacy checks moved from smoke.ts section 12 (copyTreeCoW).
// CHHOUND_COPY_FORCE override is restored with presence AND value (an outer
// forced mode survives). Deterministic on every platform: clone attempt or
// silent fallback must both yield byte-identical trees; stale .cow-tmp /
// .cow-bak crash residue is swept before a copy.
// The free-space proof test below adds 4 non-legacy checks (clone xor
// full-copy classification + write-divergence space accounting) — it makes
// the CoW mechanism OBSERVABLE where the legacy checks are deliberately
// agnostic. The darwin-only test adds 2 more: F_LOG2PHYS physical-block
// sharing proves the clone at inode level and its COW divergence on write.

describe("copyTreeCoW", () => {
	test("legacy copyTreeCoW obligations", async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-copy-tree-");
		try {
			// Tree snapshot: sorted "d <rel>" for dirs, "<rel> <sha256>" for files.
			const tree = (treeRoot: string): string => {
				const out: string[] = [];
				const walk = (dir: string) => {
					for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
						const p = path.join(dir, e.name);
						const rel = path.relative(treeRoot, p);
						if (e.isDirectory()) {
							out.push(`d ${rel}`);
							walk(p);
						} else {
							out.push(`${rel} ${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`);
						}
					}
				};
				walk(treeRoot);
				return out.join("\n");
			};
			const src = path.join(root, "cow-src");
			fs.mkdirSync(path.join(src, "sub"), { recursive: true });
			fs.writeFileSync(path.join(src, "a.txt"), "alpha\n");
			fs.writeFileSync(path.join(src, "sub", "b.bin"), Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]));
			fs.mkdirSync(path.join(src, "sub", "empty"));
			const srcSnap = tree(src);

			// Forced fallback (CHHOUND_COPY_FORCE=1 — the deterministic seam for the
			// plain-copy path): must produce a byte-identical tree. The prior env
			// value is restored, not deleted, so an outer forced mode survives.
			const priorForce = process.env.CHHOUND_COPY_FORCE;
			process.env.CHHOUND_COPY_FORCE = "1";
			let forcedOk = false;
			try {
				const dst = path.join(root, "cow-dst-force");
				copyTreeCoW(src, dst);
				forcedOk = tree(dst) === srcSnap;
			} finally {
				if (priorForce === undefined) delete process.env.CHHOUND_COPY_FORCE;
				else process.env.CHHOUND_COPY_FORCE = priorForce;
			}
			await check(t, "forced fallback copy is byte-identical", forcedOk, forcedOk ? "" : tree(path.join(root, "cow-dst-force")));

			// Normal path: clone attempt when the fs supports it, silent fallback
			// otherwise (this devcontainer's overlayfs falls back) — either way the
			// result must be byte-identical and no tmp residue may remain.
			const dst = path.join(root, "cow-dst");
			copyTreeCoW(src, dst);
			await check(t, "normal path byte-identical (clone or fallback)", tree(dst) === srcSnap, "");
			const leftovers = fs.readdirSync(root).filter((n) => n.startsWith("cow-dst.") && n.endsWith(".cow-tmp"));
			await check(t, "no cow tmp residue next to dst", leftovers.length === 0, leftovers.join(","));

			// Overwrite an existing dst (retry-after-failure shape): src files must
			// be byte-identical afterwards under BOTH semantics (clone → whole-dir
			// replace; fallback → cpSync merge overwrites matching files; whether a
			// stale dst-only file survives is deliberately platform-dependent and
			// not asserted).
			fs.writeFileSync(path.join(dst, "a.txt"), "stale\n");
			fs.writeFileSync(path.join(dst, "stale.txt"), "stale\n");
			copyTreeCoW(src, dst);
			await check(
				t,
				"overwrite of existing dst restores src bytes",
				fs.readFileSync(path.join(dst, "a.txt"), "utf8") === "alpha\n" &&
					fs.readFileSync(path.join(dst, "sub", "b.bin")).equals(Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255])),
				"",
			);
			const leftovers2 = fs.readdirSync(root).filter((n) => n.startsWith("cow-dst.") && n.endsWith(".cow-tmp"));
			await check(t, "overwrite leaves no cow tmp residue", leftovers2.length === 0, leftovers2.join(","));

			// Guards + crash-residue sweep (deterministic on every platform): a file
			// at dst is refused when src is a directory (dir→file, as before),
			// overlap is refused, and stale .cow-tmp/.cow-bak siblings from a
			// crashed run are swept before the copy.
			const fileDst = path.join(root, "cow-file-dst");
			fs.writeFileSync(fileDst, "i am a file\n");
			const fileRefused = (() => {
				try {
					copyTreeCoW(src, fileDst);
					return false;
				} catch (e) {
					return (e as Error).message.includes("not a directory");
				}
			})();
			await check(t, "dir src over file dst refused (not replaced silently)", fileRefused && fs.readFileSync(fileDst, "utf8") === "i am a file\n", "");

			// File→file overwrite is the REAL rerun shape (the db at the target is a
			// file after the engine has run): must replace atomically, byte-identical.
			const fileSrc = path.join(root, "cow-file-src");
			const fileDst2 = path.join(root, "cow-file-dst2");
			fs.writeFileSync(fileSrc, Buffer.from([9, 8, 7, 6, 5]));
			fs.writeFileSync(fileDst2, "stale bytes\n");
			copyTreeCoW(fileSrc, fileDst2);
			await check(
				t,
				"file over existing file replaced byte-identically",
				fs.readFileSync(fileDst2).equals(Buffer.from([9, 8, 7, 6, 5])) &&
					fs.readdirSync(root).filter((n) => n.startsWith("cow-file-dst2.") && n.endsWith(".cow-tmp")).length === 0,
				"",
			);
			const overlapRefused = (() => {
				try {
					copyTreeCoW(path.join(src, "sub"), src);
					return false;
				} catch (e) {
					return (e as Error).message.includes("overlap");
				}
			})();
			await check(t, "overlapping src/dst refused", overlapRefused, "");
			const sweptDst = path.join(root, "cow-sweep-dst");
			const litterA = `${sweptDst}.999.cow-tmp`;
			const litterB = `${sweptDst}.999.cow-bak`;
			fs.mkdirSync(litterA, { recursive: true });
			fs.writeFileSync(path.join(litterA, "junk"), "junk\n");
			fs.mkdirSync(litterB, { recursive: true });
			copyTreeCoW(src, sweptDst);
			const swept = !fs.existsSync(litterA) && !fs.existsSync(litterB);
			await check(t, "crash residue (.cow-tmp/.cow-bak) swept before copy", swept && tree(sweptDst) === srcSnap, swept ? "" : "residue survived");
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	// Free-space proof (df -P -k deltas around the production primitive): the
	// forced plain copy is the ground-truth control `a`; the normal clone
	// attempt is `b`. Ratio classification on a 4×16MiB incompressible tree:
	// b < a/4 → real clone; b > 3a/4 → full-copy fallback; anything between →
	// per-file partial clone (macOS cp -c degrades PER FILE) or measurement
	// noise → failure. This cannot flake-red on filesystem capability
	// differences (APFS/ext4/tmpfs/overlayfs/btrfs all report a consistent
	// verdict); it only fails on behavioral inconsistency. A transient
	// background write on the runner may distort one measurement — one retry.
	test("clone attempt is provably clone xor full copy (df free-space deltas)", async (t) => {
		const kib = 64 * 1024;
		const root = await makeFixtureRoot("pi-chhound-fs-cow-proof-");
		try {
			const src = path.join(root, "proof-src");
			fs.mkdirSync(src, { recursive: true });
			const blob = randomBytes(16 * 1024 * 1024);
			for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(src, `blob-${i}.bin`), blob);
			const dfAvail = (dir: string): number => {
				const r = spawnSync("df", ["-P", "-k", dir], { encoding: "utf8" });
				const lines = typeof r.stdout === "string" ? r.stdout.trim().split("\n") : [];
				const avail = Number((lines[lines.length - 1] ?? "").trim().split(/\s+/)[3]);
				if (r.status !== 0 || !Number.isFinite(avail)) throw new Error(`df parse failed (${r.status}): ${r.stderr ?? r.stdout ?? ""}`);
				return avail;
			};
			const measure = (forced: boolean): number => {
				const dst = path.join(root, forced ? "proof-dst-force" : "proof-dst");
				const prior = process.env.CHHOUND_COPY_FORCE;
				let delta: number;
				try {
					// Presence+value restoration: the normal-path measurement
					// temporarily clears an OUTER forced mode so the clone attempt
					// is actually exercised; both runs restore exactly.
					if (forced) process.env.CHHOUND_COPY_FORCE = "1";
					else if (prior === "1") delete process.env.CHHOUND_COPY_FORCE;
					const before = dfAvail(root);
					copyTreeCoW(src, dst);
					delta = before - dfAvail(root);
				} finally {
					if (prior === undefined) delete process.env.CHHOUND_COPY_FORCE;
					else process.env.CHHOUND_COPY_FORCE = prior;
				}
				fs.rmSync(dst, { recursive: true, force: true });
				return delta;
			};
			const classify = (a: number, b: number): "clone" | "full" | "inconclusive" =>
				b < a / 4 ? "clone" : b > (a * 3) / 4 ? "full" : "inconclusive";
			let a = measure(true);
			let b = measure(false);
			let verdict = classify(a, b);
			if (verdict === "inconclusive") {
				// One retry absorbs transient background writes on the runner.
				a = measure(true);
				b = measure(false);
				verdict = classify(a, b);
			}
			await check(t, "df control: forced plain copy consumes ≈ tree size", a > kib / 2 && a < kib * 2, `a=${a}KiB tree=${kib}KiB`);
			if (verdict === "clone") {
				await check(t, "copyTreeCoW clone attempt performs a REAL clone (df delta ≈ 0)", true, `a=${a}KiB b=${b}KiB → CLONE`);
			} else if (verdict === "full") {
				await check(t, "copyTreeCoW clone attempt provably fell back to a FULL copy (df delta ≈ control)", true, `a=${a}KiB b=${b}KiB → FULL COPY`);
			} else {
				await check(t, "copyTreeCoW clone attempt is clone xor full copy (df delta)", false, `a=${a}KiB b=${b}KiB → PARTIAL/INCONCLUSIVE (per-file silent degrade or measurement noise)`);
			}

			// CoW write-divergence semantics (portable, verdict-aware): a REAL
			// clone shares extents, so rewriting one dst file must allocate fresh
			// blocks (~file size); an independent copy rewrites its private
			// extents in place (~0). Either way the src bytes are untouched —
			// that is the observable copy-on-write contract.
			const fileKib = 16 * 1024;
			const srcHashes = (): string =>
				["blob-0.bin", "blob-1.bin", "blob-2.bin", "blob-3.bin"]
					.map((n) => createHash("sha256").update(fs.readFileSync(path.join(src, n))).digest("hex"))
					.join("\n");
			const srcBefore = srcHashes();
			const divDst = path.join(root, "proof-div");
			const priorForce = process.env.CHHOUND_COPY_FORCE;
			try {
				// The verdict was measured with force cleared; this copy must run
				// the same clone attempt so the accounting arm stays consistent
				// with the classification (presence+value restoration).
				if (priorForce === "1") delete process.env.CHHOUND_COPY_FORCE;
				copyTreeCoW(src, divDst);
			} finally {
				if (priorForce === undefined) delete process.env.CHHOUND_COPY_FORCE;
				else process.env.CHHOUND_COPY_FORCE = priorForce;
			}
			const availBeforeMutate = dfAvail(root);
			fs.writeFileSync(path.join(divDst, "blob-0.bin"), randomBytes(16 * 1024 * 1024));
			const mutateDelta = availBeforeMutate - dfAvail(root);
			const srcUntouched = srcHashes() === srcBefore;
			await check(t, "mutating a dst file leaves src byte-identical (CoW divergence)", srcUntouched && !fs.readFileSync(path.join(divDst, "blob-0.bin")).equals(blob), "");
			const divergenceOk = verdict === "clone" ? mutateDelta > fileKib / 2 : verdict === "full" ? mutateDelta < fileKib / 4 : false;
			await check(t, "write-divergence space accounting matches the clone/full verdict", divergenceOk, `verdict=${verdict} mutateDelta=${mutateDelta}KiB file=${fileKib}KiB`);
			fs.rmSync(divDst, { recursive: true, force: true });
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});

	// macOS/APFS-only: fcntl(F_LOG2PHYS_EXT) maps logical file offsets to
	// physical device offsets. Two files sharing EVERY block are clones;
	// after a copy-on-write rewrite of one side the mapping diverges. The
	// probe is a tiny C helper (test/lib/f2p-clones.c, MIT-derived)
	// compiled with cc at test time — macOS runners ship Xcode CLT. Skipped
	// on other platforms with a visible skip reason (portability policy).
	test("darwin: F_LOG2PHYS proves physical block sharing + COW divergence", { skip: process.platform === "darwin" ? false : "macOS/APFS-only probe (fcntl F_LOG2PHYS)" }, async (t) => {
		const root = await makeFixtureRoot("pi-chhound-fs-cow-f2p-");
		try {
			const c = spawnSync("cc", ["-O1", "-o", path.join(root, "f2p-clones"), path.join(import.meta.dirname, "..", "lib", "f2p-clones.c")], { encoding: "utf8" });
			if (c.status !== 0) throw new Error(`cc compile failed: ${c.error ? String(c.error) : (c.stderr ?? c.stdout)}`);
			const probe = (a: string, b: string): string => {
				const r = spawnSync(path.join(root, "f2p-clones"), [a, b], { encoding: "utf8" });
				if (r.status !== 0) throw new Error(`f2p-clones failed (${r.status}): ${r.error ? String(r.error) : (r.stderr ?? r.stdout)}`);
				return (r.stdout ?? "").trim();
			};
			const srcDir = path.join(root, "src");
			fs.mkdirSync(srcDir);
			const blobA = randomBytes(4 * 1024 * 1024);
			fs.writeFileSync(path.join(srcDir, "blob.bin"), blobA);
			const priorForce = process.env.CHHOUND_COPY_FORCE;
			try {
				// Same outer-force discipline as the divergence arm above: this
				// copy must attempt the clone (presence+value restoration).
				if (priorForce === "1") delete process.env.CHHOUND_COPY_FORCE;
				copyTreeCoW(srcDir, path.join(root, "dst"));
			} finally {
				if (priorForce === undefined) delete process.env.CHHOUND_COPY_FORCE;
				else process.env.CHHOUND_COPY_FORCE = priorForce;
			}
			const srcFile = path.join(srcDir, "blob.bin");
			const dstFile = path.join(root, "dst", "blob.bin");
			const shared = probe(srcFile, dstFile);
			await check(t, "darwin: dst shares PHYSICAL blocks with src after copyTreeCoW (F_LOG2PHYS=1)", shared === "1", `probe=${shared}`);
			const blobB = randomBytes(4 * 1024 * 1024);
			fs.writeFileSync(dstFile, blobB);
			const diverged = probe(srcFile, dstFile);
			await check(
				t,
				"darwin: COW divergence — rewritten dst no longer shares blocks (F_LOG2PHYS=0)",
				diverged === "0" && fs.readFileSync(srcFile).equals(blobA) && !fs.readFileSync(dstFile).equals(blobA),
				`probe=${diverged}`,
			);
		} finally {
			await fs.promises.rm(root, { recursive: true, force: true });
		}
	});
});
