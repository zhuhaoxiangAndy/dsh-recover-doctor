// tests/smoke.mjs — dsh-session-recovery 冒烟测试（零依赖，node:test）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  scanInterruption, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN,
  forkBoundaryOf, titleOf, lastActivityOf,
} from '../src/detect.mjs'
import { applyConfig, renderTemplate, DEFAULT_RESUME_TEMPLATE, DEFAULTS } from '../src/config.mjs'
import { parseRecoverInput, formatList, pickRow } from '../src/commands.mjs'
import { isExcludedWorkspace } from '../src/glob.mjs'

/** 构造事件流辅助。 */
const ev = (type, seq, data) => ({ type, seq, time: 1000 + seq, data })

test('detect: 完整闭合会话不算中断', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('step/start', 1, { step: 1 }),
    ev('step/end', 2),
    ev('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
  ]
  const report = scanInterruption(events)
  assert.equal(report.interrupted, false)
  assert.equal(report.turnCount, 1)
  assert.equal(report.lastTurnEndSeq, 3)
  assert.equal(report.pendingCalls.length, 0)
})

test('detect: 尾部未闭合轮 → interrupted', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 2, { turn: 2 }),
    ev('step/start', 3, { step: 1 }),
  ]
  const report = scanInterruption(events)
  assert.equal(report.interrupted, true)
  assert.equal(report.openTurn, 2)
  assert.equal(report.interruptedAtSeq, 2)
  assert.equal(report.lastTurnEndSeq, 1)
  assert.equal(report.forkBoundary, undefined) // 只在行对象上补，报告本身无此字段
})

test('detect: 开放轮里的 pending 工具调用区分两种恢复码', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('assistant/message', 1, {
      step: 1,
      message: { content: [{ type: 'tool-call', id: 'call-a' }, { type: 'tool-call', id: 'call-b' }] },
    }),
    ev('tool/call', 2, { callId: 'call-a' }), // 已记录开始 → OUTCOME_UNKNOWN
    // call-b 从未记录 tool/call → NOT_STARTED
  ]
  const report = scanInterruption(events)
  assert.equal(report.interrupted, true)
  assert.equal(report.pendingCalls.length, 2)
  const byId = Object.fromEntries(report.pendingCalls.map((c) => [c.callId, c.code]))
  assert.equal(byId['call-a'], TOOL_OUTCOME_UNKNOWN)
  assert.equal(byId['call-b'], TOOL_NOT_STARTED)
  assert.equal(report.outcomeUnknown, 1)
  assert.equal(report.notStarted, 1)
})

test('detect: tool/result 销账后不再计入 pending', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('assistant/message', 1, { step: 1, message: { content: [{ type: 'tool-call', id: 'call-a' }] } }),
    ev('tool/call', 2, { callId: 'call-a' }),
    ev('tool/result', 3, { message: { source: { callId: 'call-a' }, content: [{ type: 'tool-result' }] } }),
  ]
  const report = scanInterruption(events)
  assert.equal(report.pendingCalls.length, 0)
})

test('detect: 空事件流安全返回', () => {
  const report = scanInterruption([])
  assert.equal(report.interrupted, false)
  assert.equal(report.lastSeq, -1)
  assert.equal(report.turnCount, 0)
})

test('detect: 非数组输入安全返回', () => {
  for (const bad of [null, undefined, 42, 'x', {}]) {
    const report = scanInterruption(bad)
    assert.equal(report.interrupted, false)
  }
})

test('detect: forkBoundaryOf 返回最后闭合轮 seq', () => {
  const events = [
    ev('turn/start', 0, { turn: 1 }),
    ev('turn/end', 1, { turn: 1, reason: { kind: 'completed' } }),
    ev('turn/start', 2, { turn: 2 }),
  ]
  const report = scanInterruption(events)
  assert.equal(forkBoundaryOf(report), 1)
})

test('detect: titleOf 取最新标题', () => {
  const events = [
    ev('session/title', 0, { title: '旧标题' }),
    ev('session/title', 1, { title: '新标题' }),
  ]
  assert.equal(titleOf(events), '新标题')
})

test('detect: lastActivityOf 取最后带 time 的事件', () => {
  const events = [{ type: 'x', seq: 0, time: 111 }, { type: 'y', seq: 1 }, { type: 'z', seq: 2, time: 222 }]
  assert.equal(lastActivityOf(events), 222)
})

