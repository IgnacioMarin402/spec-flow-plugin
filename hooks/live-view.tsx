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
 * Phase, milestone and gate come from `.claude/state/`. It never reads a
 * transcript (ADR-036).
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepInput, TurnStepResult } from 'claude-code'

// The parser the agent gate and run-trace read a return with: one copy.
import { parseReturn } from '../scripts/agent-blocks.mjs'
import type { LiveAgent, LiveOrchestrator, LiveRun, LiveTokens, LiveTurn } from './live-view-state'

const PANE = 'spec-flow-live'
const PREFIX = 'spec-flow:'
// The phase vocabulary `hooks/lib/io.mjs` arms on.
const ARMED = ['spec', 'plan', 'review', 'implement', 'blocked']
const BAR = ['spec', 'plan', 'review', 'implement', 'done']
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const CARD = 38 // 34 columns of text, its padding and its border

const ZERO: LiveTokens = { in: 0, cacheRead: 0, cacheWrite: 0, out: 0 }
const ORCH0: LiveOrchestrator = { steps: 0, calls: 0, lastTool: '', lastAt: 0, ctx: 0, model: '', tokens: ZERO }
const TURN0: LiveTurn = { steps: 0, tokens: ZERO }
const RUN0: LiveRun = { phase: '', milestone: '', gate: '', gateAt: 0, attempts: 0 }

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
  const after: LiveRun = {
    phase,
    milestone: phase && ours && mk ? `${mk} · ${slug}` : '',
    gate: phase && result ? `${result} ${gateLine.split(' ')[1] ?? ''}` : '',
    gateAt: Date.parse(gateLine.split(' ')[0] ?? '') || 0,
    attempts: phase ? Number(await stateText($, root, 'gate_attempts')) || 0 : 0,
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
  await update($, orchestrator, m => ({ ...m, calls: m.calls + 1, lastTool: what, lastAt: at }))
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
  await update($, turn, t => ({ steps: t.steps + 1, tokens: plus(t.tokens, u) }))
  await update($, orchestrator, m => ({ ...m, ctx: u ? sent(u) : m.ctx, model: u?.model ?? m.model, lastAt: at }))
}

/**
 * The orchestrator is charged per turn, as `token-trace` charges it at Stop: a
 * turn that ends inside this session's run counts whole, the turn that starts
 * the run included, and one that ends outside it counts nothing.
 */
async function closeTurn($: EngineInterface) {
  await poll($)
  const open = await read($, turn)
  if (open.steps > 0 && (await armed($))) {
    await update($, orchestrator, m => ({ ...m, steps: m.steps + open.steps, tokens: sum(m.tokens, open.tokens) }))
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
const all = (t: LiveTokens) => t.in + t.cacheRead + t.cacheWrite + t.out
// Read from cache, sent fresh (cache writes included), and generated.
const split = (t: LiveTokens) => `cache ${k(t.cacheRead)} · new ${k(t.in + t.cacheWrite)} · out ${k(t.out)}`
const tone = (status: string) =>
  /BLOCK|FAIL|ERROR|ABORTED/.test(status) ? 'error' : /ESCALATE|CHANGES|NEEDS|NO_STATUS/.test(status) ? 'warning' : 'success'
const mark = (status: string) => (tone(status) === 'error' ? '✗' : tone(status) === 'warning' ? '↺' : '✓')
const elapsed = (a: LiveAgent, at: number) => a.activeMs + (a.endedAt === null ? Math.max(0, at - a.turnAt) : 0)
// Exact, in token-trace's field names, so the two can be compared line by line (ADR-037).
const countLine = (id: string, role: string, t: LiveTokens, msgs: number) =>
  `agent_id=${id} role=${role} in=${t.in} cache_read=${t.cacheRead} cache_write=${t.cacheWrite} out=${t.out} msgs=${msgs}`

export const register: Register = (on, options) => {
  // The plugin setting that turns the view off: nothing is hooked at all.
  if (options.live_view === false) return

  on('session.start', async ($, e, next) => {
    root = e.cwd
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
    const m = { ...committed, steps: committed.steps + open.steps, tokens: sum(committed.tokens, open.tokens) }

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
        <Text wrap="truncate-end">{`${m.calls} calls · ${m.steps} requests · ctx ${k(m.ctx)}`}</Text>
        <Text wrap="truncate-end">{split(m.tokens)}</Text>
        <Text wrap="truncate-end">{`total ${k(all(m.tokens))}`}</Text>
      </Box>
    )

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
      const pace = `${dur(elapsed(a, at))} · ${a.calls} calls · ${a.steps} requests`
      if (!running) {
        return (
          <Box key={`agent-${a.agentId}`} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor paddingX={1} width={CARD}>
            {title}
            <Text dimColor wrap="truncate-end">{pace}</Text>
            <Text dimColor wrap="truncate-end">{`${split(a.tokens)}`}</Text>
            <Text dimColor wrap="truncate-end">{`total ${k(all(a.tokens))} · ${shortModel(a.model)}`}</Text>
          </Box>
        )
      }
      return (
        <Box key={`agent-${a.agentId}`} flexDirection="column" borderStyle="bold" borderColor={color} paddingX={1} width={CARD}>
          {title}
          <Text dimColor wrap="truncate-end">
            {`${shortModel(a.model)}${a.effort ? ` · ${a.effort}` : ''}${a.resumes ? ` · resumed ${a.resumes}` : ''}`}
          </Text>
          <Text wrap="truncate-end">{pace}</Text>
          <Text wrap="truncate-end">{split(a.tokens)}</Text>
          <Text wrap="truncate-end">{`total ${k(all(a.tokens))} · ctx ${k(a.ctx)}`}</Text>
          <Text color="suggestion" wrap="truncate-end">{`▸ ${a.lastTool || 'thinking…'}`}</Text>
        </Box>
      )
    }

    // Chronological; the arrow is "then": every hand-off goes back through the orchestrator.
    const perRow = Math.max(1, Math.floor((cols + 3) / (CARD + 3)))
    const rows: LiveAgent[][] = []
    for (let i = 0; i < list.length; i += perRow) rows.push(list.slice(i, i + perRow))

    const total = list.reduce(
      (acc, a) => ({ calls: acc.calls + a.calls, tokens: sum(acc.tokens, a.tokens) }),
      { calls: m.calls, tokens: m.tokens },
    )

    return (
      <Box flexDirection="column">
        {bar}
        {gate}
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
          {`${list.length} agents · ${total.calls} calls`}
        </Text>
        <Text wrap="wrap">{`${split(total.tokens)} · total ${k(all(total.tokens))}`}</Text>
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
                  ...now.map(a => countLine(a.agentId, a.role, a.tokens, a.steps)),
                  countLine('-', 'orchestrator', charged.tokens, charged.steps),
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
