import { writeFileSync } from "node:fs";

const pidPath = process.env.CCX_TRAY_TEST_PID_FILE;
if (!pidPath) throw new Error("Missing CCX_TRAY_TEST_PID_FILE.");

writeFileSync(pidPath, String(process.pid));
await Bun.sleep(30_000);
