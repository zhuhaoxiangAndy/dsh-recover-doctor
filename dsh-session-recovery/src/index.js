/**
 * dsh-session-recovery — host half（dsh 0.2.1-rc.5）。
 *
 * 宿主异常退出/中断/重启后，主动检测「上次干到一半」的会话并提供恢复。
 * 与宿主内建能力的分工：
 * - 宿主已有 crash-repair（packages/core/session/src/repair.ts）：冷打开一个
 *   中断会话时，为孤儿工具调用合成 TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN
 *   结果。但它是**被动**的——你不打开那个会话，就永远不会修复/提示。
 * - 本插件补上主动一环：扫描所有可见会话的尾部，找出未闭合轮，列出并支持
 *   一键恢复（注入继续消息）或保守 fork。
 *
 * API 依据（本地 checkout 实测，dsh 0.2.1-rc.5）：
 * - 会话枚举：sessionController.list(request, signal) → {items: SessionSummary[]}
 *   只读 header + projection cache，**不激活 Agent**
 *   （packages/api/session-controller/src/list.ts:126、index.ts:224）。
 * - 单会话事件：sessionController.inspect(sessionId, signal) →
 *   {meta, inheritedEventCount, events}，同样**不激活 Agent**
 *   （packages/api/session-controller/src/index.ts:201-215）。
 * - fork：sessionController.fork({sessionId, atSeq})（commands.ts:202）。
 * - prompt（恢复注入）：sessionController.prompt(request, signal)（index.ts:347）。
 * - 命令：ctx.inject(['commands']).commands.register({definitionId, name,
 *   description, input, handler})，handler 返回 {kind:'success'|'error', text}
 *   （packages/interaction/permission-presets/src/index.ts:256-277 同款）。
 * - settings：ctx.inject(['settings']) + settings.register(ns, schemastery)
 *   （模板 dsh-better-workspace 同款，schemastery 动态 import）。
 */

import { scanInterruption, forkBoundaryOf, titleOf, lastActivityOf } from './detect.mjs'
import { applyConfig, renderTemplate, SETTINGS_NS, DEFAULTS } from './config.mjs'
import { parseRecoverInput, formatList, pickRow } from './commands.mjs'
import { isExcludedWorkspace } from './glob.mjs'
import { auditOwnership, auditRegistryShape, findTitleConflicts, formatDoctor } from './doctor.mjs'
import { auditSessionLog, decodeZstdText, parseEvents, scanZstdFrames } from './zstd-frames.mjs'

export const name = 'dsh-session-recovery'

/** 命令名（无斜杠）。 */
const COMMAND = 'recover'

/** @type {import('./config.mjs').RecoveryConfig} */
let config = applyConfig(undefined)

/** 被用户 dismiss 的会话 id（本进程内；持久化在 settings 的 dismissedIds）。 */
let dismissed = new Set()

/** 最近一次扫描结果缓存（/recover list 复用，避免重复全量读）。 */
/** @type {{rows: any[], stats: {scanned: number, skipped: number}, at: number}|null} */
let scanCache = null
const SCAN_TTL_MS = 15_000

/**
 * @param {any} ctx
 * @param {string} msg
 */
