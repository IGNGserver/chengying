# 澄影 Chengying

澄影是 **DeepSeek Harness（DSH）** 的 AI 摄影后期插件，面向旅行、活动等大批量照片，把"筛图 → 专业修图 → 高级智能后期 → 导出"做成 Agent 可以端到端执行、用户可以随时查看和接管的工作流。

- **原图只读**：所有处理都写在插件自己的状态目录与导出目录，原始文件永不修改、移动或删除（`FsGuard` 强制）。
- **非破坏、可恢复**：每次修改都生成一个不可变修订（revision），可撤销、回到任意历史版本；任务中断后从最新修订继续。
- **专业引擎全接口**：darktable、RawTherapee 的全部模块/参数由插件从已安装的引擎**自动发现**，以 JSON Schema 暴露给 Agent，而不是一组预设。
- **真实性优先**：生成式修改必须经用户授权，导出文件会被标注为含 AI 生成内容。

## 三个阶段

### 1. 自动筛图

`photo_workspace_open` 指定工作目录 → `photo_cull_run`：

- 扫描图片（JPEG/HEIF/TIFF/PNG 及主流 RAW），用 ExifTool 读取拍摄时间、时区、GPS、相机/镜头、曝光参数；RAW 与机内 JPEG 自动配对为同一张"照片"。
- 生成预览（优先内嵌预览，回退到 libvips / sips），在 worker 池中计算像素特征：清晰度（对比度归一化）、曝光/高光/暗部裁切、噪声、色彩、构图（三分法/水平线/主体显著性）、感知哈希等。
- 分组：精确重复（内容哈希）、近似重复（pHash/dHash）、相似场景（颜色与 Lab 缩略图）、按时间与地点切分的行程片段。
- 评分：传统视觉评分 + 可选专用模型（`models`：command / http / onnx 打分器）+ 可选视觉大模型（`photo_vlm_score`，联系表批量打分，覆盖技术质量、美学、构图、内容价值、后期潜力）。
- 选片：`photo_select` 把自然语言（"选 30 张最好的""4 分以上全要""多留人像少要重复的日落"）解析成数量/阈值/偏好，按 MMR 兼顾质量、场景多样性和行程叙事（每个片段的配额）。数量与阈值都不设上限。
- 人工调整：`photo_selection` / `photo_flag` 增删、锁定、标记；用户的取舍会作为偏好学习，影响后续评分。
- **从不删除原图**：重复与淘汰只是标记。

### 2. 专业修图 Agent

- `edit_tasks_create` 为每张入选照片建立一个**独立、可恢复的修图任务**（优先 RAW）。
- `edit_run` 按需拉起 DSH 子 Agent（`ctx.subagents`，默认 `spawn` 提供者），并发受 `editing.maxConcurrent` 限制；每个子 Agent 只拿到绑定该任务的工具，看不到 shell、文件系统和其他任务。
- `edit_task` 支持暂停/恢复/重试/取消；失败按 `editing.maxAttempts` 自动重试；子 Agent 的模型用量逐任务记录。
- 子 Agent 的工作循环：`edit_task_info` 看图与历史 → `edit_capabilities` / `edit_describe` 查操作和完整参数 schema → `edit_apply` 原子地应用一组操作并立刻得到预览与直方图/裁切/饱和度统计 → `edit_preview`（与原图对比）→ 不满意就 `edit_revert` → `edit_finish` 写总结。
- 多阶段管线：例如 darktable 显影 RAW → 内置引擎精修 → AI 阶段；每个阶段的配方都以引擎原生格式（XMP / pp3 / JSON）保存。

### 3. 高级智能后期（AI 阶段，引擎 `ai`）

| 操作 | 说明 | 是否生成式 |
|---|---|---|
| `ai:upscale` | 超分辨率：外部模型 CLI（Real-ESRGAN、waifu2x 等，`superResolution` 配置）或 Lanczos3 + 细节恢复 | 否（模型超分会在说明中注明） |
| `ai:inpaint` | 经典修补（Telea 快速行进），去除电线、灰尘、小干扰物；只用周围像素填充 | 否 |
| `ai:style_match` + `edit_unify_style` | 跨照片统一风格：以参考照片的 Lab 色彩统计与影调分位数为目标，色偏位移与对比度缩放有上限，保护高光/暗部中性 | 否 |
| `edit_generate` → `ai:gen_layer` | 生成式填充 / 移除 / 替换 / 增强：调用配置的提供者（OpenAI 兼容 `images/edits`、ComfyUI 工作流、任意命令行）**一次**，结果作为带蒙版的图层写入修订，渲染确定、预览与导出一致 | **是，需用户授权** |
| `aiOperations` | 任意外部确定性图像命令，按其参数 schema 自动出现在目录中 | 否 |

