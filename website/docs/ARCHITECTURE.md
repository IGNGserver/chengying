# 澄影（Chengying）官方网站架构说明

本文档说明 `website/` 的视觉叙事结构、WebGL2 线性光暗房管线、摄影资产构建方式与验证体系。

## 1. 设计哲学与视觉系统

澄影官网拒绝通用 AI SaaS 模板（紫色渐变、悬浮发光卡片、虚假数据看板），采用**美术馆摄影画册 × 专业色彩暗房控制台**的双重美学体系：

- **双环境光环绕（Surround Modes）**：
  - `darkroom`（D65 暗房黑曜石 `#09090b`）：面向低照度审片与高动态范围对比，最大程度减少人眼明适应干扰。
  - `baryta`（硫酸钡摄影棉纸 `#f3eee5`）：复刻银盐展览微喷画册的暖调纸基质感。
- **字排系统（全本地自托管 `@fontsource-variable/*`，零外部 CDN）**：
  - 展示衬线：`Cormorant Variable` + `Noto Serif SC`（画册章节名、作品标题）
  - 界面无衬线：`Plus Jakarta Sans` + `Noto Sans SC`
  - 暗房/EXIF/XMP 参数等宽：`JetBrains Mono Variable`

## 2. 六幕沉浸式交互叙事（Six-Act Choreography）

| 幕次 | 模块文件 | 核心视觉与交互机制 | 对应澄影真实产品能力 |
|---|---|---|---|
| **Act I · 首幕** | `src/stages/hero-stage.ts` | 全屏高海拔破晓风光作品；支持指针拖拽分割线、滚动视差联动、`O` 键光学放大镜检视与实时 256-bin RGB 波形示波器 | RAW 线性底片输入 vs 场景参考（Scene-Referred）母版精修对比 |
| **Act II · 筛图墙** | `src/stages/culling-wall.ts` | 24 张连拍底片接触印相网格 → 逐组识别闭眼/手抖模糊/过曝/地平线倾斜 → 废片渐暗（`0` 字节删除）→ **FLIP 几何过渡**重组为 8 幅远征视觉叙事长卷；含 `#ffd54f` 1:1 眼部特写 VLM 审片弹窗 | `photo_cull`、`photo_select`、Laplacian 锐度评分、dHash 64-bit 聚类、VLM 闭眼检测 |
| **Act III · 数字暗房** | `src/stages/digital-darkroom.ts` + `src/gl/` | 实时 WebGL2 线性光暗房：曝光/色温/色调/光影六滑块、可拖拽 **Fritsch–Carlson 单调三次样条曲线**（Master/R/G/B）、预设与手绘径向局部蒙版、斑马纹裁切预警、澄影审美红线护栏、可逆修订栈（`edit_apply`/`edit_revert`）与实时 `.chengying.json` / `darktable .xmp` / `RawTherapee .pp3` 代码检视 | 三层可逆算子栈、暗房审美硬约束、非破坏式 Sidecar 编译 |
| **Act IV · Agent 编排** | `src/stages/agent-workflow.ts` | 6 帧跨场景摄影集分配给独立 Sub-Agent：展示 `sceneAnchor` 锚点屏障、`copy_from_task` 影调同步、过饱和红线拦截后自动 `edit_revert` 自愈、以及 `status: "unchanged"` 克制原片原则 | `EditOrchestrator`、`presets/chengying.patch.yml`、Sub-Agent 预算与自检闭环 |
| **Act V · 授权边界** | `src/stages/auth-boundary.ts` | 同一帧雨夜渔港底片的三种受控状态对比：① 原片 `FsGuard` 只读 SHA-256 锁定；② 确定性非生成 `ai:inpaint`（Telea 电线消除，无需授权）；③ 显式人工审批网关解锁 `edit_generate`（`ai:gen_layer`）并写入 IPTC `compositeWithTrainedAlgorithmicMedia` 溯源标记 | `Symbol('authorized-generative-flow')` Fail-Closed 门禁、`generated_assets` 16-bit PNG 图层与回滚清除机制 |
| **Act VI · 引擎与接入** | `src/stages/engine-matrix.ts` | 四阶引擎（darktable 5.6.1 / RawTherapee 5.13 / Builtin 32f / AI Stage）共 **174 算子、2,448 参数**分类搜索面板、5 大随包摄影技能、28 种 RAW 格式矩阵与 DSH 安装命令一键复制 | `docs/coverage/*.json` 硬件回读校验真源、`dsh plugin add` 与 CLI 接入 |

## 3. WebGL2 线性光渲染器（`src/gl/`）

- **Shader 管线（`src/gl/shaders.ts`）**：
  1. sRGB EOTF 解码至线性工作空间；
  2. EV 曝光增益（$2^{\text{EV}}$）与开尔文色温/洋红绿偏移矩阵；
  3. 感知亮度分离的高光压缩、阴影提亮、黑位与中灰对比度曲线；
  4. **256×1 RGBA 纹理查找表（LUT）**：由 `evaluateMonotoneCubicLut` 实时计算单调三次样条曲线，先作用 Master 通道，再分别作用 R/G/B 通道；
  5. 多形状参数化与手绘椭圆径向羽化局部蒙版（含青色密度叠加预览模式）；
  6. Oklch/Rec.709 感知亮度保持的自然饱和度（Vibrance）与全局饱和度；
  7. sRGB OETF 编码与斜向斑马纹（高光 >98.6% 暖红、死黑 <0.6% 冷青）实时叠加。
- **优雅降级（`src/gl/darkroom-renderer.ts`）**：当宿主环境禁用硬件 WebGL2 时，自动退化至 Canvas 2D 合成渲染器，确保页面功能与交互不中断。

## 4. 摄影资产与构建验证流水线

- `scripts/build-photo-assets.mjs`：使用 `sharp` 将高分辨率底片离线派生为全尺寸精修 WebP、线性模拟 RAW 底片（降对比、色温偏移与轻微暗角）、24 张连拍缩略图（含真实卷积核动态模糊、曝光包围偏差与地平线倾斜）、`#ffd54f` 面部 1:1 裁切图以及社交分享卡片 `public/og/og.jpg`。
- `scripts/verify-website.mjs`：启动静态生产预览服务并用无头 Chromium 完整回归：
  - 构建包体积预算校验与零外部 CDN 断言；
  - 桌面端（`1440×900`）、平板端（`820×1180`）、手机端（`390×844`）零水平溢出与零 Console/Page Error 断言；
  - 六幕核心交互（光学分割拖拽、24→8 筛图动画与闭眼检视弹窗、暗房预设/样条曲线/斑马纹/Sidecar 切换、多 Agent 编排回放、生成式人工审批解锁与撤销、引擎参数检索、双主题与中英双语切换）自动化端到端测试。
