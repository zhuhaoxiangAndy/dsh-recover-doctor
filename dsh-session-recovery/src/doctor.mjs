// src/doctor.mjs — 迁移后一致性体检（零依赖、纯函数优先）。
//
// 为什么需要：一次「把会话迁到另一个工作区」的操作会同时改动四处状态——
//   1) 会话归档文件（sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd）
//   2) 归档文件第 0 帧里的 cwd
//   3) 工作区注册表 workspace.json 的 path / sessionIds / workspaceIds
//   4) 投影缓存 session_projcache/sessions/<id>.json 的 identity.cwd 等字段
// 手工迁移（或进程中途被终止）很容易只改了两三处，症状是：会话在侧栏能看见
// 但点进去没有历史、同一会话出现两份、或工作区名与组名重复导致重复行。
//
// 本模块把这些判据固化成可重复执行的检查，优先使用宿主公开 API
// （sessionController.list + 磁盘统计），不解析日志正文。
//
// 关键事实（来自 2026-11-11 的真实事故，见工作区 TODO_dsh-session-recovery.md）：
//   * DSH 的项目目录名由 projectKey(cwd) 决定：`/`、`\`、`:` 合并成一个 `-`，
//     `[A-Za-z0-9._-]` 原样保留，**其它字符（含 `!`、空格、`~`）转成 `~XXXX`**
//     四位大写十六进制码位，最后包一层 `--...--`。
//     例：`D:\Downloads\!ISA104` -> `--D-Downloads-~0021ISA104--`
//   * 会话日志是**多帧 zstd**，`zstdDecompressSync(整文件)` 只解第一帧且不报错。
//     把整份解压后重压会塌缩成单帧，静默丢掉除首帧外的全部数据。
//   * boot 要求**第 0 帧解压后恰好一行 header**，否则启动白屏。
//
// 本模块只做**只读**检查并给出结论，绝不修改用户的会话或注册表。

const SEPARATORS = new Set(['/', '\\', ':'])

/**
 * 复刻 DSH session-persistence-jsonl 的 projectKey()。
 * @param {string} cwd - 会话的工作目录。
 * @returns {string} `--...--` 形状的项目目录名。
 */
