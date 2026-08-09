/**
 * Canonical CodexCommander identity.
 *
 * This plain-JavaScript module is also consumed by the Node npm launcher
 * before Bun loads the TypeScript runtime. Keep it free of TypeScript syntax
 * and keep every product identifier single-valued.
 */

export const BRAND_DISPLAY = "CodexCommander";
export const PACKAGE_SLUG = "codexcommander";
export const NPM_PACKAGE = "codexcommander";

export const CLI_LONG = "codexcommander";
export const CLI_SHORT = "ccx";

export const STATE_DIR_NAME = ".codexcommander";
export const HOME_ENV = "CODEXCOMMANDER_HOME";
export const REPOSITORY_URL = "https://github.com/pavelhov/CodexCommander";

export const HEALTH_SERVICE_ID = "codexcommander";
export const PROVIDER_ID = "codexcommander";

export const SERVICE_LABEL = "com.codexcommander.proxy";
export const SERVICE_TASK = "codexcommander-proxy";
export const WINSW_SERVICE_ID = "codexcommander-proxy-native";

export const OWNER_FILE = ".codexcommander-owner.json";
export const UNINSTALL_MANIFEST = ".codexcommander-uninstall.json";

export const ADMIN_KEY_PREFIX = "ccx_admin_";
export const GUI_SESSION_PREFIX = "ccx_session_";
export const DATA_KEY_PREFIX = "ccx_data_";

export const API_KEY_HEADER = "x-codexcommander-api-key";
export const GUI_ORIGIN_HEADER = "x-codexcommander-gui-origin";
export const CSRF_HEADER = "x-codexcommander-csrf-token";
export const ATTESTATION_CHALLENGE_HEADER = "x-codexcommander-attestation-challenge";
export const ATTESTATION_PROOF_HEADER = "x-codexcommander-attestation-proof";

export const AUTH_REQUIRED_MESSAGE = "CodexCommander API key required";
export const ADMIN_AUTH_REQUIRED_MESSAGE = "CodexCommander admin token required";

export const ARTIFACT_HTTP_PREFIX = "/v1/codexcommander/artifacts";
export const SESSION_PATH = "/codexcommander-session";

/** Read one canonical environment variable. */
export function readEnv(name, env = process.env) {
  const value = env?.[name]?.trim();
  return value || undefined;
}
