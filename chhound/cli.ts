import { spawn } from "node:child_process";

export interface RunChhoundOptions {
	cwd?: string;
	env?: Record<string, string | undefined>;
	/** Called per complete output line (stdout+stderr merged, trimmed, non-empty). */
	onLine?: (line: string) => void;
	signal?: AbortSignal;
	/** Captured output cap per stream (default 64 KB) — prevents unbounded memory on long runs. */
	maxCaptured?: number;
}

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Binary name/location — overridable via CHHOUND_BINARY. */
export function chhoundBinary(): string {
	return process.env.CHHOUND_BINARY || "chunkhound";
}

/** Env injection for the embedding key — held in memory only, never on disk. */
export function chhoundApiKeyEnv(apiKey?: string): Record<string, string> | undefined {
	return apiKey ? { CHUNKHOUND_EMBEDDING__API_KEY: apiKey } : undefined;
}

function appendCapped(buf: string, text: string, cap: number): string {
	const next = buf + text;
	return next.length > cap ? next.slice(next.length - cap) : next;
}

export function runChhound(args: string[], opts: RunChhoundOptions = {}): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(chhoundBinary(), args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const cap = opts.maxCaptured ?? 64 * 1024;
		let stdout = "";
		let stderr = "";
		let pending = "";

		const onData = (chunk: Buffer, stream: "out" | "err") => {
			const text = chunk.toString();
			if (stream === "out") stdout = appendCapped(stdout, text, cap);
			else stderr = appendCapped(stderr, text, cap);
			if (!opts.onLine) return;
			const combined = pending + text;
			const lines = combined.split("\n");
			pending = lines.pop() ?? "";
			for (const line of lines) {
				const t = line.trim();
				if (t) opts.onLine(t);
			}
		};

		child.stdout.on("data", (d: Buffer) => onData(d, "out"));
		child.stderr.on("data", (d: Buffer) => onData(d, "err"));
		child.on("error", (e) => reject(e));
		child.on("close", (code) => {
			if (pending.trim() && opts.onLine) opts.onLine(pending.trim());
			resolve({ code: code ?? -1, stdout, stderr });
		});
		opts.signal?.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
	});
}

export async function chhoundVersion(): Promise<string> {
	try {
		const r = await runChhound(["--version"], { maxCaptured: 4096 });
		return r.code === 0 ? r.stdout.split("\n")[0]!.trim() : "unknown";
	} catch {
		return "unknown";
	}
}
