# pi-test CLI 历史产品说明

状态：已归档；领域模型参考保留，桌面实现以 `../../docs/TEST_WORKBENCH_MVP.md` 为准  
日期：2026-08-12

> 本文记录迁移前 CLI 产品，其中“直接 Bash/CLI”“allowBash”和旧 project schema 决策已被桌面基线取代，不得作为当前实现依据。

## 一句话

多端探索性测试工作台：一个业务项目可挂 **H5 / 管理后台 / App（含微信小程序壳）**，先摸业务，再沉淀 **可重复 YAML cases**；面向新手，**确认后**自动安装 `agent-browser-cli` 与 `handsets`。

## 目标用户

- 主要：新手（不会配环境、不会记 CLI）
- 次要：熟手（可 bash 直调底层 CLI）

## 非目标（v1）

- iOS
- 微信官方稳定自动化 API
- 桌面 GUI / 报告平台 / 录制器
- 重型 TS SDK（CLI + 薄 tool）
- 沿用 PiDeck 的 project/run/bug 仪式与模式状态机

## 核心对象

```
Project
  surfaces[]     h5 | admin | app | miniprogram
  map            业务地图（模块 / 主流程 / 角色）
  cases[]        可重复步骤（YAML）
  runs[]         一次执行记录 + 证据
  findings[]     问题（含待确认）
```

| 对象    | 职责                           |
| ------- | ------------------------------ |
| Surface | 一端入口与驱动方式             |
| Map     | 探索产物；服务「测什么」       |
| Case    | 稳定、可重放；不是探索日记     |
| Run     | 某次执行的范围、结果、证据路径 |
| Finding | 可观察问题；未确认也可记       |

### Surface

| type          | 驱动                       | 配置                             |
| ------------- | -------------------------- | -------------------------------- |
| `h5`          | agent-browser-cli          | `url`，默认 viewport `390x844`   |
| `admin`       | agent-browser-cli          | `url`，桌面 viewport             |
| `app`         | handsets (`hs`)            | package / 启动入口 / 可选 serial |
| `miniprogram` | handsets 驱微信（fragile） | 名称/入口；有 H5 等价时优先 `h5` |

同一 Project 可同时存在多端。Case 每步必须带 `surface`；允许跨端（如下单后 admin 核对）。

### 微信小程序

- 标为 **fragile**：可探索，cases 易碎。
- 优先：有 H5 形态则测 H5；否则 Android 上 `hs` 操作微信 UI。
- 产品文案必须提示不稳定，不承诺与原生 App 同级可靠性。

## 用户主路径

```
setup → new → explore → case → run
```

1. **setup**：检查依赖；缺则展示计划，**用户确认后安装** CLI；扩展/USB/微信登录仍可能要手动。
2. **new**：建项目，登记 surfaces。
3. **explore**：按端摸业务，写 Map，主流程走通。
4. **case**：稳定路径写成 YAML case（可选 MD 说明）。
5. **run**：重放 case，落证据与 finding。

命令入口（示意）：`/test setup|new|explore|run|status`  
细操作：P0 仅少量 tool + skill 规定直调 CLI（见下）。

## Tools

### P0 只实现 3 个

| tool         | 作用                                                         |
| ------------ | ------------------------------------------------------------ |
| `test_setup` | doctor；确认后代装 CLI；分关卡输出 ok/action/manual          |
| `test_run`   | 开/结 run、维护 active-run、写 `run.yaml`                    |
| `test_shot`  | 截图写入 **当前** run 的 `evidence/`（无 active-run 则报错） |

### 不做成 tool（P0）

`open` / 连设备 / `ui` / `tap|fill|wait`：**skill 规定直接 bash 调** `agent-browser-cli` 与 `hs`。  
case 的增改：agent 写 YAML 文件（或后续薄封装）；P0 不做 CRUD tool 全家桶。

### P1+ 可选再加

