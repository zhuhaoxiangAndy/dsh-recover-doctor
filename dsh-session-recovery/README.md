# dsh-session-recovery

DSH (DeepSeek Harness) 插件：**宿主异常退出/中断/重启后，主动检测「上次干到一半」的会话并一键恢复。**

对齐 `dsh 0.2.1-rc.5`，零 npm 依赖。

## 为什么需要它

DSH 内建了 **crash-repair**（`packages/core/session/src/repair.ts`）：冷打开一个因崩溃中断的会话时，会为孤儿工具调用合成恢复结果——未记录开始的记 `TOOL_NOT_STARTED`，已记录但无结果的记 `TOOL_OUTCOME_UNKNOWN`（提示「先核实外部状态再决定是否重试，不要盲重试」）。

**但它是被动的**：你不打开那个会话，就永远不知道它中断了、也不会被修复。本插件补上缺失的一环——启动时主动扫描所有可见会话的尾部，找出未闭合轮并提示/恢复。

## 检测原理

与宿主 `repair.ts` **同构**的状态机：会话事件流里最后一个 `turn/start` 没有对应 `turn/end`，即为中断会话。

同时区分两类待恢复工具调用：
- `TOOL_NOT_STARTED` —— 助手已请求但从未记录 `tool/call`（可以安全重试）；
- `TOOL_OUTCOME_UNKNOWN` —— 已记录 `tool/call` 但无结果（**必须先核实外部状态**）。

若宿主已在冷读时合成了 `turn/end`（`reason.kind === 'interrupted'`），则报告 `crash-repair 待修复 N 调用` 计数。

**不激活 Agent**：只用 `sessionController.list()`（读 header + 投影缓存）与 `sessionController.inspect()`（读事件前缀），两者按 rc.5 源码都不 resume Agent。

## 用法

```
/recover list                     # 列出中断会话（id、标题、工作区、中断轮次、待修复调用）
/recover doctor                   # 迁移后一致性体检（只读，见下节）
/recover resume <id>              # 复活会话并注入"继续"消息（宿主的 crash-repair 会补齐孤儿调用）
/recover fork <id> [seq]          # 保守方案：从最后闭合轮 fork 子会话（中断轮内容不继承）
/recover dismiss <id>             # 忽略（本进程有效）
```

id 支持唯一前缀。

## 迁移体检 `/recover doctor`（v0.2.0）

一次「把会话迁到另一个工作区」会**同时**改动四处状态，只改一部分就会出现怪现象：

| # | 状态 | 漏改的症状 |
|---|---|---|
| 1 | 会话归档文件 `sessions/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd` | 报 `ENOENT`、工具 cwd 失效 |
| 2 | 归档文件**第 0 帧**里的 `cwd` | 同上；boot 还会因帧不变式失败而白屏 |
| 3 | 工作区注册表 `workspace.json` 的 `path` / `sessionIds` / `workspaceIds` | 会话归类错、出现"幽灵"会话 |
| 4 | 投影缓存 `session_projcache/sessions/<id>.json` 的 `identity.cwd` 等 | 侧栏显示旧路径、历史打不开 |

`/recover doctor` 把这些判据固化成**只读**检查，**不修改任何文件**：

| 检查项 | 判据 | 真实事故对应 |
|---|---|---|
| 注册表结构 | `global.workspaceIds` 必须与 `tables.workspaces` 的键**同集** | `workspaceIds` 16 项 vs 表 15 条 → 悬空 id 让会话被判 `unregistered`，表现为"点进去没有历史" |
| 会话归属 | 一个 sessionId 只能被**恰好一个**工作区记账 | 两个工作区同时记账 → 侧栏出现两条同名会话 |
| cwd 契合 | 会话 cwd 应对应某个已登记工作区 `path` | cwd 不匹配 → 会话显示为未归属 |
| 归档冲突 | 会话不能同时在工作区记账与 `archivedSessionIds` 里 | — |
| 标题/分组同名 | 工作区标题同时也是某分组路径 | `RBE999` 工作区 + `RBE999/Sim-to-Real…` → 同一行被放置两次、反复出现 |

### 为什么还要复刻 `projectKey()`

DSH 的项目目录名不是随手拼的：

