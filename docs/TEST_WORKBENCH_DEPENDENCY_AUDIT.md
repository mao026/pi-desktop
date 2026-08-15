# Pi Test Desktop 依赖删除审计

状态：最小 Web 闭环与真实设备授权客户端完成  
日期：2026-08-12

## 结论

通用桌面能力跨 Main、Agent Host、Renderer、契约和测试，不能只隐藏 UI。独立 `sessionMode: test` 只加载 `packages/pi-test` 的固定 extension/workflows；当前工具恰好为 `test_setup`、`test_run`、`test_observe`、`test_act`、`test_map`、`test_case`、`test_play`、`test_finding`。因此删除通用能力时，不需要改写测试领域逻辑或放宽 Agent 权限。

## Browser

影响面：

- Main：`src/main/browser/**`、`BrowserService` 生命周期、证书/代理登录、Host capability snapshot。
- Host：`browser-tools.ts`、`browser-agent-runtime.ts`、`browser-capability-runtime.ts`、Host/Main `browser.*` RPC。
- Contract/Preload：`src/contract/browser.ts`、`PiBridge.browser*`、`desktop:browser:*`。
- Renderer：`BrowserDock`、授权弹窗、Browser 设置、AppShell 面板布局、MessageView 结果导航。
- Tests/scripts：Browser smoke、i18n/security/contract checks、Electron Browser E2E。

删除结果：Renderer Dock/授权/设置、Host browser tools、Main BrowserService、Browser IPC/契约和对应 E2E 已从当前工作树删除。Web 测试只保留 Main 中固定 `agent-browser-cli` driver 链路。

## Skills / Plugins

影响面：`DefaultResourceLoader`、`skills-service`、`plugins-service`、plugin worker、Host API、设置页和 `/reload`。

Skills/Plugins 管理 UI、服务、安装 API 和 plugin worker 已删除。Agent Host 的 general session 兼容 runtime 仍会通过 Pi `DefaultResourceLoader` 加载资源；测试 session 使用 `noExtensions/noSkills` 加显式第一方 extension/workflow 路径，不读取用户全局、项目第三方资源、prompt、theme 或 context file。

## Bash / 文件 / Git / Worktree

影响面：

- Bash/search/toolchain：`rpc-manager` general session 自定义工具、toolchain runtime、开发工具设置与 catalogs 仍保留。
- 文件：FileExplorer/FileViewer 和任意写编辑 API 已删除；Host 仍保留消息附件/Markdown 渲染使用的只读 `files.read/download` 兼容链。
- Git/Worktree：创建、删除、状态 API 和 UI 已删除；session 索引仍用 `shared/worktree` 归类历史会话元数据。

测试 session 使用 Pi SDK `noTools: "builtin"` 和固定工具 allowlist，不创建 Bash/search/Browser custom tools，也不能调用只读文件 Host API。恢复 session 时通过持久化 marker 强制保持 test mode。`packages/pi-test` 已删除旧 `replay/setup/open/shot/cli` 直接 spawn 链路和 case `bash` act。

## Channels

影响面：`src/agent-host/channels/**`、Host handlers、Main channel credential vault/RPC、Renderer Channels 设置和快速绑定、会话消息来源渲染。

Channel adapters、session bridge、凭据 RPC、管理 UI 和绑定入口已删除；仅保留读取旧 session channel marker 的兼容展示代码。测试 session 不加载 channels，Main Test Coordinator 也不暴露 channel 入口。

## Git 状态与迁移源

- `pi-desktop` 开始时只有未跟踪的 `docs/`。
- 原 `/Users/m/workSpace/pi-extension` 不是 Git 仓库，无法审计提交或工作树差异。
- 该目录已物理移动到 `packages/pi-test`，原路径仅保留指向新 package 的本机符号链接；不存在两个可编辑副本。

## 首个工作包边界加固（2026-08-12，macOS）

在首包验收中补齐以下边界：

