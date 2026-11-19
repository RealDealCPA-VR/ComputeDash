#!/usr/bin/env node
/**
 * `npm run setup`: first-run helper for a ComputeDash host (Windows, macOS, Linux).
 *
 * Checks Node, ssh and (optionally) Tailscale; creates .env from .env.example
 * when it is missing; adds a random SPARKDASH_TOKEN when none is set (an
 * existing token is never replaced, and the rest of .env is kept byte for
 * byte); checks config/ and the frontend build; prints what to do next.
 * Safe to run again. Non-interactive.
 *
 *   npm run setup                    check and write what is missing
 *   npm run setup -- --check         report only, write nothing
 *   npm run setup -- --print-token   also print the token value
 *
 * Exits non-zero only when Node is too old.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSetup } from "./setup-lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const { exitCode, output } = runSetup({ root, argv: process.argv.slice(2) });
  process.stdout.write(output);
  process.exitCode = exitCode;
} catch (err) {
  // Unexpected local problem (for example .env not writable): say so plainly.
  process.stderr.write(`setup: ${err && err.message ? err.message : err}\n`);
  process.exitCode = 1;
}
