# Pi Test Desktop MVP 方案

状态：已确认，Phase 1 Chrome 资产产品化和 Android 受控驱动技术切片已完成，Windows Android 真机待验证  
日期：2026-08-11  
目标平台：Windows 10/11 x64  
关联项目：`pi-desktop`、`/Users/m/workSpace/pi-extension`

## 1. 文档用途

本文是下一开发 session 的产品与技术基线。除标记为“待验证”或“待定”的内容外，以下内容均为已确认决策，不应在实现过程中重新扩展范围。

下一 session 开始时应先完成：

1. 阅读本文和 `/Users/m/workSpace/pi-extension/PRODUCT.md`。
2. 检查两个工作区的最新状态，不覆盖用户已有改动。
3. 先完成 Windows 工具链和受控测试工具的技术设计，不先重做全部 UI。
4. 将 `pi-extension` 作为单一 `pi-test` package 纳入本仓库，避免两份领域逻辑长期并存。

本文是产品与技术基线。2026-08-12 已开始实施 Phase 0；Windows 真机验证尚未完成。

## 2. 产品定位

产品定位：

> 一个面向测试新手的专用桌面测试工作台，以 Pi Agent 作为推理能力，以 pi-test 作为测试引擎，测试 H5、管理后台、Android App 和微信小程序。

它不再是通用 Pi Coding Agent 桌面壳。用户不需要理解或操作以下概念：

- `cwd`
- Session JSONL
- YAML
- Skill
- Extension / Plugin
- CLI
- Provider Model ID
- Thinking Level
- Tool Preset
- Git、分支、Worktree

用户看到的核心概念只有：

- 项目
- 对话
- 业务地图
- 测试用例
- 执行记录
- 问题
- 测试环境
- 测试账号
- AI 服务
- 禅道

## 3. 第一版范围

### 3.1 必做

- Windows 10/11 x64。
- 设备在线授权，使用 OSS 上的 Ed25519 签名授权文件。
- 项目创建、打开、归档和项目级对话隔离。
- 一个项目可包含 H5、管理后台、Android App、微信小程序。
- 允许创建入口暂不完整的项目，只执行已就绪的测试端。
- 用户自行提供模型 API Key。
- 中文快捷动作和中文执行状态。
- Web 只操作用户真实 Chrome，驱动为 `agent-browser-cli`。
- App 只操作真实 Android 手机，驱动为私有 ADB 和 Handsets。
- 全应用同一时间只允许一个改变 Chrome 或手机状态的测试执行。
- 支持人工接管、暂停、重新感知和恢复。
- 支持探索业务、测试一个功能、运行回归测试。
- 支持业务地图、用例、执行记录、证据和本地问题。
- 支持 App/H5 与管理后台的跨端验证。
- 支持项目内多个业务身份，秘密使用 Windows OS-backed 加密存储。
- 生产环境只读。
- 支持明显视觉异常检查，项目级授权且默认关闭。
- 本地问题经用户确认后提交到禅道 Bug。
- 安装包、更新清单和授权文件由 OSS 分发。

### 3.2 明确不做

- Electron 内置浏览器。
- 实时浏览器投屏或手机投屏。
- 通用 Bash、任意文件读写编辑、Git 和 Worktree 工具。
- 第三方 Skill/Extension 动态安装或市场。
- 运行时机器翻译任意 Skill/Extension 描述。
- 多项目或多设备并行测试。
- iOS。
- 像素级视觉回归、设计稿比对、多浏览器矩阵。
- PDF/HTML 测试报告导出。
- 多人协作、云同步、网络盘并发写入。
- 禅道测试用例、测试执行和测试报告同步。
- 用 `agent-browser-cli` 操作禅道网页作为 API 兼容方案。
- 完整低代码用例编辑器。
- 账号池、轮询账号、并发账号。
- 生产环境写操作开关。

## 4. 核心用户体验

### 4.1 首屏

应用启动后首先显示最近项目，而不是空白聊天：

```text
最近项目

易点金 · 测试环境
商城 App · 预发布环境

[新建测试项目] [打开已有项目]
```

未授权设备只能进入只读模式、查看设备授权码、重新检查授权、查看已有项目数据和更新应用。

### 4.2 新建项目

新建项目只收集业务信息，不被 AI、Chrome、手机或禅道配置阻塞：

1. 项目名称。
2. 环境：测试、预发布、生产。
3. 测试端：H5、管理后台、Android App、微信小程序。
4. 当前已知的 URL、小程序名称等入口。
5. 项目目录，高级选项才允许修改。

默认项目根目录：

```text
%USERPROFILE%\Pi Test Projects\<project-id>\
```

不要默认使用 OneDrive Documents，也不要把项目业务数据放进应用安装目录。

测试端允许不完整，例如 App 暂时没有 package。状态由统一 readiness 结果推导：

```text
Android App     待连接手机并选择测试 App
管理后台        可以测试
```

### 4.3 项目工作区

项目内固定五个入口：

- 工作台
- 业务地图
- 测试用例
- 执行记录
- 问题

工作台以对话为主。左侧只显示当前项目的对话，不混排其他项目。

项目顶部只显示需要关注的状态：

```text
测试环境    AI 已连接    Web 可测    App 未连接    禅道已连接
```

生产环境标识必须始终明显。

### 4.4 中文快捷动作

输入框上方最多显示四个上下文动作。它们是第一方固定业务动作，不从 Skill 文本动态生成，也不展示内部命令。

新项目：

```text
[探索业务] [测试一个功能] [检查测试环境]
```

已有稳定用例：

```text
[测试一个功能] [运行回归测试] [继续上次测试]
```

测试进行中：

```text
[完成当前步骤后暂停] [截图留证] [记录问题] [结束测试]
```

