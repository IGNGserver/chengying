/**
 * Runtime skills contributed by Chengying's host row.
 *
 * `ctx.skills.register()` keeps the bodies independent of where the package is
 * installed: no custom-skill path resolution in the preset YAML, and the same
 * skills exist in headless compositions. The preset mounts `tool-skill` (plus
 * `skill-filesystem` for the user's own project skills), so the model can load
 * these on demand instead of carrying the recipes in every system prompt.
 */

export interface ChengyingSkill {
  name: string
  description: string
  whenToUse: string
  content: string
}

const AESTHETIC_GRADING = `# 澄影摄影审美分诊与五步精调总纲

用于指导修图计划制定、单张精修、影调分诊与审美质量把控。

## 一、核心审美哲学：克制与自然（Restraint & Naturalism）

自动修图最常见的失败是**过度处理（Over-processing）**：一次堆砌 6–8 个大幅度滑块，把阴影拉到发灰噪点爆炸、把饱和度拉到肤色发橘、把清晰度拉出黑边光晕。
**最高准则**：用 2–3 个精准、克制的核心调整撑起画面，远胜于 6 个各自都有理由的平庸滑块叠加。原片已经曝光均衡、氛围自然时，最优操作是 \`edit_finish(status="unchanged")\`。

---

## 二、动手前必做：光线诊断与影调分诊（Tonal & Light Triage）

**光线条件比拍摄题材更能决定修图方案**（逆光人像与顺光人像的修法截然相反）。动手前先结合图像视觉与 \`stats\`（\`percentiles.p05 / p50 / p95\`、\`localContrast\`、\`clipHigh / clipLow\`、\`colorCast\`、\`faceStats\`）做定量分诊：

### 1. 曝光基准（先看 \`p50\` 与 \`p95\`，曝光不对后面全白干）
| 实测指标 | 视觉与数据特征 | 病根诊断 | 正确的第一刀 |
|---|---|---|---|
| \`p50 < 95\` 且 \`p95 < 190\` | 整体昏暗、高光也没顶上去 | **整体欠曝** | 提 \`exposure\` (+0.25~+0.8 EV) + 适度 \`whites\`，**受噪点余量约束** |
| \`p50 > 175\` 或 \`clipHigh > 2%\` | 画面发白、高光溢出 | **整体过曝** | **必须先压 \`exposure\` (-0.25~-0.7 EV) 与 \`highlights\` (-30~-70)**；绝不能在发白的底子上直接刷冷调或曲线，否则只会变成浑浊的灰白 |
| \`p50\` 正常 (110~155) 但 \`localContrast < 8\` | 看起来“灰、平、闷”，但并不暗 | **反差不足（Flat）** | 用 S 型 \`curve\` 或微加 \`contrast\` (+8~+18)，不要乱提 \`exposure\` |
| \`p05 > 45\` 且 \`clipLow == 0\` | 头发/暗部发灰、画面像蒙了层雾、人浮在背景上 | **黑场塌陷（Washed-out Blacks）** | 压 \`blacks\` (-8~-20) 或把曲线暗部端点微收；逆光眩光照片可保留适度空气感 |
| \`clipLow > 3.5%\` 且 \`p05 < 8\` | 暗部死黑成团、细节全丢 | **黑场压死（Crushed Blacks）** | 提 \`shadows\` (+15~+35) 或微提曲线黑点 (0→0.02) |

### 2. 噪点预算硬上限（Noise Headroom Ceiling — 一票否决项）
任何暗部/曝光提亮都受任务上下文中的 \`shadowEv\` / \`headroomEv\`（及 ISO）硬性约束：
| 暗部可恢复余量 (\`shadowEv\`) | 允许最大 \`exposure\` 提亮 | 允许最大 \`shadows\` 提亮 | 必须同步做的事 |
|---|---|---|---|
| \`>= 2.0 EV\` (低 ISO RAW) | \`+0.8 EV\` | \`+40\` | 正常推进 |
| \`1.0 ~ 2.0 EV\` | \`+0.45 EV\` | \`+25\` | 观察暗部纯净度 |
| \`0.5 ~ 1.0 EV\` | \`+0.25 EV\` | \`+15\` | 必须同步开启 \`denoise\` (luminance 20~35, chroma 30) |
| \`< 0.5 EV\` (高 ISO / 8-bit JPG 夜景) | **禁止正值 \`exposure\`** | **最多 \`+10\`** | **严禁强拉暗部把夜景修成白昼**；宁可压 \`blacks\` (-5~-12) 保持干净纯粹的夜色 |

---

## 三、风格塑造工具威力排序（Tool Hierarchy）

1. **分通道色调曲线（RGB Curves）← 最细腻、最优先的风格化主力**
   - 相比生硬地拉色温（会毁掉全局肤色和白点），用红/绿/蓝三通道曲线可以在**保持中灰与肤色端正**的前提下实现高级冷暖分离：
   - **暗部偏青蓝 + 高光偏暖金**：
     - \`blue\` 通道：暗部微抬 \`[0.25, 0.28]\` + 高光微压 \`[0.75, 0.72]\`
     - \`red\` 通道：暗部微压 \`[0.25, 0.23]\` + 高光微抬 \`[0.75, 0.78]\`
   - **胶片柔和滚降（Soft Highlight Roll-off & Matte Toe）**：
     - \`points\` (Luma/Master)：\`[[0, 0.02], [0.22, 0.19], [0.5, 0.51], [0.78, 0.82], [1, 0.97]]\`（暗部微雾化不死黑，高光柔化不刺眼）。
2. **HSL 八色混色器 ← 零蒙版风险的局部手术刀**
   - **保肤色（Red / Orange）**：人像肤色主要由 \`orange\`（及少量 \`red\`）控制。肤色暗沉发黄时：\`orange: { luminance: +6..+14, saturation: -4..-12, hue: -2..+2 }\`（提亮橙色明度、微降饱和度 = 白皙通透肤色）。
   - **压杂色（Yellow / Green）**：户外树叶/草地容易呈现廉价的荧光黄绿。将 \`yellow\` 与 \`green\` 的 \`saturation\` 降低 \`-15..-45\`，\`green.hue\` 向青色偏移 \`+10..+25\`，画面立刻干净高级。
   - **塑天空（Aqua / Blue）**：晴天蓝天发飘时：\`blue: { luminance: -8..-20, saturation: +8..+20, hue: -5..-12 }\`。
3. **基础影调滑块（Exposure / Tone）← 负责打底，不负责风格**
   - 先把动态范围收进舒适区间（\`highlights: -15..-50\`, \`shadows: +10..+30\`），对比度优先交给曲线。
4. **白平衡（White Balance）← 只做校正与微调，慎做大跨度风格化**
   - 除非原片有明显光源偏色（\`castA/castB\` 异常），否则 \`temperature\` 调整控制在 \`±15\`（内置引擎）或 \`±400K\` 以内，防止人脸变成“黄疸”或“僵尸青”。

---

## 四、五步闭环精调法（The 5-Pass Closed Loop）

每次任务最多分 2–3 轮 \`edit_apply\` 渐进完成，每轮看返回的 **Original | Edited 对比图** 与 **statsDelta**：

- **Pass 1 · 基础曝光与影调打底（Foundation）**：
  校正明显的白平衡偏色 + 把 \`p50\` 和高光/暗部拉回健康区间（\`exposure\` + \`tone\`）。如果原片有高置信度水平线倾斜（\`tiltConfidence > 0.45\` 且 \`|tiltDeg| >= 0.8°\`），在此步一并校正 \`rotate\`。
- **Pass 2 · 曲线反差与色彩风格（Look & Color）**：
  使用分通道 \`curve\` + \`hsl\` + \`color_grading\`（或 \`saturation.vibrance\`）建立与场景匹配的胶片/电影/清新氛围。
- **Pass 3 · 局部蒙版雕琢与细节收尾（Local Sculpting & Detail）**：
  - 若有人像且检测到 \`faceBox: [x, y, w, h]\` 且人脸偏暗（\`faceStats.luma < 115\`）：用椭圆蒙版 \`{ type: "ellipse", cx: x+w/2, cy: y+h/2, rx: w*0.65, ry: h*0.65, feather: 0.12 }\` 局部微提 \`exposure: +0.12..+0.25\`；
  - 若天地光比过大（\`topHalfLuma - bottomHalfLuma > 45\`）：用顶部线性渐变 \`{ type: "gradient", x0: 0.5, y0: 0.05, x1: 0.5, y1: 0.45 }\` 局部压暗天空 \`exposure: -0.25..-0.45\`；
  - 若高 ISO 噪点明显：加 \`denoise\`，最后按需轻度 \`sharpen\`。

---

## 五、一票否决红线（Below-the-Line Rubric — 触犯任意一条必须 \`edit_revert\`）

1. **人像毁容红线**：含有人像（\`people\` 标签或 \`faceRegions >= 1\`）的照片，**严禁设置全局 \`clarity > 0\`**（会把毛孔和法令纹锐化成脏斑），**严禁全局 \`saturation > +8\`**，**严禁让 \`faceStats.luma\` 掉到 90 以下或冲到 225 以上**。
2. **去雾滥用红线**：任何照片 **\`dehaze\` 严禁超过 \`+15\`**；阴天、室内、人像特写 **严禁使用正值 \`dehaze\`**（会导致天空死白翻倍、暗部结块发黑）。
3. **伪电影感红线**：**严禁把“电影感/高级感”当成“无脑压暗 \`exposure\`”**。真正的电影感来自高光柔和滚降、色相收敛（压杂色饱和度）和冷暖分离，而不是把整张图修得乌漆嘛黑。
4. **盲目裁切/旋转红线**：除非画面边缘有明显穿帮杂物，或 \`tiltConfidence > 0.45\` 证实地平线倾斜，否则**严禁随意 \`crop\` 或 \`rotate\`** 破坏摄影师原本的完整构图。
5. **过曝/死黑恶化红线**：除非原片本身是不可逆的太阳/灯芯死白，否则修图后 \`clipHigh\` 不得超过 \`0.8%\`（且不得比原片恶化超过 \`+0.5%\`），\`clipLow\` 不得超过 \`2.0%\`。
`;

