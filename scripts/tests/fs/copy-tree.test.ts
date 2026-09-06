import { describe, test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { copyTreeCoW } from "../../../chhound/hotstart.js";
import { check } from "../lib/checks.js";
import { makeFixtureRoot } from "../lib/isolation.js";

// Inventory: 9 legacy checks moved from smoke.ts section 12 (copyTreeCoW).
// CHHOUND_COPY_FORCE override is restored with presence AND value (an outer
// forced mode survives). Deterministic on every platform: clone attempt or
// silent fallback must both yield byte-identical trees; stale .cow-tmp /
// .cow-bak crash residue is swept before a copy.

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
});