确定性动作直接走类型化 IPC；需要判断和探索的动作发送一条自然中文任务给 Agent。不要把 `/test`、`/skill:*` 或 CLI 命令填进输入框。

## 5. 项目与记忆边界

### 5.1 三层记忆

| 层级     | 内容                                     | 项目隔离         |
| -------- | ---------------------------------------- | ---------------- |
| 对话记忆 | 当前任务聊天、工具过程、压缩摘要         | 是               |
| 项目记忆 | project、业务地图、cases、runs、findings | 是               |
| 用户配置 | AI Key、工具安装、应用偏好、禅道连接     | 否，按需全局共享 |

不要增加向量数据库。项目资产就是可审计的长期记忆。

新对话只注入轻量项目快照：

- 项目名称和环境。
- 已配置的测试端和 readiness。
- 最近一次执行结果。
- stable case 数量。
- 未关闭 finding 数量。
- 是否存在未结束 run。
- 业务地图和资产位置。

详细内容由受控工具按需读取，不把全部历史会话塞入上下文。

### 5.2 项目目录

```text
<project>/
  project.yaml
  map.md
  cases/
  runs/
  findings/
  .pi-test/
```

应用注册表只保存路径、最后打开时间、归档状态和 UI 偏好。项目业务数据以项目目录为权威来源。

第一版单机、单用户。不同电脑不得同时写入同一个项目目录。

### 5.3 project schema 修订方向

正式发布前继续使用 `schemaVersion: 1`，但一次性修订为桌面产品需要的结构；发布后冻结并通过迁移升级。

示意：

```yaml
schemaVersion: 1
id: ydj
name: 易点金
environment: test # test | staging | production
createdAt: 2026-08-11T08:00:00Z
updatedAt: 2026-08-11T08:00:00Z

surfaces:
  h5:
    url: null
    viewport: "390x844"
  admin:
    url: https://admin.example.com/
    viewport: "1440x900"
  app:
    package: null
    activity: null
    serial: null
  miniprogram:
    name: null
    wechatPackage: com.tencent.mm

identities:
  customer:
    name: 普通用户
    surfaces: [app, h5]
  operator:
    name: 后台操作员
    surfaces: [admin]

defaultIdentityBySurface:
  app: customer
  h5: customer
  admin: operator
```

规则：

- 至少选择一个 surface。
- surface 可以暂时缺少入口。
- `requireSurfaceReady()` 是唯一 readiness 门禁。
- 未就绪 surface 不可执行，其他已就绪 surface 不受影响。
- 项目文件不保存账号密码、API Key、禅道 Token 或设备授权私钥。

## 6. Agent 能力边界

### 6.1 普通测试会话禁止

- 通用 `bash`。
- 任意 `read/write/edit`。
- Git、Worktree 和代码工具。
- Electron Browser tools。
- 用户全局或项目目录中的任意第三方 Pi Extension/Skill。
- 直接执行 `agent-browser-cli.exe`、`hs.exe` 或 `adb.exe`。

专用 runtime 必须使用资源 allowlist，只加载产品内固定、已审核的 pi-test 工具和工作流。现有 `~/.pi/agent` 中的第三方资源不能自动进入测试会话。

### 6.2 受控领域工具

建议的最小工具面：

| 工具           | 作用                                     |
| -------------- | ---------------------------------------- |
| `test_setup`   | 返回结构化环境 readiness 和可执行下一步  |
| `test_run`     | 开始、查看、暂停、继续、结束执行         |
| `test_observe` | 读取当前网页或手机的结构、文本和可选截图 |
| `test_act`     | 打开、点击、填写、等待、滑动、启动 App   |
| `test_shot`    | 截图到当前 run evidence                  |
| `test_map`     | 读取或更新业务地图的指定部分             |
| `test_case`    | 创建、调整、读取、启停和晋级用例         |
| `test_play`    | 重放已有用例                             |
| `test_finding` | 创建问题、更新状态、追加复测             |

`test_act` 第一版不暴露任意 JavaScript、CDP、Shell 或坐标脚本入口。低层驱动能力由受控 adapter 内部调用。

### 6.3 结构化进度

驱动层必须产生结构化进度事件，不依赖 Renderer 解析命令字符串：

```text
opening_page
reading_page
clicking
filling
waiting
capturing_evidence
waiting_for_user
checking_result
```

Renderer 将其翻译成中文业务状态。原始命令和脱敏输出只在“技术详情”中显示。

### 6.4 确定性操作不经过模型

以下操作由 Renderer 通过 Host 直接调用 core：

- 新建、打开、归档项目。
- 修改项目名称和入口。
- 列出用例、执行记录、问题。
- 启用、停用用例。
- 查看证据。
- 保存测试身份凭据。
- 连接禅道。
- 提交已经由用户确认的禅道 Bug。
- 检查授权状态。

模型只参与探索、页面理解、流程决策、生成用例、异常归类、Bug 文案和跨端业务关联。

## 7. 核心架构

### 7.1 单一领域逻辑

将 `/Users/m/workSpace/pi-extension` 纳入本仓库，目标结构：

```text
pi-desktop/
  packages/
    pi-test/
      core/          # project/case/run/finding/evidence/replay domain
      extension/     # Agent tools adapter
      workflows/     # 固定 explore/web/mobile 规则
  src/
    main/            # 授权、测试协调器、驱动、全局锁、禅道、更新
    agent-host/      # 受限 Agent runtime 和 Main RPC client
    renderer/        # 专用测试工作台
```

不要维护两个可编辑副本。迁移完成并验证后，原 `pi-extension` 工作区归档。

### 7.2 权限调用链