const STYLE_RECIPES = `# 澄影场景化风格配方库（Builtin / Darktable / RawTherapee）

在确定照片场景与光线条件后加载本技能。以下配方均为**经过实测的温和起点（Conservative Starting Points）**，请根据具体照片的实测 \`p05 / p50 / p95\` 与 \`headroomEv\` 按比例微调，切勿机械照搬。

---

## 配方 1 · 自然通透纪实（Neutral Clean Documentary）
- **适用场景**：光线正常的旅行纪实、建筑、合照、日常抓拍。
- **禁忌场景**：需要强烈情绪化风格或原本已高反差的正午硬光。
- **Builtin 参数**：
  - \`tone\`: \`{ highlights: -22, shadows: 16, whites: 6, blacks: -6, contrast: 6 }\`
  - \`saturation\`: \`{ vibrance: 8, saturation: -2 }\`
  - \`hsl\`: \`{ yellow: { saturation: -8, hue: -4 }, green: { saturation: -12, hue: 8 }, orange: { luminance: 4 } }\`
- **Darktable 参数**：
  - \`exposure\`: \`{ exposure: 0.1 }\`
  - \`colorbalancergb\`: \`{ vibrance: 0.08, contrast: 0.05, chroma_global: 0.04, brilliance_shadows: 0.08, brilliance_highlights: -0.06 }\`
- **RawTherapee 参数**：
  - \`Exposure\`: \`{ Compensation: 0.1, HighlightCompr: 25, ShadowCompr: 20, Contrast: 6 }\`
  - \`Vibrance\`: \`{ Enabled: true, Pastels: 10, Saturated: 4 }\`

---

## 配方 2 · 日系清新胶片（Airy Film / 滨田英明 · 富士 Pro400H 风）
- **适用场景**：户外自然光人像、晴天/多云街景、校园、草地、海边。
- **禁忌场景**：严重欠曝的夜景、需要深沉暗调的严肃题材（在暗光下强拉暗部会显得脏闷）。
- **核心秘诀**：低反差、高光柔和下压、阴影敞开、黄绿减淡偏青、天空清透偏青蓝、肤色清亮。
- **Builtin 参数**：
  - \`white_balance\`: \`{ temperature: 4, tint: -2 }\`
  - \`tone\`: \`{ contrast: -12, highlights: -38, shadows: 28, whites: 4, blacks: 8 }\`
  - \`curve\`: \`{ points: [[0, 0.025], [0.25, 0.26], [0.75, 0.78], [1, 0.97]], blue: [[0, 0.03], [0.3, 0.32], [0.75, 0.76], [1, 0.96]] }\`
  - \`hsl\`: \`{ orange: { saturation: -8, luminance: 10 }, yellow: { saturation: -28, luminance: 8, hue: -6 }, green: { saturation: -30, luminance: 10, hue: 18 }, aqua: { saturation: 12 }, blue: { hue: -10, saturation: 12, luminance: 6 } }\`
  - \`clarity\`: \`{ amount: -8 }\`（柔化光线边缘）
- **Darktable 参数**：
  - \`exposure\`: \`{ exposure: 0.25, black: -0.008 }\`
  - \`colorbalancergb\`: \`{ contrast: -0.08, vibrance: 0.06, brilliance_shadows: 0.18, brilliance_highlights: -0.12, chroma_shadows: -0.05 }\`
  - \`rgbcurve\`: \`{ curves: { master: [[0, 0.02], [0.28, 0.30], [0.75, 0.78], [1, 0.97]], b: [[0, 0.02], [0.3, 0.32], [1, 0.96]] } }\`

---

## 配方 3 · 温润自然人像（Warm Natural Portrait）
- **适用场景**：单人/双人肖像、黄金时刻人像、室内窗光人像、人文特写。
- **禁忌场景**：纯风景无人物照片。
- **核心秘诀**：保护肤色质感（绝不加正 clarity/texture），橙色通道微提亮降饱和，背景绿植压暗降饱和以突出主体，对人脸（\`faceBox\`）做柔光提亮。
- **Builtin 参数**：
  - \`tone\`: \`{ contrast: 4, highlights: -26, shadows: 18, whites: 5, blacks: -8 }\`
  - \`saturation\`: \`{ vibrance: 8, saturation: -3 }\`
  - \`hsl\`: \`{ red: { saturation: -4, luminance: 4 }, orange: { hue: -2, saturation: -6, luminance: 8 }, yellow: { hue: -8, saturation: -16 }, green: { hue: 12, saturation: -22, luminance: -6 } }\`
  - **局部蒙版（当存在 \`faceBox: [x, y, w, h]\` 且面部偏暗时）**：
    添加 \`exposure\` step：\`params: { ev: 0.18 }, mask: { shapes: [{ type: "ellipse", cx: x + w/2, cy: y + h/2, rx: w * 0.65, ry: h * 0.65, feather: 0.12 }] }\`
- **Darktable 参数**：
  - \`sigmoid\`: \`{ middle_grey_contrast: 1.35, contrast_skewness: 0 }\`（若阶段未开 filmic；人像 skew 保持 0 防止肤色断层）
  - \`colorbalancergb\`: \`{ vibrance: 0.06, chroma_global: -0.02, brilliance_shadows: 0.10, brilliance_highlights: -0.08 }\`

---

## 配方 4 · 冷青电影都市感（Urban Teal & Slate）
- **适用场景**：阴天/多云城市街拍、现代建筑、玻璃幕墙、雨天街道、工业风。
- **禁忌场景**：需要温暖红润肤色的近景人像、温馨室内聚会。
- **核心秘诀**：不靠拉低色温，而是靠 **蓝/红分通道曲线** 做暗部冷青、高光干净的分离，压低黄/绿/洋红杂色。
- **Builtin 参数**：
  - \`tone\`: \`{ contrast: 10, highlights: -35, shadows: 12, whites: 4, blacks: -12 }\`
  - \`curve\`: \`{ points: [[0, 0.01], [0.22, 0.19], [0.5, 0.5], [0.8, 0.82], [1, 0.98]], blue: [[0, 0.02], [0.25, 0.28], [0.75, 0.74], [1, 0.98]], red: [[0, 0], [0.25, 0.22], [0.75, 0.77], [1, 1]] }\`
  - \`hsl\`: \`{ yellow: { saturation: -35 }, green: { saturation: -40, hue: 20 }, aqua: { hue: 10, saturation: 12 }, blue: { hue: -8, saturation: 15, luminance: -8 }, magenta: { saturation: -25 } }\`
  - \`saturation\`: \`{ saturation: -5, vibrance: 8 }\`
  - \`vignette\`: \`{ amount: -15, midpoint: 50, feather: 60 }\`

---

## 配方 5 · 黄金时刻 / 落日青橙电影感（Golden Hour & Teal-Orange）
- **适用场景**：日出、日落、晚霞、黄昏街景、逆光剪影与暖光夜景。
- **禁忌场景**：正午惨白强光或纯阴天无暖光源的场景。
- **核心秘诀**：强化高光与中灰的暖金感，暗部注入克制的青蓝互补色，保留晚霞高光细节（严防死白）。
- **Builtin 参数**：
  - \`white_balance\`: \`{ temperature: 8, tint: 2 }\`
  - \`tone\`: \`{ highlights: -42, shadows: 20, whites: 6, blacks: -10, contrast: 8 }\`
  - \`curve\`: \`{ blue: [[0, 0.02], [0.25, 0.28], [0.75, 0.71], [1, 0.95]], red: [[0, 0], [0.25, 0.22], [0.75, 0.79], [1, 1]] }\`
  - \`color_grading\`: \`{ shadows: { hue: 210, saturation: 14 }, highlights: { hue: 38, saturation: 16 }, balance: 15 }\`
  - \`hsl\`: \`{ orange: { saturation: 12, luminance: 6 }, yellow: { hue: -10, saturation: 10 }, aqua: { saturation: 10 }, blue: { saturation: 12, luminance: -6 } }\`

---

## 配方 6 · 壮丽自然风光（Dynamic Landscape）
- **适用场景**：山脉、湖泊、海岸、森林、开阔天地风光。
- **核心秘诀**：分离天地光比（顶部渐变蒙版压天空高光），适度提升局部微反差与自然饱和度（Vibrance），去雾严格控制在 \`+6..+14\` 以内。
- **Builtin 参数**：
  - \`tone\`: \`{ contrast: 12, highlights: -35, shadows: 24, whites: 10, blacks: -12 }\`
  - \`dehaze\`: \`{ amount: 10 }\`
  - \`clarity\`: \`{ amount: 12, radius: 32 }\`
  - \`saturation\`: \`{ vibrance: 16, saturation: 2 }\`
  - \`hsl\`: \`{ green: { hue: 6, saturation: -6, luminance: 4 }, blue: { hue: -4, saturation: 10, luminance: -10 } }\`
  - **局部蒙版（天空亮于地面时）**：
    添加 \`tone\` step：\`params: { highlights: -25, contrast: 8 }, mask: { shapes: [{ type: "gradient", x0: 0.5, y0: 0.05, x1: 0.5, y1: 0.45 }] }\`

---

## 配方 7 · 纯净高感夜景（Clean Night & City Lights）
- **适用场景**：城市夜景、室内暗光、夜市、车轨、蓝调时刻。
- **禁忌场景**：白天场景。
- **核心秘诀**：**夜景绝对不要当白天修**！保护高光灯牌不过曝（压 \`highlights\`），把 \`blacks\` 微压（-5~-10）保住夜空的深邃纯净感，阴影提亮绝不超过 \`shadowEv\` 预算，并第一时间开启降噪。
- **Builtin 参数**：
  - \`tone\`: \`{ highlights: -45, shadows: 12, whites: 4, blacks: -8, contrast: 8 }\`
  - \`denoise\`: \`{ luminance: 28, chroma: 38, detail: 55 }\`
  - \`hsl\`: \`{ magenta: { saturation: -18 }, purple: { saturation: -15 }, orange: { luminance: 6 }, blue: { saturation: 10 } }\`

---

## 配方 8 · 温暖诱人美食与静物（Appetizing Food & Still Life）
- **适用场景**：餐厅美食、咖啡甜点、暖光静物、手作特写。
- **核心秘诀**：消除室内冷绿荧光灯偏色（微加暖温与洋红 tint），提亮主食与桌面高光，增强红/橙/黄暖色鲜度，压低背景冷杂色，配合轻微中心聚光。
- **Builtin 参数**：
  - \`white_balance\`: \`{ temperature: 8, tint: 3 }\`
  - \`tone\`: \`{ contrast: 8, highlights: -20, shadows: 22, whites: 12, blacks: -8 }\`
  - \`hsl\`: \`{ red: { saturation: 10, luminance: 4 }, orange: { saturation: 14, luminance: 8 }, yellow: { saturation: 12, luminance: 6 }, blue: { saturation: -20 }, aqua: { saturation: -20 } }\`
  - \`clarity\`: \`{ amount: 8, radius: 20 }\`
  - \`vignette\`: \`{ amount: -12, midpoint: 55, feather: 65 }\`
`;

