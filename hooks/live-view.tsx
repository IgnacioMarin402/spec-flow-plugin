/**
 * The live view: one box per spec-flow agent, the orchestrator, the phase and
 * the last gate, in a pane and the status line (ADR-037).
 *
 * A mod, not a command hook: it runs inside Claude Code with no Node, and a
 * Claude Code without function hooks skips it while the engine runs as before.
 *
 * It shows; it never decides. Every hook hands on what `next` resolved,
 * untouched, its own bookkeeping may fail without reaching the spawn, the tool
 * call or the turn, and it writes nothing but its own `$.state`. Nothing in the
 * engine reads what it shows: `token-trace` stays the record.
 *
 * Per-agent activity comes from the session's events, joined by `agentId`.
 * Phase, milestone, gate, budgets, send-backs and the checks that stood down
 * come from `.claude/state/`, and the caps from the file `opus-budget` reads
 * them from (ADR-047). It never reads a transcript (ADR-036). The one cost in
 * dollars it shows is the session's, as Claude Code totals it: a share per
 * role would be a guess (ADR-037).
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepInput, TurnStepResult } from 'claude-code'

// The parser the agent gate and run-trace read a return with, and the gate's cap: one copy.
import { MAX_BLOCKS, parseReturn } from '../scripts/agent-blocks.mjs'
// The caps opus-budget denies at: one copy.
import { BUDGETS, budgetCap } from './lib/budgets.mjs'
import type { LiveAgent, LiveOrchestrator, LiveRun, LiveTokens, LiveTurn } from './live-view-state'

const PANE = 'spec-flow-live'
const PREFIX = 'spec-flow:'
// The phase vocabulary `hooks/lib/io.mjs` arms on.
const ARMED = ['spec', 'plan', 'review', 'implement', 'blocked']
const BAR = ['spec', 'plan', 'review', 'implement', 'done']
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const CARD = 38 // 34 columns of text, its padding and its border

const ZERO: LiveTokens = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 }
const ORCH0: LiveOrchestrator = { steps: 0, calls: 0, byTool: {}, advisor: 0, advisorMs: 0, lastTool: '', lastAt: 0, ctx: 0, model: '', effort: '', tokens: ZERO }
const TURN0: LiveTurn = { steps: 0, tokens: ZERO, advisor: 0, advisorMs: 0 }
const RUN0: LiveRun = { phase: '', milestone: '', gate: '', gateAt: 0, attempts: 0, usd: null, failed: [], budgets: [], stoodDown: [], sentBack: {}, traceUnread: false }

// The checks whose own log says they stood down, each line stamped when it did.
const STOOD_DOWN = [
  { file: 'orchestrator-scope-unmatched.log', what: 'orchestrator-scope stood down: no tool call attributed to an agent yet' },
  { file: 'human-turn-unmatched.log', what: 'the case 3 check stood down: no answer ever recorded' },
]
// The gate line's fields that are not a check.
const NOT_A_CHECK = ['cc', 'engine', 'phase', 'attempt', 'result', 'files']

const agents = atom({ plugin: 'spec-flow', key: 'liveAgents' } as const, [])
const orchestrator = atom({ plugin: 'spec-flow', key: 'liveOrchestrator' } as const, ORCH0)
const turn = atom({ plugin: 'spec-flow', key: 'liveTurn' } as const, TURN0)
const run = atom({ plugin: 'spec-flow', key: 'liveRun' } as const, RUN0)
const clock = atom({ plugin: 'spec-flow', key: 'liveClock' } as const, 0)

// ---- what the engine wrote -------------------------------------------------

async function stateText($: EngineInterface, root: string, file: string): Promise<string> {
  try {
    const text = await $.fs.read(`${root}/.claude/state/${file}`)
    return typeof text === 'string' ? text.trim() : ''
  } catch {
    return ''
  }
}

let root = ''
let session = ''
let phaseSeen = ''
let phaseTracked = false
let gateSeen = ''
let gateLine = ''
let traceSeen = ''
let stoodSeen = ''
let stood: string[] = []
let backs: LiveRun['sentBack'] = {}
let traceUnread = false

/** The checks a failing gate line names with a non-zero code: `lint`, `test`, an unscoped check's field. */
const failedChecks = (line: string): string[] =>
  /\bresult=fail:(behaviour|lint\/trace)\b/.test(line)
    ? [...line.matchAll(/ ([\w-]+)=(\S+)/g)].filter(([, k, v]) => !NOT_A_CHECK.includes(k) && v !== '0' && v !== '-').map(([, k]) => k)
    : []