生成式授权只有三种来源：用户在插件面板点"授权生成式修改"；`gen_authorize` / `edit_generate` 触发 DSH 审批提示且**用户点了允许**；或用户在配置里显式设置 `generative.requireApproval: false`。Agent 无法自行授予。每个生成图层记录授权 ID；含生成图层的导出写入 `XMP-iptcExt:DigitalSourceType = compositeWithTrainedAlgorithmicMedia`，撤销该图层后导出不再带此标记。

批量入口 `photo_ai_redraw` 在一次 `gen_authorize({ max_uses: 张数 })` 授权下对整批照片各调用一次 provider；单张针对性微调仍用 `edit_generate`。

## 引擎与接口覆盖

| 引擎 | 发现方式 | 本机实测（2026-10） |
|---|---|---|
| darktable 5.x | `native/dt-introspect.c` 通过 dlopen 读取每个 iop 模块的 introspection（字段、类型、范围、默认值、枚举）、混合参数版本与管线顺序；或 darktable 5.7+ 自带的 darktable-mcp | 93 个模块、738 个参数；89 个渲染 + XMP 回读一致，1 个为导出管线内部模块（`finalscale`），3 个没有 introspection（只能以原始参数块透传） |
| RawTherapee 5.x | `rawtherapee-cli -O` 导出完整处理配置（56 节、872 键）+ Locallab 局部调整点（836 键） | 54 个工具、1593 个参数，全部渲染并回读一致 |
| 内置（libvips + JS） | 注册表 | 23 个操作、95 个参数，全部渲染且与空配方的像素比对确有变化 |
| AI 阶段 | 注册表 + 配置的模型/命令 | 4 个操作、22 个参数，全部渲染且确有变化；另加 `aiOperations` 中的自定义命令 |

引擎升级后，目录按"二进制路径 + 版本 + 修改时间"指纹自动重新发现，新增的模块/参数无需改代码即可调用。详细方法、未覆盖项与原因见 [docs/engine-coverage.md](docs/engine-coverage.md)，原始报告在 `docs/coverage/`。

复现覆盖验证：

```bash
chengying engines list
chengying engines verify darktable --input <某个 RAW> --report darktable.json
chengying engines verify rawtherapee --input <某个 RAW> --report rawtherapee.json
chengying engines verify builtin
chengying engines verify ai
```

## 安装

需要 Node.js ≥ 24.9 与 DeepSeek Harness ≥ 0.2.1（`dsh-agent-preset`）。darktable、RawTherapee 是**可选**依赖：未安装时筛图与内置引擎照常可用。

```bash
pnpm install
pnpm build
pnpm pack                                          # 得到 chengying-<version>.tgz
dsh plugin --profile web add ./chengying-<version>.tgz
```

然后确认 profile 的 `package.json` 中 `dsh.profile.bundles` 含有 `chengying`。也可以用 `--patch` 叠加层直接加载构建产物：

```yaml
- insert:
    - id: chengying
      name: '/path/to/chengying/lib/index.js'
      config:
        mode: both          # headless/direct patch: host + agent in one row
```

插件会向 DSH 的新任务预设列表注册 **“澄影 · 摄影后期”**。新建对话时选择它，才会加载 36 个摄影工具和摄影工作流；普通 DSH 会话不会被摄影工具污染。右侧栏的“澄影”面板是进度与结果监视器，只在有澄影会话/工作区时才有内容。

> 预设只决定工具与提示词组合，不是安全沙箱；原图只读仍由 `FsGuard` 强制。

### 不使用预设

- Web 中想恢复旧行为：把 Host 行 `config.mode` 设为 `both`，所有会话都会带上摄影工具。
- Headless / 自己的 `--patch`：没有 preset roster，`mode: auto` 会自动退化为 `both`，无需额外配置。
- 只想用 CLI：`chengying cull/select/status/engines` 不依赖 DSH 预设。

### 一个典型的澄影会话

```text
（新建任务选择“澄影 · 摄影后期”）
用户：/Volumes/trip/2026-hangzhou 这次只筛图，选 60 张，按行程讲故事，放到 /Users/me/交付/hangzhou
Agent：photo_session_start({ path, goal: "cull", output_dir, brief })
       → photo_cull_run → photo_select → photo_deliver({ mode: "originals" })
```

```text
用户：这些照片修一下再交付，用编辑引擎逐项修，输出到 ~/交付/final
Agent：photo_session_start({ path, goal: "retouch-deliver", retouch: "engine", output_dir })
       → photo_cull_run → photo_select
       → edit_tasks_create({ confirm: true }) → edit_run
       → photo_deliver({ mode: "rendered" })
```

```text
用户：直接 AI 重绘这批，统一成暖色胶片感
Agent：photo_session_start({ ..., retouch: "generative" })
       → photo_cull_run → photo_select
       → gen_authorize({ max_uses: 张数 })   # 用户一次批准整批
       → photo_ai_redraw → photo_deliver
```

### 输入：路径或聊天附件

