# 澄影（Chengying）· 项目 Agent 规范

> 只写本仓库与设备级规范的差异。Git 纪律、worktree 路径与生命周期、基线解析、冲突处理、PR 流程及构建去处一律见 `~/.qoder/coder-rules/global-rules.md`；冲突时以设备级安全条款为准。

Collaboration: solo
Baseline: main
Release: none
Validation: `git diff --check`
Worktree: `~/项目/.wt/影视后期插件/<slug>`

## 项目定位

澄影（Chengying）是影视后期插件项目。本仓库当前处于初始化阶段，后续承载插件源码、开发工具与项目文档。

- GitHub 仓库：`https://github.com/IGNGserver/chengying`
- 中文名称：澄影
- 英文标识：`chengying`
- 项目目录：`影视后期插件`

## 开发约定

- 在明确插件宿主、目标版本、平台与打包格式前，不得凭猜测引入技术栈或提交宿主专属实现；相关事实先记录在项目文档中。
- 插件源码、开发脚本、测试与文档分层组织；新增目录时保持命名清晰，并在 README 中补充用途。
- 依赖版本、宿主 API 约束和发布流程一旦确定，必须在本文件或对应文档中登记，并同步更新 Validation 命令。
- 影视素材、缓存、导出包和本地宿主安装目录不属于源码，禁止提交到仓库。

## 质量与安全

- 提交前至少运行 `git diff --check`；建立具体技术栈后，将 lint、类型检查、单元测试和打包检查补充到 `Validation:`。
- 不提交 `.env`、密钥、token、私钥、宿主授权信息或任何未脱敏的日志。
- 构建依赖与产物遵循设备级规范第 5c、8 节，放在本机 `$BUILD_SCRATCH_ROOT` 或 CI，不落在项目卷。
- 发布不随合并自动发生；当前没有版本化 Release 或部署目标，需另行明确后再补充流程。
