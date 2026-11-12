// src/zstd-frames.mjs — 多帧 zstd 的安全读写（零依赖，纯函数优先）。
//
// 为什么必须有这个模块
// --------------------
// `session.v4.jsonl.zstd` 是**成百上千个 zstd 帧首尾相接**（每次追加写一帧）。
// 两个静默失败害过人（见工作区 TODO_dsh-session-recovery.md 第二节）：
//
//   1. `zlib.zstdDecompressSync(整个文件)` **只解出第 1 帧**，不报错，
//      静默丢弃其余全部事件；
//   2. 想改 header 时若走「整份解压 → 改首行 → 整体重压」，会把 N 帧写成 1 帧。
//      实测：731 帧 / 1501 事件被压成 1 帧，丢了 730 帧，文件仍有 172 字节，
//      还能解出一个合法 header —— 界面表现就是「点进去没有历史记录」。
//
// 因此本模块只做两件正确的事：
//   * 按帧魔数 `28 B5 2F FD` 切分，逐帧解压；
//   * 改写时**只重建第 0 帧**，其余帧字节原样保留。
//
// 帧不变式（违反即白屏）：第 0 帧必须解压出**恰好一行** header。
// `assertZstdHeaderFrame` 在 `dsh web` 启动时跑，不满足直接崩。

import zlib from 'node:zlib'

/** zstd 帧魔数。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 带 checksum 的压缩参数（与 dsh-mv-session 同款，缺了它部分读取器会拒绝）。 */
export const ZSTD_PARAMS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }

/**
 * 按魔数切分多帧 zstd。
 * 注意：魔数也可能出现在压缩数据内部，所以这里只做候选切分，
 * 由 {@link decodeFrames} 用解压成功与否过滤掉假边界。
 *
 * @param {Buffer} buf
 * @returns {Array<{start: number, end: number}>}
 */
export function scanZstdFrames(buf) {
  const starts = []
  let i = buf.indexOf(ZSTD_MAGIC, 0)
  while (i !== -1) {
    starts.push(i)
    i = buf.indexOf(ZSTD_MAGIC, i + ZSTD_MAGIC.length)
  }
  const frames = []
  for (let k = 0; k < starts.length; k += 1) {
    frames.push({ start: starts[k], end: k + 1 < starts.length ? starts[k + 1] : buf.length })
  }
  return frames
}

/**
 * 解压每一帧并拼成完整文本。
 *
 * 与 `zstdDecompressSync(wholeFile)` 的区别：后者只返回第 1 帧。
 * 假边界（魔数恰好出现在压缩数据里）会因为解压失败被跳过，不影响其它帧。
 *
 * @param {Buffer} buf
 * @returns {{text: string, frames: number, decoded: number, failed: number}}
 */
export function decodeZstdText(buf) {
  const candidates = scanZstdFrames(buf)
  const parts = []
  let decoded = 0
  let failed = 0
  for (const frame of candidates) {
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8'))
      decoded += 1
    } catch {
      failed += 1
    }
  }
  return { text: parts.join(''), frames: candidates.length, decoded, failed }
}

/**
 * 解析全部事件（每行一个 JSON）。
 * 坏行被跳过并计数，绝不因为一行坏掉就丢掉整份会话。
 *
 * @param {string} text
 * @returns {{events: any[], badLines: number}}
 */
export function parseEvents(text) {
  const events = []
  let badLines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      badLines += 1
    }
  }
  return { events, badLines }
}

/** 读取并解析一个会话日志文件。 */
export function readSessionEvents(file) {
  const buf = fsReadFileSync(file)
  const { text, frames, decoded, failed } = decodeZstdText(buf)
  const { events, badLines } = parseEvents(text)
  return { buf, text, events, frames, decoded, failed, badLines }
}

/**
 * 第 0 帧是否「恰好一行 header」——boot 的 `assertZstdHeaderFrame` 同款判据。
 * @param {string} text
 */
export function isExactlyOneHeaderLine(text) {
  return typeof text === 'string' && text.length > 0 && text.indexOf('\n') === text.length - 1
}

// 顶层静态导入（ESM 模块里不能用 require）
import { readFileSync as fsReadFileSync, writeFileSync as fsWriteFileSync, renameSync as fsRenameSync, existsSync as fsExistsSync, copyFileSync as fsCopyFileSync } from 'node:fs'

