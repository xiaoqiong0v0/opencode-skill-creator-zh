/**
 * 金标准（gold standard）示例库：把高分技能描述沉淀成可复用的改写范例。
 *
 * 存储是一个 JSON 文件，最多保留 50 条，按通过率降序排列。
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** 新增金标准时需要提供的字段。 */
export interface GoldStandardInput {
  skillName: string;
  description: string;
  passRate: number;
  notes?: string;
}

/** 落盘后的金标准：输入字段加上生成的 id 与创建时间。 */
export interface GoldStandard extends GoldStandardInput {
  id: string;
  createdAt: string;
}

/** 存储记录里必须是字符串的必填字段（`passRate` 单独判数值，`notes` 可选）。 */
const REQUIRED_STRING_FIELDS = ["id", "createdAt", "skillName", "description"] as const;

/**
 * 读取存储文件。
 *
 * `JSON.parse` 之后必须做运行时结构校验：存储被外部改坏成 `{}` / `null` / 非数组时，
 * 只在解析处带路径报错；否则错误会漂到 `sortStandards` 的展开处，变成与文件无关的
 * `TypeError`，用户无从定位是哪份存储坏了。
 *
 * @param path 存储文件路径
 * @returns 文件里的金标准数组；文件不存在时返回空数组
 * @throws 存储不是合法 JSON、不是数组，或某条记录缺必需字段时，抛出带存储路径的错误
 */
function readStore(path: string): GoldStandard[] {
  if (!existsSync(path)) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Failed to read gold standards store at ${path}: malformed JSON`,
      );
    }
    throw error;
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Failed to read gold standards store at ${path}: expected a JSON array, got ${parsed === null ? "null" : typeof parsed}`,
    );
  }

  // 逐条校验必需字段：坏记录同样要带路径与下标，不能留到排序 / 渲染时再炸。
  parsed.forEach((entry, index) => {
    const record = (
      typeof entry === "object" && entry !== null ? entry : {}
    ) as Record<string, unknown>;
    const hasRequiredStrings = REQUIRED_STRING_FIELDS.every(
      (field) => typeof record[field] === "string",
    );
    const hasValidPassRate =
      typeof record["passRate"] === "number" && Number.isFinite(record["passRate"]);
    const hasValidNotes =
      record["notes"] === undefined || typeof record["notes"] === "string";

    if (
      Array.isArray(entry) ||
      !hasRequiredStrings ||
      !hasValidPassRate ||
      !hasValidNotes
    ) {
      throw new Error(
        `Failed to read gold standards store at ${path}: invalid record at index ${index} (expected string id, createdAt, skillName, description and a finite numeric passRate)`,
      );
    }
  });

  return parsed as GoldStandard[];
}

/**
 * 按通过率降序排序（不改原数组）。
 *
 * @param standards 金标准数组
 * @returns 排序后的新数组
 */
function sortStandards(standards: GoldStandard[]): GoldStandard[] {
  return [...standards].sort((a, b) => b.passRate - a.passRate);
}

/**
 * 原子写入存储文件。
 *
 * 先写同目录下的临时文件再 `rename`，避免进程中途退出留下半个 JSON。
 *
 * @param path 存储文件路径
 * @param standards 待写入的金标准数组（写入前排序并截断到 50 条）
 */
function writeStore(path: string, standards: GoldStandard[]): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(sortStandards(standards).slice(0, 50), null, 2));
  renameSync(tmpPath, path);
}

/**
 * 列出全部金标准。
 *
 * @param path 存储文件路径
 * @returns 按通过率降序排列的金标准数组
 */
export function listGoldStandards(path: string): GoldStandard[] {
  return sortStandards(readStore(path));
}

/**
 * 新增一条金标准并落盘。
 *
 * @param path 存储文件路径
 * @param input 技能名、描述、通过率与可选备注
 * @returns 落盘的完整记录（含生成的 `id` 与 `createdAt`）
 * @throws `passRate` 不是 0~1 之间的有限数时抛错
 */
export function addGoldStandard(
  path: string,
  input: GoldStandardInput,
): GoldStandard {
  if (
    !Number.isFinite(input.passRate) ||
    input.passRate < 0 ||
    input.passRate > 1
  ) {
    throw new Error("passRate must be a finite number between 0 and 1");
  }

  const standard: GoldStandard = {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  writeStore(path, [...readStore(path), standard]);
  return standard;
}

/**
 * 按 id 删除一条金标准。
 *
 * @param path 存储文件路径
 * @param id 要删除的记录 id
 * @returns 真的删掉了返回 `true`；id 不存在时返回 `false` 且不改动文件
 */
export function removeGoldStandard(path: string, id: string): boolean {
  const standards = readStore(path);
  const remaining = standards.filter((standard) => standard.id !== id);
  if (remaining.length === standards.length) return false;

  writeStore(path, remaining);
  return true;
}

/**
 * 生成给模型看的金标准示例提示（最多 5 条）。
 *
 * @param path 存储文件路径
 * @returns 多行提示文本；没有任何金标准时返回空串
 */
export function getGoldAdvice(path: string): string {
  const standards = listGoldStandards(path).slice(0, 5);
  if (standards.length === 0) return "";

  const examples = standards.map((standard) => {
    const percent = Math.round(standard.passRate * 100);
    const notes = standard.notes ? ` Notes: ${standard.notes}` : "";
    return `- ${standard.skillName} (${percent}%): ${standard.description}${notes}`;
  });

  return ["GOLD STANDARD EXAMPLES:", ...examples].join("\n");
}
