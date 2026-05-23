import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserAgent, type AgentEvent, type ModelAdapter } from "../src";
import { createCodeMirrorEditTool, createCodeMirrorWorkspace, createProposalDiffState } from "../src/codemirror";

const views: EditorView[] = [];

function createView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({ doc }),
    parent
  });
  views.push(view);
  return view;
}

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

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.remove();
    view.destroy();
  }
});

describe("CodeMirror workspace", () => {
  it("snapshots editor state", () => {
    const workspace = createCodeMirrorWorkspace({ view: createView("hello") });
    const snapshot = workspace.snapshot();

    expect(snapshot).toMatchObject({
      documentId: "codemirror-document",
      text: "hello",
      length: 5
    });
    expect(snapshot.version).toMatch(/^v/);
  });

  it("auto-applies edits against empty targets", () => {
    const view = createView("");
    const workspace = createCodeMirrorWorkspace({ view });
    const result = workspace.proposeEdit({
      kind: "replace-document",
      text: "const value = 1;"
    });

    expect(result).toMatchObject({
      status: "applied",
      autoApplied: true
    });
    expect(view.state.doc.toString()).toBe("const value = 1;");
  });

  it("creates a pending proposal for non-empty edits and applies it after approval", () => {
    const view = createView("const value = 1;");
    const workspace = createCodeMirrorWorkspace({ view });
    const snapshot = workspace.snapshot();
    const result = workspace.proposeEdit({
      kind: "replace-document",
      text: "const value = 2;",
      baseVersion: snapshot.version,
      description: "Update value."
    });

    expect(result.status).toBe("proposed");
    if (result.status !== "proposed") throw new Error("Expected a proposed edit.");
    expect(view.state.doc.toString()).toBe("const value = 1;");
    expect(result.proposal.status).toBe("pending");

    const diffState = createProposalDiffState(result.proposal);
    expect(diffState.doc.toString()).toBe("const value = 2;");

    const applied = workspace.applyProposal(result.proposal.id);
    expect(applied).toMatchObject({
      status: "applied",
      autoApplied: false,
      proposalId: result.proposal.id
    });
    expect(view.state.doc.toString()).toBe("const value = 2;");
  });

  it("rejects stale edits", () => {
    const view = createView("alpha");
    const workspace = createCodeMirrorWorkspace({ view });
    const snapshot = workspace.snapshot();
    view.dispatch({ changes: { from: 0, to: 5, insert: "beta" } });

    expect(() =>
      workspace.applyEdit({
        kind: "replace-document",
        text: "gamma",
        baseVersion: snapshot.version
      })
    ).toThrow(/Stale document version/);
  });

  it("waits for approval when the CodeMirror edit tool changes non-empty content", async () => {
    const view = createView("one");
    const workspace = createCodeMirrorWorkspace({ view });
    let calls = 0;
    const model: ModelAdapter = async function* () {
      calls += 1;
      if (calls === 1) {
        yield {
          type: "tool.call",
          toolCall: {
            name: "edit_code",
            arguments: {
              action: "replace_document",
              text: "two",
              baseVersion: workspace.snapshot().version,
              description: "Replace one with two."
            }
          }
        };
        return;
      }
      yield { type: "message.delta", content: "changed" };
    };

    const agent = createBrowserAgent({
      model,
      tools: [createCodeMirrorEditTool(workspace)]
    });

    const events = await collect(agent.run("change it"), (event) => {
      if (event.type === "approval.requested") {
        agent.resolveApproval(event.approval.id, { approved: true });
      }
    });

    expect(events.some((event) => event.type === "edit.proposed")).toBe(true);
    expect(events.some((event) => event.type === "approval.requested")).toBe(true);
    expect(events.some((event) => event.type === "edit.applied")).toBe(true);
    expect(view.state.doc.toString()).toBe("two");
  });
});
