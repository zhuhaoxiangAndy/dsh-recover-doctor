// src/commands.mjs — /recover 命令解析与格式化纯函数（零依赖）。

/**
 * 解析 /recover 的 rawInput。
 * @param {string|undefined} rawInput - 例如 "list"、"resume <id>"、"fork <id> [seq]"、"dismiss <id>"。
 * @returns {{action: 'list'|'doctor'|'audit'|'resume'|'fork'|'dismiss'|'help', id?: string, seq?: number, error?: string}}
 */
export function parseRecoverInput(rawInput) {
  const parts = String(rawInput || '').trim().split(/\s+/).filter((s) => s.length > 0)
  if (parts.length === 0) return { action: 'help' }
  const action = /** @type {any} */ (parts[0].toLowerCase())
  if (action === 'list') {
    if (parts.length > 1) return { action, error: 'list 不接受参数' }
    return { action }
  }
  // v0.2.0: 迁移后一致性体检（只读）。不带参数。
  if (action === 'doctor') {
    if (parts.length > 1) return { action, error: 'doctor 不接受参数' }
    return { action }
  }
  // v0.3.0: 多帧 zstd 完整性体检。传会话 id 前缀，或一个 .zstd 文件绝对路径。
  if (action === 'audit') {
    const id = (parts[1] || '').trim()
    if (!id) return { action, error: '用法：/recover audit <session-id 前缀 | 日志文件路径>' }
    if (parts.length > 2) return { action, error: 'audit 只接受一个参数' }
    return { action, id }
  }
  if (action === 'resume' || action === 'fork' || action === 'dismiss') {
    const id = parts[1]
    if (!id) return { action, error: `用法：/recover ${action} <session-id>${action === 'fork' ? ' [seq]' : ''}` }
    if (action === 'fork' && parts[2] !== undefined) {
      const seq = Number(parts[2])
      if (!Number.isSafeInteger(seq) || seq < 0) {
        return { action, id, error: `seq 必须是非负整数，得到 "${parts[2]}"` }
      }
      return { action, id, seq }
    }
    if (parts.length > (action === 'fork' ? 3 : 2)) {
      return { action, id, error: `参数过多（${parts.length - 1} 个，期望 ${action === 'fork' ? 2 : 1} 个）` }
    }
    return { action, id }
  }
  return { action: 'help', error: `未知子命令 "${parts[0]}"（可用 list | resume | fork | dismiss）` }
}

/**
 * 渲染 /recover list 正文。
 * @param {Array<import('./detect.mjs').InterruptionReport & {sessionId: string, title?: string, cwd?: string, updatedAt?: number}>} rows
 * @param {{scanned: number, skipped: number}} stats
 * @returns {string}
 */
export function formatList(rows, stats) {
  if (rows.length === 0) {
    return `没有检测到中断会话（扫描 ${stats.scanned} 个，跳过 ${stats.skipped} 个）。`
  }
  const header = `中断会话 ${rows.length} 个（扫描 ${stats.scanned}，跳过 ${stats.skipped}）：`
  const body = rows.map((row) => {
    const title = row.title ? `「${row.title}」` : ''
    const cwd = row.cwd ? ` @ ${row.cwd}` : ''
    const updated = typeof row.updatedAt === 'number'
      ? ` 最后活动 ${new Date(row.updatedAt).toISOString().replace('T', ' ').slice(0, 19)}`
      : ''
    const repair = row.tailSyntheticRepair > 0
      ? ` crash-repair 待修复 ${row.tailSyntheticRepair} 调用`
      : row.outcomeUnknown > 0 || row.notStarted > 0
        ? ` 待恢复工具 ${row.outcomeUnknown}+${row.notStarted}`
        : ''
    const pending = row.pendingCalls.length > 0 ? ` [${row.pendingCalls.map((c) => `${c.callId.slice(0, 12)}…:${c.code}`).join(', ')}]` : ''
    return `- ${row.sessionId}${title}${cwd}${updated}\n  中断于第 ${row.openTurn} 轮 (seq ${row.interruptedAtSeq}，尾 seq ${row.lastSeq})${repair}${pending}`
  })
  return [header, ...body, '恢复：/recover resume <id>（注入继续消息）| /recover fork <id> [seq]（保守派生）| /recover dismiss <id>（忽略）'].join('\n')
}

/**
 * 按 id（或唯一前缀）选行。
 * @param {Array<{sessionId: string}>} rows
 * @param {string} id
 * @returns {object|null}
 */
export function pickRow(rows, id) {
  const exact = rows.find((r) => r.sessionId === id)
  if (exact) return exact
  const matches = rows.filter((r) => r.sessionId.startsWith(id))
  return matches.length === 1 ? matches[0] : null
}
