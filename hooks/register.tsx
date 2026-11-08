import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Task, Touched } from '../types'

// Shen's desk, one mod:
// right pane: vault tasks with due dates + session board (both fold)
// token in/out beside the model in the prompt footer
// vault guard   closeout nudge + /closeout

const VAULT = "/Users/henghanshen/Documents/Shen's Vault"
const PANE = 'desk-board'
const STALE_MS = 12 * 60 * 60 * 1000
const TASK_ROOTS = ['03_Personal-Wing', '04_Lark-Automation-Business-Wing']
const TASK_SCAN_MS = 2 * 60 * 1000

const tokens = atom({ plugin: 'shen-desk', key: 'tokens' } as const, { input: 0, output: 0 }, { shape: 'tokens-2' })
const touched = atom({ plugin: 'shen-desk', key: 'touched' } as const, {}, { shape: 'touched-1' })
const tick = atom({ plugin: 'shen-desk', key: 'tick' } as const, 0)
const isTasksOpen = atom({ plugin: 'shen-desk', key: 'isTasksOpen' } as const, true)
const isSessionsOpen = atom({ plugin: 'shen-desk', key: 'isSessionsOpen' } as const, true)

type Row = { id: string; label: string; state: 'working' | 'waiting'; since: number }

// ---------- small helpers ----------

const fmt = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

