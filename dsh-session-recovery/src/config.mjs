// src/config.mjs — 配置默认值与合并纯函数（零依赖）。
//
// settings namespace 'session-recovery'（schemastery 动态 import 注册，见
// index.js registerSettings）。合并语义与 dsh-checkpoint-rewind 同款：
// 浅合并，数组字段（autoResumeIds / excludeWorkspaceGlobs）类型不符整体重置。

export const SETTINGS_NS = 'session-recovery'

export const DEFAULT_RESUME_TEMPLATE =
  '上次会话在异常退出时中断于第 {turn} 轮（事件 seq {seq}）。' +
  '请检查未完成的工具调用：TOOL_OUTCOME_UNKNOWN 的先核实外部状态，' +
  '然后从中断处继续（不要重放已完成的步骤）。'

/** @typedef {Object} RecoveryConfig
 * @property {boolean} notifyOnBoot
 * @property {string} resumeMessageTemplate
 * @property {number} maxScanSessions
 * @property {string[]} excludeWorkspaceGlobs
 * @property {string[]} autoResumeIds
 */

/** @type {RecoveryConfig} */
export const DEFAULTS = Object.freeze({
  notifyOnBoot: true,
  resumeMessageTemplate: DEFAULT_RESUME_TEMPLATE,
  maxScanSessions: 50,
  excludeWorkspaceGlobs: Object.freeze([]),
  autoResumeIds: Object.freeze([]),
})

/**
 * 浅合并配置；字段类型不符回退默认（单个错误值不拖垮整个配置）。
 * @param {unknown} value - settings 值（可能 undefined / 部分字段）。
 * @returns {RecoveryConfig}
 */
export function applyConfig(value) {
  const source = value && typeof value === 'object' ? /** @type {Record<string, unknown>} */ (value) : {}
  /** @type {RecoveryConfig} */
  const merged = { ...DEFAULTS }
  if (typeof source.notifyOnBoot === 'boolean') merged.notifyOnBoot = source.notifyOnBoot
  if (typeof source.resumeMessageTemplate === 'string' && source.resumeMessageTemplate.includes('{turn}')) {
    merged.resumeMessageTemplate = source.resumeMessageTemplate
  }
  const maxScan = Number(source.maxScanSessions)
  if (Number.isFinite(maxScan) && maxScan >= 1 && maxScan <= 500) merged.maxScanSessions = Math.floor(maxScan)
  if (Array.isArray(source.excludeWorkspaceGlobs)) {
    merged.excludeWorkspaceGlobs = source.excludeWorkspaceGlobs.filter((g) => typeof g === 'string' && g.length > 0)
  }
  if (Array.isArray(source.autoResumeIds)) {
    merged.autoResumeIds = source.autoResumeIds.filter((id) => typeof id === 'string' && id.length > 0)
  }
  return merged
}

/**
 * 模板渲染：{turn} {seq} {title} 占位符替换（未提供字段的占位符原样保留
 * 会被吞为空串——这里选择保留原文，避免静默丢信息）。
 * @param {string} template
 * @param {{turn?: number, seq?: number, title?: string, sessionId?: string}} fields
 * @returns {string}
 */
export function renderTemplate(template, fields) {
  let out = String(template || '')
  if (fields.turn !== undefined) out = out.replaceAll('{turn}', String(fields.turn))
  if (fields.seq !== undefined) out = out.replaceAll('{seq}', String(fields.seq))
  if (fields.title !== undefined) out = out.replaceAll('{title}', fields.title)
  if (fields.sessionId !== undefined) out = out.replaceAll('{sessionId}', fields.sessionId)
  return out
}