test('config: applyConfig 用默认值填充缺失字段', () => {
  const cfg = applyConfig(undefined)
  assert.equal(cfg.notifyOnBoot, true)
  assert.equal(cfg.resumeMessageTemplate, DEFAULT_RESUME_TEMPLATE)
  assert.equal(cfg.maxScanSessions, DEFAULTS.maxScanSessions)
  assert.deepEqual([...cfg.autoResumeIds], [])
})

test('config: 非法字段回退默认值', () => {
  const cfg = applyConfig({
    notifyOnBoot: 'yes',
    maxScanSessions: 9999,
    resumeMessageTemplate: 'missing placeholder',
    excludeWorkspaceGlobs: 'not-array',
  })
  assert.equal(cfg.notifyOnBoot, true)
  assert.equal(cfg.maxScanSessions, DEFAULTS.maxScanSessions)
  assert.equal(cfg.resumeMessageTemplate, DEFAULT_RESUME_TEMPLATE)
  assert.deepEqual([...cfg.excludeWorkspaceGlobs], [])
})

test('config: 合法字段被采纳', () => {
  const cfg = applyConfig({
    notifyOnBoot: false,
    maxScanSessions: 7,
    resumeMessageTemplate: '继续 {turn} 轮',
    excludeWorkspaceGlobs: ['node_modules'],
    autoResumeIds: ['s-1'],
  })
  assert.equal(cfg.notifyOnBoot, false)
  assert.equal(cfg.maxScanSessions, 7)
  assert.equal(cfg.resumeMessageTemplate, '继续 {turn} 轮')
  assert.deepEqual([...cfg.excludeWorkspaceGlobs], ['node_modules'])
  assert.deepEqual([...cfg.autoResumeIds], ['s-1'])
})

test('config: renderTemplate 替换占位符', () => {
  const text = renderTemplate('轮 {turn} seq {seq} 标题 {title} id {sessionId}', {
    turn: 3, seq: 42, title: 'T', sessionId: 'S',
  })
  assert.equal(text, '轮 3 seq 42 标题 T id S')
})

test('config: renderTemplate 缺失字段保留原占位符', () => {
  const text = renderTemplate('轮 {turn} seq {seq}', { turn: 1 })
  assert.equal(text, '轮 1 seq {seq}')
})

test('commands: parse list', () => {
  assert.deepEqual(parseRecoverInput('list'), { action: 'list' })
  assert.deepEqual(parseRecoverInput('  list  '), { action: 'list' })
  assert.equal(parseRecoverInput('list extra').error !== undefined, true)
})

test('commands: parse resume/fork/dismiss', () => {
  assert.deepEqual(parseRecoverInput('resume abc'), { action: 'resume', id: 'abc' })
  assert.deepEqual(parseRecoverInput('fork abc 12'), { action: 'fork', id: 'abc', seq: 12 })
  assert.deepEqual(parseRecoverInput('dismiss abc'), { action: 'dismiss', id: 'abc' })
})

test('commands: parse 错误分支', () => {
  assert.equal(parseRecoverInput('resume').error !== undefined, true)
  assert.equal(parseRecoverInput('fork abc -1').error !== undefined, true)
  assert.equal(parseRecoverInput('fork abc x1').error !== undefined, true)
  assert.equal(parseRecoverInput('bogus').action, 'help')
  assert.equal(parseRecoverInput('').action, 'help')
})

test('commands: formatList 空列表', () => {
  const text = formatList([], { scanned: 5, skipped: 0 })
  assert.match(text, /没有检测到中断会话/)
})

test('commands: formatList 渲染中断行', () => {
  const rows = [{
    sessionId: 'sess-123', title: '测试会话', cwd: 'C:/work', updatedAt: 1700000000000,
    openTurn: 2, interruptedAtSeq: 10, lastSeq: 12, tailSyntheticRepair: 0,
    outcomeUnknown: 1, notStarted: 0, pendingCalls: [{ callId: 'call-a', code: 'TOOL_OUTCOME_UNKNOWN' }],
  }]
  const text = formatList(rows, { scanned: 3, skipped: 0 })
  assert.match(text, /sess-123/)
  assert.match(text, /测试会话/)
  assert.match(text, /第 2 轮/)
  assert.match(text, /\/recover resume/)
})

