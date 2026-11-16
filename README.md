# dsh-aipais-image

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-4f46e5.svg)](https://github.com/JAYcodr/dsh-aipais-image)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-3c873a.svg)](https://nodejs.org)

把「想点子 → 填个表 → 出图 → 回给用户看」压成**一次工具调用**的 DSH 宿主插件。
底座是 [aipais.de](https://aipais.de) 的 OpenAI 兼容图片中转，主模型 `gpt-image-2.6-exact`。
一次调用可以给**多条不同提示词**（`prompts`），每张图旁边落一份 JSON 元数据，`save_dir` 里再记一份 `index.jsonl` 账本。

> 要求：DSH 0.2.x（会话内联图片卡依赖 0.2 的客户端模块系统，0.1.x 只能出文本）+ 一个 aipais.de 的 API key。
> 零 npm 依赖，`index.js` / `lib/` 都是可直接加载的 ESM，没有构建步骤。

| 工具 | 作用 | 花钱 |
|---|---|---|
| `generate_image` | 文生图 / 参考图编辑，自动落盘到工作区，返回路径 + 可直接粘贴的 Markdown | 约 0.009 credits/张 |
| `image_gen_info` | 查余额、模型与尺寸档、能力表 | 免费 |

## 为什么用它

新会话不用再翻 `.aipais.env`、不用记 curl 参数、不用管 b64 还是 url：

- 一条调用完成「生成 → 落盘 → 返回 Markdown」，文件默认落在 `<当前工作目录>/generate/images/`；
- 优先 `b64_json`，绕开 CDN 的 UA 拦截与 `chatgpt.com` 直链被墙；
- 返回的格式按**真实文件魔数**判断（不信请求参数），顺手带回宽高；
- 5xx/429 指数退避重试，尊重 `Retry-After`；单张下载失败还会再试一次；
- 一次最多 10 张，风格/比例/格式都在参数里选；
- 同一秒、同一 prompt、并行两次调用也不会互相覆盖（进程内占位 + `-2`/`-3` 后缀）；
- 多会话同时出图走进程内并发闸（默认 2，配置 `concurrency` 可调），排队而不是撞 429。

## generate_image 参数表

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `prompt` | string | 与 `prompts` 二选一 | 主体、场景、光线、媒介/画风；要画面文字就把文字逐字写进去并要求不得乱码 |
| `prompts` | string[] | — | **一次给 1–10 条不同提示词，各出一张**；给了它就忽略 `n` |
| `n` | 1–10 | `1` | 同一提示词的张数 |
| `model` | string | `gpt-image-2.6-exact` | 见下方模型表；GIF/SVG 会**自动**切 `-media` |
| `aspect_ratio` | enum | `1:1` | `1:1` `16:9` `9:16` `2:3` `3:2` |
| `size_tier` | enum | `1k` | `1k`（原生）/ `2k` / `4k`（只有 `-exact` 支持；2k/4k 是 1k 放大，细节不增加） |
| `quality` | enum | `auto` | `auto` `low` `medium` `high`；追速度用 auto/low |
| `output_format` | enum | `auto` | `png` `jpeg` `webp` `gif` `svg` `auto`（b64 默认 PNG） |
| `reference_images` | string[] | — | 1–4 张参考图，给了就走 `/v1/images/edits`：锁角色、锁风格、改背景/表情 |
| `save_dir` | string | `generate/images` | 相对当前工作目录 |
| `filename_hint` | string | 从 prompt 提取 | 文件名提示 |

## 0.3.0 新增

| 变更 | 说明 |
|---|---|
| `prompts` 多提示词 | 「同一句话出四种方向」「一条调用填满整块版面」不用再连调四次工具；结果顺序与提示词顺序一致 |
| JSON sidecar | 每张图旁边一份 `<同名>.json`：prompt / 模型 / 比例 / 档位 / 画质 / 参考图 / 宽高 / 字节数 / 插件版本 |
| `index.jsonl` 账本 | `save_dir` 里一行一张图。想知道「上次那张是什么 prompt 出来的」，读它 |
| 单张失败重试 | 拿图（下载/解码）失败会等 800ms 再试一次，不整单作废 |
| 并发闸 | 进程内最多 2 个在途生成请求（`config.concurrency` 可调），多会话同时出图排队 |
| 防覆盖 | 同秒同名不再互相吃掉：进程内占位 + `-2`/`-3` 后缀 |
| 图片卡 | 超过 6 张可「展开全部」；大图支持 `←`/`→` 翻页、显示页码与这张的 prompt |
| 测试 | `node test/offline.mjs`：桩掉 fetch，验证多提示词、防覆盖、元数据、重试，不花钱 |

## 0.4.0 新增

| 变更 | 说明 |
|---|---|
| 会话附件 | 生成完顺手调用 `ctx.attachments.saveImage()`，把字节再存一份进 DSH 附件存储，拿到持久引用 `{ attachmentId, mediaType, bytes, width, height }` |
| 走官方鉴权 loader | 卡片的 `<img>` 不再拼 `/api/file?path=`，而是用 toolview owner 给的 `loadImage(ref)`（Gateway 鉴权、带 `peek` 同步缓存）——**桌面端也能看图** |
| 图不再依赖工作区 | 工作区文件被删/挪，会话里的图还在；卡片头上有「会话附件」徽标 |
| 向后兼容 | 没有附件的老结果 → 照旧退回 `/api/file`；连 `meta` 都没有的更老结果 → 解析 Markdown 图片 |
| 优雅降级 | 附件服务缺席（自定义组合没挂 `attachment-local`）或准入被拒（超限/格式不支持）时只跳过附件，出图不受影响 |

> 2026-11-16 起，主机侧已按 `dsh-bili-scroll` 的现成范式实现入库：`ctx.get('attachments').saveImages([{ data, mediaType, name }])`。
> 与 bili 唯一的差别：图片不塞成 image block 进结果内容，仍走 `presentationMeta`，所以**模型上下文零开销**，也不需要探 `inputModalities`。
> 0.4.1 修掉了 0.4.0 里「看着有、其实没入库」的问题：之前用 `ctx.attachments.saveImage()`（单数），这版宿主上取不到；现在与 bili 一致走 `ctx.get('attachments')` + `saveImages()`。准入没成功的真实原因会写进结果（`附件：未入库（xxx）`），不再静默。

## 模型与格式

| 模型 | 尺寸档 | 用途 |
|---|---|---|
| `gpt-image-2.6-exact` | 1k / 2k / 4k | 主力，高清档唯一选择 |
| `gpt-image-2.6` | 1k | 基础款 |
| `gpt-image-2.6-media` | 1k | **GIF / SVG 必须走它** |
| `gpt-image-2.6-flare` / `-sunburst` | 1k | 风格化 |

- 格式：`png` / `jpeg` / `webp` / `gif`（约 410px 循环动图，9 帧上下）/ `svg`（需上游能生成原生矢量）
- 尺寸：1K 是网页端原生分辨率（1:1 约 1254²，16:9 约 1672×941）；2K/4K 只是整数倍放大
- 计费：约 0.009 credits/张，1k/2k/4k 同价

## 安装

装进任意 DSH profile 的 `dsh.profile.bundles` 即可，细节和排错见 [`INSTALL.md`](INSTALL.md)。

**A. 直接从这里装（推荐）**

```bash
# profile 名常见是 desktop / web
dsh plugin --profile desktop add github:JAYcodr/dsh-aipais-image
```

再把 `"dsh-aipais-image"` 加进 `~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles`，
然后在 profile 目录 `pnpm install`，重启 DSH。

> 也可以把 [Releases](https://github.com/JAYcodr/dsh-aipais-image/releases) 里的
> `dsh-aipais-image-x.y.z.zip` 解压到任意位置，用 `link:<绝对路径>` 挂进去。

**B. 让 agent 装**

把 zip 丢给 agent，说一句：

> 用 plugin_manager 的 install_bundle 装这个本地目录：`/path/to/dsh-aipais-image`

这条路会同时写好依赖和 `dsh.profile.bundles`，装完即可用。

**C. 手动**

```json
{
  "dependencies": { "dsh-aipais-image": "github:JAYcodr/dsh-aipais-image" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-aipais-image" ] } }
}
```

装好后 entry id 为 `include:aipais-image`（配置行 id 是 `aipais-image`）；工具名 `generate_image` / `image_gen_info`。
改了 `lib/client.js` 这类客户端代码后，要重启插件 entry（或整个 DSH）再刷新页面才会生效。

## API key

按顺序找：插件 `config.apiKey` → 环境变量 `AIPAIS_KEY` → `~/.aipais.env` → `<当前工作目录>/.aipais.env`。
env 文件格式：`export AIPAIS_KEY=sk-...`。

## 会话内联图片卡（v0.2.0）

`generate_image` 的结果不再只是一坨文本：工具行会渲染成**内联图片卡**（缩略图网格 + 点击看大图 + 下载 + 点路径在侧栏打开）。

实现分两块，都不碰内置包：

| 半边 | 文件 | 做什么 |
|---|---|---|
| 宿主 | [`index.js`](index.js) `output.presentationMeta` | 把 `files[]` 投影成 `{ images: [{ path, absolute_path, width, height, bytes, prompt }] }` 写进 `tools/result.meta`。**只给界面看，不进模型上下文**，不额外烧 token |
| 浏览器 | [`lib/client.js`](lib/client.js) | 手写客户端 bundle（`window.__ModuleLoader__.load`），注册 `tool.call.toolview` 的 `generate_image` 视图 |

图片地址有三条路，按优先级：

1. **会话附件**（0.4.0）：`meta.images[].attachment` 有引用 → 用 owner 的 `loadImage(attachment)`（先试 `peek()` 同步缓存），Gateway 鉴权、桌面端也支持；
2. **工作区文件**：没有附件但有路径 → `GET /api/file?path=<绝对路径>`（仅 http(s) 页面）；
3. **纯文本 Markdown**：连 `meta` 都没有的更老会话 → 解析结果文本里的 `![alt](<路径>)`。

超时/失败都会降级成「无法预览：路径」，不会白屏。

要求：

- 改了 `lib/client.js` 之后要重启/重载插件 entry 并刷新页面，客户端模块图才会换到新 bundle。
- 附件那条路要求 profile 里挂着 `@deepseek-ai/dsh-attachment-local`（随附 base 组合自带）；没有时自动退回第 2 条。

## 用法建议（写给 agent）

- 「做几张有趣的图看看」这类请求：**直接想点子 → 调 `generate_image`（`prompts` 一次给几条不同方向）→ 把返回的 markdown 贴进回复**。
- 要「同一句话，四种风格」：一条调用写四段 prompt 丢进 `prompts`，比四次调用快，也只出一张卡片。
- 用户问「上次那张是什么 prompt」：读 `save_dir/index.jsonl`，或看图片旁边的同名 `.json`。不要逐张 `read_image` 复核，image2.6 很稳，复核只是浪费时间和 token。
- 只有用户明确要检查、或工具报失败时，才读图 / 重试。
- 需要角色一致：先用一张定稿当 `reference_images`，再批量出差分。
- 一次调用里混风格（摄影 / 浮世绘 / 动画 / 海报）比一个风格出十张更有意思。

## 排错

| 现象 | 处理 |
|---|---|
| `没有找到 aipais API key` | 检查上面四个位置 |
| GIF 出来是静图 | 确认没手动指定非 `-media` 模型；本工具会自动切 |
| SVG 失败 | 上游不一定支持原生矢量，改用 PNG/WebP |
| 图片拿到了但下载失败 | 已在优先 `b64_json`，并自动重试一次；还失败就重新生成 |
| 两张图名字撞了 / 后一张吃掉前一张 | 0.3.0 已修：同秒同名会加 `-2`/`-3` 后缀；还看到就检查是不是装了旧版 |
| 上游偶发 502 / 直链被墙 | 工具自带重试；持续失败就重新生成（别复用坏链接） |
| 工具行还是纯文本、没有缩略图 | ① 刷新页面（`Cmd+R`）；② 设置 → 插件里确认 `aipais-image` 是启用状态；③ 刚升级到 0.4.0 的话要重启插件 entry（客户端 bundle 换了） |
| 桌面端图片显示「无法预览」 | 0.4.0 起新生成的图走会话附件，桌面端也能看；老会话/老结果仍走 `/api/file`，那条路只有 http(s) 页面支持 |
| 卡片上没有「会话附件」徽标 | 说明附件准入没成功：检查 profile 里有没有 `@deepseek-ai/dsh-attachment-local`，或看后端日志里的拒绝原因（超限/格式） |

## 开发自检

```bash
node selftest.mjs          # 查信息 + 生成 1 张最小图（约 0.009 credits）
node selftest.mjs --info   # 只查信息，不花钱
node selftest.mjs --multi  # 2 条不同提示词，验证多提示词链路（约 0.018 credits）
node test/offline.mjs      # 离线测试：桩掉 fetch，不花钱、不联网
node test/host-smoke.mjs   # 宿主侧冒烟：假 ctx + 真 API，验证附件引用进 meta（约 0.009 credits）
```
