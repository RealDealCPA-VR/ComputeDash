#!/usr/bin/env node
// Expands test-file globs in Node, then runs `node --test` with the result,
// so `npm test` works under cmd.exe on Windows. See run-node-tests-lib.mjs.
//
// Usage: node scripts/run-node-tests.mjs [node flags... --] <pattern...>
//
// This file is only ever run as the entry point; the testable logic lives in
// the lib so no main-module guard is needed (a guard comparing argv[1] with
// import.meta.url breaks when the path goes through a symlink or junction).

import { main } from "./run-node-tests-lib.mjs";

main(process.argv.slice(2));
