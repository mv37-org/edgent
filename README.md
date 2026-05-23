# Edgent

[![npm version](https://img.shields.io/npm/v/@mv37/edgent?label=npm)](https://www.npmjs.com/package/@mv37/edgent)
[![npm downloads](https://img.shields.io/npm/dm/@mv37/edgent)](https://www.npmjs.com/package/@mv37/edgent)
[![license](https://img.shields.io/npm/l/@mv37/edgent)](./LICENSE)
[![typecheck](https://img.shields.io/badge/typecheck-passing-brightgreen)](#local-development)
[![tests](https://img.shields.io/badge/tests-13%20passing-brightgreen)](#local-development)
[![browser ESM](https://img.shields.io/badge/browser-ESM-blue)](#what-edgent-does-not-provide)

Edgent is a browser-only, headless TypeScript SDK for building lightweight agents that can inspect and edit a CodeMirror editor, call schema-first JavaScript tools, and stream every step to your own UI.

It is built for apps that want an agent loop in the browser without adopting a full IDE, backend runtime, Git integration, terminal emulator, or React UI kit.

## What Edgent Provides

- A headless agent loop with `run()`, `cancel()`, async event iteration, and event listeners.
- A provider-neutral `ModelAdapter` interface. Use OpenAI, Anthropic, Gemini, OpenRouter, your own backend, or a mock model.
- Schema-first JavaScript tools with lightweight argument validation.
- A CodeMirror 6 workspace adapter for snapshots, versioned edits, stale-edit checks, and diff approval.
- A Pyodide helper that wraps a host-provided Python runtime as a tool.
- A small Vite example app that demonstrates model streaming, tool calls, edit approvals, and event rendering.

## What Edgent Does Not Provide

- No bundled model provider clients.
- No hidden API keys or hosted service.
- No Git, terminal, project tree, or filesystem abstraction.
- No React components.
- No bundled Pyodide runtime. The host app brings and initializes Pyodide.

This keeps the package small and lets the host app remain the authority for credentials, storage, permissions, UI, and side effects.

## Install

```sh
npm install @mv37/edgent @codemirror/state @codemirror/view @codemirror/merge
```

The package is ESM-only and intended for browser builds.

## Quick Start

```ts
import { createBrowserAgent, defineTool, type ModelAdapter } from "@mv37/edgent";
import { createCodeMirrorEditTool, createCodeMirrorWorkspace } from "@mv37/edgent/codemirror";
import { createPyodideTool, type PythonRuntime } from "@mv37/edgent/pyodide";

const workspace = createCodeMirrorWorkspace({ view });

const model: ModelAdapter = async function* (request) {
  // Call a model provider directly, or send this normalized request to your backend.
  // Then yield normalized stream events back to Edgent.
  yield { type: "message.delta", content: "I can help edit this buffer." };
  yield { type: "done" };
};

const pyodideRuntime: PythonRuntime = {
  async runPython(code, input, signal) {
    signal?.throwIfAborted();
    pyodide.globals.set("input", input);
    return pyodide.runPythonAsync(code);
  }
};

const agent = createBrowserAgent({
  model,
  system: "You are a precise browser-local coding assistant.",
  tools: [
    createCodeMirrorEditTool(workspace),
    createPyodideTool(pyodideRuntime),
    defineTool({
      name: "read_selection",
      description: "Read the current CodeMirror selection.",
      parameters: { type: "object", additionalProperties: false },
      execute() {
        return workspace.snapshot().selection;
      }
    })
  ]
});

for await (const event of agent.run("Refactor this function.")) {
  renderTimeline(event);

  if (event.type === "approval.requested") {
    showDiff(event.approval.data);
    // Resolve this later from your own UI.
    agent.resolveApproval(event.approval.id, { approved: true });
  }
}
```

## Core API

```ts
const agent = createBrowserAgent({
  model,
  system,
  tools,
  maxTurns,
  responseFormat,
  settings
});
```

`agent.run(input)` starts a run and returns an `AsyncIterable<AgentEvent>`.

```ts
for await (const event of agent.run("Update the code.")) {
  console.log(event.type, event);
}
```

You can also subscribe to every event:

```ts
const unsubscribe = agent.on("event", (event) => {
  renderTimeline(event);
});
```

Cancel the active run:

```ts
agent.cancel("User cancelled");
```

Resolve approvals from your UI:

```ts
agent.resolveApproval(approvalId, { approved: true });
agent.resolveApproval(approvalId, { approved: false, reason: "Not this change." });
```

## Model Adapter

Edgent does not own API keys or vendor protocols. Your app passes a model adapter:

```ts
type ModelAdapter = (request: {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  responseFormat?: unknown;
  settings?: Record<string, unknown>;
  signal: AbortSignal;
}) => AsyncIterable<ModelStreamEvent>;
```

Supported normalized stream events:

```ts
type ModelStreamEvent =
  | { type: "message.delta"; content: string }
  | { type: "message.completed"; content?: string }
  | { type: "tool.call"; toolCall: { id?: string; name: string; arguments: unknown } }
  | { type: "error"; error: unknown }
  | { type: "done" };
```

This makes both deployment styles possible:

- Browser BYOK: users paste their own provider key and the host app calls the provider directly.
- Backend proxy: the host app sends the normalized request to a server and streams normalized events back.

For public browser apps, never embed a secret provider key in client code. User-submitted keys are visible to that user's browser runtime by design.

## Tools

Tools are schema-first JavaScript functions.

```ts
const readDocument = defineTool({
  name: "read_document",
  description: "Read the current document text.",
  parameters: {
    type: "object",
    additionalProperties: false
  },
  execute(_args, context) {
    context.emit({ type: "message.delta", content: "Reading editor state..." });
    return workspace.snapshot();
  }
});
```

Tool arguments are validated against a small JSON Schema subset before `execute()` runs. Failed validation emits `tool.error` and returns the error to the model as a tool result.

Tools receive:

- `runId`
- `turn`
- `signal`
- `emit(event)`
- `requestApproval(request)`

Use tools as the permission boundary. If the host does not register a tool, the agent cannot do that action.

## CodeMirror Adapter

```ts
import { createCodeMirrorEditTool, createCodeMirrorWorkspace } from "@mv37/edgent/codemirror";

const workspace = createCodeMirrorWorkspace({
  view,
  documentId: "main.ts"
});

const editTool = createCodeMirrorEditTool(workspace);
```

The workspace provides:

- `snapshot()`
- `previewEdit(edit)`
- `proposeEdit(edit)`
- `applyEdit(edit)`
- `applyProposal(proposalId)`
- `rejectProposal(proposalId, reason)`
- `getProposal(proposalId)`
- `onProposal(handler)`

Editing semantics:

- Edits target a document version derived from the current text.
- Empty target content applies immediately.
- Non-empty target content creates an edit proposal, emits approval events, and waits for the host to approve or reject.
- Stale edits fail before changing the editor.

Render a proposed diff with CodeMirror merge primitives:

```ts
import { createProposalDiffState } from "@mv37/edgent/codemirror";

const diffState = createProposalDiffState(proposal);
const diffView = new EditorView({ state: diffState, parent });
```

## Pyodide

Edgent requires the host to bring and initialize Pyodide. The SDK only wraps that runtime as a tool.

```ts
import { createPyodideTool } from "@mv37/edgent/pyodide";

const runPython = createPyodideTool({
  async runPython(code, input, signal) {
    signal?.throwIfAborted();
    pyodide.globals.set("input", input);
    return pyodide.runPythonAsync(code);
  }
});
```

The helper registers a `run_python` tool by default. You can override the name, description, and input schema.

## Event Stream

`agent.run(input)` returns an async iterable and also publishes through `agent.on("event", handler)`.

Core events include:

- `run.started`
- `message.delta`
- `message.completed`
- `tool.started`
- `tool.result`
- `tool.error`
- `edit.proposed`
- `edit.applied`
- `approval.requested`
- `approval.resolved`
- `run.completed`
- `run.cancelled`
- `run.error`

These events are designed to be rendered directly by custom chat panes, timeline views, inspectors, or debug consoles.

## Example App

```sh
git clone https://github.com/mv37-org/edgent.git
cd edgent
npm install
npm run build
npm install --prefix examples/codemirror-basic
npm run dev --prefix examples/codemirror-basic
```

The example uses a fake streaming model so you can inspect the event stream, approval flow, and CodeMirror edit path without configuring a provider.

## Local Development

```sh
npm install
npm run typecheck
npm run lint
npm run test
npm run format
npm run build
npm pack --dry-run
```

The package publishes only `dist`, `README.md`, `CHANGELOG.md`, `LICENSE`, and `package.json`.

## Package Exports

```ts
import { createBrowserAgent, defineTool } from "@mv37/edgent";
import { createCodeMirrorWorkspace, createCodeMirrorEditTool } from "@mv37/edgent/codemirror";
import { createPyodideTool } from "@mv37/edgent/pyodide";
```

## Status

Edgent is early. The v1 surface is intentionally small: browser-only ESM, CodeMirror-first, headless, and host-controlled.

## License

MIT
