// Legacy: settings were called MOCHI_* before the rename to Cadbury. Copy each one to its CADBURY_* name
// unless that is already set, so old .env files keep working. Imported first by index.ts.
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith("MOCHI_") && v !== undefined) {
    const n = "CADBURY_" + k.slice("MOCHI_".length);
    if (process.env[n] === undefined) process.env[n] = v;
  }
}