`test_case`（draft→stable）、`test_open` / `test_device` / `test_ui` / `test_act`——仅当 CLI 直调在真实使用中摩擦大时再包。

## Case 格式（概要）

**YAML 正文 + 可选同名 MD**。完整 schema 见下文「case.yaml（已定死）」。

## 安装策略与完成定义

`test_setup` 默认：

1. 检查依赖（分关卡，见下）
2. 列出将执行的安装动作（dry-run）
3. **用户确认后**再安装 **CLI**（handsets install.sh、agent-browser-cli 安装路径等）
4. 再 doctor；失败给中文下一步

禁止：静默安装、擅自 sudo、改全局代理。

三级结果：`ok` | `action`（已可代办或已代装） | `manual`（必须用户动手）。

### 关卡（完成定义）

| 关           | 检查                                                                        | 可代装？     | 算 setup 完成？                            |
| ------------ | --------------------------------------------------------------------------- | ------------ | ------------------------------------------ |
| 1 CLI        | `agent-browser-cli`、`hs`（若项目含 app/miniprogram）、`adb`（手机）在 PATH | 是（确认后） | 否，仅过第 1 关                            |
| 2 桥接       | Chrome 扩展连通 / browser daemon；`hs use` 能连上 daemon                    | 否           | Web 项目：2=可测；App：还需 3              |
| 3 设备与业务 | USB 调试授权、设备解锁；业务站/微信已登录（若需要）                         | 否           | 本关 manual 通过才宣称「可测对应 surface」 |

**禁止**把「npm/curl 退出码 0」单独宣传为安装成功。  
setup 输出必须按 surface 说明：哪些端已可测、卡在哪一关、用户下一步点哪里。

## 安全与纪律

- 不确定输入（账号/验证码/业务参数）必须问，禁止编造
- 删除/下单/支付/退款/发消息/改权限/写生产：先确认
- 敏感值不进 cases 明文、不进 runs/findings 正文；证据脱敏
- 结论必须有可观察证据路径

## 目录

```text
<project>/
  project.yaml           # 权威配置（schema 见下，已定死）
  map.md                 # 业务地图（自由 MD + 最小标题模板）
  cases/
    <id>.yaml
    <id>.md              # 可选说明
  runs/
    <YYYY-MM-DD-HHmm>-<slug>/
      run.yaml
      evidence/
  findings/
    <id>.yaml
  .pi-test/
    active-run           # 当前 in_progress 的 run 目录名；无则文件不存在
  .secrets/
    inputs.yaml          # gitignore；{{input.*}} 取值
```

### Active run（已定死）

- 每个项目 **最多一个** `status: in_progress` 的 run
- `.pi-test/active-run` 内容：单行目录名，如 `2026-08-11-1530-smoke`（不是绝对路径）
- `test_run` 开始：创建目录 + 写 run.yaml + 写 active-run
- `test_run` 结束：写终态 + 删除 active-run
- `test_shot` / 写 journal / 挂 finding：必须读 active-run；缺失则报错并提示先开 run
- 若 active-run 指向目录不存在或 run.yaml 已是终态：**stale** → 删指针并提示；不自动开新 run
- 崩溃残留：`test_run` 开始或 `test_setup` 发现 stale 时清指针；对应 run 仍为 `in_progress` 则改为 `aborted`（summary.text 注明 crash/stale）

## 资产写入原则（评审修订）

- 人几乎不手写四套 YAML；**由 tool / agent 生成**，`createdAt`/`updatedAt` 由工具填
- 加载失败：中文一行说明缺啥、怎么修，不堆 schema 术语
- 证据路径：run 内引用相对 run 目录；finding 引用相对项目根——**只由工具生成，人手勿拼**

## target 解析（已定死）

case / 操作里的 `target`：

