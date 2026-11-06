# 澄影架构

```
DSH host (bundle chengying-host, mode: auto)
  ├─ runtime.ts        projects, activities/jobs, VLM pass, authorization, session plans
  ├─ http.ts           panel API (behind ctx.connection auth)
  └─ ../client         sidebar panel (React via the host ModuleLoader)
        ▲
        │ one shared ChengyingRuntime service
        │
DSH agent preset "chengying" (presets/chengying.patch.yml)
  ├─ tools/session.ts   photo_session_start / photo_workspace_import / photo_deliver
  ├─ tools/audit.ts     photo_integrity_check (original baseline)
  ├─ tools/cull.ts      photo_* (phase 1)
  ├─ tools/edit.ts      edit_* / export_run (phase 2)
  ├─ tools/ai.ts        edit_generate / photo_ai_redraw / gen_* (phase 3)
  ├─ skills.ts          runtime skills: batch-ops, engine-troubleshoot
  ├─ orchestrator.ts    editing sub-agents (ctx.subagents), concurrency, usage
  ├─ general tools      bash/pwsh · jobs · present · subagent/workflow · skill · goal · schedule · plan-mode
  └─ system prompt      plan → cull → select → retouch/redraw → deliver
        │
        ▼
src/core (host-independent; also used by the CLI and tests)
  ├─ project.ts        one workspace = one SQLite DB (node:sqlite) under stateRoot
  ├─ fsguard.ts        read: workspace + own dirs; write: own dirs only; originals never writable
  ├─ integrity.ts      scan-time size/mtime/hash baseline; check / repair
  ├─ scan/ meta/       discovery, RAW+JPEG pairing, ExifTool metadata
  ├─ image/ analysis/  previews, pixel features (worker pool), scoring, VLM, models
  ├─ grouping/ select/ duplicates, scenes, trip segments, MMR + narrative selection, preferences
  ├─ edit/
  │   ├─ engine.ts     EngineAdapter contract, Catalog, cache keyed by engine fingerprint
  │   ├─ registry.ts   darktable · rawtherapee · builtin · ai
  │   ├─ service.ts    tasks, immutable revisions, multi-stage render, compare, generate
  │   ├─ verify.ts     interface-coverage verification
  │   ├─ generative.ts providers (openai-images, comfyui, command)
  │   └─ engines/      adapters
  └─ export/
      ├─ exporter.ts   full-res render + metadata copy + read-back verification + recipes
      ├─ deliver.ts    original-copy delivery + manifest
      └─ zip.ts        store-only delivery archive
```

## 预设与 Host/Agent 分层

DSH 的 agent preset 是会话级组合：新建任务时选择，决定该会话的 persona、工具、提示词与 skill。澄影不再把 30+ 摄影工具注册到 Host 层；Host 行只保留 runtime、HTTP 面板和共享服务，`presets/chengying.patch.yml` 在选中预设时挂载 Agent 行。Headless/直接 `--patch` 没有 preset roster，`mode: auto` 自动退化为单行 `both`。

Web 的 web-app patch 会禁用全局模型工具行（bash、fs、jobs、subagent 等），每个预设必须自己列出完整工具面。澄影预设因此在摄影工具之外显式挂载通用工具：bash/pwsh、jobs、present、subagent/subagent_fork、workflow、skill、goal、schedule、plan-mode。Host 行额外做两件事：注册 `shell-env` 的 `DSH_CHENGYING_*` 变量，以及把随包 skill 注册进 `ctx.skills`。这些是叠加，不是替换。

预设是**一棵 Loader 子树**：`mountPreset()` 会审计每一行，任意一行导入或激活失败就整体拒绝。宿主在不同 minor 之间会重划自己的工具行（例如 0.2.2 把 `dsh-tool-subagent-control/list-agents` 并进主入口并删掉该子路径导出），而预设里写死了行名。所以**凡是写包子路径的行都必须带 `disabled: !!js` 守卫**：运行时按 `ctx.baseUrl` 解析该子路径，解析不到就跳过本行。`tests/preset-shape.test.ts` 守着这条规则。失败现象与取证见 [`troubleshooting.md`](troubleshooting.md)。

预设只决定工具与提示词组合，不是安全沙箱；`FsGuard` 约束摄影工具，shell 不受它约束（见“安全边界”）。

## 会话计划

`photo_session_start` 把来源、范围、修图方式、筛图质量、交付目录和 checkpoint 写入项目 DB 的 `sessionPlan:<sessionId>`（`src/dsh/plan.ts`）。后续工具执行计划守卫：

- `goal: cull` 时 `edit_tasks_create` / `edit_run` 拒绝；
- `retouch: generative` 时 `edit_run` 拒绝，改走 `photo_ai_redraw`；
- `checkpoint: after-selection` 时 `edit_tasks_create` 第一次返回 `needsConfirmation`，`confirm: true` 后才建任务；
- `photo_deliver` 默认使用计划里的 `outputDir` / `deliverMode`。

## 输入与交付

- 聊天附件：Host 的附件对象按内容哈希存储（`DSH_HOME/attachments/v1/objects/<xx>/<sha256>`，无扩展名）。`photo_session_start` 汇总本会话人类消息里的附件，通过 `attachments.imageHostPath/fileHostPath` 找到只读路径，按 `mediaType` / 客户端文件名 / 文件头（`src/core/image/format.ts`）补齐扩展名，复制到 `<会话工作区>/_chengying_inbox/session-*/` 后作为工作区打开；交付默认落在 `<会话工作区>/_chengying_export/`。无会话工作区时回退 `stateRoot/inbox/`，`intake.location: state` 可显式使用旧行为。
- 扫描兜底：`scanner` 对没有已知扩展名的文件读取文件头，识别为图片时用检测到的 `ext` 入库（TIFF 容器再用 ExifTool `FileTypeExtension` 细分 RAW），因此历史遗留的无扩展名 inbox 也能被重新扫描。
- `photo_deliver`：
  - `originals` 字节级复制入选原图；
  - `rendered` 走现有 exporter；
  - 两者都可写 `manifest.json`，并把交付目录动态加入 `FsGuard` 可写根。

