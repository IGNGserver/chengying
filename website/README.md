# 澄影官网 · Chengying Official Website

澄影（Chengying）产品官方网站，位于产品主仓库 `website/` 目录，完整呈现澄影面向 **DeepSeek Harness（DSH）** 的 AI 摄影筛图、非破坏式线性光数字暗房、RAW 多引擎自省架构、多 Agent 沙盒协同工作流与默认拒绝（Fail-Closed）的生成式授权边界。

- 产品仓库：<https://github.com/IGNGserver/chengying>
- 当前对应版本：`v0.8.0`

## 核心体验与架构亮点

1. **沉浸式光学显影首屏（WebGL2 Linear-Light Curtain & 2.4× Loupe）**：全画幅摄影作品占据视觉核心，支持鼠标/触控拖拽光学分界线、滚动联动线性显影、2.4× 消色差放大镜及实时亮度波形图（`p05 / p50 / p95`）。
2. **动态 AI 筛图墙与 FLIP 行程叙事（24 帧 → 8 帧）**：完整演示双感知哈希去重、结构张量运动模糊分离、地平线倾角检测、`#ffd54f` 1:1 人脸眼部放大画中画联系表（`photo_vlm_score`）与自然语言 MMR 行程叙事重组，体现 `FsGuard` 原片 0 字节删改承诺。
3. **交互式场景参考数字暗房（WebGL2 32-bit Float Pipeline）**：在浏览器 GPU 中实时运行线性曝光、白平衡高光中性保护、7 套真实 `chengying-style-recipes` 跨引擎预设、可拖拽 **Fritsch–Carlson 单调三次样条分通道曲线**、可直接在画布拖动的局部几何蒙版、高光/死黑斑马纹、五条审美一票否决红线告警、不可变修订链（`edit_apply` / `edit_revert`）及三格式实时原生旁车配方（`.chengying.json` / `darktable .xmp` / `RawTherapee .pp3`）。
4. **多 Agent 沙盒协同工作台**：交互式呈现 `EditOrchestrator` 的任务级权限收窄（`bash/fs` 剥夺）、场景锚点先行（`sceneAnchor` + `copy_from_task`）、红线触发自动回退修正，以及 `status: "unchanged"` 克制原片直出理念。
5. **纪实真实性与生成式授权边界**：三态实拍对比演示只读原片基线、无需授权的确定性周围像素修补（`ai:inpaint` 去电线），以及受私有 Symbol 与任务绑定原子收据锁死的生成式图层（`edit_generate` → `ai:gen_layer`）和 `XMP-iptcExt:DigitalSourceType = compositeWithTrainedAlgorithmicMedia` 溯源写入/撤销闭环。
6. **四阶引擎全量覆盖矩阵**：详实展示 `darktable`（93 模块 / 738 参数）、`RawTherapee`（54 工具 / 1,593 参数）、`builtin`（23 算子 / 95 参数）与 `ai`（4 算子 / 22 参数）的实测覆盖数据与自省原理，自托管可变字体（Cormorant / Plus Jakarta Sans / JetBrains Mono），零外部 CDN 依赖。

## 开发与验证（遵循本机构建区规范）

所有依赖安装、打包构建与 Playwright 浏览器验证均在 `$BUILD_SCRATCH_ROOT` 本机盘副本中执行，绝不在项目工作区生成 `node_modules/` 或 `dist/`（详见 [`docs/WORKSPACE.md`](docs/WORKSPACE.md) 与 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)）：

```bash
WT=~/项目/.wt/影视后期插件/<slug>
SCR=${BUILD_SCRATCH_ROOT:-$HOME/.build}/影视后期插件/<slug>/website
mkdir -p "$SCR"
rsync -a --delete --exclude node_modules --exclude dist --exclude test-results "$WT/website/" "$SCR/"
cd "$SCR"
pnpm install --frozen-lockfile --ignore-workspace
pnpm run build
pnpm run verify
```