```text
Renderer
  -> typed IPC
Main Test Coordinator
  -> online license gate
  -> global execution lease
  -> readiness gate
  -> production/risk gate
  -> pi-test core
  -> browser/mobile/zentao drivers

Agent tool
  -> typed Host RPC
Main Test Coordinator
  -> 同一组门禁和 core/driver
```

Main 是唯一有权执行外部 CLI、写测试资产和写禅道的边界。Renderer 和 Agent Host 都不能绕过 Main。

### 7.3 现有代码可复用点

- 现有 Electron Main / Agent Host / Renderer 三进程隔离。
- 现有类型化 IPC 契约。
- 现有 toolchain 下载、哈希校验、安全解压和私有 runtime 目录。
- 现有 `safeStorage` 加密 vault 模式，但需要扩展 key namespace，不能继续只接受 channel key。
- 现有 session 和项目 `cwd` 关联可作为迁移基础。

## 8. 删除通用桌面能力

专用版本应删除而不是只隐藏：

- Electron `WebContentsView` Browser Dock。
- `browser_*` Agent tools。
- Browser Authorization 对话框。
- Electron Browser Profile、Cookie、下载、代理和标签页恢复。
- Browser 设置页和相关 IPC/测试。
- Git 分支和 Worktree UI。
- Skills/Plugins 管理 UI 和动态安装。
- 微信、Telegram、飞书消息渠道。
- 普通用户可见的模型高级参数、token 和费用细节。

删除 Browser Dock 后，截图和证据作为对话工具结果、执行记录或问题附件展示，不保留永久右侧浏览器面板。

## 9. Web 测试设计

### 9.1 唯一链路

```text
Pi Test Desktop
  -> Main Test Coordinator
  -> agent-browser-cli.exe
  -> Chrome 扩展桥
  -> 用户真实 Chrome/Profile/tab
  -> evidence
```

不允许 Electron Browser 与真实 Chrome 两套链路并存。

### 9.2 固定目录

Windows 工具和扩展使用稳定路径，例如：

```text
%LOCALAPPDATA%\PiTestDesktop\toolchains\...
%LOCALAPPDATA%\PiTestDesktop\chrome-extension\tmwd_cdp_bridge\
```

Chrome 扩展不能放在应用版本安装目录中，否则更新后路径变化会使 Chrome 丢失扩展。

### 9.3 Chrome 扩展首次安装

桌面端自动完成：

1. 准备固定版本 CLI 和扩展目录。
2. 校验扩展文件哈希。
3. 启动 daemon。
4. 复制扩展目录到剪贴板。
5. 打开 `chrome://extensions`。
6. 持续检查扩展连接、版本、Profile 和普通网页 tab。

用户只完成 Chrome 强制的人机步骤：

1. 开启开发者模式。
2. 点击“加载已解压的扩展程序”。
3. 选择桌面端准备好的目录。

成功与否由 `agent-browser-cli status/tabs` 自动判断，不让用户手工声明成功。

`agent-browser-cli v0.3.7` 的 `chrome-extensions.zip` 实际根目录直接包含 `manifest.json`，桌面端必须自行创建 `tmwd_cdp_bridge` 目录再解压，不能依赖文档中“ZIP 自带子目录”的描述。

### 9.4 扩展安全补丁

当前上游扩展 popup 会读取当前站点 Cookie，并自动复制 `name=value` 到剪贴板。第一版必须：

- 固定上游 commit/version。
- 应用最小补丁，删除 Cookie 自动读取、展示和复制。
- 产品不开放 Cookie value 查看能力。
- 受控 Agent 工具不暴露 `cookies` 命令。
- 尽量向上游提交此修复，接受后再减少本地 patch。

当前扩展权限很高，包括 `cookies`、`debugger`、`scripting`、`management` 和 `<all_urls>`。第一版不能未经回归直接删核心权限，但必须在安装引导中明确说明用途。

### 9.5 Profile 和 tab 绑定

- 首次连接只有一个 Profile 时自动绑定。
- 多 Profile 时让用户选择。
- 为项目设置唯一 profile label。
- 项目保存 profile ID/label，不保存 Cookie。
- 打开页面后保存返回的 tab ID/session key。
- 后续操作显式指定 profile/tab，避免依赖当前活动标签页。
- Profile 不可用时停止执行并引导重新选择，不能静默切换登录态。

### 9.6 扩展更新

1. 当前无测试执行。
2. 备份固定扩展目录。
3. 在原路径原子更新文件。
4. 打开 `chrome://extensions` 并提示点击“重新加载”。
5. 检测扩展版本和连接。
6. 成功后删除备份并自动继续原动作。

扩展未重新加载期间仅禁用 Web 测试，App 测试可继续使用。

## 10. Android 测试设计

### 10.1 Windows 原生工具

第一版不依赖 WSL、Git Bash、Node、Python 或 Rust。

固定组件：

- Handsets `v0.1.38` Windows x64：`hs.exe`、`hs.jar`。
- Android platform-tools 固定版本：`adb.exe` 等。

Handsets README/installer 仍称 macOS/Linux，但 `v0.1.38` Release 已提供 `handsets-windows-x86_64.zip`。这属于“待 Windows 真机验证”，不能仅凭发布包存在宣称已支持。

### 10.2 App 选择

用户手机上已经安装目标 App。默认流程：

1. 连接手机并完成 USB 调试授权。
2. 用户在手机上打开目标 App。
3. 桌面端读取当前前台 package。
4. 通过 `hs see` 保存确认截图。
5. 用户确认这是目标 App。
6. 将 package 写入项目 surface。

不先做完整应用列表、APK 管理、图标提取或拖入 APK。

### 10.3 设备规则

