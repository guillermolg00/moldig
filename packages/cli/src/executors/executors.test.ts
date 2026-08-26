import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  backup,
  createDeviceProbe,
  createTrash,
  spawnDelegate,
  statPath,
  writeAtomic,
} from "./index.js";

let tree: string;

beforeEach(async () => {
  tree = await mkdtemp(join(tmpdir(), "moldig-executors-"));
});

afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
});

describe("the filesystem executors", () => {
  it("writes atomically: a temp file in the same directory, the original's mode, then a rename", async () => {
    const file = join(tree, "settings.json");
    await writeFile(file, "{}\n");
    await chmod(file, 0o600);
    await writeAtomic(file, '{"kept": true}\n');
    expect(await readFile(file, "utf8")).toBe('{"kept": true}\n');
    // Windows has no POSIX permission bits: `chmod` there toggles the read-only flag alone and
    // the mode always reads back 0o666, so the mode is only asserted where it means something.
    const mode = process.platform === "win32" ? 0o600 : (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readdir(tree)).toEqual(["settings.json"]);
  });

  it("leaves nothing behind when the write cannot land", async () => {
    await expect(writeAtomic(join(tree, "missing/dir/file.json"), "{}")).rejects.toThrow(/ENOENT/u);
    expect(await readdir(tree)).toEqual([]);
  });

  it("copies a file and a whole directory into the run's backup directory", async () => {
    await mkdir(join(tree, "skill/nested"), { recursive: true });
    await writeFile(join(tree, "skill/SKILL.md"), "# skill\n");
    await writeFile(join(tree, "skill/nested/reference.md"), "reference\n");
    await writeFile(join(tree, "lock.json"), '{"skills": {}}\n');

    await backup(join(tree, "lock.json"), join(tree, "backups/run/%2Flock.json"));
    await backup(join(tree, "skill"), join(tree, "backups/run/%2Fskill"));
    expect(await readFile(join(tree, "backups/run/%2Flock.json"), "utf8")).toBe('{"skills": {}}\n');
    expect(await readFile(join(tree, "backups/run/%2Fskill/nested/reference.md"), "utf8")).toBe(
      "reference\n",
    );
  });

  it("stats a link where it sits, never where it points (D96)", async () => {
    await symlink(join(tree, "nowhere"), join(tree, "dangling"));
    expect(await statPath(join(tree, "dangling"))).toMatchObject({ exists: true });
    expect(await statPath(join(tree, "nowhere"))).toMatchObject({ exists: false });
  });
});

describe("the trash executor", () => {
  it("hands the helper only the paths that are there, and reports what stayed", async () => {
    const here = join(tree, "here.txt");
    await writeFile(here, "x");
    const calls: string[][] = [];
    const trash = createTrash(async (paths) => {
      calls.push(paths);
      await rm(paths[0] ?? "", { force: true });
    });
    const result = await trash([here, join(tree, "gone.txt")]);
    expect(calls).toEqual([[here]]);
    expect(result).toEqual({ moved: [here], left: [], error: null });
  });

  it("a path still in place after the call is left, whatever the helper said", async () => {
    const stubborn = join(tree, "stubborn.txt");
    await writeFile(stubborn, "x");
    const trash = createTrash(() => Promise.resolve());
    const result = await trash([stubborn]);
    expect(result.moved).toEqual([]);
    expect(result.left).toEqual([stubborn]);
    expect(result.error).toBe("the trash left files behind");
  });

  it("a rejected call whose paths are all gone still counts as moved (08 §3)", async () => {
    const file = join(tree, "moved.txt");
    await writeFile(file, "x");
    const trash = createTrash(async (paths) => {
      await rm(paths[0] ?? "", { force: true });
      throw new Error("the helper exited 5");
    });
    expect(await trash([file])).toEqual({ moved: [file], left: [], error: null });
  });

  it("nothing to move is not a call", async () => {
    let called = false;
    const trash = createTrash(() => {
      called = true;
      return Promise.resolve();
    });
    expect(await trash([join(tree, "absent")])).toEqual({ moved: [], left: [], error: null });
    expect(called).toBe(false);
  });
});

describe("the delegate executor", () => {
  it("runs argv without a shell: metacharacters are arguments, not syntax", async () => {
    const result = await spawnDelegate({
      argv: [
        process.execPath,
        "-e",
        "process.stderr.write(process.argv[1] ?? '')",
        "&& echo hacked > /tmp/pwned",
      ],
      cwd: tree,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("&& echo hacked > /tmp/pwned");
    expect(existsSync("/tmp/pwned")).toBe(false);
  });

  it("carries the exit code back", async () => {
    const result = await spawnDelegate({
      argv: [process.execPath, "-e", "process.stderr.write('boom'); process.exit(3)"],
      cwd: null,
    });
    expect(result).toEqual({ exitCode: 3, stderr: "boom" });
  });

  it("a binary missing from PATH is a failed row, never a crash", async () => {
    const result = await spawnDelegate({ argv: ["moldig-no-such-binary"], cwd: null });
    expect(result).toEqual({ exitCode: null, stderr: "command not found: moldig-no-such-binary" });
  });
});

describe("the volume probe", () => {
  it("classifies the home volume local and anything it cannot stat unknown", () => {
    const deviceOf = createDeviceProbe({ home: tree, platform: process.platform });
    expect(deviceOf(tree).kind).toBe("local");
    expect(deviceOf(join(tree, "nowhere"))).toEqual({ dev: -1, kind: "unknown" });
  });

  it("a UNC path is a network volume on sight (win32)", () => {
    const deviceOf = createDeviceProbe({ home: tree, platform: "win32" });
    expect(deviceOf(tree).kind).toBe("local");
    expect(deviceOf("\\\\server\\share\\.claude").kind).toBe("network");
  });
});
