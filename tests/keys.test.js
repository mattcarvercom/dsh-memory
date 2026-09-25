import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { ancestry, canonicalRoot, claudeHash, claudeMemoryDir, clearRootCache, dshMemoryDir, projectKey, resolveKey } from "../lib/keys.js";
import { makeRoots } from "./helpers.js";

describe("projectKey (Claude Code's rule)", () => {
  it("replaces every non-alphanumeric character with -", () => {
    assert.equal(projectKey("/home/me/dev"), "-home-me-dev");
    assert.equal(projectKey("/home/me/my_project.v2 x"), "-home-me-my-project-v2-x");
    assert.equal(projectKey("C:\\work\\my-project"), "C--work-my-project");
    assert.equal(projectKey("/home/me/café"), "-home-me-caf-");
  });

  it("caps long keys at 200 characters plus a base-36 hash of the original path", () => {
    const path = `/home/me/${"a".repeat(250)}`;
    const key = projectKey(path);
    assert.equal(key.slice(0, 200), path.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 200));
    assert.equal(key, `${key.slice(0, 200)}-${Math.abs(claudeHash(path)).toString(36)}`);
    assert.equal(projectKey(`${"/x".repeat(100)}`).length, 200);
  });

  it("hashes like Java String.hashCode", () => {
    assert.equal(claudeHash(""), 0);
    assert.equal(claudeHash("hello"), 99162322);
  });
});

describe("ancestry", () => {
  it("stops at the home directory", () => {
    assert.deepEqual(ancestry("/home/me/dev/proj", "/home/me"), ["/home/me/dev/proj", "/home/me/dev", "/home/me"]);
  });
  it("walks to the filesystem root outside home", () => {
    assert.deepEqual(ancestry("/srv/app", "/home/me"), ["/srv/app", "/srv", "/"]);
  });
});

describe("canonicalRoot and resolveKey", () => {
  let t;
  before(async () => {
    t = await makeRoots();
    clearRootCache();
  });
  after(() => t.cleanup());

  it("keys a git repo by its root and a worktree by the main checkout", async () => {
    const repo = join(t.home, "dev", "repo");
    await mkdir(join(repo, "src"), { recursive: true });
    const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", join(t.home, "dev", "repo-wt"));
    assert.equal(await canonicalRoot(join(repo, "src")), repo);
    assert.equal(await canonicalRoot(join(t.home, "dev", "repo-wt")), repo);
  });

  it("uses the directory itself outside a repository", async () => {
    const plain = join(t.home, "plain", "deep");
    await mkdir(plain, { recursive: true });
    assert.equal(await canonicalRoot(plain), plain);
  });

  it("walks up to the nearest ancestor with a Claude Code memory folder", async () => {
    const dev = join(t.home, "dev2");
    const project = join(dev, "myapp", "src");
    await mkdir(project, { recursive: true });
    await mkdir(claudeMemoryDir(t.claudeRoot, projectKey(dev)), { recursive: true });
    assert.equal(await resolveKey(project, t.roots), projectKey(dev));
  });

  it("also matches folders that exist only in the dsh store", async () => {
    const dir = join(t.home, "dshonly", "a");
    await mkdir(dir, { recursive: true });
    await mkdir(dshMemoryDir(t.dshRoot, projectKey(join(t.home, "dshonly"))), { recursive: true });
    assert.equal(await resolveKey(dir, t.roots), projectKey(join(t.home, "dshonly")));
  });

  it("falls back to the root's own key and never above home", async () => {
    const dir = join(t.home, "fresh", "x");
    await mkdir(dir, { recursive: true });
    await mkdir(claudeMemoryDir(t.claudeRoot, projectKey("/")), { recursive: true });
    assert.equal(await resolveKey(dir, t.roots), projectKey(dir));
  });

  it("applies aliases", async () => {
    const dir = join(t.home, "aliased");
    await mkdir(dir, { recursive: true });
    assert.equal(await resolveKey(dir, { ...t.roots, aliases: { [projectKey(dir)]: "canonical" } }), "canonical");
  });
});
