// Load this project's .env before modules read process.env. No external package needed.
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".env");
try {
  loadEnvFile(envPath);
} catch (error) {
  // Let the app use its built-in defaults when .env has not been created yet.
  if (error.code !== "ENOENT") throw error;
}
