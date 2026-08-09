// Emit more than a tiny CCX_DOCTOR_MAX_BUFFER so the prepush wrapper hard-fails.
process.stdout.write("x".repeat(64 * 1024));
process.exit(0);
