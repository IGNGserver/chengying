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
} as const

export interface EngineCoverageSpec {
  id: 'builtin' | 'darktable' | 'rawtherapee' | 'ai'
  name: Bilingual
  badge: Bilingual
  subtitle: Bilingual
  summary: Bilingual
  sidecarFormat: Bilingual
  highlights: Bilingual[]
  capabilities: Bilingual[]
}

export const ENGINE_COVERAGE_DATA: EngineCoverageSpec[] = [
  {
    id: 'builtin',
    name: { zh: '澄影内置数字暗房', en: 'Chengying Built-in Darkroom' },
    badge: { zh: '装好即用 · 无需额外软件', en: 'Ready Out of the Box' },
    subtitle: {
      zh: '不依赖第三方修图软件，手机照片与常用相机照片装好就能修',
      en: 'Works right away with zero extra installs — ideal for daily phone & camera edits',
    },
    summary: {
      zh: '针对日常选片与温和调色打磨的内置暗房：柔和压暗亮部不过曝，提亮人脸自然不发黄，一套动作同时保存非破坏配方，随时都能推倒重来。',
      en: 'Designed for effortless culling and gentle color work: smooth highlight roll-off, flattering skin light, and non-destructive recipes you can adjust anytime.',
    },
    sidecarFormat: {
      zh: '保存为轻量配方文件（.chengying.json），原片完全不动',
      en: 'Saved as a clean sidecar recipe (.chengying.json) · Original untouched',
    },
    highlights: [
      {
        zh: '不用配置复杂环境，安装完澄影插件就能直接选片、修人像、调风景。',
        en: 'No external software needed — start sorting bursts and grading right after install.',
      },
      {
        zh: '自带柔光高光保护，提亮暗部人像时肤色依旧温润，不容易显得干硬或发黄。',
        en: 'Built-in highlight roll-off keeps bright skies gentle and skin tones clean when lifting shadows.',
      },
      {
        zh: '支持局部柔光圈、天空渐变和杂物点消修补，常见修图一步到位。',
        en: 'Includes soft face glow masks, sky gradients, and clean spot/wire healing.',
      },
    ],
    capabilities: [
      { zh: '自然曝光与对比度', en: 'Natural Exposure & Tone' },
      { zh: '高光柔化保护', en: 'Highlight Protection' },
      { zh: '分通道色彩曲线', en: 'Tone & Color Curves' },
      { zh: '色温与局部微调', en: 'Warmth & HSL' },
      { zh: '胶片风格查找表', en: 'Film Look Presets' },
      { zh: '柔和局部蒙版', en: 'Soft Local Masks' },
      { zh: '灰点杂物修补', en: 'Spot & Blemish Heal' },
      { zh: '轻柔降噪与扶正', en: 'Denoise & Straighten' },
    ],
  },
  {
    id: 'darktable',
    name: { zh: 'darktable 专业暗房联动', en: 'darktable Integration' },
    badge: { zh: '可选搭配 · 深度 RAW 冲印', en: 'Optional · Full RAW Suite' },
    subtitle: {
      zh: '如果你电脑装有开源专业软件 darktable，澄影能直接调用它的全套冲印能力',
      en: 'Automatically connects to your local darktable install for full studio RAW grading',
    },
    summary: {
      zh: '不把专业软件简化成几个玩具滑块，而是尊重摄影师常用工作习惯，支持完整专业调色模块，并顺手生成标准的 .xmp 工程文件，随时可以在 darktable 里打开继续微调。',
      en: 'Never strips down your tools: uses darktable’s complete RAW pipeline and writes standard .xmp sidecar files so you can open and refine any photo yourself.',
    },
    sidecarFormat: {
      zh: '导出标准 darktable .xmp 工程文件，桌面软件可直接打开接着调',
      en: 'Exports standard darktable .xmp files — open directly in darktable anytime',
    },
    highlights: [
      {
        zh: '大光比雪山与逆光人像的高光过渡极柔和，大晴天云彩和白色婚纱也不易惨白死白。',
        en: 'Smooth highlight transitions keep sunlit clouds and bright fabrics detailed without harsh clipping.',
      },
      {
        zh: '支持人像椭圆柔光、天空线性渐变等多种局部调整区域，精细照顾画面每一块明暗。',
        en: 'Supports full local adjustment shapes — gradients, brushes, ellipses, and tone-based masks.',
      },
      {
        zh: '每次精修自动留下规范的 .xmp 旁车配方文件，方便你自己打开继续收尾微调。',
        en: 'Saves clean .xmp sidecar recipes alongside your photos for effortless handoff.',
      },
    ],
    capabilities: [
      { zh: '完整 RAW 无损解码', en: 'Full Camera RAW Decode' },
      { zh: '胶片感柔和曲线', en: 'Filmic Highlight Roll-Off' },
      { zh: '暗部细节分区提亮', en: 'Zone Shadow Recovery' },
      { zh: '冷暖氛围分色平衡', en: 'Split Color Balance' },
      { zh: '高感光降噪', en: 'Noise Reduction' },
      { zh: '建筑横平竖直矫正', en: 'Perspective Correction' },
      { zh: '多形状局部蒙版', en: 'Drawn & Tone Masks' },
      { zh: '导出标准 .xmp 工程', en: 'Standard .xmp Sidecars' },
    ],
  },
  {
    id: 'rawtherapee',
    name: { zh: 'RawTherapee 精细冲印联动', en: 'RawTherapee Integration' },
    badge: { zh: '可选搭配 · 细腻画质与胶片调性', en: 'Optional · Crisp Detail & Film' },
    subtitle: {
      zh: '兼容 RawTherapee 5 全部色彩、降噪与局部精修工具，同步导出 .pp3 工程文件',
      en: 'Works with RawTherapee 5’s full toolset for crisp textures, gentle noise control, and .pp3 recipes',
    },
    summary: {
      zh: '喜欢 RawTherapee 对胶片色彩、微反差与紫边紫雾抑制的细腻手感？安装后澄影即可直接联动它完成精修，并完整导出 .pp3 配方文件，电脑打开即所见。',
      en: 'Love RawTherapee’s signature sharpness and clean shadows? Chengying drives it seamlessly and saves .pp3 recipes you can open straight in RawTherapee anytime.',
    },
    sidecarFormat: {
      zh: '导出标准 RawTherapee .pp3 配方文件，开箱即可对接桌面版继续微调',
      en: 'Exports standard RawTherapee .pp3 files ready for desktop fine-tuning',
    },
    highlights: [
      {
        zh: '全面支持 RawTherapee 的色彩平衡、多组细腻局部调整点、肤色保护与风光通透调节。',
        en: 'Supports RawTherapee’s rich local spot adjustments, gentle skin protection, and crisp color tools.',
      },
      {
        zh: '自动帮你保留镜头畸变校正、紫边消除与细腻胶片颗粒感，省去繁琐手动点选。',
        en: 'Applies lens correction, defringing, and subtle film texture without hunting through deep menus.',
      },
      {
        zh: '输出真实可读的 .pp3 处理档案，方便有桌面修图习惯的朋友继续接手调整。',
        en: 'Generates clean, standard .pp3 processing profiles for easy manual tweaks.',
      },
    ],
    capabilities: [
      { zh: '经典高光与暗部压缩', en: 'Highlights & Shadows' },
      { zh: '局部区域精准点亮', en: 'Local Spot Adjustments' },
      { zh: '自然肤色保护', en: 'Skin Tone Protection' },
      { zh: '高感杂色细腻抑制', en: 'Impulse Noise Cleanup' },
      { zh: '消除逆光紫边', en: 'Fringe Removal' },
      { zh: '胶片模拟与黑白质感', en: 'Film & Monochrome Looks' },
      { zh: '镜头畸变扶正', en: 'Lens & Horizon Fix' },
      { zh: '导出 .pp3 配方文件', en: 'Standard .pp3 Profiles' },
    ],
  },
  {
    id: 'ai',
    name: { zh: '智能局部修补与 AI 边界守护', en: 'Smart Cleanup & Honest AI Guard' },
    badge: { zh: '安全分界 · 未经你点头不改真伪', en: 'Honest Boundary · Always Reversible' },
    subtitle: {
      zh: '把“擦除杂物/统一影调”与“AI 换天生成”清晰分开，守护每张照片的可信度',
      en: 'Cleanly separates everyday blemish removal from AI image generation requiring your confirmation',
    },
    summary: {
      zh: '顺手擦除电线、路面纸屑或调整成组色调，全都基于照片本来的真实像素，流畅直接完成；一旦遇到需要用 AI 重新绘制天空等操作，会立刻停下来征求你的同意。',
      en: 'Removing stray wires or matching series color uses only your real photo light. Any request to invent new skies pauses immediately until you approve.',
    },
    sidecarFormat: {
      zh: '生成图层单独存放可一键撤回，并在照片信息里诚实记录来源',
      en: 'AI layers stay separate and reversible, with honest source notes in exports',
    },
    highlights: [
      {
        zh: '日常擦除电线杂物、参考样片统一风格、适当放大清晰度，只利用原有真实光线与周边画面。',
        en: 'Wire cleanup, look matching, and gentle upscaling stay faithful to your real captured light.',
      },
      {
        zh: '任何“无中生有”的 AI 换天或画面重绘操作默认上锁，没有你的点击允许绝不执行。',
        en: 'Generative sky swaps stay locked by default — never run behind your back.',
      },
      {
        zh: '哪怕同意生成一次，结果也会放在独立图层里，随时能一键撤回恢复成纯实拍版。',
        en: 'Approved AI edits live on a separate layer you can undo with a single click anytime.',
      },
    ],
    capabilities: [
      { zh: '杂物电线自然擦除', en: 'Stray Wire & Spot Heal' },
      { zh: '同组风格温柔对齐', en: 'Series Look Matching' },
      { zh: '清晰度适度放大', en: 'Gentle Resolution Boost' },
      { zh: 'AI 重绘默认先询问', en: 'AI Generation Prompt Gate' },
      { zh: '独立图层随时可撤', en: 'One-Click Undo Layer' },
      { zh: '导出信息如实标注', en: 'Honest Source Metadata' },
    ],
  },
]