const ago = (ms: number): string => {
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'now'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h`
}

const deskDir = async ($: EngineInterface): Promise<string> =>
  `${(await $.env.get('HOME')) ?? ''}/.claude/shen-desk`

// A project folder is the deepest folder above the file, under Personal-Projects/
// or a lane of 02_Work/, that holds its own Journal or Brief note.
async function projectOf($: EngineInterface, path: string): Promise<{ dir: string; name: string } | null> {
  const root = path.match(/^(.*\/(?:Personal-Projects|02_Work\/[^/]+))\//)?.[1]
  if (!root) return null
  const parts = path.slice(root.length + 1).split('/').slice(0, -1)
  for (let i = parts.length; i > 0; i--) {
    const dir = `${root}/${parts.slice(0, i).join('/')}`
    try {
      const names = (await $.fs.list(dir)).map(f => f.name)
      if (names.some(n => n.endsWith('-Journal.md') || /^_.*-Brief\.md$/.test(n))) {
        return { dir, name: parts[i - 1] ?? dir }
      }
    } catch {
      // folder not there yet
    }
  }
  return null
}

// ---------- session file (what the board reads) ----------

let firstPrompt = ''
let state: Row['state'] = 'waiting'
let since = 0

const writeRow = async ($: EngineInterface): Promise<void> => {
  try {
    const dir = await deskDir($)
    const id = await $.session.id()
    const cwd = await $.session.cwd()
    const label = firstPrompt || cwd.split('/').pop() || id.slice(0, 8)
    const row: Row = { id, label: label.slice(0, 40), state, since }
    await $.fs.write(`${dir}/sessions/${id}.json`, JSON.stringify(row))
  } catch {
    // the board is a convenience; never break a turn over it
  }
}

const readRows = async ($: EngineInterface): Promise<Row[]> => {
  const dir = `${await deskDir($)}/sessions`
  const now = await $.clock.now()
  try {
    const entries = await $.fs.list(dir)
    const rows: Row[] = []
    for (const one of entries) {
      if (one.kind !== 'file' || !one.name.endsWith('.json')) continue
      try {
        const row = JSON.parse(await $.fs.read(`${dir}/${one.name}`)) as Row
        if (now - row.since < STALE_MS) rows.push(row)
      } catch {
        // a half-written file: skip it this round
      }
    }
    return rows.sort((a, b) => (a.state === b.state ? b.since - a.since : a.state === 'waiting' ? -1 : 1))
  } catch {
    return []
  }
}

// ---------- vault tasks (read only) ----------

let taskCache: Task[] = []
let taskScannedAt = 0

const field = (text: string, key: string): string =>
  text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() ?? ''

async function scanTasks($: EngineInterface): Promise<Task[]> {
  const found: Task[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    let entries
    try {
      entries = await $.fs.list(dir)
    } catch {
      return
    }
    const isTasks = dir.endsWith('/Tasks')
    for (const one of entries) {
      if (one.name.startsWith('.') || one.name === '98_Archive') continue
      const path = `${dir}/${one.name}`
      if (one.kind === 'dir') {
        await walk(path, depth + 1)
      } else if (isTasks && one.name.endsWith('.md') && !one.name.startsWith('_')) {
        try {
          const head = (await $.fs.read(path)).slice(0, 800)
          const status = field(head, 'status')
          if (status === 'done' || status === 'dropped' || status === 'cancelled') continue
          const due = field(head, 'due').match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? ''
          const project = dir.split('/').slice(-2, -1)[0] ?? ''
          found.push({ title: one.name.replace(/\.md$/, '').replace(/-/g, ' '), due, status, project })
        } catch {
          // unreadable note: skip it
        }
      }
    }
  }
  for (const root of TASK_ROOTS) await walk(`${VAULT}/${root}`, 0)
  return found.sort((a, b) => (a.due && b.due ? a.due.localeCompare(b.due) : a.due ? -1 : b.due ? 1 : a.title.localeCompare(b.title)))
}

async function tasksNow($: EngineInterface): Promise<Task[]> {
  const now = await $.clock.now()
  if (now - taskScannedAt > TASK_SCAN_MS) {
    taskScannedAt = now
    taskCache = await scanTasks($)
  }
  return taskCache
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------- the guard ----------

const GIT_SWITCH = /\bgit\s+(?:-C\s+\S+\s+)?(?:checkout|switch)\b/
const isMainVault = (dir: string): boolean => dir.replace(/\/$/, '') === VAULT

const guardBash = async ($: EngineInterface, command: string): Promise<string | null> => {
  if (!GIT_SWITCH.test(command)) return null
  if (/\bgit\s+checkout\s+(?:\S+\s+)?--\s/.test(command)) return null // restoring files, not switching
  const cwd = await $.session.cwd()
  const namesMain = command.includes(VAULT) && !command.includes(`${VAULT}/.claude/worktrees`)
  if (isMainVault(cwd) || namesMain) {
    return '门卫：vault 主文件夹永远在 main，不能切分支。要分支请用 git worktree。'
  }
  return null
}

let methodologyUnlockedUntil = 0

const guardWrite = async ($: EngineInterface, path: string, text: string): Promise<string | null> => {
  if (!path.includes("Shen's Vault/")) return null
  if (path.includes('/04_Methodology/') && (await $.clock.now()) > methodologyUnlockedUntil) {
    return '门卫：04_Methodology 只有 Shen 点头才能写。先给他看，他同意后让他打 /desk-unlock（10 分钟内有效）。'
  }
  if (path.endsWith('.md') && (/—/.test(text) || / -- /.test(text))) {
    return '门卫：vault 笔记不用破折号或双横线。请改用逗号、冒号、句号或括号，重写这一句。'
  }
  return null
}

// ---------- writes: guard first, then remember the project ----------

async function onWrite($: EngineInterface, path: string, text: string, run: () => Promise<unknown>) {
  const deny = await guardWrite($, path, text)
  if (deny) return { deny }
  const ran = await run()
  const p = await projectOf($, path)
  if (p) try {
    const isJournal = path.endsWith('-Journal.md')
    await update($, touched, cur => {
      const was = cur[p.dir] ?? { name: p.name, hasJournal: false, isNudged: false }
      return { ...cur, [p.dir]: { ...was, hasJournal: was.hasJournal || isJournal } }
    })
  } catch {
    // bookkeeping only
  }
  return ran
}


// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    since = await $.clock.now()
    // a reload runs this again: keep what the board already said about us
    try {
      const was = JSON.parse(await $.fs.read(`${await deskDir($)}/sessions/${await $.session.id()}.json`)) as Row
      if (was.since > 0) {
        state = was.state
        since = was.since
      }
    } catch {
      // first start
    }
    await $.command.register({ name: 'desk', description: '打开或关上右边的 session 看板' })
    await $.command.register({ name: 'closeout', description: '收工：写 journal、更新 brief 和 session-state，然后 commit' })
    await $.command.register({ name: 'desk-unlock', description: '允许 Claude 写 04_Methodology 10 分钟（你点头之后才用）' })
    await $.tool.register({
      name: 'desk_check',
      description: 'Read-only self check of the shen-desk mod: open panes, tokens, usage, tasks, board rows.',
      inputSchema: { type: 'object', properties: {} },
    })
    $.clock.every(20_000, () => {
      void update($, tick, n => n + 1)
    })
    await writeRow($)
    if (e.isInteractive) void $.ui.open({ id: PANE, title: 'Desk' })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      await $.fs.write(`${await deskDir($)}/sessions/${await $.session.id()}.json`, JSON.stringify({ id: 'gone', label: '', state: 'waiting', since: 0 }))
    } catch {
      // nothing to clean
    }
    return next(e)
  })

  // ----- working / waiting -----
  on('prompt.submit', async ($, e, next) => {
    if (!firstPrompt && e.text && !/^\s*[/<]/.test(e.text)) firstPrompt = e.text.replace(/\s+/g, ' ').slice(0, 30)
    state = 'working'
    since = await $.clock.now()
    await writeRow($)
    return next(e)
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    // 4: a turn's usage is its responses summed (subagents' turns count too)
    const u = e.usage
    if (u) {
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      await update($, tokens, cur => ({ input: cur.input + input, output: cur.output + (u.output_tokens ?? 0) }))
    }
    if (e.agentId !== undefined) return done
    state = 'waiting'
    since = await $.clock.now()
    await writeRow($)
    // 5: closeout nudge, once per project
    const t = await read($, touched)
    const missing = Object.entries(t).filter(([, p]) => !p.hasJournal && !p.isNudged)
    if (missing.length > 0) {
      $.ui.toast(`你改了 ${missing.map(([, p]) => p.name).join('、')}，journal 还没写`)
      await update($, touched, cur => {
        const copy = { ...cur }
        for (const [dir, one] of missing) copy[dir] = { ...one, isNudged: true }
        return copy
      })
    }
    return done
  })

  // ----- 3: guard, and 5: track touched projects -----
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const deny = await guardBash($, e.command)
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Write' }, ($, e, next) => onWrite($, e.file_path, e.content, () => next(e)) as never).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, ($, e, next) => onWrite($, e.file_path, e.new_string, () => next(e)) as never).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__shen-desk__desk_check' }, async $ => {
    const report = {
      panes: await $.ui.panes(),
      tokens: await read($, tokens),
      touched: await read($, touched),
      usage: await $.session.usage(),
      tasks: await tasksNow($),
      rows: await readRows($),
    }
    return { result: JSON.stringify(report, null, 1) }
  })

  on('command.run', { command: 'desk' }, async $ => {
    const panes = await $.ui.panes()
    if (panes.some(p => p.id === PANE)) {
      await $.ui.close({ id: PANE })
      return { text: '看板关了。再打 /desk 打开。' }
    }
    await $.ui.open({ id: PANE, title: 'Desk' })
    return { text: '看板开了。' }
  })

  on('command.run', { command: 'desk-unlock' }, async $ => {
    methodologyUnlockedUntil = (await $.clock.now()) + 10 * 60 * 1000
    return { text: '04_Methodology 开放 10 分钟。' }
  })

  on('command.run', { command: 'closeout' }, async $ => {
    const t = await read($, touched)
    const names = Object.values(t).map(p => p.name)
    await $.prompt.submit({
      text:
        `收工。按 vault 规矩走完这个 session 的收尾：` +
        `${names.length ? `碰过的项目是 ${names.join('、')}，` : ''}` +
        '给每个碰过的项目写 journal、需要的话更新 brief 的下一步，刷新 session-state，检查后 commit。只写这个 session 自己做过的事。',
    })
    return { text: '收工开始。' }
  })

  // ----- the right pane: tasks, then sessions -----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    await read($, tick)
    const tasksOpen = await read($, isTasksOpen)
    const sessionsOpen = await read($, isSessionsOpen)
    const tasks = await tasksNow($)
    const rows = await readRows($)
    const me = await $.session.id()
    const now = await $.clock.now()
    const today = Date.parse(new Date(now).toISOString().slice(0, 10))
    const dated = tasks.filter(t => t.due)
    const undated = tasks.length - dated.length

    return (
      <Box flexDirection="column" gap={1}>
        <Button key="tasks" plain onPress={() => update($, isTasksOpen, v => !v)}>
          {tasksOpen ? '▾' : '▸'} Tasks <Text dimColor>{dated.length}</Text>
        </Button>
        {tasksOpen && (
          <Box flexDirection="column">
            {dated.map(t => {
              const days = Math.round((Date.parse(t.due) - today) / 86_400_000)
              const [, mm, dd] = t.due.split('-')
              const tone = days < 0 ? 'error' : days <= 7 ? 'warning' : undefined
              return (
                <Box key={`${t.project}/${t.title}`} flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end" dimColor={t.status === 'waiting' || t.status === 'blocked'}>
                    {t.title}
                  </Text>
                  <Text tabular color={tone} dimColor={tone === undefined}>
                    {MONTHS[Number(mm) - 1]} {Number(dd)}
                    {days < 0 ? ` · ${-days}d late` : days === 0 ? ' · today' : ` · ${days}d`}
                  </Text>
                </Box>
              )
            })}
            {undated > 0 && <Text dimColor size="footnote">+{undated} with no due date</Text>}
          </Box>
        )}
        <Button key="sessions" plain onPress={() => update($, isSessionsOpen, v => !v)}>
          {sessionsOpen ? '▾' : '▸'} Sessions <Text dimColor>{rows.length}</Text>
        </Button>
        {sessionsOpen && (
          <Box flexDirection="column">
            {rows.map(r => (
              <Box key={r.id} flexDirection="row" justifyContent="space-between" gap={1}>
                <Text wrap="truncate-end" bold={r.id === me}>
                  <Text color={r.state === 'working' ? 'success' : 'warning'}>● </Text>
                  {r.label}
                </Text>
                <Text dimColor tabular>
                  {r.state === 'working' ? 'working' : 'waiting'} · {ago(now - r.since)}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // ----- token in / out beside the model in the prompt footer -----
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const tk = await read($, tokens)
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, `in ${fmt(tk.input)} · out ${fmt(tk.output)}`] } })
  })
}
