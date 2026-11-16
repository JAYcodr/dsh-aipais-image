# dsh-aipais-image 安装说明（v0.2.0）

给另一台机器用的一页纸。插件本体在 `dsh-aipais-image/`，装进任意一个 DSH profile 即可。

## 0. 前提

| 项 | 要求 |
|---|---|
| DSH | **0.2.x**（桌面版或 `dsh web`）。工具本体在 0.1.x 也能跑，但**会话内联图片卡需要 0.2.x 的客户端模块系统** |
| Node | ≥ 22（用 DSH 自带的运行时即可，不必自己装） |
| key | aipais.de 的 API key（`sk-...`） |

## 1. 拿代码（二选一）

```bash
# 1a. 直接装，不用解压 —— 跳到第 2 步的「D. 从 GitHub」
git clone https://github.com/JAYcodr/dsh-aipais-image ~/dsh-plugins/dsh-aipais-image

# 1b. 下载 Releases 里的 zip
mkdir -p ~/dsh-plugins
curl -L -o /tmp/dsh-aipais-image.zip \
  https://github.com/JAYcodr/dsh-aipais-image/releases/latest/download/dsh-aipais-image-0.2.0.zip
unzip /tmp/dsh-aipais-image.zip -d ~/dsh-plugins
# → ~/dsh-plugins/dsh-aipais-image/{index.js, lib/, package.json, cordis.patch.yml, README.md, selftest.mjs}
```

## 2. 装进 profile（四选一）

### D. 从 GitHub 直接装（最省事）

```bash
dsh plugin --profile desktop add github:JAYcodr/dsh-aipais-image
```

照样得把 `"dsh-aipais-image"` 补进 `dsh.profile.bundles`，再 `pnpm install`，重启 DSH。

profile 目录默认在 `~/.dsh/profiles/<名字>/`，名字常见是 `desktop` 或 `web`（看你用哪个入口）。

### A. 让 agent 装（推荐）

把 zip 解压后，对 agent 说：

> 用 plugin_manager 的 install_bundle 把这个本地目录装进来：
> `/Users/you/dsh-plugins/dsh-aipais-image`

这条路会同时写好依赖和 `dsh.profile.bundles`，装完即可用。

### B. CLI

`dsh plugin` 只是把参数转发给 profile 里的 pnpm，所以用 `add`（不是 `install`）：

```bash
dsh plugin --profile desktop add "link:/Users/you/dsh-plugins/dsh-aipais-image"
```

`link:` 后面必须是**绝对路径**（`~` 不会展开）。
装完还要手动补一步（CLI 不知道它是个 bundle）：编辑 `~/.dsh/profiles/desktop/package.json`，把包名加进 `dsh.profile.bundles`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "...", "dsh-aipais-image"] } }
}
```

### C. 全手动

`~/.dsh/profiles/<profile>/package.json` 同时改两处：

```json
{
  "dependencies": { "dsh-aipais-image": "link:/Users/you/dsh-plugins/dsh-aipais-image" },
  "dsh": { "profile": { "bundles": ["...", "dsh-aipais-image"] } }
}
```

然后在 profile 目录装依赖（用 DSH 自带 pnpm）：

```bash
cd ~/.dsh/profiles/desktop
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/node/bin/node" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install
```

## 3. 配 API key

```bash
printf 'export AIPAIS_KEY=sk-你的key\n' > ~/.aipais.env
chmod 600 ~/.aipais.env
```

查找顺序：插件 `config.apiKey` → 环境变量 `AIPAIS_KEY` → `~/.aipais.env` → `<当前工作目录>/.aipais.env`。

## 4. 生效

- **工具**：装完即注册。新会话直接能用；当前会话如果没看到，重开一个会话。
- **内联图片卡**：客户端 bundle 由宿主在页面启动时下发，所以**重启 DSH 或刷新页面（⌘R）**才会出现。只改插件代码不重启，卡片还是旧的。
- 改了 `lib/client.js` 之后：设置 → 插件里把它关掉再打开（重启 entry），然后刷新页面。

## 5. 验证（先免费，再花 1 厘）

1. 让 agent 调 `image_gen_info` —— 免费，能返回余额 + 模型清单，说明 key 通了、插件活了。
2. 让 agent 调 `generate_image` 出一张最小图（约 0.009 credits）—— 工具行应该出现缩略图卡片。
3. 卡片交互：点缩略图开灯箱（Esc 关、可下载）、点路径在右侧栏打开。

命令行自检（不经过 agent，直接验 key 和上游）：

```bash
cd ~/dsh-plugins/dsh-aipais-image
node selftest.mjs --info    # 只查信息，不花钱
node selftest.mjs           # 真生成 1 张，约 0.009 credits
```

## 6. 排错

| 现象 | 处理 |
|---|---|
| 工具列表里没有 `generate_image` | profile 的 `dsh.profile.bundles` 没加；或依赖没装上（`dsh plugin --profile <p> why dsh-aipais-image`）；改完重启 DSH |
| 工具能出图，但工具行只有纯文本 | 刷新页面；确认 DSH 是 0.2.x；确认在 http(s) 页面里看（桌面内嵌 `dsh-app:` 页不支持本地图片路由，卡片会显示"无法预览"） |
| 卡片里显示"无法预览：…" | 图片文件被移走/删了，或路径变了；重新生成即可 |
| `没有找到 aipais API key` | 看第 3 步四个位置 |
| GIF 是静图 | 走的是 `-media` 模型才对；检查是否手动指定了别的 model |
| 上游 502/429 | 工具自带指数退避重试；持续失败就重新生成 |

## 7. 卸载

- GUI：设置 → 插件，关掉/移除即可；
- 或手动：从 `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里删掉 `dsh-aipais-image`，再 `pnpm install`，重启 DSH。

## 8. 包里有什么

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主：注册 `generate_image` / `image_gen_info`，`output.presentationMeta` 产出给 UI 的图片元数据 |
| `lib/core.js` | aipais 中转调用、重试、落盘、格式嗅探（无 DSH 依赖，可单独跑） |
| `lib/client.js` | 浏览器：`tool.call.toolview` 的内联图片卡（缩略图网格 + 灯箱） |
| `cordis.patch.yml` | bundle 补丁：往配置树插一行 `id: aipais-image` |
| `package.json` | 包名、`dsh.bundle` / `dsh.client` 声明、`./client` 导出 |
| `selftest.mjs` | 不经 agent 的自检脚本 |