- Main 对 `test_run`、`test_observe`、`test_act` 和 `test.sessionEnded` 执行严格运行时校验，拒绝未知字段、错型字段和未声明动作。
- `agent-browser-cli` 的用户目标和值统一放在 `--` 后，不能被解释为 `--help`、`--clear` 等 CLI 选项；子进程仍由 Main 以 `shell: false` 和固定超时/输出上限执行。
- 测试会话拒绝 channel turn、channel command 和 fork；`set_tools`、reload、恢复 session 后仍只有三个固定测试工具和三个固定 workflow。
- 测试 session 销毁或 Agent Host 停止时，Main 将当前 run 标为 `aborted` 并释放租约；Main 重启后，同一项目再次执行前会将遗留 active run 标为 `aborted`。
- 全局租约同时绑定 project ID、规范化项目根目录和 session ID；同 ID 项目目录不能借用另一个项目的租约。
- 只读搜索框填写不再被一律提升为业务写入；危险和写入关键词仍只能提升风险，不能降低风险。
- project schema 拒绝带内嵌用户名或密码的 URL，避免凭据进入 `project.yaml`。
- Web workflow 明确禁止 Agent 指定 `profileId`/`tabId`，只允许 Main 从项目绑定解析。
- core 拒绝 active-run、run/case/finding ID 和 finding evidence 的目录穿越或 Windows 反斜杠路径绕过。

macOS 已通过 `pi-test` selfcheck/9 个 package 测试、受限 session 集成测试、channel 隔离测试、TypeScript、ESLint、契约覆盖、桌面安全检查、Pi 0.84 兼容检查、生产产物检查和完整构建。仓库完整测试 470 项中 469 项通过；唯一失败是既有 `session-list` 测试的固定 UTC 时间在当前本地时区跨日，与本工作包无关。以下 Windows/真实 Chrome 能力按后文状态真机验证。

## 最小 Web 闭环（2026-08-12）