export const RAW_FORMAT_BADGES: ReadonlyArray<{ brand: Bilingual; exts: string }> = [
  { brand: { zh: '手机日常格式', en: 'Phone Photos' }, exts: 'JPG · PNG · HEIC · ProRAW' },
  { brand: { zh: 'Sony 索尼', en: 'Sony' }, exts: '.ARW · .SRF · .SR2' },
  { brand: { zh: 'Canon 佳能', en: 'Canon' }, exts: '.CR3 · .CR2 · .CRW' },
  { brand: { zh: 'Nikon 尼康', en: 'Nikon' }, exts: '.NEF · .NRW' },
  { brand: { zh: 'Fujifilm 富士', en: 'Fujifilm' }, exts: '.RAF' },
  { brand: { zh: 'Leica 徕卡', en: 'Leica' }, exts: '.DNG · .RWL' },
  { brand: { zh: 'Hasselblad 哈苏', en: 'Hasselblad' }, exts: '.3FR · .FFF' },
  { brand: { zh: 'OM / 松下', en: 'OM / Panasonic' }, exts: '.ORF · .RW2' },
  { brand: { zh: '宾得 / 理光', en: 'Pentax / Ricoh' }, exts: '.PEF · .DNG' },
  { brand: { zh: '飞思中画幅', en: 'Phase One' }, exts: '.IIQ' },
]

