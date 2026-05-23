import { describe, expect, it } from "vitest";
import { createPyodideTool, type PythonRuntime } from "../src/pyodide";

describe("createPyodideTool", () => {
  it("delegates code execution to the host runtime", async () => {
    const calls: Array<{ code: string; input: unknown; signal?: AbortSignal }> = [];
    const runtime: PythonRuntime = {
      async runPython(code, input, signal) {
        calls.push({
          code,
          input,
          ...(signal === undefined ? {} : { signal })
        });
        return { ok: true };
      }
    };

    const tool = createPyodideTool(runtime);
    const result = await tool.execute(
      { code: "x = input['value'] + 1", input: { value: 41 } },
      {
        runId: "run_test",
        turn: 0,
        signal: new AbortController().signal,
        emit: () => undefined,
        requestApproval: async () => ({ approved: true })
      }
    );

    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      code: "x = input['value'] + 1",
      input: { value: 41 }
    });
  });
});