/** The agent gate's send-backs per agent, from its own `agent-check` lines (ADR-031). */
function sendBacks(trace: string, ids: Set<string>): LiveRun['sentBack'] {
  const out: LiveRun['sentBack'] = {}
  for (const [, result, why, id] of trace.matchAll(/ agent-check agent=\S+ result=(block|cap) why=(\S+) agent_id=([\w-]+)$/gm)) {
    if (!ids.has(id)) continue
    const was = out[id] ?? { n: 0, why: '', cap: false }
    out[id] = { n: was.n + (result === 'block' ? 1 : 0), why, cap: was.cap || result === 'cap' }
  }
  return out
}

async function statKey($: EngineInterface, path: string): Promise<string> {
  try {
    const st = await $.fs.stat(path)
    return `${st.size}:${st.mtimeMs}`
  } catch {
    return ''
  }
}

/**
 * This session's run, as `readOwnedPhase` reads it (ADR-017): a phase another
 * session owns, or one git tracks, is not a run here and shows as none. The
 * milestone and the gate are this run's only: the milestone an implementer
 * this session spawned wrote, and the gate lines after the run's telemetry mark.
 */
async function poll($: EngineInterface): Promise<void> {
  const before = await read($, run)
  const raw = await stateText($, root, 'phase')
  if (!raw && !before.phase) return // a repository that never ran the engine: nothing more to read

  if (raw !== phaseSeen) {
    phaseSeen = raw
    phaseTracked = false
    if (ARMED.includes(raw)) {
      try {
        const git = await $.process.run(['git', 'ls-files', '--error-unmatch', '--', '.claude/state/phase'], { cwd: root })
        phaseTracked = git.exitCode === 0
      } catch {
        /* no git to ask: the engine's own read counts the phase too */
      }
    }
  }
  const owner = ARMED.includes(raw) ? await stateText($, root, 'phase.session') : ''
  const phase = phaseTracked || (owner && session && owner !== session) ? '' : raw

  const [slug = '', mk = '', implementer = ''] = (await stateText($, root, 'current-milestone')).split(/\s+/)
  const ours = (await read($, agents)).some(a => a.agentId === implementer)

  let mark = 0
  try {
    mark = Number(JSON.parse(await stateText($, root, 'run-offset'))['gate-history.log']) || 0
  } catch {
    /* no mark: every line counts, as the snapshot reads it */
  }
  try {
    const st = await $.fs.stat(`${root}/.claude/state/gate-history.log`)
    const seen = `${st.size}:${st.mtimeMs}:${mark}`
    if (seen !== gateSeen) {
      gateSeen = seen
      gateLine = (await stateText($, root, 'gate-history.log')).split('\n').slice(mark).filter(Boolean).at(-1) ?? ''
    }
  } catch {
    gateLine = ''
  }
  const result = /\bresult=(\S+)/.exec(gateLine)?.[1] ?? ''
  let usd: number | null = null
  try {
    usd = (await $.session.usage()).cost?.usd ?? null
  } catch {
    /* no ledger to read: shown as none */
  }

  // The run starts where its telemetry mark was set; no mark, every line counts, as above.
  const offsetKey = await statKey($, `${root}/.claude/state/run-offset`)
  const stoodKeys = [offsetKey, ...(await Promise.all(STOOD_DOWN.map(d => statKey($, `${root}/.claude/state/${d.file}`))))].join('|')
  if (phase && stoodKeys !== stoodSeen) {
    stoodSeen = stoodKeys
    const startedAt = Number(offsetKey.split(':')[1]) || 0
    stood = []
    for (const d of STOOD_DOWN) {
      const n = (await stateText($, root, d.file)).split('\n').filter(l => Date.parse(l.split(' ')[0] ?? '') >= startedAt).length
      if (n > 0) stood.push(`${d.what} (${n}×)`)
    }
  }

  const traceKey = await statKey($, `${root}/.claude/state/run-trace.log`)
  const ids = (await read($, agents)).map(a => a.agentId)
  if (phase && `${traceKey}|${ids.join(',')}` !== traceSeen) {
    traceSeen = `${traceKey}|${ids.join(',')}`
    backs = {}
    traceUnread = false
    if (traceKey !== '') {
      try {
        backs = sendBacks(await $.fs.read(`${root}/.claude/state/run-trace.log`), new Set(ids))
      } catch {
        // There and unread — over what one read takes — is said, never shown as nothing sent back.
        traceUnread = true
      }
    }
  }

  // While a run can still spend them: at `done` or `idle` no spawn is charged.
  let budgets: LiveRun['budgets'] = []
  if (ARMED.includes(phase)) {
    let config = ''
    try {
      config = await $.fs.read(`${root}/.claude/spec-flow.config.json`)
    } catch {
      /* none: each cap is its default, as opus-budget reads it */
    }
    budgets = await Promise.all(
      Object.entries(BUDGETS).map(async ([role, b]) => ({ role, used: Number(await stateText($, root, b.counter)) || 0, cap: budgetCap(config, role) })),
    )
  }

  const after: LiveRun = {
    phase,
    milestone: phase && ours && mk ? `${mk} · ${slug}` : '',
    gate: phase && result ? `${result} ${gateLine.split(' ')[1] ?? ''}` : '',
    gateAt: Date.parse(gateLine.split(' ')[0] ?? '') || 0,
    attempts: phase ? Number(await stateText($, root, 'gate_attempts')) || 0 : 0,
    usd,
    failed: phase ? failedChecks(gateLine) : [],
    budgets,
    stoodDown: phase ? stood : [],
    sentBack: phase ? backs : {},
    traceUnread: phase !== '' && traceUnread,
  }
  if (JSON.stringify(after) !== JSON.stringify(before)) await update($, run, () => after)
}

