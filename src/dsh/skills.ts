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
