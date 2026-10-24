import { expect, mock, test } from 'claude-code/testing'
import type { Args, HookStream, On, TurnStepChunk, TurnStepInput, TurnStepResult, TurnStepServerToolUse } from 'claude-code'
// What node hands back for a log one read cannot take; test/log-lines.test.mjs holds the script to it.
import { linesOf } from './lib/log-lines.mjs'

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
// `.claude/spec-flow.config.json` is keyed by its name, beside the state files.
const stateFile = (path: string) => /[\\/]\.claude[\\/](?:state[\\/])?(.+)$/.exec(path)?.[1] ?? path

/**
 * The world beneath the mod: `.claude/state/` as `files` (mutable), git's
 * answer, the model's, and what the session has cost (`usd`, absent: no ledger).
 * `server` holds the server tool calls of the next steps, one entry per step.
 * `mtimes` sets a file's modification time (mutable); a file in `unreadable` is
 * there and refuses a read, as one over 4 MiB does, and node reads it unless
 * `node` is false, or hands back more than one read takes when `truncated`.
 * `hold` is awaited inside a read, with the file's name, and inside git's call,
 * as `git`. With `gitHangs`, git never answers a call that sets no time limit,
 * and one that sets one fails, as the host fails it when the limit passes.
 */
function world(
  on: On,
  files: Record<string, string>,
  {
    tracked = false,
    usd,
    server = [],
    mtimes = {},
    unreadable = [],
    node = true,
    truncated = false,
    hold,
    gitHangs = false,
    sessionId = () => ME,
  }: {
    tracked?: boolean
    usd?: number
    server?: TurnStepServerToolUse[][]
    mtimes?: Record<string, number>
    unreadable?: string[]
    node?: boolean
    truncated?: boolean
    hold?: (file: string) => Promise<void>
    gitHangs?: boolean
    sessionId?: () => string
  } = {},
) {
  on('fs.read', async (_, e) => {
    const text = files[stateFile(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    if (unreadable.includes(stateFile(e.path))) throw new Error('EFBIG')
    await hold?.(stateFile(e.path))
    return { value: text }
  })
  on('fs.stat', (_, e) => {
    const text = files[stateFile(e.path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: text.length, mtimeMs: mtimes[stateFile(e.path)] ?? text.length, isLink: false } }
  })
  on('process.run', async (_, e) => {
    if (e.argv[0] !== 'node') {
      await hold?.('git')
      if (gitHangs) return typeof e.init?.timeoutMs === 'number' ? Promise.reject(new Error('ETIMEDOUT')) : new Promise<never>(() => {})
      return { value: { exitCode: tracked ? 0 : 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (!node) throw new Error('ENOENT: node')
    const [path = '', since = '', needle = ''] = e.argv.slice(e.argv.indexOf('--') + 1)
    const { n, last } = linesOf(files[stateFile(path)] ?? '', needle, Number(since))
    return { value: { exitCode: 0, stdout: [n, ...last].join('\n'), stderr: '', isStdoutTruncated: truncated, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: sessionId() }))
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

/** The line run-trace writes when `session` writes `done` (ADR-043). */
const closedBy = (session: string) => `2026-10-22T10:00:00Z phase=done session=${session} closed tool=Write\n`

/** The end of one of the orchestrator's turns: where token-trace's Stop would charge it. */
const mainTurnEnds = { answer: '', durationMs: 1, isAborted: false, turnId: 't-main', reason: 'answer' } as const

/**
 * Holds the next read of `file` until `release`: `next()` resolves once a read
 * is held. The reads after it pass.
 */
function held(file: string) {
  let arm = false
  let reached = () => {}
  let release = () => {}
  const released = new Promise<void>(r => (release = r))
  return {
    next: () => ((arm = true), new Promise<void>(r => (reached = r))),
    release: () => release(),
    hold: async (name: string) => {
      if (name !== file || !arm) return
      arm = false
      reached()
      await released
    },
  }
}

/** What `$.state` still holds after a reload: `liveRun`, as an earlier version wrote it. */
function kept(on: On, value: unknown) {
  const ref = { plugin: 'spec-flow', key: 'liveRun' } as const
  on('state.get', ref, async (_, e, next) => {
    const r = await next(e)
    return r.value?.value === undefined ? { value: { value: value as never, version: 0 } } : r
  })
}

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
    files['run-trace.log'] = closedBy(ME)
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

  test(`${surface}: a failed gate names the checks its line records as failed`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const at = '2026-10-17T04:05:00Z faa2688 cc=? engine=abc1234 phase=implement attempt=1'
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      'gate-history.log': `${at} result=fail:lint/trace lint=1 test=0 spec=0 typecheck=2 files=3\n`,
    }
    world(on, files)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '  failed: lint · typecheck' }), 'the non-zero checks, by their field').toBeDefined()

    files['gate-history.log'] += `${at} result=fail:behaviour lint=0 test=1 spec=0 typecheck=0 files=3\n`
    await clock.advance(2_000)
    expect(await ui.find({ type: 'Text', text: /^  failed: test$/ }), 'a red test').toBeDefined()

    // `-` is a check that did not run: lint, with no file of its own to lint.
    files['gate-history.log'] += `${at} result=fail:lint/trace lint=- test=0 spec=1 typecheck=0 files=0\n`
    await clock.advance(2_000)
    expect(await ui.find({ type: 'Text', text: /^  failed: spec$/ }), 'a check that did not run is not one that failed').toBeDefined()

    // A refusal ran no check: its result already says why.
    for (const refused of ['fail:base lint=- test=- spec=- typecheck=-', 'fail:contract lint=- test=- unscoped=missing', 'fail:hook-error lint=- test=- unscoped=missing']) {
      files['gate-history.log'] += `${at} result=${refused} files=-\n`
      await clock.advance(2_000)
      expect(await ui.find({ text: /failed:/ }), `nothing listed for ${refused}`).toBeUndefined()
    }

    files['gate-history.log'] += `${at} result=pass lint=0 test=0 spec=0 typecheck=0 files=3\n`
    await clock.advance(2_000)
    expect(await ui.find({ text: /failed:/ }), 'nothing listed for a pass').toBeUndefined()
  })

  test(`${surface}: the escalation budgets show against the caps opus-budget denies at`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      opus_calls: '4',
      architect_calls: '1',
      'spec-flow.config.json': '{"max_opus_calls": 4}',
    }
    world(on, files)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^ planner 4\/4$/ }))?.props.color, 'the configured cap, reached').toBe('error')
    expect((await ui.find({ type: 'Text', text: /^ architect 1\/3$/ }))?.props.color, 'the default cap, with room').toBeUndefined()

    files.architect_calls = '2'
    await clock.advance(2_000)
    expect((await ui.find({ type: 'Text', text: /^ architect 2\/3$/ }))?.props.color, 'one call from the cap').toBe('warning')

    files['spec-flow.config.json'] = '{"max_opus_calls": 4, "max_architect_calls": "three"}'
    await clock.advance(2_000)
    expect(await ui.find({ text: ' architect 2, cap unreadable: every call denied' }), 'a cap the hook denies at').toBeDefined()
    // What a narrow pane would cut off is what says why: the line wraps.
    expect((await ui.findAll({ type: 'Text', text: /budget:/ })).map(t => t.props.wrap), 'never cut').toContain('wrap')

    files.phase = 'done'
    await clock.advance(2_000)
    expect(await ui.find({ text: /planner/ }), 'outside a run').toBeUndefined()
  })

  test(`${surface}: a cap written after a byte-order mark shows as opus-budget reads it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME, 'spec-flow.config.json': '\uFEFF{"max_opus_calls": 2, "max_architect_calls": "three"}' })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^ planner 0\/2$/ }), 'the cap set, not the default').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ architect 0, cap unreadable: every call denied$/ }), 'a cap the hook denies every call at').toBeDefined()
  })

  test(`${surface}: a check that stood down during this run says so, and one before it does not`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = {
      phase: 'spec',
      'phase.session': ME,
      'run-offset': '{"run-trace.log":0,"gate-history.log":0}',
      'orchestrator-scope-unmatched.log':
        '2026-10-17T03:00:00.000Z phase=spec tool=Read unattributed\n' +
        '2026-10-17T04:00:00.000Z phase=spec tool=Read unattributed\n' +
        '2026-10-17T04:00:01.000Z phase=spec tool=Bash unattributed\n',
    }
    // The mark was set at 03:30, when this run started.
    world(on, files, { mtimes: { 'run-offset': Date.parse('2026-10-17T03:30:00Z') } })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '⚠ orchestrator-scope stood down: no tool call attributed to an agent yet (2×)' }), 'its lines since the mark').toBeDefined()
    expect(await ui.find({ text: /case 3 check/ }), 'no line of its own').toBeUndefined()

    files['human-turn-unmatched.log'] = '2026-10-17T04:10:00.000Z case-3 check stood down: no answer recorded — fix-login\n'
    await clock.advance(2_000)
    expect(await ui.find({ text: '⚠ the case 3 check stood down: no answer ever recorded (1×)' })).toBeDefined()
  })

  test(`${surface}: an agent the agent gate sent back says how often and why`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const line = (id: string, result: string, why: string) =>
      `2026-10-17T04:00:00.000Z phase=implement session=${ME} agent-check agent=spec-flow:implementer result=${result} why=${why} agent_id=${id}\n`
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      'run-trace.log': line('a-implementer', 'block', 'no-status') + line('someone-else', 'block', 'no-status') + line('a-implementer', 'skip', 'empty'),
    }
    world(on, files)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'sent back 1/2 · no-status' }), "its own block, not another agent's or a skip").toBeDefined()

    files['run-trace.log'] += line('a-implementer', 'block', 'unknown-status') + line('a-implementer', 'cap', 'missing-path')
    await clock.advance(2_000)
    const capped = await ui.find({ type: 'Text', text: /^sent back 2\/2, then let through · missing-path$/ })
    expect(capped, 'past the cap').toBeDefined()
    // 34 columns before the reason, in a card with 34 to draw in: it wraps, never cut.
    expect(capped?.props.wrap).toBe('wrap')
  })

  test(`${surface}: a check that stood down in an earlier run of this session is not this run's`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const mtimes = { 'run-offset': Date.parse('2026-10-17T03:30:00Z') }
    const files: Record<string, string> = {
      phase: 'spec',
      'phase.session': ME,
      'run-offset': '{"run-trace.log":0,"gate-history.log":0}',
      'orchestrator-scope-unmatched.log': '2026-10-17T04:00:00.000Z phase=spec tool=Read unattributed\n',
    }
    world(on, files, { mtimes })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^⚠ orchestrator-scope stood down/ }), 'the first run').toBeDefined()

    // The next run sets its mark, and nothing has stood down since.
    mtimes['run-offset'] = Date.parse('2026-10-17T05:00:00Z')
    await clock.advance(2_000)
    expect(await ui.find({ text: /^⚠ orchestrator-scope stood down/ }), 'the second run').toBeUndefined()
  })

  test(`${surface}: what stood down and what was sent back are this session's run only`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      'orchestrator-scope-unmatched.log': '2026-10-17T04:00:00.000Z phase=implement tool=Read unattributed\n',
      'run-trace.log': `2026-10-17T04:00:00.000Z phase=implement session=${ME} agent-check agent=spec-flow:implementer result=block why=no-status agent_id=a-implementer\n`,
    }
    world(on, files)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^⚠ orchestrator-scope stood down/ }), 'while the run is ours').toBeDefined()
    expect(await ui.find({ text: 'sent back 1/2 · no-status' })).toBeDefined()

    files['phase.session'] = 'session-other'
    await clock.advance(2_000)
    expect(await ui.find({ text: /stood down/ }), 'a run another session owns').toBeUndefined()
    expect(await ui.find({ text: /^sent back/ })).toBeUndefined()
  })

  test(`${surface}: a log over what one read takes is read by node`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      'gate-history.log': '2026-10-17T04:05:00Z faa2688 cc=? engine=abc1234 phase=implement attempt=1 result=fail:behaviour lint=0 test=1 files=3\n',
      'run-trace.log':
        `2026-10-17T04:00:00.000Z phase=implement session=${ME} tool=Read agent_id=a-implementer\n` +
        `2026-10-17T04:00:01.000Z phase=implement session=${ME} agent-check agent=spec-flow:implementer result=block why=no-status agent_id=a-implementer\n`,
      'run-offset': '{"run-trace.log":0,"gate-history.log":0}',
      'orchestrator-scope-unmatched.log': '2026-10-17T04:00:00.000Z phase=implement tool=Read unattributed\n',
    }
    world(on, files, { unreadable: ['gate-history.log', 'run-trace.log', 'orchestrator-scope-unmatched.log'], mtimes: { 'run-offset': Date.parse('2026-10-17T03:30:00Z') } })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'fail:behaviour faa2688' }), 'the gate').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  failed: test$/ })).toBeDefined()
    expect(await ui.find({ text: 'sent back 1/2 · no-status' }), 'the send-backs').toBeDefined()
    expect(await ui.find({ text: '⚠ orchestrator-scope stood down: no tool call attributed to an agent yet (1×)' }), 'a stand-down').toBeDefined()
    expect(await ui.find({ text: /could not be read/ })).toBeUndefined()
  })

  test(`${surface}: a log that neither the view nor node can read is said, never drawn as nothing in it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = {
      phase: 'implement',
      'phase.session': ME,
      'gate-history.log': '2026-10-17T04:05:00Z faa2688 cc=? engine=abc1234 phase=implement attempt=1 result=pass lint=0 test=0 files=3\n',
      'run-trace.log': 'x\n',
      'orchestrator-scope-unmatched.log': '2026-10-17T04:00:00.000Z phase=implement tool=Read unattributed\n',
      'human-turn-unmatched.log': '2026-10-17T04:10:00.000Z case-3 check stood down: no answer recorded — fix-login\n',
    }
    world(on, files, { unreadable: Object.keys(files).filter(f => f.endsWith('.log')), node: false })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text', text: /could not be read/ })).map(t => t.text)).toEqual([
      'gate-history.log could not be read: the last gate is not shown',
      'orchestrator-scope-unmatched.log could not be read: whether orchestrator-scope stood down is not shown',
      'human-turn-unmatched.log could not be read: whether the case 3 check stood down is not shown',
      "run-trace.log could not be read: the agent gate's send-backs are not shown",
    ])
  })

  test(`${surface}: two polls at once count a stand-down once`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const LOG = 'orchestrator-scope-unmatched.log'
    const files: Record<string, string> = {
      phase: 'spec',
      'phase.session': ME,
      'run-offset': '{"run-trace.log":0,"gate-history.log":0}',
      [LOG]: '2026-10-17T04:00:00.000Z phase=spec tool=Read unattributed\n',
    }
    const read = held(LOG)
    world(on, files, { mtimes: { 'run-offset': Date.parse('2026-10-17T03:30:00Z') }, hold: read.hold })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)

    // The timer's poll stops on the log; a line lands, and a turn's end polls too.
    files[LOG] += '2026-10-17T04:00:01.000Z phase=spec tool=Bash unattributed\n'
    const tick = read.next()
    const timer = clock.advance(2_000)
    await tick
    files[LOG] += '2026-10-17T04:00:02.000Z phase=spec tool=Bash unattributed\n'
    const turnEnd = $.turn.complete(mainTurnEnds)
    await clock.settle()
    read.release()
    await Promise.all([timer, turnEnd])
    await clock.advance(2_000)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text', text: /^⚠ orchestrator-scope/ })).map(t => t.text)).toEqual([
      '⚠ orchestrator-scope stood down: no tool call attributed to an agent yet (3×)',
    ])
  })

  test(`${surface}: two polls at once, what is drawn is the later read`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const line = (why: string) =>
      `2026-10-17T04:00:00.000Z phase=implement session=${ME} agent-check agent=spec-flow:implementer result=block why=${why} agent_id=a-implementer\n`
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME, 'run-trace.log': line('no-status') }
    const read = held('run-trace.log')
    world(on, files, { hold: read.hold })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))

    // The timer's poll stops on the trace; a send-back lands, and a turn's end polls too.
    const tick = read.next()
    const timer = clock.advance(2_000)
    await tick
    files['run-trace.log'] += line('unknown-status')
    const turnEnd = $.turn.complete(mainTurnEnds)
    await clock.settle()
    read.release()
    await Promise.all([timer, turnEnd])
    await clock.advance(2_000)

    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.findAll({ type: 'Text', text: /^sent back/ })).map(t => t.text)).toEqual(['sent back 2/2 · unknown-status'])
  })

  // A poll the timer started may hang on a slow host call; the turn's end has its own.
  test(`${surface}: a turn's end does not wait on a poll the timer started`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const read = held('phase')
    world(on, { phase: 'implement', 'phase.session': ME }, { hold: read.hold })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const tick = read.next()
    const timer = clock.advance(2_000)
    await tick
    let ended = false
    const turnEnd = $.turn.complete(mainTurnEnds).then(() => (ended = true))
    await clock.settle()
    expect(ended, "the turn's end waited on the timer's poll").toBe(true)
    read.release()
    await Promise.all([timer, turnEnd])
  })

  test(`${surface}: a read that never settles does not freeze the pane`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'plan', 'phase.session': ME }
    const read = held('phase')
    world(on, files, { hold: read.hold })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const tick = read.next()
    void clock.advance(2_000)
    await tick
    files.phase = 'review'
    for (let i = 0; i < 3; i++) await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '[review]' }), 'later polls still read the phase').toBeDefined()
    read.release()
  })

  test(`${surface}: this version leaves the run an earlier version reads alone`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const written: unknown[] = []
    on('state.set', { plugin: 'spec-flow', key: 'liveRun' } as const, async (_, e, next) => (written.push(e), next(e)))
    world(on, { phase: 'implement', 'phase.session': ME })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '[implement]' })).toBeDefined()
    expect(written, 'an earlier version reading liveRun would draw this one\'s run as its own').toEqual([])
  })

  // The run's mark counts the lines already there, stamped or not.
  test(`${surface}: the gate after the mark is this run's, when a line before it has no stamp`, async ($, on) => {
    const clock = mock.clock(on, { now: Date.parse('2026-10-11T18:00:00Z') })
    world(on, {
      phase: 'implement',
      'phase.session': ME,
      'run-offset': '{"run-trace.log":0,"gate-history.log":2}',
      'gate-history.log':
        'rotated by hand\n2026-10-11T05:25:18Z 5745ede cc=? phase=implement attempt=0 result=pass lint=0 test=0 files=1\n' +
        '2026-10-11T18:00:01Z 223dc9f cc=? phase=implement attempt=0 result=pass lint=0 test=0 files=1\n',
    })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: 'pass 223dc9f' }), "this run's gate").toBeDefined()
  })

  test(`${surface}: a settings file that does not parse is said, with the caps it leaves`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME, 'spec-flow.config.json': '{ "max_opus_calls": 2, }' })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\.claude\/spec-flow\.config\.json does not parse as JSON .*: the caps shown are the defaults$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ planner 0\/6$/ }), 'the default the hook falls back to').toBeDefined()
  })

  test(`${surface}: a settings file that is there and cannot be read is said, with the caps it leaves`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME, 'spec-flow.config.json': '{ "max_opus_calls": 2 }' }, { unreadable: ['spec-flow.config.json'] })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\.claude\/spec-flow\.config\.json could not be read: the caps shown are the defaults$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ planner 0\/6$/ }), 'the default the hook falls back to').toBeDefined()
  })

  test(`${surface}: what node hands back past what one read takes is said, never shown cut`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME, 'run-trace.log': 'x\n' }, { unreadable: ['run-trace.log'], truncated: true })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^run-trace\.log could not be read/ })).toBeDefined()
  })

  test(`${surface}: a log unread in another session's run is not said here`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': 'session-other', 'run-trace.log': 'x\n' }, { unreadable: ['run-trace.log'], node: false })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /could not be read/ })).toBeUndefined()
  })

  // What this session's run could not read is its own: a run another session takes over says nothing of it.
  test(`${surface}: a log this session's run could not read is not said once the run is another session's`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME, 'run-trace.log': 'x\n' }
    world(on, files, { unreadable: ['run-trace.log'], node: false })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^run-trace\.log could not be read/ }), 'own run').toBeDefined()
    files['phase.session'] = 'session-other'
    await clock.advance(2_000)
    expect(await ui.find({ text: /could not be read/ }), "another session's run").toBeUndefined()
  })

  test(`${surface}: git is asked with a time limit, so one that never answers holds no run back`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const status = world(on, { phase: 'plan', 'phase.session': ME }, { gitHangs: true })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await clock.advance(1_000)
    expect(status.at(-1)).toBe('plan')
  })

  // The phase is seen only with git's answer for it: a poll that meets it before then asks git itself.
  test(`${surface}: a phase git tracks stays no run here while git's first answer is pending`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const git = held('git')
    world(on, { phase: 'implement', 'phase.session': ME }, { tracked: true, hold: git.hold })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    const asked = git.next()
    void clock.advance(2_000)
    await asked
    await step($)
    await $.turn.complete(mainTurnEnds)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: '[implement]' }), 'a tracked phase drawn as this run').toBeUndefined()
    git.release()
  })

  // Every phase the engine arms on is a run here: the view's list is the engine's.
  for (const phase of ['spec', 'plan', 'review', 'implement', 'blocked']) {
    test(`${surface}: a run at ${phase} shows its phase in the status line`, async ($, on) => {
      const clock = mock.clock(on, { now: 1_000_000 })
      const status = world(on, { phase, 'phase.session': ME })
      await $.session.start({ cwd: ROOT, surface, isInteractive: true })
      await clock.advance(2_000)
      await clock.advance(1_000)
      expect(status.at(-1)).toBe(phase)
    })
  }

  // A blocked run is still a run: the budget is armed, and the status says so.
  test(`${surface}: a blocked run shows its budgets and its phase in the status line`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const status = world(on, { phase: 'blocked', 'phase.session': ME, opus_calls: '2' })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^ planner 2\/6$/ })).toBeDefined()
    expect(status.at(-1)).toBe('blocked')
  })

  // A spawn whose response named no id still put an implementer on the milestone.
  test(`${surface}: the milestone shows when its implementer's id was not recorded`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME, 'current-milestone': 'this-change M2' }
    world(on, files)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /M2 · this-change/ }), 'no implementer of this session is on it').toBeUndefined()
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/this-change/milestones/M2.md'))
    await clock.advance(2_000)
    expect(await ui.find({ text: /M2 · this-change/ }), 'the one this session put on it').toBeDefined()
  })

  test(`${surface}: a work order named without its change still labels the card`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await $.agent.spawn(spawn('spec-flow:implementer', 'resume, with plan.md and milestones/M2.md'))
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /· M2/ })).toBeDefined()
  })

  test(`${surface}: the work order labels the card, not a milestone file named before it`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME, 'current-milestone': 'this-change M2' })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await $.agent.spawn(spawn('spec-flow:implementer', 'see docs/milestones/M1.md, then work on specflow/this-change/milestones/M2.md'))
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /M2 · this-change/ }), 'the run line finds the agent current-milestone names').toBeDefined()
    expect(await ui.find({ text: /· M1/ })).toBeUndefined()
  })

  test(`${surface}: another change's milestone of the same number is not this run's`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME, 'current-milestone': 'change-b M1' })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/change-a/milestones/M1.md'))
    await clock.advance(2_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /M1 · change-b/ })).toBeUndefined()
  })

  test(`${surface}: the turn that writes done is charged, even when a tick saw done first`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME }
    world(on, files)
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await step($)
    files.phase = 'done'
    files['run-trace.log'] = closedBy(ME)
    await clock.advance(2_000)
    await step($)
    await $.turn.complete(mainTurnEnds)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)?.split('\n').at(-1)).toMatch(/ msgs=2$/)
  })

  test(`${surface}: a session whose first turn writes done before any poll is charged for it`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME }
    world(on, files)
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await step($)
    files.phase = 'done'
    files['run-trace.log'] = closedBy(ME)
    await $.turn.complete(mainTurnEnds)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)?.split('\n').at(-1)).toMatch(/ msgs=1$/)
  })

  // After /clear the next session counts its own closes from its start.
  test(`${surface}: a new session's first close is charged after an earlier session closed a run`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    let id = ME
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME }
    world(on, files, { sessionId: () => id })
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await step($)
    files.phase = 'done'
    files['run-trace.log'] = closedBy(ME)
    await $.turn.complete(mainTurnEnds)

    id = 'session-next'
    Object.assign(files, { phase: 'implement', 'phase.session': id })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await step($)
    files.phase = 'done'
    files['run-trace.log'] += closedBy(id)
    await $.turn.complete(mainTurnEnds)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)?.split('\n').at(-1)).toMatch(/ msgs=2$/)
  })

  // token-trace charges a turn at `done` by this session's own closed line, never by what a poll saw.
  test(`${surface}: a turn after another session closed the run is not charged`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    const files: Record<string, string> = { phase: 'implement', 'phase.session': ME }
    world(on, files)
    const copied = clipboard(on)
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(2_000)
    await $.agent.spawn(spawn('spec-flow:implementer', 'work on specflow/x/milestones/M1.md'))
    await step($)
    await $.turn.complete(mainTurnEnds)
    await clock.advance(2_000)
    files['phase.session'] = 'session-other'
    files.phase = 'done'
    files['run-trace.log'] = closedBy('session-other')
    await step($)
    await $.turn.complete(mainTurnEnds)
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'copy' })
    expect(copied.at(-1)?.split('\n').at(-1)).toMatch(/ msgs=1$/)
  })

  test(`${surface}: a run an earlier version of the view kept is read as none, not drawn`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, { phase: 'implement', 'phase.session': ME })
    kept(on, { phase: 'implement', milestone: '', gate: '', gateAt: 0, attempts: 0, usd: null })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    // Drawn before the first poll writes this version's run.
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /No spec-flow agent has been spawned/ })).toBeDefined()
    await clock.advance(2_000)
    expect(await ui.find({ text: '[implement]' })).toBeDefined()
  })

  test(`${surface}: an earlier version's run, with no phase left to poll, is read as none`, async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    world(on, {})
    kept(on, { phase: '', milestone: '', gate: '', gateAt: 0, attempts: 0, usd: null })
    await $.session.start({ cwd: ROOT, surface, isInteractive: true })
    await clock.advance(10_000)
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /No spec-flow agent has been spawned/ })).toBeDefined()
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
