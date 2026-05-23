import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "../src";

describe("validateJsonSchema", () => {
  it("validates required properties and primitive types", () => {
    const result = validateJsonSchema(
      { name: "Ada", attempts: 3 },
      {
        type: "object",
        required: ["name", "attempts"],
        properties: {
          name: { type: "string" },
          attempts: { type: "integer", minimum: 1 }
        },
        additionalProperties: false
      }
    );

    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("reports nested validation errors", () => {
    const result = validateJsonSchema(
      { name: "Ada", extra: true },
      {
        type: "object",
        required: ["attempts"],
        properties: {
          name: { type: "number" }
        },
        additionalProperties: false
      }
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["$.attempts is required", "$.name must be number", "$.extra is not allowed"]);
  });
});
