import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";

type TextContent = { type: "text"; text: string };
type KernelToolResult<TDetails = unknown> = { content: TextContent[]; details: TDetails };
type KernelToolCallback<TDetails = unknown> = (partialResult: KernelToolResult<TDetails>) => void;

export type KernelTool = AgentTool<any, any>;

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read." }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write." }),
	content: Type.String({ description: "Full file contents to write." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit." }),
	edits: Type.Optional(
		Type.Array(
			Type.Object({
				oldText: Type.String({ description: "Exact text to replace." }),
				newText: Type.String({ description: "Replacement text." }),
			}),
		),
	),
	oldText: Type.Optional(Type.String({ description: "Legacy single replacement old text." })),
	newText: Type.Optional(Type.String({ description: "Legacy single replacement new text." })),
});

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command to execute." }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })),
});

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list." })),
});

const findSchema = Type.Object({
	pattern: Type.String({ description: "Filename substring or extension to search for." }),
	path: Type.Optional(Type.String({ description: "Directory to search." })),
});

const grepSchema = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression source to search for." }),
	path: Type.Optional(Type.String({ description: "File or directory to search." })),
});

export function createReadTool(cwd: string): KernelTool {
	return {
		name: "read",
		label: "read",
		description: "Read a text file. Use offset and limit for large files.",
		parameters: readSchema,
		execute: async (_toolCallId, params) => {
			const absolutePath = resolvePath(cwd, params.path);
			const content = await readFile(absolutePath, "utf8");
			const lines = content.split("\n");
			const startIndex = Math.max(0, (params.offset ?? 1) - 1);
			const endIndex = params.limit ? startIndex + Math.max(params.limit, 0) : lines.length;
			const sliced = lines.slice(startIndex, endIndex);
			const body = sliced.join("\n");
			const suffix = endIndex < lines.length ? `\n\n[Use offset=${endIndex + 1} to continue reading the file.]` : "";
			return {
				content: [{ type: "text", text: body.length > 0 ? body + suffix : "[Empty file]" }],
				details: { lineCount: sliced.length },
			};
		},
	};
}

export function createWriteTool(cwd: string): KernelTool {
	return {
		name: "write",
		label: "write",
		description: "Create or overwrite a file with the supplied content.",
		parameters: writeSchema,
		execute: async (_toolCallId, params) => {
			const absolutePath = resolvePath(cwd, params.path);
			await mkdir(dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, params.content, "utf8");
			return {
				content: [{ type: "text", text: `Wrote ${params.path}` }],
				details: { bytes: Buffer.byteLength(params.content, "utf8") },
			};
		},
	};
}

export function createEditTool(cwd: string): KernelTool {
	return {
		name: "edit",
		label: "edit",
		description: "Edit a file by exact text replacement.",
		parameters: editSchema,
		prepareArguments: (input) => normalizeEditInput(input as Static<typeof editSchema>),
		execute: async (_toolCallId, rawParams) => {
			const params = normalizeEditInput(rawParams);
			if (!params.edits || params.edits.length === 0) {
				throw new Error("Edit tool requires at least one replacement.");
			}

			const absolutePath = resolvePath(cwd, params.path);
			const original = await readFile(absolutePath, "utf8");
			const next = applyExactEdits(original, params.edits);
			await writeFile(absolutePath, next, "utf8");
			return {
				content: [{ type: "text", text: `Updated ${params.path}` }],
				details: { editsApplied: params.edits.length },
			};
		},
	};
}

export function createBashTool(cwd: string): KernelTool {
	return {
		name: "bash",
		label: "bash",
		description: "Run a shell command in the current working directory.",
		parameters: bashSchema,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const output = await runShellCommand(cwd, params.command, params.timeout, signal, onUpdate);
			return {
				content: [{ type: "text", text: output.text.length > 0 ? output.text : "[Command produced no output]" }],
				details: { exitCode: output.exitCode },
			};
		},
	};
}

export function createLsTool(cwd: string): KernelTool {
	return {
		name: "ls",
		label: "ls",
		description: "List files in a directory.",
		parameters: lsSchema,
		execute: async (_toolCallId, params) => {
			const absolutePath = resolvePath(cwd, params.path ?? ".");
			const entries = (await readdir(absolutePath, { withFileTypes: true }))
				.map((entry) => `${entry.isDirectory() ? "dir" : "file"} ${entry.name}`)
				.sort();
			return {
				content: [{ type: "text", text: entries.join("\n") || "[Empty directory]" }],
				details: { entryCount: entries.length },
			};
		},
	};
}

export function createFindTool(cwd: string): KernelTool {
	return {
		name: "find",
		label: "find",
		description: "Find files by basename substring.",
		parameters: findSchema,
		execute: async (_toolCallId, params) => {
			const root = resolvePath(cwd, params.path ?? ".");
			const matches = await walk(root, (filePath) => filePath.toLowerCase().includes(params.pattern.toLowerCase()));
			return {
				content: [{ type: "text", text: matches.join("\n") || "[No matches]" }],
				details: { matchCount: matches.length },
			};
		},
	};
}