function log(ctx, msg) {
  const logger = ctx?.logger
  if (logger && typeof logger.info === 'function') logger.info(`[${name}] ${msg}`)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errMsg(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 取 sessionController（多形态容错：ctx.sessionController 或 ctx.get('sessionController')）。
 * @param {any} ctx
 * @returns {any}
 */
function controllerOf(ctx) {
  if (ctx?.sessionController && typeof ctx.sessionController.list === 'function') return ctx.sessionController
  try {
    const got = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined
    if (got && typeof got.list === 'function') return got
  } catch {}
  return undefined
}

/**
 * 从 inspect 结果里取事件数组（容错：events 或 prefix/items）。
 * @param {any} inspection
 * @returns {Array<{type: string, seq: number, time?: number, data?: any}>}
 */
function eventsOf(inspection) {
  if (!inspection || typeof inspection !== 'object') return []
  if (Array.isArray(inspection.events)) return inspection.events
  if (Array.isArray(inspection.prefix)) return inspection.prefix
  if (Array.isArray(inspection.items)) return inspection.items
  return []
}

/**
 * 扫描全部可见会话，返回中断行。
 * 不激活 Agent：只调 list + inspect（逐个只读尾部事件）。
 * 为控制开销，按 updatedAt 倒序最多扫描 config.maxScanSessions 个非 running 会话。
 * @param {any} ctx
 * @returns {Promise<{rows: any[], stats: {scanned: number, skipped: number}}>}
 */
async function scanInterrupted(ctx) {
  const controller = controllerOf(ctx)
  if (!controller) return { rows: [], stats: { scanned: 0, skipped: 0 } }

  /** @type {any[]} */
  let items = []
  try {
    const value = await controller.list({}, undefined)
    items = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : []
  } catch (error) {
    log(ctx, `session list failed: ${errMsg(error)}`)
    return { rows: [], stats: { scanned: 0, skipped: 0 } }
  }

  // running 的会话是当前活跃的，不是"上次中断"，跳过。
  const candidates = items
    .filter((item) => item && typeof item.sessionId === 'string' && item.running !== true)
    .filter((item) => !dismissed.has(item.sessionId))
    .filter((item) => !isExcludedWorkspace(item.cwd, config.excludeWorkspaceGlobs))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

  const limit = Math.min(candidates.length, config.maxScanSessions)
  const rows = []
  let scanned = 0
  let skipped = candidates.length - limit

  for (let i = 0; i < limit; i++) {
    const item = candidates[i]
    try {
      const inspection = await controller.inspect(item.sessionId, undefined)
      const events = eventsOf(inspection)
      scanned++
      if (events.length === 0) continue
      const report = scanInterruption(events)
      if (!report.interrupted) continue
      rows.push({
        ...report,
        sessionId: item.sessionId,
        title: titleOf(events) ?? item.title,
        cwd: item.cwd ?? inspection?.meta?.cwd,
        updatedAt: lastActivityOf(events) ?? item.updatedAt,
        forkBoundary: forkBoundaryOf(report),
      })
    } catch (error) {
      skipped++
      log(ctx, `inspect ${item.sessionId} failed: ${errMsg(error)}`)
    }
  }
  return { rows, stats: { scanned, skipped } }
}

/**
 * 带缓存扫描（/recover list 与 boot 提示共用）。
 * @param {any} ctx
 * @param {boolean} [force]
 * @returns {Promise<{rows: any[], stats: {scanned: number, skipped: number}}>}
 */
async function scanCached(ctx, force = false) {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_TTL_MS) {
    return { rows: scanCache.rows, stats: scanCache.stats }
  }
  const result = await scanInterrupted(ctx)
  scanCache = { rows: result.rows, stats: result.stats, at: Date.now() }
  return result
}

/**
 * 多帧 zstd 完整性体检（v0.3.0，只读）。
 *
 * 这个子命令存在的理由：`zstdDecompressSync(整个文件)` 只解出第 1 帧且**不报错**，
 * 所以「表面上能打开」的会话可能已经丢了 99% 的事件。实测一个真实会话：
 * 5101 帧 / 9427 事件，整份解压只得到 1 个事件（228 字符），多帧解压得到 1921 万字符。
 * 因此必须提供一个能看见「帧数与事件数」的检查入口。
 *
 * @param {any} ctx
 * @param {string} target 会话 id 前缀，或日志文件绝对路径
 */
async function doAudit(ctx, target) {
  const { existsSync, readdirSync, statSync } = await import('node:fs')
  const path = (await import('node:path')).default
  const os = (await import('node:os')).default

  // (a) 直接给文件路径
  let file = null
  if (/\.zstd$/i.test(target) && existsSync(target)) {
    file = target
  } else {
    // (b) 按会话 id 前缀在 sessions 根下找
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const root = path.join(home, 'sessions')
    let best = null
    let matches = 0
    try {
      for (const slug of readdirSync(root)) {
        const sd = path.join(root, slug)
        if (!statSync(sd).isDirectory()) continue
        for (const sid of readdirSync(sd)) {
          if (!sid.startsWith(target)) continue
          const f = path.join(sd, sid, 'session.v4.jsonl.zstd')
          if (!existsSync(f)) continue
          matches += 1
          const size = statSync(f).size
          if (best === null || size > best.size) best = { file: f, sid, size }
        }
      }
    } catch (error) {
      return { kind: 'error', text: `无法扫描会话目录：${errMsg(error)}` }
    }
    if (matches === 0) return { kind: 'error', text: `没有找到匹配 "${target}" 的会话日志` }
    if (matches > 1) {
      return { kind: 'error', text: `"${target}" 匹配到 ${matches} 个会话，请给出更长的前缀` }
    }
    file = best.file
  }

  try {
    const audit = auditSessionLog(file)
    const { readFileSync } = await import('node:fs')
    const buf = readFileSync(file)
    const multi = decodeZstdText(buf)
    const events = parseEvents(multi.text).events

    const lines = [
      `会话日志体检：${path.basename(path.dirname(file))}`,
      `  文件      : ${file}`,
      `  大小      : ${buf.length.toLocaleString()} 字节`,
      `  帧数      : ${audit.frames.toLocaleString()}（成功解压 ${audit.decoded}，失败 ${audit.failed}）`,
      `  事件数    : ${events.length.toLocaleString()}`,
      `  坏行      : ${audit.badLines}`,
      `  第 0 帧   : ${audit.headerOk ? '恰好一行 header ✓' : '不是单行 header ✗（boot 会白屏）'}`,
    ]
    if (audit.frames > 1) {
      lines.push('')
      lines.push(`  提示：这是多帧文件。用 zstdDecompressSync(整份文件) 只会得到第 0 帧的 1 个事件，`)
      lines.push(`        必须按帧魔数 28 B5 2F FD 切分后逐帧解压，才能拿到全部 ${events.length.toLocaleString()} 个事件。`)
    }
    if (audit.problems.length > 0) {
      lines.push('')
      lines.push('  问题：')
      for (const p of audit.problems) lines.push('    - ' + p)
    } else {
      lines.push('')
      lines.push('  结论：完整，未发现丢帧或坏行。')
    }
    return { kind: audit.ok ? 'success' : 'error', text: lines.join(String.fromCharCode(10)) }
  } catch (error) {
    return { kind: 'error', text: `体检失败：${errMsg(error)}` }
  }
}

/**
 * 采集迁移体检报告（/recover doctor）。**只读**：只用公开 API 与注册表读取。
 *
 * 设计取舍：不解析会话日志正文。同一次事故里我们确认日志是逐帧 zstd，
 * 整份解压只拿首帧；但插件没有理由为此去读私有格式——`list()` 已经给出
 * sessionId + cwd，注册表给出归属，二者足够判定「四处状态是否一致」。
 *
 * @param {any} ctx
 * @returns {Promise<{registry: any, ownership: any, conflicts: any[]}>}
 */
async function collectDoctorReport(ctx) {
  const controller = controllerOf(ctx)

  /** @type {Array<{sessionId: string, cwd?: string}>} */
  let sessions = []
  if (controller && typeof controller.list === 'function') {
    try {
      const value = await controller.list({}, undefined)
      const items = Array.isArray(value?.items) ? value.items : Array.isArray(value) ? value : []
      sessions = items.map((s) => ({
        sessionId: String(s?.sessionId ?? s?.id ?? ''),
        cwd: typeof s?.cwd === 'string' ? s.cwd : undefined,
      })).filter((s) => s.sessionId !== '')
    } catch (error) {
      log(ctx, `doctor: sessionController.list failed: ${errMsg(error)}`)
    }
  }

  // 工作区注册表：优先宿主服务，缺失时退化为直接读 workspace.json（只读）。
  /** @type {Array<{workspaceId: string, path?: string, title?: string, sessionIds?: string[]}>} */
  let workspaces = []
  let archivedSessionIds = []
  let registryShape = { problems: [], warnings: [], ok: true }
  let rawRegistry = null

  const registry = (() => {
    try { return typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined } catch { return undefined }
  })()
  if (registry && typeof registry.list === 'function') {
    try {
      const list = registry.list()
      workspaces = (Array.isArray(list) ? list : []).map((w) => ({
        workspaceId: String(w?.workspaceId ?? w?.id ?? ''),
        path: typeof w?.path === 'string' ? w.path : undefined,
        title: typeof w?.title === 'string' ? w.title : undefined,
        sessionIds: Array.isArray(w?.sessionIds) ? w.sessionIds.map(String) : [],
      })).filter((w) => w.workspaceId !== '')
    } catch (error) {
      log(ctx, `doctor: workspaceRegistry.list failed: ${errMsg(error)}`)
    }
    try {
      archivedSessionIds = Array.isArray(registry.archivedSessionIds)
        ? [...registry.archivedSessionIds].map(String)
        : []
    } catch { archivedSessionIds = [] }
  } else {
    // Fallback: read the registry file. Read-only; a malformed file is reported
    // rather than thrown so doctor still says something useful.
    try {
      const { readFileSync } = await import('node:fs')
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const file = join(home, 'storages', 'workspace.json')
      rawRegistry = JSON.parse(readFileSync(file, 'utf8'))
      const table = rawRegistry?.tables?.workspaces ?? {}
      workspaces = Object.entries(table).map(([workspaceId, w]) => ({
        workspaceId,
        path: typeof w?.path === 'string' ? w.path : undefined,
        title: typeof w?.title === 'string' ? w.title : undefined,
        sessionIds: Array.isArray(w?.sessionIds) ? w.sessionIds.map(String) : [],
      }))
      archivedSessionIds = Array.isArray(rawRegistry?.global?.archivedSessionIds)
        ? rawRegistry.global.archivedSessionIds.map(String)
        : []
    } catch (error) {
      log(ctx, `doctor: registry file read failed: ${errMsg(error)}`)
    }
  }

  if (rawRegistry !== null) registryShape = auditRegistryShape(rawRegistry)

  return {
    registry: registryShape,
    ownership: auditOwnership({ sessions, workspaces, archivedSessionIds }),
    conflicts: findTitleConflicts(workspaces),
  }
}

/**
 * /recover resume —— 复活会话并注入继续消息。
 * @param {any} ctx
 * @param {any} row
 * @returns {Promise<{kind: 'success'|'error', text: string}>}
 */
async function doResume(ctx, row) {
  const controller = controllerOf(ctx)
  if (!controller || typeof controller.prompt !== 'function') {
    return { kind: 'error', text: '会话服务不可用（sessionController.prompt 缺失），无法恢复' }
  }
  const message = renderTemplate(config.resumeMessageTemplate, {
    turn: row.openTurn ?? 0,
    seq: row.interruptedAtSeq >= 0 ? row.interruptedAtSeq : row.lastSeq,
    title: row.title ?? '',
    sessionId: row.sessionId,
  })
  try {
    // prompt 会按 preset-aware resume policy 复活冷会话（session-controller
    // README:31 "prompt ... may resolve or resume an ordinary Session"）。
    await controller.prompt({
      sessionId: row.sessionId,
      content: [{ type: 'text', text: message }],
    }, undefined)
    return {
      kind: 'success',
      text: [
        `已恢复会话 ${row.sessionId}${row.title ? `「${row.title}」` : ''}。`,
        `已注入继续消息（第 ${row.openTurn} 轮中断处）：`,
        message,
        '',
        '打开该会话即可看到；宿主的 crash-repair 会在冷打开时补齐孤儿工具调用的合成结果。',
      ].join('\n'),
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `恢复失败：${errMsg(error)}\n可改用保守方案：/${COMMAND} fork ${row.sessionId} ${row.forkBoundary ?? ''}`.trim(),
    }
  }
}

/**
 * /recover fork —— 在最后闭合边界派生子会话。
 * @param {any} ctx
 * @param {any} row
 * @param {number|undefined} seqArg
 * @returns {Promise<{kind: 'success'|'error', text: string}>}
 */
async function doFork(ctx, row, seqArg) {
  const controller = controllerOf(ctx)
  if (!controller || typeof controller.fork !== 'function') {
    return { kind: 'error', text: 'fork 服务不可用（sessionController.fork 缺失）' }
  }
  const atSeq = typeof seqArg === 'number' ? seqArg : row.forkBoundary
  if (typeof atSeq !== 'number' || atSeq < 0) {
    return {
      kind: 'error',
      text: `会话 ${row.sessionId} 没有闭合轮边界（首轮就中断了），无法 fork；请用 /${COMMAND} resume ${row.sessionId}`,
    }
  }
  try {
    const value = await controller.fork({ sessionId: row.sessionId, atSeq })
    const childId = value?.sessionId ?? value?.id ?? '(未知)'
    return {
      kind: 'success',
      text: `已派生子会话 ${childId}（从 seq=${atSeq} 的最后闭合轮，源会话 ${row.sessionId} 未改动，中断轮内容不继承）。`,
    }
  } catch (error) {
    return { kind: 'error', text: `fork 失败：${errMsg(error)}` }
  }
}

/**
 * 注册 /recover 命令。
 * @param {any} ctx
 */
function registerCommand(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      definitionId: `${name}:recover`,
      name: COMMAND,
      description: 'List sessions interrupted by an abnormal exit and recover them, or audit migration / log integrity (list | doctor | audit <id|file> | resume <id> | fork <id> [seq] | dismiss <id>)',
      input: { hint: 'list | doctor | audit <id|file> | resume <id> | fork <id> [seq] | dismiss <id>' },
      handler: async ({ rawInput }) => {
        try {
          const parsed = parseRecoverInput(rawInput)
          if (parsed.error && parsed.action === 'help') {
            return { kind: 'error', text: `${parsed.error}\n用法：/${COMMAND} list | doctor | resume <id> | fork <id> [seq] | dismiss <id>` }
          }
          if (parsed.error) return { kind: 'error', text: parsed.error }

          // v0.2.0 migration audit (read-only): four-state consistency check.
          if (parsed.action === 'doctor') {
            const report = await collectDoctorReport(ctx)
            const text = formatDoctor(report)
            const bad = (report.registry?.problems?.length ?? 0) + (report.ownership?.problems?.length ?? 0)
            return { kind: bad > 0 ? 'error' : 'success', text }
          }

          // v0.3.0: multi-frame integrity audit (read-only).
          if (parsed.action === 'audit') {
            return await doAudit(ctx, parsed.id)
          }

          if (parsed.action === 'list' || parsed.action === 'help') {
            const { rows, stats } = await scanCached(ctx, true)
            return { kind: 'success', text: formatList(rows, stats) }
          }

          const { rows } = await scanCached(ctx, false)
          const row = pickRow(rows, parsed.id)
          if (!row) {
            return {
              kind: 'error',
              text: `没有找到中断会话 "${parsed.id}"（或前缀不唯一）。先运行 /${COMMAND} list。`,
            }
          }

          if (parsed.action === 'resume') return await doResume(ctx, row)
          if (parsed.action === 'fork') return await doFork(ctx, row, parsed.seq)
          if (parsed.action === 'dismiss') {
            dismissed.add(row.sessionId)
            scanCache = null
            return { kind: 'success', text: `已忽略会话 ${row.sessionId}（本进程有效；重启后重新出现）` }
          }
          return { kind: 'error', text: '未知子命令' }
        } catch (error) {
          return { kind: 'error', text: `recover 失败：${errMsg(error)}` }
        }
      },
    })
    log(ctx, `command registered: /${COMMAND}`)
  })
}