1. 默认按 **可见文案 / 无障碍名** 解析（web 与 `hs` 同一语义优先级）；Main 对 click/fill 先直传 CLI，失败后再按可见文案/无障碍名（含 shadow DOM）定位。
2. web 失败 → `snapshot` 二次定位后再点；禁止用 `open` 猜 URL 开新标签页。
3. app 失败 → `hs find` 再收紧 selector
4. **禁止** 在 `status: stable` 的 case 中写 `@eN`（会话态引用）
5. 坐标 `x,y`：仅当 `note` 写明原因，且不推荐进 stable

## project.yaml（已定死）

- 文件名固定：`project.yaml`（项目根目录）
- `schemaVersion` 当前只接受 `1`
- 未知顶层键：**拒绝加载**（严格，避免静默忽略）
- 实现用标准 YAML 1.2 解析；不支持自定义标签

### 完整字段

```yaml
schemaVersion: 1 # required, 字面量 1
id: ydj # required, ^[a-z][a-z0-9-]{1,63}$
name: 易点金 # required, 展示名，1–80 字
createdAt: 2026-08-11T08:00:00Z # required, ISO-8601 UTC
updatedAt: 2026-08-11T08:00:00Z # required, ISO-8601 UTC

# required, 至少 1 个 surface；键名即 surface id，限下列枚举
surfaces:
  h5:
    url: https://h5.example.com/ # required, http(s) URL
    viewport: "390x844" # optional, 默认 "390x844"，格式 WxH
  admin:
    url: https://admin.example.com/
    viewport: "1440x900" # optional, 默认 "1440x900"
  app:
    package: com.example.app # required, Android package
    activity: null # optional, 如 .MainActivity；null=默认启动
    serial: null # optional, adb serial；null=hs 默认设备
  miniprogram:
    wechatPackage: com.tencent.mm # optional, 默认 com.tencent.mm
    name: 易点金 # required, 微信内展示名（用于 hs 点选）
    appId: null # optional, 有则记录，不保证能用
    entry: null # optional, 入口描述（文案/路径提示）
    # fragile 不写；加载时强制视为 true

# optional, 声明 case/run 可用的 {{input.*}}；值不在此文件
inputs:
  phone:
    description: 登录手机号
    secret: true # optional, 默认 true
  sms:
    description: 短信验证码
    secret: true

# optional
defaults:
  regression: [login-h5, place-order] # stable case id 列表；缺省=全部 stable
  riskConfirm: true # 高风险步骤默认要确认；默认 true
  allowBash: false # 是否允许 case 中 act/pre 使用 bash；默认 false
  visualCheck: true # 启用明显视觉异常检查
  visualModel: { provider: qwen-token-plan-cn, modelId: qwen3.6-flash } # 视觉模型，支持 image 输入
```

### 校验规则（实现必须遵守）

| 规则                    | 说明                                               |
| ----------------------- | -------------------------------------------------- |
| surface 键              | 仅 `h5` \| `admin` \| `app` \| `miniprogram`       |
| surfaces 非空           | 至少出现一个                                       |
| url                     | `http://` 或 `https://`，禁止空字符串              |
| viewport                | `^[1-9][0-9]{1,4}x[1-9][0-9]{1,4}$`                |
| package / wechatPackage | 非空 Android package 名                            |
| inputs 键               | `^[a-z][a-z0-9_]{0,31}$`，对应 `{{input.<key>}}`   |
| inputs.*.secret         | bool，默认 `true`                                  |
| defaults.regression     | string[]，元素为 case `id`；可空数组               |
| defaults.allowBash      | bool，默认 `false`                                 |
| defaults.visualCheck    | bool；开启时要求已选 `defaults.visualModel`        |
| defaults.visualModel    | `{provider, modelId}`，模型 `input` 必须含 `image` |
| miniprogram             | 加载后只读字段 `fragile: true`（不要求写在文件里） |
| id 稳定                 | `id` 创建后不改；改名只动 `name`                   |

### 最小合法例（仅 H5）

```yaml
schemaVersion: 1
id: demo-h5
name: Demo H5
createdAt: 2026-08-11T08:00:00Z
updatedAt: 2026-08-11T08:00:00Z
surfaces:
  h5:
    url: https://example.com/
```