- 专用测试工作台已成为首屏，提供最近项目、新建/打开项目、项目内工作台/业务地图/测试用例/执行记录/问题五个入口。
- Renderer 只调用固定 preload IPC；项目 YAML、run journal、证据、Finding、Chrome CLI 和绑定状态仍由 Main 与 `packages/pi-test` 唯一 core 管理。
- 项目浏览器绑定按规范化 project root、project ID 和 surface 持久保存；唯一 Profile/唯一普通 tab 自动绑定，多 tab 由用户显式选择。`open` 返回新 tab 后由 Main 更新绑定。
- “开始测试”确定性执行 `start -> open -> text observe`；工作台支持重新感知、截图留证、证据预览、记录本地问题和结束 run。Agent 对话固定创建 `sessionMode: test`，测试模式 UI 不展示文件附件、`@`、Slash、通用工具权限和压缩控件。
- `observe/open/click/fill/wait/shot` 写入当前 run journal；截图输出路径由 Main 生成，只允许写入当前 run evidence 目录。证据预览和 Finding 创建会再次校验证据相对路径、类型、存在性和 10 MB 上限。
- 业务写入/高风险动作使用 Electron Main 原生确认；填写值不进入确认文案。生产环境只允许 `open`、`observe`、`wait` 和 `shot`，包括声明为 read 的 `click/fill` 也拒绝。
- Workbench 状态提供最近项目注册表；仅在本次在线授权成功后，Main 才扫描已知项目并将遗留 active run 标为 `aborted`，未授权只读启动不写项目。绑定仍严格隔离同 ID 的不同项目目录。
- 真实设备授权客户端已实现：首次启动生成 Ed25519 身份，私钥经 Electron `safeStorage` vault 保存，公钥哈希形成完整 fingerprint/短授权码；Main 从构建时固定 HTTPS origin 读取 `licenses/<fingerprint>.json`，验证规范化 payload 的独立 Ed25519 签名、设备绑定、issuedAt、feature、最低桌面版本及 active/revoked 状态。
- 每次启动在线检查、持续运行 24 小时刷新、手动重试和 signed cache 展示已贯通；缓存永不离线放行。404、网络错误、重定向、超时、过大响应、无效签名、撤销和版本不兼容均进入只读。授权丢失时当前浏览器原子操作可完成并写 journal/证据，随后 run 标为 `aborted`。
- 未授权时不启动 Agent Host、不发 Renderer Host MessagePort、不创建 Agent session、不检测 Chrome、不允许新建项目；仍可打开已有项目、查看 run/Finding/证据、复制短码和完整 fingerprint、手动重试和使用更新入口。开发闭环仍只由 `npm run dev` 显式注入 `PI_TEST_LICENSE_BYPASS=1`，UI 标记为开发旁路。
- 本地 authority 生成和 active/revoked JSON 签发脚本已提供；管理机 authority 已生成在仓库外的 `/Users/m/.pi-test-license-authority`，私钥权限为 `0600`，只按显式绝对路径读取，不进入仓库、客户端、CI 或 OSS。`pack`/`dist`、macOS 签名脚本和 tag CI 在公开配置缺少或误配固定 HTTPS origin/Ed25519 公钥时失败；信任根构建时内联，运行环境变量不能替换。
- 正式公开信任根已固定为 `https://shenzhen-agent.oss-cn-shenzhen.aliyuncs.com/` 和管理机 authority 的 Ed25519 公钥，仓库公开配置为 `config/device-license-public.json`；OSS 根目录返回 403（不可列目录），不存在的精确 license 对象返回 404。真实私钥签发的临时 active JSON 已由同一公开公钥验签通过，私钥材料扫描确认未进入仓库。
- 已通过 14 项 `pi-test`/Workbench 测试、15 项授权/网络/vault 边界测试、受限 session/channel 测试、TypeScript、ESLint、契约覆盖、64 条桌面安全检查、Pi 0.84 兼容检查和完整生产构建。隔离 Electron 在 1280x808 视口验证未配置构建只读首屏与授权详情无溢出、Host 未启动；配置构建确认固定 HTTPS origin/公钥已内联且运行时变量名/私钥均未进入 Main bundle。
- macOS 真实 Chrome 闭环已使用固定 `agent-browser-cli 0.3.7`、扩展 `2.1` 和 Chrome `151.0.7922.109` 完成：工作台通过 Main 执行 `start -> open -> text observe -> snapshot -> shot`，正文返回 Example Domain，结构返回 `RootWebArea`/`@e1`，1200x815 PNG 可在 UI 预览，Finding 成功关联证据，最终 run 为 `passed` 且 active-run 已清除。验收项目保留在 `/Users/m/workSpace/pi-test-web-e2e`。
- 真实闭环发现并修复 `open` 后新 tab 尚未连接的竞态：Driver 现在用 `lookup tab` 有界等待精确 Profile/tab；同时拒绝退出码为 0 但顶层 `ok:false` 的 CLI 业务失败，并从成功 JSON 中提取真正的 `result.content`/`result.tree`。
- 修复 tsup watch 共享 `out/main` 的互删问题：Main 与 Agent Host config 均不在 watch 重编时清目录，开发和 production build 只在首次并行构建前统一清理一次。

## 删除残留复核（2026-08-13）

- Browser Dock、Browser Agent tools、Skills/Plugins 管理、Channels、Git/Worktree UI 及其主要实现已经从当前工作树删除；专用 Renderer 首屏只创建 `sessionMode: test`。
- 修复删除 Plugin worker 后遗留的 `tsup` entry；production build 现在只生成 `main.js`、`agent-host.mjs` 和 preload/Renderer，不再寻找或产出 `plugin-worker.mjs`。
- Smoke 已改为验证只读设备授权下的专用工作台首屏、固定测试 bridge、Host RPC 和工具链 revision；不再通过已删除的 Git/Worktree、Skill/Channel、任意文件下载或 HTML preview 能力验收。
- `packages/pi-test` selfcheck/14 个 package 测试、受限 session 集成测试、TypeScript、ESLint、契约覆盖、桌面安全、Pi 0.84 兼容、生产产物、production build 和 Electron smoke 通过。全仓 261 个测试中 260 个通过；唯一失败仍是既有 `session-list` 固定 UTC 时间在当前本地时区跨日，与测试工作台无关。

