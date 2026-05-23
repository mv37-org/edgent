import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { unifiedMergeView, type DiffConfig } from "@codemirror/merge";
import type { ToolDefinition } from "../core/types";

export interface CodeMirrorWorkspaceOptions {
  view: EditorView;
  documentId?: string;
}

export interface CodeMirrorSelectionRange {
  from: number;
  to: number;
}

export interface CodeMirrorSnapshot {
  documentId: string;
  version: string;
  text: string;
  length: number;
  selection: {
    main: CodeMirrorSelectionRange;
    ranges: CodeMirrorSelectionRange[];
  };
}

export type WorkspaceEdit =
  | {
      kind: "replace-document";
      text: string;
      baseVersion?: string;
      description?: string;
    }
  | {
      kind: "replace-range";
      from: number;
      to: number;
      text: string;
      baseVersion?: string;
      description?: string;
    };

export interface EditPreview {
  before: string;
  after: string;
  targetText: string;
  from: number;
  to: number;
  isEmptyTarget: boolean;
}

export interface EditProposal {
  id: string;
  documentId: string;
  baseVersion: string;
  before: string;
  after: string;
  targetText: string;
  edit: WorkspaceEdit;
  status: "pending" | "applied" | "rejected" | "stale";
  createdAt: number;
  description?: string;
}

export type EditResult =
  | {
      status: "applied";
      documentId: string;
      version: string;
      proposalId?: string;
      autoApplied: boolean;
    }
  | {
      status: "proposed";
      proposal: EditProposal;
    }
  | {
      status: "rejected";
      proposalId: string;
      reason?: string;
    };

export type ProposedEditResult = Exclude<EditResult, { status: "rejected" }>;

export interface CodeMirrorWorkspace {
  readonly documentId: string;
  snapshot(): CodeMirrorSnapshot;
  previewEdit(edit: WorkspaceEdit): EditPreview;
  proposeEdit(edit: WorkspaceEdit): ProposedEditResult;
  applyEdit(edit: WorkspaceEdit): Extract<EditResult, { status: "applied" }>;
  applyProposal(proposalId: string): Extract<EditResult, { status: "applied" }>;
  rejectProposal(proposalId: string, reason?: string): Extract<EditResult, { status: "rejected" }>;
  getProposal(proposalId: string): EditProposal | undefined;
  onProposal(handler: (proposal: EditProposal) => void): () => void;
}

export interface CodeMirrorEditToolOptions {
  name?: string;
  description?: string;
}

export interface CodeMirrorEditToolArgs {
  action: "replace_document" | "replace_range";
  text: string;
  from?: number;
  to?: number;
  baseVersion?: string;
  description?: string;
}

export interface ProposalDiffOptions {
  highlightChanges?: boolean;
  gutter?: boolean;
  allowInlineDiffs?: boolean;
  mergeControls?: boolean;
  diffConfig?: DiffConfig;
}

export function createCodeMirrorWorkspace(options: CodeMirrorWorkspaceOptions): CodeMirrorWorkspace {
  return new CodeMirrorWorkspaceRuntime(options.view, options.documentId ?? "codemirror-document");
}

export function createCodeMirrorEditTool(
  workspace: CodeMirrorWorkspace,
  options: CodeMirrorEditToolOptions = {}
): ToolDefinition<CodeMirrorEditToolArgs, EditResult> {
  return {
    name: options.name ?? "edit_code",
    description:
      options.description ??
      "Edit the current CodeMirror document. Empty targets apply immediately; non-empty targets request approval with a diff.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action", "text"],
      properties: {
        action: {
          type: "string",
          enum: ["replace_document", "replace_range"],
          description: "Use replace_document for the entire buffer or replace_range for a specific range."
        },
        text: {
          type: "string",
          description: "Replacement text."
        },
        from: {
          type: "integer",
          minimum: 0,
          description: "Start offset for replace_range."
        },
        to: {
          type: "integer",
          minimum: 0,
          description: "End offset for replace_range."
        },
        baseVersion: {
          type: "string",
          description: "Document version from a previous snapshot."
        },
        description: {
          type: "string",
          description: "Short explanation shown near the diff proposal."
        }
      }
    },
    async execute(args, context) {
      const edit = editToolArgsToWorkspaceEdit(args);
      const result = workspace.proposeEdit(edit);

      if (result.status === "applied") {
        context.emit({
          type: "edit.applied",
          proposalId: result.proposalId ?? "auto",
          result
        });
        return result;
      }

      context.emit({ type: "edit.proposed", proposal: result.proposal });
      const approval = await context.requestApproval({
        kind: "edit",
        title: "Apply editor change",
        data: result.proposal,
        ...(result.proposal.description === undefined ? {} : { description: result.proposal.description })
      });

      if (!approval.approved) {
        return workspace.rejectProposal(result.proposal.id, approval.reason);
      }

      const applied = workspace.applyProposal(result.proposal.id);
      context.emit({
        type: "edit.applied",
        proposalId: result.proposal.id,
        result: applied
      });
      return applied;
    }
  };
}

export function createProposalDiffExtensions(proposal: EditProposal, options: ProposalDiffOptions = {}): Extension[] {
  return [
    unifiedMergeView({
      original: proposal.before,
      ...(options.highlightChanges === undefined ? {} : { highlightChanges: options.highlightChanges }),
      ...(options.gutter === undefined ? {} : { gutter: options.gutter }),
      ...(options.allowInlineDiffs === undefined ? {} : { allowInlineDiffs: options.allowInlineDiffs }),
      ...(options.mergeControls === undefined ? {} : { mergeControls: options.mergeControls }),
      ...(options.diffConfig === undefined ? {} : { diffConfig: options.diffConfig })
    })
  ];
}

