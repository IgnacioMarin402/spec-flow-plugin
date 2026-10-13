import { expect, mock, test } from 'claude-code/testing'
import type { Args, HookStream, On, TurnStepChunk, TurnStepInput, TurnStepResult, TurnStepServerToolUse } from 'claude-code'

const ROOT = '/repo'
const ME = 'session-me'
// Assembled, never spelled: model-pins scans `hooks/`, and here a model is only
// data the view labels (ADR-013).
const PARENT_MODEL = ['claude', 'sonnet', '5', '5'].join('-')
const MODEL = ['claude', 'opus', '5', '5'].join('-')
const MODEL_LABEL = ['opus', '5\\.5'].join(' ')

const spawn = (subagentType: string, prompt = 'p'): Args<'agent.spawn'> => ({
  tool_use_id: `tu-${subagentType}`,
  prompt,
  description: 'd',
  subagentType,
  provider: { plugin: 'spec-flow', tier: 'user' },
  parentModel: PARENT_MODEL,
  background: true,
  fork: false,
})

const usage = (out: number) => ({
  model: MODEL,
  input_tokens: 2_000,
  cache_read_input_tokens: 400_000,
  cache_creation_input_tokens: 10_000,
  output_tokens: out,
})

const PANE = {
  plugin: 'spec-flow',
  component: 'Pane',
  requestId: 'spec-flow-live',
  props: { title: 'spec-flow', isFocused: false, bodyColumns: 125, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

// The kit hands paths back in the platform's spelling: `C:\repo\.claude\state\phase` on Windows.
const stateFile = (path: string) => /[\\/]\.claude[\\/]state[\\/](.+)$/.exec(path)?.[1] ?? path

/**
 * The world beneath the mod: `.claude/state/` as `files` (mutable), git's
 * answer, the model's, and what the session has cost (`usd`, absent: no ledger).
 * `server` holds the server tool calls of the next steps, one entry per step.
 */
function world(
  on: On,
  files: Record<string, string>,
  { tracked = false, usd, server = [] }: { tracked?: boolean; usd?: number; server?: TurnStepServerToolUse[][] } = {},
) {
  on('fs.read', (_, e) => {
    const text = files[stateFile(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('fs.stat', (_, e) => {
    const text = files[stateFile(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: text.length, isLink: false } }
  })
  on('process.run', () => ({ value: { exitCode: tracked ? 0 : 1, stdout: '', stderr: '' } as never }))
  on('session.id', () => ({ value: ME }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], ...(usd === undefined ? {} : { cost: { usd } }) } as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', (_, e) => ({ model: MODEL, agentId: `a-${e.subagentType.replace(/^spec-flow:/, '')}` }))
  on('turn.step', async function* (_, e) {
    const serverToolUses = server.shift()
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: usage(3_100), ...(serverToolUses ? { serverToolUses } : {}) }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: 'ok' as never }))
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  const status: (string | undefined)[] = []
  on('ui.status', (_, e) => (status.push(e.text), { value: undefined }))
  return status
}

/** What the pane put on the clipboard. */
function clipboard(on: On) {
  const copied: string[] = []
  on('ui.copy', (_, e) => (copied.push(e.text), { value: { isCopied: true as const } }))
  return copied
}

type Stepper = { turn: { step: (input: TurnStepInput) => HookStream<TurnStepChunk, TurnStepResult> } }

async function step($: Stepper, agentId?: string) {
  const s = $.turn.step({ turnId: `t-${agentId ?? 'main'}`, index: 0, model: MODEL, messageCount: 3, effort: 'high', ...(agentId ? { agentId } : {}) })
  for await (const _ of s) {
    /* drain */
  }
  return s.result
}

/** The end of one of the orchestrator's turns: where token-trace's Stop would charge it. */
const mainTurnEnds = { answer: '', durationMs: 1, isAborted: false, turnId: 't-main', reason: 'answer' } as const

for (const surface of ['terminal', 'desktop'] as const) {
  test(`${surface}: a role shows when spawned, counts only its own work live, and closes with its STATUS`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const status = world(on, { phase: 'plan', 'phase.session': ME })
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000) // the poll reads the phase

    await $.agent.spawn(spawn('spec-flow:planner', 'read specflow/x/milestones/M1.md'))
    await $.agent.spawn(spawn('Explore'))

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^planner$/ }), 'planner box').toBeDefined()
    expect(await ui.find({ text: /running$/ }), 'running badge').toBeDefined()
    expect(await ui.find({ text: /M1/ }), 'a planner names a milestone, does not work on one').toBeUndefined()
    expect(await ui.find({ text: /Explore/ }), 'not this flow').toBeUndefined()
    expect(await ui.find({ text: '[plan]' }), 'phase from .claude/state').toBeDefined()

    // Mid-run: one request of the planner, and one of the orchestrator.
    await step($, 'a-planner')
    await step($)
    expect(await ui.find({ text: 'cache 400k · new 12k · out 3k' }), 'live tokens before it finishes').toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: 'cache 400k · new 12k · out 3k' }), 'orchestrator counted apart').toHaveLength(2)
    expect(await ui.find({ text: /^0s · 1 requests · ctx 412k$/ }), "the running agent's prompt").toBeDefined()
    expect(await ui.find({ text: /^total |· total / }), 'no sum of cache reads and fresh tokens').toBeUndefined()

    await clock.advance(72_000)
    expect(await ui.find({ text: /^1m12s · 1 requests · ctx 412k$/ }), 'its clock runs while it does').toBeDefined()
    expect(status.at(-1), 'Claude Code prefixes the plugin name itself').toBe('plan · planner')

    await $.turn.complete({
      agentId: 'a-planner',
      answer: 'Done.\nSTATUS: PLAN_READY\nPLAN_PATH: specflow/x/plan.md',
      durationMs: 72_000,
      isAborted: false,
      turnId: 't-a-planner',
      reason: 'answer',
      usage: usage(3_100),
    })
    expect(await ui.find({ text: '✓ PLAN_READY' }), 'its own status').toBeDefined()
    expect(await ui.find({ text: /running$/ }), 'nothing runs').toBeUndefined()
    expect(await ui.find({ text: /^1m12s · / }), 'its time is its turn').toBeDefined()
    expect(await ui.find({ text: new RegExp(`^1m12s · 1 requests · ${MODEL_LABEL}$`) }), 'a finished box keeps its numbers, shorter').toBeDefined()
    expect(await ui.find({ text: /^▸ / }), 'a finished box has no live line').toBeUndefined()

    // The orchestrator's own call, in this session's run, is its own.
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/specflow/x/plan.md` } as never)
    expect(await ui.find({ text: '▸ Read plan.md' }), 'orchestrator working').toBeDefined()
    expect(await ui.find({ text: /^1 requests · ctx/ }), 'orchestrator counts its requests').toBeDefined()
    expect(await ui.find({ text: /^1 tools · 0 skills$/ }), 'and its calls').toBeDefined()
    await $.turn.complete(mainTurnEnds)

    // Another agent's turn is not the planner's.
    await $.turn.complete({ agentId: 'a-ghost', answer: 'STATUS: BLOCKED', durationMs: 1, isAborted: false, turnId: 'g', reason: 'answer' })
    expect(await ui.find({ text: /BLOCKED/ })).toBeUndefined()

    // A SendMessage resumes it under the same id.
    await step($, 'a-planner')
    expect(await ui.find({ text: /resumed 1/ }), 'resumed').toBeDefined()
    expect(await ui.find({ text: /running$/ }), 'running again').toBeDefined()
    expect(await ui.find({ text: 'cache 800k · new 24k · out 6k' }), 'its tokens add up').toBeDefined()
    expect(await ui.find({ text: /^cache 1\.2M · new 36k · out 9k$/ }), 'the run total').toBeDefined()

    // The exact counts, in token-trace's field names, for a line-by-line comparison,
    // with the model and effort that price them.
    await ui.press({ key: 'copy' })
    expect(copied).toEqual([
      `agent_id=a-planner role=planner model=${MODEL} effort=high in=4000 cache_read=800000 cache_write=20000 out=6200 msgs=2\n` +
        `agent_id=- role=orchestrator model=${MODEL} effort=high in=2000 cache_read=400000 cache_write=10000 out=3100 msgs=1`,
    ])
  })

  test(`${surface}: a STATUS line is read as the agent gate reads it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await $.turn.complete({ agentId: 'a-implementer', answer: 'All done.\n\n**STATUS:** IMPLEMENTED\nMILESTONE: M1', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer' })
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '✓ IMPLEMENTED' })).toBeDefined()
  })

  test(`${surface}: the orchestrator is charged per turn, as token-trace charges it at Stop`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'idle', 'phase.session': ME }
    world(on, files)
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)

    // The turn that starts the run: its first request comes before the phase is written.
    await step($)
    files.phase = 'spec'
    await $.agent.spawn(spawn('spec-flow:spec-writer'))
    await step($)
    await $.turn.complete(mainTurnEnds)

    // The turn that ends the run writes `done` and is charged (ADR-043).
    await step($)
    files.phase = 'done'
    await $.turn.complete(mainTurnEnds)

    // A turn after the run is not.
    await step($)
    await $.turn.complete(mainTurnEnds)

    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)?.split('\n').at(-1)).toBe(`agent_id=- role=orchestrator model=${MODEL} effort=high in=6000 cache_read=1200000 cache_write=30000 out=9300 msgs=3`)
  })

  test(`${surface}: a copied line names a model and an effort only where one is known`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME })
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    // Spawned, with no request yet: the spawn resolved its model, and nothing has named an effort.
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy' })
    expect(copied).toEqual([
      `agent_id=a-implementer role=implementer model=${MODEL} effort=? in=0 cache_read=0 cache_write=0 out=0 msgs=0\n` +
        'agent_id=- role=orchestrator model=? effort=? in=0 cache_read=0 cache_write=0 out=0 msgs=0',
    ])
  })

  test(`${surface}: each box counts its tools, its skills and the advisor's consultations`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const advice = (id: string, ms: number) => [{ id, name: 'advisor', input: {}, startedAt: 1_000, endedAt: 1_000 + ms }]
    // One entry per step, in order: the implementer's two, then the orchestrator's.
    world(on, { phase: 'implement', 'phase.session': ME }, { server: [advice('s1', 8_000), [], advice('s2', 3_000)] })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))

    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/lib/a.ts`, agentId: 'a-implementer' } as never)
    await $.tool.call({ tool: 'Skill', skill: 'testing', agentId: 'a-implementer' } as never)
    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/lib/a.ts`, agentId: 'a-implementer' } as never)
    await step($, 'a-implementer')
    await step($, 'a-implementer')
    await $.tool.call({ tool: 'Skill', skill: 'review' } as never)
    await step($)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^2 tools · 1 skills$/ }), "the implementer's").toBeDefined()
    expect(await ui.find({ text: /^advisor 1 · 8s$/ }), "a card's own line, its consultation's time").toBeDefined()
    expect(await ui.find({ text: /^0 tools · 1 skills · advisor 1 · 3s$/ }), "the orchestrator's").toBeDefined()
    expect(await ui.find({ text: /1 agents · 2 tools · 2 skills · advisor 2 · 11s$/ }), 'the run line').toBeDefined()
  })

  test(`${surface}: the run line shows what the session cost, as /cost totals it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'plan', 'phase.session': ME }, { usd: 1.234 })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'session cost US$1.23 (/cost)' })).toBeDefined()
  })

  test(`${surface}: a host that keeps no cost ledger shows none, never a zero`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'plan', 'phase.session': ME })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'session cost: none reported' })).toBeDefined()
    expect(await ui.find({ text: /US\$/ })).toBeUndefined()
  })

  test(`${surface}: the milestone and the gate shown are this run's`, async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-11T18:00:00Z') })
    const earlier = '2026-10-11T05:25:18Z 5745ede cc=? phase=implement attempt=0 result=pass lint=0 test=0\n'
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      'current-milestone': 'an-earlier-change M3 a-someone-else',
      'gate-history.log': earlier,
      'run-offset': '{"run-trace.log":10,"gate-history.log":1}',
    }
    world(on, files)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /an-earlier-change/ }), "another run's milestone").toBeUndefined()
    expect(await ui.find({ text: 'gate: not run in this run' }), "another run's gate").toBeDefined()

    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/this-change/milestones/M1.md'))
    files['current-milestone'] = 'this-change M1 a-implementer'
    files['gate-history.log'] = `${earlier}2026-10-11T18:00:01Z 223dc9f cc=? phase=implement attempt=0 result=pass lint=0 test=0\n`
    await clock.advance(2_000)
    expect(await ui.find({ text: /M1 · this-change/ }), 'the milestone this run is on').toBeDefined()
    expect(await ui.find({ text: 'pass 223dc9f' }), "this run's gate").toBeDefined()
  })

  test(`${surface}: a call made inside an agent is that agent's alone`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M2.md'))

    await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/lib/a.ts`, agentId: 'a-implementer' } as never)
    await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a-someone-else' } as never)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^implementer · M2$/ }), 'an implementer works on its milestone').toBeDefined()
    expect(await ui.find({ text: '▸ Edit a.ts' })).toBeDefined()
    expect(await ui.find({ text: /^1 tools · 0 skills$/ }), 'one call: its own').toBeDefined()
    expect(await ui.find({ text: /^0 tools · 0 skills$/ }), 'the orchestrator made none').toBeDefined()
  })

  test(`${surface}: the phase and the gate are what .claude/state/ says`, async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-11T04:10:00Z') })
    world(on, {
      phase: 'blocked',
      'phase.session': ME,
      gate_attempts: '5',
      'gate-history.log': '2026-10-11T04:05:00Z faa2688 cc=? phase=implement attempt=5 result=fail lint=1 test=0\n',
    })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /\[blocked\]/ })).toBeDefined()
    expect(await ui.find({ text: 'fail faa2688' })).toBeDefined()
    expect(await ui.find({ text: / · failures in a row 5/ })).toBeDefined()
  })

  for (const [why, files, tracked] of [
    ['another session owns', { phase: 'implement', 'phase.session': 'session-other' }, false],
    ['git tracks', { phase: 'implement', 'phase.session': ME }, true],
  ] as const) {
    test(`${surface}: a phase ${why} is not this session's run (ADR-017)`, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      const status = world(on, files, { tracked })
      await $.session.start({ cwd: ROOT, surface, isInteractive: true })
      await clock.advance(2_000)
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ text: '[implement]' })).toBeUndefined()
      expect(await ui.find({ text: 'implement' }), 'the bar still draws, unlit').toBeDefined()
      expect(status).toEqual([])
    })
  }

  test(`${surface}: the plugin setting turns the view off`, { options: { live_view: false } }, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const status = world(on, { phase: 'plan', 'phase.session': ME })
    on('ui.render', { component: 'Pane' }, (engine, e) => {
      const { Text } = engine.ui.resolve(e)
      return <Text>engine's own</Text>
    })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(4_000)
    await $.agent.spawn(spawn('spec-flow:planner'))
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /planner/ })).toBeUndefined()
    expect(await ui.find({ text: "engine's own" })).toBeDefined()
    expect(status).toEqual([])
  })

  test(`${surface}: a repository that never ran the engine shows nothing and sets no status`, async ($, on) => {
    const clock = mock.clock(on)
    const status = world(on, {})
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(4_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /No spec-flow agent has been spawned/ })).toBeDefined()
    expect(status).toEqual([])
  })
}
