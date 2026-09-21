import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scanner = "scripts/check-secrets.mjs";

test("secret scanner detects the isolated synthetic credential fixture", () => {
  const baseline = spawnSync(process.execPath, [scanner], { encoding: "utf8" });
  assert.equal(baseline.status, 0, baseline.stderr);

  const fixture = spawnSync(process.execPath, [scanner, "--include-fixture"], {
    encoding: "utf8",
  });
  assert.notEqual(fixture.status, 0);
  assert.match(fixture.stderr, /Possible credential found/);
});

test("secret scanner reads staged content when it differs from the worktree", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "crashmemory-secret-scan-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const localScanner = join(directory, "check-secrets.mjs");
  cpSync(scanner, localScanner);
  writeFileSync(join(directory, "safe.txt"), "safe worktree content\n");
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["add", "safe.txt"], { cwd: directory });

  const synthetic = ["ghp_", "0123456789abcdefghijklmnopqrstuv"].join("");
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    cwd: directory,
    input: synthetic,
    encoding: "utf8",
  }).trim();
  execFileSync(
    "git",
    ["update-index", "--add", "--cacheinfo", `100644,${blob},safe.txt`],
    {
      cwd: directory,
    },
  );
  assert.equal(
    readFileSync(join(directory, "safe.txt"), "utf8"),
    "safe worktree content\n",
  );

  const staged = spawnSync(process.execPath, [localScanner], {
    cwd: directory,
    encoding: "utf8",
  });
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /candidate commit: safe.txt/);
});
