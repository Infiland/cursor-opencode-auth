import { copyFile } from "node:fs/promises";
import * as path from "node:path";

import { describeExit, run, succeeded } from "cursor-openai-bridge";

type GitOptions = { env?: NodeJS.ProcessEnv; input?: string; signal?: AbortSignal; timeoutMs?: number };

// Keep user configuration (pagers, colours, external diff tools, prefix
// settings) from changing the output we parse or hand back as a patch.
const BASE_ARGS = ["-c", "core.pager=cat", "-c", "color.ui=false", "-c", "diff.noprefix=false"];

export async function git(args: string[], cwd: string, opts: GitOptions = {}): Promise<string> {
  const result = await run("git", [...BASE_ARGS, ...args], {
    cwd,
    env: opts.env ?? process.env,
    input: opts.input,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
  if (!succeeded(result)) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`git ${args[0]} ${describeExit(result)}${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout;
}

/**
 * Record HEAD plus every uncommitted change (staged, unstaged and untracked,
 * honouring .gitignore) as a dangling commit, without touching the real index
 * or working tree. A worktree checked out from it sees exactly what the user sees.
 */
export async function snapshotWorkingTree(repoRoot: string, scratchDir: string, signal?: AbortSignal): Promise<string> {
  const indexPath = path.resolve(repoRoot, (await git(["rev-parse", "--git-path", "index"], repoRoot, { signal })).trim());
  const tempIndex = path.join(scratchDir, "snapshot-index");
  // Starting from a copy of the real index keeps git's stat cache, so only changed files are hashed.
  await copyFile(indexPath, tempIndex).catch(() => undefined);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  await git(["add", "-A", "--", "."], repoRoot, { env, signal });
  const tree = (await git(["write-tree"], repoRoot, { env, signal })).trim();
  const head = (await git(["rev-parse", "--verify", "HEAD"], repoRoot, { signal })).trim();
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: "cursor-opencode-auth",
    GIT_AUTHOR_EMAIL: "cursor-opencode-auth@localhost",
    GIT_COMMITTER_NAME: "cursor-opencode-auth",
    GIT_COMMITTER_EMAIL: "cursor-opencode-auth@localhost",
  };
  return (
    await git(["commit-tree", tree, "-p", head, "-m", "cursor_cli_patch working tree snapshot"], repoRoot, {
      env: identity,
      signal,
    })
  ).trim();
}