- `/`、`\`、`:` 三个分隔符**合并成一串**后只产生**一个** `-`
- `[A-Za-z0-9._-]` 原样保留；**其它字符**（含 `!`、空格、`+`、`~`）转成 `~` + 4 位大写十六进制码位
- 最后包一层 `--…--`

例：`D:\Downloads\!ISA104` → `--D-Downloads-~0021ISA104--`。
当年拿到那个 `ENOENT` 路径之所以认不出来，就是因为不知道 `!` 会变成 `~0021`。
本插件用 `projectKey()` 做对照，让 doctor 能指出「归档文件应该在哪个目录」。

### 关于日志帧（只作背景，不解析）

会话日志是**上千个 zstd 帧首尾相接**，`zlib.zstdDecompressSync(整个文件)` 只解出第 1 帧
且**不报错**——把它解压后重压会塌缩成单帧，静默丢掉其余全部数据（真实事故里一个会话从
731 帧变成 1 帧）。所以：**doctor 不读日志正文**，只走 `sessionController.list()` 这类公开 API。
日志层面的修复请用专用工具（见工作区 `TODO_dsh-session-recovery.md`）。

## 配置

Settings namespace `session-recovery`：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `notifyOnBoot` | `true` | 启动时若发现中断会话，注入 system prompt 提示段 |
| `resumeMessageTemplate` | 见下 | 注入的继续消息模板，支持 `{turn}` `{seq}` `{title}` `{sessionId}` |
| `maxScanSessions` | `50` | 每次最多扫描多少个会话（按最后活动倒序） |
| `excludeWorkspaceGlobs` | `[]` | 跳过匹配的工作区（支持 `**`、`*`，Windows 大小写不敏感） |
| `autoResumeIds` | `[]` | **默认空 = 绝不自动恢复**；填入 id 才在启动时自动恢复 |

默认继续消息：

```
上次会话在异常退出时中断于第 {turn} 轮（事件 seq {seq}）。
请检查未完成的工具调用：TOOL_OUTCOME_UNKNOWN 的先核实外部状态，
然后从中断处继续（不要重放已完成的步骤）。
```

## 安装

**A. 官方 CLI（web / tui / 其他 profile）**

```powershell
dsh plugin --profile web add "file:/path/to/dsh-session-recovery"
```

CLI 会自动把本包加入 `dsh.profile.bundles`（因为 `package.json` 声明了 `dsh.bundle.patch`），无需手改 profile 文件。

**B. 桌面端（Electron）**

桌面 profile 由 Electron 独占，只能用界面安装：设置 → 插件 → 安装 → 选择本目录打包的 tgz（`npm pack` 产物）或粘贴路径，然后重启应用。

**C. 手工挂载（等价于 A）**

profile 的 `package.json`：

```json
{
  "dependencies": { "dsh-session-recovery": "file:/path/to/dsh-session-recovery" },
  "dsh": { "profile": { "bundles": ["...", "dsh-session-recovery"] } }
}
```

## 验证

装好后重启宿主，日志应出现：

```
[dsh-session-recovery] host half loaded (aligned to dsh 0.2.1-rc.5)
[dsh-session-recovery] settings namespace registered: session-recovery
[dsh-session-recovery] command registered: /recover
[dsh-session-recovery] initial scan: N interrupted / M scanned / K skipped
```

然后运行 `/recover list`。

## 安全设计

- **绝不自动恢复**：`autoResumeIds` 默认空；
- 只调用官方公开 API（`list` / `inspect` / `fork` / `prompt`），不直接解析或改写 `~/.dsh/sessions` 的 zstd 日志；
- `running` 状态的会话视为当前活跃，不算「上次中断」，跳过；
- 扫描失败、inspect 失败只记日志不影响宿主。

## 上游致谢（设计参考，非代码 fork）

- [terryvanke/dsh-session-rollover](https://github.com/terryvanke/dsh-session-rollover)（MIT）：durable checkpoints / fresh-session handoff / crash recovery 的思路；
- [MedicineKing/dsh-corrupt-session-repair](https://github.com/MedicineKing/dsh-corrupt-session-repair)（MIT）：崩溃后日志修复场景（官方 discussion #1497）。

本插件为独立实现（零依赖 JS），仅借鉴上述设计思想。

## 遗留风险

1. **未在真实宿主端到端验证**：`list` / `inspect` / `prompt` / `fork` 的签名按 rc.5 checkout 核实，但 `sessionController` 在 `ctx` 上的实际挂载形态可能不同（代码已做 `ctx.sessionController` 与 `ctx.get('sessionController')` 双形态容错）。
2. **`systemPrompt.section` 的 API 形态**若与预期不符，boot 提示会静默失效（只影响提示，不影响 `/recover` 命令）。
3. **`prompt` 要求的 content 结构**若需 attachment/其他字段，`resume` 会失败并提示改用 `fork`。
4. 大库扫描有开销：默认最多 50 个会话，可用 `maxScanSessions` 调低。
5. `dismiss` 仅本进程有效（重启后重新出现）。

## License

MIT