### 三端 + 小程序例

见 `examples/project.yaml`。

### 模板插值（与 project 相关）

| 表达式                     | 来源                                              |
| -------------------------- | ------------------------------------------------- |
| `{{surfaces.h5.url}}`      | `surfaces.h5.url`（admin/app 同理；无则报错）     |
| `{{surfaces.app.package}}` | app package                                       |
| `{{input.phone}}`          | `.secrets/inputs.yaml` 的 `phone`，缺则运行时询问 |

`.secrets/inputs.yaml` 形状（不定进 schemaVersion，但键必须 ⊆ `inputs` 声明）：

```yaml
phone: "13800000000"
sms: "123456"
```

### 显式不做（v1 project.yaml）

- 多环境（staging/prod）切换表 → 用不同项目目录或以后 v2
- surface 自定义 id（如 `h5-b`）→ v1 四端枚举足够
- 在 project 里存账号密码
- linked monorepo 路径强制字段 → 需要时以后加 `source.repo` 可选扩展（v1 不加）

## case.yaml（已定死）

- 路径：`cases/<id>.yaml`；`<id>` 必须等于文件内 `id`
- 可选说明：`cases/<id>.md`（**不参与重放**，解析器可忽略）
- `schemaVersion` 只接受 `1`
- 未知顶层键：**拒绝加载**
- 字符串中的 `{{surfaces.*}}` / `{{input.*}}` 在执行时解析；写盘时保持模板原文

### 完整字段

```yaml
schemaVersion: 1
id: login-h5 # required, ^[a-z][a-z0-9-]{1,63}$
title: H5 登录 # required, 1–120 字
description: null # optional, 短摘要；长文放同名 .md
surface: h5 # required, 默认 surface：h5|admin|app|miniprogram
status: draft # required: draft | stable | disabled
tags: [] # optional, string[]，元素 ^[a-z0-9-]{1,32}$
risk:
  normal # optional: normal | high；默认 normal
  # high = 含下单/支付/删除等，执行前必确认（且受 project.defaults.riskConfirm）
createdAt: 2026-08-11T08:00:00Z # required
updatedAt: 2026-08-11T08:00:00Z # required

# optional, 执行 steps 前的准备；按序执行；失败则 case 不跑 steps
pre:
  - surface: h5 # optional, 默认用 case.surface
    open: "{{surfaces.h5.url}}" # web: 打开 URL
  # - surface: app
  #   launch: true                   # app: 启动 package（用 project.surfaces.app）
  # - surface: app
  #   connect: true                  # app/miniprogram: 确保 hs 已连接（serial 来自 project）

# required, 至少 1 步
steps:
  - act: fill # 见下方 act 枚举
    surface: h5 # optional, 覆盖 case.surface
    target: "手机号" # 选择器或可见文案；坐标仅 risk 明确时
    value: "{{input.phone}}" # fill 必填
    timeout: 10s # optional, 默认 10s；格式 <num>ms|<num>s
    optional: false # optional, true=失败记 warn 并继续；默认 false
    note: null # optional, 人读备注，不执行

  - act: fill
    target: "验证码"
    value: "{{input.sms}}"

  - act: tap
    target: "登录"

  - act: wait
    text: "首页" # wait 三选一：text | idle | package

  - act: shot
    name: after-login # 证据文件名 stem；写入当前 run/evidence/

# optional, steps 成功后的断言；任一失败 → case 失败
assert:
  - see: "首页" # 当前 surface 可见文案/控件
  # - not_see: "登录失败"
  # - url_contains: "/#/home"        # 仅 h5/admin
  # - package: com.example.app       # 仅 app/miniprogram 前台包名
```

### `act` 枚举（v1）