/**
 * 只重建第 0 帧，其余帧**字节原样保留**。
 *
 * @param {Buffer} buf 原始文件内容
 * @param {object} patch 要与原 header 合并的字段（例如 { cwd: 'D:\\new' }）
 * @param {{backup?: boolean, file?: string}} [options]
 * @returns {{out: Buffer, header: any, framesBefore: number, framesAfter: number, bytesBefore: number, bytesAfter: number}}
 */
export function rewriteHeaderFrame(buf, patch, options = {}) {
  const candidates = scanZstdFrames(buf)
  if (candidates.length === 0) throw new Error('不是 zstd 文件：找不到帧魔数')

  // 第 0 帧必须是完整的 header 行，否则不能安全改写
  const first = candidates[0]
  const firstText = zlib.zstdDecompressSync(buf.subarray(first.start, first.end)).toString('utf8')
  if (!isExactlyOneHeaderLine(firstText)) {
    throw new Error('第 0 帧不是恰好一行 header，拒绝改写（会破坏 boot 不变式）')
  }
  const header = JSON.parse(firstText)
  const merged = { ...header, ...patch }
  const newFirst = zlib.zstdCompressSync(Buffer.from(JSON.stringify(merged) + '\n', 'utf8'), ZSTD_PARAMS)

  // 从第 2 帧起点整段拷贝 —— 这是不丢数据的关键
  const rest = buf.subarray(first.end)
  const out = Buffer.concat([newFirst, rest])

  // 自检：帧数不能减少，且第 0 帧仍恰好一行
  const after = scanZstdFrames(out)
  if (after.length < candidates.length) {
    throw new Error(`帧数减少（${candidates.length} -> ${after.length}），拒绝写入`)
  }
  const verifyText = zlib.zstdDecompressSync(out.subarray(after[0].start, after[0].end)).toString('utf8')
  if (!isExactlyOneHeaderLine(verifyText)) {
    throw new Error('改写后第 0 帧不再是单行 header，拒绝写入')
  }

  if (options.file && options.backup !== false) {
    if (fsExistsSync(options.file)) fsCopyFileSync(options.file, options.file + '.bak-' + Date.now())
  }

  return {
    out,
    header: merged,
    framesBefore: candidates.length,
    framesAfter: after.length,
    bytesBefore: buf.length,
    bytesAfter: out.length,
  }
}

/**
 * 原子写入：先写同目录临时文件，再 rename 覆盖。
 * 绝不原地覆盖——中途失败会留下一份完整的旧文件。
 *
 * @param {string} file
 * @param {Buffer} data
 */
export function writeFileAtomic(file, data) {
  const tmp = file + '.tmp-' + process.pid + '-' + Date.now()
  fsWriteFileSync(tmp, data)
  fsRenameSync(tmp, file)
}

/**
 * 体检一个会话日志的多帧完整性（只读）。
 * @param {string} file
 * @returns {{ok: boolean, frames: number, decoded: number, failed: number, events: number, badLines: number, headerOk: boolean, problems: string[]}}
 */
export function auditSessionLog(file) {
  const problems = []
  const buf = fsReadFileSync(file)
  const candidates = scanZstdFrames(buf)
  if (candidates.length === 0) problems.push('找不到任何 zstd 帧')
  const { text, decoded, failed } = decodeZstdText(buf)
  if (failed > 0) problems.push(`${failed} 帧解压失败（可能是假边界或损坏帧）`)
  const { events, badLines } = parseEvents(text)
  if (badLines > 0) problems.push(`${badLines} 行不是合法 JSON`)
  let headerOk = false
  if (candidates.length > 0) {
    try {
      const t = zlib.zstdDecompressSync(buf.subarray(candidates[0].start, candidates[0].end)).toString('utf8')
      headerOk = isExactlyOneHeaderLine(t)
    } catch {
      problems.push('第 0 帧无法解压')
    }
    if (!headerOk && candidates.length > 0) problems.push('第 0 帧不是恰好一行 header（boot 会白屏）')
  }
  return {
    ok: problems.length === 0,
    frames: candidates.length,
    decoded,
    failed,
    events: events.length,
    badLines,
    headerOk,
    problems,
  }
}
