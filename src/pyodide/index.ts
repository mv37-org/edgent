import type { JSONSchema, ToolDefinition } from "../core/types";

export interface PythonRuntime {
  runPython(code: string, input?: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface PyodideToolOptions {
  name?: string;
  description?: string;
  inputSchema?: JSONSchema;
}

export interface RunPythonArgs {
  code: string;
  input?: unknown;
}

export function createPyodideTool(
  runtime: PythonRuntime,
  options: PyodideToolOptions = {}
): ToolDefinition<RunPythonArgs, unknown> {
  return {
    name: options.name ?? "run_python",
    description:
      options.description ??
      "Run Python in the host-provided Pyodide runtime. Use this for lightweight browser-local execution.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["code"],
      properties: {
        code: {
          type: "string",
          description: "Python code to execute."
        },
        input: options.inputSchema ?? true
      }
    },
    execute(args, context) {
      return runtime.runPython(args.code, args.input, context.signal);
    }
  };
}