| act       | 适用 surface     | 必填字段                      | 含义                                                                                                                          |
| --------- | ---------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `open`    | h5, admin        | `url`                         | 打开页面（也可只放 pre）                                                                                                      |
| `connect` | app, miniprogram | —                             | `hs use`（serial 来自 project）                                                                                               |
| `launch`  | app              | —                             | 启动 `surfaces.app.package`（可选 `activity` 来自 project）                                                                   |
| `tap`     | 全部             | `target`                      | 点击                                                                                                                          |
| `fill`    | 全部             | `target`, `value`             | 填入（清空后写入）                                                                                                            |
| `wait`    | 全部             | `text` 或 `idle` 或 `package` | 等待                                                                                                                          |
| `swipe`   | app, miniprogram | `direction`                   | `up\|down\|left\|right`；可选 `distance` 默认 300                                                                             |
| `shot`    | 全部             | `name`                        | 截图到 run evidence                                                                                                           |
| `ui`      | 全部             | —                             | 拉取当前 UI 摘要到 evidence（调试用）                                                                                         |
| `bash`    | —                | `run`                         | **默认禁止**。仅当 `project.defaults.allowBash: true` 且 case 为 `draft` 时可执行；`stable` 与 `trigger: regression` 一律拒绝 |

`wait` 字段互斥：恰好一个 `text` | `idle` | `package`。  
`idle` 值如 `200ms`。`package` 为 Android package 名。

### pre 项形状

每项是 **单键动作**（除可选 `surface`）：

| 键        | 含义                                |
| --------- | ----------------------------------- |
| `open`    | string URL（可模板）                |
| `connect` | `true`                              |
| `launch`  | `true`                              |
| `bash`    | string（同 steps，regression 拒绝） |

### assert 项形状

每项恰好一个断言键（可另加可选 `surface`）：

| 键             | 含义                       |
| -------------- | -------------------------- |
| `see`          | 可见包含该文案/匹配 target |
| `not_see`      | 不可见                     |
| `url_contains` | 当前 URL 子串（web）       |
| `package`      | 前台 package（app）        |

### 校验规则

| 规则              | 说明                                              |
| ----------------- | ------------------------------------------------- |
| 文件名            | `cases/<id>.yaml` 与 `id` 一致                    |
| surface           | 必须在 `project.surfaces` 中存在                  |
| steps[].surface   | 若写，必须在 project 中存在                       |
| status            | 仅三值；`defaults.regression` 只收录 `stable`     |
| risk=high         | 执行前必须用户确认（当 `riskConfirm: true`）      |
| 坐标 target       | 仅允许 `x,y` 数字形式且 `note` 必填原因；否则拒绝 |
| 未知 act / 断言键 | 拒绝加载                                          |
| `{{input.X}}`     | `X` 必须在 `project.inputs` 声明                  |

### 最小合法例

```yaml
schemaVersion: 1
id: smoke-h5
title: 打开 H5 首页
surface: h5
status: draft
createdAt: 2026-08-11T08:00:00Z
updatedAt: 2026-08-11T08:00:00Z
pre:
  - open: "{{surfaces.h5.url}}"
steps:
  - act: wait
    text: "首页"
assert:
  - see: "首页"
```

更多见 `examples/case-login-h5.yaml`、`examples/case-cross-surface.yaml`。

### 显式不做（v1 case）

- 步骤级 if/for/宏
- 多 case 继承/混入
- 在 case 内写密钥明文
- Playwright/Appium 脚本内嵌
- 默认开放 `bash` act（必须显式 allowBash）

---

## run.yaml（已定死）

- 路径：`runs/<YYYY-MM-DD-HHmm>-<slug>/run.yaml`
- 同目录 `evidence/` 放截图与 UI 摘要；**只存相对路径引用**
- `schemaVersion` 只接受 `1`
- 未知顶层键：**拒绝加载**
- run **只追加结果，不改 case 文件**；复测 = 新 run 目录

### 目录名

```text
runs/<YYYY-MM-DD-HHmm>-<slug>/
```

