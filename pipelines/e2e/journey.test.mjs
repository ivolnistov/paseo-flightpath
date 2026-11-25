import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { claimSandbox, SANDBOX_CLAIM, stopChild } from "./journey.mjs";

const children = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
});

function start(source, stdio) {
  const child = spawn(process.execPath, ["-e", source], { stdio });
  children.push(child);
  return child;
}

it("kills a child that ignores SIGTERM and confirms its exit", async () => {
  const child = start("process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);", ["ignore", "pipe", "ignore"]);
  await once(child.stdout, "data");
  expect(await stopChild(child, 200)).toBe(true);
  expect(child.signalCode).toBe("SIGKILL");
});

it("reports an already exited child as stopped", async () => {
  const child = start("", "ignore");
  await once(child, "exit");
  expect(await stopChild(child, 200)).toBe(true);
});

it("claims a fresh sandbox once and refuses reuse or earlier outputs without removing them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-claim-"));
  try {
    const results = path.join(dir, "acceptance-results.json");
    await claimSandbox(dir, [results]);
    const claim = await readFile(path.join(dir, SANDBOX_CLAIM), "utf8");
    await expect(claimSandbox(dir, [results])).rejects.toThrow("already used");
    expect(await readFile(path.join(dir, SANDBOX_CLAIM), "utf8")).toBe(claim);

    const other = await mkdtemp(path.join(tmpdir(), "fp-claim-"));
    try {
      await writeFile(path.join(other, "acceptance-results.json"), "{}\n");
      await expect(claimSandbox(other, [path.join(other, "acceptance-results.json")])).rejects.toThrow("not fresh");
      expect(await readFile(path.join(other, "acceptance-results.json"), "utf8")).toBe("{}\n");
      await expect(readFile(path.join(other, SANDBOX_CLAIM))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("lets only one of two concurrent claims succeed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-claim-"));
  try {
    const outcomes = await Promise.allSettled([claimSandbox(dir, []), claimSandbox(dir, [])]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("treats a link whose target is missing as an earlier output", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "fp-claim-"));
  try {
    const results = path.join(dir, "acceptance-results.json");
    await symlink(path.join(dir, "missing-target"), results);
    await expect(claimSandbox(dir, [results])).rejects.toThrow("not fresh");
    await expect(readFile(path.join(dir, SANDBOX_CLAIM))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
