// The tests import the desktop app's shared code, which imports its seed
// bundle; with no fetch, this puts the inert placeholder there unless a
// seed is already on disk. The same step as the desktop app's pretest,
// but setting the variable here rather than as `VAR=1 node ...` in
// package.json, which cmd.exe -- pnpm's script shell on Windows unless
// npm_config_script_shell says otherwise -- refuses as an unknown
// command, failing `pnpm test` before a test runs.
process.env.NEOXIFY_SKIP_SEED = "1";
await import("../../desktop-windows/scripts/ensure-seed-bundle.mjs");
