import { AsyncEventQueue } from "./queue";
import { validateJsonSchema } from "./schema";
import type {
  AgentErrorInfo,
  AgentEvent,
  AgentEventInput,
  AgentLifecycleHook,
  AgentLifecycleHookEvent,
  AgentLifecycleHookResult,
  AgentMessage,
  AgentRunInput,
  ApprovalRequest,
  ApprovalRequestInput,
  ApprovalResult,
  BrowserAgent,
  BrowserAgentConfig,
  ContextCompactionConfig,
  ContextTokenEstimateInput,
  ModelAdapterRequest,
  ModelAdapterRequestPatch,
  ModelStreamEvent,
  ModelTurnResult,
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
    let activeTurn = 0;

    emit({ type: "run.started", input });

    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        activeTurn = turn;
        throwIfAborted(signal);

        const baseRequest = modelRequest({
          system: this.config.system ?? "",
          messages,
          tools: toolSpecs,
          signal,
          ...(this.config.responseFormat === undefined ? {} : { responseFormat: this.config.responseFormat }),
          ...(this.config.settings === undefined ? {} : { settings: this.config.settings })
        });
        const beforeModel = await this.runBeforeModelHooks({
          request: baseRequest,
          messages,
          runId,
          turn,
          signal,
          emit
        });
        let request = beforeModel.request;
        replaceMessages(messages, request.messages);

        let modelResult = beforeModel.skip;
        let modelCompleted = Boolean(modelResult);
        if (!modelResult) {
          request = await this.maybeCompactRequest({ request, messages, runId, turn, signal, emit });
          replaceMessages(messages, request.messages);
          throwIfAborted(signal);
          const collected = await collectModelTurn(this.config.model(request), signal, emit);
          modelResult = collected.result;
          modelCompleted = collected.completed;
        }

        modelResult = await this.runAfterModelHooks({
          result: modelResult,
          messages,
          runId,
          turn,
          signal,
          emit
        });

        if (modelResult.content || modelCompleted) {
          emit({ type: "message.completed", content: modelResult.content });
        }

        if (modelResult.content || modelResult.toolCalls.length) {
          messages.push({
            role: "assistant",
            content: modelResult.content,
            toolCalls: modelResult.toolCalls
          });
        }

        if (modelResult.toolCalls.length === 0) {
          emit({ type: "run.completed", messages: [...messages] });
          return;
        }

        for (const toolCall of modelResult.toolCalls) {
          throwIfAborted(signal);
          await this.executeTool({ toolCall, messages, runId, turn, signal, emit });
        }
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        await this.runErrorHooks({
          error: toAgentError(error),
          messages,
          runId,
          turn: activeTurn,
          signal,
          emit
        });
      }
      throw error;
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
    const { messages, runId, turn, signal, emit } = args;
    const beforeHook = await this.runBeforeToolHooks({
      toolCall: args.toolCall,
      messages,
      runId,
      turn,
      signal,
      emit
    });
    const toolCall = beforeHook.toolCall;
    if (beforeHook.skip) {
      throwIfAborted(signal);
      const result = await this.runAfterToolHooks({
        toolCall,
        result: beforeHook.skip.result,
        messages,
        runId,
        turn,
        signal,
        emit
      });
      emit({ type: "tool.result", toolCall, result });
      messages.push(toolResultMessage(toolCall, result));
      return;
    }

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
      let result = await tool.execute(toolCall.arguments, context);
      result = await this.runAfterToolHooks({
        toolCall,
        result,
        messages,
        runId,
        turn,
        signal,
        emit
      });
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

  private async runBeforeModelHooks(args: {
    request: ModelAdapterRequest;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<{ request: ModelAdapterRequest; skip?: ModelTurnResult }> {
    let request = args.request;
    for (const hook of this.hooksFor("before_model_call")) {
      const input = {
        event: "before_model_call" as const,
        request,
        runId: args.runId,
        turn: args.turn,
        messages: [...args.messages],
        signal: args.signal,
        emit: args.emit
      };
      const result = await this.runHook(hook, input, args.emit);
      request = input.request;
      if (hasRequestPatch(result)) request = applyRequestPatch(request, result.request);
      if (hasSkipModelResult(result)) {
        return {
          request,
          skip: {
            content: result.skip.content ?? "",
            toolCalls: result.skip.toolCalls ?? []
          }
        };
      }
    }
    return { request };
  }

  private async runAfterModelHooks(args: {
    result: ModelTurnResult;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<ModelTurnResult> {
    let result = args.result;
    for (const hook of this.hooksFor("after_model_call")) {
      const input = {
        event: "after_model_call" as const,
        result,
        runId: args.runId,
        turn: args.turn,
        messages: [...args.messages],
        signal: args.signal,
        emit: args.emit
      };
      const hookResult = await this.runHook(hook, input, args.emit);
      result = input.result;
      if (hasModelContent(hookResult)) result = { ...result, content: hookResult.content };
      if (hasModelToolCalls(hookResult)) result = { ...result, toolCalls: hookResult.toolCalls };
      appendHookMessages(args.messages, hookResult);
    }
    return result;
  }

  private async runBeforeToolHooks(args: {
    toolCall: ToolCall;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<{ toolCall: ToolCall; skip?: { result: unknown } }> {
    let toolCall = args.toolCall;
    for (const hook of this.hooksFor("before_tool_call")) {
      const input = {
        event: "before_tool_call" as const,
        toolCall,
        runId: args.runId,
        turn: args.turn,
        messages: [...args.messages],
        signal: args.signal,
        emit: args.emit
      };
      const result = await this.runHook(hook, input, args.emit);
      toolCall = input.toolCall;
      if (hasToolCallPatch(result)) toolCall = result.toolCall;
      appendHookMessages(args.messages, result);
      if (hasSkipToolResult(result)) return { toolCall, skip: result.skip };
    }
    return { toolCall };
  }

  private async runAfterToolHooks(args: {
    toolCall: ToolCall;
    result: unknown;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<unknown> {
    let result = args.result;
    for (const hook of this.hooksFor("after_tool_call")) {
      const input = {
        event: "after_tool_call" as const,
        toolCall: args.toolCall,
        result,
        runId: args.runId,
        turn: args.turn,
        messages: [...args.messages],
        signal: args.signal,
        emit: args.emit
      };
      const hookResult = await this.runHook(hook, input, args.emit);
      result = input.result;
      if (hasToolResultPatch(hookResult)) result = hookResult.result;
      appendHookMessages(args.messages, hookResult);
    }
    return result;
  }

  private async runErrorHooks(args: {
    error: AgentErrorInfo;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<void> {
    for (const hook of this.hooksFor("on_error")) {
      const result = await this.runHook(
        hook,
        {
          event: "on_error",
          error: args.error,
          runId: args.runId,
          turn: args.turn,
          messages: [...args.messages],
          signal: args.signal,
          emit: args.emit
        },
        args.emit
      );
      appendHookMessages(args.messages, result);
    }
  }

  private async maybeCompactRequest(args: {
    request: ModelAdapterRequest;
    messages: AgentMessage[];
    runId: string;
    turn: number;
    signal: AbortSignal;
    emit(event: AgentEventInput): void;
  }): Promise<ModelAdapterRequest> {
    const compaction = this.config.contextCompaction;
    if (!compaction?.enabled) return args.request;

    const tokenEstimate = await estimateContextTokens(compaction, {
      runId: args.runId,
      turn: args.turn,
      system: args.request.system,
      messages: args.request.messages,
      tools: args.request.tools,
      ...(args.request.responseFormat === undefined ? {} : { responseFormat: args.request.responseFormat }),
      ...(args.request.settings === undefined ? {} : { settings: args.request.settings })
    });
    const contextWindowTokens = Math.max(1, Math.floor(compaction.contextWindowTokens));
    const thresholdPercent = clampNumber(compaction.thresholdPercent, 1, 100);
    const thresholdTokens = Math.ceil(contextWindowTokens * (thresholdPercent / 100));
    if (tokenEstimate < thresholdTokens) return args.request;

    const split = splitMessagesForCompaction(args.request.messages, compaction.preserveRecentMessages ?? 6);
    if (split.compacted.length === 0) return args.request;

    args.emit({
      type: "context.compaction.started",
      tokenEstimate,
      thresholdTokens,
      compactedMessageCount: split.compacted.length,
      preservedMessageCount: split.preserved.length + split.leadingSystem.length
    });

    const summary = await summarizeMessagesForCompaction({
      compaction,
      messages: split.compacted,
      signal: args.signal
    });
    const cleanSummary = summary.trim();
    if (!cleanSummary) throw new Error("Context compaction returned an empty summary.");

    const compactedMessages = [
      ...split.leadingSystem,
      { role: "user" as const, content: `Compacted conversation summary:\n${cleanSummary}` },
      ...split.preserved
    ];

    args.emit({
      type: "context.compaction.completed",
      tokenEstimate,
      thresholdTokens,
      summary: cleanSummary,
      compactedMessageCount: split.compacted.length,
      preservedMessageCount: split.preserved.length + split.leadingSystem.length
    });

    return { ...args.request, messages: compactedMessages };
  }

  private hooksFor(event: AgentLifecycleHookEvent): AgentLifecycleHook[] {
    return (this.config.hooks ?? []).filter((hook) => hook.event === event);
  }

  private async runHook(
    hook: AgentLifecycleHook,
    input: Parameters<AgentLifecycleHook["handler"]>[0],
    emit: (event: AgentEventInput) => void
  ): Promise<AgentLifecycleHookResult> {
    const info = hookEventInfo(hook);
    emit({ type: "hook.started", hook: info });
    try {
      const result = await hook.handler(input);
      emit({ type: "hook.completed", hook: info });
      return result;
    } catch (error: unknown) {
      const infoError = toAgentError(error);
      emit({ type: "hook.error", hook: info, error: infoError });
      throw error;
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

function modelRequest(args: {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
  responseFormat?: unknown;
  settings?: Record<string, unknown>;
}): ModelAdapterRequest {
  return {
    system: args.system,
    messages: [...args.messages],
    tools: args.tools,
    signal: args.signal,
    ...(args.responseFormat === undefined ? {} : { responseFormat: args.responseFormat }),
    ...(args.settings === undefined ? {} : { settings: args.settings })
  };
}

async function collectModelTurn(
  stream: AsyncIterable<ModelStreamEvent>,
  signal: AbortSignal,
  emit?: (event: AgentEventInput) => void
): Promise<{ result: ModelTurnResult; completed: boolean }> {
  const toolCalls: ToolCall[] = [];
  let content = "";
  let completed = false;

  for await (const event of stream) {
    throwIfAborted(signal);
    switch (event.type) {
      case "message.delta":
        content += event.content;
        emit?.({ type: "message.delta", content: event.content });
        break;
      case "message.completed":
        if (typeof event.content === "string") content = event.content;
        completed = true;
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

  return { result: { content, toolCalls }, completed };
}

function replaceMessages(target: AgentMessage[], next: AgentMessage[]): void {
  target.splice(0, target.length, ...next);
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

function applyRequestPatch(request: ModelAdapterRequest, patch: ModelAdapterRequestPatch): ModelAdapterRequest {
  return {
    ...request,
    ...(patch.system === undefined ? {} : { system: patch.system }),
    ...(patch.messages === undefined ? {} : { messages: patch.messages }),
    ...(patch.tools === undefined ? {} : { tools: patch.tools }),
    ...(patch.responseFormat === undefined ? {} : { responseFormat: patch.responseFormat }),
    ...(patch.settings === undefined ? {} : { settings: patch.settings }),
    signal: request.signal
  };
}

function appendHookMessages(messages: AgentMessage[], result: AgentLifecycleHookResult): void {
  if (!isObject(result) || !Array.isArray(result.appendMessages)) return;
  messages.push(...result.appendMessages);
}

function hasRequestPatch(result: AgentLifecycleHookResult): result is { request: ModelAdapterRequestPatch } {
  return isObject(result) && isObject(result.request);
}

function hasSkipModelResult(result: AgentLifecycleHookResult): result is { skip: Partial<ModelTurnResult> } {
  return isObject(result) && isObject(result.skip);
}

function hasModelContent(result: AgentLifecycleHookResult): result is { content: string } {
  return isObject(result) && typeof result.content === "string";
}

function hasModelToolCalls(result: AgentLifecycleHookResult): result is { toolCalls: ToolCall[] } {
  return isObject(result) && Array.isArray(result.toolCalls);
}

function hasToolCallPatch(result: AgentLifecycleHookResult): result is { toolCall: ToolCall } {
  return isObject(result) && isToolCall(result.toolCall);
}

function hasSkipToolResult(result: AgentLifecycleHookResult): result is { skip: { result: unknown } } {
  return isObject(result) && isObject(result.skip) && "result" in result.skip;
}

function hasToolResultPatch(result: AgentLifecycleHookResult): result is { result: unknown } {
  return isObject(result) && "result" in result;
}

function isToolCall(value: unknown): value is ToolCall {
  return isObject(value) && typeof value.id === "string" && typeof value.name === "string" && "arguments" in value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hookEventInfo(hook: AgentLifecycleHook): { event: AgentLifecycleHookEvent; name?: string } {
  return {
    event: hook.event,
    ...(hook.name === undefined ? {} : { name: hook.name })
  };
}

async function estimateContextTokens(
  compaction: ContextCompactionConfig,
  input: ContextTokenEstimateInput
): Promise<number> {
  const estimate = compaction.estimateTokens ? await compaction.estimateTokens(input) : defaultTokenEstimate(input);
  return Math.max(0, Math.ceil(Number.isFinite(estimate) ? estimate : 0));
}

function defaultTokenEstimate(input: ContextTokenEstimateInput): number {
  return Math.ceil(safeJsonStringify(input).length / 4);
}

function splitMessagesForCompaction(
  messages: AgentMessage[],
  preserveRecentMessages: number
): { leadingSystem: AgentMessage[]; compacted: AgentMessage[]; preserved: AgentMessage[] } {
  const leadingSystem: AgentMessage[] = [];
  let firstCompactableIndex = 0;
  for (const message of messages) {
    if (message.role !== "system") break;
    leadingSystem.push(message);
    firstCompactableIndex += 1;
  }

  const compactable = messages.slice(firstCompactableIndex);
  const preserveCount = Math.max(0, Math.floor(preserveRecentMessages));
  if (compactable.length <= preserveCount + 1) {
    return { leadingSystem, compacted: [], preserved: compactable };
  }

  const splitIndex = compactable.length - preserveCount;
  return {
    leadingSystem,
    compacted: compactable.slice(0, splitIndex),
    preserved: compactable.slice(splitIndex)
  };
}

async function summarizeMessagesForCompaction(args: {
  compaction: ContextCompactionConfig;
  messages: AgentMessage[];
  signal: AbortSignal;
}): Promise<string> {
  const prompt = args.compaction.prompt.trim() || "Summarize the conversation so far.";
  throwIfAborted(args.signal);
  const stream = args.compaction.model({
    system: prompt,
    messages: [
      {
        role: "user",
        content: `Compact these messages into a concise state summary for continuing the run.\n\n${serializeMessagesForCompaction(args.messages)}`
      }
    ],
    tools: [],
    signal: args.signal,
    ...(args.compaction.settings === undefined ? {} : { settings: args.compaction.settings })
  });
  const { result } = await collectModelTurn(stream, args.signal);
  return result.content;
}

function serializeMessagesForCompaction(messages: AgentMessage[]): string {
  return messages
    .map((message, index) => {
      const metadata = [
        `role=${message.role}`,
        message.name ? `name=${message.name}` : null,
        message.toolCallId ? `toolCallId=${message.toolCallId}` : null
      ]
        .filter(Boolean)
        .join(" ");
      const toolCalls = message.toolCalls?.length ? `\nTool calls: ${safeJsonStringify(message.toolCalls)}` : "";
      return `Message ${index + 1} (${metadata})\n${message.content}${toolCalls}`;
    })
    .join("\n\n");
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
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