## Chrome 资产产品化（2026-08-13）

- 唯一上游固定为 npm provenance 包 `@sleepinsummer/agent-browser-cli@0.3.7` 和 source commit `bfcd4f3c94e7c9a007c8f05290cfffdb7ab4d8dd`；基础包和四个平台原生包均记录固定 URL、字节数和 SHA-256，构建期使用现有安全 tar 解压器校验。
- 构建产物按目标只包含私有 CLI 与 manifest；扩展从同一固定基础包提取，应用最小 popup 覆盖并生成逐文件 SHA-256 manifest。Popup 不再读取、显示或复制 Cookie，受控 Agent 工具仍不暴露 Cookie 命令。
- 扩展保留上游数字版本 `2.1`，以 Chrome `version_name` 和 Bridge status 暴露产品安全版本 `2.1-pi-test.2`；未加载该安全版本时 Web readiness 为 false。`.2` 将全部 WebSocket 发送集中到仅允许 `OPEN` 状态的 `sendWs()` 门禁，修复 Chrome 首次加载扩展时 `CONNECTING` 竞态。
- Main 启动前校验 packaged CLI/扩展的精确文件列表、大小、SHA-256，以及 macOS CLI 的 Mach-O code digest；缺失、过期或篡改的私有副本会从只读 packaged 资源原子替换。运行中只额外允许上游 daemon 创建的零字节普通文件 `.agent-browser-cli.lock`，其他残留继续拒绝，避免把正在运行的同版本 CLI 误判为需要替换。Windows 使用 `%LOCALAPPDATA%\PiTestDesktop` 稳定目录，Chrome 不引用版本化安装目录。
- Workbench 在扩展未连接或版本不符时显示安装/更新入口：Main 写入固定扩展路径到系统剪贴板，并只从固定 Chrome 安装位置打开 `chrome://extensions`；Renderer 不能提供路径、URL 或可执行文件。状态每 5 秒自动重检，不能由用户手工声明成功。
- `electron-builder` 已将目标 CLI 和补丁扩展列为 `extraResources`。Production artifact gate、42 条桌面安全检查和 packaged verifier 均要求这些资产存在且完整；packaged startup 报告同时要求 CLI `0.3.7` 和扩展 `2.1-pi-test.2`。
- macOS arm64 unpacked 包已通过完整 packaged verifier：production 应用启动、私有目录部署、CLI `--help` 执行、扩展逐文件哈希和启动报告均通过。新 Windows x64 安装包的首次安装/覆盖更新、Chrome 重新加载和 SmartScreen 行为仍待 Windows 真机验证。

## Android 受控驱动技术切片（2026-08-13）

