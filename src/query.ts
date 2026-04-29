import { QueryError } from "./errors.js";
import type { Table } from "./table.js";
import type {
  ComparisonOperator,
  FieldRuntimeValue,
  OrderDirection,
  QueryCondition,
  QueryOrder,
  RowOf,
  SchemaDefinition,
  UpdateInput,
  WhereInput
} from "./types.js";

export class Query<S extends SchemaDefinition> {
  private readonly table: Table<S>;
  private readonly conditions: QueryCondition<S>[];
  private readonly order: QueryOrder<S> | undefined;
  private readonly take: number | undefined;
  private readonly skip: number;

  constructor(
    table: Table<S>,
    options: {
      conditions?: QueryCondition<S>[];
      order?: QueryOrder<S> | undefined;
      take?: number | undefined;
      skip?: number | undefined;
    } = {}
  ) {
    this.table = table;
    this.conditions = options.conditions ?? [];
    this.order = options.order;
    this.take = options.take;
    this.skip = options.skip ?? 0;
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
    const condition = this.table.createCondition(field, operatorOrValue, maybeValue);
    return new Query(this.table, {
      conditions: [...this.conditions, condition],
      order: this.order,
      take: this.take,
      skip: this.skip
    });
  }

  orderBy<K extends keyof S & string>(field: K, direction: OrderDirection = "asc"): Query<S> {
    if (direction !== "asc" && direction !== "desc") {
      throw new QueryError(`Invalid order direction "${direction}".`);
    }

    this.table.assertKnownField(field);
    return new Query(this.table, {
      conditions: this.conditions,
      order: { field, direction },
      take: this.take,
      skip: this.skip
    });
  }

  limit(count: number): Query<S> {
    if (!Number.isInteger(count) || count < 0) {
      throw new QueryError("limit() expects a non-negative integer.");
    }

    return new Query(this.table, {
      conditions: this.conditions,
      order: this.order,
      take: count,
      skip: this.skip
    });
  }

  offset(count: number): Query<S> {
    if (!Number.isInteger(count) || count < 0) {
      throw new QueryError("offset() expects a non-negative integer.");
    }

    return new Query(this.table, {
      conditions: this.conditions,
      order: this.order,
      take: this.take,
      skip: count
    });
  }

  async find(): Promise<Array<RowOf<S>>> {
    return this.table.runQuery({
      conditions: this.conditions,
      order: this.order,
      take: this.take,
      skip: this.skip
    });
  }

  update(changes: UpdateInput<S>): Promise<number>;
  update(filter: WhereInput<S>, changes: UpdateInput<S>): Promise<number>;
  async update(
    filterOrChanges: WhereInput<S> | UpdateInput<S>,
    maybeChanges?: UpdateInput<S>
  ): Promise<number> {
    const hasFilter = maybeChanges !== undefined;
    const extraConditions = hasFilter
      ? this.table.createConditionsFromFilter(filterOrChanges as WhereInput<S>, "update filter")
      : [];
    const changes = hasFilter ? maybeChanges : filterOrChanges as UpdateInput<S>;

    return this.table.runUpdate({
      conditions: [...this.conditions, ...extraConditions],
      order: this.order,
      take: this.take,
      skip: this.skip
    }, changes);
  }
}
