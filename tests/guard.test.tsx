import { expect, test } from 'claude-code/testing'

const VAULT = "/Users/henghanshen/Documents/Shen's Vault"

test('the guard stops a branch switch in the vault main folder only', async ($, on) => {
  let ran = 0
  on('session.cwd', () => ({ value: VAULT }))
  on('tool.call', () => {
    ran += 1
    return { result: {} }
  })

  const blocked = await $.tool.call({ tool: 'Bash', command: 'git switch codex/x' })
  expect(ran).toBe(0)

  await $.tool.call({ tool: 'Bash', command: 'git checkout -- notes.md' })
  await $.tool.call({ tool: 'Bash', command: 'git status' })
  expect(ran).toBe(2)
})

test('the guard lets a worktree switch branch', async ($, on) => {
  let ran = 0
  on('session.cwd', () => ({ value: `${VAULT}/.claude/worktrees/abc` }))
  on('tool.call', () => {
    ran += 1
    return { result: {} }
  })
  await $.tool.call({ tool: 'Bash', command: 'git switch -c feature' })
  expect(ran).toBe(1)
})

test('the guard stops Methodology writes and dashes in vault notes', async ($, on) => {
  let ran = 0
  on('clock.now', () => ({ value: 1_000 }))
  on('fs.list', () => ({ value: [] }))
  on('tool.call', () => {
    ran += 1
    return { result: {} }
  })
  const m = await $.tool.call({ tool: 'Write', file_path: `${VAULT}/04_Methodology/Lessons/x.md`, content: 'hi' })
  expect(ran).toBe(0)
  const d = await $.tool.call({ tool: 'Write', file_path: `${VAULT}/00_Inbox/x.md`, content: 'a — b' })
  expect(ran).toBe(0)
  await $.tool.call({ tool: 'Write', file_path: `${VAULT}/00_Inbox/x.md`, content: '---\ntitle: ok\n---\nfine, clean' })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/other.md', content: 'a — b' })
  expect(ran).toBe(2)
})
