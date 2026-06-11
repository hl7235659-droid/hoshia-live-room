# Hoshia Live Room Codex 前置规则

本文件用于指导 Codex 在本项目内协作、开发、提交和总结。优先遵守用户当前指令；如果当前指令没有覆盖，以本文件为默认规则。

## 项目基本信息

- 项目名称：Hoshia Live Room
- 本地目录：`E:\ai私密直播间`
- GitHub：`hl7235659-droid/hoshia-live-room`
- 当前工作分支：`codex/room-account-live2d-cleanup`
- 服务器部署目录：`/home/ubuntu/staging/live-room-dev`
- 服务器 SSH Host 别名：优先 `openclaw`；如果内网别名超时，使用本机 SSH 配置里的 `live-room-staging` 回退别名（不要在仓库中记录 HostName、User、IdentityFile、IP 或私钥路径）

## 开发前规则

- 修改前先看 `git status --short --branch`，确认当前变更范围。
- 如果工作区已有用户或其他任务的改动，不要回滚、覆盖或误提交。
- 不要提交 `.env`、数据库、`node_modules`、`dist`、日志、缓存、密钥、token、证书。
- 优先小范围修改，不做无关重构。
- 中文文案统一保存为 UTF-8，避免乱码扩散。

## 模块化更新要求

更新音乐、新闻、礼物、Live2D、TTS、小游戏等功能模块时，优先接入现有模块化机制。

要求：

- 模块状态通过 `module_context` 提供给 Hoshia 理解。
- 用户行为通过 `module_events` 做归因。
- 需要进入记忆提纯的行为通过 `module_memory_events` 处理。
- 新模块优先实现 provider 形式的能力上下文，不要为了单个模块反复修改 Hoshia 主人格 prompt。
- 不要保存原始流水记录，记忆里只保留提纯后的偏好、习惯或近期状态。
- 模块事件里的 `data` 必须使用短文本白名单字段，不允许塞路径、token、密钥、内部地址、原始日志或隐私数据。
- 新模块的 Release 说明要用外行能理解的话说明：这个模块让用户体验有什么变化。

## 记忆与隐私规则

- Hoshia 可以知道直播间公开状态、模块能力、当前播放/队列、观众公开配置、在线状态和用户允许记忆的偏好。
- Hoshia 不应该看到或透露 `.env`、token、密钥、服务器 IP、SSH 信息、本地绝对路径、数据库文件路径、cloudflared 隧道细节。
- 用户行为进入记忆前必须提纯，不保存完整点歌、礼物、互动或聊天流水。
- 单次行为通常只作为短期信号；多次稳定倾向或用户明确说“喜欢/记住”时，才写入偏好或近期状态。

## 测试要求

修改完成后默认运行：

- gateway：`npm test`
- frontend：`npm run build`

如果修改了 AstrBot bridge，还要运行：

- `python -m compileall astrbot_plugin_live_room_bridge`

如果某项没有运行，最终总结必须说明原因。

## Git 与提交

- commit message 要清晰，说明本次实际改变，例如 `update: refine module event lifecycle`。
- push 到当前 GitHub 分支：`codex/room-account-live2d-cleanup`。
- 提交前再次检查 `git status`，确认没有误提交敏感文件、构建产物、数据库或无关改动。

## 部署规则

部署服务器时必须安全可回滚：

- 先备份 `/home/ubuntu/staging/live-room-dev` 到 `/home/ubuntu/backups/` 下的新目录。
- 保留服务器 `.env`。
- 保留 `gateway/data` 数据库目录。
- 保留服务器 `docker-compose.yml` 里的 cloudflared tunnel 配置。
- 再同步新代码。
- 执行：
  - `sudo docker compose build live-room-gateway live-room-web`
  - `sudo docker compose up -d live-room-redis live-room-gateway live-room-web live-room-tunnel`

部署后验证：

- `sudo docker compose ps`
- `curl http://127.0.0.1:18888/live/healthz`
- 当前公网健康检查以实际可用域名为准；如果临时 trycloudflare 地址 DNS 失效，要明确说明。

## Release 说明

每次成功 push 到 GitHub 后，必须写一份外行也能看懂的中文 Release 说明。

Release 说明的重点是：这次更新了什么。

要求：

- 用中文。
- 面向不了解代码的人。
- 不堆技术术语。
- 重点说明新增、修复、调整、优化了哪些东西。
- 尽量用用户能理解的变化来描述。
- 如果是内部改动，也要说明它让系统在哪方面更稳定、更安全、更容易维护。
- 不要只写 `fix bug`、`update code`、`refactor`、`optimize`。

推荐格式：

```md
## Release 说明

这次更新了：

1. xxx
2. xxx
3. xxx

简单来说：
- xxx
- xxx

测试情况：
- 前端构建：通过 / 未通过
- 网关测试：通过 / 未通过
- 部署验证：通过 / 未部署
```

## 最终总结格式

任务完成后，总结至少包含：

- 改了什么
- 测试是否通过
- GitHub 是否 push 成功
- 服务器是否部署成功
- 备份目录是什么
- 是否发现敏感信息
- Release 说明：必须说明这次更新了什么，并且外行能看懂
- 模块接入：新增或调整模块时，优先走现有模块化机制，不要写成一次性特例
