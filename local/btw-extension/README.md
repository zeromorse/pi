# btw-extension

`/btw` 侧问扩展:agent 忙碌时问一个一次性侧问题,回答经独立 LLM 调用立即流式返回,不打断 agent、不进会话历史;空闲时消息作为正常 prompt 发送。

## 为什么是 extension

最初 `/btw` 直接改在 `packages/coding-agent/src` 的三个 upstream 热点文件里(`agent-session.ts`、`interactive-mode.ts`、`slash-commands.ts`),pi-sync 每天 merge upstream main 时反复冲突(如 #9548 mid-conversation system messages 撞 import 块)。改为 extension 后 fork 不再修改这些 core 文件,该类冲突根除。

## 部署

```bash
ln -s /Users/duanyanlong/agent/pi/local/btw-extension/btw.ts ~/.pi/agent/extensions/btw.ts
```

pi 的 extension loader 明确支持符号链接目录项,imports(`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`)由 pi 自身的 jiti alias 解析,与文件实际位置无关。

## 实现要点

- `pi.registerCommand("btw")`:`/btw` slash 命令(带补全);空闲时 `pi.sendUserMessage` 正常发送,忙碌时跑侧问。
- `pi.on("input")`:拦截无斜杠 `btw <message>` 形式;`event.streamingBehavior` 区分空闲(transform 剥前缀)与忙碌(handled + 侧问);`source !== "interactive"` 的输入(扩展注入/RPC)不拦截;其他任意输入清除上一次回答的 widget。
- 侧问调用:`ctx.modelRegistry.streamSimple` + `convertToLlm(buildContextEntries())` 会话快照 + `ctx.getSystemPrompt()` 追加侧问指令;回答经 `ctx.ui.setWidget` 流式渲染(编辑器上方,截取尾部 15 行)。
- 测试:`packages/coding-agent/test/btw-extension.test.ts`(经真实 discovery 加载,覆盖命令注册/前缀矩阵/source 过滤)。

## 修改后

改完 `btw.ts` 后,全局 pi 下次启动或 `/reload` 即生效(jiti 不缓存);如需验证:

```bash
cd packages/coding-agent && node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/btw-extension.test.ts
```
