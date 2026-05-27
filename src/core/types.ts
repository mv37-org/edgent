export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JSONSchema =
  | boolean
  | {
      type?: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
      description?: string;
      properties?: Record<string, JSONSchema>;
      required?: string[];
      items?: JSONSchema;
      enum?: JsonValue[];
      additionalProperties?: boolean | JSONSchema;
      minimum?: number;
      maximum?: number;
      minLength?: number;
      maxLength?: number;
      [keyword: string]: unknown;
    };

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface AgentMessage {
  role: AgentRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export interface ApprovalRequest<TData = unknown> {
  id: string;
  kind: string;
  title: string;
  description?: string;
  data?: TData;
}

export interface ApprovalRequestInput<TData = unknown> {
  kind?: string;
  title: string;
  description?: string;
  data?: TData;
}

export interface ApprovalResult<TValue = unknown> {
  approved: boolean;
  value?: TValue;
  reason?: string;
}

export interface ToolContext {
  runId: string;
  turn: number;
  signal: AbortSignal;
  emit(event: AgentEventInput): void;
  requestApproval<TData = unknown, TValue = unknown>(
    request: ApprovalRequestInput<TData>
  ): Promise<ApprovalResult<TValue>>;
}

export interface ToolDefinition<TArgs = unknown, TResult = unknown> extends ToolSpec {
  execute(args: TArgs, context: ToolContext): Promise<TResult> | TResult;
}

export type ModelStreamEvent =
  | { type: "message.delta"; content: string }
  | { type: "message.completed"; content?: string }
  | { type: "tool.call"; toolCall: { id?: string; name: string; arguments: unknown } }
  | { type: "error"; error: unknown }
  | { type: "done" };

export interface ModelAdapterRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  responseFormat?: unknown;
  settings?: Record<string, unknown>;
  signal: AbortSignal;
}

export type ModelAdapter = (request: ModelAdapterRequest) => AsyncIterable<ModelStreamEvent>;

export interface ModelTurnResult {
  content: string;
  toolCalls: ToolCall[];
}

export type AgentLifecycleHookEvent =
  | "before_model_call"
  | "after_model_call"
  | "before_tool_call"
  | "after_tool_call"
  | "on_error";

export interface AgentLifecycleHookBaseInput {
  event: AgentLifecycleHookEvent;
  runId: string;
  turn: number;
  messages: AgentMessage[];
  signal: AbortSignal;
  emit(event: AgentEventInput): void;
}

export interface BeforeModelCallHookInput extends AgentLifecycleHookBaseInput {
  event: "before_model_call";
  request: ModelAdapterRequest;
}

export interface AfterModelCallHookInput extends AgentLifecycleHookBaseInput {
  event: "after_model_call";
  result: ModelTurnResult;
}

export interface BeforeToolCallHookInput extends AgentLifecycleHookBaseInput {
  event: "before_tool_call";
  toolCall: ToolCall;
}

export interface AfterToolCallHookInput extends AgentLifecycleHookBaseInput {
  event: "after_tool_call";
  toolCall: ToolCall;
  result: unknown;
}

export interface ErrorHookInput extends AgentLifecycleHookBaseInput {
  event: "on_error";
  error: AgentErrorInfo;
}

export type AgentLifecycleHookInput =
  | BeforeModelCallHookInput
  | AfterModelCallHookInput
  | BeforeToolCallHookInput
  | AfterToolCallHookInput
  | ErrorHookInput;

export interface ModelAdapterRequestPatch {
  system?: string;
  messages?: AgentMessage[];
  tools?: ToolSpec[];
  responseFormat?: unknown;
  settings?: Record<string, unknown>;
}

export interface BeforeModelCallHookResult {
  request?: ModelAdapterRequestPatch;
  skip?: Partial<ModelTurnResult>;
}

export interface AfterModelCallHookResult {
  content?: string;
  toolCalls?: ToolCall[];
  appendMessages?: AgentMessage[];
}

export interface BeforeToolCallHookResult {
  toolCall?: ToolCall;
  skip?: { result: unknown };
  appendMessages?: AgentMessage[];
}

export interface AfterToolCallHookResult {
  result?: unknown;
  appendMessages?: AgentMessage[];
}

export interface ErrorHookResult {
  appendMessages?: AgentMessage[];
}

export type AgentLifecycleHookResult =
  | void
  | BeforeModelCallHookResult
  | AfterModelCallHookResult
  | BeforeToolCallHookResult
  | AfterToolCallHookResult
  | ErrorHookResult;

