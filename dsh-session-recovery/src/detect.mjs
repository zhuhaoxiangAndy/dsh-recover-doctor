// src/detect.mjs — 未闭合轮检测纯函数（零依赖，node --check 可独立校验）。
//
// 判定依据与宿主 crash-repair（core/session/src/repair.ts interruptedTurnClosers）
// 完全同构：事件流最后一个 turn/start 没有对应 turn/end 即为中断（开放轮）。
// 本模块只读不写：绝不合成宿主事件，只报告。
//
// 事件类型事实来源（dsh 0.2.1-rc.5 checkout）：
// - core/session/src/types.ts:276  'turn/start'  data: { turn: number }
// - core/session/src/types.ts:285  'turn/end'    data: { turn, reason: TurnEndReason }
//   （reason.kind === 'interrupted' 是宿主 resume/cold-read 时补写的关闭标记）
// - repair.ts:37-76 同款状态机：turn/start、turn/end、step/start、step/end、
//   assistant/message（tool-call 块登记 pendingCalls）、tool/call（记 callSeq）、
//   tool/result（销账）；其余类型不移动游标。
// - repair.ts:14-18 TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN 两个恢复码。
// - session-title/src/types.ts:41-48 'session/title' data: { title, messageSeqs, source }。

/** 恢复码：助手已请求但从未记录 tool/call 的调用。 */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED'
/** 恢复码：已记录 tool/call 但未持久化结果的调用。 */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN'

/**
 * @typedef {{type: string, seq: number, time?: number, data?: any}} ScanEvent
 * @typedef {Object} InterruptionReport
 * @property {boolean} interrupted 会话尾部是否存在未闭合轮。
 * @property {number|undefined} openTurn 开放轮的 turn 号（未中断为 undefined）。
 * @property {number|undefined} openStep 开放 step 号。
 * @property {number|undefined} lastTurnEndSeq 最后一条 turn/end 的 seq（fork 边界）。
 * @property {number|undefined} lastTurnEndTurn 最后闭合轮的 turn 号。
 * @property {number} turnCount 已闭合轮数。
 * @property {number} lastSeq 最后一条事件的 seq（-1 = 空日志）。
 * @property {number} interruptedAtSeq 未闭合轮的 turn/start seq（未中断为 -1）。
 * @property {{callId: string, code: string, seq?: number}[]} pendingCalls 待恢复的工具调用。
 * @property {number} outcomeUnknown TOOL_OUTCOME_UNKNOWN 计数（= crash-repair 待修复数）。
 * @property {number} notStarted TOOL_NOT_STARTED 计数。
 * @property {number} tailSyntheticRepair 尾部已被宿主合成 closer 关闭（turn/end reason=interrupted）时的待修复调用数；0 = 无。
 */

/**
 * 扫描会话事件流，判定尾部是否有未闭合轮。与 repair.ts 同构的状态机，
 * 且对已被宿主合成 closer 关闭的中断（turn/end reason.kind === 'interrupted'）
 * 也报 pendingCalls（供 /recover list 展示 crash-repair 待修复数），但
 * interrupted 只对「当前真的开着轮」为 true。
 * @param {readonly ScanEvent[]} events - 会话事件（inspect().events，seq 连续）。
 * @returns {InterruptionReport}
 */