- 固定 Handsets `0.1.38`（commit `dbf8fe0484a566695cfdfaf952e41f700e6850ed`）Windows x64 ZIP 和 Android platform-tools `37.0.1` Windows ZIP；构建期只从固定上游提取 `hs.exe`、`hs.jar`、`LICENSE`、`VERSION`，生成逐文件 SHA-256 manifest。
- Windows Main 将 Handsets 原子部署到 `%LOCALAPPDATA%\PiTestDesktop\test-android`；缺失或篡改会从只读 packaged 资源修复。platform-tools 仅在用户通过 Main 原生确认后，从固定产品 HTTPS 路径下载并校验固定大小/SHA-256，保留 `adb.exe`、两个运行 DLL、`NOTICE.txt` 和 `source.properties`，不修改系统 PATH 或静默安装 USB 驱动。
- Mobile driver 仅提供设备枚举、连接、前台 package、UI、启动、点击、填写和截图。Main 只执行固定绝对路径和固定 argv 形状，不回退系统 ADB，不向 Renderer/Agent 暴露 `hs shell/do/fan/tui`、任意 ADB 参数或 shell 文本。敏感填写仍强制人工完成。
- 项目可创建 App surface，并在工作台完成组件准备、设备选择、连接截图和前台 App 确认；Coordinator 已支持 App `open/observe/click/fill/shot`，共用授权、全局租约、风险确认、run journal 和 evidence 目录。miniprogram 仍明确返回 `NOT_IMPLEMENTED`。
- Android 资产、driver 固定 argv、多设备连接 fallback 和 Coordinator App 路由已有最小测试；TypeScript、ESLint 和 `pi-test` package tests 通过。Production gate 和 packaged verifier 要求 Windows 包精确携带并执行 `hs.exe --help`，macOS/Linux 包不得携带 Android 二进制；packaged startup 要求 Windows 私有 Handsets 部署成功且不得静默安装 platform-tools。
- 上述代码与静态/模拟验证不能替代 Windows 真机。私有 `adb.exe` 识别手机及 `hs use -> ui -> tap -> see` 保持待 Windows 真机验证。

## 风险确认与人工接管状态机（2026-08-13）

- 现有 `run.yaml` 增加可选 `control` 字段；旧 run 缺少该字段时按 `running` 只读兼容，不新增第二份状态文件。状态由 Main 在 `running / pause_requested / takeover_requested / paused / waiting_for_user / resuming` 之间转换。
- `test_run` 在保持单一 Agent 工具的前提下增加 `pause / takeover / resume`。暂停请求可在当前原子步骤执行时登记，Main 等该步骤结束后截图并转为 `paused`；同时发起的其他 observe/act 会返回 `TEST_BUSY`，driver 不会并行执行。
- 人工接管转为 `waiting_for_user` 后 Main 拒绝所有 observe/act，run 和全局租约保持。登录、验证码、扫码和授权原因强制按敏感现场处理，接管前后不截图；恢复时强制重新 snapshot，Web 不复用旧 `@eN`，App 重新校验前台 package 后才回到 `running`。恢复失败保持原暂停/等待状态。
- 业务写入必须在 `test_run start` 声明 `surface + risk=business_write`，由 Main 原生弹窗在 run 创建前确认，并仅对该 run/surface 持久有效。未预授权的业务写动作不能临时补确认；高风险动作继续每次临近执行单独确认；生产环境不能开始业务写入 run。
- Workbench 提供“步骤后暂停”“人工接管”“我已完成/继续测试”，显示持久 control 状态。控制 IPC 仍转发既有 `test.run`；Renderer 不持有确认或状态转换权。

## 项目身份与凭据 vault（2026-08-13）

- Workbench 可新增、编辑和删除项目身份，配置适用 surface 与各 surface 默认身份；元数据由唯一 `packages/pi-test/core/project.ts` 原子写入 `project.yaml`。
- 账号密码只通过受信 Renderer -> Main IPC 写入 Electron `safeStorage` vault，key 固定为 `test:project:<projectId>:identity:<identityId>`。Renderer 和 Agent 只得到 `credentialConfigured`，没有读取账号、密码、vault key 或密文的 API；身份列表检查 entry 是否存在时也不解密秘密。
- 删除身份通过 Main 原生确认，先删除 vault entry 再删除项目元数据；编辑时不回填凭据，留空保持原凭据，成对填写才覆盖。项目 YAML、Workbench 返回值和 Agent `test_run` 脱敏身份状态均不包含秘密。
- 自动秘密填写仍未启用。安全 stdin/pipe 完成前，登录、验证码和其他敏感输入继续使用人工接管，凭据不会进入 `agent-browser-cli`/Handsets argv、模型上下文或 run journal。

