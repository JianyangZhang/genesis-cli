import { expect } from "vitest";
import type { ToolExecutionContext, ToolExecutionResult, ToolGovernor } from "../governance/tool-governor.js";

export interface GovernorProbeHandle {
	complete(overrides?: Partial<ToolExecutionResult>): void;
}

export function expectGovernorProbeAllows(governor: ToolGovernor, context: ToolExecutionContext): GovernorProbeHandle {
	const decision = governor.beforeExecution(context);
	expect(decision).toMatchObject({ type: "allow" });

	let completed = false;
	return {
		complete(overrides?: Partial<ToolExecutionResult>): void {
			if (completed) {
				throw new Error(`Governor probe already completed: ${context.toolCallId}`);
			}
			completed = true;
			governor.afterExecution({
				toolName: context.toolName,
				toolCallId: context.toolCallId,
				status: "success",
				targetPath: context.targetPath,
				...overrides,
			});
		},
	};
}
