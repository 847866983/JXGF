import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** 内置技能文件读取（forest-laoli-h3） */

const SKILL_ID = 'forest-laoli-h3'

export interface SkillRef {
  name: string
  file: string
  size: number
}

export function skillRootOf(skillsRoot: string): string {
  return path.join(skillsRoot, SKILL_ID)
}

export async function readSkillMain(skillsRoot: string): Promise<string> {
  try {
    return await fsp.readFile(path.join(skillRootOf(skillsRoot), 'SKILL.md'), 'utf8')
  } catch {
    return ''
  }
}

export async function listSkillRefs(skillsRoot: string): Promise<SkillRef[]> {
  const dir = path.join(skillRootOf(skillsRoot), 'references')
  try {
    const files = await fsp.readdir(dir)
    const out: SkillRef[] = []
    for (const f of files) {
      if (!f.endsWith('.md')) continue
      try {
        const st = await fsp.stat(path.join(dir, f))
        out.push({ name: f.replace(/\.md$/, ''), file: `references/${f}`, size: st.size })
      } catch {
        // skip
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export async function readSkillRef(skillsRoot: string, name: string): Promise<string> {
  const safe = String(name ?? '').replace(/[^a-zA-Z0-9_\-]/g, '')
  if (!safe) return ''
  try {
    return await fsp.readFile(path.join(skillRootOf(skillsRoot), 'references', `${safe}.md`), 'utf8')
  } catch {
    return ''
  }
}

/** 找到 h3_lint.py（若随包存在） */
export function lintScriptPath(skillsRoot: string): string {
  return path.join(skillRootOf(skillsRoot), 'scripts', 'h3_lint.py')
}

export function hasLintScript(skillsRoot: string): boolean {
  return fs.existsSync(lintScriptPath(skillsRoot))
}