- 只有一台设备时自动选择。
- 多台设备时按设备名称选择。
- 项目记住上次设备 serial。
- 设备不可用时重新选择。
- 第一版不做多设备并行。

环境引导必须区分：

- 没有设备。
- 只有充电连接。
- USB 调试未开启。
- `unauthorized`。
- Windows 缺少品牌 USB 驱动。
- 手机锁屏。
- 设备已就绪。

品牌 USB 驱动属于人工步骤，不静默安装。

## 11. 测试执行与并发

### 11.1 全局执行租约

全应用同一时间只允许一个会改变 Chrome 或手机状态的执行：

```text
ownerProjectId
ownerSessionId
runId
startedAt
surfaces
state
```

其他项目可以查看数据，但不能开始另一个测试。切换时提供：

```text
[前往当前测试] [结束当前测试] [取消]
```

不能静默终止当前测试。

锁必须在 Main 中执行，不能只禁用 UI。由于普通 Agent 没有 Bash 和私有工具路径，所有外部操作都会经过同一个门禁。

### 11.2 用户可见状态

- 准备中
- 自动测试中
- 等待用户操作
- 已暂停
- 已完成
- 失败
- 意外中断

### 11.3 人工接管

需要登录、验证码、扫码、授权或人工判断时：

1. Agent 进入 `waiting_for_user`。
2. run 保持进行中，租约不释放。
3. Agent 停止操作 Chrome/手机。
4. 用户在真实现场完成操作。
5. 用户点击“我已完成”。
6. Agent 重新 scan/snapshot/hs ui。
7. 验证目标状态后继续。

恢复时禁止复用旧 `@eN`、DOM snapshot、手机 selector 或前台 package 假设。

用户主动暂停采用“完成当前原子步骤后暂停”，暂停前自动保存截图。不要默认提供会留下不确定状态的立即中断。

### 11.4 异常退出

- 释放全局租约。
- 未结束 run 标记为意外中断/aborted。
- 保留已有证据。
- 下次提供重新运行失败项或重新开始探索。
- 不假装从上次点击位置精确续跑。

## 12. 测试入口与工作流

工作台只保留三个主要入口：

### 12.1 探索业务

- 开始前确认 surface、起点和目标。
- 默认只读。
- 每进入重要页面更新业务地图。
- 关键流程走通后生成 draft 用例。
- 不明确规则写入“待确认”。
- 到达约定范围后主动结束，不无限遍历。

### 12.2 测试一个功能

Agent先展示测试范围、会做什么和不会做什么，用户确认后执行。

### 12.3 运行回归测试

- 只运行 stable 用例。
- 尽量由确定性 runner 执行。
- 模型只在无法定位、页面明显变化、失败归类和问题整理时介入。
- 可选择核心用例、全部稳定用例或手工选择。

## 13. 用例模型

### 13.1 用户界面

用户不接触 YAML。列表展示：

```text
测试用例          测试端       状态       最近结果      风险
手机号登录        App          可重复运行  通过           普通
提交订单并后台核对 App -> 后台  待完善      未运行         需确认
```

内部状态映射：

| 内部状态     | 用户文案     |
| ------------ | ------------ |
| `draft`      | 待完善       |
| `stable`     | 可重复运行   |
| `disabled`   | 已停用       |
| `risk: high` | 运行前需确认 |
| miniprogram  | 不稳定       |

### 13.2 用例产生和晋级

用例只通过以下方式产生：

- 探索成功后由 Agent 生成 draft。
- 从执行记录整理为用例。
- 用户要求保存刚才流程。
- 基于已有用例让 Agent 调整。

Draft 至少成功运行一次，并通过稳定性校验后，才提示用户晋级 stable。坐标、临时 `@eN` 和 fragile 小程序步骤不能晋级稳定回归。

第一版不提供复杂手工步骤编辑器，只提供可读步骤和“让 Agent 调整”。

### 13.3 跨端临时变量

跨端验证需要最小 capture 能力：

```yaml
- act: capture
  surface: app
  pattern: "订单号[:：]\\s*([A-Z0-9-]+)"
  as: order_id

- act: fill
  surface: admin
  target: "订单号"
  value: "{{capture.order_id}}"
```

规则：

- 只在当前 case/run 内存在。
- 不跨 case 持久化。
- 找不到值时阻塞，不能猜。
- 默认界面只显示“已读取订单号”。
- 敏感值不写进 case、run、日志或会话。
- 不引入 if、for、宏或通用工作流语言。

## 14. 跨端验证

同一业务、同一环境下的 App、H5、后台和小程序属于同一个项目。

一次跨端测试是一个 run、一条带 surface 标识的时间线：

```text
App
1. 提交测试业务
2. 读取业务编号

管理后台
3. 打开业务列表
4. 使用刚才的编号查询
5. 核对状态
```

开始前一次检查所有相关 surface，缺哪个只补哪个。真实观察现场是手机和 Chrome，工作台展示步骤、确认、证据和结论。

## 15. 风险与生产环境

### 15.1 风险级别

| 类型     | 示例                                   | 规则               |
| -------- | -------------------------------------- | ------------------ |
| 只读     | 打开、搜索、查看、截图                 | 可自动执行         |
| 业务写入 | 登录、提交申请、创建测试订单、修改状态 | run 开始前确认范围 |
| 高风险   | 支付、退款、删除、发消息、改权限、审核 | 临近执行时单独确认 |

Agent提交结构化风险意图。Main 校验项目环境、确认记录和动作类别。危险关键词只能提升风险，不能降低风险。

### 15.2 生产环境

生产环境只允许只读测试。禁止：

- 创建、提交或修改业务数据。
- 支付、退款、删除。
- 发送消息。
- 修改权限或审核状态。