## 多测试端与项目生命周期（2026-08-13）

- 新建和项目设置可在同一项目选择 H5、管理后台和 Android App，Web URL 允许暂缺并继续由统一 readiness 判定；App 保留已确认 package/device。移除被身份引用的 surface 会被 core 严格校验拒绝，移除 Web surface 会同步清理旧 Profile/tab binding。
- 项目名称、环境和 surface 配置由唯一 `packages/pi-test/core/project.ts` 原子更新；当前有 active run 时 Main 拒绝修改。跨端项目无需手改 YAML。
- 工作台注册表兼容旧 `recentProjects: string[]`，现持久化归档状态。归档/恢复只改注册表；“仅从工作台移除”只移除注册表和 binding，均不触碰项目目录或 vault。
- “删除本地项目数据”要求 Renderer 输入完整项目名，Main 再展示用例、run、finding、证据文件数/字节数和远端禅道 Bug 不受影响的原生确认。只有 Electron `shell.trashItem` 成功后才清理项目身份 vault 与注册表；产品路径不直接永久删除目录。

## 领域工具与确定性回归（2026-08-13）

- 专用 session 固定工具扩为 `test_setup/test_run/test_observe/test_act/test_map/test_case/test_play/test_finding`；extension 仍只转发类型化 Host RPC，不读写项目文件、不 spawn CLI。Main 是 setup doctor、领域写入、重放、租约、风险和证据的唯一边界。
- 业务地图只允许读写四个固定章节；case/finding 使用结构化字段并复用唯一 core。领域 mutation 要求当前 session 持有 active run；Renderer 的机械用例状态操作经 Main 直达同一 core。
- draft 可手工重放一次以形成成功历史；`regression` 只接受 stable，disabled 与 miniprogram 均拒绝。stable 晋级要求至少一条 case passed run，且继续拒绝临时 `@eN`。
- runner 支持 Web/App 固定 open/tap/fill/wait/swipe/shot/ui、跨 surface 步骤、文本/URL/package 断言、失败截图、run case 状态、暂停/接管/恢复。App swipe 只产生固定 Handsets argv；Web case 导航限制为项目入口同源。
- capture 只存在当前 case 执行内，使用一个捕获组的受限正则；值不写入 run/journal。秘密 `{{input.*}}` 不自动填充并转为人工接管要求。UI 结构证据只允许当前 run evidence 中的 `.txt`，工作台按纯文本预览。
- 明显视觉异常检查复用 `test_observe mode=visual`，不新增工具。项目默认关闭，首次开启经 Main 原生确认；adapter 在 Main 调用前检查模型 image 能力。Main 先读现场并在敏感页截图前 fail closed，非敏感 PNG 才作为 run evidence 和 Pi image block 返回；tool details 不含 base64。

## 禅道现代 REST 闭环（2026-08-13）

- Main 新增固定 `/api.php/v1` 客户端，已按禅道官方源码核对 `tokens/ping/configurations/products/modules/releases/users/options/bug/bugs/files` 路由。Electron transport 拒绝重定向，限制 15 秒和 2 MB JSON/响应，DNS 与 URL 均阻止 loopback、链路本地和组播目标；HTTP 内网连接需 Main 原生警告确认。
- 全局连接元数据只保存 ID、名称、基础地址、目录与 capability；Token 只写 Electron `safeStorage` vault 的 `test:zentao:<connectionId>:token`，并与规范化基础地址绑定，地址变化必须重新认证。账号密码仅用于 `POST /tokens` 换取 Token 后立即丢弃。项目 YAML 只保存连接 ID、产品、模块、`openedBuild` 和默认指派。
- 连接验证要求 `/ping` 和受保护产品目录同时成功；产品、模块、发布、用户、Bug 选项和自定义必填字段分别探测。Bug 创建、附件和备注独立 fail closed；官方开源现代 REST 未可靠提供备注入口，因此默认显示不可用，不能由连接成功推断写能力。
- Renderer 提供全局连接、项目映射和 finding 远端状态；Bug 提交使用用户可编辑的预填表单，并由 Main 原生二次确认。Main 每次提交重新读取目录/capability，固定 `Pi-Test: <project>/<finding>` 标识，超时或错误后先查重；本地 finding 保持事实来源，刷新远端状态不覆盖本地状态。
- PNG/JPEG/TXT 证据沿用既有 realpath/symlink/单文件 10 MB 校验，并限制一次最多 20 个、总计 50 MB。附件先经 `/files?uid=...` 上传，再通过 Bug `uid` 关联并重新读取 Bug 验证文件 ID；失败保留已创建 Bug，只有 404/405 或关联验证失败才把附件 capability 降为不可用，临时断网/超时仍可重试。复测备注只有真实写入后可从 action 读回标识才标记支持，且从不自动关闭远端 Bug。
- Agent 测试 session 仍只有既定 8 个领域工具，没有新增禅道工具；所有连接、项目映射和远端写入只经受信 Renderer -> Main IPC。

