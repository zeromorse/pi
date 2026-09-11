---
name: blog-sync-local
description: 将远程博文/网页文章同步到本地保存为 Markdown，英文文章自动转为英中对照格式（英文原文 + 中文翻译逐段对照）。当用户说"把这篇文章存到本地"、"同步博文到本地"、"翻译这篇文章"、"转为英中对照"、"保存这个链接的文章"、"文章转 markdown 存档"或发来一个博客/文章 URL 要求保存时激活。保留原文图片（下载到本地）、超链接、代码块，并通过 markdownlint 校验。
---

# 博文同步本地（英中对照）

把远程博客文章抓取、翻译、保存为本地 Markdown 文档，英文文章采用英中对照格式。本 skill 的流程已在 claude.com/blog 文章上完整验证过，可推广到大部分静态渲染的博客页面（Webflow、Ghost、Hugo、GitHub Pages 等）。

## 适用判断

- 目标是**内容存档 + 阅读**（Markdown 文档），不是网页截图或 HTML 转存
- 文章页面正文嵌在 HTML 中（非 JS 动态拉取的 SPA）——先用 curl 抓下来看一眼再判断
- 英文文章 → 英中对照；中文文章 → 仅同步不翻译

## 执行流程

### 1. 抓取页面

```bash
curl -sL "<URL>" -o /tmp/<slug>.html && wc -c /tmp/<slug>.html
```

- 若文件很小（<10KB）或正文关键词搜不到，说明是 JS 动态渲染，改用浏览器类 skill（tabbit/catdesk-browser）获取渲染后 HTML。
- 剥离 `<script>` / `<style>` 后提取正文。

### 2. 提取正文结构

用 Python 一次性提取（脚本要点，不要照抄 URL）：

1. `re.sub(r'<(script|style)[^>]*>.*?</\1>', '', raw, flags=re.S)` 剥离脚本样式
2. 提取标题层级 `<(h1|h2|h3|h4)>` 先看全文骨架，确认正文边界（从 `<h1` 到相关文章/页脚之前）
3. 逐块转换时**必须处理 img 的两种属性顺序**（src 在前/alt 在前）和 `<a href>`：
   - `<img ... src="X" ... alt="T">` → `![T](X)`；无 alt 用简短中文描述（lint MD045 要求 alt）
   - `<a ... href="X">TEXT</a>` → `[TEXT](X)`
4. 块级标签（h1-h4/p/li/pre/blockquote/tr）替换为带标记的换行（如 `@@h2@@`），再整体剥标签，`html.unescape` 还原实体
5. **注意被压平的块**：表格行 `<tr>`、对比卡片、"Traditional / AI-native / Getting started"这类小部件会被压成一行长文本，需要按语义人工拆开重组，不能直接照抄提取结果
6. 页面装饰性图片（placeholder.svg、图标、头像）直接丢弃，只保留正文插图

### 3. 下载图片到本地

```bash
mkdir -p /tmp/blog-imgs && cd /tmp/blog-imgs && curl -sO "<img-url>"
file *.png   # 验证是真图片、看尺寸
```

- 存放位置遵循所在工作区规范（catpaw-desk-workspace 任务区：`document/.pic/YYYY/MM/DD/`）
- **重命名为语义化文件名**（如 `sdlc-loop.png`），不要保留 CDN 哈希名
- 文档内引用**相对路径**，保证本地离线可读

### 4. 确定保存位置与文件名

- catpaw-desk-workspace：知识文档放 `document/<中文标题>.md`
- 其他仓库：询问用户或按该仓库文档目录惯例
- frontmatter 必须包含（工作区 lint 要求）：

```yaml
---
created: YYYY/MM/DD
updated: YYYY/MM/DD
ai_generated: true
source: <原文 URL>
format: 英中对照（英文原文 + 中文翻译）   # 仅英文文章需要
---
```

### 5. 翻译与对照格式（核心）

翻译要求：准确、流畅、符合中文技术文档习惯；专有名词保留英文（CLAUDE.md、hook、skill、PR、worktree 等）；首译出现的关键术语可在括号内附英文。

**格式约定（已验证通过 markdownlint）：**

| 元素 | 格式 |
| --- | --- |
| 段落 | 英文原文一行，紧跟中文翻译一行，两行相邻，块间空行 |
| 标题 | `## 中文标题（English Title）` |
| 无序列表项 | `* English text` + 下一行 2 空格缩进的中文（渲染为同项内对照） |
| 有序列表项 | 同上，`1. English` + 缩进中文 |
| 表格 | 单元格内 `English<br>中文`（若目标 lint 开启 MD033 则改用两个并行表格或仅中文+脚注） |
| 代码块 | 保留英文原样不翻译，fenced 且必须声明语言（MD040） |
| 图片 | `![中文 alt 描述](相对路径)`（MD045） |
| 链接 | 保留原文 URL，链接文本可中文化；禁止裸链接（MD034），文档内提到域名时用 `[](...)` 包裹 |
| 参考资源列表 | `[英文标题](url)<br>中文说明` 逐条对照 |

对照格式示例：

```markdown
Organizations have started using AI to write code at a speed unthinkable one year ago, yet the processes around the code haven't changed at the same pace.
组织已经开始使用 AI 以前所未有的速度编写代码，但围绕代码的流程却未能以同样的速度改变。
```

### 6. 长文分节写入

- 单次输出放不下整篇时，先 `write` 写头部+第一节，然后用 `bash` quoted heredoc（`cat >> file <<'EOF'`）分节追加，每节一个追加调用
- quoted heredoc 可安全包含反引号、`$`、代码块
- 每节内容务必与原文逐段核对，防止漏段（尤其列表项和表格行）

### 7. 校验收尾

```bash
# markdownlint（工作区有配置时用工作区配置）
npx markdownlint-cli2 --config .markdownlint-cli2.jsonc "document/<文件>.md"

# 图片引用完整性
grep -o '\.pic/[^)]*' <文件>.md | while read p; do [ -f "$p" ] || echo "MISSING $p"; done
```

常见 lint 雷区：MD040（代码块缺语言）、MD045（图片缺 alt）、MD034（裸链接）、MD009（行尾空格）、MD012（连续空行）、MD026（标题末尾标点）、MD041（一级标题必须在 frontmatter 后首行）。

最后向用户报告：文件路径、图片位置、lint 结果。
