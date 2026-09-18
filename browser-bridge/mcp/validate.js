// A small validator for the subset of JSON Schema the tool definitions use.
//
// Models send `clear: "false"` and `tabId: "123"` often enough that forwarding them
// unchecked is a real bug: the string "false" is truthy, and the clear flag wipes a
// buffer nobody asked to clear. No dependency: the schemas here are simple and known.

const TYPE_NAMES = {
  string: (value) => typeof value === "string",
  number: (value) => typeof value === "number" && Number.isFinite(value),
  integer: (value) => typeof value === "number" && Number.isInteger(value),
  boolean: (value) => typeof value === "boolean",
  object: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  null: (value) => value === null,
};

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((name) => TYPE_NAMES[name]?.(value) ?? true);
}

/** Returns a list of human-readable problems; empty means valid. */
export function validateValue(value, schema, path = "input") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  if (schema.type && !matchesType(value, schema.type)) {
    const want = Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type;
    errors.push(`${path} must be ${want} (got ${typeOf(value)})`);
    return errors; // every other rule assumes the type held
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be at most ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path} needs at least ${schema.minItems} item(s)`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path} takes at most ${schema.maxItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateValue(item, schema.items, `${path}[${index}]`));
      });
    }
  }

  if (TYPE_NAMES.object(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) errors.push(`${path}.${key} is required`);
    }
    for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      errors.push(...validateValue(value[key], subSchema, `${path}.${key}`));
    }
  }

  return errors;
}

/** null when the input is acceptable, otherwise the message to hand back to the model. */
export function validateToolInput(tool, input) {
  const value = input ?? {};
  if (!TYPE_NAMES.object(value)) return `Invalid input for ${tool.name}: it must be an object`;
  const errors = validateValue(value, tool.inputSchema, "input");
  if (errors.length === 0) return null;
  return `Invalid input for ${tool.name}: ${errors.slice(0, 5).join("; ")}`;
}
