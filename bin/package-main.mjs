export const packageName = "codexcommander";
export const cliCommand = "ccx";

export async function loadBunApi() {
  if (typeof Bun === "undefined") {
    throw new Error("The CodexCommander programmatic API requires the Bun runtime. Use `ccx` for the CLI entrypoint.");
  }
  return import("../src/index.ts");
}
