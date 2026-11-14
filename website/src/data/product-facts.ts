import type { Bilingual } from '../types'

export const CHENGYING_FACTS = {
  version: '0.8.0',
  packageName: 'chengying',
  presetId: 'chengying',
  presetNameZh: '澄影 · 摄影后期',
  presetNameEn: 'Chengying · Photo Post-Production',
  repositoryUrl: 'https://github.com/IGNGserver/chengying',
  releasesUrl: 'https://github.com/IGNGserver/chengying/releases',
  nodeRequirement: '>= 24.9.0',
  dshRequirement: '>= 0.2.1-0 < 0.3.0',
  totalTools: 38,
  bundledSkills: 5,
  supportedRawExtensions: 28,
  supportedRasterExtensions: 13,
  verifiedExifTags: 20,
  sqliteTables: 20,
  totalVerifiedOps: 174,
  totalSchemaParams: 2448,
} as const

export interface EngineCoverageSpec {
  id: 'darktable' | 'rawtherapee' | 'builtin' | 'ai'
  name: string
  testedVersion: string
  discoveryMethod: Bilingual
  operations: number
  parameters: number
  passed: number
  failed: number
  skipped: number
  skipReason?: Bilingual
  sidecarFormat: string
  highlights: Bilingual[]
  sampleOps: string[]
}

