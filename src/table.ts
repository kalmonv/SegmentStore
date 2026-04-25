import { IndexManager } from "./index/index-manager.js";
import { Query } from "./query.js";
import { resolveSchema, type ResolvedSchema } from "./schema.js";
import type { Database } from "./database.js";
import {
  PrimaryKeyError,
  QueryError,
  SchemaError,
  UniqueConstraintError,
  ValidationError
} from "./errors.js";
import type { TableMutation, TableSnapshot } from "./storage/storage-engine.js";
import type {
  ComparisonOperator,
  FieldRuntimeValue,
  InsertInput,
  OrderDirection,
  QueryCondition,
  QueryOrder,
  RowOf,
  SchemaDefinition,
  UpdateInput,
  WhereInput
} from "./types.js";
import {
  assertComparable,
  cloneRow,
  compareValues,
  deserializeValue,
  normalizeValue,
  serializeValue,
  toIndexKey,
  valuesEqual,
  type RuntimeRow,
  type RuntimeValue
} from "./value.js";

export interface QueryExecution<S extends SchemaDefinition> {
  conditions: QueryCondition<S>[];
  order?: QueryOrder<S> | undefined;
  take?: number | undefined;
  skip: number;
}

export class Table<S extends SchemaDefinition> {
  private readonly database: Database;
  private readonly schema: ResolvedSchema<S>;
  private rows: Array<RowOf<S>>;
  private autoIncrement: Record<string, number>;
  private readonly indexes: IndexManager<S>;
  private loaded = false;

  constructor(database: Database, tableName: string, schemaDefinition: S, snapshot?: TableSnapshot) {
    this.database = database;
    this.schema = resolveSchema(tableName, schemaDefinition);
    this.rows = [];
    this.autoIncrement = {};
    if (snapshot) {
      this.applySnapshot(snapshot);
    }
    this.indexes = new IndexManager(this.schema, this.rows as RuntimeRow[]);
  }

  get name(): string {
    return this.schema.tableName;
  }

  get signature(): string {
    return this.schema.signature;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const snapshot = await this.database.loadTableSnapshot(this.name);
    this.applySnapshot(snapshot);
    this.indexes.rebuild(this.rows as RuntimeRow[]);
  }

  async insert(input: InsertInput<S>): Promise<RowOf<S>> {
    this.database.assertOpen();
    await this.ensureLoaded();
    this.assertNoUnknownKeys(input, "insert");

    const previousAutoIncrement = { ...this.autoIncrement };
    const built = this.buildInsertRow(input);
    const row = built.row;
    this.assertUniqueConstraints([{ row }]);

    this.autoIncrement = built.autoIncrement;
    this.rows.push(row);
    this.indexes.addRow(this.rows.length - 1, row as RuntimeRow);

    try {
      await this.persist({
        type: "insert",
        row: this.serializeRow(row),
        autoIncrement: { ...this.autoIncrement }
      });
    } catch (error) {
      this.autoIncrement = previousAutoIncrement;
      this.rows.pop();
      this.indexes.rebuild(this.rows as RuntimeRow[]);
      throw error;
    }

    return cloneRow(row as RuntimeRow) as RowOf<S>;
  }

  async find(filter?: WhereInput<S>): Promise<Array<RowOf<S>>> {
    await this.ensureLoaded();
    const conditions = filter ? this.conditionsFromFilter(filter) : [];
    return this.runQuery({ conditions, skip: 0 });
  }

  where<K extends keyof S & string>(field: K, value: FieldRuntimeValue<S[K]>): Query<S>;
  where<K extends keyof S & string>(
    field: K,
    operator: Exclude<ComparisonOperator, "in">,
    value: FieldRuntimeValue<S[K]>
  ): Query<S>;
  where<K extends keyof S & string>(
    field: K,
    operator: "in",
    value: Array<FieldRuntimeValue<S[K]>>
  ): Query<S>;
  where<K extends keyof S & string>(
    field: K,
    operatorOrValue: ComparisonOperator | FieldRuntimeValue<S[K]>,
    maybeValue?: FieldRuntimeValue<S[K]> | Array<FieldRuntimeValue<S[K]>>
  ): Query<S> {
    return new Query(this).where(field, operatorOrValue as never, maybeValue as never);
  }

  orderBy<K extends keyof S & string>(field: K, direction: OrderDirection = "asc"): Query<S> {
    return new Query(this).orderBy(field, direction);
  }

  limit(count: number): Query<S> {
    return new Query(this).limit(count);
  }

  offset(count: number): Query<S> {
    return new Query(this).offset(count);
  }

