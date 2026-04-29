import { describe, expect, it } from "vitest";
import {
  Database,
  PrimaryKeyError,
  UniqueConstraintError
} from "../src/index.js";
import { createTempDb, userSchema } from "./helpers.js";

describe("Indexes and constraints", () => {
  it("enforces unique fields and primary keys", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await users.insert({ id: 10, name: "Ana", email: "ana@example.com" });

      await expect(users.insert({
        name: "Outra Ana",
        email: "ana@example.com"
      })).rejects.toBeInstanceOf(UniqueConstraintError);

      await expect(users.insert({
        id: 10,
        name: "Duplicated Id",
        email: "dup-id@example.com"
      })).rejects.toBeInstanceOf(PrimaryKeyError);

      const next = await users.insert({
        name: "Next",
        email: "next@example.com"
      });
      expect(next.id).toBe(11);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("updates indexes on update/delete and rebuilds them after reopening", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await users.insert({ name: "Ana", email: "ana@example.com" });
      await users.update({ email: "ana@example.com" }, { email: "ana.new@example.com" });

      await expect(users.find({ email: "ana@example.com" })).resolves.toEqual([]);
      await expect(users.find({ email: "ana.new@example.com" })).resolves.toHaveLength(1);

      await db.close();

      const reopened = await Database.open(temp.filePath);
      const reopenedUsers = reopened.table("users", userSchema());

      await expect(reopenedUsers.insert({
        name: "Duplicate",
        email: "ana.new@example.com"
      })).rejects.toBeInstanceOf(UniqueConstraintError);

      expect(await reopenedUsers.delete({ email: "ana.new@example.com" })).toBe(1);

      await expect(reopenedUsers.insert({
        name: "Available Again",
        email: "ana.new@example.com"
      })).resolves.toMatchObject({
        email: "ana.new@example.com"
      });

      await reopened.close();
    } finally {
      await temp.cleanup();
    }
  });
});