export function projectKey(cwd) {
  const text = String(cwd ?? '')
  if (text.length === 0) throw new Error('projectKey: cwd 不能为空')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (SEPARATORS.has(ch)) {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const trimmed = readable.replace(/^-+/u, '') || 'root'
  return `--${trimmed.slice(0, 251)}--`
}

/** 会话归档的当前文件名（dsh 0.2.x）。 */
export const SESSION_LOG_NAME = 'session.v4.jsonl.zstd'

/**
 * 检查一处 workspace 记录与它名下会话的一致性（纯函数）。
 *
 * 判据：
 *  - 会话的 cwd 必须等于某个工作区的 path（`attachSession` 要求 `header.cwd === workspace.path`）；
 *  - 一个会话只能被**恰好一个**工作区记账，否则侧栏会出现两条同名会话；
 *  - 会话不能同时出现在 archivedSessionIds 里。
 *
 * @param {{sessions: Array<{sessionId: string, cwd?: string}>, workspaces: Array<{workspaceId: string, path?: string, title?: string, sessionIds?: string[]}>, archivedSessionIds?: string[]}} input
 * @returns {{problems: Array<{code: string, detail: string}>, warnings: Array<{code: string, detail: string}>, checks: number}}
 */
export function auditOwnership(input) {
  const problems = []
  const warnings = []
  const workspaces = Array.isArray(input?.workspaces) ? input.workspaces : []
  const sessions = Array.isArray(input?.sessions) ? input.sessions : []
  const archived = new Set(Array.isArray(input?.archivedSessionIds) ? input.archivedSessionIds : [])

  // 1. 同一 sessionId 被多个工作区记账 -> 侧栏重复
  const owners = new Map()
  for (const ws of workspaces) {
    for (const sid of Array.isArray(ws?.sessionIds) ? ws.sessionIds : []) {
      if (!owners.has(sid)) owners.set(sid, [])
      owners.get(sid).push(ws.workspaceId)
    }
  }
  for (const [sid, list] of owners) {
    if (list.length > 1) {
      problems.push({
        code: 'session-multi-owner',
        detail: `会话 ${sid} 被 ${list.length} 个工作区同时记账（${list.join(', ')}）——侧栏会出现重复行`,
      })
    }
  }

  // 2. cwd 对不上任何工作区 path
  const paths = new Set(workspaces.map((w) => String(w?.path ?? '')).filter((p) => p !== ''))
  for (const s of sessions) {
    const cwd = String(s?.cwd ?? '')
    if (cwd === '') continue
    if (!paths.has(cwd)) {
      warnings.push({
        code: 'cwd-not-registered',
        detail: `会话 ${s.sessionId} 的 cwd「${cwd}」不对应任何已登记工作区（该会话可能显示为未归属）`,
      })
    }
  }

  // 3. 归档状态与记账冲突
  for (const sid of archived) {
    if (owners.has(sid)) {
      warnings.push({
        code: 'archived-but-owned',
        detail: `会话 ${sid} 同时处于归档列表与工作区记账中`,
      })
    }
  }

  return { problems, warnings, checks: workspaces.length + sessions.length + archived.size }
}

/**
 * 检查工作区注册表的**结构**自洽（workspaceIds 与 workspaces 表必须同集）。
 *
 * 真实事故：`global.workspaceIds` 有 16 项而 `tables.workspaces` 只有 15 条，
 * 差的那个是悬空 id。任何「拿 workspaceIds join 表记录」的读取方都会把受影响
 * 会话判成 unregistered —— 这正是「点进去没有历史」的直接原因。
 *
 * @param {any} registry - workspace.json 解析后的对象。
 * @returns {{problems: Array<{code: string, detail: string}>, warnings: Array<object>, ok: boolean}}
 */
export function auditRegistryShape(registry) {
  const problems = []
  const warnings = []
  const ids = Array.isArray(registry?.global?.workspaceIds) ? registry.global.workspaceIds : null
  const table = registry?.tables?.workspaces
  if (ids === null || table === null || typeof table !== 'object') {
    problems.push({ code: 'registry-shape', detail: '注册表缺少 global.workspaceIds 或 tables.workspaces' })
    return { problems, warnings, ok: false }
  }
  const tableKeys = Object.keys(table)
  const idSet = new Set(ids)
  const tableSet = new Set(tableKeys)

  const dangling = ids.filter((id) => !tableSet.has(id))
  const orphan = tableKeys.filter((id) => !idSet.has(id))
  if (dangling.length > 0) {
    problems.push({
      code: 'registry-dangling-id',
      detail: `workspaceIds 里有 ${dangling.length} 个 id 在 workspaces 表中不存在（悬空）：${dangling.slice(0, 5).join(', ')}${dangling.length > 5 ? ' …' : ''}`,
    })
  }
  if (orphan.length > 0) {
    problems.push({
      code: 'registry-orphan-record',
      detail: `workspaces 表里有 ${orphan.length} 条记录未登记进 workspaceIds：${orphan.slice(0, 5).join(', ')}${orphan.length > 5 ? ' …' : ''}`,
    })
  }
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i)
  if (dupIds.length > 0) {
    warnings.push({ code: 'registry-duplicate-id', detail: `workspaceIds 有 ${dupIds.length} 个重复项` })
  }
  // 同名工作区（标题相同）是重复行的常见来源，但不一定是错误。
  const titles = new Map()
  for (const [id, rec] of Object.entries(table)) {
    const t = String(rec?.title ?? '')
    if (t === '') continue
    if (!titles.has(t)) titles.set(t, [])
    titles.get(t).push(id)
  }
  for (const [t, list] of titles) {
    if (list.length > 1) {
      warnings.push({
        code: 'duplicate-workspace-title',
        detail: `${list.length} 个工作区共用标题「${t}」（${list.join(', ')}）——若与同名分组叠加会出现重复行`,
      })
    }
  }
  return { problems, warnings, ok: problems.length === 0 }
}

