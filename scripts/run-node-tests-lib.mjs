// Glob expansion and process handling for scripts/run-node-tests.mjs.
//
// npm runs package.json scripts through cmd.exe on Windows, and cmd.exe does
// not expand `*.test.js`, so `node --test dir/*.test.js` fails there. The
// runner expands the patterns itself, with no dependency and the same
// deterministic (sorted) result on every platform; fs.globSync is still
// experimental in Node 22.
//
// A pattern is a file path, or a path whose final segment holds `*`
// wildcards (`server/__tests__/*.test.js`). Wildcards in directory segments
// are not supported. A pattern that matches nothing is an error, so a typo
// cannot silently drop a suite.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function escapeRegExp(text) {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// "/" always separates; "\" only where it is the platform separator, so a
// POSIX file name that contains a backslash is left alone.
function lastSeparator(pattern) {
  const slash = pattern.lastIndexOf("/");
  return path.sep === "\\" ? Math.max(slash, pattern.lastIndexOf("\\")) : slash;
}

/**
 * Expands one pattern relative to `cwd`. Returns the matching file paths,
 * sorted, prefixed with the pattern's own directory (with "/" separators on
 * Windows). Throws when the directory is missing or nothing matches.
 */
export function expandPattern(pattern, { cwd = process.cwd() } = {}) {
  if (typeof pattern !== "string" || pattern.trim() === "") {
    throw new Error("empty test pattern");
  }
  const cut = lastSeparator(pattern);
  // Keep the directory as written, leading separators included, so absolute
  // and UNC (\\host\share) paths survive.
  const dir = cut === -1 ? "" : pattern.slice(0, cut + 1);
  const base = pattern.slice(cut + 1);
  if (dir.includes("*")) {
    throw new Error(`test pattern ${pattern}: wildcards are only supported in the final path segment`);
  }
  if (base === "") throw new Error(`test pattern ${pattern}: names a directory, not files`);
  const absDir = path.resolve(cwd, dir || ".");
  const prefix = path.sep === "\\" ? dir.replaceAll("\\", "/") : dir;
  const shownDir = prefix.length > 1 ? prefix.replace(/\/$/, "") : prefix || ".";

  if (!base.includes("*")) {
    const absFile = path.join(absDir, base);
    if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
      throw new Error(`test pattern ${pattern}: file not found`);
    }
    return [prefix + base];
  }

  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      throw new Error(`test pattern ${pattern}: directory ${shownDir} not found`);
    }
    throw new Error(`test pattern ${pattern}: cannot read directory ${shownDir}: ${error.message}`);
  }
  const matcher = new RegExp(`^${base.split("*").map(escapeRegExp).join(".*")}$`);
  // Like a POSIX shell, `*` does not match a leading dot. Unlike one, only
  // files match: sh would also pass along a directory named `x.test.js`.
  const allowDotfiles = base.startsWith(".");
  const matches = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => (allowDotfiles || !name.startsWith(".")) && matcher.test(name))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => prefix + name);
  if (matches.length === 0) {
    throw new Error(`test pattern ${pattern}: no files match`);
  }
  return matches;
}

/** Expands every pattern in order and drops duplicate files. */
export function expandPatterns(patterns, options) {
  if (patterns.length === 0) throw new Error("no test patterns given");
  const seen = new Set();
  const files = [];
  for (const pattern of patterns) {
    for (const file of expandPattern(pattern, options)) {
      if (!seen.has(file)) {
        seen.add(file);
        files.push(file);
      }
    }
  }
  return files;
}

/** Splits argv into node flags (before `--`) and patterns (after it, or all of it). */
export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1) return { nodeFlags: [], patterns: argv };
  return { nodeFlags: argv.slice(0, separator), patterns: argv.slice(separator + 1) };
}

/** Expands the patterns in argv and runs `node --test` on them; exits with its status. */
export function main(argv) {
  const { nodeFlags, patterns } = parseArgs(argv);
  let files;
  try {
    files = expandPatterns(patterns);
  } catch (error) {
    console.error(`run-node-tests: ${error.message}`);
    process.exit(2);
  }

  const child = spawn(process.execPath, [...nodeFlags, "--test", ...files], { stdio: "inherit" });
  const forward = (signal) => child.kill(signal);
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);
  child.on("error", (error) => {
    console.error(`run-node-tests: failed to start node: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    process.off("SIGINT", forward);
    process.off("SIGTERM", forward);
    if (signal) {
      // Re-raise so the caller sees the same signal; if it is ignored and we
      // keep running, still fail rather than exit 0.
      process.exitCode = 1;
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
