import { describe, expect, test } from "bun:test";
import { journalOwnerIsProvenDead, readJournalOwnerIdentity, type JournalOwnerIdentity } from "../src/codex/journal-owner";

const owner: JournalOwnerIdentity = {
  platform: "darwin", bootId: "11111111-1111-1111-1111-111111111111", birthToken: "Tue Sep 8 12:00:00 2026",
};
const replacement = { ...owner, bootId: "22222222-2222-2222-2222-222222222222" };
const journal = { pid: 1014, ownerIdentity: owner };
const alive = () => {};

describe("journal owner lifetime proof", () => {
  test("reboot proves previous owner gone despite a live reused PID", () => {
    expect(journalOwnerIsProvenDead(journal, { probe: alive, readIdentity: () => replacement })).toBe(true);
  });
  test("same boot PID reuse is distinguished from a still-live owner", () => {
    expect(journalOwnerIsProvenDead(journal, { probe: alive, readIdentity: () => owner })).toBe(false);
    expect(journalOwnerIsProvenDead(journal, {
      probe: alive, readIdentity: () => ({ ...owner, birthToken: "Tue Sep 8 13:00:00 2026" }),
    })).toBe(true);
  });
  test("legacy, unavailable and incomparable identity never authorize recovery", () => {
    expect(journalOwnerIsProvenDead({ pid: 1014 }, { probe: alive, readIdentity: () => replacement })).toBe(false);
    for (const identity of [undefined, { ...owner, birthToken: undefined }, { ...replacement, platform: "linux" as const }]) {
      expect(journalOwnerIsProvenDead(journal, { probe: alive, readIdentity: () => identity })).toBe(false);
    }
  });
  test("only ESRCH authorizes recovery without cross-boot evidence", () => {
    for (const code of ["ESRCH", "EPERM", "EACCES", "UNKNOWN"]) {
      expect(journalOwnerIsProvenDead(journal, {
        probe: () => { throw Object.assign(new Error(), { code }); }, readIdentity: () => ({ ...owner, birthToken: "different-process" }),
      })).toBe(code === "ESRCH");
    }
  });
  test("a previous boot proves owner death even if a privileged process reused its PID", () => {
    expect(journalOwnerIsProvenDead(journal, {
      probe: () => { throw Object.assign(new Error(), { code: "EPERM" }); },
      readIdentity: () => replacement,
    })).toBe(true);
    expect(journalOwnerIsProvenDead(journal, {
      probe: () => { throw Object.assign(new Error(), { code: "UNKNOWN" }); },
      readIdentity: () => replacement,
    })).toBe(false);
  });
  test("malformed identity and PID fail closed", () => {
    expect(journalOwnerIsProvenDead({ ...journal, pid: -1 }, { probe: alive })).toBe(false);
    expect(journalOwnerIsProvenDead(journal, {
      probe: alive, readIdentity: () => ({ ...replacement, bootId: "garbage" }),
    })).toBe(false);
  });
  test("macOS captures a normalized boot session and process birth", () => {
    expect(readJournalOwnerIdentity(1014, {
      platform: "darwin", command: (file, args) => file.endsWith("sysctl")
        ? ` ${owner.bootId.toUpperCase()}\n` : "Tue Sep  8 12:00:00 2026\n",
    })).toEqual(owner);
  });
  test("Linux stat parser tolerates spaces and parentheses in comm", () => {
    expect(readJournalOwnerIdentity(1014, {
      platform: "linux", readFile: path => path.endsWith("boot_id") ? owner.bootId
        : `1014 (a process (name)) ${["S", ...Array(18).fill("0"), "12345"].join(" ")}\n`,
    })).toEqual({ platform: "linux", bootId: owner.bootId, birthToken: "12345" });
  });
  test("unavailable process details keep boot evidence; boot failure gives no identity", () => {
    expect(readJournalOwnerIdentity(1014, {
      platform: "darwin", command: file => {
        if (file.endsWith("sysctl")) return owner.bootId;
        throw new Error("unavailable");
      },
    })).toEqual({ platform: "darwin", bootId: owner.bootId });
    expect(readJournalOwnerIdentity(1014, {
      platform: "darwin", command: () => { throw new Error("unavailable"); },
    })).toBeUndefined();
  });
  test("actual owner stays live with identity captured by this runtime", () => {
    const identity = readJournalOwnerIdentity(process.pid);
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(identity).toBeDefined();
      expect(readJournalOwnerIdentity(process.pid)).toEqual(identity);
    }
    expect(journalOwnerIsProvenDead({ pid: process.pid, ownerIdentity: identity })).toBe(false);
  });
});