- 时间：本地创建时刻，24h，零填充
- `slug`：`^[a-z0-9]+(-[a-z0-9]+){0,7}$`，总目录名 ≤ 80 字符
- 碰撞：同秒同 slug 则后缀 `-2`, `-3`, …

### 完整字段

```yaml
schemaVersion: 1
id: run-20260811-1530-smoke # required, 建议 run-<目录名>；^[a-z][a-z0-9-]{1,79}$
projectId: ydj # required, 等于 project.id
status: in_progress # required: in_progress | passed | failed | blocked | aborted
trigger: manual # required: manual | regression | explore
createdAt: 2026-08-11T07:30:00Z # required
startedAt: 2026-08-11T07:30:01Z # required
finishedAt: null # 结束时 required；ISO-8601

title: 冒烟 # required, 1–120 字
note: null # optional

# 本 run 意图执行的 case；可空（纯 explore 只写 journal）
cases:
  - id: login-h5 # case id
    status: pending # pending | running | passed | failed | skipped | blocked
    startedAt: null
    finishedAt: null
    error: null # 失败/阻塞时短信息，禁止堆敏感值
    evidence: [] # 相对本 run 目录，如 evidence/login-h5-after-login.jpg

# 环境快照（执行开始时写入，禁止密文）
env:
  surfaces: [h5, admin] # 本 run 实际用到的 surface
  browser: null # 可选摘要，如 "chrome+agent-browser-cli"
  deviceSerial: null # hs/adb serial
  deviceModel: null
  toolVersions: # optional map
    agent-browser-cli: null
    hs: null

# explore / 人工步骤流水；case 重放也可附记
journal:
  - at: 2026-08-11T07:30:05Z
    surface: h5
    kind: step # step | observe | ask | confirm | error
    summary: 打开首页
    evidence: [] # 相对路径

# 本 run 产生的 finding id 列表（文件在 findings/）
findings: []

# 结束时必填其一逻辑：passed=全部 case 非 failed/blocked；
# failed=至少一 case failed；blocked=环境/权限/工具；aborted=用户中止
summary:
  passed: 0
  failed: 0
  blocked: 0
  skipped: 0
  text: null # 可选一句话结论
```

### 状态机

```text
in_progress → passed | failed | blocked | aborted
```

- case 项：`pending → running → passed|failed|skipped|blocked`
- `skipped`：用户跳过或 pre 条件声明跳过
- 顶层 `status` 在 `finishedAt` 非 null 时不得为 `in_progress`

### 校验规则

| 规则             | 说明                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 目录与 id        | `id` 建议含目录名；不强制相等，但必须唯一                                                                                                              |
| projectId        | 必须等于当前 `project.id`                                                                                                                              |
| cases[].id       | 若非 explore 空跑，应存在对应 case 文件（explore 可只写 journal）                                                                                      |
| evidence 路径    | 只允许相对路径，且落在本 run 目录下，禁止 `..`                                                                                                         |
| 敏感值           | `error` / `journal.summary` / `summary.text` 不得写密码验证码 token                                                                                    |
| 结束             | `finishedAt` + 终态 + `summary` 计数一致（passed+failed+blocked+skipped = cases.length）                                                               |
| cases 为空       | explore 合法；计数全 0；顶层 status 由 journal/finding/用户中止决定：有 error 类 journal 或未解决阻断 → `blocked`/`failed`，否则 `passed` 或 `aborted` |
| 同时 in_progress | 禁止；由 active-run 单例保证                                                                                                                           |

### 最小合法例（进行中）

```yaml
schemaVersion: 1
id: run-20260811-1530-smoke
projectId: ydj
status: in_progress
trigger: manual
createdAt: 2026-08-11T07:30:00Z
startedAt: 2026-08-11T07:30:01Z
finishedAt: null
title: 冒烟
cases:
  - id: login-h5
    status: pending
env:
  surfaces: [h5]
journal: []
findings: []
summary:
  passed: 0
  failed: 0
  blocked: 0
  skipped: 0
```

