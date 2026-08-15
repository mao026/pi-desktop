---
name: test-web
description: 使用受控工具测试真实 Chrome 中的 H5 或管理后台。
---

# Web 测试

- 只使用 `test_observe` 和 `test_act`，不得调用 Bash、Electron Browser、JavaScript、CDP 或 Cookie 能力。
- `profileId` 和 `tabId` 只由 Main 从项目绑定中解析，Agent 不得指定；绑定失效时停止并请用户重新选择。
- 定位优先可见文案和无障碍名；结构变化后重新 `snapshot`。
- click/fill 失败时，先重新 `test_observe snapshot` 定位；禁止用 `test_act open` 猜 URL 开新标签页。
- `@eN` 仅用于当前 snapshot，不能进入 stable case。
- 登录凭据不进入工具参数；安全 pipe 能力完成前由用户在真实 Chrome 人工登录。
- H5 目标视口默认 390x844，管理后台默认 1440x900；实际 viewport 不符时不得声称已按目标尺寸验证。
- 只有项目已启用视觉检查并使用 `test_observe mode=visual`；截图会自动发给项目配置的视觉模型，主对话模型不需要支持图片，也不接收图片。密码、验证码、支付、证件和银行卡页面禁止发送截图。不确定时只标记疑似视觉问题。
