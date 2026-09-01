import { existsSync, writeFileSync } from "node:fs";

import { openVideoJobStore } from "../../src/images/video-job-store";

const home = process.env.MEDIA_JOURNAL_TEST_HOME;
const readyPath = process.env.MEDIA_JOURNAL_TEST_READY;
const continuePath = process.env.MEDIA_JOURNAL_TEST_CONTINUE;
const resultPath = process.env.MEDIA_JOURNAL_TEST_RESULT;

if (!home || !readyPath || !continuePath || !resultPath) {
  throw new Error("media journal owner child is missing required test paths");
}

process.env.CODEXCOMMANDER_HOME = home;
const store = openVideoJobStore({ now: () => 1_000 });
try {
  writeFileSync(readyPath, "ready", { mode: 0o600 });
  while (!existsSync(continuePath)) await Bun.sleep(10);
  const reservation = store.reserveVideoJob({
    binding: {
      authSource: "subscription_oauth",
      providerKind: "canonical",
      slotRef: "media-slot:owner-child",
      identityDigest: `sha256:${"d".repeat(64)}`,
    },
    deadlineAt: 61_000,
  });
  writeFileSync(resultPath, reservation.kind, { mode: 0o600 });
} finally {
  store.close();
}