export function scanInterruption(events) {
  /** @type {InterruptionReport} */
  const report = {
    interrupted: false,
    openTurn: undefined,
    openStep: undefined,
    lastTurnEndSeq: undefined,
    lastTurnEndTurn: undefined,
    turnCount: 0,
    lastSeq: -1,
    interruptedAtSeq: -1,
    pendingCalls: [],
    outcomeUnknown: 0,
    notStarted: 0,
    tailSyntheticRepair: 0,
  }
  if (!Array.isArray(events) || events.length === 0) return report

  let openTurn = null
  let openStep = null
  /** @type {Map<string, {step: number, callSeq?: number}>} */
  let pending = new Map()
  /** @type {Map<string, {step: number, callSeq?: number}>} */
  let tailPending = new Map()
  let tailOpenTurn = null
  let interruptedAtSeq = -1
  /** @type {number|undefined} */
  let lastTurnEndSeq
  /** @type {number|undefined} */
  let lastTurnEndTurn
  let turnCount = 0
  let lastSeq = -1
  let closedByInterrupted = false

  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    const seq = typeof event.seq === 'number' ? event.seq : lastSeq
    lastSeq = Math.max(lastSeq, seq)
    switch (event.type) {
      case 'turn/start': {
        // 连续 turn/start 无 turn/end（防御：正常日志不会出现）按新开放轮处理。
        openTurn = /** @type {{data?: {turn?: number}}} */ (event).data?.turn ?? openTurn
        openStep = null
        pending = new Map()
        tailPending = new Map()
        tailOpenTurn = openTurn
        closedByInterrupted = false
        if (interruptedAtSeq < 0) interruptedAtSeq = seq
        break
      }
      case 'turn/end': {
        turnCount++
        lastTurnEndSeq = seq
        lastTurnEndTurn = /** @type {{data?: {turn?: number}}} */ (event).data?.turn
        openTurn = null
        openStep = null
        pending = new Map()
        // reason.kind === 'interrupted'：宿主 resume/cold-read 合成的关闭标记。
        const reason = /** @type {{data?: {reason?: {kind?: string}}}} */ (event).data?.reason
        if (reason?.kind === 'interrupted') {
          closedByInterrupted = true
          tailOpenTurn = null
        } else {
          tailOpenTurn = null
          tailPending = new Map()
          interruptedAtSeq = -1
          closedByInterrupted = false
        }
        break
      }
      case 'step/start':
        openStep = /** @type {{data?: {step?: number}}} */ (event).data?.step
        break
      case 'step/end':
        pending.clear()
        openStep = null
        break
      case 'assistant/message': {
        // 助手消息携带 tool-call 块：每个块登记为 pending，直到同 callId 的
        // tool/result 落账（repair.ts:54-60 同款）。
        const content = /** @type {{data?: {message?: {content?: any[]}}}} */ (event).data?.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === 'tool-call' && typeof block.id === 'string') {
              const step = /** @type {{data?: {step?: number}}} */ (event).data?.step ?? 0
              pending.set(block.id, { step })
            }
          }
        }
        break
      }
      case 'tool/call': {
        const callId = /** @type {{data?: {callId?: string}}} */ (event).data?.callId
        const entry = callId ? pending.get(callId) : undefined
        if (entry) entry.callSeq = seq
        break
      }
      case 'tool/result': {
        const callId = /** @type {{data?: {message?: {source?: {callId?: string}}}}} */ (event).data?.message?.source?.callId
        if (callId) {
          pending.delete(callId)
          tailPending.delete(callId)
        }
        // 结果 isError 且带恢复码：宿主合成 closer 已把该调用记为待核实。
        const message = /** @type {{data?: {message?: {content?: any[]}}}} */ (event).data?.message
        if (Array.isArray(message?.content)) {
          for (const block of message.content) {
            const code = /** @type {{data?: {error?: {code?: string}}}} */ (event).data?.error?.code
            if (block && block.type === 'tool-result' && block.isError && (code === TOOL_OUTCOME_UNKNOWN || code === TOOL_NOT_STARTED)) {
              if (code === TOOL_OUTCOME_UNKNOWN) report.outcomeUnknown++
              else report.notStarted++
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  // 尾部状态归档：中断轮里每个仍在 pending 的调用都是待恢复项。
  if (openTurn !== null) {
    report.interrupted = true
    report.openTurn = openTurn
    report.openStep = openStep ?? undefined
    report.interruptedAtSeq = interruptedAtSeq
    for (const [callId, meta] of pending) {
      report.pendingCalls.push({ callId, code: meta.callSeq !== undefined ? TOOL_OUTCOME_UNKNOWN : TOOL_NOT_STARTED, seq: meta.callSeq })
      if (meta.callSeq !== undefined) report.outcomeUnknown++
      else report.notStarted++
    }
  } else if (closedByInterrupted) {
    // 尾轮已被宿主合成 closer 关闭：报告其待修复调用数（从 closer 前的
    // pending 恢复——重放一遍尾部轮内的登记）。
    report.tailSyntheticRepair = tailSyntheticPendingCount(events)
  }
  report.turnCount = turnCount
  report.lastTurnEndSeq = lastTurnEndSeq
  report.lastTurnEndTurn = lastTurnEndTurn
  report.lastSeq = lastSeq
  return report
}

/**
 * 统计被宿主合成 closer 关闭的尾轮内的待修复调用数：找最后一条
 * reason=interrupted 的 turn/end，重放该轮登记，减去工具结果销账。
 * （供 /recover list 展示「crash-repair 待修复数」；主循环里 tool/result
 * 的 isError+恢复码计数已在 outcomeUnknown/notStarted 里。）
 * @param {readonly ScanEvent[]} events
 * @returns {number}
 */
function tailSyntheticPendingCount(events) {
  // 只数 tool/result 事件 error.code 命中恢复码的条数（closer 每个调用一条）。
  let count = 0
  for (const event of events) {
    if (event?.type !== 'tool/result') continue
    const code = /** @type {{data?: {error?: {code?: string}}}} */ (event).data?.error?.code
    if (code === TOOL_OUTCOME_UNKNOWN || code === TOOL_NOT_STARTED) count++
  }
  return count
}

/**
 * 未中断会话的 fork 边界：最后闭合轮的 turn/end seq。
 * @param {InterruptionReport} report
 * @returns {number|undefined}
 */
export function forkBoundaryOf(report) {
  return report.lastTurnEndSeq
}

/**
 * 从事件流提取最新标题（session/title latest-wins）。
 * @param {readonly ScanEvent[]} events
 * @returns {string|undefined}
 */
export function titleOf(events) {
  let title
  for (const event of events) {
    if (event?.type === 'session/title') {
      const t = /** @type {{data?: {title?: string}}} */ (event).data?.title
      if (typeof t === 'string' && t.length > 0) title = t
    }
  }
  return title
}

/**
 * 最后活动时间：最后一条带 time 的事件。
 * @param {readonly ScanEvent[]} events
 * @returns {number|undefined}
 */
export function lastActivityOf(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const time = events[i]?.time
    if (typeof time === 'number' && Number.isFinite(time)) return time
  }
  return undefined
}