## 发布前边界

当前测试 session 的资源与工具已 fail closed，但 Agent Host 仍保留 general session 兼容 runtime、只读消息附件文件访问和开发 toolchain 代码。测试 session 和可加载第三方 extension 的 general session 共用一个 Agent Host 进程，而 Main 的 `host-rpc` 信任该 Host。物理删除 general runtime 的第三方 Extension/Plugin 动态加载能力前，不能把 session allowlist 宣称为对 Host 内恶意扩展的进程级隔离。

## Windows 真机验证（2026-08-13）

已在 Windows 11 Pro x64 build 26200 上验证：

- 固定正式 OSS origin/Ed25519 公钥和真实设备授权客户端的当前 NSIS x64 包已通过单目标静态校验、远端哈希校验、当前用户静默覆盖安装和正常 GUI 启动。`Pi-Agent-Desktop-Setup-0.1.7.exe` SHA-256 为 `8baaa0b75b6e6e6b673624618b3488dbe974cb469698b961f04c6957652cef8e`，大小 139245624 bytes；安装后的 EXE SHA-256 为 `6aa7c780ece8fea709040677f13999b8e9c723ee172c86a1ee76eb9e1bee046f`，ASAR SHA-256 为 `094f34078309c14e0767d7080691c7e6b509f2055116ebaa2cfa9af71ff1eeb5`，与本地 `win-unpacked` 完全一致。
- packaged startup 报告为 `ok: true`：Renderer、Agent Host、Pi `0.84.0` 和 Host/Main revision 同步通过。
- bundled `ripgrep 15.2.0`、`fd 10.3.0` 在 Windows 直接执行成功，文件大小和 SHA-256 与 manifest 一致。
- 通过真实 Renderer -> MessagePort -> Agent Host 创建 `sessionMode: test`：当时验收包工具恰好为 `test_run`、`test_observe`、`test_act`，三个固定 workflow 从安装包 ASAR 加载，未加载 Bash、文件、Git、Electron Browser 或第三方资源。当前源码已扩为 8 个固定领域工具并通过本机 runtime 隔离测试，待 Windows 新包复验。
- 正常运行期间无 WER 崩溃文件或 Application 严重事件；开始菜单和桌面快捷方式目标正确。Windows 打包首屏为 Pi Test 工作台，1264x775 视口无溢出、Renderer Console 无异常。
- 当前打包版已生成稳定设备身份并在线检查固定 OSS；目标设备 fingerprint 为 `a2a9bebeabd3534ee759e826639485f67a81ff89c30e9187f77d9764eaef77b7`，短码为 `A2A9-BEBE-ABD3-534E`。OSS signed active 对象已上传，独立公钥验签通过；Main 返回 `phase=authorized`、`readOnly=false`，正常重启后授权缓存再次在线刷新为 active。当前 OSS 对象的 license ID 为字面值 `lic-YYYYMMDD-001`，后续签发应改用实际日期编号。
- `agent-browser-cli 0.3.7` 的 Windows x64 原生二进制可在无 Node 环境中运行，CLI SHA-256 为 `f70762826b76f19a148f75092c0a37553b1fd6e1a42258ae3a4bdcd1a8d5ba8d`。本轮隔离 Chrome Profile 中重新验证 `status` ready、`scan` 返回 Example Domain 正文、`snapshot` 返回 `RootWebArea`/`@e1`，`screenshot` 写入有效 929x861 PNG。
- CLI 已迁移到 `%LOCALAPPDATA%\PiTestDesktop\toolchains\agent-browser-cli\0.3.7\win32-x64`；Main 的 Windows 路径解析已同步修正并由单测覆盖，不再使用 Electron `%APPDATA%` userData 目录。
- 上游扩展固定为版本 `2.1`，当时仅在验收资产中应用最小 popup 补丁，删除 Cookie 展示、自动读取和复制逻辑；Chrome 中实际加载路径为 `%LOCALAPPDATA%\PiTestDesktop\chrome-extension\tmwd_cdp_bridge`。该手工验收随后已产品化为 `2.1-pi-test.1`，见上文。
- 真实 Chrome `151.0.7922.109` 中扩展 ID 为 `enhnoogpimelpjagbammgddcalnpdgkp`，`agent-browser-cli status` 报告 extension connected、版本 `2.1`、唯一 profile 和 1 个普通网页 tab，`doctor` 全项通过。
- daemon API `18767` 和扩展桥 `18765` 均只监听 `127.0.0.1`。对 `https://example.com/` 的 `tabs`、`scan --text-only` 和 `snapshot` 均成功，返回显式 profile/tab ID、页面正文和可操作元素树。
- Windows SSH 非交互会话中，首次触发 daemon 的 `restart`/`tabs` 可能因子进程句柄继承而不退出；daemon 实际已启动，后续独立 `status`/`tabs` 正常退出。此上游生命周期缺陷不影响固定超时的 Main adapter，但仍应在正式工具安装流程中监控。

