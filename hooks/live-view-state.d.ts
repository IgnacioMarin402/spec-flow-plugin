export type LiveTokens = { in: number; cacheRead: number; cacheWrite: number; out: number }

export type LiveAgent = {
  agentId: string
  role: string
  // the agent that spawned it ('' for the orchestrator): the architect runs inside the implementer
  parentId: string
  milestone: string
  model: string
  effort: string
  startedAt: number
  // when its current run began: the spawn, or its first request after a SendMessage resumed it
  turnAt: number
  // wall time of its finished runs
  activeMs: number
  // null while it runs
  endedAt: number | null
  // the STATUS: its report handed back; '' while it runs
  status: string
  resumes: number
  steps: number
  calls: number
  byTool: Record<string, number>
  // the advisor consultations its requests made, and the time they took
  advisor: number
  advisorMs: number
  lastTool: string
  // the last request's prompt: what the agent carries now
  ctx: number
  tokens: LiveTokens
}

// The orchestrator's turns that ended inside this session's run, plus what it is doing now.
export type LiveOrchestrator = {
  steps: number
  calls: number
  byTool: Record<string, number>
  advisor: number
  advisorMs: number
  lastTool: string
  lastAt: number
  ctx: number
  model: string
  effort: string
  tokens: LiveTokens
}

// The orchestrator's current turn, charged or dropped when it ends.
export type LiveTurn = { steps: number; tokens: LiveTokens; advisor: number; advisorMs: number }

// What .claude/state/ said at the last poll, as this session's run.
export type LiveRun = {
  phase: string
  milestone: string
  gate: string
  gateAt: number
  attempts: number
  // what the session has cost, as /cost totals it; null where the host keeps no ledger
  usd: number | null
  // the checks the last gate line records as failed: `lint`, `test`, an unscoped check's field
  failed: string[]
  // planner and architect calls this run, against the cap opus-budget denies at
  budgets: { role: string; used: number; cap: number }[]
  // the checks whose own log says they stood down during this run
  stoodDown: string[]
  // by agent id: the agent gate's send-backs, the last one's reasons, and whether it then let the return through
  sentBack: Record<string, { n: number; why: string; cap: boolean }>
  // a log that is there and could not be read, and what that leaves unshown
  unread: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'spec-flow': {
      liveAgents: LiveAgent[]
      liveOrchestrator: LiveOrchestrator
      liveTurn: LiveTurn
      liveRun: Shaped<LiveRun>
      liveClock: number
    }
  }
}
