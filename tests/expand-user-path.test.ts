import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandUserPath, getConfigDir } from "../src/config";

const previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;

afterEach(() => {
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
});

describe("expandUserPath", () => {
  test("expands ~ and leading ~/ or ~\\ to the home directory", () => {
    expect(expandUserPath("~")).toBe(homedir());
    expect(expandUserPath("~/custom/dir")).toBe(join(homedir(), "custom/dir"));
    expect(expandUserPath("~\\custom\\dir")).toBe(join(homedir(), "custom\\dir"));
  });

  test("leaves ~user, absolute, relative, and %VAR%/$VAR paths untouched", () => {
    expect(expandUserPath("~other/dir")).toBe("~other/dir");
    expect(expandUserPath("/absolute/dir")).toBe("/absolute/dir");
    expect(expandUserPath("relative/dir")).toBe("relative/dir");
    expect(expandUserPath("%USERPROFILE%\\dir")).toBe("%USERPROFILE%\\dir");
    expect(expandUserPath("$HOME/dir")).toBe("$HOME/dir");
  });
});

describe("CODEXCOMMANDER_HOME tilde expansion", () => {
  test("getConfigDir honors CODEXCOMMANDER_HOME=~/...", () => {
    process.env.CODEXCOMMANDER_HOME = "~/.ccx-tilde-test";
    expect(getConfigDir()).toBe(join(homedir(), ".ccx-tilde-test"));
  });
});
