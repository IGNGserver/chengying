# 澄影官网 · Chengying Official Website

澄影（Chengying）产品官方网站，位于产品主仓库 `website/` 目录，以温和易懂的摄影画册叙事向普通摄影爱好者展示澄影（**DeepSeek Harness 插件**）的智能选片、交互式数字暗房调色、成组色调统一与诚实的 AI 边界确认，并将 `.xmp / .pp3 / .chengying.json` 配方与命令行安装详情以默认折叠方式收纳供进阶用户按需展开。

- 正式站点：<https://chengying.igng.net/>
- 产品仓库：<https://github.com/IGNGserver/chengying>
- 当前对应版本：`v0.8.0`

## 核心体验亮点

1. **沉浸式光影对比首屏（WebGL2 实时显影 & 2.4× 放大镜）**：全画幅作品占据视觉核心，支持鼠标/触控拖动对比分界、2.4× 细节放大镜及三幅旅行作品实时切换。
2. **动态智能选片墙（24 张 → 8 张故事精选）**：用日常摄影视角演示连拍自动归并、眨眼/手抖/跑焦/过曝/重片标记，支持点击放大组内眼睛特写对比及日常口语筛选，强调原片一张不删。
3. **交互式数字暗房**：在浏览器 GPU 中实时试调亮度、色温、高光/阴影、曲线与局部柔光蒙版，自带人像肤色柔和提醒与多版本回退，并将 `.chengying.json` / `darktable .xmp` / `RawTherapee .pp3` 专业配方文件收进默认折叠抽屉。
4. **成组统一修图与克制原则**：以老修图师笔记的形式直观呈现“代表作定调 → 同组延续色调 → 过曝自动退回局部提亮 → 本就耐看则保留原片直出”。
5. **修图与 AI 生成清晰边界**：通过夜航渡口三态实拍对比，清楚区分基于真实像素的去电线修补与需要本人点头确认的 AI 换天图层，并可随时一键撤回。
6. **格式支持与三步轻松上手**：列出手机常见格式（JPG / HEIC / ProRAW）及主流相机 RAW 支持与 5 份 built-in 摄影审美修养；首层展示“三步开启 + 日常提问示例”，将终端安装命令与 CLI 指令收进默认折叠区。

## 开发、验证与线上托管

所有本地依赖安装、打包构建与 Playwright 浏览器验证均在 `$BUILD_SCRATCH_ROOT` 本机盘副本中执行，绝不在项目工作区生成 `node_modules/` 或 `dist/`；线上由 `.github/workflows/website.yml` 自动部署至 Cloudflare Pages（详见 [`docs/WORKSPACE.md`](docs/WORKSPACE.md)、[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与 [`docs/HOSTING.md`](docs/HOSTING.md)）：

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
