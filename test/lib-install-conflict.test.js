/**
 * 安装前同名技能探测（docs/SPEC.md R6.1-I3）。
 *
 * 只读探测：`.claude/skills`、`.agents/skills`、OpenCode 配置目录与 `skills.paths`；
 * `OPENCODE_DISABLE_EXTERNAL_SKILLS` / `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` 必须真实生效。
 * 全部路径都在 `os.tmpdir()` 下，不读也不写真实用户目录。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";

import { runCommand } from "../dist/cli/dispatch.js";
import { parseArgs } from "../dist/cli/parse-args.js";
import {
  detectSkillConflicts,
  hasActiveSkillConflict,
  SKILL_NAME,
} from "../dist/lib/skill-install.js";

/** 统一成 `/` 分隔。 */
const toDisplay = (path) => path.replaceAll("\\", "/");

/**
 * 在临时根里执行用例，结束后递归删除。
 *
 * @param {(root: string) => unknown} fn 用例体
 * @returns 用例体返回值
 */
function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "skill-creator-conflict-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  try {
    return fn(root);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 造一份同名技能（含 SKILL.md）。
 *
 * @param dir 技能目录
 * @param content SKILL.md 内容
 */
function writeSameNameSkill(dir, content) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), content);
}

/**
 * 递归列出目录里的文件与其 sha256（用于断言「探测目录未被改写」）。
 *
 * @param root 根目录
 * @returns 相对路径 → sha256
 */
function snapshotHashes(root) {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) {
        out[relative(root, abs).split(sep).join("/")] = createHash("sha256")
          .update(readFileSync(abs))
          .digest("hex");
      }
    }
  };
  walk(root);
  return out;
}

test("用户级 ~/.claude/skills 同名技能命中且当前生效", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    writeSameNameSkill(join(home, ".claude", "skills", SKILL_NAME), "claude\n");

    const conflicts = detectSkillConflicts({ name: SKILL_NAME, homeDir: home, env: {} });

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].source, "claude");
    assert.equal(conflicts[0].enabled, true);
    assert.equal(conflicts[0].effective, true);
  });
});

test("用户级 ~/.agents/skills 同名技能命中", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    writeSameNameSkill(join(home, ".agents", "skills", SKILL_NAME), "agents\n");

    const conflicts = detectSkillConflicts({ name: SKILL_NAME, homeDir: home, env: {} });

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].source, "agents");
    assert.equal(conflicts[0].effective, true);
  });
});

test("项目级 .opencode/skills 同名技能命中；三处同存时最后扫描的项目级生效", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const project = join(root, "project");
    writeSameNameSkill(join(home, ".claude", "skills", SKILL_NAME), "claude\n");
    writeSameNameSkill(join(home, ".agents", "skills", SKILL_NAME), "agents\n");
    writeSameNameSkill(join(project, ".opencode", "skills", SKILL_NAME), "project\n");

    const conflicts = detectSkillConflicts({ name: SKILL_NAME, homeDir: home, projectDir: project, env: {} });

    assert.deepEqual(
      conflicts.map((item) => item.source),
      ["claude", "agents", "project-opencode"],
    );
    assert.equal(conflicts.filter((item) => item.effective).length, 1);
    assert.equal(conflicts.at(-1).effective, true);
  });
});

test("OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 只关闭 .claude，.agents 仍生效", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    writeSameNameSkill(join(home, ".claude", "skills", SKILL_NAME), "claude\n");
    writeSameNameSkill(join(home, ".agents", "skills", SKILL_NAME), "agents\n");

    const conflicts = detectSkillConflicts({
      name: SKILL_NAME,
      homeDir: home,
      env: { OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" },
    });

    assert.equal(conflicts.find((item) => item.source === "claude").enabled, false);
    assert.equal(conflicts.find((item) => item.source === "agents").enabled, true);
    assert.equal(conflicts.find((item) => item.source === "agents").effective, true);
  });
});

test("OPENCODE_DISABLE_CLAUDE_CODE=1 同样关闭 .claude", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    writeSameNameSkill(join(home, ".claude", "skills", SKILL_NAME), "claude\n");

    const conflicts = detectSkillConflicts({
      name: SKILL_NAME,
      homeDir: home,
      env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" },
    });

    assert.equal(conflicts[0].enabled, false);
    assert.equal(hasActiveSkillConflict(conflicts), false);
  });
});