// ---- what the session's own events say ------------------------------------

const label = (e: { tool: string } & Record<string, unknown>): string => {
  const pick = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : '')
  const path = pick('file_path') || pick('notebook_path')
  const target = path
    ? (path.split(/[\\/]/).at(-1) ?? path)
    : pick('subagent_type').replace(PREFIX, '') || pick('pattern') || pick('command').split('\n')[0] || pick('description')
  return `${e.tool} ${target ?? ''}`.trim()
}

const plus = (t: LiveTokens, u: TurnStepResult['usage']): LiveTokens =>
  u
    ? {
        in: t.in + u.input_tokens,
        cacheRead: t.cacheRead + u.cache_read_input_tokens,
        cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
        out: t.out + u.output_tokens,
      }
    : t

const sum = (a: LiveTokens, b: LiveTokens): LiveTokens => ({
  in: a.in + b.in,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  out: a.out + b.out,
})

const sent = (u: TurnStepResult['usage']) =>
  u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0

// The advisor runs inside the request, as a server tool, so no tool call is
// made for it: its consultations are read off the step's result. Their tokens
// are not in the step's usage; token-trace reads them from the transcript.
const consulted = (res: TurnStepResult) => {
  const uses = (res.serverToolUses ?? []).filter(u => u.name === 'advisor')
  return { n: uses.length, ms: uses.reduce((sum, u) => sum + Math.max(0, (u.endedAt ?? u.startedAt) - u.startedAt), 0) }
}

const armed = async ($: EngineInterface) => ARMED.includes((await read($, run)).phase)

async function noteCall($: EngineInterface, agentId: string | undefined, what: string, tool: string) {
  if (agentId !== undefined) {
    if (!(await read($, agents)).some(a => a.agentId === agentId)) return
    await update($, agents, all =>
      all.map(a =>
        a.agentId === agentId
          ? { ...a, calls: a.calls + 1, byTool: { ...a.byTool, [tool]: (a.byTool[tool] ?? 0) + 1 }, lastTool: what }
          : a,
      ),
    )
    return
  }
  if (!(await armed($))) return
  const at = await $.clock.now()
  await update($, orchestrator, m => ({
    ...m,
    calls: m.calls + 1,
    byTool: { ...m.byTool, [tool]: (m.byTool?.[tool] ?? 0) + 1 },
    lastTool: what,
    lastAt: at,
  }))
}

// A SendMessage resumes an agent under the same id: its first request is its new run.
async function noteResume($: EngineInterface, agentId: string | undefined) {
  if (agentId === undefined) return
  const agent = (await read($, agents)).find(a => a.agentId === agentId)
  if (!agent || agent.endedAt === null) return
  const at = await $.clock.now()
  await update($, agents, all =>
    all.map(a => (a.agentId === agentId ? { ...a, endedAt: null, turnAt: at, status: '', resumes: a.resumes + 1 } : a)),
  )
  await update($, clock, () => at)
}