const ENGINE_MASTERY = `# 澄影引擎高阶色彩科学指南（Darktable / RawTherapee / Builtin）

用于调用 \`darktable\`、\`rawtherapee\` 或 \`builtin\` 引擎进行专业级精修时的模块选型与参数避坑。

## 一、Darktable 现代场景参考管线（Scene-Referred Workflow）

澄影默认启用 \`workflow: "darktable-default"\`（即线性無界 Scene-Referred 管线，底层已自动挂载默认 \`exposure\`、\`color calibration\` 与显示映射器）。

### 1. 四大核心铁律
1. **严禁叠加两个显示映射器（Display Transform）**：默认管线已包含显示映射器。除非你显式设 \`workflow: "none"\`，否则不要盲目新开冲突的 \`basecurve\`；若调整 \`sigmoid\`，在人像上务必保持 \`contrast_skewness: 0\` 以防肤色断层。
2. **弃用旧显示参考模块（Deprecated Display-Referred Modules）**：
   - ❌ **不要用** \`tonecurve\`、\`levels\`、\`basecurve\`、\`shadhi\`（Shadows and Highlights，易产生明暗交界伪影光晕）、\`velvia\`。
   - ✅ **替代方案**：
     - 调中灰亮度 → \`exposure\`（\`exposure: -1.5..1.5\` EV）
     - 调高光与暗部动态范围（无光晕 Dodge & Burn）→ \`toneequal\`（Tone Equalizer）或 \`colorbalancergb\` 的 \`brilliance_shadows / brilliance_midtones / brilliance_highlights\`
     - 调色彩、自然饱和度与四路分级 → \`colorbalancergb\`
     - 调特定颜色的色相/饱和度/明度（HSL）→ \`colorzones\`（使用 \`curves\` 语法糖）
     - 分通道曲线微调 → \`rgbcurve\`（仅用于温和 S 曲线或 R/B 通道微调）
3. **局部调整自动多实例**：
   在澄影中，给任何支持蒙版的 darktable 步骤传入 \`mask\` 时，适配器会自动为它分配独立的 \`instance\`（multi_priority >= 1）并插入自定义管线顺序，不会覆盖基础全局实例。
4. **\`colorbalancergb\` 安全参数范围（最核心调色模块）**：
   - \`vibrance\`: \`-0.2 .. +0.25\`（常用 \`+0.05 .. +0.15\`）
   - \`contrast\`: \`-0.15 .. +0.20\`（常用 \`-0.05 .. +0.10\`）
   - \`chroma_global\`: \`-0.15 .. +0.20\`（常用 \`+0.02 .. +0.10\`）
   - \`brilliance_shadows\`: \`-0.25 .. +0.35\`（提亮暗部常用 \`+0.08 .. +0.22\`）
   - \`brilliance_highlights\`: \`-0.30 .. +0.20\`（压高光常用 \`-0.06 .. -0.18\`）

---

## 二、RawTherapee 管线（PP3 & Locallab）

1. **增量合并机制**：澄影会将每个 step 的参数合并到基础配置之上。启用某个工具小节（如 \`Shadows & Highlights\`、\`Vibrance\`、\`Lab Adjustments\`、\`Impulse Denoising\`）时，记得传 \`Enabled: true\`。
2. **避免 RGB 对比度带来的饱和度畸变**：
   - 大幅调整反差时，优先配合 \`Lab Adjustments\`（\`LContrast: -20..+25\`, \`Chromaticity: -10..+20\`），在 Lab 空间独立控制明度反差与色度，肤色更干净。
3. **局部调整必须走 \`Locallab\`**：
   - RawTherapee 不支持通用 \`step.mask\`，所有局部修改必须添加 \`op: "Locallab"\` 并传入 \`spots: [{ Name: "face", ... }]\`，在每个 spot 内显式设置对应工具开关（如 \`Expexpose: true\` 配合曝光参数）。

---

## 三、Builtin 线性光浮点管线（libvips 16-bit Float）

1. **执行顺序**：所有非几何算子按 step 顺序在 32-bit 线性光浮点空间执行，几何算子（\`rotate\`、\`perspective\`、\`crop\`、\`flip\`）自动在影调/色彩之后按顺序执行。
2. **多通道复合曲线（\`builtin:curve\`）**：
   \`curve\` 支持在一个 step 内同时传入亮度曲线与 RGB 分通道曲线：
   \`\`\`json
   {
     "op": "curve",
     "params": {
       "points": [[0, 0.015], [0.25, 0.22], [0.75, 0.78], [1, 0.985]],
       "red": [[0, 0], [0.25, 0.23], [0.75, 0.77], [1, 1]],
       "blue": [[0, 0.02], [0.25, 0.27], [0.75, 0.73], [1, 0.97]]
     }
   }
   \`\`\`
   其中 \`points\` 作用于感知亮度（保持色度比），\`red / green / blue\` 独立微调各通道，是塑造电影感与日系胶片感最强大的工具。
3. **蒙版坐标规范**：
   - 所有蒙版坐标 \`x, y, cx, cy, x0, y0, x1, y1\` 均为旋正后画面的 \`0..1\` 归一化坐标（左上角为 \`(0,0)\`）；
   - \`gradient\` 从 \`(x0, y0)\`（权重 1）平滑过渡到 \`(x1, y1)\`（权重 0）：例如压暗天空用 \`{ type: "gradient", x0: 0.5, y0: 0.05, x1: 0.5, y1: 0.45 }\`；压暗地面前景用 \`{ type: "gradient", x0: 0.5, y0: 0.95, x1: 0.5, y1: 0.55 }\`。
`;