test('commands: pickRow 精确与前缀唯一', () => {
  const rows = [{ sessionId: 'abc' }, { sessionId: 'abd' }]
  assert.equal(pickRow(rows, 'abc')?.sessionId, 'abc')
  assert.equal(pickRow(rows, 'abc').sessionId, 'abc')
  assert.equal(pickRow(rows, 'ab'), null) // 前缀不唯一
  assert.equal(pickRow(rows, 'zzz'), null)
})

test('glob: 空模式永不排除', () => {
  assert.equal(isExcludedWorkspace('C:/work', []), false)
  assert.equal(isExcludedWorkspace('C:/work', undefined), false)
})

test('glob: 前缀与段匹配（Windows 大小写不敏感）', () => {
  assert.equal(isExcludedWorkspace('C:/Users/user/work', ['c:/users/user']), true)
  assert.equal(isExcludedWorkspace('C:/Users/user/work', ['C:\\Users\\user']), true)
  assert.equal(isExcludedWorkspace('C:/Users/user/work', ['C:/other']), false)
})

test('glob: ** 通配与段包含', () => {
  assert.equal(isExcludedWorkspace('C:/a/node_modules/pkg', ['**/node_modules/**']), true)
  assert.equal(isExcludedWorkspace('C:/a/src', ['**/node_modules/**']), false)
  assert.equal(isExcludedWorkspace('C:/a/b/c', ['**']), true)
})

test('glob: 单段 * 通配', () => {
  assert.equal(isExcludedWorkspace('C:/a/pkg/b', ['a/*/b']), true)
  assert.equal(isExcludedWorkspace('C:/x/y/b', ['a/*/b']), false)
  assert.equal(isExcludedWorkspace('C:/a/any', ['a/*']), true)
})

/* ------------------------------------------------------------------ doctor --
 * v0.2.0 迁移体检。判据来自 2026-11-11 的真实事故：一次工作区迁移同时要改
 * 四处状态（归档文件、帧 0 的 cwd、workspace.json、投影缓存），只改一部分就
 * 会出现「侧栏能看见但点进去没历史」或「同一会话出现两份」。
 * 这些用例把当时的真实数据形状固化成回归断言。
 */
import { projectKey, auditOwnership, auditRegistryShape, findTitleConflicts, formatDoctor, isUnderPath } from '../src/doctor.mjs'

test('projectKey matches DSH encoder exactly (the ~0021 accident)', () => {
  // `!` is U+0021 -> ~0021. Not knowing this is why the reported ENOENT path
  // looked unrecognisable. NOTE: these are Windows paths, so every separator is
  // a DOUBLED backslash in the source.
  assert.equal(projectKey('D:\\Downloads\\!ISA104'), '--D-Downloads-~0021ISA104--')
  assert.equal(projectKey('D:\\Downloads\\SOE888'), '--D-Downloads-SOE888--')
  assert.equal(projectKey('D:\\Downloads\\SOE888\\desktop-ball-pet'), '--D-Downloads-SOE888-desktop-ball-pet--')
  // Consecutive separators collapse to ONE hyphen.
  assert.equal(projectKey('C:\\\\a\\\\b'), '--C-a-b--')
  // `+` and `~` are escaped with four upper-case hex digits.
  assert.equal(projectKey('C:\\a+b'), '--C-a~002Bb--')
  assert.equal(projectKey('C:\\a~b'), '--C-a~007Eb--')
  assert.throws(() => projectKey(''))
})

test('auditRegistryShape catches the dangling workspaceId that hid history', () => {
  // Real shape: workspaceIds had 16 entries, the table only 15. The extra id
  // made every join-based reader classify the session as unregistered, which
  // surfaced as "the sidebar shows it but opening it has no history".
  const bad = auditRegistryShape({
    global: { workspaceIds: ['a', 'b', 'dead-id'] },
    tables: { workspaces: { a: { title: 'A' }, b: { title: 'B' } } },
  })
  assert.equal(bad.ok, false)
  assert.equal(bad.problems.length, 1)
  assert.equal(bad.problems[0].code, 'registry-dangling-id')

  // The reverse (record not listed) is equally broken.
  const orphan = auditRegistryShape({
    global: { workspaceIds: ['a'] },
    tables: { workspaces: { a: { title: 'A' }, b: { title: 'B' } } },
  })
  assert.equal(orphan.ok, false)
  assert.equal(orphan.problems[0].code, 'registry-orphan-record')

  // Healthy input stays quiet.
  const ok = auditRegistryShape({
    global: { workspaceIds: ['a', 'b'] },
    tables: { workspaces: { a: { title: 'A' }, b: { title: 'B' } } },
  })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.problems, [])
})

