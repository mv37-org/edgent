import { javascript } from "@codemirror/lang-javascript";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { createBrowserAgent, defineTool, type AgentEvent, type ModelAdapter } from "@mv37/edgent";
import { createCodeMirrorEditTool, createCodeMirrorWorkspace } from "@mv37/edgent/codemirror";
import { createPyodideTool, type PythonRuntime } from "@mv37/edgent/pyodide";
import "./style.css";

const editorParent = requireElement<HTMLDivElement>("#editor");
const eventList = requireElement<HTMLOListElement>("#events");
const runButton = requireElement<HTMLButtonElement>("#run");
const approveButton = requireElement<HTMLButtonElement>("#approve");
const rejectButton = requireElement<HTMLButtonElement>("#reject");
const cancelButton = requireElement<HTMLButtonElement>("#cancel");

const view = new EditorView({
  parent: editorParent,
  state: EditorState.create({
    doc: `function greet(name) {\n  return "hello " + name;\n}\n`,
    extensions: [javascript(), keymap.of(defaultKeymap), EditorView.lineWrapping]
  })
});

const workspace = createCodeMirrorWorkspace({ view, documentId: "example.js" });

const pyodideRuntime: PythonRuntime = {
  async runPython(code, input, signal) {
    signal?.throwIfAborted();
    return {
      note: "This example uses a fake Pyodide runtime. Pass a real runtime in your app.",
      code,
      input
    };
  }
};

let modelCalls = 0;
const fakeModel: ModelAdapter = async function* () {
  modelCalls += 1;

  if (modelCalls === 1) {
    yield { type: "message.delta", content: "I will propose a small edit." };
    yield {
      type: "tool.call",
      toolCall: {
        name: "edit_code",
        arguments: {
          action: "replace_document",
          baseVersion: workspace.snapshot().version,
          description: "Use a template literal and a clearer greeting.",
          text: `function greet(name) {\n  return \`Hello, \${name}!\`;\n}\n`
        }
      }
    };
    return;
  }

  yield { type: "message.delta", content: "The edit is applied and ready to review." };
  yield { type: "done" };
};

const agent = createBrowserAgent({
  model: fakeModel,
  system: "You are a concise coding assistant running in the browser.",
  tools: [
    createCodeMirrorEditTool(workspace),
    createPyodideTool(pyodideRuntime),
    defineTool({
      name: "read_document",
      description: "Read the current CodeMirror document.",
      parameters: { type: "object", additionalProperties: false },
      execute() {
        return workspace.snapshot();
      }
    })
  ]
});

let pendingApprovalId: string | undefined;

runButton.addEventListener("click", () => {
  modelCalls = 0;
  eventList.replaceChildren();
  pendingApprovalId = undefined;
  setApprovalButtons(false);

  void (async () => {
    for await (const event of agent.run("Improve the greeting function.")) {
      renderEvent(event);
      if (event.type === "approval.requested") {
        pendingApprovalId = event.approval.id;
        setApprovalButtons(true);
      }
    }
  })();
});

approveButton.addEventListener("click", () => {
  if (!pendingApprovalId) return;
  agent.resolveApproval(pendingApprovalId, { approved: true });
  pendingApprovalId = undefined;
  setApprovalButtons(false);
});

rejectButton.addEventListener("click", () => {
  if (!pendingApprovalId) return;
  agent.resolveApproval(pendingApprovalId, { approved: false, reason: "Rejected in example UI." });
  pendingApprovalId = undefined;
  setApprovalButtons(false);
});

cancelButton.addEventListener("click", () => agent.cancel("Cancelled from example UI."));

function renderEvent(event: AgentEvent): void {
  const item = document.createElement("li");
  item.innerHTML = `<strong>${event.type}</strong><pre>${escapeHtml(JSON.stringify(event, null, 2))}</pre>`;
  eventList.prepend(item);
}

function setApprovalButtons(enabled: boolean): void {
  approveButton.disabled = !enabled;
  rejectButton.disabled = !enabled;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Example DOM is missing required element: ${selector}`);
  return element;
}