export const ENGINE_COVERAGE_DATA: EngineCoverageSpec[] = [
  {
    id: 'darktable',
    name: 'darktable',
    testedVersion: '5.6.1 / 5.7+ MCP',
    discoveryMethod: {
      zh: 'darktable-mcp (5.7+) → 随包版本目录快照 → POSIX C dlopen (dt-introspect v8) 动态读取模块字段树与管线顺序',
      en: 'darktable-mcp (5.7+) → bundled versioned catalog snapshot → POSIX C dlopen (dt-introspect v8) binary struct introspection',
    },
    operations: 93,
    parameters: 738,
    passed: 89,
    failed: 0,
    skipped: 4,
    skipReason: {
      zh: '4 项跳过均为非导出像素算子：finalscale（内部缩放）、clahe（已弃用无自省，按 $blob 透传）、overexposed / rawoverexposed（纯 UI 指示器）',
      en: '4 skipped non-export ops: finalscale (internal), clahe (deprecated, raw $blob passthrough), overexposed & rawoverexposed (UI-only indicators)',
    },
    sidecarFormat: '.xmp (darktable XMP v5 + blendop v14)',
    highlights: [
      {
        zh: '默认启用现代 32-bit 浮点线性 REC.2020 场景参考管线（Scene-Referred），自动规避旧显示参考模块叠加断层',
        en: 'Defaults to modern 32-bit float linear REC.2020 scene-referred pipeline, preventing legacy display-referred clipping',
      },
      {
        zh: '支持圆、椭圆、矩形、渐变、多边形、笔刷 6 类手绘蒙版与全通道参数化蒙版，逐字节回读内嵌 XMP 校验一致性',
        en: 'Supports 6 drawn mask shapes + full-channel parametric masks with byte-for-byte embedded XMP read-back verification',
      },
      {
        zh: '曲线模块（rgbcurve / tonecurve / colorzones）提供点对高层语法糖，自动拟合单调样条并编码底层二进制结构体',
        en: 'High-level point-pair syntax sugar for spline modules, automatically fitting monotonic splines into binary params',
      },
    ],
    sampleOps: [
      'exposure',
      'sigmoid',
      'filmicrgb',
      'colorbalancergb',
      'channelmixerrgb',
      'toneequal',
      'rgbcurve',
      'colorzones',
      'denoiseprofile',
      'diffuse',
      'ashift',
    ],
  },
  {
    id: 'rawtherapee',
    name: 'RawTherapee',
    testedVersion: '5.13',
    discoveryMethod: {
      zh: 'rawtherapee-cli -O 导出完整处理配置（56 节 872 键）+ Locallab 局部调整点全展开（836 键）自动生成 JSON Schema',
      en: 'rawtherapee-cli -O full profile export (56 sections, 872 keys) + Locallab spot expansion (836 keys) into JSON Schema',
    },
    operations: 54,
    parameters: 1593,
    passed: 54,
    failed: 0,
    skipped: 0,
    sidecarFormat: '.pp3 (Native Processing Profile)',
    highlights: [
      {
        zh: '54 个工具与 1,593 个参数 100% 实测渲染并通过 dumpProfile 逐键回读核验，零失败零遗漏',
        en: '100% of 54 tools and 1,593 parameters verified via real RAW rendering and dumpProfile key-by-key read-back',
      },
      {
        zh: '完整暴露 Locallab 局部调整点（spots[] 14 大局部工具块与 ΔE 色彩范围蒙版），外部 ICC/LCP/LUT 引用经 FsGuard 安全校验',
        en: 'Exposes full Locallab spots[] (14 local tool groups & ΔE color masks) with FsGuard validation on external ICC/LCP/LUT paths',
      },
      {
        zh: '针对整数参数自动执行四舍五入容错重试，并用 libvips 解码校验输出像素完整性',
        en: 'Automatic integer coercion retry and full pixel decode verification via libvips',
      },
    ],
    sampleOps: [
      'Exposure',
      'White Balance',
      'Shadows & Highlights',
      'Vibrance',
      'Tone Curves',
      'Lab Adjustments',
      'Locallab',
      'Impulse Denoising',
      'Defringe',
      'Perspective',
    ],
  },
  {
    id: 'builtin',
    name: 'Builtin Linear 32f',
    testedVersion: '0.8.0 (libvips)',
    discoveryMethod: {
      zh: '内置强类型算子注册表，无外部 RAW 引擎依赖即可开箱运行完整筛图与 32-bit 线性光精修',
      en: 'Built-in strongly typed operator registry — full culling & 32-bit float linear-light retouching out of the box',
    },
    operations: 23,
    parameters: 95,
    passed: 23,
    failed: 0,
    skipped: 0,
    sidecarFormat: '.chengying.json (chengying-recipe/1)',
    highlights: [
      {
        zh: '全链路 32-bit 浮点线性 sRGB 计算，内置 0.75+ 高光软膝压缩与色相保护，提亮人像不偏黄',
        en: '32-bit float linear sRGB pipeline with soft-knee highlight compression and hue preservation for natural skin tones',
      },
      {
        zh: 'Fritsch–Carlson 4096 级单调三次样条曲线，支持单步同时组合 Luma 与 R/G/B 分通道曲线实现胶片滚降与冷暖分离',
        en: 'Fritsch–Carlson 4096-step monotonic cubic spline supporting combined Luma + R/G/B curves in a single atomic step',
      },
      {
        zh: '全部 19 个非几何算子均支持 6 种手绘几何蒙版 × 11 通道参数化范围蒙版及布尔运算，含非生成式光学克隆修复 heal',
        en: 'All 19 non-geometry ops support 6 drawn shapes × 11-channel parametric masks, plus deterministic planar-gradient heal',
      },
    ],
    sampleOps: [
      'exposure',
      'tone',
      'curve',
      'white_balance',
      'hsl',
      'color_grading',
      'lut3d',
      'clarity',
      'dehaze',
      'denoise',
      'heal',
      'perspective',
    ],
  },
  {
    id: 'ai',
    name: 'AI Stage (Phase 3)',
    testedVersion: '0.8.0 (Guarded)',
    discoveryMethod: {
      zh: '内置确定性视觉算法 + 用户显式配置的 aiOperations CLI 与受门禁保护的 generative.providers',
      en: 'Deterministic computer-vision ops + user-configured aiOperations CLIs + fail-closed generative.providers',
    },
    operations: 4,
    parameters: 22,
    passed: 4,
    failed: 0,
    skipped: 0,
    sidecarFormat: '.chengying.json + generated_assets SHA-256 Receipt',
    highlights: [
      {
        zh: '严格二分：ai:inpaint（Telea 周围像素行进修补）、ai:style_match（含肤色阻尼的 Lab 影调迁移）、ai:upscale 均为非生成式',
        en: 'Strict dichotomy: ai:inpaint (Telea pixel propagation), ai:style_match (skin-safe Lab transfer), and ai:upscale are non-generative',
      },
      {
        zh: 'ai:gen_layer 受私有 Symbol 与任务绑定原子授权锁死，生成结果存为独立 16-bit PNG 遮罩层并校验磁盘 SHA-256 收据',
        en: 'ai:gen_layer is gated by a private Symbol & task-bound atomic grant, stored as a deterministic 16-bit PNG layer with SHA-256 receipt',
      },
      {
        zh: '含生成图层的导出强制写入 IPTC DigitalSourceType = compositeWithTrainedAlgorithmicMedia；撤销图层即刻恢复纯净纪实标记',
        en: 'Exports with generative layers carry IPTC DigitalSourceType = compositeWithTrainedAlgorithmicMedia; reverting removes the tag',
      },
    ],
    sampleOps: ['ai:inpaint', 'ai:style_match', 'ai:upscale', 'ai:gen_layer'],
  },
]