export type AgentLifecycleHookHandler = (
  input: AgentLifecycleHookInput
) => Promise<AgentLifecycleHookResult> | AgentLifecycleHookResult;

export interface AgentLifecycleHook {
  event: AgentLifecycleHookEvent;
  name?: string;
  handler: AgentLifecycleHookHandler;
}

export interface ContextTokenEstimateInput {
  runId: string;
  turn: number;
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  responseFormat?: unknown;
  settings?: Record<string, unknown>;
}

export type ContextTokenEstimator = (input: ContextTokenEstimateInput) => number | Promise<number>;

export interface ContextCompactionConfig {
  enabled?: boolean;
  thresholdPercent: number;
  contextWindowTokens: number;
  prompt: string;
  model: ModelAdapter;
  preserveRecentMessages?: number;
  estimateTokens?: ContextTokenEstimator;
  settings?: Record<string, unknown>;
}

export type AgentRunInput =
  | string
  | {
      input?: string;
      messages?: AgentMessage[];
      metadata?: Record<string, unknown>;
    };

export interface BrowserAgentConfig {
  model: ModelAdapter;
  system?: string;
  tools?: ToolDefinition[];
  maxTurns?: number;
  responseFormat?: unknown;
  settings?: Record<string, unknown>;
  hooks?: AgentLifecycleHook[];
  contextCompaction?: ContextCompactionConfig;
}

export type AgentEvent =
  | {
      type: "run.started";
      runId: string;
      timestamp: number;
      input: AgentRunInput;
    }
  | {
      type: "message.delta";
      runId: string;
      timestamp: number;
      content: string;
    }
  | {
      type: "message.completed";
      runId: string;
      timestamp: number;
      content: string;
    }
  | {
      type: "tool.started";
      runId: string;
      timestamp: number;
      toolCall: ToolCall;
    }
  | {
      type: "tool.result";
      runId: string;
      timestamp: number;
      toolCall: ToolCall;
      result: unknown;
    }
  | {
      type: "tool.error";
      runId: string;
      timestamp: number;
      toolCall: ToolCall;
      error: AgentErrorInfo;
    }
  | {
      type: "hook.started";
      runId: string;
      timestamp: number;
      hook: {
        event: AgentLifecycleHookEvent;
        name?: string;
      };
    }
  | {
      type: "hook.completed";
      runId: string;
      timestamp: number;
      hook: {
        event: AgentLifecycleHookEvent;
        name?: string;
      };
    }
  | {
      type: "hook.error";
      runId: string;
      timestamp: number;
      hook: {
        event: AgentLifecycleHookEvent;
        name?: string;
      };
      error: AgentErrorInfo;
    }
  | {
      type: "context.compaction.started";
      runId: string;
      timestamp: number;
      tokenEstimate: number;
      thresholdTokens: number;
      compactedMessageCount: number;
      preservedMessageCount: number;
    }
  | {
      type: "context.compaction.completed";
      runId: string;
      timestamp: number;
      tokenEstimate: number;
      thresholdTokens: number;
      summary: string;
      compactedMessageCount: number;
      preservedMessageCount: number;
    }
  | {
      type: "edit.proposed";
      runId: string;
      timestamp: number;
      proposal: unknown;
    }
  | {
      type: "edit.applied";
      runId: string;
      timestamp: number;
      proposalId: string;
      result: unknown;
    }
  | {
      type: "approval.requested";
      runId: string;
      timestamp: number;
      approval: ApprovalRequest;
    }
  | {
      type: "approval.resolved";
      runId: string;
      timestamp: number;
      approvalId: string;
      result: ApprovalResult;
    }
  | {
      type: "run.error";
      runId: string;
      timestamp: number;
      error: AgentErrorInfo;
    }
  | {
      type: "run.completed";
      runId: string;
      timestamp: number;
      messages: AgentMessage[];
    }
  | {
      type: "run.cancelled";
      runId: string;
      timestamp: number;
      reason?: string;
    };

export type AgentEventInput = AgentEvent extends infer T
  ? T extends AgentEvent
    ? Omit<T, "runId" | "timestamp"> & {
        runId?: string;
        timestamp?: number;
      }
    : never
  : never;

export interface AgentErrorInfo {
  name: string;
  message: string;
  stack?: string;
  cause?: unknown;
}

export interface BrowserAgent {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(reason?: string): void;
  on(eventName: "event", handler: (event: AgentEvent) => void): () => void;
  resolveApproval<TValue = unknown>(approvalId: string, result: ApprovalResult<TValue>): boolean;
}