/**
 * 注册 settings namespace。
 * @param {any} ctx
 */
function registerSettings(ctx) {
  if (typeof ctx?.inject !== 'function') return
  ctx.inject(['settings'], (settingsCtx) => {
    import('@deepseek-ai/schemastery').then(([sm]) => {
      const settings = settingsCtx?.settings
      if (!settings || typeof settings.register !== 'function') return
      const Schema = sm.default
      settings.register(SETTINGS_NS, Schema.object({
        notifyOnBoot: Schema.boolean().default(DEFAULTS.notifyOnBoot),
        resumeMessageTemplate: Schema.string().default(DEFAULTS.resumeMessageTemplate),
        maxScanSessions: Schema.number().min(1).max(500).default(DEFAULTS.maxScanSessions),
        excludeWorkspaceGlobs: Schema.array(String).default([]),
        autoResumeIds: Schema.array(String).default([]),
      }).description('dsh-session-recovery 中断检测与恢复配置'))
      const current = typeof settings.get === 'function' ? settings.get(SETTINGS_NS) : undefined
      config = applyConfig(current)
      if (typeof settings.on === 'function') {
        settings.on('settings/updated', (payload) => {
          if (payload?.namespace === SETTINGS_NS || payload?.ns === SETTINGS_NS) {
            config = applyConfig(payload.value ?? payload.data)
            scanCache = null
          }
        })
      }
      log(ctx, `settings namespace registered: ${SETTINGS_NS}`)
    }).catch((error) => {
      log(ctx, `settings registration failed (defaults in effect): ${errMsg(error)}`)
    })
  })
}