const BATCH_OPS = `# 澄影批量命令手册

用于摄影工具没有覆盖的批量操作：清点、转换、重命名、旁车、打包、磁盘检查。

## 先看环境

- 可用命令：\`command -v exiftool magick ffmpeg vips rsync zip tar\`（Windows 用 \`Get-Command\`）。
- 托管变量（每次 shell 调用由宿主注入，不随会话保存）：
  - \`$DSH_CHENGYING_PROJECT\`：当前照片工作区（原图目录，只读）。
  - \`$DSH_CHENGYING_STATE\`：插件状态目录（缓存、预览、渲染）。
  - \`$DSH_CHENGYING_SCRATCH\`：临时工作目录，适合放脚本、中间文件、CSV。
  - \`$DSH_CHENGYING_EXPORT\`：默认交付目录。
  - 没有工作区时这些变量不存在；先 \`photo_session_start\` / \`photo_workspace_open\`。

## 铁律

1. 原图只读：不要对 \`$DSH_CHENGYING_PROJECT\` 下的文件执行 \`mv\`、\`rm\`、覆盖写入、\`chmod\`、\`touch\`，也不要写 XMP 旁车。需要副本时先 \`cp\` 到 scratch。
2. 所有输出写 \`$DSH_CHENGYING_SCRATCH\` 或交付目录；用 \`-o\` / \`--out\` 明确指定。
3. 破坏性命令先 dry-run（\`-n\`、\`--dry-run\`、先 \`echo\` 一遍），确认路径再执行；不要 \`rm -rf\` 变量目录。
4. 路径一律加引号；文件名可能含空格、中文、换行。批量遍历用 \`find -print0 | xargs -0\`。
5. 改图一律走 \`edit_*\`（会生成修订）；shell 只做“工具之外的辅助”，不要用 \`magick\` 直接覆盖交付图。
6. 跑完任何可能碰到原图的命令后，调用 \`photo_integrity_check\` 复核。

## 配方

### EXIF 清点

~~~bash
exiftool -csv -r -FileName -DateTimeOriginal -Model -LensModel -ISO -FNumber -ExposureTime \\
  "$DSH_CHENGYING_PROJECT" > "$DSH_CHENGYING_SCRATCH/exif.csv"
~~~

### 只读转换 / 缩略图

~~~bash
mkdir -p "$DSH_CHENGYING_SCRATCH/converted"
find "$DSH_CHENGYING_PROJECT" -maxdepth 2 -type f \\( -iname '*.jpg' -o -iname '*.png' \\) -print0 \\
  | xargs -0 -I{} magick "{}" -auto-orient -resize 1600x1600\\> "$DSH_CHENGYING_SCRATCH/converted/$(basename "{}")"
~~~

注意：上面 \`$(basename ...)\` 在 xargs 里不会按预期展开；可靠写法是 \`sh -c 'for f do magick "$f" ... "$OUT/$(basename "$f")"; done' sh\` 或写一个小脚本放 scratch。

### 重命名（只重命名交付副本）

~~~bash
cd "$DSH_CHENGYING_EXPORT" || exit 1
for f in *.JPG; do
  ts=$(exiftool -s3 -DateTimeOriginal -d '%Y%m%d-%H%M%S' "$f")
  mv -- "$f" "\${ts:-unknown}-$f"
done
~~~

### 视频 / 延时

~~~bash
ffmpeg -framerate 24 -pattern_type glob -i "$DSH_CHENGYING_EXPORT/*.jpg" \\
  -c:v libx264 -pix_fmt yuv420p -crf 18 "$DSH_CHENGYING_EXPORT/timelapse.mp4"
~~~

### 打包

优先 \`photo_deliver({ archive: true })\`（store-only zip，跨平台）。需要压缩率或 >4GB 时再用 shell：

~~~bash
cd "$(dirname "$DSH_CHENGYING_EXPORT")" && zip -r -q "$(basename "$DSH_CHENGYING_EXPORT").zip" "$(basename "$DSH_CHENGYING_EXPORT")"
~~~

### 磁盘与体量

~~~bash
df -h "$DSH_CHENGYING_PROJECT" "$DSH_CHENGYING_STATE"
du -sh "$DSH_CHENGYING_PROJECT"/* | sort -h | tail
~~~

## 收尾

- 回报“跑了什么命令、输出在哪、是否碰过原图”。
- 用 \`present\` 声明最终 zip / CSV / 报告，让用户直接打开。
`;