见 `examples/run.yaml`。

### 显式不做（v1 run）

- 改写历史 run（只新建）
- 把完整 DOM/HAR 塞进 run.yaml（放大文件放 evidence/，yaml 只引用）
- 分布式/并发 run 状态合并

---

## finding.yaml（已定死）

Finding = 一次可观察问题记录（含尚未确认的）。**不是**工单系统；不强制工作流引擎。

- 路径：`findings/<id>.yaml`；`<id>` 必须等于文件内 `id`
- `schemaVersion` 只接受 `1`
- 未知顶层键：**拒绝加载**
- 证据优先引用 **run 目录内相对路径**（从项目根写：`runs/.../evidence/...`）；允许项目根下其它相对路径，禁止 `..` 与绝对路径
- 复测：不改历史叙述字段的「首次发现」语义；追加 `retests[]`，并更新 `status` / `updatedAt`

### 完整字段

```yaml
schemaVersion: 1
id: f-login-button-miss # required, ^[a-z][a-z0-9-]{1,63}$
projectId: ydj # required, 等于 project.id
title: 登录按钮偶发不展示 # required, 1–120 字
status: open # required: open | confirmed | fixed | wontfix | duplicate
severity:
  p2 # required: p0 | p1 | p2 | p3
  # p0 主流程阻断；p1 严重功能；p2 一般；p3 轻微/体验
confidence:
  observed # required: suspected | observed | confirmed
  # suspected=推断；observed=有证据未业务确认；confirmed=用户/业务确认是缺陷
surface: h5 # required, 主现 surface（须在 project.surfaces）
createdAt: 2026-08-11T07:31:00Z # required
updatedAt: 2026-08-11T07:31:00Z # required

# 溯源
runIds: [run-20260811-1530-smoke] # required, 至少 1 个；首次发现的 run 放第一个
caseId: login-h5 # optional, 关联 case；explore 发现可 null
duplicateOf: null # optional, 指向另一 finding id；status=duplicate 时 required

# 描述（禁止敏感明文）
summary: 点击登录后按钮消失且无跳转 # required, 1–500 字
stepsToReproduce: # required, 至少 1 条，面向人读
  - 打开 H5 登录页
  - 输入手机号与验证码
  - 点击登录
expected: 进入首页 # required
actual: 按钮消失，仍停在登录页 # required

evidence: # required, 至少 1 条（suspected 也至少 1：可为 journal 摘录路径）
  - runs/2026-08-11-1530-smoke/evidence/login-h5-after-login.jpg

# optional
env:
  note: 测试包 1.2.0 / Chrome # 短环境备注，非密

tags: [auth] # optional

# 复测历史；每次复测追加，不删旧项
retests:
  - at: 2026-08-12T03:00:00Z
    runId: run-20260812-1100-retest
    result: still_fail # still_fail | passed | blocked
    note: 仍复现
    evidence: []
```

### 状态语义

| status      | 含义                                           |
| ----------- | ---------------------------------------------- |
| `open`      | 新发现或仍存在，未结案                         |
| `confirmed` | 已确认为缺陷（通常 `confidence: confirmed`）   |
| `fixed`     | 复测 `passed`，认为已修复                      |
| `wontfix`   | 明确不修 / 产品如此（需 note 或 retests.note） |
| `duplicate` | 与 `duplicateOf` 重复                          |

建议流转（不强制状态机引擎，加载时只做合法枚举校验）：

```text
open → confirmed → fixed
open → fixed
open → wontfix
open|confirmed → duplicate
```

`confidence` 与 `status` 约束：

- `status: confirmed` 时 `confidence` 必须为 `confirmed`
- `status: duplicate` 时 `duplicateOf` 非空，且不得等于自身
- `status: fixed` 时 `retests` 至少一条 `result: passed`（v1 软提醒：实现应校验）

### 校验规则