/**
 * 启动提示：检测到中断会话时，向系统提示注入一段可见说明。
 * 不自动恢复（autoResumeIds 白名单除外，且只在显式配置时执行）。
 * @param {any} ctx
 */
function registerBootNotice(ctx) {
  // 用 systemPrompt section 注入（宿主的模型可见面），比日志更容易被发现。
  try {
    if (ctx?.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
      ctx.systemPrompt.section({
        id: `${name}:interrupted-sessions`,
        render: async () => {
          if (!config.notifyOnBoot) return ''
          try {
            const { rows } = await scanCached(ctx, false)
            if (rows.length === 0) return ''
            const lines = rows.slice(0, 5).map((row) => {
              const title = row.title ? `「${row.title}」` : ''
              const repair = row.tailSyntheticRepair > 0 ? `，${row.tailSyntheticRepair} 个工具调用待 crash-repair` : ''
              return `- ${row.sessionId}${title}：中断于第 ${row.openTurn} 轮${repair}`
            })
            return [
              '[session-recovery] 检测到上次异常退出时中断的会话：',
              ...lines,
              rows.length > 5 ? `（还有 ${rows.length - 5} 个，运行 /recover list 查看全部）` : '运行 /recover list 查看全部',
              `恢复：/recover resume <id>（注入继续消息）或 /recover fork <id>（保守派生）。`,
            ].join('\n')
          } catch {
            return ''
          }
        },
      })
      log(ctx, 'system prompt section registered: interrupted-sessions')
    }
  } catch (error) {
    log(ctx, `systemPrompt section registration failed (boot notice disabled): ${errMsg(error)}`)
  }
}