export const RAW_FORMAT_BADGES = [
  { brand: 'Sony', exts: '.ARW · .SRF · .SR2' },
  { brand: 'Canon', exts: '.CR3 · .CR2 · .CRW' },
  { brand: 'Nikon', exts: '.NEF · .NRW' },
  { brand: 'Fujifilm', exts: '.RAF' },
  { brand: 'Leica', exts: '.DNG · .RWL' },
  { brand: 'Hasselblad', exts: '.3FR · .FFF' },
  { brand: 'Phase One', exts: '.IIQ' },
  { brand: 'OM / Panasonic', exts: '.ORF · .RW2' },
  { brand: 'Pentax / Ricoh', exts: '.PEF · .DNG' },
  { brand: 'ProRAW / Mobile CFA', exts: '.DNG (Engine Fallback)' },
] as const

export const BUNDLED_SKILLS_LIST = [
  {
    id: 'chengying-aesthetic-grading',
    title: { zh: '摄影审美分诊与五步精调总纲', en: 'Aesthetic Triage & 5-Pass Grading Rubric' },
    desc: {
      zh: '基于 p05/p50/p95 与 shadowEv 噪点上限的定量光影分诊、曲线优先工具金字塔及 5 条一票否决红线。',
      en: 'Quantitative light triage (p05/p50/p95, shadowEv noise ceiling), curve-first hierarchy, and 5 auto-revert red lines.',
    },
  },
  {
    id: 'chengying-style-recipes',
    title: { zh: '8 套跨引擎专业色彩配方库', en: '8 Cross-Engine Color Style Recipes' },
    desc: {
      zh: '涵盖自然纪实、日系 Pro400H、温润人像、冷青都市、落日青橙、风光、夜景与静物的三引擎参数起点。',
      en: 'Calibrated Builtin, darktable, and RawTherapee starting recipes across 8 genres with explicit scene contraindications.',
    },
  },
  {
    id: 'chengying-engine-mastery',
    title: { zh: '场景参考色彩科学与蒙版规范', en: 'Scene-Referred Color Science & Mask Mastery' },
    desc: {
      zh: 'darktable 线性场景参考铁律、RawTherapee Locallab 局部点与 builtin 分通道样条曲线规范。',
      en: 'darktable scene-referred rules, RawTherapee Locallab spots, and builtin multi-channel spline curves.',
    },
  },
  {
    id: 'chengying-batch-ops',
    title: { zh: '受控环境变量非破坏批处理', en: 'Non-Destructive Batch Operations' },
    desc: {
      zh: '围绕 $DSH_CHENGYING_PROJECT（只读）与 SCRATCH/EXPORT 的安全脚本配方。',
      en: 'Safe scripting patterns bound to read-only $DSH_CHENGYING_PROJECT and isolated scratch/export roots.',
    },
  },
  {
    id: 'chengying-engine-troubleshoot',
    title: { zh: '引擎健康度与跨平台排障', en: 'Engine Doctor & Cross-Platform Diagnostics' },
    desc: {
      zh: '48×32 实测渲染冒烟、OpenCL 自动回退与 Windows 反斜杠转义排障指南。',
      en: '48×32 render smoke tests, OpenCL fallback, and Windows path normalization diagnostics.',
    },
  },
] as const
