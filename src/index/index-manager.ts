import type { ResolvedSchema } from "../schema.js";
import type { SchemaDefinition } from "../types.js";
import type { RuntimeRow, RuntimeValue } from "../value.js";
import { toIndexKey } from "../value.js";

type IndexMap = Map<string, Set<number>>;

export class IndexManager<S extends SchemaDefinition = SchemaDefinition> {
  private readonly schema: ResolvedSchema<S>;
  private readonly indexes = new Map<string, IndexMap>();

  constructor(schema: ResolvedSchema<S>, rows: ReadonlyArray<RuntimeRow>) {
    this.schema = schema;
    this.rebuild(rows);
  }

  rebuild(rows: ReadonlyArray<RuntimeRow>): void {
    this.indexes.clear();
    for (const field of this.schema.indexedFields) {
      this.indexes.set(field, new Map());
    }

    rows.forEach((row, index) => {
      this.addRow(index, row);
    });
  }

  addRow(rowIndex: number, row: RuntimeRow): void {
    for (const field of this.schema.indexedFields) {
      const index = this.indexes.get(field);
      if (!index) {
        continue;
      }

      const key = toIndexKey(row[field]);
      const bucket = index.get(key);
      if (bucket) {
        bucket.add(rowIndex);
      } else {
        index.set(key, new Set([rowIndex]));
      }
    }
  }

  removeRow(rowIndex: number, row: RuntimeRow): void {
    for (const field of this.schema.indexedFields) {
      const index = this.indexes.get(field);
      if (!index) {
        continue;
      }

      const key = toIndexKey(row[field]);
      const bucket = index.get(key);
      if (!bucket) {
        continue;
      }

      bucket.delete(rowIndex);
      if (bucket.size === 0) {
        index.delete(key);
      }
    }
  }

  lookup(field: string, value: RuntimeValue): number[] | undefined {
    const index = this.indexes.get(field);
    if (!index) {
      return undefined;
    }

    return [...(index.get(toIndexKey(value)) ?? [])];
  }

  has(field: string, value: RuntimeValue, excludedRows: ReadonlySet<number> = new Set()): boolean {
    const matches = this.lookup(field, value);
    if (!matches) {
      return false;
    }

    return matches.some((rowIndex) => !excludedRows.has(rowIndex));
  }

  isIndexed(field: string): boolean {
    return this.indexes.has(field);
  }
}
