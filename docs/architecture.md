# 澄影架构

```
DSH host ──► src/dsh (plugin entry)
              ├─ tools/cull.ts     photo_* (phase 1)
              ├─ tools/edit.ts     edit_* / export_run (phase 2)
              ├─ tools/ai.ts       edit_generate / edit_unify_style / gen_* (phase 3)
              ├─ orchestrator.ts   editing sub-agents (ctx.subagents), concurrency, usage
              ├─ runtime.ts        projects, activities/jobs, VLM pass, authorization
              ├─ http.ts           panel API (behind ctx.connection auth)
              └─ ../client         sidebar panel (React via the host ModuleLoader)
                     │
                     ▼
            src/core (host-independent; also used by the CLI and tests)
              ├─ project.ts        one workspace = one SQLite DB (node:sqlite) under stateRoot
              ├─ fsguard.ts        read: workspace + own dirs; write: own dirs only; originals never writable
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
              └─ export/           full-res render + metadata copy + read-back verification + recipes
```

## 数据与持久化

- 每个工作区在 `stateRoot/projects/<id>/` 下有一个 SQLite 数据库和 `previews/ thumbs/ renders/ assets/ sheets/ scratch/` 目录；工作区本身只被读取。
- 表：files、shots、features、scores、groups、selections、tasks、revisions、events、usage、exports、authorizations、prefs、feedback。
- 修订是不可变的 `EditDocument`（源文件 + 有序阶段 + 每阶段步骤 + 来源标记）。撤销/检出是"把旧文档作为新修订"，历史不丢。
- 任务状态机：queued → running → succeeded / failed / paused / cancelled / waiting-authorization。宿主重启时 running 的任务回到 queued，子 Agent 从最新修订继续。

## 引擎适配层

每个引擎实现 `EngineAdapter`：`probe`（可用性、版本、指纹）、`catalog`（完整操作目录 + JSON Schema）、`validateStep`、`render`、`recipe`（原生配方）、`importRecipe`、可选 `callNative`。

- **darktable**：C 助手 `dt-introspect` 在 fork 出的子进程里逐个 dlopen iop 模块，导出 introspection 字段树（结构体、数组、枚举、联合、浮点范围/默认值）、默认混合色彩空间、混合参数版本和管线顺序；适配器按字段布局把 JSON 参数编码为二进制 params，写 XMP v5 历史（含蒙版 `masks_history`、绘制形状、参数化混合），用 `darktable-cli` 渲染；多实例使用自定义 iop 顺序。darktable 5.7+ 提供 darktable-mcp 时改用 MCP 获取目录与编解码。
- **RawTherapee**：`-O` 导出完整 pp3 键空间，结合源码派生的类型/范围提示生成 schema；Locallab 局部调整点作为数组参数；渲染用 sidecar pp3（`-p`），并用 `dumpProfile` 回读 RT 实际使用的配置。
- **内置**：线性光浮点管线（libvips 解码/编码），23 个操作，所有非几何操作支持绘制 + 参数化蒙版。
- **AI**：见 README 第 3 阶段。生成式结果作为资产保存，`gen_layer` 只做合成，因此渲染确定。

渲染在阶段之间传递 16 位 TIFF；预览在第一阶段缩小，后续阶段收到 `previewEdge` 与 `fullEdge`，像素尺寸类参数按比例缩放。

## 子 Agent 隔离

`EditOrchestrator` 为每个任务预留 child id，监听 `agent/created`，在子 Agent 自己的作用域注册任务绑定工具（无 `task` 参数），并 `restrict` 全局工具到只读的引擎发现工具。子 Agent 不能运行 shell、不能读写任意文件、不能操作其他任务或修改授权。

## 安全边界

- `FsGuard`：读限于工作区与插件目录；写限于插件状态目录与导出目录；原图路径永远拒绝写入；外部命令只接收插件生成的临时文件路径。
- 生成式授权：`acquireGenerative` 只接受用户授予的记录、DSH 审批提示中的"允许"，或显式配置的策略；渲染时校验每个生成图层携带的授权 ID。
- 凭据：生成式提供者的 API key 只从配置指定的环境变量读取，不进入配置文件、日志或数据库。
- HTTP 面板 API 经 `ctx.connection.requestRejection` 校验，只服务插件目录中的文件。