允许登录已有测试身份作为只读验证的必要例外。第一版不提供“允许生产写入”开关。

## 16. 身份与秘密

### 16.1 多身份

项目可声明普通用户、商户、后台操作员、审核员等身份。每个 surface 有一个默认身份，用例可显式切换身份。

项目文件只保存身份名称和适用 surface。实际凭据按 `projectId + identityId` 存入 Windows OS-backed 加密 vault。

Agent只知道：

```text
普通用户：凭据已配置
后台操作员：凭据已配置
```

### 16.2 秘密不得进入模型和日志

以下内容不得进入模型请求、session JSONL、tool 参数记录、压缩摘要、诊断日志或 finding：

- 模型 API Key。
- 禅道 Token 和登录密码。
- 测试账号密码。
- Cookie value。
- 验证码和动态口令。
- 设备授权私钥。

用例只引用 `{{input.*}}`。执行器在最后一刻解析并填写，结果只返回“已填写密码”等脱敏状态。

### 16.3 子进程安全传值

当前 `agent-browser-cli fill <target> <value>` 会使 secret 出现在 Windows 子进程命令行。自动凭据填写上线前必须提供 stdin/pipe 等安全传值方式，或暂时要求用户人工登录。

验证码、扫码、人脸、生物识别、支付密码和系统权限授权默认由用户在真实现场完成，不通过聊天输入。

凭据填写阶段不截图。确认进入目标页后再保存证据。

## 17. 视觉检查

- 支持明显错位、遮挡、截断、空白页、图片加载失败、弹窗溢出等异常。
- 不做像素级对比、设计稿比对或多分辨率矩阵。
- 不确定时标记“疑似视觉问题”，由用户确认。
- 视觉检查默认关闭，每个项目首次启用时明确说明截图会发送给所选的视觉模型。
- 项目持久化 `visualModel`（如 `qwen-token-plan-cn/qwen3.6-flash`）；主对话模型（如 DeepSeek）不需要图片能力。
- `test_observe visual` 由 Main 截屏并做敏感页面拦截后，Host 用同一凭据对视觉模型发起一次无工具、无历史、无缓存的图片请求，只把文字结论回给主 Agent；base64 不进入主会话或 tool details。

默认不发送以下页面截图给模型：

- 密码和验证码页。
- 支付页。
- 身份证、银行卡等敏感资料页。
- 用户或 Agent 标记为敏感的页面。

H5 目标视口默认 `390x844`，后台默认 `1440x900`。由于使用真实 Chrome，报告必须记录实际 viewport，不能在窗口尺寸不符时宣称已按目标尺寸验证。

## 18. 证据与执行记录

第一版报告只在桌面工作台内展示，根据 run/case/evidence 实时生成，不导出 PDF/HTML。

自动截图时机：

- 关键起点。
- 业务写入完成后。
- 跨端切换前后。
- 断言失败时。
- 用户接管前后。
- 记录问题时。
- 测试结束时。

不要每一步都截图。用户可随时点击“截图留证”。

证据默认不自动删除。按项目显示占用空间。未来清理必须按完整 run 删除，并检查 finding 引用，不能删除仍被问题引用的零散截图。

## 19. 失败分类

执行失败必须先分类，不直接等于 Bug：

| 分类         | 示例                                 | 处理             |
| ------------ | ------------------------------------ | ---------------- |
| 产品异常     | 实际结果与明确预期不一致             | 可建议记录问题   |
| 用例需要更新 | 页面、控件或定位方式变化             | 将用例标记待更新 |
| 环境阻塞     | Chrome、手机、网络、登录、权限未就绪 | run blocked      |
| 业务待确认   | 信息不足以判断                       | 记录待确认       |

Agent可以提出建议，但提交产品问题由用户确认。

## 20. 本地问题与禅道

### 20.1 数据关系

```text
Local Finding (事实来源)
  -> 用户确认
ZenTao Bug (团队协作)
```

本地 finding 保留 run、case、证据和复测历史。禅道只同步 Bug，不同步用例、执行记录、业务地图或测试报告。

同步状态：

- 未提交
- 提交中
- 已提交
- 提交失败
- 远端已关闭

本地和远端状态分别显示，不强制互相覆盖。

### 20.2 第一版禅道能力

- 配置地址和认证。
- 测试连接。
- 读取产品、模块、版本和用户。
- 创建 Bug。
- 上传 PNG/JPEG 和文本证据。
- 保存 Bug ID 和链接。
- 追加复测备注和证据。
- 查询远端状态。
- 打开禅道详情。

版本未知、无公司自定义必填字段。第一版先实现现代 REST API 能力探测和适配，使用真实禅道验证；不预先维护全部历史版本，不回退到浏览器填表。

如果账号密码可换 Token，成功后立即清除密码，只保存 Token。Token 使用全局 OS-backed vault，项目只保存连接 ID、产品、模块、版本和默认指派。

### 20.3 提交规则

Agent可以自动创建本地待确认 finding，但写禅道必须由用户确认预填表单。

字段映射：

| Finding                | ZenTao Bug       |
| ---------------------- | ---------------- |
| title                  | 标题             |
| surface/environment    | 运行环境         |
| stepsToReproduce       | 重现步骤         |
| expected               | 期望结果         |
| actual                 | 实际结果         |
| severity               | 严重程度         |
| evidence               | 附件             |
| case/run/source marker | 描述中的来源信息 |

严重程度和优先级不是同一个字段。系统可建议优先级，用户提交前可调整。

每个 Bug 写入稳定来源标识，例如 `Pi-Test: ydj/finding-order-missing`。网络超时后重试时先查该标识，避免重复创建。

复测通过后只追加结果和证据，不自动替开发人员关闭禅道 Bug。

## 21. AI 服务

