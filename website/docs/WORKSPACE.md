# 工作区与本机构建区约定

澄影官网源码位于主仓库 `website/` 目录，与插件本体共享同一 Git 仓库但独立管理前端构建，不修改插件本体代码。Git 分支、worktree 生命周期与构建去处严格遵循仓库根目录 `AGENTS.md` 与 `~/.qoder/coder-rules/global-rules.md` 第 5c、8 节。

## 目录与构建流向

```text
~/项目/影视后期插件/                           # _anchor 空树锚点（只读，不进编辑态）
~/项目/.wt/影视后期插件/<slug>/website/         # 任务 worktree 内的官网源码
~/.build/影视后期插件/<slug>/website/           # 本机盘构建与验证副本（含 node_modules、dist、验证截图）
```

## 标准本地构建与端到端验证

1. 检查本机构建盘剩余空间（须 ≥ 20G）：
   ```bash
   df -h "${BUILD_SCRATCH_ROOT:-$HOME/.build}"
   ```
2. 单向同步 `website/` 到本机 scratch 并执行类型检查、构建与 Playwright 全链路验证：
   ```bash
   WT=~/项目/.wt/影视后期插件/<slug>/website
   SCR=${BUILD_SCRATCH_ROOT:-$HOME/.build}/影视后期插件/<slug>/website
   mkdir -p "$SCR"
   rsync -a --delete --exclude node_modules --exclude dist --exclude test-results "$WT/" "$SCR/"
   cd "$SCR"
   pnpm install --frozen-lockfile --ignore-workspace
   pnpm run build
   pnpm run verify
   ```
3. 如更新了依赖版本，仅将 `package.json` 与 `pnpm-lock.yaml` 拷回 worktree，禁止将 `node_modules/`、`dist/` 或测试截图拷回项目目录。
