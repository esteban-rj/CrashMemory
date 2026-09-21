import { execFileSync } from "node:child_process";

const [before, head = "HEAD", baseRef] = process.argv.slice(2);
const zero = /^0+$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

let base = before;
if (baseRef) {
  const remoteBase = `origin/${baseRef}`;
  base = git(["merge-base", head, remoteBase]);
}

if (!baseRef && process.env.GITHUB_REF !== "refs/heads/main") {
  console.log(
    "README gate: feature-branch push; README is enforced on the pull request.",
  );
  process.exit(0);
}

if (!base || zero.test(base))
  throw new Error("README gate requires a comparable integration base.");

const changed = git(["diff", "--name-only", base, head]).split("\n");
if (!changed.includes("README.md")) {
  throw new Error(
    "Every delivery must update README.md with verified usage or verification instructions.",
  );
}

console.log(`README gate passed for ${base}..${head}.`);
