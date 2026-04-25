import { Buffer } from "node:buffer";
import { QueryError, ValidationError } from "./errors.js";
import type { FieldMeta } from "./field.js";
import type { FieldType, JsonObject, JsonValue } from "./types.js";

export type RuntimeValue = number | string | boolean | Date | Uint8Array | JsonValue | null;
export type RuntimeRow = Record<string, RuntimeValue>;
export type SerializedValue = JsonValue;
export type SerializedRow = Record<string, SerializedValue>;

const blobMarker = "$simpleDbBlob";

export function normalizeValue(meta: FieldMeta, value: unknown, label: string): RuntimeValue {
  if (value === null) {
    if (meta.nullable) {
      return null;
    }
    throw new ValidationError(`${label} cannot be null.`);
  }

  if (value === undefined) {
    throw new ValidationError(`${label} is required.`);
  }

  switch (meta.type) {
    case "int":
      if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
        throw new ValidationError(`${label} must be an integer.`);
      }
      return value;

    case "real":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new ValidationError(`${label} must be a finite number.`);
      }
      return value;

    case "string":
      if (typeof value !== "string") {
        throw new ValidationError(`${label} must be a string.`);
      }
      return value;

    case "boolean":
      if (typeof value !== "boolean") {
        throw new ValidationError(`${label} must be a boolean.`);
      }
      return value;

    case "datetime":
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new ValidationError(`${label} must be a valid Date.`);
      }
      return new Date(value.getTime());

    case "blob":
      if (!(value instanceof Uint8Array)) {
        throw new ValidationError(`${label} must be a Uint8Array or Buffer.`);
      }
      return new Uint8Array(value);

    case "json":
      if (!isJsonValue(value)) {
        throw new ValidationError(`${label} must be a JSON-compatible value.`);
      }
      return cloneJson(value);
  }
}

export function cloneRuntimeValue(value: RuntimeValue): RuntimeValue {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }

  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }

  if (isJsonValue(value)) {
    return cloneJson(value);
  }

  return value;
}

export function cloneRow<T extends RuntimeRow>(row: T): T {
  const clone: RuntimeRow = {};
  for (const [key, value] of Object.entries(row)) {
    clone[key] = cloneRuntimeValue(value);
  }
  return clone as T;
}

export function serializeValue(type: FieldType, value: RuntimeValue): SerializedValue {
  if (value === null) {
    return null;
  }

  switch (type) {
    case "datetime":
      if (!(value instanceof Date)) {
        throw new ValidationError("Cannot serialize a non-Date datetime value.");
      }
      return value.toISOString();

    case "blob":
      if (!(value instanceof Uint8Array)) {
        throw new ValidationError("Cannot serialize a non-Uint8Array blob value.");
      }
      return {
        [blobMarker]: Buffer.from(value).toString("base64")
      };

    case "json":
      if (!isJsonValue(value)) {
        throw new ValidationError("Cannot serialize a non-JSON value.");
      }
      return cloneJson(value);

    case "int":
    case "real":
    case "string":
    case "boolean":
      if (!isJsonValue(value)) {
        throw new ValidationError(`Cannot serialize value for ${type}.`);
      }
      return value;
  }
}

export function deserializeValue(type: FieldType, value: unknown, label: string): RuntimeValue {
  if (value === null) {
    return null;
  }

  switch (type) {
    case "datetime":
      if (typeof value !== "string") {
        throw new ValidationError(`${label} must be an ISO datetime string in storage.`);
      }
      return new Date(value);

    case "blob": {
      if (!isPlainObject(value) || typeof value[blobMarker] !== "string") {
        throw new ValidationError(`${label} must be a blob marker object in storage.`);
      }
      return new Uint8Array(Buffer.from(value[blobMarker], "base64"));
    }

    case "json":
      if (!isJsonValue(value)) {
        throw new ValidationError(`${label} must be JSON-compatible in storage.`);
      }
      return cloneJson(value);

    case "int":
    case "real":
    case "string":
    case "boolean":
      return value as RuntimeValue;
  }
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.byteLength !== right.byteLength) {
      return false;
    }
    return left.every((byte, index) => byte === right[index]);
  }

  if (isJsonLike(left) || isJsonLike(right)) {
    return stableStringify(left) === stableStringify(right);
  }

  return Object.is(left, right);
}

export function compareValues(left: unknown, right: unknown): number {
  if (valuesEqual(left, right)) {
    return 0;
  }

  if (left === null || left === undefined) {
    return -1;
  }

  if (right === null || right === undefined) {
    return 1;
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() < right.getTime() ? -1 : 1;
  }

  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    const length = Math.min(left.byteLength, right.byteLength);
    for (let index = 0; index < length; index += 1) {
      const a = left[index] ?? 0;
      const b = right[index] ?? 0;
      if (a !== b) {
        return a < b ? -1 : 1;
      }
    }
    return left.byteLength < right.byteLength ? -1 : 1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return left < right ? -1 : 1;
  }

  if (typeof left === "string" && typeof right === "string") {
    return left < right ? -1 : 1;
  }

  if (typeof left === "boolean" && typeof right === "boolean") {
    return left === false ? -1 : 1;
  }

  const leftKey = stableStringify(left);
  const rightKey = stableStringify(right);
  return leftKey < rightKey ? -1 : 1;
}

export function assertComparable(operator: string, left: unknown, right: unknown): void {
  if ([">", ">=", "<", "<="].includes(operator)) {
    const comparable =
      (typeof left === "number" && typeof right === "number") ||
      (typeof left === "string" && typeof right === "string") ||
      (left instanceof Date && right instanceof Date);

    if (!comparable) {
      throw new QueryError(`Operator "${operator}" requires comparable values of the same type.`);
    }
  }
}

export function toIndexKey(value: unknown): string {
  if (value instanceof Date) {
    return `datetime:${value.toISOString()}`;
  }

  if (value instanceof Uint8Array) {
    return `blob:${Buffer.from(value).toString("base64")}`;
  }

  return `${typeof value}:${stableStringify(value)}`;
}

export function stableStringify(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify({ $date: value.toISOString() });
  }

  if (value instanceof Uint8Array) {
    return JSON.stringify({ $blob: Buffer.from(value).toString("base64") });
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  return JSON.stringify(value);
}

function isJsonLike(value: unknown): boolean {
  return value === null || Array.isArray(value) || isPlainObject(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) {
    return true;
  }

  const type = typeof value;
  if (type === "string" || type === "boolean") {
    return true;
  }

  if (type === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }

  return false;
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