用户自行提供 API Key。普通流程只显示：

```text
AI 服务已连接
```

首次使用需要 Agent 的功能时再引导配置，不阻塞项目创建和历史数据查看。完成配置后自动继续用户原始动作。

主界面提供少量已验证 Provider，例如 OpenAI、Anthropic、Google Gemini；国内 Provider 和具体推荐模型需要按同一验收集验证后再定。其他兼容服务放高级设置。

连接时验证：

- Key 是否有效。
- 推荐模型权限。
- 中文能力。
- 工具调用能力。
- 图片能力。

不默认自动跨 Provider 故障转移，避免数据被发送给另一服务商或产生意外费用。

Key 使用 OS-backed 加密 vault，不写项目文件、日志或诊断包。应用只允许重新填写，不显示完整明文。

## 22. 设备在线授权

### 22.1 设备身份

首次启动生成 Ed25519 设备密钥对：

- 私钥使用 Windows OS-backed 加密存储。
- 公钥哈希作为完整设备 fingerprint。
- UI 显示由 fingerprint 派生的短授权码。
- 不依赖 MAC 地址、硬盘序列号或主板指纹。

复制授权 JSON 到另一台电脑不能使用，因为没有对应设备私钥。系统重装或 vault 被清除后需要重新授权。

### 22.2 授权文件

OSS 路径：

```text
licenses/<sha256-full-device-fingerprint>.json
```

示意：

```json
{
  "version": 1,
  "licenseId": "lic-20260811-001",
  "deviceFingerprint": "full-fingerprint",
  "status": "active",
  "issuedAt": "2026-08-11T08:00:00Z",
  "features": ["desktop-testing"],
  "minimumDesktopVersion": "1.0.0",
  "signature": "base64-ed25519-signature"
}
```

授权永久，不设置 `expiresAt`。吊销通过同路径覆盖为签名的 `status: revoked`，不要通过删除文件表达吊销。

签名覆盖除 `signature` 外的规范化 payload。授权签名私钥只存在于管理机，不进入仓库、客户端、CI 或 OSS。

### 22.3 在线规则

- 每次应用启动必须在线检查。
- 应用持续运行时每 24 小时重新检查。
- 没有离线宽限期。
- OSS 网络失败或状态无效时进入只读模式。
- 收到有效签名的 revoked 立即禁止新操作。
- 正在执行时允许当前原子操作收尾、保存证据，然后中断后续步骤。
- 本地缓存只用于展示上次状态，不能用于离线放行。

只读模式允许查看本地项目、地图、用例、执行记录、问题、证据、授权码和应用更新；禁止 Agent、新 run、项目写入、Chrome/手机操作和禅道写入。

Main 必须在创建 Agent session、开始 run、调用外部驱动、写项目和写禅道时重新执行授权门禁。Renderer 不能决定授权结果。

### 22.4 现实边界

纯桌面授权无法阻止有能力的人修改二进制跳过校验。签名授权用于防止普通复制、伪造许可和 OSS 篡改，不等同于不可破解 DRM。

## 23. Windows 工具链

### 23.1 安装原则

- 所有工具使用绝对路径。
- 不写系统 PATH。
- 不要求管理员权限。
- 不执行 `npm install -g`。
- 不执行 `curl | bash`。
- 不依赖外部 `which`、`sleep` 或 POSIX `/tmp`。
- 使用 Node/Electron 标准 API、Windows temp 和现有安全解压器。

建议随应用携带：

- Pi runtime。
- pi-test core/workflows。
- `agent-browser-cli.exe` 和必要 assets。
- 已打安全补丁的 Chrome 扩展。
- `hs.exe`、`hs.jar`。

首次需要 App 测试时按确认计划从 OSS 下载：

- 固定版本 Android platform-tools。

### 23.2 版本兼容矩阵

初始基线：

```text
Desktop            1.x
Pi Runtime          0.84.0
pi-test             1.x
agent-browser-cli   0.3.7
Chrome Extension    2.1 + cookie popup patch
Handsets            0.1.38
platform-tools      37.0.1
project schema      1
```

不能自动跟随 GitHub/npm latest。所有版本先通过 Windows 真机回归，再跟随桌面版本发布。

## 24. OSS 分发和更新

### 24.1 目录建议

```text
desktop/
  stable.json
  releases/1.0.0/PiTestDesktop-1.0.0-x64.exe

tools/
  windows-x64/manifest.json
  windows-x64/platform-tools-<version>.zip

chrome-extension/
  2.1/chrome-extension.zip

licenses/
  <device-fingerprint-sha256>.json
```

最好使用独立自有域名：

```text
https://download.example.com/
https://license.example.com/
```

### 24.2 更新清单

`stable.json` 使用独立“发布签名密钥”签名。授权文件使用另一套“授权签名密钥”。两套私钥不能混用。

客户端验证：

1. 固定 HTTPS 下载域名。
2. 更新清单 Ed25519 签名。
3. 版本约束。
4. 安装包大小。
5. SHA-256。
6. 有 Authenticode 后再验证 Windows 代码签名。

安装包版本目录不可覆盖，设置 immutable 长缓存。`stable.json` 和授权对象设置 `no-cache`。Bucket 禁止目录列表，客户端只具备公开读取能力。

授权服务失败会进入只读；更新服务失败不影响当前版本正常测试。

### 24.3 发布工具

第一版只做本地发布脚本，不建设发布后台。脚本负责：

1. 构建 Windows x64 安装包。
2. 计算 size/SHA-256。
3. 生成并签名更新清单。
4. 上传不可变版本目录。
5. 验证远端对象。
6. 最后更新 `stable.json`。

脚本私有配置包含发布私钥和 OSS 上传凭据，不进入 Git。

