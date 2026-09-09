# sp

保存并推送:stage 变更,用 pi(default-flash 模型)生成 commit message,提交并推送到远程。

## 流程

```
stage → 展示清单 → pi 生成 message → 确认 → commit → push
```

- message 由 pi 以 `-p` 非交互模式生成,模型取 `~/.pi/agent/settings.json` 的
  `defaultFlashProvider` + `defaultFlashModel`(当前为 `glm-5.3-flash`);
  生成时加载目标仓库的 AGENTS.md 等上下文,commit 规范自动遵循近期提交风格。
- 生成调用带 `--no-tools --no-skills --no-session --thinking off`,
  纯文本快进快出,不落 session 文件。**不传 `--no-extensions`**:
  mcli 等自定义 provider 依赖扩展注入兼容 header(如 mcli-compat 给
  system prompt 加 Claude Code marker),禁用扩展会被服务端 400 拒绝。

## 用法

```bash
sp [选项] [路径...]
```

- 无路径参数:stage 全部变更(修改/删除/未跟踪文件)。
- 指定路径:只 stage 那些路径(支持 git add 路径语法)。
- 无可提交内容但领先远程时,直接 push。

| 选项 | 说明 |
|---|---|
| `-y, --yes` | 全自动,不询问 |
| `-m, --message MSG` | 不用 AI,直接用指定 message |
| `--model SPEC` | 覆盖生成模型,`provider/model` 或 `model` |
| `--dry-run` | stage 并生成 message,但不 commit/push |
| `-h, --help` | 帮助 |

交互确认:`Enter` 提交推送 / `e` 用 git 编辑器改 message / `n` 中止(变更保持 staged)。

## 行为细节

- diff 超过 `SP_DIFF_LIMIT`(默认 65536 字符)时截断后送给模型,文件清单
  (`--stat`)始终全量。
- pi 调用失败(如 provider 认证过期)时:交互模式提示手动输入 message,
  `-y` 模式直接失败退出。
- pre-commit 拦截 lockfile 提交(`PI_ALLOW_LOCKFILE_CHANGE`)时:交互模式询问
  是否带该变量重试,`-y` 模式不自动绕过,直接失败提示。
- 分支无 upstream 时询问是否 `git push -u origin HEAD`(`-y` 自动执行)。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BIN` | PATH 中的 `pi` | pi 可执行文件 |
| `SP_DIFF_LIMIT` | `65536` | 送给模型的 diff 最大字符数 |

## 安装

```bash
ln -sf "$(pwd)/local/sp/sp" ~/.local/bin/sp
```