  async update(filter: WhereInput<S>, changes: UpdateInput<S>): Promise<number> {
    this.database.assertOpen();
    await this.ensureLoaded();
    this.assertNoUnknownKeys(filter, "update filter");
    this.assertNoUnknownKeys(changes, "update changes");

    const patch = this.normalizePatch(changes);
    if (Object.keys(patch).length === 0) {
      return 0;
    }

    const indices = this.findMatchingIndices(this.conditionsFromFilter(filter));
    if (indices.length === 0) {
      return 0;
    }

    const before = this.rows.map((row) => cloneRow(row as RuntimeRow) as RowOf<S>);
    const indexSet = new Set(indices);
    const candidates = indices.map((index) => {
      const current = this.rows[index];
      if (!current) {
        throw new QueryError(`Internal row index ${index} is out of bounds.`);
      }

      return {
        index,
        row: {
          ...(current as RuntimeRow),
          ...patch
        } as RowOf<S>
      };
    });

    this.assertUniqueConstraints(candidates, indexSet);

    for (const { index, row } of candidates) {
      this.rows[index] = row;
    }
    this.indexes.rebuild(this.rows as RuntimeRow[]);

    try {
      await this.persist({
        type: "update",
        rows: candidates.map((candidate) => ({
          index: candidate.index,
          row: this.serializeRow(candidate.row)
        })),
        autoIncrement: { ...this.autoIncrement }
      });
    } catch (error) {
      this.rows = before;
      this.indexes.rebuild(this.rows as RuntimeRow[]);
      throw error;
    }

    return candidates.length;
  }

  async delete(filter: WhereInput<S>): Promise<number> {
    this.database.assertOpen();
    await this.ensureLoaded();
    this.assertNoUnknownKeys(filter, "delete filter");

    const indices = this.findMatchingIndices(this.conditionsFromFilter(filter));
    if (indices.length === 0) {
      return 0;
    }

    const before = this.rows.map((row) => cloneRow(row as RuntimeRow) as RowOf<S>);
    const remove = new Set(indices);
    this.rows = this.rows.filter((_, index) => !remove.has(index));
    this.indexes.rebuild(this.rows as RuntimeRow[]);

    try {
      await this.persist({
        type: "delete",
        indices,
        autoIncrement: { ...this.autoIncrement }
      });
    } catch (error) {
      this.rows = before;
      this.indexes.rebuild(this.rows as RuntimeRow[]);
      throw error;
    }

    return indices.length;
  }

  async runQuery(execution: QueryExecution<S>): Promise<Array<RowOf<S>>> {
    this.database.assertOpen();
    await this.ensureLoaded();
    let indices = this.findMatchingIndices(execution.conditions);

    if (execution.order) {
      const order = execution.order;
      indices = [...indices].sort((leftIndex, rightIndex) => {
        const left = this.rows[leftIndex];
        const right = this.rows[rightIndex];
        if (!left || !right) {
          return 0;
        }

        const result = compareValues(left[order.field], right[order.field]);
        return order.direction === "asc" ? result : -result;
      });
    }

    const start = execution.skip;
    const end = execution.take === undefined ? undefined : start + execution.take;
    return indices
      .slice(start, end)
      .map((index) => {
        const row = this.rows[index];
        if (!row) {
          throw new QueryError(`Internal row index ${index} is out of bounds.`);
        }
        return cloneRow(row as RuntimeRow) as RowOf<S>;
      });
  }

  createCondition<K extends keyof S & string>(
    field: K,
    operatorOrValue: ComparisonOperator | FieldRuntimeValue<S[K]>,
    maybeValue?: FieldRuntimeValue<S[K]> | Array<FieldRuntimeValue<S[K]>>
  ): QueryCondition<S> {
    this.assertKnownField(field);

    const hasExplicitOperator = typeof operatorOrValue === "string" && isComparisonOperator(operatorOrValue);
    const operator = hasExplicitOperator ? operatorOrValue : "=";
    const rawValue = hasExplicitOperator ? maybeValue : operatorOrValue;
    const resolvedField = this.schema.fields[field];
    if (!resolvedField) {
      throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
    }

    if (operator === "in") {
      if (!Array.isArray(rawValue)) {
        throw new QueryError(`Operator "in" for "${this.name}.${field}" expects an array.`);
      }

      return {
        field,
        operator,
        value: rawValue.map((value) => normalizeValue(resolvedField.meta, value, `${this.name}.${field}`))
      };
    }

    if (rawValue === undefined) {
      throw new QueryError(`Missing value for condition "${this.name}.${field}".`);
    }

    if (operator === "contains") {
      return {
        field,
        operator,
        value: rawValue
      };
    }

    return {
      field,
      operator,
      value: normalizeValue(resolvedField.meta, rawValue, `${this.name}.${field}`)
    };
  }

