// 多帧 zstd 读写测试。
//
// 这些测试针对一起真实事故（见工作区 TODO_dsh-session-recovery.md 第二节）：
// 「整份解压 → 改首行 → 整体重压」把 731 帧写成 1 帧，丢了 730 帧，
// 文件仍有 172 字节、还能解出一个合法 header，界面表现是「点进去没有历史记录」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import {
  ZSTD_MAGIC, ZSTD_PARAMS, scanZstdFrames, decodeZstdText, parseEvents,
  isExactlyOneHeaderLine, rewriteHeaderFrame, auditSessionLog,
} from '../src/zstd-frames.mjs'

/** 造一个多帧 zstd 缓冲：第 0 帧是 header，之后每帧一行事件。 */
function buildLog(header, lines) {
  const frames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), ZSTD_PARAMS)]
  for (const line of lines) {
    frames.push(zlib.zstdCompressSync(Buffer.from(line + '\n', 'utf8'), ZSTD_PARAMS))
  }
  return Buffer.concat(frames)
}

test('scanZstdFrames finds every frame boundary', () => {
  const buf = buildLog({ id: 'a', cwd: 'C:/x' }, ['{"seq":1}', '{"seq":2}', '{"seq":3}'])
  const frames = scanZstdFrames(buf)
  assert.equal(frames.length, 4, 'header + 3 event frames')
  assert.equal(frames[0].start, 0, 'first frame starts at 0')
  for (const f of frames) assert.ok(f.end > f.start, 'every frame is non-empty')
})

test('decodeZstdText returns ALL frames, not just the first', () => {
  // This is the whole point: zstdDecompressSync(whole buffer) silently returns
  // only frame 0, so a naive reader sees 1 event and calls it a healthy session.
  const buf = buildLog({ id: 'a', cwd: 'C:/x' }, ['{"seq":1}', '{"seq":2}', '{"seq":3}'])
  const naive = zlib.zstdDecompressSync(buf).toString('utf8')
  const multi = decodeZstdText(buf)
  // The header line is itself valid JSON, so the multi-frame read yields
  // 1 header + 3 events. The naive read yields only the header — which is
  // exactly the silent data loss this module exists to prevent.
  assert.equal(parseEvents(naive).events.length, 1, 'naive read loses everything after frame 0')
  assert.equal(parseEvents(multi.text).events.length, 4, 'multi-frame read keeps header + all events')
  assert.equal(multi.failed, 0, 'no frame failed to decode')
})

test('rewriteHeaderFrame changes ONLY frame 0 and preserves later bytes', () => {
  const header = { id: 'a', cwd: 'C:/old', version: 4 }
  const buf = buildLog(header, ['{"seq":1}', '{"seq":2}'])
  const before = scanZstdFrames(buf)
  const r = rewriteHeaderFrame(buf, { cwd: 'D:/new' })

  assert.equal(r.framesAfter, r.framesBefore, 'frame count is unchanged')
  assert.equal(r.header.cwd, 'D:/new', 'cwd was patched')
  assert.equal(r.header.id, 'a', 'other header fields survive')

  const after = scanZstdFrames(r.out)
  const oldRest = buf.subarray(before[0].end)
  const newRest = r.out.subarray(after[0].end)
  assert.deepEqual(newRest, oldRest, 'every byte after frame 0 is identical')

  const events = parseEvents(decodeZstdText(r.out).text).events
  assert.equal(events.length, 3, 'header + 2 events, unchanged')
})

test('rewriteHeaderFrame refuses a first frame that is not exactly one line', () => {
  // A two-line first frame violates the boot invariant, so the rewrite must
  // throw rather than write a file that white-screens on next start.
  const bad = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from('{"id":"x"}\n{"extra":"line"}\n', 'utf8'), ZSTD_PARAMS),
    zlib.zstdCompressSync(Buffer.from('{"seq":1}\n', 'utf8'), ZSTD_PARAMS),
  ])
  assert.throws(() => rewriteHeaderFrame(bad, { cwd: 'X' }), /不是恰好一行 header/)
})

test('isExactlyOneHeaderLine matches the boot assertion', () => {
  assert.equal(isExactlyOneHeaderLine('{"a":1}\n'), true)
  assert.equal(isExactlyOneHeaderLine('{"a":1}'), false, 'no trailing newline')
  assert.equal(isExactlyOneHeaderLine('{"a":1}\n{}\n'), false, 'two lines')
  assert.equal(isExactlyOneHeaderLine(''), false, 'empty')
})

test('auditSessionLog reports a healthy multi-frame log', () => {
  const buf = buildLog({ id: 'a', cwd: 'C:/x' }, ['{"seq":1}', '{"seq":2}'])
  const file = path.join(process.env.TEMP || '.', 'dsh-audit-test-' + Date.now() + '.zstd')
  fs.writeFileSync(file, buf)
  try {
    const audit = auditSessionLog(file)
    assert.equal(audit.ok, true, audit.problems.join('; '))
    assert.equal(audit.frames, 3)
    assert.equal(audit.events, 3, 'header line + 2 events')
    assert.equal(audit.headerOk, true)
  } finally {
    fs.rmSync(file, { force: true })
  }
})
