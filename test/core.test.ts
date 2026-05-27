import { describe, expect, it } from "vitest";
import { createBrowserAgent, defineTool, type AgentEvent, type ModelAdapter } from "../src";

async function collect(
  iterable: AsyncIterable<AgentEvent>,
  onEvent?: (event: AgentEvent) => void
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

describe("createBrowserAgent", () => {
  it("streams model messages and completes", async () => {
    const model: ModelAdapter = async function* () {
      yield { type: "message.delta", content: "hello" };
      yield { type: "message.delta", content: " world" };
      yield { type: "done" };
    };

    const agent = createBrowserAgent({ model });
    const events = await collect(agent.run("say hi"));

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.delta",
      "message.completed",
      "run.completed"
    ]);
    expect(events.find((event) => event.type === "message.completed")).toMatchObject({
      content: "hello world"
    });
  });

  it("executes schema-first tools and feeds results into the next model turn", async () => {
    let calls = 0;
    const model: ModelAdapter = async function* (request) {
      calls += 1;
      if (calls === 1) {
        yield {
          type: "tool.call",
          toolCall: {
            name: "double",
            arguments: { value: 21 }
          }
        };
        return;
      }

      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "double",
        content: '{"value":42}'
      });
      yield { type: "message.delta", content: "done" };
    };

    const agent = createBrowserAgent({
      model,
      tools: [
        defineTool<{ value: number }, { value: number }>({
          name: "double",
          description: "Double a number.",
          parameters: {
            type: "object",
            required: ["value"],
            properties: {
              value: { type: "number" }
            }
          },
          execute(args) {
            return { value: args.value * 2 };
          }
        })
      ]
    });

    const events = await collect(agent.run("double it"));

    expect(events.some((event) => event.type === "tool.started")).toBe(true);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("emits tool errors for invalid tool arguments", async () => {
    let calls = 0;
    const model: ModelAdapter = async function* () {
      calls += 1;
      if (calls === 1) {
        yield {
          type: "tool.call",
          toolCall: {
            name: "needs_value",
            arguments: {}
          }
        };
        return;
      }
      yield { type: "message.delta", content: "recovered" };
    };

    const agent = createBrowserAgent({
      model,
      tools: [
        defineTool<{ value: number }, number>({
          name: "needs_value",
          description: "Requires a value.",
          parameters: {
            type: "object",
            required: ["value"],
            properties: {
              value: { type: "number" }
            }
          },
          execute(args) {
            return args.value;
          }
        })
      ]
    });

    const events = await collect(agent.run("call invalid tool"));
    const error = events.find((event) => event.type === "tool.error");

    expect(error).toMatchObject({
      type: "tool.error",
      error: {
        name: "ToolValidationError"
      }
    });
  });

  it("stops after the configured max turns", async () => {
    const model: ModelAdapter = async function* () {
      yield {
        type: "tool.call",
        toolCall: {
          name: "noop",
          arguments: {}
        }
      };
    };

    const agent = createBrowserAgent({
      maxTurns: 2,
      model,
      tools: [
        defineTool({
          name: "noop",
          description: "No-op.",
          parameters: { type: "object" },
          execute: () => ({ ok: true })
        })
      ]
    });

    const events = await collect(agent.run("loop"));
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: {
        name: "MaxTurnsExceededError"
      }
    });
  });

  it("can cancel an active run", async () => {
    const model: ModelAdapter = async function* (request) {
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true
        });
      });
    };

    const agent = createBrowserAgent({ model });
    const iterator = agent.run("wait")[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value?.type).toBe("run.started");
    agent.cancel("test cancellation");

    const second = await iterator.next();
    expect(second.value).toMatchObject({
      type: "run.cancelled",
      reason: "test cancellation"
    });
  });

  it("runs before-model hooks that mutate the model request", async () => {
    const seenSystems: string[] = [];
    const seenMessages: string[][] = [];
    const model: ModelAdapter = async function* (request) {
      seenSystems.push(request.system);
      seenMessages.push(request.messages.map((message) => message.content));
      yield { type: "message.completed", content: "done" };
    };

    const agent = createBrowserAgent({
      model,
      system: "base",
      hooks: [
        {
          event: "before_model_call",
          name: "inject_context",
          handler(input) {
            if (input.event !== "before_model_call") return;
            return {
              request: {
                system: `${input.request.system}\nhooked`,
                messages: [...input.request.messages, { role: "user", content: "from hook" }]
              }
            };
          }
        }
      ]
    });

    const events = await collect(agent.run("hello"));

    expect(seenSystems).toEqual(["base\nhooked"]);
    expect(seenMessages).toEqual([["hello", "from hook"]]);
    expect(events.some((event) => event.type === "hook.started")).toBe(true);
    expect(events.some((event) => event.type === "hook.completed")).toBe(true);
  });

  it("runs after-model hooks that mutate content and tool calls", async () => {
    let modelCalls = 0;
    const model: ModelAdapter = async function* (request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "message.completed", content: "before hook" };
        return;
      }

      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "double",
        content: '{"value":42}'
      });
      yield { type: "message.completed", content: "finished" };
    };

    const agent = createBrowserAgent({
      model,
      hooks: [
        {
          event: "after_model_call",
          handler(input) {
            if (input.event !== "after_model_call") return;
            if (input.turn !== 0) return;
            return {
              content: "after hook",
              toolCalls: [{ id: "tool-1", name: "double", arguments: { value: 21 } }]
            };
          }
        }
      ],
      tools: [
        defineTool<{ value: number }, { value: number }>({
          name: "double",
          description: "Double a value.",
          parameters: {
            type: "object",
            required: ["value"],
            properties: { value: { type: "number" } }
          },
          execute(args) {
            return { value: args.value * 2 };
          }
        })
      ]
    });

    const events = await collect(agent.run("start"));

    expect(events.filter((event) => event.type === "message.completed").map((event) => event.content)).toContain(
      "after hook"
    );
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("runs tool hooks that can skip execution and replace results", async () => {
    let modelCalls = 0;
    let executed = false;
    const model: ModelAdapter = async function* (request) {
      modelCalls += 1;
      if (modelCalls === 1) {
        yield { type: "tool.call", toolCall: { id: "tool-1", name: "dangerous", arguments: {} } };
        return;
      }

      expect(request.messages.at(-1)).toMatchObject({
        role: "tool",
        name: "dangerous",
        content: '{"ok":"after"}'
      });
      yield { type: "message.completed", content: "done" };
    };

    const agent = createBrowserAgent({
      model,
      hooks: [
        {
          event: "before_tool_call",
          handler(input) {
            if (input.event !== "before_tool_call") return;
            return { skip: { result: { ok: "before" } } };
          }
        },
        {
          event: "after_tool_call",
          handler(input) {
            if (input.event !== "after_tool_call") return;
            return { result: { ok: "after" } };
          }
        }
      ],
      tools: [
        defineTool({
          name: "dangerous",
          description: "Should be skipped.",
          parameters: { type: "object" },
          execute() {
            executed = true;
            return { ok: false };
          }
        })
      ]
    });

    const events = await collect(agent.run("call it"));

    expect(executed).toBe(false);
    expect(events.some((event) => event.type === "tool.result")).toBe(true);
    expect(events.at(-1)?.type).toBe("run.completed");
  });

  it("fails the run when a hook throws", async () => {
    const model: ModelAdapter = async function* () {
      yield { type: "message.completed", content: "unused" };
    };
    const agent = createBrowserAgent({
      model,
      hooks: [
        {
          event: "before_model_call",
          name: "explode",
          handler() {
            throw new Error("hook failed");
          }
        }
      ]
    });

    const events = await collect(agent.run("start"));

    expect(events.some((event) => event.type === "hook.error")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "run.error",
      error: { message: "hook failed" }
    });
  });

  it("compacts old messages before the model call when the threshold is reached", async () => {
    const compactionMessages: string[][] = [];
    const modelRequests: string[][] = [];
    const compactionModel: ModelAdapter = async function* (request) {
      compactionMessages.push(request.messages.map((message) => message.content));
      yield { type: "message.completed", content: "old work summarized" };
    };
    const model: ModelAdapter = async function* (request) {
      modelRequests.push(request.messages.map((message) => message.content));
      yield { type: "message.completed", content: "done" };
    };
    const messages = [
      { role: "system" as const, content: "keep system" },
      { role: "user" as const, content: "old one" },
      { role: "assistant" as const, content: "old two" },
      { role: "user" as const, content: "recent one" },
      { role: "assistant" as const, content: "recent two" }
    ];

    const agent = createBrowserAgent({
      model,
      contextCompaction: {
        enabled: true,
        thresholdPercent: 50,
        contextWindowTokens: 100,
        prompt: "Summarize.",
        model: compactionModel,
        preserveRecentMessages: 2,
        estimateTokens: () => 80
      }
    });

    const events = await collect(agent.run({ messages }));

    expect(compactionMessages[0]?.[0]).toContain("old one");
    expect(modelRequests[0]).toEqual([
      "keep system",
      "Compacted conversation summary:\nold work summarized",
      "recent one",
      "recent two"
    ]);
    expect(events.some((event) => event.type === "context.compaction.started")).toBe(true);
    expect(events.some((event) => event.type === "context.compaction.completed")).toBe(true);
  });

  it("can cancel while compaction is running", async () => {
    const model: ModelAdapter = async function* () {
      yield { type: "message.completed", content: "unused" };
    };
    const compactionModel: ModelAdapter = async function* (request) {
      await new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
          once: true
        });
      });
    };
    const agent = createBrowserAgent({
      model,
      contextCompaction: {
        enabled: true,
        thresholdPercent: 1,
        contextWindowTokens: 10,
        prompt: "Summarize.",
        model: compactionModel,
        preserveRecentMessages: 0,
        estimateTokens: () => 10
      }
    });
    const iterator = agent
      .run({
        messages: [
          { role: "user", content: "old" },
          { role: "user", content: "new" }
        ]
      })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("run.started");
    expect((await iterator.next()).value?.type).toBe("context.compaction.started");
    agent.cancel("stop compaction");

    expect(await iterator.next()).toMatchObject({
      value: { type: "run.cancelled", reason: "stop compaction" }
    });
  });
});