## 数据与持久化

- 每个工作区在 `stateRoot/projects/<id>/` 下有一个 SQLite 数据库和 `previews/ thumbs/ renders/ assets/ sheets/ scratch/` 目录；工作区本身只被读取。
- 表：files、shots、features、scores、groups、selections、tasks、revisions、events、usage、exports、authorizations、prefs、feedback、originals_baseline。
- 修订是不可变的 `EditDocument`（源文件 + 有序阶段 + 每阶段步骤 + 来源标记）。撤销/检出是"把旧文档作为新修订"，历史不丢。
- 任务状态机：queued → running → succeeded / failed / paused / cancelled / waiting-authorization。宿主重启时 running 的任务回到 queued，子 Agent 从最新修订继续。

## 引擎适配层

每个引擎实现 `EngineAdapter`：`probe`（可用性、版本、指纹）、`catalog`（完整操作目录 + JSON Schema）、`validateStep`、`render`、`recipe`（原生配方）、`importRecipe`、可选 `smokeTest`（真实渲染一张 48×32 的图，`health` 用）、可选 `callNative`。`probe` 只回答"装没装"，`health`（注册表缓存，按指纹失效）回答"能不能用"，`pick()` 只从健康引擎里选。

- **darktable**：模块发现顺序为 darktable-mcp（5.7+）→ 随包目录快照（精确版本，缺省时降级到同 minor）→ C 助手 `dt-introspect`（POSIX：在 fork 出的子进程里逐个 dlopen iop 模块，导出 introspection 字段树、默认混合色彩空间、混合参数版本和管线顺序）。针对 `tonecurve`、`rgbcurve`、`basecurve`、`colorzones` 等样条曲线模块额外提供 `curves` 点对高层语法糖并自动展开为底层结构体数组；适配器按字段布局把 JSON 参数编码为二进制 params，写 XMP v5 历史（含蒙版 `masks_history`、绘制形状、参数化混合），用 `darktable-cli` 渲染；多实例使用自定义 iop 顺序。
- **RawTherapee**：`-O` 导出完整 pp3 键空间，结合源码派生的类型/范围提示生成 schema；Locallab 局部调整点作为数组参数；渲染用 sidecar pp3（`-p`），并用 `dumpProfile` 回读 RT 实际使用的配置。
- **内置**：线性光浮点管线（libvips 解码/编码），23 个操作，所有非几何操作支持绘制 + 参数化蒙版。
- **AI**：见 README 第 3 阶段。生成式结果作为资产保存，`gen_layer` 只做合成，因此渲染确定。

所有交给外部进程的路径都经 `cliPath()`（Windows 下转成 `/`）：`darktable-cli` 会把输出参数当模式串解析，反斜杠被当转义符吃掉，导致"退出码 0 但没有写文件"。

**预览回退链**：`makePreview` 依次尝试 libvips 解码 → 内嵌 JPEG → **已安装的 RAW 引擎显影**（`Project.options.rawFallback`，由运行时接到 `EngineRegistry`）→ TIFF IFD0 → macOS `sips`。手机 DNG 这类 CFA 压缩数据只能走引擎这一步；没有引擎时返回带 `hint` 的错误，而不是把 `vips_colourspace` 的原话抛给 Agent。`photo_preview` 复用同一条路径，且不创建修图任务。

渲染在阶段之间传递 16 位 TIFF；预览在第一阶段缩小，后续阶段收到 `previewEdge` 与 `fullEdge`，像素尺寸类参数按比例缩放。

## 子 Agent 隔离

`EditOrchestrator` 为每个任务预留 child id，监听 `agent/created`，在子 Agent 自己的作用域注册任务绑定工具（无 `task` 参数），并 `restrict` 全局工具到只读的引擎发现工具。这个限制会过滤祖先层（包括预设挂载的 bash/pwsh），所以主 Agent 可以用 shell，修图子 Agent 仍然不能用；子 Agent 也不能读写任意文件、操作其他任务或修改授权。

## 安全边界

- `FsGuard`：读限于工作区与插件目录；写限于插件状态目录、项目导出目录和本次显式交付目录（`addWritableRoot` 按需加入，扫描会跳过它）；原图路径永远拒绝写入；外部命令只接收插件生成的临时文件路径。
- 原图完整性：扫描时把 `size`/`mtime`（以及可用的全量 SHA-256）写入 `originals_baseline`，重扫不覆盖；`photo_integrity_check` 对比基线，`photo_deliver` 交付前自动快速检查并把 `originalsIntact` 写进结果与 manifest，`repair_baseline` 是显式接受当前状态。shell 绕过 FsGuard 时，这套基线负责**发现**而不是阻止越界。
- 生成式授权：`acquireGenerative` 只接受用户授予的记录、DSH 审批提示中的"允许"，或显式配置的策略；渲染时校验每个生成图层携带的授权 ID。
- 凭据：生成式提供者的 API key 只从配置指定的环境变量读取，不进入配置文件、日志或数据库。
- HTTP 面板 API 经 `ctx.connection.requestRejection` 校验，只服务插件目录中的文件。