export function createProposalDiffState(proposal: EditProposal, extensions: Extension[] = []): EditorState {
  return EditorState.create({
    doc: proposal.after,
    extensions: [...extensions, createProposalDiffExtensions(proposal)]
  });
}

class CodeMirrorWorkspaceRuntime implements CodeMirrorWorkspace {
  private readonly proposals = new Map<string, EditProposal>();
  private readonly proposalListeners = new Set<(proposal: EditProposal) => void>();

  constructor(
    private readonly view: EditorView,
    readonly documentId: string
  ) {}

  snapshot(): CodeMirrorSnapshot {
    const text = this.view.state.doc.toString();
    const main = this.view.state.selection.main;
    return {
      documentId: this.documentId,
      version: versionForText(text),
      text,
      length: text.length,
      selection: {
        main: { from: main.from, to: main.to },
        ranges: this.view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }))
      }
    };
  }

  previewEdit(edit: WorkspaceEdit): EditPreview {
    const snapshot = this.snapshot();
    assertFresh(snapshot.version, edit.baseVersion);

    const range = editRange(edit, snapshot.length);
    const before = snapshot.text;
    const targetText = before.slice(range.from, range.to);
    const after = `${before.slice(0, range.from)}${edit.text}${before.slice(range.to)}`;

    return {
      before,
      after,
      targetText,
      from: range.from,
      to: range.to,
      isEmptyTarget: targetText.length === 0
    };
  }

  proposeEdit(edit: WorkspaceEdit): ProposedEditResult {
    const preview = this.previewEdit(edit);
    if (preview.isEmptyTarget) {
      return this.applyEdit(edit);
    }

    const proposal: EditProposal = {
      id: createId("edit"),
      documentId: this.documentId,
      baseVersion: edit.baseVersion ?? this.snapshot().version,
      before: preview.before,
      after: preview.after,
      targetText: preview.targetText,
      edit,
      status: "pending",
      createdAt: Date.now(),
      ...(edit.description === undefined ? {} : { description: edit.description })
    };
    this.proposals.set(proposal.id, proposal);
    for (const listener of this.proposalListeners) listener(proposal);
    return { status: "proposed", proposal };
  }

  applyEdit(edit: WorkspaceEdit): Extract<EditResult, { status: "applied" }> {
    const snapshot = this.snapshot();
    assertFresh(snapshot.version, edit.baseVersion);
    const range = editRange(edit, snapshot.length);
    this.view.dispatch({
      changes: {
        from: range.from,
        to: range.to,
        insert: edit.text
      }
    });

    return {
      status: "applied",
      documentId: this.documentId,
      version: this.snapshot().version,
      autoApplied: true
    };
  }

  applyProposal(proposalId: string): Extract<EditResult, { status: "applied" }> {
    const proposal = this.requireProposal(proposalId);
    if (proposal.status !== "pending") {
      throw new Error(`Cannot apply ${proposal.status} edit proposal: ${proposalId}`);
    }

    try {
      const result = this.applyEdit(proposal.edit);
      proposal.status = "applied";
      return {
        ...result,
        proposalId,
        autoApplied: false
      };
    } catch (error) {
      proposal.status = "stale";
      throw error;
    }
  }

  rejectProposal(proposalId: string, reason?: string): Extract<EditResult, { status: "rejected" }> {
    const proposal = this.requireProposal(proposalId);
    proposal.status = "rejected";
    return {
      status: "rejected",
      proposalId,
      ...(reason === undefined ? {} : { reason })
    };
  }

  getProposal(proposalId: string): EditProposal | undefined {
    return this.proposals.get(proposalId);
  }

  onProposal(handler: (proposal: EditProposal) => void): () => void {
    this.proposalListeners.add(handler);
    return () => this.proposalListeners.delete(handler);
  }

  private requireProposal(proposalId: string): EditProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Unknown edit proposal: ${proposalId}`);
    return proposal;
  }
}

function editToolArgsToWorkspaceEdit(args: CodeMirrorEditToolArgs): WorkspaceEdit {
  if (args.action === "replace_document") {
    return {
      kind: "replace-document",
      text: args.text,
      ...(args.baseVersion === undefined ? {} : { baseVersion: args.baseVersion }),
      ...(args.description === undefined ? {} : { description: args.description })
    };
  }

  if (typeof args.from !== "number" || typeof args.to !== "number") {
    throw new Error("replace_range requires numeric from and to offsets.");
  }

  return {
    kind: "replace-range",
    from: args.from,
    to: args.to,
    text: args.text,
    ...(args.baseVersion === undefined ? {} : { baseVersion: args.baseVersion }),
    ...(args.description === undefined ? {} : { description: args.description })
  };
}

function editRange(edit: WorkspaceEdit, length: number): { from: number; to: number } {
  if (edit.kind === "replace-document") return { from: 0, to: length };
  if (edit.from > edit.to) throw new Error("Edit range start must be before or equal to range end.");
  if (edit.from < 0 || edit.to > length) throw new Error(`Edit range ${edit.from}:${edit.to} is outside the document.`);
  return { from: edit.from, to: edit.to };
}

function assertFresh(currentVersion: string, baseVersion?: string): void {
  if (baseVersion && baseVersion !== currentVersion) {
    throw new Error(`Stale document version. Expected ${baseVersion}, current version is ${currentVersion}.`);
  }
}

function versionForText(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 33) ^ text.charCodeAt(index);
  }
  return `v${(hash >>> 0).toString(36)}:${text.length}`;
}

function createId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Math.random().toString(36).slice(2)}`;
}
