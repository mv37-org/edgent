import { AsyncEventQueue } from "./queue";
import { validateJsonSchema } from "./schema";
import type {
  AgentErrorInfo,
  AgentEvent,
  AgentEventInput,
  AgentMessage,
  AgentRunInput,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalResult,
  BrowserAgent,
  BrowserAgentConfig,
  ModelStreamEvent,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolSpec
} from "./types";

interface PendingApproval {
  runId: string;
  resolve(result: ApprovalResult): void;
  emit(event: AgentEventInput): void;
}

export function createBrowserAgent(config: BrowserAgentConfig): BrowserAgent {
  return new BrowserAgentRuntime(config);
}

export function defineTool<TArgs = unknown, TResult = unknown>(
  definition: ToolDefinition<TArgs, TResult>
): ToolDefinition<TArgs, TResult> {
  return definition;
}

class BrowserAgentRuntime implements BrowserAgent {
  private activeRun: { controller: AbortController; reason?: string } | undefined;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly config: BrowserAgentConfig) {
    for (const tool of config.tools ?? []) {
      if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
      this.tools.set(tool.name, tool);
    }
  }

  run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.cancel("superseded");

    const runId = createId("run");
    const controller = new AbortController();
    const queue = new AsyncEventQueue<AgentEvent>();
    this.activeRun = { controller };

    const emit = (event: AgentEventInput) => {
      const fullEvent = normalizeEvent(runId, event);
      queue.push(fullEvent);
      for (const listener of this.listeners) listener(fullEvent);
    };

    void this.executeRun({ input, runId, signal: controller.signal, emit })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          const reason = this.activeRun?.reason;
          emit(reason ? { type: "run.cancelled", reason } : { type: "run.cancelled" });
          return;
        }
        emit({ type: "run.error", error: toAgentError(error) });
      })
      .finally(() => {
        if (this.activeRun?.controller === controller) this.activeRun = undefined;
        queue.close();
      });

    return queue;
  }

  cancel(reason = "cancelled"): void {
    if (!this.activeRun) return;
    this.activeRun.reason = reason;
    this.activeRun.controller.abort(reason);
  }

  on(eventName: "event", handler: (event: AgentEvent) => void): () => void {
    if (eventName !== "event") throw new Error(`Unsupported event name: ${eventName}`);
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  resolveApproval<TValue = unknown>(approvalId: string, result: ApprovalResult<TValue>): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return false;
    this.pendingApprovals.delete(approvalId);
    pending.emit({ type: "approval.resolved", approvalId, result });
    pending.resolve(result as ApprovalResult);
    return true;
  }

  private async executeRun(args: {
    input: AgentRunInput;
    runId: string;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<void> {
    const { input, runId, signal, emit } = args;
    const messages = normalizeRunMessages(input);
    const toolSpecs = [...this.tools.values()].map(toToolSpec);
    const maxTurns = this.config.maxTurns ?? 6;

    emit({ type: "run.started", input });

    for (let turn = 0; turn < maxTurns; turn += 1) {
      throwIfAborted(signal);

      const toolCalls: ToolCall[] = [];
      let assistantContent = "";
      let completedMessageEmitted = false;

      const request = {
        system: this.config.system ?? "",
        messages: [...messages],
        tools: toolSpecs,
        signal
      };
      const stream = this.config.model({
        ...request,
        ...(this.config.responseFormat === undefined ? {} : { responseFormat: this.config.responseFormat }),
        ...(this.config.settings === undefined ? {} : { settings: this.config.settings })
      });

      for await (const event of stream) {
        throwIfAborted(signal);
        switch (event.type) {
          case "message.delta":
            assistantContent += event.content;
            emit({ type: "message.delta", content: event.content });
            break;
          case "message.completed":
            if (typeof event.content === "string") assistantContent = event.content;
            completedMessageEmitted = true;
            emit({ type: "message.completed", content: assistantContent });
            break;
          case "tool.call":
            toolCalls.push(normalizeToolCall(event));
            break;
          case "error":
            throw event.error;
          case "done":
            break;
        }
      }

      if (assistantContent && !completedMessageEmitted) {
        emit({ type: "message.completed", content: assistantContent });
      }

      if (assistantContent || toolCalls.length) {
        messages.push({ role: "assistant", content: assistantContent, toolCalls });
      }

      if (toolCalls.length === 0) {
        emit({ type: "run.completed", messages: [...messages] });
        return;
      }

      for (const toolCall of toolCalls) {
        throwIfAborted(signal);
        await this.executeTool({ toolCall, messages, runId, turn, signal, emit });
      }
    }

    emit({
      type: "run.error",
      error: {
        name: "MaxTurnsExceededError",
        message: `Agent stopped after ${maxTurns} turns without completing.`
      }
    });
  }

  private async executeTool(args: {
    toolCall: ToolCall;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<void> {
    const { toolCall, messages, runId, turn, signal, emit } = args;
    emit({ type: "tool.started", toolCall });

    const tool = this.tools.get(toolCall.name);
    if (!tool) {
      const error = { name: "ToolNotFoundError", message: `Unknown tool: ${toolCall.name}` };
      emit({ type: "tool.error", toolCall, error });
      messages.push(toolResultMessage(toolCall, { error }));
      return;
    }

    const validation = validateJsonSchema(toolCall.arguments, tool.parameters);
    if (!validation.ok) {
      const error = {
        name: "ToolValidationError",
        message: validation.errors.join("; ")
      };
      emit({ type: "tool.error", toolCall, error });
      messages.push(toolResultMessage(toolCall, { error }));
      return;
    }

    const context: ToolContext = {
      runId,
      turn,
      signal,
      emit,
      requestApproval: async <TData = unknown, TValue = unknown>(request: ApprovalRequestInput<TData>) =>
        (await this.requestApproval({ request, runId, emit })) as ApprovalResult<TValue>
    };

    try {
      const result = await tool.execute(toolCall.arguments, context);
      throwIfAborted(signal);
      emit({ type: "tool.result", toolCall, result });
      messages.push(toolResultMessage(toolCall, result));
    } catch (error: unknown) {
      if (signal.aborted) throw error;
      const info = toAgentError(error);
      emit({ type: "tool.error", toolCall, error: info });
      messages.push(toolResultMessage(toolCall, { error: info }));
    }
  }

  private requestApproval(args: {
    request: ApprovalRequestInput;
    runId: string;
    emit(event: AgentEventInput): void;
  }): Promise<ApprovalResult> {
    const approval: ApprovalRequest = {
      id: createId("approval"),
      kind: args.request.kind ?? "generic",
      title: args.request.title,
      ...(args.request.description === undefined ? {} : { description: args.request.description }),
      ...(args.request.data === undefined ? {} : { data: args.request.data })
    };

    args.emit({ type: "approval.requested", approval });

    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApprovals.set(approval.id, {
        runId: args.runId,
        emit: args.emit,
        resolve
      });
    });
  }
}

function normalizeRunMessages(input: AgentRunInput): AgentMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const messages = [...(input.messages ?? [])];
  if (input.input) messages.push({ role: "user", content: input.input });
  return messages;
}

function normalizeToolCall(event: Extract<ModelStreamEvent, { type: "tool.call" }>): ToolCall {
  return {
    id: event.toolCall.id ?? createId("tool"),
    name: event.toolCall.name,
    arguments: parseArguments(event.toolCall.arguments)
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function toToolSpec(tool: ToolDefinition): ToolSpec {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters
  };
}

function toolResultMessage(toolCall: ToolCall, result: unknown): AgentMessage {
  return {
    role: "tool",
    name: toolCall.name,
    toolCallId: toolCall.id,
    content: stringifyResult(result)
  };
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result);
}

function normalizeEvent(runId: string, event: AgentEventInput): AgentEvent {
  return {
    ...event,
    runId,
    timestamp: event.timestamp ?? Date.now()
  } as AgentEvent;
}

function toAgentError(error: unknown): AgentErrorInfo {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(error.cause === undefined ? {} : { cause: error.cause })
    };
  }
  return {
    name: "Error",
    message: String(error)
  };
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new DOMException("The agent run was cancelled.", "AbortError");
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}
