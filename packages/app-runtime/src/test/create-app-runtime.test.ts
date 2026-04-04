import { describe, expect, it } from "vitest";
import { createAppRuntime } from "../create-app-runtime.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { ModelDescriptor } from "../types/index.js";
import { StubPiSessionAdapter } from "./stubs/stub-pi-session-adapter.js";

const stubModel: ModelDescriptor = { id: "test-model", provider: "test" };

describe("createAppRuntime", () => {
	it("creates a runtime with an event bus", () => {
		const adapter = new StubPiSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		expect(runtime.events).toBeDefined();
	});

	it("createSession returns an active SessionFacade", () => {
		const adapter = new StubPiSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		const session = runtime.createSession();

		expect(session.state.status).toBe("active");
		expect(session.id.value).toBeTruthy();
		expect(session.context.mode).toBe("print");
		expect(session.context.workingDirectory).toBe("/tmp");
		expect(session.context.model).toEqual(stubModel);
	});

	it("createSession emits session_created on global bus", () => {
		const adapter = new StubPiSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "json",
			model: stubModel,
			adapter,
		});

		const events: RuntimeEvent[] = [];
		runtime.events.on("session_created", (e) => events.push(e));

		runtime.createSession();

		expect(events).toHaveLength(1);
		expect(events[0]!.category).toBe("session");
		if (events[0]!.type === "session_created") {
			expect(events[0]!.model).toEqual(stubModel);
		}
	});

	it("recoverSession restores state and emits session_resumed", () => {
		const adapter = new StubPiSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "rpc",
			model: stubModel,
			adapter,
		});

		// Create, then serialize for recovery
		const session = runtime.createSession();
		const recoveryData = {
			sessionId: session.id,
			model: stubModel,
			toolSet: ["read", "edit"],
			planSummary: null,
			compactionSummary: null,
			taskState: { status: "idle" as const, currentTaskId: null, startedAt: null },
		};

		// Create a fresh runtime for recovery
		const adapter2 = new StubPiSessionAdapter();
		const runtime2 = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "rpc",
			model: stubModel,
			adapter: adapter2,
		});

		const events: RuntimeEvent[] = [];
		runtime2.events.on("session_resumed", (e) => events.push(e));

		const recovered = runtime2.recoverSession(recoveryData);

		expect(recovered.state.status).toBe("active");
		expect(recovered.id).toEqual(session.id);
		expect(events).toHaveLength(1);
		if (events[0]!.type === "session_resumed") {
			expect(events[0]!.recoveryData.model).toEqual(stubModel);
		}
	});

	it("throws if no adapter is provided", () => {
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
		});

		expect(() => runtime.createSession()).toThrow("No PiSessionAdapter provided");
	});

	it("shutdown closes all sessions", async () => {
		const adapter = new StubPiSessionAdapter();
		const runtime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		const s1 = runtime.createSession();
		const s2 = runtime.createSession();

		await runtime.shutdown();

		expect(s1.state.status).toBe("closed");
		expect(s2.state.status).toBe("closed");
	});

	it("same runtime can drive multiple modes (print + json)", () => {
		const adapter = new StubPiSessionAdapter();

		const printRuntime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "print",
			model: stubModel,
			adapter,
		});

		const jsonRuntime = createAppRuntime({
			workingDirectory: "/tmp",
			mode: "json",
			model: stubModel,
			adapter,
		});

		const printSession = printRuntime.createSession();
		const jsonSession = jsonRuntime.createSession();

		// Both share the same runtime design — different modes but same API
		expect(printSession.context.mode).toBe("print");
		expect(jsonSession.context.mode).toBe("json");
		expect(printSession.state.status).toBe("active");
		expect(jsonSession.state.status).toBe("active");
	});
});
