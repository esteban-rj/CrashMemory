import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const syntheticFixture = "fixtures/security/synthetic-token.txt";
const listed = (args) =>
  execFileSync("git", ["ls-files", ...args, "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.endsWith(".lock") && path !== syntheticFixture);
const indexed = new Set(listed(["--cached"]));
const untracked = listed(["--others", "--exclude-standard"]);
const paths = [...new Set([...indexed, ...untracked])];

if (process.argv.includes("--include-fixture")) paths.push(syntheticFixture);

const forbidden = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\b(?:sk|rk)_[A-Za-z0-9]{20,}\b/,
  /AIza[0-9A-Za-z_-]{35}/,
];

for (const path of paths) {
  // A staged file may differ from its worktree copy. Scan the exact index content
  // that would be committed, then scan untracked files directly from the worktree.
  const content = indexed.has(path)
    ? execFileSync("git", ["show", `:${path}`], { encoding: "utf8" })
    : readFileSync(path, "utf8");
  if (forbidden.some((pattern) => pattern.test(content))) {
    throw new Error(`Possible credential found in candidate commit: ${path}`);
  }
}

console.log(
  "No configured secret signatures found in the candidate commit or worktree.",
);
