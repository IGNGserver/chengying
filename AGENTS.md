# 澄影（Chengying）· 项目 Agent 规范

> 只写本仓库与设备级规范的差异。Git 纪律、worktree 路径与生命周期、基线解析、冲突处理、PR 流程及构建去处一律见 `~/.qoder/coder-rules/global-rules.md`；冲突时以设备级安全条款为准。

Collaboration: solo
Baseline: main
Release: tag + Actions（`.github/workflows/release.yml`）；标签为 `v<SemVer>`，普通发布默认 prerelease，正式版必须显式选择 `release`
Validation: `git diff --check`；`python3 scripts/verify-release-version.py --version "$(tr -d '[:space:]' < VERSION)"`；`python3 scripts/render-release-body.py --version "$(tr -d '[:space:]' < VERSION)" --release-type prerelease --repository IGNGserver/chengying --check`
Worktree: `~/项目/.wt/影视后期插件/<slug>`

## 项目定位

澄影（Chengying）是 **DeepSeek Harness 的插件**。仓库承载插件源码、开发脚本、测试、文档和可分发的插件包；宿主 API、目标平台与正式安装格式以实际实现和文档为准，不得凭猜测扩展兼容承诺。

- GitHub 仓库：`https://github.com/IGNGserver/chengying`
- 中文名称：澄影
- 英文标识：`chengying`
- 项目目录：`影视后期插件`

## 版本与发布

版本策略参考计然（Jiran），并针对本插件保持最小可用实现：

- 根目录 `VERSION` 是当前版本的唯一版本源，使用不带 `v` 的标准 SemVer `major.minor.patch`；兼容计然的历史/过渡版本可使用 `-rev.N` 后缀，但新版本优先使用无后缀形式；当前初始化版本为 `0.1.0`。
- 发布标签统一为 `v<version>`，例如 `v0.1.0`。新版本必须严格高于最近的版本标签，不能复用已发布版本号。
- 正常的“发布 release”默认是 GitHub prerelease。标签推送和手动工作流的默认行为都不会创建正式版。
- 只有明确要求正式版时，才在 GitHub Actions 的 `workflow_dispatch` 中将 `release_type` 选择为 `release`；正式版不会自动随 PR 合并产生。
- 每个版本的手写更新说明放在 `.github/release-notes/<version>.md`，文件名不带 `v`；没有对应说明时，Release 工作流必须失败。
- `.github/RELEASE_TEMPLATE.md` 只负责结构；Release 正文由工作流使用当前版本说明生成，不能把历次版本说明累积到模板中。
- 当前工作流发布可复现的源码插件包（zip 与 tar.gz）。DeepSeek Harness 的宿主专用打包格式确定后，必须在 `scripts/package-plugin.sh`、Release 说明和验证命令中同步登记。

## 发布操作

1. 在独立 worktree 中递增 `VERSION`，新增对应的 `.github/release-notes/<version>.md`，并通过 PR 合并。
2. 基于已合并的 `main` 创建并推送 `v<version>` 标签；标签工作流默认创建 prerelease。
3. 若要把同一版本标为正式版，在 GitHub Actions 的 `Release` 工作流中手动输入不带 `v` 的版本号，并显式选择 `release`。
4. 发布构建只在 GitHub Actions 中执行；本地不在项目卷生成 `dist/` 或 Release 包。正式版与 prerelease 都必须验证标签、`VERSION`、更新说明和源码包内容。

## 开发约定

- 插件源码、开发脚本、测试与文档分层组织；新增目录时保持命名清晰，并在 README 中补充用途。
- 依赖版本、DeepSeek Harness API 约束、目标平台和安装方式一旦确定，必须在本文件或对应文档中登记，并同步更新 Validation 与 Release 工作流。
- 影视素材、缓存、导出包、本地宿主安装目录和凭据不属于源码，禁止提交到仓库。

## 质量与安全

- 提交前至少运行 `git diff --check`、版本校验和 Release 正文检查；建立具体技术栈后，将 lint、类型检查、单元测试和打包检查补充到 `Validation:`。
- 不提交 `.env`、密钥、token、私钥、宿主授权信息或任何未脱敏的日志。
- 构建依赖与产物遵循设备级规范第 5c、8 节，放在本机 `$BUILD_SCRATCH_ROOT` 或 CI，不落在项目卷。
- Release 不代表部署；当前没有自动部署目标，发布后是否安装到 DeepSeek Harness 由单独的用户指令决定。
