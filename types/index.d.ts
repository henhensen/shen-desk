export type Tokens = { input: number; output: number }
export type Touched = Record<string, { name: string; hasJournal: boolean; isNudged: boolean }>
export type Task = { title: string; due: string; status: string; project: string }

declare module 'claude-code' {
  interface PluginState {
    'shen-desk': {
      tokens: Shaped<Tokens>
      touched: Shaped<Touched>
      tick: number
      isTasksOpen: boolean
      isSessionsOpen: boolean
    }
  }
}