正式面向普通用户前建议购买 Authenticode 证书。OSS 加签不能消除 SmartScreen 的“未知发布者”。

## 25. 数据保存与删除

- 项目业务数据保存在项目目录。
- AI Key、禅道 Token、项目身份凭据和设备私钥保存在 OS-backed 加密 vault。
- 验证码只存在于当前人工操作，不写盘。
- `.secrets/inputs.yaml` 只作为旧 CLI 项目兼容读取，桌面端不再写入新密码，并提供迁移提示。
- 所有 YAML/JSON 业务写入使用临时文件和原子替换。
- schema 迁移先备份、迁移、校验，再替换。
- 新 schema 项目被旧客户端打开时只读，不降级写回。

普通操作是“归档项目”。真正删除必须：

- 当前没有执行。
- 展示用例、run、finding、证据占用。
- 明确已提交禅道 Bug 不会删除。
- 用户再次确认项目名称。
- 使用 Windows 回收站，不直接永久删除。

“仅从工作台移除”和“删除本地项目数据”必须是两个动作。

## 26. 诊断与隐私

应用内提供“一键环境自检”和“导出诊断信息”，不要求用户使用终端。

检查项：

- 设备授权。
- Chrome 安装、扩展版本、连接、Profile、普通 tab。
- `agent-browser-cli.exe`。
- 私有 `adb.exe`。
- Android 设备和 USB 授权。
- `hs use/ui/see`。
- AI 服务连接。
- 项目目录读写。
- 禅道连接。
- 组件版本和兼容矩阵。

诊断包禁止包含：

- API Key、Token、测试账号和密码。
- Cookie value。
- 验证码。
- 设备授权私钥。
- 未经用户明确选择的业务截图。

## 27. 实施阶段

### Phase 0：单仓库与边界清理

- [x] 将 `pi-extension` 导入 `packages/pi-test`。
- [x] 保留 core 与 adapter 分层。
- [x] 让 desktop 和 Agent 调用同一个 core。
- [x] 删除/禁用 Electron Browser 全链路。
- [x] 测试会话禁止第三方 Pi 资源自动加载。
- [x] 测试会话移除 Bash、任意文件、Git 和 Electron Browser 工具。
- [x] 建立 Main Test Coordinator 和类型化契约。

删除影响面见 `docs/TEST_WORKBENCH_DEPENDENCY_AUDIT.md`。Browser 全链路和 Skills/Plugins、Channels、Git/Worktree 的主要实现/UI 已删除；Agent Host general session、历史会话展示和只读附件渲染仍有兼容代码，不进入测试会话。

### Phase 1：Windows 底层技术验证

- [x] 应用私有 `agent-browser-cli.exe` 可运行。
- [x] 固定目录扩展安装引导和自动连接检测。
- [x] 应用扩展 Cookie popup 安全补丁。
- [x] Profile/tab 显式绑定。
- [ ] 私有 `adb.exe` 能识别真机。
- [ ] `hs.exe use -> ui -> tap -> see`。
- [x] 受控 `test_observe/test_act` 完成一次网页操作。
- [x] 无 Bash、任意文件工具时 Agent 仍能完成观察和点击。

Phase 1 可先在 macOS 完成代码、单测和 Windows 构建；最终状态必须标记“待 Windows 真机验证”。

### Phase 2：最小 Web 闭环

```text
设备授权
-> 新建项目
-> 配置 AI Key
-> 加载 Chrome 扩展
-> 测试一个功能
-> 自动生成 run 和证据
-> 记录本地问题
-> 提交禅道 Bug
```

### Phase 3：App 与跨端

```text
连接手机
-> 检测前台 App
-> 用户确认 package
-> App 操作
-> 捕获业务编号
-> 管理后台核对
-> 保存跨端证据和问题
```

### Phase 4：项目资产与回归

- [x] 业务地图。
- [x] draft/stable/disabled 用例。
- [x] 确定性回归 runner。
- [x] capture 临时变量。
- [x] 问题复测。
- [x] 明显视觉异常检查。

2026-08-13：普通测试 session 的固定工具面现为 `test_setup/test_run/test_observe/test_act/test_map/test_case/test_play/test_finding`。领域写入均由 Main 校验当前租约并复用唯一 core；`test_play` 可手工重放 draft，`regression` 只接受 stable，disabled 和 miniprogram 拒绝。stable 晋级要求至少一次 case passed 历史。runner 支持三端固定动作、断言、自动失败截图、App swipe、当前 run/case 内受限正则 capture 和纯文本 UI evidence；秘密 `{{input.*}}` 仍要求人工接管，不进入 CLI argv。工作台用例页可确定性运行全部 stable 用例并启停/晋级。视觉检查复用 `test_observe mode=visual`，项目默认关闭；首次在项目设置启用时由 Main 原生确认截图会发送给当前 AI 服务商。adapter 在 Main 截图前检查当前模型是否支持 image；Main 先读取现场并阻止密码、验证码、支付、证件和银行卡页面，再将非敏感 PNG 作为当前 run evidence 和 Pi 原生 image block 返回，base64 不进入 tool details。只检查明显异常，不做像素级对比。

### Phase 5：正式分发

- [ ] OSS 授权。
- [x] OSS 更新清单。
- [ ] 本地授权签发/吊销工具。
- [x] 本地发布脚本（`npm run publish:oss`，V1 签名直传 Aliyun OSS）。
- [x] Chrome 扩展更新引导。
- [ ] Windows NSIS 安装包。
- [ ] Authenticode 代码签名。

