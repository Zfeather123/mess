# 去品牌化(品牌未定,先占位)

MIT 允许白牌。但**怎么换**很讲究:如果直接手改 `ui/index.html`、`site.webmanifest`、favicon,那这些 upstream 文件就永远带着我们的 diff,每次合并都要解一次冲突。

所以:**品牌在构建期注入,仓库里不留 diff。**

## 怎么用

```bash
node scripts/jin/apply-brand.mjs          # 注入品牌(在 pnpm build / docker build 之前跑)
node scripts/jin/apply-brand.mjs --check  # 只校验锚点(CI 每次都跑)
```

改品牌 = 改 `branding/brand.config.json` 一个文件 + 把图标丢进 `branding/assets/`。**不要手改 `ui/` 里的任何文件。**

当前占位值:

| 字段 | 值 |
|---|---|
| name / title | `Jin Studio`(**待定**) |
| shortName | `Jin` |
| themeColor | `#18181b`(先沿用) |
| lang | `zh-CN`(Paperclip 默认 `en`,我们的用户是中文的) |
| 图标 | **还没有** —— `branding/assets/` 是空的,现在跑起来仍是 Paperclip 的回形针图标 |

## 覆盖到的位置

| 文件 | 改什么 |
|---|---|
| `ui/index.html` | `<title>` / `apple-mobile-web-app-title` / `theme-color` / `html lang` |
| `ui/public/site.webmanifest` | `name` / `short_name` / `description` / `theme_color` |
| `ui/public/*` | 用 `branding/assets/` 里的同名文件覆盖(favicon.ico / favicon.svg / android-chrome-*.png / apple-touch-icon.png) |

## `--check` 是干嘛的

CI 每次都跑 `--check`。它不改文件,只确认那几个正则锚点还能匹配上。
**upstream 哪天重构了 `index.html`,CI 当场红**,而不是等某次发版之后才发现浏览器标签又变回 "Paperclip" 了。

## 品牌定下来之后要做的

- [ ] 设计出图标(至少:`favicon.svg`、`favicon.ico`、`favicon-16x16.png`、`favicon-32x32.png`、`apple-touch-icon.png`、`android-chrome-192x192.png`、`android-chrome-512x512.png`)→ 丢进 `branding/assets/`
- [ ] 更新 `branding/brand.config.json` 的 name / title / themeColor
- [ ] UI 里残留的 "Paperclip" 文案(登录页、空状态等)走 i18n(`ui/src/i18n/locales`),不要硬改组件
- [ ] `LICENSE` **保留 MIT 原文和版权行**(这是 MIT 的义务),我们的版权另起一行追加
