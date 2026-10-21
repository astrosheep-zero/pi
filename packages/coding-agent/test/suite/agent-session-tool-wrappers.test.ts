import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import type { ExtensionAPI, ExtensionError, ExtensionFactory, ToolDefinition, ToolWrapper } from "../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

// https://github.com/earendil-works/pi/issues/11218
describe("AgentSession tool wrappers", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("wraps built-ins and follows replacement, re-registration, and reload without stacking", async () => {
		let owner!: ExtensionAPI;
		let version = 0;
		const calls: string[] = [];
		const wrap =
			(label: string): ToolWrapper =>
			(tool) => ({
				...tool,
				description: `${tool.description}:${label}`,
				execute: async (...args) => {
					calls.push(label);
					return tool.execute(...args);
				},
			});
		const replacement = (): ToolDefinition => ({
			name: "read",
			label: "read",
			description: `read-${version}`,
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: `read-${version}` }], details: {} }),
		});
		const factories: ExtensionFactory[] = [
			(pi) => {
				pi.wrapTool("read", wrap("a"));
				pi.wrapTool("read", wrap("b"));
			},
			(pi) => {
				owner = pi;
				if (version) pi.registerTool(replacement());
			},
			(pi) => {
				pi.wrapTool("read", wrap("c"));
			},
		];
		let extensionsResult = await createTestExtensionsResult(factories);
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getExtensions = () => extensionsResult;
		resourceLoader.reload = async () => {
			extensionsResult = await createTestExtensionsResult(factories);
		};
		const harness = await createHarness({ resourceLoader, initialActiveToolNames: ["read"] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		writeFileSync(join(harness.tempDir, "example.txt"), "built-in read");
		const read = async () => {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path: "example.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("read it");
			return getMessageText(getToolResult(harness, "read"));
		};
		expect(await read()).toContain("built-in read");
		for (version = 1; version <= 2; version++) {
			owner.registerTool(replacement());
			expect(await read()).toBe(`read-${version}`);
			expect(harness.session.getToolDefinition("read")?.description).toBe(`read-${version}:a:b:c`);
		}
		await harness.session.reload();
		const reloaded = harness.session.agent.state.tools.find((tool) => tool.name === "read")!;
		expect(getMessageText(await reloaded.execute("reloaded", { path: "example.txt" }))).toBe("read-3");
		expect(harness.session.getToolDefinition("read")?.description).toBe("read-3:a:b:c");
		expect(calls).toEqual(Array.from({ length: 4 }, () => ["c", "b", "a"]).flat());
		expect(harness.session.getAllTools().find((tool) => tool.name === "read")?.sourceInfo.path).toBe("<inline:2>");
	});

	it("uses the decorated declaration, validation, loadout, renderers, and execution in CodeMode too", async () => {
		const renderCall = () => new Text("wrapped");
		const calls: string[] = [];
		const harness = await createHarness({
			initialActiveToolNames: ["codemode", "echo"],
			extensionFactories: [
				createCodemodeExtension(),
				(pi) => {
					pi.registerTool({
						name: "echo",
						label: "echo",
						description: "echo",
						parameters: Type.Object({ text: Type.String() }),
						execute: async (_id, { text }) => ({ content: [{ type: "text", text }], details: {} }),
					});
				},
				(pi) => {
					pi.on("session_start", () => {
						pi.wrapTool("echo", (tool) => ({
							...tool,
							parameters: Type.Object({ text: Type.Literal("prepared") }),
							prepareArguments: () => ({ text: "prepared" }),
							outputSchema: Type.Object({ wrapped: Type.String() }),
							prepareLoadout: () => ({ descriptions: { echo: "wrapped echo" } }),
							renderCall,
							execute: async (...args) => {
								calls.push(args[0]);
								const result = await tool.execute(...args);
								return { ...result, structuredContent: { wrapped: getMessageText(result) } };
							},
						}));
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		expect(harness.session.getToolDefinition("echo")?.renderCall).toBe(renderCall);
		expect(harness.session.getAllTools().find((tool) => tool.name === "echo")?.parameters).toMatchObject({
			properties: { text: { const: "prepared" } },
		});
		harness.setResponses([
			(context: TranscriptContext) => {
				expect(getCurrentTools(context.messages).find((tool) => tool.name === "echo")?.description).toBe(
					"wrapped echo",
				);
				return fauxAssistantMessage(
					[
						fauxToolCall("echo", { text: "raw" }),
						fauxToolCall("codemode", { code: 'return (await tools.echo({ text: "raw" })).wrapped;' }),
					],
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getMessageText(getToolResult(harness, "echo"))).toBe("prepared");
		expect(getMessageText(getToolResult(harness, "codemode"))).toContain("prepared");
		expect(getToolResult(harness, "codemode").nestedCalls?.calls).toMatchObject([{ name: "echo", status: "ok" }]);
		expect(calls).toHaveLength(2);
	});

	it("reports wrappers that fail before the error listener is bound", async () => {
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.wrapTool("read", () => {
						throw new Error("startup failure");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
		expect(errors).toMatchObject([{ event: "wrap_tool", error: "startup failure" }]);
		expect(harness.session.getCallableToolNames()).not.toContain("read");
	});

	it.each(["throw", "rename"])("reports a %s wrapper and makes the tool unavailable", async (failure) => {
		let api!: ExtensionAPI;
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error) });
		api.wrapTool("read", (tool) => {
			if (failure === "throw") throw new Error("broken wrapper");
			return { ...tool, name: "renamed" };
		});
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({ extensionPath: "<inline:1>", event: "wrap_tool" });
		expect(harness.session.getToolDefinition("read")).toBeUndefined();
		expect(harness.session.getActiveToolNames()).not.toContain("read");
		expect(harness.session.getCallableToolNames()).not.toContain("read");
	});
});
