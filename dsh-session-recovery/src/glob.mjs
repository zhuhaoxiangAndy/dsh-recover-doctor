// src/glob.mjs — 工作区排除 glob 匹配纯函数（零依赖）。
//
// Windows 大小写兼容：统一小写比较、分隔符统一为 /。
// 支持三种模式（手写实现，避免任何 npm 依赖）：
//   'name'        — 路径段包含该名（含子路径）
//   'name/**'     — 以该前缀开头
//   '**/name/**'  — 路径中包含该段
//   'a/b'         — 前缀匹配（段级）
// 以及整段 '**' 通配。空模式列表永不排除。

/**
 * 规范化路径：反斜杠 → 正斜杠，去首尾分隔符，小写（Windows 大小写不敏感）。
 * @param {string} p
 * @returns {string}
 */
function normalizePath(p) {
  return String(p || '').replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase()
}

/**
 * 工作区路径是否命中排除 glob。
 * @param {string|undefined} cwd - 会话工作区绝对路径。
 * @param {readonly string[]} patterns - 排除模式（分隔符 / 或 \ 均可）。
 * @returns {boolean}
 */
export function isExcludedWorkspace(cwd, patterns) {
  if (!cwd || !Array.isArray(patterns) || patterns.length === 0) return false
  const norm = normalizePath(cwd)
  if (!norm) return false
  const segments = norm.split('/').filter((s) => s.length > 0)
  for (const raw of patterns) {
    const pattern = normalizePath(raw)
    if (!pattern) continue
    if (pattern === '**' || pattern === '*') return true
    // 去掉模式里的 '**' 语义糖后做段级匹配。
    if (matchPattern(norm, segments, pattern)) return true
  }
  return false
}

/**
 * 单模式匹配：段级前缀 / 包含 / 尾部通配。
 * @param {string} norm
 * @param {string[]} segments
 * @param {string} pattern
 * @returns {boolean}
 */
function matchPattern(norm, segments, pattern) {
  const hasDoubleStar = pattern.includes('**')
  const parts = pattern.split('/').filter((s) => s.length > 0 && s !== '**')
  if (parts.length === 0) return hasDoubleStar
  const joined = parts.join('/')
  if (!hasDoubleStar && !parts.includes('*')) {
    // 纯前缀匹配：norm 以 'joined' 或 'joined/' 开头。
    return norm === joined || norm.startsWith(joined + '/')
  }
  // 含 '*'（单段通配）或 '**'（跨段通配）：按段序列在路径中「包含」匹配。
  return containsSequence(segments, parts)
}

/**
 * segments 是否按序包含 parts（每段精确或单段 '*' 通配）。
 * @param {string[]} segments
 * @param {string[]} parts
 * @returns {boolean}
 */
function containsSequence(segments, parts) {
  outer: for (let start = 0; start <= segments.length - parts.length; start++) {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      const seg = segments[start + i]
      if (part === '*') continue
      if (seg !== part) continue outer
    }
    return true
  }
  return false
}