async function noteStep($: EngineInterface, e: TurnStepInput, res: TurnStepResult) {
  const u = res.usage
  const effort = typeof e.effort === 'string' ? e.effort : ''
  const adv = consulted(res)
  if (e.agentId !== undefined) {
    const id = e.agentId
    if (!(await read($, agents)).some(a => a.agentId === id)) return
    await update($, agents, all =>
      all.map(a =>
        a.agentId === id
          ? {
              ...a,
              steps: a.steps + 1,
              tokens: plus(a.tokens, u),
              advisor: (a.advisor ?? 0) + adv.n,
              advisorMs: (a.advisorMs ?? 0) + adv.ms,
              ctx: u ? sent(u) : a.ctx,
              model: u?.model ?? a.model,
              effort: effort || a.effort,
            }
          : a,
      ),
    )
    return
  }
  // The orchestrator's request goes on its open turn; the turn's end decides whether it counts.
  const at = await $.clock.now()
  await update($, turn, t => ({
    steps: t.steps + 1,
    tokens: plus(t.tokens, u),
    advisor: (t.advisor ?? 0) + adv.n,
    advisorMs: (t.advisorMs ?? 0) + adv.ms,
  }))
  await update($, orchestrator, m => ({ ...m, ctx: u ? sent(u) : m.ctx, model: u?.model ?? m.model, effort: effort || m.effort, lastAt: at }))
}

/**
 * The orchestrator is charged per turn, as `token-trace` charges it at Stop: a
 * turn that ends inside this session's run counts whole, the turn that starts
 * the run included, and so does the one that writes `done` (ADR-043). One that
 * ends outside a run counts nothing.
 */
async function closeTurn($: EngineInterface) {
  const before = (await read($, run)).phase
  await poll($)
  const open = await read($, turn)
  const closing = (await read($, run)).phase === 'done' && ARMED.includes(before)
  if (open.steps > 0 && ((await armed($)) || closing)) {
    await update($, orchestrator, m => ({
      ...m,
      steps: m.steps + open.steps,
      tokens: sum(m.tokens, open.tokens),
      advisor: (m.advisor ?? 0) + (open.advisor ?? 0),
      advisorMs: (m.advisorMs ?? 0) + (open.advisorMs ?? 0),
    }))
  }
  await update($, turn, () => TURN0)
}