test('auditRegistryShape flags duplicate titles as a warning, not a failure', () => {
  const r = auditRegistryShape({
    global: { workspaceIds: ['a', 'b'] },
    tables: { workspaces: { a: { title: 'Same' }, b: { title: 'Same' } } },
  })
  assert.equal(r.ok, true, 'a shared title is a warning; two workspaces may legitimately share one')
  assert.ok(r.warnings.some((w) => w.code === 'duplicate-workspace-title'))
})

test('auditOwnership catches one session owned by two workspaces (duplicate rows)', () => {
  const r = auditOwnership({
    workspaces: [
      { workspaceId: 'w1', path: 'C:/x', sessionIds: ['s1'] },
      { workspaceId: 'w2', path: 'C:/y', sessionIds: ['s1'] },
    ],
    sessions: [{ sessionId: 's1', cwd: 'C:/x' }],
  })
  assert.equal(r.problems.length, 1)
  assert.equal(r.problems[0].code, 'session-multi-owner')
})

test('auditOwnership warns when a cwd matches no registered workspace', () => {
  const r = auditOwnership({
    workspaces: [{ workspaceId: 'w1', path: 'C:/x', sessionIds: [] }],
    sessions: [{ sessionId: 's9', cwd: 'D:/elsewhere' }],
  })
  assert.equal(r.problems.length, 0, 'an unowned cwd is a hint, not corruption')
  assert.ok(r.warnings.some((w) => w.code === 'cwd-not-registered'))
})

test('findTitleConflicts detects the RBE999 workspace/group collision', () => {
  // The reported bug: a workspace titled "RBE999" coexisting with
  // "RBE999/Sim-to-Real..." — the same row could be placed twice.
  const c = findTitleConflicts([
    { workspaceId: 'rbe', title: 'RBE999' },
    { workspaceId: 'sim', title: 'RBE999/Sim-to-Real_GR00T-N1.7+SO-101' },
  ])
  assert.equal(c.length, 1)
  assert.equal(c[0].title, 'RBE999')
  assert.deepEqual(c[0].workspaceIds, ['rbe'])
  assert.deepEqual(c[0].children, ['sim'])

  // No collision when the group has no workspace of the same name.
  const none = findTitleConflicts([{ workspaceId: 'sim', title: 'RBE999/Sim' }])
  assert.deepEqual(none, [])
})

test('isUnderPath normalizes separators and never matches a sibling prefix', () => {
  assert.equal(isUnderPath('D:\\Downloads\\RBE999', 'D:/Downloads/RBE999/Sim'), true)
  assert.equal(isUnderPath('D:\\Downloads\\RBE999', 'D:/Downloads/RBE9999/Sim'), false)
  assert.equal(isUnderPath('D:\\Downloads\\RBE999', 'D:/Downloads/RBE999'), false)
  assert.equal(isUnderPath('', 'D:/x'), false)
})

test('formatDoctor reports clean vs broken states differently', () => {
  const clean = formatDoctor({
    registry: { problems: [], warnings: [] },
    ownership: { problems: [], warnings: [], checks: 7 },
    conflicts: [],
  })
  assert.match(clean, /通过/u)
  assert.doesNotMatch(clean, /只读/u)

  const broken = formatDoctor({
    registry: { problems: [{ code: 'registry-dangling-id', detail: 'x' }], warnings: [] },
    ownership: { problems: [], warnings: [], checks: 3 },
    conflicts: [{ title: 'RBE999', workspaceIds: ['a'], children: ['b'] }],
  })
  assert.match(broken, /发现 1 个问题/u)
  assert.match(broken, /registry-dangling-id/u)
  assert.match(broken, /只读/u, 'a broken report must say the command only inspects')
})

test('/recover accepts the doctor subcommand', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(path.join(dir, '../src/commands.mjs'), 'utf8')
  assert.match(src, /action === 'doctor'/u, 'doctor is a recognised subcommand')
  assert.match(src, /doctor 不接受参数/u, 'doctor rejects arguments')
})
