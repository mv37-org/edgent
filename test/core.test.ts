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
});
