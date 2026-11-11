// 验证 doctor.mjs 的 projectKey 与 DSH 真实实现逐字一致。
// 用真实事故里的 cwd 作对照，期望值来自工作区 TODO_dsh-session-recovery.md。

import { projectKey } from '../src/doctor.mjs'

const CASES = [
  // 真实事故：`!` 是 U+0021 -> ~0021
  ['D:\\Downloads\\!ISA104', '--D-Downloads-~0021ISA104--'],
  ['D:\\Downloads\\SOE888', '--D-Downloads-SOE888--'],
  // 真实迁移目标
  ['D:\\Downloads\\SOE888\\desktop-ball-pet', '--D-Downloads-SOE888-desktop-ball-pet--'],
  // 平级路径
  ['D:\\Downloads\\desktop-ball-pet', '--D-Downloads-desktop-ball-pet--'],
  // 连续分隔符合并成一个 -
  ['C:\\\\a\\\\b', '--C-a-b--'],
  // 空格与加号都要转义
  ['D:\\Downloads\\RBE999\\Sim-to-Real_GR00T-N1.7+SO-101', '--D-Downloads-RBE999-Sim-to-Real_GR00T-N1.7~002BSO-101--'],
  // ~ 自身也要转义
  ['C:\\a~b', '--C-a~007Eb--'],
]

let failed = 0
for (const [input, want] of CASES) {
  let got
  try {
    got = projectKey(input)
  } catch (e) {
    console.log(`FAIL  ${JSON.stringify(input)} threw: ${e.message}`)
    failed++
    continue
  }
  const ok = got === want
  if (!ok) failed++
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${JSON.stringify(input)}`)
  console.log(`        got  ${got}`)
  if (!ok) console.log(`        want ${want}`)
}

console.log()
if (failed > 0) {
  console.error(`${failed}/${CASES.length} projectKey case(s) failed`)
  process.exit(1)
}
console.log(`PASS: ${CASES.length}/${CASES.length} projectKey cases match DSH's real encoder`)
