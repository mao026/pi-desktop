import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mapPath } from "./paths.ts";

export type MapSection = "modules" | "flows" | "roles" | "open_questions";

const TITLES: Record<MapSection, string> = {
  modules: "模块",
  flows: "主流程",
  roles: "角色",
  open_questions: "待确认",
};

export function readMap(root: string): Record<MapSection, string> {
  const text = readFileSync(mapPath(root), "utf8");
  return Object.fromEntries(
    Object.entries(TITLES).map(([section, title]) => [section, readSection(text, title)]),
  ) as Record<MapSection, string>;
}

export function updateMapSection(root: string, section: MapSection, content: string): Record<MapSection, string> {
  if (content.length > 20_000 || /\0/.test(content) || /^#{1,2}\s/m.test(content)) {
    throw new Error("业务地图章节内容无效");
  }
  const file = mapPath(root);
  const text = readFileSync(file, "utf8");
  const title = TITLES[section];
  const heading = `## ${title}`;
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`业务地图缺少章节: ${title}`);
  const contentStart = start + heading.length;
  const next = text.indexOf("\n## ", contentStart);
  const end = next < 0 ? text.length : next;
  const replacement = `\n\n${content.trim() || "- 待补充"}\n\n`;
  const updated = `${text.slice(0, contentStart)}${replacement}${text.slice(end < text.length ? end + 1 : end)}`;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, updated, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows ACLs are controlled by the containing user directory.
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return readMap(root);
}

function readSection(text: string, title: string): string {
  const heading = `## ${title}`;
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`业务地图缺少章节: ${title}`);
  const contentStart = start + heading.length;
  const next = text.indexOf("\n## ", contentStart);
  return text.slice(contentStart, next < 0 ? text.length : next).trim();
}
