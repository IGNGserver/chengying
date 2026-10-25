# 澄影 Chengying

DeepSeek Harness 插件项目。

## 当前状态

仓库已完成基础初始化，并建立了基于 SemVer、标签和 GitHub Actions 的 Release 流程。当前版本记录在根目录 `VERSION`，初始值为 `0.1.0`。

## 开发

本仓库遵循项目级 `AGENTS.md` 与设备级 Agent 规范。开发任务应从远端 `main` 创建独立 worktree：

```bash
wt new 影视后期插件 <任务名>
```

## 发布

常规版本号使用不带 `v` 的 `major.minor.patch`，兼容计然的历史迁移可使用 `-rev.N` 后缀；发布标签使用 `v<version>`。每个版本的更新说明放在 `.github/release-notes/<version>.md`。

推送版本标签后，GitHub Actions 默认创建 prerelease：

```bash
git tag -a v0.1.0 -m "chore: release v0.1.0"
git push origin v0.1.0
```

只有明确需要正式版时，才在 GitHub Actions 的 `Release` 工作流中手动选择 `release`。当前 Release 附带源码插件包；宿主专用打包格式确定后会在同一工作流中加入。
