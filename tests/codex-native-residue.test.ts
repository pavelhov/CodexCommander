import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  buildCatalogEntries,
  readCodexCatalogPath,
} from "../src/codex/catalog";
import { buildProfileFile } from "../src/codex/inject";
import {
  classifyNativeRoutedResidue,
  classifyNativeRoutedResidueWithoutJournal,
} from "../src/codex/native-residue";
import { readCodexTransitionState } from "../src/codex/transition-state";
import {
  resolveCodexCoordinatorDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import type { CodexCommanderConfig } from "../src/types";
import { convergeCatalogForTest } from "./helpers/catalog-convergence";

setDefaultTimeout(30_000);

let codexHome = "";
let codexCommanderHome = "";
let coordinatorPath = "";
let previousCodexHome: string | undefined;
let previousCodexCommanderHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousCodexCommanderHome = process.env.CODEXCOMMANDER_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "ccx-native-residue-codex-"));
  codexCommanderHome = mkdtempSync(join(tmpdir(), "ccx-native-residue-codexcommander-"));
  process.env.CODEX_HOME = codexHome;
  process.env.CODEXCOMMANDER_HOME = codexCommanderHome;
  coordinatorPath = resolveCodexCoordinatorDatabasePath(
    resolveEffectiveUserIdentity(),
    realpathSync.native(codexHome),
  );
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousCodexCommanderHome === undefined) delete process.env.CODEXCOMMANDER_HOME;
  else process.env.CODEXCOMMANDER_HOME = previousCodexCommanderHome;
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${coordinatorPath}${suffix}`, { force: true });
  }
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(codexCommanderHome, { recursive: true, force: true });
});

function pathInCodexHome(name: string): string {
  return join(codexHome, name);
}

function canonicalPathInCodexHome(name: string): string {
  return join(realpathSync.native(codexHome), name);
}

function routedCatalog(): string {
  const models = buildCatalogEntries(
    null,
    [],
    [{ provider: "fixture-provider", id: "fixture-model" }],
  );
  return JSON.stringify({ models }, null, 2) + "\n";
}

const residueFixtures: Array<{
  name: string;
  surface: string;
  arrange: () => void;
}> = [
  {
    name: "injected config.toml",
    surface: "config",
    arrange: () => writeFileSync(pathInCodexHome("config.toml"), [
      "# Auto-injected by CodexCommander",
      'openai_base_url = "http://127.0.0.1:10100/v1"',
      "",
    ].join("\n")),
  },
  {
    name: "generated profile",
    surface: "profile",
    arrange: () => writeFileSync(
      pathInCodexHome("codexcommander.config.toml"),
      buildProfileFile(10100, null),
    ),
  },
  {
    name: "routed catalog",
    surface: "catalog",
    arrange: () => writeFileSync(pathInCodexHome("codexcommander-catalog.json"), routedCatalog()),
  },
  {
    name: "routed models cache",
    surface: "models-cache",
    arrange: () => writeFileSync(pathInCodexHome("models_cache.json"), routedCatalog()),
  },
  {
    name: "restore journal",
    surface: "journal",
    arrange: () => writeFileSync(pathInCodexHome("codexcommander-journal.json"), JSON.stringify({
      version: 1,
      originalConfig: Buffer.from('model = "gpt-5.5"\n').toString("base64"),
      originalProfile: null,
      pid: 12345,
      timestamp: "2026-08-04T00:00:00.000Z",
    })),
  },
];

for (const fixture of residueFixtures) {
  test(`${fixture.name} is structurally provable routed residue`, () => {
    fixture.arrange();
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "residue",
      surface: fixture.surface,
    });
  });

  if (fixture.surface !== "journal") {
    test(`${fixture.name} remains routed residue when only the journal is ignored`, () => {
      fixture.arrange();
      expect(classifyNativeRoutedResidueWithoutJournal()).toMatchObject({
        kind: "residue",
        surface: fixture.surface,
      });
    });
  }
}

test("the recovery observation ignores only a completed journal while the default remains fail-closed", () => {
  residueFixtures.find(fixture => fixture.surface === "journal")!.arrange();

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "journal",
  });
  expect(classifyNativeRoutedResidueWithoutJournal()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

test("the recovery observation still refuses a journal atomic-write replacement", () => {
  residueFixtures.find(fixture => fixture.surface === "journal")!.arrange();
  const tempPath = pathInCodexHome("codexcommander-journal.json.ccx.42.7.tmp");
  writeFileSync(tempPath, "replacement in flight");

  const classified = classifyNativeRoutedResidueWithoutJournal();
  expect(classified).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
    reason: "CodexCommander atomic-write artifact is still present",
  });
  expect(classified.kind === "indeterminate" ? basename(classified.path) : null)
    .toBe(basename(tempPath));
});

test("an CodexCommander atomic-write artifact is indeterminate", () => {
  writeFileSync(pathInCodexHome("config.toml.ccx.123.1.tmp"), "partial");
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
  });
});

test("a routed catalog at the configured nested path refuses coordinator initialization", async () => {
  const catalogPath = canonicalPathInCodexHome("nested/custom-catalog.json");
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  const config: CodexCommanderConfig = {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.invalid/v1",
        liveModels: false,
        models: ["fixture-model"],
      },
    },
  };

  const sync = await convergeCatalogForTest(config);

  expect(sync).toMatchObject({ path: catalogPath, catalogWritten: true });
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "catalog",
    path: catalogPath,
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

test("a BOM-prefixed configured catalog refuses coordinator initialization", () => {
  writeFileSync(
    pathInCodexHome("config.toml"),
    '\uFEFFmodel_catalog_json = "bom-catalog.json"\n',
  );
  const productionTarget = readCodexCatalogPath();
  mkdirSync(dirname(productionTarget), { recursive: true });
  writeFileSync(productionTarget, routedCatalog());

  expect(classifyNativeRoutedResidue()).toEqual({
    kind: "residue",
    surface: "catalog",
    path: productionTarget,
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

const catalogConfigShapes: Array<{
  name: string;
  content: string;
  strictOnlyTargets?: string[];
}> = [
  {
    name: "quoted key",
    content: '"model_catalog_json" = "quoted.json"\n',
    strictOnlyTargets: ["quoted.json"],
  },
  { name: "single-quoted value", content: "model_catalog_json = 'single.json'\n" },
  { name: "BOM prefix", content: '\uFEFFmodel_catalog_json = "bom.json"\n' },
  { name: "CRLF", content: 'model_catalog_json = "crlf.json"\r\n' },
  { name: "leading whitespace", content: '  model_catalog_json = "ws.json"\n' },
  { name: "after table header", content: '[tools]\nmodel_catalog_json = "nested.json"\n' },
  { name: "trailing comment", content: 'model_catalog_json = "cmt.json" # comment\n' },
];

for (const shape of catalogConfigShapes) {
  test(`catalog candidate coverage matches production for ${shape.name}`, () => {
    writeFileSync(pathInCodexHome("config.toml"), shape.content);
    for (const target of shape.strictOnlyTargets ?? []) {
      writeFileSync(pathInCodexHome(target), JSON.stringify({ models: [] }));
    }
    const productionTarget = readCodexCatalogPath();
    mkdirSync(dirname(productionTarget), { recursive: true });
    writeFileSync(productionTarget, routedCatalog());

    expect(classifyNativeRoutedResidue()).toEqual({
      kind: "residue",
      surface: "catalog",
      path: productionTarget,
    });
  });
}

const catalogPathShapes: Array<{
  name: string;
  configuredPath: (outsideRoot: string, leaf: string) => string;
}> = [
  { name: "root-relative", configuredPath: (_outsideRoot, leaf) => leaf },
  { name: "nested-relative", configuredPath: (_outsideRoot, leaf) => `nested/${leaf}` },
  {
    name: "absolute inside CODEX_HOME",
    configuredPath: (_outsideRoot, leaf) => canonicalPathInCodexHome(leaf),
  },
  {
    name: "absolute outside CODEX_HOME",
    configuredPath: (outsideRoot, leaf) => join(outsideRoot, leaf),
  },
  {
    name: "parent-escaping relative",
    configuredPath: (_outsideRoot, leaf) => `../${basename(codexHome)}-${leaf}`,
  },
];

for (const shape of catalogPathShapes) {
  test(`configured catalog classification follows the ${shape.name} path`, () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "ccx-native-residue-catalog-outside-"));
    const configuredPath = shape.configuredPath(outsideRoot, randomUUID());
    const targetPath = resolve(realpathSync.native(codexHome), configuredPath);
    try {
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(
        pathInCodexHome("config.toml"),
        `model_catalog_json = ${JSON.stringify(configuredPath)}\n`,
      );

      expect(classifyNativeRoutedResidue(), "configured absence must fail closed").toMatchObject({
        kind: "indeterminate",
        surface: "catalog",
        path: targetPath,
      });

      writeFileSync(targetPath, routedCatalog());
      expect(classifyNativeRoutedResidue(), "routed target must be detected").toEqual({
        kind: "residue",
        surface: "catalog",
        path: targetPath,
      });
    } finally {
      rmSync(targetPath, { force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
}

const productionCatalogLeafShapes = [
  { name: "extensionless", suffix: "" },
  { name: ".txt", suffix: ".txt" },
  { name: ".json5", suffix: ".json5" },
  { name: "trailing dot", suffix: "." },
  { name: "uppercase .JSON", suffix: ".JSON" },
] as const;

for (const shape of productionCatalogLeafShapes) {
  const configuredLeaf = `${randomUUID()}${shape.suffix}`;
  test(`production writer routes the ${shape.name} configured catalog ${configuredLeaf}`, async () => {
    const catalogPath = canonicalPathInCodexHome(`nested/${configuredLeaf}`);
    mkdirSync(dirname(catalogPath), { recursive: true });
    writeFileSync(
      pathInCodexHome("config.toml"),
      `model_catalog_json = ${JSON.stringify(`nested/${configuredLeaf}`)}\n`,
    );
    writeFileSync(catalogPath, JSON.stringify({ models: [] }));
    const config: CodexCommanderConfig = {
      port: 10100,
      multiAgentGuidanceEnabled: true,
      defaultProvider: "fixture",
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://fixture.invalid/v1",
          liveModels: false,
          models: ["fixture-model"],
        },
      },
    };

    const sync = await convergeCatalogForTest(config);
    const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
      models: Array<Record<string, unknown>>;
    };
    const routedRows = catalog.models.filter(model =>
      typeof model.description === "string"
        && model.description.startsWith("Routed via CodexCommander → ")
    );

    expect(sync).toMatchObject({ path: catalogPath, catalogWritten: true });
    expect(routedRows).toHaveLength(1);
    expect(classifyNativeRoutedResidue()).toEqual({
      kind: "residue",
      surface: "catalog",
      path: catalogPath,
    });
  });
}

test("an atomic-write artifact beside the configured catalog is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("nested/custom-catalog.json");
  const artifactPath = `${catalogPath}.ccx.42.7.tmp`;
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  writeFileSync(artifactPath, "partial");

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
    path: artifactPath,
  });
});

test("an atomic-write artifact is found before its configured target exists", () => {
  const catalogPath = canonicalPathInCodexHome("nested/pending.json");
  const artifactPath = `${catalogPath}.ccx.42.7.tmp`;
  mkdirSync(dirname(catalogPath), { recursive: true });
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/pending.json"\n');
  writeFileSync(artifactPath, "partial");

  expect(lstatSync(catalogPath, { throwIfNoEntry: false })).toBeUndefined();
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "partial-write",
    path: artifactPath,
  });
});

test("a configured catalog target that is not a readable regular file is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("nested/custom-catalog.json");
  mkdirSync(catalogPath, { recursive: true });
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "catalog",
    path: catalogPath,
  });
});

const permissionTest = process.platform === "win32" ? test.skip : test;
permissionTest("EACCES on a configured regular catalog file is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("permission-target.json");
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "permission-target.json"\n');
  writeFileSync(catalogPath, routedCatalog());
  expect(lstatSync(catalogPath).isFile()).toBe(true);
  chmodSync(catalogPath, 0o000);
  try {
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: "catalog",
      path: catalogPath,
    });
  } finally {
    chmodSync(catalogPath, 0o600);
  }
});

test("an absent configured catalog target is indeterminate", () => {
  const catalogPath = canonicalPathInCodexHome("nested/missing-catalog.json");
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/missing-catalog.json"\n');

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "catalog",
    path: catalogPath,
  });
});

test("the default catalog is still inspected when a custom catalog is configured", () => {
  const defaultCatalogPath = canonicalPathInCodexHome("codexcommander-catalog.json");
  mkdirSync(pathInCodexHome("nested"));
  writeFileSync(pathInCodexHome("config.toml"), 'model_catalog_json = "nested/custom-catalog.json"\n');
  writeFileSync(pathInCodexHome("nested/custom-catalog.json"), JSON.stringify({ models: [] }));
  writeFileSync(defaultCatalogPath, routedCatalog());

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "catalog",
    path: defaultCatalogPath,
  });
});

for (const location of ["inside", "outside"] as const) {
  test(`the default catalog remains inspected with an absolute ${location} configured path`, () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "ccx-native-residue-default-outside-"));
    const configuredPath = location === "inside"
      ? canonicalPathInCodexHome("absolute-custom.json")
      : join(outsideRoot, "absolute-custom.json");
    const defaultCatalogPath = canonicalPathInCodexHome("codexcommander-catalog.json");
    try {
      writeFileSync(
        pathInCodexHome("config.toml"),
        `model_catalog_json = ${JSON.stringify(configuredPath)}\n`,
      );
      writeFileSync(configuredPath, JSON.stringify({ models: [] }));
      writeFileSync(defaultCatalogPath, routedCatalog());

      expect(classifyNativeRoutedResidue()).toMatchObject({
        kind: "residue",
        surface: "catalog",
        path: defaultCatalogPath,
      });
    } finally {
      rmSync(configuredPath, { force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
}

test("every non-string TOML type for model_catalog_json is indeterminate", () => {
  const nonStringTomlValues = [
    ["number", "42"],
    ["boolean", "true"],
    ["array", '["custom.json"]'],
    ["inline table", '{ path = "custom.json" }'],
    ["datetime", "1979-05-27T07:32:00Z"],
  ] as const;

  for (const [type, value] of nonStringTomlValues) {
    writeFileSync(pathInCodexHome("config.toml"), `model_catalog_json = ${value}\n`);
    expect(classifyNativeRoutedResidue(), type).toMatchObject({
      kind: "indeterminate",
      surface: "config",
      path: canonicalPathInCodexHome("config.toml"),
    });
  }
});

test("duplicate configured catalog paths are indeterminate", () => {
  writeFileSync(pathInCodexHome("config.toml"), [
    'model_catalog_json = "first.json"',
    'model_catalog_json = "second.json"',
    "",
  ].join("\n"));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "config",
    path: canonicalPathInCodexHome("config.toml"),
  });
});

const arbitraryComboAlias = randomUUID();

test(`production-generated arbitrary bare combo alias ${arbitraryComboAlias} is routed residue`, async () => {
  // The production writer and residue classifier share the canonical catalog filename.
  const catalogPath = canonicalPathInCodexHome("codexcommander-catalog.json");
  writeFileSync(catalogPath, JSON.stringify({ models: [] }));
  const config: CodexCommanderConfig = {
    port: 10100,
    multiAgentGuidanceEnabled: true,
    defaultProvider: "fixture",
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.invalid/v1",
        liveModels: false,
        models: ["combo-member"],
        modelContextWindows: { "combo-member": 128_000 },
      },
    },
    disabledModels: ["fixture/combo-member"],
    combos: {
      edge: {
        alias: arbitraryComboAlias,
        targets: [{ provider: "fixture", model: "combo-member" }],
      },
    },
  };

  const sync = await convergeCatalogForTest(config);
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
    models: Array<Record<string, unknown>>;
  };
  const routedRows = catalog.models.filter(model =>
    typeof model.description === "string"
      && model.description.startsWith("Routed via CodexCommander → ")
  );

  expect(sync).toMatchObject({ path: catalogPath, catalogWritten: true });
  expect(arbitraryComboAlias).not.toContain("/");
  expect(routedRows).toEqual([
    expect.objectContaining({
      slug: arbitraryComboAlias,
      description: "Routed via CodexCommander → combo (combo).",
      owned_by: "combo",
    }),
  ]);
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "residue",
    surface: "catalog",
  });
  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});

const arbitraryForeignSlug = `${randomUUID()}/${randomUUID()}`;
const arbitraryForeignDescription = randomUUID();

test(`arbitrary foreign row ${arbitraryForeignSlug} described as ${arbitraryForeignDescription} is indeterminate`, () => {
  writeFileSync(pathInCodexHome("codexcommander-catalog.json"), JSON.stringify({
    models: [{ slug: arbitraryForeignSlug, description: arbitraryForeignDescription }],
  }));

  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "catalog",
  });
});

const indeterminateFixtures: Array<{
  name: string;
  surface: string;
  arrange: () => void;
}> = [
  {
    name: "malformed config TOML",
    surface: "config",
    arrange: () => writeFileSync(pathInCodexHome("config.toml"), 'model = "unterminated\n'),
  },
  {
    name: "malformed profile TOML",
    surface: "profile",
    arrange: () => writeFileSync(pathInCodexHome("codexcommander.config.toml"), "[features\n"),
  },
  {
    name: "malformed catalog JSON",
    surface: "catalog",
    arrange: () => writeFileSync(pathInCodexHome("codexcommander-catalog.json"), "{not-json"),
  },
  {
    name: "unreadable models cache shape",
    surface: "models-cache",
    arrange: () => mkdirSync(pathInCodexHome("models_cache.json")),
  },
  {
    name: "malformed journal JSON",
    surface: "journal",
    arrange: () => writeFileSync(pathInCodexHome("codexcommander-journal.json"), "{not-json"),
  },
  {
    name: "partial write",
    surface: "partial-write",
    arrange: () => writeFileSync(pathInCodexHome("codexcommander-catalog.json.ccx.42.7.tmp"), ""),
  },
];

for (const fixture of indeterminateFixtures) {
  test(`${fixture.name} is indeterminate and refuses coordinator initialization`, () => {
    fixture.arrange();
    expect(classifyNativeRoutedResidue()).toMatchObject({
      kind: "indeterminate",
      surface: fixture.surface,
    });
    expect(readCodexTransitionState()).toEqual({
      kind: "state-ambiguous",
      message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
    });
  });

  if (fixture.surface !== "journal") {
    test(`${fixture.name} remains indeterminate when only the journal is ignored`, () => {
      fixture.arrange();
      expect(classifyNativeRoutedResidueWithoutJournal()).toMatchObject({
        kind: "indeterminate",
        surface: fixture.surface,
      });
    });
  }
}

const symlinkTest = process.platform === "win32" ? test.skip : test;
symlinkTest("an unresolvable surface symlink is indeterminate", () => {
  symlinkSync(pathInCodexHome("missing-config"), pathInCodexHome("config.toml"));
  expect(classifyNativeRoutedResidue()).toMatchObject({
    kind: "indeterminate",
    surface: "config",
  });
});

test("an empty CODEX_HOME is clean and coordinator initialization succeeds", () => {
  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("user-owned non-CodexCommander content is clean and coordinator initialization succeeds", () => {
  writeFileSync(pathInCodexHome("config.toml"), 'model = "gpt-5.5"\n');
  writeFileSync(pathInCodexHome("notes.txt"), "user content\n");
  writeFileSync(pathInCodexHome("codexcommander-catalog.json"), JSON.stringify({
    models: [{ slug: "gpt-5.5", description: "Native GPT model" }],
  }));
  writeFileSync(pathInCodexHome("models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-5.5", description: "Native GPT model" }],
  }));
  expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
  expect(readCodexTransitionState()).toMatchObject({
    kind: "ready",
    state: { nativeGeneration: 0, currentTxId: null },
  });
});

test("CODEX_HOME is resolved at call time", () => {
  const secondHome = mkdtempSync(join(tmpdir(), "ccx-native-residue-second-codex-"));
  try {
    writeFileSync(join(secondHome, "codexcommander.config.toml"), buildProfileFile(10100, null));
    expect(classifyNativeRoutedResidue()).toEqual({ kind: "clean" });
    process.env.CODEX_HOME = secondHome;
    expect(classifyNativeRoutedResidue()).toMatchObject({ kind: "residue", surface: "profile" });
  } finally {
    process.env.CODEX_HOME = codexHome;
    rmSync(secondHome, { recursive: true, force: true });
  }
});

test("a missing coordinator with only the generated profile refuses initialization", () => {
  writeFileSync(join(codexHome, "codexcommander.config.toml"), buildProfileFile(10100, null));

  expect(readCodexTransitionState()).toEqual({
    kind: "state-ambiguous",
    message: "A missing coordinator row cannot be initialized while native Codex routing residue exists.",
  });
});
