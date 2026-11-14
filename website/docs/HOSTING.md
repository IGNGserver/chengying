# 托管与部署（Cloudflare Pages）

> 正式站点：<https://chengying.igng.net/>。站点源码位于产品主仓库 `IGNGserver/chengying` 的 `website/`，采用 Cloudflare Pages **Direct Upload** 托管，持续校验与自动发布工作流为 `.github/workflows/website.yml`。

## 当前配置

| 项 | 值 |
| --- | --- |
| Pages 项目 | `chengying-website`（Direct Upload，项目 ID `f26dbf02-31b5-43e0-85a6-33339ed8f2d2`） |
| 部署来源 | `IGNGserver/chengying` 的 `website/` |
| 部署工作流 | `.github/workflows/website.yml` |
| 生产分支 | `main` |
| 构建命令 | `pnpm install --frozen-lockfile --ignore-workspace && pnpm rebuild esbuild && pnpm run build`（在 `website/` 下） |
| 发布目录 | `website/dist/` |
| 自定义域名 | `https://chengying.igng.net/`（zone `igng.net`，zone ID `d3f06d3e7ef8cccf99e93ce9c4ea4f44`，domain ID `0aaf46c7-42af-4201-84e3-9deee8f03366`） |
| 默认别名 | `https://chengying-website.pages.dev/`（保留） |
| DNS | proxied CNAME `chengying.igng.net` → `chengying-website.pages.dev`（record ID `074a090ccfce2ad0c9bd343f96e65068`，新建前无旧记录） |

`SITE_URL` 固定为 `https://chengying.igng.net/`，与 `website/index.html`（`canonical`、`og:url`、`og:image`、JSON-LD）、`website/public/robots.txt`、`website/public/sitemap.xml` 及 CI 构建环境变量保持一致。`website/` 使用独立的 `package.json` 与 `pnpm-lock.yaml`，不并入产品根目录的插件构建，也不会进入插件 `.tgz` 发布资产。

## 构建参数与安全响应头

| 项 | 值 |
| --- | --- |
| 安装 | `pnpm install --frozen-lockfile --ignore-workspace`（Node.js 22+，`packageManager: pnpm@10.33.0`） |
| 构建 | `pnpm run build`（`tsc --noEmit && vite build`） |
| 验收 | `pnpm run verify`（Playwright 无头 Chromium 校验 `1440×900` / `768×1024` / `390×844` 三视口、WebGL2 线性光暗房、24→8 FLIP 筛图叙事、多 Agent 沙盒检视、生成式授权边界、SEO 元数据与安全响应头） |
| 输出 | `dist/`（纯静态，含 `index.html`、`404.html`、`_headers`、`robots.txt`、`sitemap.xml`、`og/og.jpg`、`apple-touch-icon.png`、`favicon.svg`、`photos/**` 与哈希化 `assets/*`） |
| 响应头 | `website/public/_headers`：`/assets/*` 一年期 `immutable` 强缓存；`/photos/*` 7 天边缘缓存 + `stale-while-revalidate`；全站启用 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、`Permissions-Policy`、`Cross-Origin-Opener-Policy: same-origin` |

本地构建与验证必须在 `${BUILD_SCRATCH_ROOT:-$HOME/.build}` 本机盘镜像目录内执行，禁止在项目目录内产生 `node_modules/` 或 `dist/`。

## 自动部署与所需凭据

`.github/workflows/website.yml` 在以下时机运行：

- `pull_request`（改动涉及 `website/**` 或 `.github/workflows/website.yml`）：执行构建与 Playwright 无头浏览器全套交互校验，**不执行部署**；
- `push` 到 `main`（改动涉及 `website/**` 或 `.github/workflows/website.yml`）：校验通过后调用 `cloudflare/wrangler-action@v3` 部署 `dist/` 至 `chengying-website`（`--branch main`）；
- `repository_dispatch`（`release-published`）与手动 `workflow_dispatch`：重新构建并部署生产站点。

GitHub 仓库 Actions Secrets（仅存放在仓库设置，严禁写入代码、文档或日志）：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（具备 `Cloudflare Pages:Edit` 权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（按敏感信息管理，不写入公开仓库） |

使用 Direct Upload，**不连接** Cloudflare Pages 内置的 Git 集成，避免重复构建或绕过 GitHub Actions 门禁。

## 日常维护与回滚

- **上线后核对项**：`https://chengying.igng.net/` 返回 `200`、未知路径（如 `/nonexistent-route`）返回 `404`、`/og/og.jpg` 返回 `200`、`/assets/*` 返回 `Cache-Control: public, max-age=31536000, immutable`、安全响应头齐全；
- **快速回滚**：在 Cloudflare Pages 控制台 `chengying-website` → `Deployments` 选择上一个成功生产部署点击 Rollback，或通过 Cloudflare API 调用 `POST /client/v4/accounts/{account_id}/pages/projects/chengying-website/deployments/{deployment_id}/rollback`；
- **域名回滚 / 变更**：修改或移除 DNS 前先核对原记录（新建前 `chengying.igng.net` 无任何历史 DNS 记录；当前为 proxied CNAME `chengying.igng.net` → `chengying-website.pages.dev`，record ID `074a090ccfce2ad0c9bd343f96e65068`）。

## 搜索收录与隐私

- **Google Search Console**：父域资源 `sc-domain:igng.net` 已覆盖本子域；`website/public/robots.txt` 的 `Sitemap:` 指向静态 `website/public/sitemap.xml`；
- **Bing Webmaster Tools**：`website/index.html` 已内置 `*.igng.net` 站点统一的 `<meta name="msvalidate.01" content="B411826ACAE5C5CD20EA5574C3F8A6E4" />` 验证标签，请勿删除；
- **零追踪承诺**：全站无第三方统计脚本、无 Cookie、无外部字体或脚本 CDN 请求。
