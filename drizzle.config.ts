import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.SQLITE_FILE_PATH ?? "./data/task-list.sqlite",
  },
  strict: true,
});