- 目录路径：`photo_session_start({ path })` / `photo_workspace_open({ path })`，支持 `~` 和相对会话工作目录的路径。
- 单张/多张文件：`files`，或直接把图片/文件贴进聊天后调用 `photo_session_start`；插件会把附件复制到 `stateRoot/inbox/` 的托管工作区，不改动原文件。
- 目录拖入聊天框仍受 DSH 附件 UI 限制；大目录请直接给路径。

### 交付：`photo_deliver`

- `mode: "originals"`：只筛图时复制入选原图（`source: raster | raw | both`），字节不变。
- `mode: "rendered"`：全分辨率渲染，复制并校验元数据，`_recipes/` 保存 JSON 与 XMP/pp3。
- 默认写 `manifest.json`：计划、selection、每张的源/输出/修订、是否含生成式内容、失败项。
- `dir` 可以是任意可写目录；工具会把它加入本次任务的可写根，扫描时会跳过输出目录。
- 交付目录默认沿用会话计划；再次调用 `photo_session_start({ output_dir })` 可以改。

### AI 重绘

`photo_ai_redraw` 是批量生成式模式：每张照片一次 provider 调用，不创建修图子 Agent，结果作为可回退的 `gen_layer`。它要求**一次整批授权**（`gen_authorize({ max_uses: 张数 })`），导出会写入 `XMP-iptcExt:DigitalSourceType = compositeWithTrainedAlgorithmicMedia`。没有配置 `generative.providers` 时会明确报错，不会静默退回引擎修图。

## 配置（`cordis.patch.yml` 中的 `config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `mode` | `auto` | `auto`：有 agent preset 时 Host 只挂 UI/runtime，工具由澄影预设提供；headless/无 preset 时自动 `both`。也可显式 `host` / `agent` / `both` |
| `stateRoot` | `$CHENGYING_HOME` 或 `~/.chengying` | 数据库、预览、渲染、资产；必须在本机盘 |
| `exportDir` | `<工作区>/_chengying_export` | 导出目录 |
| `allowedRoots` | `[]` | 非空时只允许打开这些根目录下的工作区 |
| `vlm` | 启用 | 视觉大模型打分（提供者/模型、批大小、联系表单元尺寸、上限） |
| `models` | `[]` | 专用打分模型 |
| `intake` | `maxFiles: 200`、`maxBytes: 4 GiB` | 聊天附件/文件导入托管 inbox 的上限 |
| `engines.{darktable,rawtherapee,builtin,ai}` | 全部启用 | `path` 可指定 CLI；未指定时自动查找 |
| `defaultEngine` | `auto` | darktable → RawTherapee → 内置 |
| `editing` | 并发 2、重试 3 | 子 Agent 提供者、预览尺寸、子 Agent 模型 |
| `superResolution` | 无 | `{command, args:[…{input} {output} {scale}…], model}` |
| `aiOperations` | `[]` | 自定义 AI 阶段命令 |
| `generative` | 无提供者，需授权 | `providers: [{id, type: openai-images\|comfyui\|command, url, model, apiKeyEnv, command, args, workflow}]`；密钥只从 `apiKeyEnv` 指定的环境变量读取 |
| `ui` | 启用，`/api/chengying` | 面板 HTTP API |

## 导出

`export_run`（默认导出最新入选）全分辨率渲染每张照片的当前修订，用 ExifTool 从源文件复制全部元数据（拍摄时间、时区、亚秒、GPS、相机、镜头、曝光、版权……），重置方向，写入处理软件与配方来源，然后**重新读取导出文件逐项校验**；不一致的导出会被标记为未通过。每张导出旁的 `_recipes/` 中保存 JSON 与引擎原生配方（XMP/pp3），可在 darktable / RawTherapee 中重新打开或由澄影导入。

## 命令行

```bash
chengying cull <工作区>
chengying select <工作区> "选 20 张，多样一点"
chengying status <工作区>
chengying engines [list | verify <engine>]
```

## 开发

本仓库遵循项目级 `AGENTS.md` 与设备级 Agent 规范：开发在 `~/项目/.wt/影视后期插件/<任务>` worktree 中进行，依赖与构建只放在本机 `$BUILD_SCRATCH_ROOT` 或 CI。

```bash
pnpm typecheck
pnpm test                    # 单元与集成测试（合成旅行照片集、预设分层、会话计划、交付、批量 AI 重绘）
pnpm test:engines            # 需要 darktable / RawTherapee（CHENGYING_DARKTABLE_CLI / CHENGYING_RAWTHERAPEE_CLI）
DSH_E2E_RUNTIME=<装有 @deepseek-ai/dsh 的目录> pnpm test:dsh   # 在真实 DSH 中用脚本化模型跑端到端
```

架构说明见 [docs/architecture.md](docs/architecture.md)。

## 发布

版本号在根目录 `VERSION`（不带 `v` 的 SemVer），更新说明在 `.github/release-notes/<version>.md`。推送 `v<version>` 标签后 GitHub Actions 默认创建 prerelease，附带源码包与可安装的插件包（`chengying-<version>.tgz`）；正式版需在 `Release` 工作流中手动选择 `release`。