const ENGINE_TROUBLESHOOT = `# 澄影引擎排障手册

用于 \`edit_engines\` 报不可用 / health 失败、RAW 预览失败、导出异常时的定位。

## 先拿事实，不要猜

1. \`edit_engines\`（可加 \`refresh: true\`）：每个引擎的 \`available\` / \`usable\` / \`health.catalog\` / \`health.render\` / \`reason\`。
2. shell 里确认二进制与版本：
   - \`command -v darktable-cli rawtherapee-cli exiftool vips magick\`
   - \`darktable-cli --version\`
   - \`rawtherapee-cli -v\`（不同版本参数可能不同；先 \`--help\`）
3. 看配置里的显式路径：\`cordis.patch.yml\` 的 \`engines.darktable.path\` / \`engines.rawtherapee.path\`。路径错时 auto 探测会静默回退。
4. 复现：\`chengying engines verify <engine> --input <一张真实文件> --report <json>\`，把报告里的失败项贴出来。

## darktable

- 模块发现顺序：darktable-mcp（5.7+）→ 随包目录快照（精确版本，缺省降级同 minor）→ C 助手 \`dt-introspect\`（仅 POSIX）。
- 常见原因：
  - \`darktable-cli\` 不在 PATH 或被 Gatekeeper / 权限拦。
  - 模块目录与版本不匹配：用 \`darktable --version\` 对比快照文件名。
  - OpenCL 初始化失败：先用 \`--disable-opencl\` 试渲染，确认是否驱动问题。
  - Windows 输出路径：插件已用 \`cliPath()\` 转 \`/\`；如果手写命令，别用反斜杠。
- 验证：\`edit_native\` 调 \`image_stats\` / \`get_metadata\`；或 \`chengying engines verify darktable\`。

## RawTherapee

- \`-O\` 导出完整 pp3 键空间；渲染用 sidecar \`-p\`。
- 常见原因：
  - \`rawtherapee-cli\` 版本太旧，缺少新键；\`-O\` 输出里会少节。
  - Locallab 点参数类型不匹配（数组 vs 对象）。
  - 输出目录不可写或路径含空格；先写 scratch。
- 验证：\`chengying engines verify rawtherapee --input <RAW>\`。

## 内置 / AI 引擎

- 内置依赖 libvips（sharp）：\`node -e "require('sharp').versions"\` 看 libvips 版本。
- \`ai\` 引擎的操作是配置出来的（\`aiOperations\` / \`superResolution\`）；\`ai:upscale\` 的外部命令不存在时 health 会标不可用。
- 生成式提供者（openai-images / comfyui / command）不可用时，先看 \`gen_authorizations\` 与配置，不要绕过授权。

## 错误映射

- \`engine-unavailable\`：二进制/版本/路径问题，不是图片问题。
- \`render failed\`：输出路径、权限、格式、参数范围；先 \`edit_describe\` 对参数。
- \`verification-failed\`：元数据回读不一致；看 \`export_run\` 的 \`problems\`。
- RAW 预览失败但 JPG 正常：解码器缺失；用 \`photo_preview\` 的 \`hint\`，或先 \`edit_engines\` 确认可用引擎。

## 收尾

- 给出“哪条命令、什么输出、结论是什么、下一步建议”。
- 修好环境后用 \`edit_engines({ refresh: true })\` 重新探测，再继续修图。
`;

