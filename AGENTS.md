# Hoshia Live Room Codex 接手说明

本文件是给后续 Codex 会话使用的项目规则和当前基线说明。优先遵守用户当前指令；当前指令没有覆盖时，以本文件为默认规则。

## 当前基线

- 项目名称：Hoshia Live Room
- GitHub 仓库：`hl7235659-droid/hoshia-live-room`
- 当前工作分支：`codex/room-account-live2d-cleanup`
- 当前 3.0 起点提交：`39fe6ea1e0eea672d6274cc0641dbed552952939`
- staging 部署目录：`/home/ubuntu/staging/live-room-dev`
- staging SSH Host：优先 `openclaw`；如果不可用，使用 `live-room-staging`
- 当前 staging 部署已更新到上述提交，并写入服务器 `REVISION`
- 最近一次服务器备份目录：`/home/ubuntu/backups/live-room-dev-20260612-011216`
- 更详细的 3.0 功能与实现总览见 [docs/3.0-baseline.md](docs/3.0-baseline.md)

本阶段已经完成的质量基线：

- GitHub Actions CI 已接入并通过。
- CodeQL 已接入并通过。
- frontend 已有 `npm run typecheck`。
- gateway `server.js` 已拆出 WebSocket helper 和 account routes。
- frontend `main.tsx` 已拆出 account、music、timeline 相关组件。
- Live2D audit 已通过 npm override 收口，`pixi-live2d-display@0.4.0` 下的 `gh-pages` 解析到 `6.3.0`。
- `npm audit --registry=https://registry.npmjs.org --audit-level=moderate` 当前为 0 vulnerabilities。
- 当前 Live2D 默认仍走 PNG fallback；真实 Live2D 模型通过环境变量配置。

## 开发前规则

- 修改前先运行 `git status --short --branch`，确认当前变更范围。
- 如果工作区已有用户或其他任务的改动，不要回滚、覆盖或误提交。
- 默认小步修改，保持行为不变或可回退；不要做一次性大重构。
- 不要提交 `.env`、数据库、`node_modules`、`dist`、日志、缓存、密钥、token、证书、服务器地址、SSH 信息、cloudflared tunnel URL。
- 中文文案统一保存为 UTF-8。发现乱码时优先补测试或断言，避免乱码再次扩散。
- `AGENTS.md` 是项目接手规则文件，可以提交；但不要把敏感信息写进来。

## 模块化更新规则

更新音乐、新闻、礼物、Live2D、TTS、小游戏等功能模块时，优先接入现有模块化机制。

- 模块状态通过 `module_context` 提供给 Hoshia 理解。
- 用户行为通过 `module_events` 做归因。
- 需要进入记忆提纯的行为通过 `module_memory_events` 处理。
- 新模块优先实现 provider 形式的能力上下文。
- 不要为了单个模块反复修改 Hoshia 主人格 prompt。
- 不要保存原始流水记录；记忆里只保留提纯后的偏好、习惯或近期状态。
- 模块事件里的 `data` 必须使用短文本白名单字段，不允许塞路径、token、密钥、内部地址、原始日志或隐私数据。
- 新模块的 Release 说明要用外行能理解的话说明：这个模块让用户体验有什么变化。

## 记忆与隐私规则

- Hoshia 可以知道直播间公开状态、模块能力、当前播放/队列、观众公开配置、在线状态和用户允许记忆的偏好。
- Hoshia 不应该看到或透露 `.env`、token、密钥、服务器 IP、SSH 信息、本地绝对路径、数据库文件路径、cloudflared 隧道细节。
- 用户行为进入记忆前必须提纯，不保存完整点歌、礼物、互动或聊天流水。
- 单次行为通常只作为短期信号；多次稳定倾向或用户明确说“喜欢”“记住”时，才写入偏好或近期状态。

## 测试要求

修改完成后默认运行：

```bash
cd gateway && npm test
cd frontend && npm run typecheck
cd frontend && npm run build
python -m compileall astrbot_plugin_live_room_bridge
git diff --check
```

如果只修改文档，可以只运行：

```bash
git diff --check
```

如果修改了依赖，还要运行：

```bash
cd frontend && npm audit --registry=https://registry.npmjs.org --audit-level=moderate
```

如果某项没有运行，最终总结必须说明原因。

## Git 与提交

- commit message 要清晰，说明本次实际改变。
- push 到当前 GitHub 分支：`codex/room-account-live2d-cleanup`。
- 提交前再次检查 `git status --short --branch`，确认没有误提交敏感文件、构建产物、数据库或无关改动。
- 成功 stage、commit、push 后，最终回复需要包含对应状态。

## 部署规则

部署 staging 时必须安全可回滚：

- 先备份 `/home/ubuntu/staging/live-room-dev` 到 `/home/ubuntu/backups/` 下的新目录。
- 保留服务器 `.env`。
- 保留 `gateway/data` 数据库目录。
- 保留服务器 `docker-compose.yml` 里的 cloudflared tunnel 配置。
- 同步代码时不要覆盖服务器专属配置。
- 同步后写入当前 commit 到服务器运行目录的 `REVISION`。
- 再执行：

```bash
sudo docker compose build live-room-gateway live-room-web
sudo docker compose up -d live-room-redis live-room-gateway live-room-web live-room-tunnel
```

部署后验证：

```bash
sudo docker compose ps
curl http://127.0.0.1:18888/live/healthz
```

如果 `live-room-tunnel` 不在服务器 compose 中，记录实际情况，不要强行改 compose。公网健康检查以实际可用域名为准；不要把 tunnel URL 写进仓库或总结。

## 3.0 后续方向

当前分支可以作为 3.0 的起点。后续建议：

- 在现有模块化机制上继续加功能，不回到大文件堆逻辑。
- `/api/hoshia/*` 仍然耦合定时器、模块事件、视觉状态和广播副作用；后续如果继续拆，要分批做纯抽取。
- Live2D 当前以 PNG fallback 为稳定基线；接真实模型前必须验证 `/live/?demo=stage` 和普通 `/live/`。
- 更重的质量工具可以后续再接，例如 ESLint、SonarCloud/SonarQube、依赖安全例外策略。
- 部署和产品功能更新分开提交，避免一次提交混入太多风险。

## Release 说明要求

每次成功 push 到 GitHub 后，必须写一份外行也能看懂的中文 Release 说明。

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
