import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { field } from "../src/index.js";

export async function createTempDb(): Promise<{
  filePath: string;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "simple-local-db-"));
  return {
    filePath: path.join(directory, "app.db"),
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}

export function userSchema() {
  return {
    id: field.int().primary().autoIncrement(),
    name: field.string().required(),
    email: field.string().unique().index(),
    age: field.int().default(0),
    rating: field.real().default(0),
    avatar: field.blob().nullable(),
    active: field.boolean().default(true),
    metadata: field.json().nullable(),
    createdAt: field.datetime().default(() => new Date("2024-01-01T00:00:00.000Z"))
  };
}