/**
 * 判断一个 path 是否位于另一个 path 之下（用于发现「组名 = 工作区名」的冲突形状）。
 * 只做字符串级的规范化比较，不访问磁盘。
 *
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
export function isUnderPath(parent, child) {
  const norm = (p) => String(p ?? '').replace(/\\/gu, '/').replace(/\/+$/u, '').toLowerCase()
  const p = norm(parent)
  const c = norm(child)
  if (p === '' || c === '' || p === c) return false
  return c.startsWith(p + '/')
}

/**
 * 找出「工作区标题已是某分组路径，同时又有工作区以它的标题为前缀」的冲突形状。
 * 真实例子：`RBE999` 工作区 + `RBE999/Sim-to-Real...` 工作区 —— 前者标题同时
 * 是一个分组名，渲染期若两处都放置就会出现重复行。
 *
 * @param {Array<{workspaceId: string, title?: string}>} workspaces
 * @returns {Array<{title: string, workspaceIds: string[], children: string[]}>}
 */
export function findTitleConflicts(workspaces) {
  const list = Array.isArray(workspaces) ? workspaces : []
  const titles = new Set(list.map((w) => String(w?.title ?? '')).filter((t) => t !== ''))
  const groupPaths = new Set()
  for (const t of titles) {
    const segs = t.split('/').filter((s) => s !== '')
    for (let i = 1; i < segs.length; i += 1) groupPaths.add(segs.slice(0, i).join('/'))
  }
  const out = []
  for (const t of titles) {
    if (!groupPaths.has(t)) continue
    const holders = list.filter((w) => String(w?.title ?? '') === t).map((w) => w.workspaceId)
    const children = list
      .filter((w) => String(w?.title ?? '').startsWith(t + '/'))
      .map((w) => w.workspaceId)
    out.push({ title: t, workspaceIds: holders, children })
  }
  return out
}

/**
 * 把 doctor 结果渲染成一段人可读的文本。
 * @param {{registry: any, ownership: any, conflicts: Array<any>}} report
 * @returns {string}
 */
export function formatDoctor(report) {
  const lines = []
  const problems = [
    ...(report?.registry?.problems ?? []),
    ...(report?.ownership?.problems ?? []),
  ]
  const warnings = [
    ...(report?.registry?.warnings ?? []),
    ...(report?.ownership?.warnings ?? []),
  ]
  const checked = report?.ownership?.checks ?? 0
  if (problems.length === 0) {
    lines.push(`迁移体检通过（检查 ${checked} 项，无问题）。`)
  } else {
    lines.push(`迁移体检发现 ${problems.length} 个问题（检查 ${checked} 项）：`)
    for (const p of problems) lines.push(`- [${p.code}] ${p.detail}`)
  }
  if (warnings.length > 0) {
    lines.push('')
    lines.push(`另有 ${warnings.length} 条提示：`)
    for (const w of warnings.slice(0, 12)) lines.push(`- [${w.code}] ${w.detail}`)
    if (warnings.length > 12) lines.push(`- ……另有 ${warnings.length - 12} 条`)
  }
  const conflicts = report?.conflicts ?? []
  if (conflicts.length > 0) {
    lines.push('')
    lines.push(`标题与分组同名 ${conflicts.length} 处（可能造成重复行）：`)
    for (const c of conflicts) {
      lines.push(`- 「${c.title}」既是工作区（${c.workspaceIds.length} 个）又是分组前缀（${c.children.length} 个子项）`)
    }
  }
  if (problems.length > 0) {
    lines.push('')
    lines.push('本命令只读；修复请参考工作区 TODO_dsh-session-recovery.md 的「四处状态一起改」清单。')
  }
  return lines.join('\n')
}
