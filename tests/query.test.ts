import { describe, expect, it } from "vitest";
import { Database } from "../src/index.js";
import { createTempDb, userSchema } from "./helpers.js";

describe("Query", () => {
  it("supports where, AND conditions, orderBy, limit and offset", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await users.insert({ name: "Ana", email: "ana@example.com", age: 25 });
      await users.insert({ name: "Bruno", email: "bruno@example.com", age: 17 });
      await users.insert({ name: "Carla", email: "carla@example.com", age: 35 });
      await users.insert({ name: "Daniel", email: "daniel@example.com", age: 45, active: false });

      const adults = await users
        .where("age", ">=", 18)
        .where("active", "=", true)
        .orderBy("age", "desc")
        .limit(1)
        .offset(0)
        .find();

      expect(adults.map((row) => row.name)).toEqual(["Carla"]);

      const secondAdult = await users
        .where("age", ">=", 18)
        .where("active", "=", true)
        .orderBy("age", "desc")
        .limit(1)
        .offset(1)
        .find();

      expect(secondAdult.map((row) => row.name)).toEqual(["Ana"]);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("supports equality find, in, contains and inequality operators", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await users.insert({
        name: "Ana Maria",
        email: "ana@example.com",
        age: 25,
        metadata: { tags: ["admin", "editor"] }
      });
      await users.insert({
        name: "Bia",
        email: "bia@example.com",
        age: 30,
        metadata: { tags: ["viewer"] }
      });

      await expect(users.find({ email: "ana@example.com" })).resolves.toMatchObject([
        { name: "Ana Maria" }
      ]);

      await expect(users.where("email", "in", [
        "ana@example.com",
        "missing@example.com"
      ]).find()).resolves.toHaveLength(1);

      await expect(users.where("name", "contains", "Maria").find()).resolves.toMatchObject([
        { email: "ana@example.com" }
      ]);

      await expect(users.where("age", "!=", 25).find()).resolves.toMatchObject([
        { email: "bia@example.com" }
      ]);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("supports update after where conditions", async () => {
    const temp = await createTempDb();

    try {
      const db = await Database.open(temp.filePath);
      const users = db.table("users", userSchema());

      await users.insert({ name: "Ana", email: "ana@example.com", age: 25 });
      await users.insert({ name: "Bruno", email: "bruno@example.com", age: 17 });
      await users.insert({ name: "Carla", email: "carla@example.com", age: 31 });

      await expect(users
        .where("age", "=", 25)
        .update(
          { email: "ana@example.com" },
          { name: "Ana Maria", age: 26 }
        )).resolves.toBe(1);

      await expect(users.find({ email: "ana@example.com" })).resolves.toMatchObject([
        { name: "Ana Maria", age: 26 }
      ]);

      await expect(users
        .where("age", "<", 18)
        .update(
          { email: "ana@example.com" },
          { name: "Ana Bloqueada" }
        )).resolves.toBe(0);

      await expect(users
        .where("age", ">=", 30)
        .update({ active: false })).resolves.toBe(1);

      await expect(users.find({ email: "carla@example.com" })).resolves.toMatchObject([
        { active: false }
      ]);

      await db.close();
    } finally {
      await temp.cleanup();
    }
  });
});