export function createGrepTool(cwd: string): KernelTool {
	return {
		name: "grep",
		label: "grep",
		description: "Search text files with a JavaScript regular expression.",
		parameters: grepSchema,
		execute: async (_toolCallId, params) => {
			const root = resolvePath(cwd, params.path ?? ".");
			const regex = new RegExp(params.pattern, "gm");
			const files = await collectFiles(root);
			const matches: string[] = [];
			for (const filePath of files) {
				if (isProbablyBinary(filePath)) {
					continue;
				}
				let text: string;
				try {
					text = await readFile(filePath, "utf8");
				} catch {
					continue;
				}
				const lines = text.split("\n");
				for (let index = 0; index < lines.length; index += 1) {
					if (regex.test(lines[index] ?? "")) {
						matches.push(`${filePath}:${index + 1}:${lines[index]}`);
					}
					regex.lastIndex = 0;
				}
			}
			return {
				content: [{ type: "text", text: matches.join("\n") || "[No matches]" }],
				details: { matchCount: matches.length },
			};
		},
	};
}

function resolvePath(cwd: string, target: string): string {
	return isAbsolute(target) ? target : resolve(cwd, target);
}

function normalizeEditInput(input: Static<typeof editSchema>): Static<typeof editSchema> {
	if (Array.isArray(input.edits) && input.edits.length > 0) {
		return input;
	}
	if (typeof input.oldText === "string" && typeof input.newText === "string") {
		return {
			path: input.path,
			edits: [{ oldText: input.oldText, newText: input.newText }],
		};
	}
	return input;
}

function applyExactEdits(content: string, edits: ReadonlyArray<{ oldText: string; newText: string }>): string {
	const matches = edits.map((edit) => {
		if (edit.oldText.length === 0) {
			throw new Error("Edit tool oldText must not be empty.");
		}
		const firstIndex = content.indexOf(edit.oldText);
		if (firstIndex === -1) {
			throw new Error(`Could not find the target text: ${edit.oldText.slice(0, 80)}`);
		}
		const secondIndex = content.indexOf(edit.oldText, firstIndex + edit.oldText.length);
		if (secondIndex !== -1) {
			throw new Error(`Edit target is not unique: ${edit.oldText.slice(0, 80)}`);
		}
		return {
			start: firstIndex,
			end: firstIndex + edit.oldText.length,
			newText: edit.newText,
		};
	});

	matches.sort((left, right) => right.start - left.start);
	for (let index = 0; index < matches.length - 1; index += 1) {
		if (matches[index].start < matches[index + 1].end) {
			throw new Error("Edit replacements overlap. Merge nearby changes into a single edit.");
		}
	}

	let next = content;
	for (const match of matches) {
		next = `${next.slice(0, match.start)}${match.newText}${next.slice(match.end)}`;
	}
	return next;
}

async function runShellCommand(
	cwd: string,
	command: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
	onUpdate?: KernelToolCallback<{ exitCode: number | null }>,
): Promise<{ text: string; exitCode: number | null }> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const shell = process.env.SHELL || "/bin/bash";
		const child = spawn(shell, ["-lc", command], {
			cwd,
			env: { ...process.env, PAGER: "cat" },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let output = "";
		let settled = false;
		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		const finalize = (result: { text: string; exitCode: number | null } | Error, isError: boolean): void => {
			if (settled) {
				return;
			}
			settled = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
			signal?.removeEventListener("abort", onAbort);
			if (isError) {
				rejectPromise(result as Error);
			} else {
				resolvePromise(result as { text: string; exitCode: number | null });
			}
		};

		const onChunk = (chunk: Buffer): void => {
			output += chunk.toString("utf8");
			onUpdate?.({
				content: [{ type: "text", text: truncateTail(output) }],
				details: { exitCode: null },
			});
		};

		const onAbort = (): void => {
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 200);
		};

		if (timeoutSeconds && timeoutSeconds > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				onAbort();
			}, timeoutSeconds * 1000);
		}

		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout?.on("data", onChunk);
		child.stderr?.on("data", onChunk);
		child.on("error", (error) => finalize(error, true));
		child.on("close", (code, closeSignal) => {
			if (signal?.aborted) {
				finalize(new Error("Command aborted"), true);
				return;
			}
			if (timedOut) {
				finalize(new Error(`Command timed out after ${timeoutSeconds}s`), true);
				return;
			}
			if (closeSignal) {
				finalize(new Error(`Command terminated by ${closeSignal}`), true);
				return;
			}
			finalize({ text: truncateTail(output), exitCode: code }, false);
		});
	});
}

function truncateTail(text: string, maxChars = 16_000): string {
	if (text.length <= maxChars) {
		return text;
	}
	return `[Output truncated]\n${text.slice(-maxChars)}`;
}

async function walk(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
	const files = await collectFiles(root);
	return files.filter(predicate);
}

async function collectFiles(root: string): Promise<string[]> {
	const rootStats = await stat(root);
	if (rootStats.isFile()) {
		return [root];
	}

	const results: string[] = [];
	const queue = [root];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) {
			continue;
		}
		const entries = await readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name === "node_modules" || entry.name === ".git") {
				continue;
			}
			const absolute = resolve(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(absolute);
			} else if (entry.isFile()) {
				results.push(absolute);
			}
		}
	}
	return results;
}

function isProbablyBinary(filePath: string): boolean {
	const extension = extname(filePath).toLowerCase();
	return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz"].includes(extension);
}
