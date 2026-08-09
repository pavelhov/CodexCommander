import { afterEach, describe, expect, test } from "bun:test";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  isDebugEnabled,
  isUsageDebugEnabled,
  resetDebugSettingsForTests,
  setDebugSettings,
} from "../src/lib/debug-settings";

describe("debug settings", () => {
  const prevDebug = process.env.CCX_DEBUG;
  const prevUsage = process.env.CCX_USAGE_DEBUG;

  afterEach(() => {
    resetDebugSettingsForTests();
    if (prevDebug === undefined) delete process.env.CCX_DEBUG;
    else process.env.CCX_DEBUG = prevDebug;
    if (prevUsage === undefined) delete process.env.CCX_USAGE_DEBUG;
    else process.env.CCX_USAGE_DEBUG = prevUsage;
  });

  test("env defaults are off when unset", () => {
    delete process.env.CCX_DEBUG;
    delete process.env.CCX_USAGE_DEBUG;
    expect(isDebugEnabled()).toBe(false);
    expect(isUsageDebugEnabled()).toBe(false);
  });

  test("runtime override enables debug without env", () => {
    delete process.env.CCX_DEBUG;
    setDebugSettings({ debug: true });
    expect(isDebugEnabled()).toBe(true);
    expect(getDebugSettings().runtimeOverride.debug).toBe(true);
  });

  test("clear restores env defaults", () => {
    process.env.CCX_DEBUG = "1";
    setDebugSettings({ debug: false });
    expect(isDebugEnabled()).toBe(false);
    clearDebugSetting("debug");
    expect(isDebugEnabled()).toBe(true);
  });

  test("clearDebugSetting only clears one scope", () => {
    process.env.CCX_DEBUG = "1";
    process.env.CCX_USAGE_DEBUG = "1";
    setDebugSettings({ debug: false, usage: false });
    clearDebugSetting("debug");
    expect(isDebugEnabled()).toBe(true);
    expect(isUsageDebugEnabled()).toBe(false);
    clearDebugSettings();
  });
});
