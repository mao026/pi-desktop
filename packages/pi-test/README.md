# pi-test

Pi Test Desktop 的唯一测试领域 package。

```text
core/       project/case/run/finding 等纯领域逻辑
extension/  Agent tools adapter，只转发到 Main Test Coordinator
workflows/  第一方固定测试工作流
contract.ts Main/Agent 共用的类型化测试 RPC
```

`extension/` 不执行 CLI，也不直接读写项目资产。外部驱动和领域写入统一经过 Electron Main。

## 验证

从仓库根目录运行：

```bash
npm --workspace pi-test test
npm run typecheck
```

`/Users/m/workSpace/pi-extension` 仅是指向本 package 的本机兼容符号链接，不是第二份源码。
