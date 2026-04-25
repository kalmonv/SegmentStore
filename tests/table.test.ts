import { describe, expect, it } from "vitest";
import {
  Database,
  PrimaryKeyError,
  SchemaError,
  ValidationError,
  field
} from "../src/index.js";
import { createTempDb, userSchema } from "./helpers.js";

describe("Table", () => {
  it("inserts, updates and deletes records", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await users.insert({ name: "Bob", email: "bob@example.com", age: 17 });
      const updated = await users.update(
        { email: "bob@example.com" },
        { name: "Bobby", age: 18, rating: 4.5 }
      );

      expect(updated).toBe(1);
      await expect(users.where("age", ">=", 18).find()).resolves.toMatchObject([
        { name: "Bobby", age: 18, rating: 4.5 }
      ]);

      expect(await users.delete({ email: "bob@example.com" })).toBe(1);
      expect(await users.find()).toEqual([]);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("applies defaults and nullable fields", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      const row = await users.insert({
        name: "Nina",
        email: "nina@example.com"
      });

      expect(row.id).toBe(1);
      expect(row.age).toBe(0);
      expect(row.rating).toBe(0);
      expect(row.active).toBe(true);
      expect(row.avatar).toBeNull();
      expect(row.metadata).toBeNull();

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("validates required, nullable and typed values", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await expect(users.insert({
        email: "missing-name@example.com"
      } as never)).rejects.toBeInstanceOf(ValidationError);

      await expect(users.insert({
        name: "Bad Age",
        email: "bad-age@example.com",
        age: 2.5
      })).rejects.toBeInstanceOf(ValidationError);

      await expect(users.insert({
        name: "Bad Metadata",
        email: "bad-metadata@example.com",
        metadata: undefined
      } as never)).rejects.toBeInstanceOf(ValidationError);

      const firstValid = await users.insert({
        name: "Valid",
        email: "valid@example.com"
      });
      expect(firstValid.id).toBe(1);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("rejects primary key updates and invalid schemas", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());
      await users.insert({ name: "Ana", email: "ana@example.com" });

      await expect(users.update({ email: "ana@example.com" }, {
        id: 99
      } as never)).rejects.toBeInstanceOf(PrimaryKeyError);

      expect(() => db.table("bad", {
        id: field.int().autoIncrement()
      })).toThrow(SchemaError);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });
});
