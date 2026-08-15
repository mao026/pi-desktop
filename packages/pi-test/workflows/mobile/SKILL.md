---
name: test-mobile
description: Android App 与微信小程序测试约束；受控移动端驱动尚待后续技术切片接入。
---

# 移动端测试

- 不得直接执行 `hs`、`adb` 或 Shell。
- 只通过 Main 提供的受控测试工具操作手机。
- Android App 只通过 Main 的固定 Handsets/platform-tools 驱动执行；微信小程序仍未实现，不得回退到通用工具绕过。
- 微信小程序始终标记 fragile，禁止进入普通 regression。
- 设备、USB 调试、锁屏或登录未就绪时归类为环境阻塞。
- 只有项目已启用视觉检查并使用 `test_observe mode=visual`；截图会自动发给项目配置的视觉模型，主对话模型不需要支持图片，也不接收图片。密码、验证码、支付、证件和银行卡页面禁止发送截图。
