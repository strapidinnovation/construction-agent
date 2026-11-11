import { defineConfig } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default defineConfig(
  { ignores: ["dist", "node_modules", ".venv", "output"] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  prettier,
);
