import { describe, expect, it } from "vitest";
import { createEventBus } from "../events/event-bus.js";
import type { RuntimeEvent } from "../events/runtime-event.js";
import type { SessionId } from "../types/index.js";

const stubSessionId: SessionId = { value: "test-session" };

function makeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
	return {
		id: "evt-1",
		timestamp: Date.now(),
		sessionId: stubSessionId,
		category: "session",
		type: "session_created",
		model: { id: "test", provider: "test" },
		toolSet: [],
		...overrides,
	} as RuntimeEvent;
}

describe("EventBus", () => {
	it("emits events to type-level listeners", () => {
		const bus = createEventBus();
		const received: RuntimeEvent[] = [];
		bus.on("session_created", (event) => received.push(event));

		const event = makeEvent();
		bus.emit(event);

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual(event);
	});

	it("emits events to category-level listeners", () => {
		const bus = createEventBus();
		const received: RuntimeEvent[] = [];
		bus.onCategory("session", (event) => received.push(event));

		bus.emit(makeEvent());

		expect(received).toHaveLength(1);
	});

	it("does not deliver to wrong type listeners", () => {
		const bus = createEventBus();
		const received: RuntimeEvent[] = [];
		bus.on("tool_started", (event) => received.push(event));

		bus.emit(makeEvent());

		expect(received).toHaveLength(0);
	});

	it("unsubscribe stops future deliveries", () => {
		const bus = createEventBus();
		const received: RuntimeEvent[] = [];
		const unsub = bus.on("session_created", (event) => received.push(event));

		unsub();
		bus.emit(makeEvent());

		expect(received).toHaveLength(0);
	});

	it("off removes a specific listener", () => {
		const bus = createEventBus();
		const received: RuntimeEvent[] = [];
		const listener = (event: RuntimeEvent) => received.push(event);

		bus.on("session_created", listener);
		bus.off("session_created", listener);
		bus.emit(makeEvent());

		expect(received).toHaveLength(0);
	});

	it("removeAllListeners clears everything", () => {
		const bus = createEventBus();
		const typeReceived: RuntimeEvent[] = [];
		const catReceived: RuntimeEvent[] = [];

		bus.on("session_created", (event) => typeReceived.push(event));
		bus.onCategory("session", (event) => catReceived.push(event));

		bus.removeAllListeners();
		bus.emit(makeEvent());

		expect(typeReceived).toHaveLength(0);
		expect(catReceived).toHaveLength(0);
	});

	it("delivers to both type and category listeners for the same event", () => {
		const bus = createEventBus();
		const typeReceived: RuntimeEvent[] = [];
		const catReceived: RuntimeEvent[] = [];

		bus.on("session_created", (event) => typeReceived.push(event));
		bus.onCategory("session", (event) => catReceived.push(event));

		bus.emit(makeEvent());

		expect(typeReceived).toHaveLength(1);
		expect(catReceived).toHaveLength(1);
	});
});