export const BUNDLED_SKILLS_LIST = [
  {
    tag: { zh: '审美与分寸', en: 'Taste & Restraint' },
    title: { zh: '看懂光线再下手的修图习惯', en: 'Read the Light Before Moving Sliders' },
    desc: {
      zh: '先看亮部会不会发白、暗部拉亮会不会起噪点、人脸要不要柔和处理；光影本来就很好时学会留白不动。',
      en: 'Checks highlight safety, low-light noise limits, and skin softness first — and knows when to leave a great frame untouched.',
    },
  },
  {
    tag: { zh: '内置风格库', en: 'Film & Light Looks' },
    title: { zh: '8 种温柔耐看的旅拍影调起点', en: 'Eight Thoughtful Color Starting Points' },
    desc: {
      zh: '覆盖日常纪实、清透富士感、暖调人像、蓝调夜景、夕阳山野与静物茶席，不同场景不用从零瞎试。',
      en: 'Ready starting moods for sunlit travel, airy film, warm portraits, blue-hour alleys, and calm indoor still lifes.',
    },
  },
  {
    tag: { zh: '局部与色彩', en: 'Local Polish' },
    title: { zh: '压住杂色高光、单独点亮主角', en: 'Subtle Masks & True-to-Life Colors' },
    desc: {
      zh: '压低过曝天空、给面部加一点柔和暖光，避免满脸拉亮造成生硬假白或背景脏闷。',
      en: 'Gently balances bright skies and adds natural glow around people without harsh halos or plastic skin.',
    },
  },
  {
    tag: { zh: '安全批处理', en: 'Safe Batch Albums' },
    title: { zh: '几百张同游照片轻松统一步调', en: 'Keep Whole Trip Albums Cohesive' },
    desc: {
      zh: '同一场景先精修一张代表作，再顺滑同步到其余同组精选，原片永远呆在只读区安然无恙。',
      en: 'Set the mood on one key shot and carry it smoothly across matching frames while originals stay safely untouched.',
    },
  },
  {
    tag: { zh: '贴心巡检', en: 'Smooth Setup' },
    title: { zh: '自动认出本机已有的修图软件', en: 'Works Smoothly on Your Computer' },
    desc: {
      zh: '无论你用的是 Mac、Windows 还是 Linux，装好就能自动对接本机工具，遇错给出明白的中文提醒。',
      en: 'Detects optional desktop photo engines on Mac, Windows, or Linux automatically and falls back cleanly when needed.',
    },
  },
] as const
