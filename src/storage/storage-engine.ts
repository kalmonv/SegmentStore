import type { SerializedRow } from "../value.js";

export interface TableSnapshot {
  rows: SerializedRow[];
  autoIncrement: Record<string, number>;
}

export interface DatabaseSnapshot {
  version: 1;
  tables: Record<string, TableSnapshot>;
}

export interface InsertTableMutation {
  type: "insert";
  row: SerializedRow;
  autoIncrement: Record<string, number>;
}

export interface UpdateTableMutation {
  type: "update";
  rows: Array<{
    index: number;
    row: SerializedRow;
  }>;
  autoIncrement: Record<string, number>;
}

export interface DeleteTableMutation {
  type: "delete";
  indices: number[];
  autoIncrement: Record<string, number>;
}

export interface SetTableMutation {
  type: "setTable";
  snapshot: TableSnapshot;
}

export type TableMutation =
  | InsertTableMutation
  | UpdateTableMutation
  | DeleteTableMutation
  | SetTableMutation;

export interface StorageEngine {
  load(): Promise<DatabaseSnapshot>;
  save(snapshot: DatabaseSnapshot): Promise<void>;
  loadTable?(tableName: string): Promise<TableSnapshot | undefined>;
  saveTable?(tableName: string, snapshot: TableSnapshot): Promise<void>;
  appendTableMutation?(tableName: string, mutation: TableMutation): Promise<void>;
  close?(): Promise<void>;
}

export function createEmptySnapshot(): DatabaseSnapshot {
  return {
    version: 1,
    tables: {}
  };
}

export function cloneTableSnapshot(snapshot: TableSnapshot): TableSnapshot {
  return {
    rows: snapshot.rows.map((row) => ({ ...row })),
    autoIncrement: { ...snapshot.autoIncrement }
  };
}

export function cloneDatabaseSnapshot(snapshot: DatabaseSnapshot): DatabaseSnapshot {
  return {
    version: 1,
    tables: Object.fromEntries(
      Object.entries(snapshot.tables).map(([name, table]) => [name, cloneTableSnapshot(table)])
    )
  };
}

export function applyTableMutationToSnapshot(
  snapshot: DatabaseSnapshot,
  tableName: string,
  mutation: TableMutation
): DatabaseSnapshot {
  const next = cloneDatabaseSnapshot(snapshot);
  const table = next.tables[tableName] ?? {
    rows: [],
    autoIncrement: {}
  };

  switch (mutation.type) {
    case "insert":
      table.rows.push({ ...mutation.row });
      table.autoIncrement = { ...mutation.autoIncrement };
      break;

    case "update":
      for (const update of mutation.rows) {
        if (update.index < 0 || update.index >= table.rows.length) {
          throw new Error(`Cannot apply update mutation for row index ${update.index} in table "${tableName}".`);
        }
        table.rows[update.index] = { ...update.row };
      }
      table.autoIncrement = { ...mutation.autoIncrement };
      break;

    case "delete":
      for (const index of [...mutation.indices].sort((left, right) => right - left)) {
        if (index < 0 || index >= table.rows.length) {
          throw new Error(`Cannot apply delete mutation for row index ${index} in table "${tableName}".`);
        }
        table.rows.splice(index, 1);
      }
      table.autoIncrement = { ...mutation.autoIncrement };
      break;

    case "setTable":
      next.tables[tableName] = cloneTableSnapshot(mutation.snapshot);
      return next;
  }

  next.tables[tableName] = table;
  return next;
}