  assertKnownField(field: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.schema.fields, field)) {
      throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
    }
  }

  createSnapshot(): TableSnapshot {
    if (!this.loaded) {
      throw new SchemaError(`Table "${this.name}" has not been loaded yet.`);
    }

    return {
      rows: this.rows.map((row) => this.serializeRow(row)),
      autoIncrement: { ...this.autoIncrement }
    };
  }

  private serializeRow(row: RowOf<S>): TableSnapshot["rows"][number] {
    const serialized: Record<string, unknown> = {};
    for (const field of this.schema.fieldNames) {
      const resolvedField = this.schema.fields[field];
      if (!resolvedField) {
        throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
      }
      serialized[field] = serializeValue(resolvedField.meta.type, row[field] as RuntimeValue);
    }
    return serialized as TableSnapshot["rows"][number];
  }

  private applySnapshot(snapshot: TableSnapshot): void {
    this.rows = this.hydrateRows(snapshot);
    this.autoIncrement = { ...snapshot.autoIncrement };
    this.reconcileAutoIncrementCounters();
    this.loaded = true;
  }

  private hydrateRows(snapshot: TableSnapshot): Array<RowOf<S>> {
    return snapshot.rows.map((storedRow, rowIndex) => {
      const row: RuntimeRow = {};

      for (const field of this.schema.fieldNames) {
        const resolvedField = this.schema.fields[field];
        if (!resolvedField) {
          throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
        }

        if (!Object.prototype.hasOwnProperty.call(storedRow, field)) {
          throw new ValidationError(`Stored row ${rowIndex} in "${this.name}" is missing field "${field}".`);
        }

        const deserialized = deserializeValue(
          resolvedField.meta.type,
          storedRow[field],
          `${this.name}.${field}`
        );
        row[field] = normalizeValue(resolvedField.meta, deserialized, `${this.name}.${field}`);
      }

      return row as RowOf<S>;
    });
  }

  private buildInsertRow(input: InsertInput<S>): { row: RowOf<S>; autoIncrement: Record<string, number> } {
    const row: RuntimeRow = {};
    const autoIncrement = { ...this.autoIncrement };

    for (const field of this.schema.fieldNames) {
      const resolvedField = this.schema.fields[field];
      if (!resolvedField) {
        throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
      }

      const meta = resolvedField.meta;
      const hasInputValue = Object.prototype.hasOwnProperty.call(input, field);
      const inputValue = (input as Record<string, unknown>)[field];

      if (hasInputValue) {
        if (inputValue === undefined) {
          throw new ValidationError(`${this.name}.${field} cannot be undefined.`);
        }

        const value = normalizeValue(meta, inputValue, `${this.name}.${field}`);
        row[field] = value;

        if (meta.autoIncrement && typeof value === "number" && value >= (autoIncrement[field] ?? 1)) {
          autoIncrement[field] = value + 1;
        }
        continue;
      }

      if (meta.autoIncrement) {
        const next = autoIncrement[field] ?? 1;
        row[field] = next;
        autoIncrement[field] = next + 1;
        continue;
      }

      if (meta.hasDefault) {
        row[field] = this.resolveDefault(field, meta);
        continue;
      }

      if (meta.nullable) {
        row[field] = null;
        continue;
      }

      throw new ValidationError(`${this.name}.${field} is required.`);
    }

    return {
      row: row as RowOf<S>,
      autoIncrement
    };
  }

  private normalizePatch(changes: UpdateInput<S>): Partial<RowOf<S>> {
    const patch: Partial<RowOf<S>> = {};

    for (const [field, value] of Object.entries(changes)) {
      if (value === undefined) {
        continue;
      }

      const resolvedField = this.schema.fields[field as keyof S & string];
      if (!resolvedField) {
        throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
      }

      if (resolvedField.meta.primary) {
        throw new PrimaryKeyError(`Cannot update primary key "${this.name}.${field}".`);
      }

      (patch as Record<string, RuntimeValue>)[field] = normalizeValue(
        resolvedField.meta,
        value,
        `${this.name}.${field}`
      );
    }

    return patch;
  }

  private conditionsFromFilter(filter: WhereInput<S>): QueryCondition<S>[] {
    return Object.entries(filter).flatMap(([field, value]) => {
      if (value === undefined) {
        return [];
      }
      return [this.createCondition(field as keyof S & string, "=", value as FieldRuntimeValue<S[keyof S]>)];
    });
  }

  private findMatchingIndices(conditions: QueryCondition<S>[]): number[] {
    const indexedCandidates = conditions
      .map((condition) => this.indexCandidates(condition))
      .filter((candidate): candidate is number[] => Boolean(candidate))
      .sort((left, right) => left.length - right.length);

    const baseIndices = indexedCandidates[0] ?? this.rows.map((_, index) => index);

    return baseIndices.filter((index) => {
      const row = this.rows[index];
      if (!row) {
        return false;
      }

      return conditions.every((condition) => this.matchesCondition(row as RuntimeRow, condition));
    });
  }

  private indexCandidates(condition: QueryCondition<S>): number[] | undefined {
    if (!this.indexes.isIndexed(condition.field)) {
      return undefined;
    }

    if (condition.operator === "=") {
      return this.indexes.lookup(condition.field, condition.value as RuntimeValue);
    }

    if (condition.operator === "in" && Array.isArray(condition.value)) {
      return [...new Set(condition.value.flatMap((value) => (
        this.indexes.lookup(condition.field, value as RuntimeValue) ?? []
      )))];
    }

    return undefined;
  }

  private matchesCondition(row: RuntimeRow, condition: QueryCondition<S>): boolean {
    const left = row[condition.field];
    const right = condition.value;

    switch (condition.operator) {
      case "=":
        return valuesEqual(left, right);
      case "!=":
        return !valuesEqual(left, right);
      case ">":
        assertComparable(condition.operator, left, right);
        return compareValues(left, right) > 0;
      case ">=":
        assertComparable(condition.operator, left, right);
        return compareValues(left, right) >= 0;
      case "<":
        assertComparable(condition.operator, left, right);
        return compareValues(left, right) < 0;
      case "<=":
        assertComparable(condition.operator, left, right);
        return compareValues(left, right) <= 0;
      case "in":
        if (!Array.isArray(right)) {
          throw new QueryError(`Operator "in" requires an array.`);
        }
        return right.some((value) => valuesEqual(left, value));
      case "contains":
        return containsValue(left, right);
    }
  }

  private assertUniqueConstraints(
    candidates: Array<{ index?: number; row: RowOf<S> }>,
    excludedRows: ReadonlySet<number> = new Set()
  ): void {
    const uniqueFields = new Set(this.schema.uniqueFields);

    for (const field of uniqueFields) {
      const seen = new Map<string, number>();
      const resolvedField = this.schema.fields[field];
      if (!resolvedField) {
        throw new SchemaError(`Unknown field "${field}" in table "${this.name}".`);
      }

      for (const candidate of candidates) {
        const value = candidate.row[field] as RuntimeValue;
        if (value === null && !resolvedField.meta.primary) {
          continue;
        }

        const key = toIndexKey(value);
        if (seen.has(key)) {
          this.throwUniqueError(field);
        }
        seen.set(key, candidate.index ?? -1);

        if (this.indexes.has(field, value, excludedRows)) {
          this.throwUniqueError(field);
        }
      }
    }
  }

  private throwUniqueError(field: keyof S & string): never {
    if (this.schema.primaryKey === field) {
      throw new PrimaryKeyError(`Duplicate primary key value for "${this.name}.${field}".`);
    }

    throw new UniqueConstraintError(`Duplicate value for unique field "${this.name}.${field}".`);
  }

  private resolveDefault(field: keyof S & string, meta: ResolvedSchema<S>["fields"][keyof S & string]["meta"]): RuntimeValue {
    const defaultProvider = meta.defaultValue;
    const value = typeof defaultProvider === "function"
      ? (defaultProvider as () => unknown)()
      : defaultProvider;

    return normalizeValue(meta, value, `${this.name}.${field}`);
  }

  private reconcileAutoIncrementCounters(): void {
    for (const field of this.schema.autoIncrementFields) {
      const maxValue = this.rows.reduce((max, row) => {
        const value = row[field];
        return typeof value === "number" && value > max ? value : max;
      }, 0);

      const storedNext = this.autoIncrement[field] ?? 1;
      this.autoIncrement[field] = Math.max(storedNext, maxValue + 1);
    }
  }

  private assertNoUnknownKeys(value: object, context: string): void {
    for (const key of Object.keys(value)) {
      this.assertKnownFieldForContext(key, context);
    }
  }

  private assertKnownFieldForContext(field: string, context: string): void {
    if (!Object.prototype.hasOwnProperty.call(this.schema.fields, field)) {
      throw new SchemaError(`Unknown field "${field}" in ${context} for table "${this.name}".`);
    }
  }

  private async persist(mutation: TableMutation): Promise<void> {
    await this.database.persistTableMutation(this.name, mutation, () => this.createSnapshot());
  }
}

function isComparisonOperator(value: string): value is ComparisonOperator {
  return ["=", "!=", ">", ">=", "<", "<=", "in", "contains"].includes(value);
}

function containsValue(left: unknown, right: unknown): boolean {
  if (typeof left === "string") {
    return typeof right === "string" && left.includes(right);
  }

  if (Array.isArray(left)) {
    return left.some((item) => valuesEqual(item, right));
  }

  if (left instanceof Uint8Array) {
    return typeof right === "number" && left.includes(right);
  }

  if (left && typeof left === "object") {
    return typeof right === "string" && Object.prototype.hasOwnProperty.call(left, right);
  }

  return false;
}