更新源已切到 OSS generic provider：`config/update-oss.json` 固定 feed 基地址，`electron-builder.yml` 生成 `app-update.yml`（`provider: generic` + OSS url），`scripts/publish-oss.mjs` 上传 `latest*.yml`/blockmap/安装包，CI 新增 `release-oss` job 在 GitHub draft release 之后发布到 OSS。electron-updater 会从 OSS 拉取 `latest.yml`/`latest-mac.yml` 并校验 SHA-512。

## 28. 验收标准

### 28.1 Windows 基础验收

在没有预装 Node、Python、Rust、ADB、Handsets 的 Windows 10/11 x64 电脑上：

1. 应用可以安装和启动。
2. 未授权时显示设备授权码并禁止新测试。
3. 授权文件上传 OSS 后可在线激活。
4. 应用私有 `agent-browser-cli.exe` 可启动。
5. 用户按引导加载扩展后，应用自动识别扩展版本、Chrome Profile 和 tab。
6. 应用私有 `adb.exe` 能识别真实 Android 手机。
7. `hs.exe` 能连接、读取 UI、点击和截图。
8. Agent只能通过受控工具操作网页和手机。
9. 所有证据正确写入当前项目。
10. 诊断导出不包含秘密。

### 28.2 主业务验收

固定验收场景：

> 在 Android App 使用普通用户提交一项测试业务，读取业务编号，在真实 Chrome 的管理后台查询并核对，保存两端截图，发现异常后生成本地问题并提交禅道 Bug，修复后追加复测结果。

该场景应覆盖：

- 项目隔离。
- 多身份和秘密填充。
- 全局测试锁。
- 手机和 Chrome。
- 人工接管。
- 跨端 capture。
- run 和证据。
- finding 和禅道。
- 风险确认。
- 授权门禁。

## 29. Windows 待验证风险

以下事项无法在当前 macOS 环境完成最终结论：

- `handsets v0.1.38` Windows 包在目标手机上的完整行为。
- Windows USB 驱动和不同手机品牌表现。
- 私有 platform-tools 与 Handsets 的路径和进程兼容。
- Chrome 开发者模式加载解压扩展的企业策略限制。
- Windows Defender/SmartScreen 对私有 CLI 和未签名安装包的拦截。
- `safeStorage` 在目标 Windows 用户环境中的可用性和迁移行为。
- NSIS 更新过程中扩展固定目录和用户数据保留。
- 实际禅道版本的 REST API 能力和附件上传格式。
- 用户选择的 AI Provider 在 Windows 网络环境中的可用性。

代码完成后由用户在 Windows 真机测试。macOS 构建和单元测试不能替代上述验收。

## 30. 下一 session 首个工作包

不要从完整 UI 重做开始。建议顺序：

1. 对照本文审计现有 Browser、Skills/Plugins、Bash 和 channel 依赖，列出删除影响面。
2. 设计 `packages/pi-test` 的 core API 和 Main Test Coordinator RPC，不先迁移全部文件。
3. 将现有 project/case/run/finding 纯领域逻辑迁入 core，保持现有 selfcheck 可运行。
4. 为 project schema 增加 `environment`、nullable surface 和 identities，并补一组最小迁移/校验测试。
5. 定义 `test_observe/test_act` 结构化参数、风险字段和进度事件。
6. 让 Agent adapter 将调用转发到 Main，而不是直接 spawn CLI。
7. 建立一个最小 Web 技术切片：Main 调用固定路径 browser CLI，返回结构化 observe/act 结果。
8. 再开始项目首页和 Chrome 安装引导 UI。

首个代码 PR/提交的完成定义（2026-08-12 已完成）：

- [x] `pi-test` 已有唯一 core。
- [x] 现有 YAML 自检继续通过。
- [x] 新 project schema 有测试。
- [x] Main 有受控测试协调器骨架。
- [x] Agent 无通用 Bash 时仍可注册最小测试工具。
- [x] 没有同时实现第二套项目或用例逻辑。

当前技术切片已完成受控 Web driver、Main/Host 注入、最小工作台闭环，以及固定 `agent-browser-cli 0.3.7`/`2.1-pi-test.2` Chrome 扩展的构建期校验、打包、稳定目录原子部署、安装/更新引导和自动连接检测。Android 切片已固定 Handsets `0.1.38` 与 platform-tools `37.0.1`，实现 Windows 私有资产部署、显式下载确认、设备诊断、前台 App 确认和受控 `open/observe/click/fill/shot`。Main 已实现持久 `pause/takeover/resume` 状态机、原子步骤后暂停、恢复强制重新感知、run/surface 级业务写入确认和逐动作高风险确认。项目身份元数据和 surface 默认身份已接入唯一 core，账号密码仅写入 Main `safeStorage` vault；Renderer/Agent 只见“凭据已配置”，安全 pipe 完成前仍由用户人工登录。项目现支持 H5/管理后台/App 多 surface 创建与修改，以及独立的归档、仅移除和系统回收站删除流程。2026-08-13 已在 Windows 11 Pro x64 真机验证上一版 NSIS、真实 Chrome Profile/tab 绑定和页面操作；本次产品化资产的新 Windows 安装包和 Android 真机仍待复验。结果见 `docs/TEST_WORKBENCH_DEPENDENCY_AUDIT.md`。

## 31. 尚未阻塞实现的待定项

这些内容需要以后填写，但不阻塞开始编码：

- 产品最终名称、图标和 Windows `appId`。
- 自有下载域名和授权域名（更新/授权 Bucket 已固定为 `shenzhen-agent.oss-cn-shenzhen.aliyuncs.com`）。
- 发布公钥、授权公钥和安全保管方式。
- 第一版具体推荐模型和国内 Provider。
- 实际禅道地址、产品和 API 探测结果。
- Authenticode 证书采购时间。
- Windows 验收机型号、Android 品牌和固定测试环境。
