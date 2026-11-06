# 排障

本文只收“装好了但用不了”这一类问题。摄影工具/引擎自身的行为看 [`engine-coverage.md`](engine-coverage.md) 与 README 的引擎一节。

## 预设

澄影的工具与提示词由 Agent 预设 `chengying` 挂载。预设出问题分三种，现象和查法都不同，按顺序走。

### 1. 预设选单里**根本没有**「澄影 · 摄影后期」

说明整个 bundle 没被加载，不是预设的问题。DSH 在启动时对每个 bundle 做版本门禁（`dsh.bundle` 的 `engines.dsh`），不满足就**整包跳过**，只在 stderr 打一行：

```
dsh: skipping profile bundle "chengying": Plugin chengying@<ver> is incompatible with dsh <ver>: ...
```

桌面版从图标启动时看不到 stderr，所以表现为“装完就没有”。查法：

```bash
dsh --version                       # 宿主版本，需落在 >=0.2.1-0 <0.3.0
dsh --profile <profile> --dump-config 2> err.txt | grep preset-chengying
cat err.txt
```

- 版本不在区间内 → 升级/回退宿主，或 `dsh plugin allow-version` 给**确切版本**开豁免（有风险，仅在确认兼容后使用）。
- 版本没问题但 `err.txt` 里有 `skipping` → 看它后面那句原因（依赖解析、manifest 读取等）。

> 桌面版自带运行时，和 PATH 里的 `dsh` 可能不是同一个版本。用 `dsh --version` 查的是 CLI；桌面版内置的那份要用 App 自己的入口查（`…\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --version`，Windows 上以 `ELECTRON_RUN_AS_NODE=1` 运行）。

### 2. 预设**在选单里**，但新建对话时报“预设加载失败”

`mountPreset()` 把预设当成一棵 Loader 子树挂载，`auditRows()` 收集每一行的导入/激活失败，**任意一行失败就让整个预设挂载失败**。所以报错通常指向某一行：

```
tool-subagent-list-agents (@deepseek-ai/dsh-tool-subagent-control/list-agents): Cannot find module …
```

这类问题的根源是**预设抄了宿主某一版本的工具行形状**，宿主改形状就断。已知案例：DSH `0.2.2-rc.1` 把 `list-agents` 并进 `@deepseek-ai/dsh-tool-subagent-control` 主入口并删掉 `./list-agents` 子路径导出，而 `0.2.1.x` 仍需单独一行。

对策：预设里**凡是写包子路径的行都必须带 `disabled: !!js` 守卫**，运行时解析不到就跳过该行，而不是让整个预设炸掉。`tests/preset-shape.test.ts` 守着这条规则，新增子路径行会被测试拦下。

### 3. 预设能进，但模型没有摄影工具

- 确认选的就是澄影预设（普通会话不挂摄影工具，这是设计）。
- 看启动日志里有没有 `dsh: disabling profile plugin row "chengying-agent": …`：这是兼容性预检把行禁掉了，原因通常是插件声明的 `engines.dsh` / peer 范围与运行时不符。
- 又用了 `--patch` 又装了 bundle 时，`mode: auto` 的判定可能落到 `host`（只挂面板不挂工具）；需要一次性全挂就显式 `mode: both`。

## 取证

| 场景 | 位置 |
| --- | --- |
| CLI / TUI | 启动时的 stderr |
| Web（`dsh web`） | 启动它的终端 |
| 桌面版（Windows） | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` |
| profile 安装内容 | `$DSH_HOME/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 与 `node_modules/<包>` |
| 插件自身日志 | 启动后 `chengying <ver> host ready` / `agent ready with N tools` |

只要贴得出 `skipping profile bundle` / `disabling profile plugin` / `mountPreset` 那三类报错中的任意一条，定位就基本完成了。
