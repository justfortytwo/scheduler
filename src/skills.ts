import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where Claude Code discovers file-based skills for a turn the scheduler
 * starts: the project (`<root>/.claude/skills`) and the user's Claude config
 * dir (`CLAUDE_CONFIG_DIR`, default `~/.claude`). Skills that come from
 * plugins are not visible here; triggers must stay correct without them.
 */
export function skillDirs(root: string, claudeConfigDir: string): string[] {
  return [join(root, '.claude', 'skills'), join(claudeConfigDir, 'skills')];
}

/** True when `<dir>/<name>/SKILL.md` exists in any of the given skill directories. */
export function skillInstalled(name: string, dirs: string[]): boolean {
  return dirs.some((dir) => existsSync(join(dir, name, 'SKILL.md')));
}