| 规则             | 说明                                                    |
| ---------------- | ------------------------------------------------------- |
| 文件名           | `findings/<id>.yaml` 与 `id` 一致                       |
| projectId        | 等于 `project.id`                                       |
| runIds           | 非空；id 应存在对应 run（丢失 run 时加载 warn，不拒读） |
| surface          | 属于 project.surfaces                                   |
| evidence         | 相对路径、无 `..`、非绝对路径；至少 1 项                |
| 敏感值           | 各文本字段禁止密码/验证码/token/完整证件号              |
| severity         | 仅 p0–p3                                                |
| retests[].runId  | 非空字符串                                              |
| retests[].result | 仅三值                                                  |

### 与 run 的双向引用

- 创建 finding 时：写入 `findings/<id>.yaml`，并把 `id` **追加**到对应 `run.yaml` 的 `findings[]`
- 复测时：新建 run；finding 追加 `retests[]`；新 run 的 `findings[]` 也可列入该 id

### 最小合法例

```yaml
schemaVersion: 1
id: f-home-blank
projectId: ydj
title: 首页白屏
status: open
severity: p1
confidence: observed
surface: h5
createdAt: 2026-08-11T07:31:00Z
updatedAt: 2026-08-11T07:31:00Z
runIds: [run-20260811-1530-smoke]
caseId: null
summary: 打开 H5 后主区域空白
stepsToReproduce:
  - 打开 {{surfaces.h5.url}}
expected: 展示首页内容
actual: 主区域空白
evidence:
  - runs/2026-08-11-1530-smoke/evidence/home.png
retests: []
```

见 `examples/finding.yaml`。

### 显式不做（v1 finding）

- 指派人/截止日期/外部 Jira 同步字段
- 在 finding 内嵌整页 DOM 或视频 blob
- 自动关闭（必须复测或用户改 status）

## 分期（评审修订后）

| 期     | 交付                                                                                                                                                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | `test_setup`（三关完成定义）、`project.yaml`（h5/admin/app）、`test_run` + active-run、`test_shot`、explore→`map.md`（最小标题模板）、生成 **draft** case；操作靠 skill+CLI（open/device/ui/act 不包 tool）。**不做** stable 回归引擎、跨端 case 重放、miniprogram 自动化重放 |
| **P1** | stable case 重放、finding 全流程、证据与 summary 闭环；按需加薄 tool                                                                                                                                                                                                          |
| **P2** | ✅ 跨 surface 重放（步骤级 surface + ensure）、miniprogram opt-in、`test_secrets`、`test_open`/`test_device`                                                                                                                                                                  |

### P0 自动化范围

| surface     | P0                                                    |
| ----------- | ----------------------------------------------------- |
| h5          | 可测                                                  |
| admin       | 可测                                                  |
| app         | 可测（`hs`）                                          |
| miniprogram | **仅 explore 备注**；不进 regression；schema 字段保留 |

### map.md 最小标题模板（explore 必须落这些节）

```markdown
# 业务地图

## 模块

## 主流程

## 角色

## 待确认
```

## 评审修订摘要

1. P0 收窄：先打通 setup→explore→draft case；回归/跨端/小程序重放后置
2. Tools 仅 setup/run/shot；其余 CLI+skill
3. 补齐 active-run 单例、target 解析、setup 三关完成定义
4. 删除仓库内旧 extensions/skills/templates 草稿，只留 PRODUCT + examples
5. `bash` act 默认禁止（`defaults.allowBash: false`）

## 与现有仓库关系

P0 代码：`extensions/test`、`lib/`、`skills/`。安装：`npm i && pi install <本仓库路径>`。

## 已拍板

1. 多端：app + h5 + admin；小程序 fragile、P0 不重放
2. 可重复 cases；不继承 PiDeck
3. 安装确认后代装；setup 三关完成定义
4. Case = YAML + 可选 MD
5. project / case / run / finding schemaVersion 1 已定死
6. P0 仅 3 tool：setup / run / shot
7. active-run 单例；target 文案优先；allowBash 默认 false
