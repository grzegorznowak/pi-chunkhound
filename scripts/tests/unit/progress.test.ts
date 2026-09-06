import { describe, test } from "node:test";
import { buildWidgetLines, classifyChhoundLine, filledCells, formatBytes, groupDigits } from "../../../chhound/progress.js";
import type { ProgressState } from "../../../chhound/progress.js";
import { check } from "../lib/checks.js";

// Inventory: 26 legacy checks moved from smoke.ts section 2 (progress extraction).
describe("progress extraction", () => {
	test("legacy progress obligations", async (t) => {
		const D = "2026-08-30 13:31:02 | DEBUG    | chunkhound.services.embedding_service:process_batch:516 - ";
		const W = "2026-08-30 13:31:02 | WARNING  | chunkhound.services.embedding_service:process_batch:516 - ";
		const I = "2026-08-30 13:31:02 | INFO     | chunkhound.providers.database.duckdb_provider:_executor_create_schema:1577 - Creating DuckDB schema";

		const b1 = classifyChhoundLine(D + "Processing batch 2/3 with 300 chunks");
		await check(t, "batch line classified (loguru prefix)", b1.kind === "batch" && b1.current === 2 && b1.total === 3 && b1.chunks === 300, JSON.stringify(b1));
		const d1 = classifyChhoundLine("2026-08-30 13:31:08 | DEBUG    | chunkhound.services.embedding_service:process_batch:564 - Batch 2 completed: 300 embeddings stored");
		await check(t, "batch-done classified", d1.kind === "batchDone" && d1.n === 2, JSON.stringify(d1));
		const p1 = classifyChhoundLine("2026-09-02 09:07:57 | DEBUG    | chunkhound.services.indexing_coordinator:_process_files_in_batches:724 - Parsing 400 files with 8 workers (timeout=3.0s, max_concurrent=auto)");
		await check(t, "parse-total classified", p1.kind === "parseTotal" && p1.files === 400, JSON.stringify(p1));
		const s1 = classifyChhoundLine("2026-09-02 09:07:57 | DEBUG    | chunkhound.services.indexing_coordinator:_store_parsed_results:1145 - Batch inserted 40 chunks for file_id 2");
		await check(t, "file-stored classified", s1.kind === "fileStored", JSON.stringify(s1));
		const s2 = classifyChhoundLine("2026-09-02 09:07:57 | DEBUG    | chunkhound.services.indexing_coordinator:process_file_batch:1568 - Skipped file: /x/a.ts (reason: unsupported)");
		await check(t, "file-skipped classified", s2.kind === "fileSkipped", JSON.stringify(s2));
		const w1 = classifyChhoundLine(W + "Embedding generation failed");
		await check(t, "warning classified as event, prefix stripped", w1.kind === "event" && w1.level === "WARNING" && w1.message === "Embedding generation failed", JSON.stringify(w1));
		await check(t, "loguru DEBUG chatter is noise", classifyChhoundLine(D + "Preparing data").kind === "noise");
		await check(t, "loguru INFO is noise", classifyChhoundLine(I).kind === "noise");
		await check(t, "stdout banner is noise", classifyChhoundLine("ChunkHound Indexing").kind === "noise");
		await check(t, "stdout db path is noise", classifyChhoundLine("Database: /x/.cache/pi-chhound/bases/x/main/db/.chhound.db").kind === "noise");
		await check(t, "stdout success tag is noise", classifyChhoundLine("[SUCCESS] Service layer initialized: /x/db/.chhound.db").kind === "noise");
		await check(t, "stdout initial stats is noise", classifyChhoundLine("Initial stats: 4 files, 122 chunks, 0 embeddings").kind === "noise");
		await check(t, "stdout summary is noise", classifyChhoundLine("Processing Complete").kind === "noise");
		await check(t, "stage marker recognized", classifyChhoundLine("[DEBUG] Discovering files...").kind === "marker");
		await check(t, "embedding-check marker recognized", classifyChhoundLine("[DEBUG] Checking for missing embeddings...").kind === "marker");

		await check(t, "filledCells rounding", filledCells(0.62, 10) === 6 && filledCells(1, 10) === 10 && filledCells(0, 40) === 0, `${filledCells(0.62, 10)}`);
		await check(t, "groupDigits", groupDigits(1412) === "1,412" && groupDigits(12) === "12", groupDigits(1412));
		await check(t, "formatBytes", formatBytes(1024 * 1024 * 5.3) === "5.3 MB", formatBytes(1024 * 1024 * 5.3));

		const wl = (state: Partial<ProgressState>) => buildWidgetLines({ phase: "baseline index", events: [], tick: 0, elapsedMs: 72_000, ...state });
		const wlChunk = wl({ filesTotal: 1412, filesDone: 636 });
		await check(t, "widget: chunking header", wlChunk[0] === "baseline index — chunking · 1:12", JSON.stringify(wlChunk[0]));
		await check(t, "widget: chunking rail + pct", wlChunk[1] === "██████████████████" + "░".repeat(22) + " 45% · 636/1,412 files", JSON.stringify(wlChunk[1]));
		const wlEmbed = wl({ batchesTotal: 12, batchesDone: 5 });
		await check(t, "widget: embedding header", wlEmbed[0] === "baseline index — embedding · 1:12", JSON.stringify(wlEmbed[0]));
		await check(t, "widget: embedding rail + pct", wlEmbed[1] === "█".repeat(17) + "░".repeat(23) + " 42% · 5/12 batches", JSON.stringify(wlEmbed[1]));
		const wlDone = wl({ filesTotal: 1412, filesDone: 1412 });
		await check(t, "widget: pass done → finalizing + done text", wlDone[0] === "baseline index — finalizing · 1:12" && wlDone[1] === "█".repeat(40) + " done · 1,412/1,412 files", JSON.stringify(wlDone));
		const wlNote = wl({ note: "baseline fresh (main @ 623e5c6)" });
		await check(t, "widget: note stage", wlNote[0] === "baseline index — baseline fresh (main @ 623e5c6) · 1:12", JSON.stringify(wlNote[0]));
		await check(t, "widget: indeterminate sweep at tick 0", wlNote[1] === "█".repeat(4) + "░".repeat(36), JSON.stringify(wlNote[1]));
		const wlEv = wl({ batchesTotal: 12, batchesDone: 5, events: ["Embedding generation failed", "Batch 7: Expected 300 embeddings, got 0"] });
		await check(t, "widget: event lines", wlEv[2] === "⚠ Embedding generation failed" && wlEv[3] === "⚠ Batch 7: Expected 300 embeddings, got 0", JSON.stringify(wlEv));
	});
});
