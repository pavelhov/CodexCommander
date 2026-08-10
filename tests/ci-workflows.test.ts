import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Governance/CI invariants for the repository's current workflow surface.
 *
 * What this file pins:
 *  - only the explicitly supported verification workflows are present;
 *  - `ci.yml` is the ONLY workflow with automatic triggers, and its single
 *    `ci` job is the only automatic check — it cannot be path-filtered into
 *    Pending, so a GitHub ruleset can require it on `main`;
 *  - cross-platform verification runs only after integration or manually;
 *  - `service-lifecycle.yml` stays manual-only (workflow_dispatch);
 *  - no workflow carries self-hosted-runner state or `pull_request_target`;
 *  - third-party actions stay pinned to immutable commit SHAs.
 *
 * Owner/admin bypass itself is NOT enforceable from this repository: it lives
 * in the GitHub ruleset on `main` (Repository admin = Always-allow bypass
 * actor; no classic "include administrators" branch protection). MAINTAINERS.md
 * is the source of truth for that invariant.
 */

const root = new URL("../", import.meta.url);
const workflowsDir = fileURLToPath(new URL(".github/workflows/", root));
const scriptsDir = fileURLToPath(new URL(".github/scripts/", root));

function readRepo(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, root)), "utf8");
}

function workflowNames(): string[] {
  return readdirSync(workflowsDir).filter(name => name.endsWith(".yml"));
}

function readWorkflow(name: string): string {
  return readRepo(`.github/workflows/${name}`);
}

/** The `on:` block of a workflow, from `on:` to the next top-level key. */
function onBlock(text: string): string {
  return text.split(/^on:/m)[1]?.split(/^[a-z]/m)[0] ?? "";
}

describe("workflow surface stays minimal", () => {
  const removedWorkflows = [
    // Write-heavy issue and pull-request automation is intentionally absent.
    "enforce-pr-target.yml",
    "pr-hygiene.yml",
    "enforce-issue-quality.yml",
    "issue-triage.yml",
    "issue-quality-tests.yml",
    "stale-needs-info.yml",
    // Publishing, deployment, and auxiliary scan automation is not part of this repository.
    "deploy-docs.yml",
    "release.yml",
    "react-doctor.yml",
    "pr-labeler.yml",
  ];

  test("removed workflows stay deleted", () => {
    for (const name of removedWorkflows) {
      expect(existsSync(`${workflowsDir}/${name}`), name).toBe(false);
    }
  });

  test("release-notes label config and automation scripts are gone too", () => {
    expect(existsSync(fileURLToPath(new URL(".github/release.yml", root)))).toBe(false);
    expect(existsSync(scriptsDir)).toBe(false);
  });

  test("CodeRabbit config stays removed", () => {
    expect(existsSync(fileURLToPath(new URL(".coderabbit.yaml", root)))).toBe(false);
  });

  test("only canonical verification workflows remain", () => {
    expect(workflowNames().sort()).toEqual(["ci.yml", "cross-platform.yml", "service-lifecycle.yml"]);
  });
});