// ---- drawing ---------------------------------------------------------------

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`)
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s >= 3600) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}
const shortModel = (m: string) =>
  m.replace(/^claude-/, '').replace(/-(\d+)-(\d+)(-\d{8})?$/, ' $1.$2').replace(/-(\d+)$/, ' $1') || '?'
// Read from cache, sent fresh (cache writes included), and generated. Never one
// sum: a cache read is billed at a fraction of a fresh token, and out at a multiple.
const split = (t: LiveTokens) => `cache ${k(t.cacheRead)} · new ${k(t.in + t.cacheWrite)} · out ${k(t.out)}`
// What it invoked, counted: tool calls, the skills among them, and the advisor's consultations.
type Invoked = { calls: number; byTool: Record<string, number>; advisor: number; advisorMs: number }
const counted = (x: Invoked) => `${x.calls - (x.byTool?.Skill ?? 0)} tools · ${x.byTool?.Skill ?? 0} skills`
// '' when it consulted none: a card gives it a line of its own only then.
const advised = (x: Invoked) => (x.advisor ? `advisor ${x.advisor} · ${dur(x.advisorMs ?? 0)}` : '')
const invoked = (x: Invoked) => [counted(x), advised(x)].filter(Boolean).join(' · ')
const usdLine = (usd: number | null) => (usd === null ? 'session cost: none reported' : `session cost US$${usd.toFixed(2)} (/cost)`)
const tone = (status: string) =>
  /BLOCK|FAIL|ERROR|ABORTED/.test(status) ? 'error' : /ESCALATE|CHANGES|NEEDS|NO_STATUS/.test(status) ? 'warning' : 'success'
const mark = (status: string) => (tone(status) === 'error' ? '✗' : tone(status) === 'warning' ? '↺' : '✓')
const elapsed = (a: LiveAgent, at: number) => a.activeMs + (a.endedAt === null ? Math.max(0, at - a.turnAt) : 0)
// Exact, in token-trace's field names, so the two can be compared line by line
// (ADR-037), and priced with no join: `?` is a model or effort no request named.
const countLine = (id: string, role: string, a: { model: string; effort: string; tokens: LiveTokens }, msgs: number) =>
  `agent_id=${id} role=${role} model=${a.model || '?'} effort=${a.effort || '?'} in=${a.tokens.in} cache_read=${a.tokens.cacheRead} cache_write=${a.tokens.cacheWrite} out=${a.tokens.out} msgs=${msgs}`

export const register: Register = (on, options) => {
  // The plugin setting that turns the view off: nothing is hooked at all.
  if (options.live_view === false) return

  on('session.start', async ($, e, next) => {
    root = e.cwd
    traceSeen = stoodSeen = ''
    try {
      session = await $.session.id()
    } catch {
      /* unknown: the phase owner then cannot be compared, as in readOwnedPhase */
    }
    $.clock.every(2000, () => poll($).catch(() => undefined))
    // A running agent's clock ticks once a second; nothing redraws while none runs.
    let shown: string | undefined
    $.clock.every(1000, async () => {
      try {
        const live = (await read($, agents)).filter(a => a.endedAt === null)
        if (live.length > 0) {
          const t = await $.clock.now()
          await update($, clock, () => t)
        }
        const { phase } = await read($, run)
        // Claude Code puts the plugin's name ahead of it.
        const text = !ARMED.includes(phase) ? undefined : `${phase}${live.length ? ` · ${live.map(a => a.role).join(', ')}` : ''}`
        if (text !== shown) $.ui.status((shown = text))
      } catch {}
    })
    try {
      await $.command.register({ name: 'spec-flow-live', description: 'Show the live spec-flow pane', immediate: true })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'spec-flow-live' }, async $ => {
    await $.ui.open({ id: PANE, title: 'spec-flow' })
    return { text: 'spec-flow live pane opened.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (!e.subagentType.startsWith(PREFIX) || spawned.deny !== undefined || spawned.agentId === undefined) return spawned
    try {
      const at = await $.clock.now()
      const role = e.subagentType.slice(PREFIX.length)
      const agent: LiveAgent = {
        agentId: spawned.agentId,
        role,
        parentId: e.parentAgentId ?? '',
        // Only an implementer works ON a milestone; the others merely name one.
        milestone: role === 'implementer' ? (/milestones[\\/](M\d+)\.md/.exec(e.prompt)?.[1] ?? '') : '',
        model: spawned.model,
        effort: '',
        startedAt: at,
        turnAt: at,
        activeMs: 0,
        endedAt: null,
        status: '',
        resumes: 0,
        steps: 0,
        calls: 0,
        byTool: {},
        advisor: 0,
        advisorMs: 0,
        lastTool: '',
        ctx: 0,
        tokens: ZERO,
      }
      await update($, agents, list => [...list.filter(a => a.agentId !== agent.agentId), agent].slice(-60))
      await update($, clock, () => at)
      // Unasked, a pane is placed only where it would sit beside the transcript.
      void $.ui.open({ id: PANE, title: 'spec-flow' }).catch(() => undefined)
    } catch {}
    return spawned
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    try {
      await noteCall($, e.agentId, label(e as unknown as { tool: string } & Record<string, unknown>), String(e.tool))
    } catch {}
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    try {
      await noteResume($, e.agentId)
    } catch {}
    const res = yield* next(e)
    try {
      await noteStep($, e, res)
    } catch {}
    return res
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    try {
      if (id === undefined) {
        await closeTurn($)
        return done
      }
      if (!(await read($, agents)).some(a => a.agentId === id)) return done
      const at = await $.clock.now()
      const status = parseReturn(e.answer)?.status ?? (e.reason === 'answer' ? 'NO_STATUS' : e.reason.toUpperCase())
      await update($, agents, list =>
        list.map(a => (a.agentId === id ? { ...a, endedAt: at, activeMs: a.activeMs + e.durationMs, status } : a)),
      )
      await update($, clock, () => at)
    } catch {}
    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const committed = await read($, orchestrator)
    const open = await read($, turn)
    const r = await read($, run)
    const at = Math.max(await read($, clock), ...list.map(a => a.endedAt ?? a.turnAt), committed.lastAt)
    // What the orchestrator has spent so far: its charged turns and the one it is in.
    const m = {
      ...committed,
      steps: committed.steps + open.steps,
      tokens: sum(committed.tokens, open.tokens),
      advisor: (committed.advisor ?? 0) + (open.advisor ?? 0),
      advisorMs: (committed.advisorMs ?? 0) + (open.advisorMs ?? 0),
    }

    const cols = e.props.bodyColumns
    const live = list.filter(a => a.endedAt === null)
    const spin = SPIN[Math.floor(at / 1000) % SPIN.length]

    const bar = (
      <Box flexWrap="wrap">
        {BAR.map((p, i) => {
          const here = BAR.indexOf(r.phase)
          return (
            <Text
              bold={p === r.phase}
              color={p === r.phase ? 'warning' : i < here ? 'success' : undefined}
              dimColor={here !== -1 && i > here}
            >
              {i === 0 ? '' : ' ─ '}
              {p === r.phase ? `[${p}]` : p}
            </Text>
          )
        })}
        {r.phase === 'blocked' && (
          <Text bold color="error">
            {'  [blocked]'}
          </Text>
        )}
        {r.milestone !== '' && <Text color="suggestion">{`   ${r.milestone}`}</Text>}
      </Box>
    )

    const gate =
      r.gate === '' ? (
        <Text dimColor>gate: not run in this run</Text>
      ) : (
        <Text wrap="truncate-end">
          gate:{' '}
          <Text color={r.gate.startsWith('pass') ? 'success' : r.gate.startsWith('running') ? 'warning' : 'error'}>
            {r.gate}
          </Text>
          <Text dimColor>{`${r.gateAt ? ` · ${dur(at - r.gateAt)} ago` : ''} · failures in a row ${r.attempts}`}</Text>
        </Text>
      )
    // Named by the checks the gate line records; their output stays in gate-failure.log.
    const failed = r.failed.length > 0 && <Text color="error" wrap="truncate-end">{`  failed: ${r.failed.join(' · ')}`}</Text>

    // A cap that is not a number of calls is one opus-budget denies every call at.
    const budget = r.budgets.length > 0 && (
      <Text wrap="truncate-end">
        <Text dimColor>budget:</Text>
        {r.budgets.map(b =>
          Number.isFinite(b.cap) ? (
            <Text color={b.used >= b.cap ? 'error' : b.used === b.cap - 1 ? 'warning' : undefined}>{` ${b.role} ${b.used}/${b.cap}`}</Text>
          ) : (
            <Text color="error">{` ${b.role} ${b.used}, cap unreadable: every call denied`}</Text>
          ),
        )}
      </Text>
    )

    const orchestratorBox = (
      <Box flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} width={Math.min(cols, CARD * 2 + 3)}>
        <Box justifyContent="space-between">
          <Text bold>orchestrator</Text>
          <Text dimColor>{shortModel(m.model)}</Text>
        </Box>
        {live.length > 0 ? (
          <Text color="warning" wrap="truncate-end">{`waiting on ${live.map(a => a.role).join(', ')}`}</Text>
        ) : at - m.lastAt < 20_000 && m.lastTool !== '' ? (
          <Text color="suggestion" wrap="truncate-end">{`▸ ${m.lastTool}`}</Text>
        ) : (
          <Text dimColor>idle: your turn, or the gate's</Text>
        )}
        <Text wrap="truncate-end">{`${m.steps} requests · ctx ${k(m.ctx)}`}</Text>
        <Text wrap="truncate-end">{invoked(m)}</Text>
        <Text wrap="truncate-end">{split(m.tokens)}</Text>
      </Box>
    )

    const sentBack = (a: LiveAgent) => {
      const b = r.sentBack[a.agentId]
      if (!b) return null
      return (
        <Text color={b.cap ? 'error' : 'warning'} wrap="truncate-end">
          {b.cap ? `sent back ${b.n}/${MAX_BLOCKS}, then let through · ${b.why}` : `sent back ${b.n}/${MAX_BLOCKS} · ${b.why}`}
        </Text>
      )
    }

    // A running agent is drawn whole and lit; a finished one keeps its box, dimmed and shorter.
    const card = (a: LiveAgent) => {
      const running = a.endedAt === null
      const color = running ? 'warning' : tone(a.status)
      const parent = a.parentId ? list.find(p => p.agentId === a.parentId)?.role : undefined
      const title = (
        <Box justifyContent="space-between">
          <Text bold={running} dimColor={!running} wrap="truncate-end">
            {a.role}
            {a.milestone ? ` · ${a.milestone}` : ''}
            {parent ? ` ← ${parent}` : ''}
          </Text>
          <Text color={color}>{running ? `${spin} running` : `${mark(a.status)} ${a.status}`}</Text>
        </Box>
      )
      const pace = `${dur(elapsed(a, at))} · ${a.steps} requests`
      if (!running) {
        return (
          <Box key={`agent-${a.agentId}`} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor paddingX={1} width={CARD}>
            {title}
            {sentBack(a)}
            <Text dimColor wrap="truncate-end">{`${pace} · ${shortModel(a.model)}`}</Text>
            <Text dimColor wrap="truncate-end">{counted(a)}</Text>
            {advised(a) !== '' && <Text dimColor wrap="truncate-end">{advised(a)}</Text>}
            <Text dimColor wrap="truncate-end">{split(a.tokens)}</Text>
          </Box>
        )
      }
      return (
        <Box key={`agent-${a.agentId}`} flexDirection="column" borderStyle="bold" borderColor={color} paddingX={1} width={CARD}>
          {title}
          {sentBack(a)}
          <Text dimColor wrap="truncate-end">
            {`${shortModel(a.model)}${a.effort ? ` · ${a.effort}` : ''}${a.resumes ? ` · resumed ${a.resumes}` : ''}`}
          </Text>
          <Text wrap="truncate-end">{`${pace} · ctx ${k(a.ctx)}`}</Text>
          <Text wrap="truncate-end">{counted(a)}</Text>
          {advised(a) !== '' && <Text wrap="truncate-end">{advised(a)}</Text>}
          <Text wrap="truncate-end">{split(a.tokens)}</Text>
          <Text color="suggestion" wrap="truncate-end">{`▸ ${a.lastTool || 'thinking…'}`}</Text>
        </Box>
      )
    }

    // Chronological; the arrow is "then": every hand-off goes back through the orchestrator.
    const perRow = Math.max(1, Math.floor((cols + 3) / (CARD + 3)))
    const rows: LiveAgent[][] = []
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow))

    const total = list.reduce(
      (acc, a) => ({
        calls: acc.calls + a.calls,
        byTool: { ...acc.byTool, Skill: (acc.byTool.Skill ?? 0) + (a.byTool?.Skill ?? 0) },
        advisor: acc.advisor + (a.advisor ?? 0),
        advisorMs: acc.advisorMs + (a.advisorMs ?? 0),
        tokens: sum(acc.tokens, a.tokens),
      }),
      { calls: m.calls, byTool: { Skill: m.byTool?.Skill ?? 0 }, advisor: m.advisor, advisorMs: m.advisorMs, tokens: m.tokens },
    )

    return (
      <Box flexDirection="column">
        {bar}
        {gate}
        {failed}
        {budget}
        {r.stoodDown.map(line => (
          <Text color="warning" wrap="wrap">{`⚠ ${line}`}</Text>
        ))}
        {r.traceUnread && <Text dimColor wrap="wrap">run-trace.log is over what one read takes: the agent gate's send-backs are not shown</Text>}
        {orchestratorBox}
        {list.length === 0 ? (
          <Text dimColor>No spec-flow agent has been spawned in this session yet.</Text>
        ) : (
          <Box flexDirection="column">
            {rows.map(row => (
              <Box flexDirection="row">
                {row.map((a, i) =>
                  i === 0 ? (
                    card(a)
                  ) : (
                    <Box flexDirection="row">
                      <Box width={3} alignItems="center" justifyContent="center">
                        <Text dimColor>→</Text>
                      </Box>
                      {card(a)}
                    </Box>
                  ),
                )}
              </Box>
            ))}
          </Box>
        )}
        <Text wrap="wrap">
          <Text bold>run total </Text>
          {`${list.length} agents · ${invoked(total)}`}
        </Text>
        <Text wrap="wrap">{split(total.tokens)}</Text>
        <Text wrap="wrap">{usdLine(r.usd)}</Text>
        {list.length > 0 && (
          <Box>
            <Button
              key="copy"
              label="Copy exact counts"
              onPress={async () => {
                // Read at the press, not from the drawing: a count may have moved since.
                const now = await read($, agents)
                const charged = await read($, orchestrator)
                const text = [
                  ...now.map(a => countLine(a.agentId, a.role, a, a.steps)),
                  countLine('-', 'orchestrator', charged, charged.steps),
                ].join('\n')
                await $.ui.copy({ text, surface: e.surface })
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