/**
 * 插件入口。
 * @param {any} ctx
 */
export function apply(ctx) {
  log(ctx, 'host half loaded (aligned to dsh 0.2.1-rc.5)')
  registerSettings(ctx)
  registerCommand(ctx)
  registerBootNotice(ctx)
  // 惰性预扫描：boot 之后异步跑一次，填充缓存并把结果记日志（不阻塞启动）。
  Promise.resolve().then(async () => {
    try {
      const { rows, stats } = await scanCached(ctx, true)
      log(ctx, `initial scan: ${rows.length} interrupted / ${stats.scanned} scanned / ${stats.skipped} skipped`)
      if (rows.length > 0) {
        for (const row of rows.slice(0, 10)) {
          log(ctx, `  interrupted ${row.sessionId} turn ${row.openTurn} seq ${row.interruptedAtSeq}`)
        }
      }
      // autoResumeIds 白名单（默认空 → 不自动恢复）。
      if (Array.isArray(config.autoResumeIds) && config.autoResumeIds.length > 0) {
        for (const row of rows) {
          if (!config.autoResumeIds.includes(row.sessionId)) continue
          log(ctx, `auto-resume ${row.sessionId} (whitelisted)`)
          const result = await doResume(ctx, row)
          log(ctx, `auto-resume ${row.sessionId}: ${result.kind} — ${result.text.split('\n')[0]}`)
        }
      }
    } catch (error) {
      log(ctx, `initial scan failed: ${errMsg(error)}`)
    }
  })
}