export const CHENGYING_SKILLS: ChengyingSkill[] = [
  {
    name: 'chengying-aesthetic-grading',
    description: 'Photography aesthetic triage, 5-pass retouching workflow, noise-headroom budget rules, tool hierarchy (RGB curves, HSL, masks) and anti-overprocessing rubric.',
    whenToUse: 'Use before or during photo retouching to diagnose tonal/color issues from percentiles and local contrast, plan natural multi-pass edits, and avoid over-processing.',
    content: AESTHETIC_GRADING,
  },
  {
    name: 'chengying-style-recipes',
    description: 'Curated, tested color-grading recipes across Builtin, Darktable and RawTherapee (Neutral Documentary, Airy Japanese Film, Warm Portrait, Urban Teal & Slate, Golden Hour Teal-Orange, Dynamic Landscape, Clean Night, Appetizing Food).',
    whenToUse: 'Use when choosing or applying a look/style for a scene cluster or individual photo, or when translating user aesthetic requests into concrete engine parameters.',
    content: STYLE_RECIPES,
  },
  {
    name: 'chengying-engine-mastery',
    description: 'Engine-specific color science and module best practices for darktable (scene-referred workflow, avoiding deprecated display-referred modules), RawTherapee (pp3 & Locallab) and the built-in linear-light pipeline.',
    whenToUse: 'Use when crafting darktable, RawTherapee or multi-channel curve/mask recipes so modules follow modern scene-referred color science without haloing or clipping.',
    content: ENGINE_MASTERY,
  },
  {
    name: 'chengying-batch-ops',
    description: 'Safe shell recipes for batch photo operations: EXIF reports, format conversion, renaming delivery copies, timelapse, archives and disk checks.',
    whenToUse: 'Use when a batch needs something the photo tools do not cover, or when you need a concrete, non-destructive shell recipe before touching files.',
    content: BATCH_OPS,
  },
  {
    name: 'chengying-engine-troubleshoot',
    description: 'Diagnose darktable / RawTherapee / builtin / AI engine availability and rendering failures with evidence instead of guessing.',
    whenToUse: 'Use when edit_engines reports unavailable or unhealthy, RAW previews fail, or exports look wrong but the recipe seems valid.',
    content: ENGINE_TROUBLESHOOT,
  },
]
