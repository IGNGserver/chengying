# 引擎接口覆盖

澄影不维护"常用参数"白名单。每个引擎的全部操作和参数都从**本机安装的引擎本身**发现，转成 JSON Schema 交给 Agent（`edit_capabilities` / `edit_describe`），Agent 用 `edit_apply` 以 `{op, params, mask}` 通用地调用。引擎升级后目录按指纹（二进制路径 + 版本 + 修改时间）失效并重新发现，新增模块无需改代码。

## 发现方式

| 引擎 | 来源 | 得到的信息 |
|---|---|---|
| darktable | `native/dt-introspect.c`：在 fork 出的子进程里 dlopen `lib/darktable/plugins/*.so`，调用每个模块的 introspection API（v8） | 模块名/版本/分组/标志、参数结构体完整字段树（float/int/bool/enum/数组/嵌套结构/联合）、范围、默认值、枚举值与标签、默认混合色彩空间；全局混合参数版本与各管线顺序版本 |
| darktable 5.7+ | 可选 darktable-mcp | 同上（MCP `tools/list` + 编解码工具），并暴露原生工具给 `edit_native` |
| RawTherapee | `rawtherapee-cli -O` 导出完整处理配置；带 `Name_0` 的 Locallab sidecar 导出全部局部调整点键 | 全部节（工具）与键、默认值与类型；结合源码提炼的范围/枚举提示 |
| 内置 | 操作注册表 | 每个操作的完整 Schema |
| AI | 注册表 + 配置的模型/命令/提供者 | 内置操作与 `aiOperations` 中每个外部命令的 Schema |

## 验证方法（`chengying engines verify <engine>`）

对目录中的**每一个**操作：

1. 只把一个参数从默认值做最小改动（整数 ±1、浮点 ±2% 量程、布尔取反、枚举换值；迭代次数、半径这类会放大计算量的参数尽量不动）；单个参数改动不会产生效果的操作（例如色彩分级要先有饱和度）使用操作自带的示例参数（`edit_describe` 中的 `example`）；需要外部输入的操作（LUT 文件、蒙版、参考指纹、生成图层）使用生成的测试输入；
2. 通过适配器正常编码并用真实引擎渲染；
3. 校验引擎**确实收到并使用了**这些参数：
   - darktable：从输出文件内嵌的 XMP 读回 darktable 实际执行的历史，与我们写入的参数块逐字节比对；
   - RawTherapee：用 `dumpProfile` 读回 RawTherapee 实际使用的处理配置，逐键比对；
   - 内置 / AI：与空配方的基准渲染做像素比对，结果必须发生变化。

渲染失败或读回不一致都记为失败；批量渲染失败时逐个重试定位。

## 本机实测结果

测试机：macOS-dev2（x86_64），输入 Nikon NEF（`20170902_0047.NEF`）；内置/AI 使用合成测试图。原始报告见 `docs/coverage/*.json`。

| 引擎 | 版本 | 操作 | 参数 | 通过 | 失败 | 跳过 |
|---|---|---|---|---|---|---|
| darktable | 5.6.1 | 93 | 738 | 89 | 0 | 4 |
| RawTherapee | 5.13 | 54 | 1593 | 54 | 0 | 0 |
| 内置 | 0.2.0 | 23 | 95 | 23 | 0 | 0 |
| AI | 0.2.0 | 4 | 22 | 4 | 0 | 0 |

darktable 跳过项及原因：

| 模块 | 原因 | 实际支持范围 |
|---|---|---|
| `finalscale` | 导出管线自行插入的内部模块，darktable 会丢弃历史中提供的该模块 | 输出尺寸由渲染/导出的 `maxEdge` 控制；`validateStep` 会明确拒绝并说明 |
| `clahe` | 已弃用的旧局部对比度模块，没有 introspection | 只能以原始参数块（`params.blob`，来自旧 XMP/样式）透传；新编辑请用 `bilat`（局部对比度） |
| `overexposed`、`rawoverexposed` | 界面上的过曝指示模块，没有 introspection，不参与导出 | 不适用于导出 |

## 未覆盖与扩展

- 上表之外，darktable 在本机共有的模块都已覆盖。由于 introspection 是逐模块动态读取，第三方或新版本模块只要提供 introspection 即自动可用；不提供的按 `blob` 透传。
- darktable 的绘制蒙版支持圆、椭圆、矩形、多边形（路径）、渐变、笔刷，参数化蒙版支持全部通道；安装的混合参数版本与已映射的 v14 不一致时，目录会关闭蒙版并在目录 `notes` 中说明。
- darktable-mcp 路径（5.7+）已实现但未在本机实测（本机为 5.6.1）。
- RawTherapee 的整数键不接受小数，适配器按默认值的整数性自动取整重试。
- 生成式提供者中 `command` 已在测试中端到端验证；`openai-images` 与 `comfyui` 按其公开 API 实现，未接入真实服务测试。
