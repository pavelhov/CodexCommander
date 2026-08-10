import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { ADMIN_KEY_PATTERN, readEnv } from "../identity";

export const ADMIN_TOKEN_FILE = "admin-api-token";

export function adminApiTokenFilePath(configDir = getConfigDir()): string {
  return join(configDir, ADMIN_TOKEN_FILE);
}

export function loadAdminTokenFromFile(configDir = getConfigDir()): string | null {
  const path = adminApiTokenFilePath(configDir);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512) return null;
    const token = readFileSync(path, "utf8").trim();
    return ADMIN_KEY_PATTERN.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function configuredAdminToken(configDir = getConfigDir(), env: NodeJS.ProcessEnv = process.env): string | null {
  return readEnv("CODEXCOMMANDER_ADMIN_AUTH_TOKEN", env) || loadAdminTokenFromFile(configDir);
}
