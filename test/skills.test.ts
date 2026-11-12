import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillDirs, skillInstalled } from '../src/skills.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scheduler-skills-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function addSkill(base: string, name: string): void {
  mkdirSync(join(base, name), { recursive: true });
  writeFileSync(join(base, name, 'SKILL.md'), '---\nname: x\n---\n', 'utf8');
}

describe('skillDirs', () => {
  it('lists the project skills dir, then the user config skills dir', () => {
    expect(skillDirs('/srv/fortytwo', '/home/me/.claude')).toEqual([
      join('/srv/fortytwo', '.claude', 'skills'),
      join('/home/me/.claude', 'skills'),
    ]);
  });
});

describe('skillInstalled', () => {
  it('is false when no directory has the skill', () => {
    expect(skillInstalled('learn-review', [join(dir, 'a'), join(dir, 'b')])).toBe(false);
  });

  it('is true when any directory has <name>/SKILL.md', () => {
    addSkill(join(dir, 'b'), 'learn-review');
    expect(skillInstalled('learn-review', [join(dir, 'a'), join(dir, 'b')])).toBe(true);
  });

  it('needs the SKILL.md file, not just the directory', () => {
    mkdirSync(join(dir, 'a', 'learn-review'), { recursive: true });
    expect(skillInstalled('learn-review', [join(dir, 'a')])).toBe(false);
  });
});