test("OPENCODE_DISABLE_EXTERNAL_SKILLS=1 时 .claude / .agents 全部不算冲突", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    writeSameNameSkill(join(home, ".claude", "skills", SKILL_NAME), "claude\n");
    writeSameNameSkill(join(home, ".agents", "skills", SKILL_NAME), "agents\n");

    const conflicts = detectSkillConflicts({
      name: SKILL_NAME,
      homeDir: home,
      env: { OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" },
    });

    assert.equal(conflicts.length, 2);
    assert.ok(conflicts.every((item) => item.enabled === false));
    assert.equal(hasActiveSkillConflict(conflicts), false);
  });
});

test("install 输出点名冲突路径，且探测目录的文件集合与哈希不变", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const project = join(root, "project");
    const skillsRoot = join(root, "skills");
    const sourceDir = join(root, "bundle");
    const claudeSkill = join(home, ".claude", "skills", SKILL_NAME);
    const projectSkill = join(project, ".opencode", "skills", SKILL_NAME);

    writeSameNameSkill(claudeSkill, "claude\n");
    writeSameNameSkill(projectSkill, "project\n");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(
      join(sourceDir, "SKILL.md"),
      ["---", `name: ${SKILL_NAME}`, "description: 冲突探测测试", "---", "", "# T", ""].join("\n"),
    );

    const before = { ...snapshotHashes(claudeSkill), ...snapshotHashes(projectSkill) };
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const previousSource = process.env.SKILL_ZH_SKILL_SOURCE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.SKILL_ZH_SKILL_SOURCE = sourceDir;

    try {
      const result = runCommand(
        parseArgs(`install --dir "${toDisplay(skillsRoot)}"`),
        { directory: project, worktree: project },
      );
      assert.equal(result.ok, true, result.output);
      assert.ok(result.output.includes(toDisplay(claudeSkill)), result.output);
      assert.ok(result.output.includes(toDisplay(projectSkill)), result.output);
      assert.ok(result.output.includes("当前生效"));
      for (const action of [
        "SKILL.md.disabled",
        "移出任何 skills/ 路径",
        "frontmatter name",
        "permission deny",
        "OPENCODE_DISABLE_EXTERNAL_SKILLS=1",
      ]) {
        assert.ok(result.output.includes(action), `提示缺少生效的处置动作：${action}`);
      }
      assert.ok(!result.output.includes("重命名目录即"));
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      if (previousSource === undefined) delete process.env.SKILL_ZH_SKILL_SOURCE;
      else process.env.SKILL_ZH_SKILL_SOURCE = previousSource;
    }

    assert.deepEqual({ ...snapshotHashes(claudeSkill), ...snapshotHashes(projectSkill) }, before);
    assert.ok(existsSync(join(skillsRoot, SKILL_NAME, "SKILL.md")));
  });
});

test("skills 任意层级 + frontmatter name 也能命中（不只目录名）", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const nested = join(home, ".claude", "skills", "group", "deep", "different-dir");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "SKILL.md"),
      ["---", `name: ${SKILL_NAME}`, "description: 嵌套同名技能", "---", "", "# T", ""].join("\n"),
    );

    const conflicts = detectSkillConflicts({ name: SKILL_NAME, homeDir: home, env: {} });

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, nested);
    assert.equal(conflicts[0].source, "claude");
  });
});

test("项目目录按 directory → worktree 逐层探测", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const project = join(root, "proj");
    const directory = join(project, "sub");
    writeSameNameSkill(join(project, ".claude", "skills", SKILL_NAME), "project\n");
    mkdirSync(directory, { recursive: true });

    const conflicts = detectSkillConflicts({
      name: SKILL_NAME,
      homeDir: home,
      projectDirs: [directory, project],
      env: {},
    });

    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].path, join(project, ".claude", "skills", SKILL_NAME));
  });
});

test("生效顺序为外部 → config → skills.paths，paths 最后覆盖", () => {
  withTempRoot((root) => {
    const home = join(root, "home");
    const project = join(root, "proj");
    const custom = join(root, "custom-skills");
    writeSameNameSkill(join(home, ".claude", "skills", SKILL_NAME), "claude\n");
    writeSameNameSkill(join(project, ".opencode", "skills", SKILL_NAME), "config\n");
    writeSameNameSkill(join(custom, SKILL_NAME), "paths\n");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "opencode.json"),
      JSON.stringify({ skills: { paths: [custom] } }),
    );

    const conflicts = detectSkillConflicts({
      name: SKILL_NAME,
      homeDir: home,
      projectDirs: [project],
      env: {},
    });

    assert.deepEqual(
      conflicts.map((item) => item.source),
      ["claude", "project-opencode", "skills.paths"],
    );
    assert.equal(conflicts.at(-1).source, "skills.paths");
    assert.equal(conflicts.filter((item) => item.effective).length, 1);
    assert.equal(conflicts.at(-1).effective, true);
  });
});