仍待验证或实现：

- 在 Windows 新安装包验证产品化后的 `0.3.7` CLI、`2.1-pi-test.2` 扩展首次安装、同路径原子更新、Chrome 重新加载检测，以及 SmartScreen/企业策略行为。
- 当前目标 Windows 设备的 signed active OSS 授权已验证；后续新设备仍需按完整 fingerprint 签发并上传对应对象。
- Windows packaged 授权闭环已通过：固定 `agent-browser-cli 0.3.7`、扩展 `2.1` 和完全隔离 Chrome Profile 完成 `create -> bind -> start -> open -> text observe -> snapshot -> shot -> evidence preview -> Finding -> finish`。正文返回 Example Domain，结构包含 `RootWebArea`/`@e1`，929x861 PNG有效，P3 Finding引用同一证据，最终 run为 `passed` 且 active-run已清除。项目留档于 `/Users/m/workSpace/pi-test-windows-authorized-e2e`；Windows隔离 Profile、daemon、调试端口、计划任务、临时项目和 Workbench recent/binding记录均已清理，普通 GUI保持授权且 Host ready。
- 新 Android 切片的 Windows 包内 Handsets 私有部署、platform-tools 确认下载、`adb.exe` 设备识别、USB 驱动和 `hs use -> ui -> tap -> see` 真机闭环。
- 真实公司禅道版本、自定义必填字段、附件关联和备注 capability 的端到端验收；现代 REST 实现、能力探测和 fail-closed 写入链路已完成。
- 小程序驱动和账号秘密安全 pipe 自动填充等后续工作；人工接管、确定性回归 runner 与禅道现代 REST 闭环已实现。Electron Browser、Skills/Plugins、Channels、Git/Worktree 的主要实现和 UI 已删除，剩余隔离边界见“发布前边界”。
