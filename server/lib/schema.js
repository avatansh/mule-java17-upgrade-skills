// server/lib/schema.js — tiny JSON Schema validator (the subset our tool inputSchemas use).
//
// Dependency-free by design (the suite ships only js-yaml). Validates the exact features the tool
// catalog declares: object `type`, `required`, `properties` types, `enum`, and
// `additionalProperties:false`. Returns an array of human-readable problem strings ([] === valid);
// it is the "schema-contract guard" enforced before any tool handler runs. Nested object/array
// property values are type-checked but not deeply descended (our schemas are one level deep).

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v; // "object" | "string" | "number" | "boolean" | "undefined"
}

function matchesType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true; // unknown/absent type → accept
  }
}

/**
 * validateArgs(args, schema): return an array of problem strings. Empty array === valid.
 * @param {object} args
 * @param {object} schema  JSON Schema (object-typed)
 */
export function validateArgs(args, schema) {
  const problems = [];
  if (!schema || typeof schema !== "object") return problems;

  if (schema.type && !matchesType(args, schema.type)) {
    problems.push(`expected ${schema.type}, got ${typeOf(args)}`);
    return problems; // can't check properties of a non-object
  }
  const props = schema.properties ?? {};

  // required
  for (const key of schema.required ?? []) {
    if (args == null || !(key in args) || args[key] === undefined) {
      problems.push(`missing required property "${key}"`);
    }
  }

  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined) continue;
      const spec = props[key];
      if (!spec) {
        if (schema.additionalProperties === false) problems.push(`unexpected property "${key}"`);
        continue;
      }
      if (spec.type && !matchesType(value, spec.type)) {
        problems.push(`property "${key}" expected ${spec.type}, got ${typeOf(value)}`);
      }
      if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
        problems.push(`property "${key}" must be one of ${JSON.stringify(spec.enum)}`);
      }
    }
  }
  return problems;
}