describe("ci.yml is the only pull-request check", () => {
  const ci = readWorkflow("ci.yml");

  test("it is the only workflow triggered by pull requests", () => {
    for (const name of workflowNames()) {
      const triggers = onBlock(readWorkflow(name));
      if (name === "ci.yml") {
        expect(triggers, name).toContain("pull_request:");
        expect(triggers, name).toContain("push:");
      } else if (name === "cross-platform.yml") {
        expect(triggers, name).not.toContain("pull_request");
        expect(triggers, name).toContain("push:");
      } else {
        expect(triggers, name).not.toContain("pull_request");
        expect(triggers, name).not.toContain("push:");
        expect(triggers, name).not.toContain("schedule:");
      }
    }
  });

  test("runs on every pull request with no paths filter", () => {
    // A workflow-level paths filter leaves a required check Pending forever on
    // out-of-scope PRs, so the pull_request trigger must carry no paths list.
    expect(ci).toMatch(/on:\n  pull_request:\n  push:/);
    expect(onBlock(ci)).not.toContain("paths:");
  });

  test("pushes are scoped to main, the sole integration branch", () => {
    expect(ci).toContain("branches: [main]");
    expect(ci).not.toMatch(/branches:\s*\[[^\]]*\b(dev|development|preview)\b/);
  });

  test("exposes exactly one job, named ci, on GitHub-hosted Ubuntu", () => {
    const jobsSection = ci.split(/^jobs:/m)[1] ?? "";
    const jobNames = [...jobsSection.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map(m => m[1]);
    expect(jobNames).toEqual(["ci"]);
    expect(ci).toContain("name: ci");
    expect(ci).toContain("runs-on: ubuntu-latest");
  });

  test("covers the full local gate: typecheck, privacy, tests, GUI lint/i18n/build", () => {
    for (const step of [
      "bun x tsc --noEmit",
      "bun run privacy:scan",
      "bun test --isolate tests",
      "bun run lint",
      "bun run lint:i18n",
      "bun run build",
    ]) {
      expect(ci).toContain(step);
    }
    // The suite serves gui/dist, so the build must precede the test run.
    expect(ci.indexOf("bun run build")).toBeLessThan(ci.indexOf("bun test --isolate tests"));
  });

  test("grants read-only permissions and keeps no checkout credentials", () => {
    expect(ci).toContain("permissions:\n  contents: read");
    expect(ci).not.toMatch(/permissions:[\s\S]*?: write/);
    expect(ci).toContain("persist-credentials: false");
  });
});

describe("service lifecycle workflow is manual-only", () => {
  test("triggers exclusively on workflow_dispatch", () => {
    const triggers = onBlock(readWorkflow("service-lifecycle.yml"));
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toContain("pull_request");
    expect(triggers).not.toContain("push:");
    expect(triggers).not.toContain("schedule:");
  });
});

describe("cross-platform verification is post-integration only", () => {
  test("runs on main pushes and manual dispatch, never pull requests", () => {
    const triggers = onBlock(readWorkflow("cross-platform.yml"));
    expect(triggers).toContain("push:");
    expect(triggers).toContain("branches: [main]");
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).not.toContain("pull_request");
  });
});

describe("workflow hygiene across all active workflows", () => {
  test("no self-hosted runner state remains", () => {
    for (const name of workflowNames()) {
      const text = readWorkflow(name);
      expect(text, name).not.toContain("self-hosted");
      expect(text, name).not.toContain("CCX_SELF_HOSTED");
      expect(text, name).not.toContain("ccx-home");
    }
  });

  test("no workflow uses pull_request_target", () => {
    // With the governance gates gone, no automation runs with write
    // permissions against PR-triggering events at all.
    for (const name of workflowNames()) {
      expect(readWorkflow(name), name).not.toContain("pull_request_target");
    }
  });

  test("no workflow grants write permissions", () => {
    for (const name of workflowNames()) {
      expect(readWorkflow(name), name).not.toMatch(/^\s+\w+:\s*write$/m);
    }
  });

  test("third-party actions are pinned to full commit SHAs with version comments", () => {
    const usesPattern = /uses:\s*([^\s]+)/g;
    for (const name of workflowNames()) {
      for (const line of readWorkflow(name).split("\n")) {
        const match = usesPattern.exec(line);
        usesPattern.lastIndex = 0;
        if (!match) continue;
        const ref = match[1]!;
        if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
        expect(
          /^[a-z0-9_.-]+\/[a-z0-9_./-]+@[0-9a-f]{40}$/.test(ref),
          `${name}: unpinned action ${ref}`,
        ).toBe(true);
        expect(line, `${name}: ${ref} missing human-readable version comment`).toContain("#");
      }
    }
  });
});

describe("governance documents", () => {
  test("CODEOWNERS assigns everything to the owner only", () => {
    const assignments = readRepo(".github/CODEOWNERS")
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    expect(assignments).toEqual(["* @pavelhov"]);
  });

  test("MAINTAINERS.md pins the ruleset admin-bypass invariant", () => {
    const maintainers = readRepo("MAINTAINERS.md");
    expect(maintainers).toContain("@pavelhov");
    expect(maintainers).toMatch(/[Bb]ypass actors/);
    expect(maintainers).toContain("Always allow");
    expect(maintainers).toContain("Include administrators");
  });

  test("MAINTAINERS.md records that release automation is intentionally absent", () => {
    expect(readRepo("MAINTAINERS.md")).toMatch(/publishing automation is not included/i);
  });

  test("AGENTS.md branch policy names main as the sole integration branch", () => {
    const agents = readRepo("AGENTS.md");
    const policy = agents.split("## Branch policy")[1]?.split("\n## ")[0] ?? "";
    expect(policy).toContain("`main`");
    expect(policy).not.toContain("enforce-target");
    expect(policy).toMatch(/[Bb]ypass/);
  });
});
