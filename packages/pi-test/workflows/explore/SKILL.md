---
name: test-explore
description: 探索已配置且就绪的测试端，维护业务地图并沉淀测试流程。
---

# 探索业务

1. 先用 `test_run` 开始 `trigger=explore` 的执行。
2. 只探索用户约定范围和 readiness 已就绪的测试端。
3. 用 `test_observe` 读取现场，用 `test_act` 执行受控原子动作。
4. 不确定输入、规则或预期时进入等待用户，不得猜测。
5. 生产环境只读；业务写入在 run 开始前确认，高风险动作临近执行时单独确认。
6. 结束时用 `test_run` 写入明确结果，不无限遍历。

业务地图、用例和问题由对应受控领域工具维护；普通会话不得直接读写 YAML 或 Markdown 文件。
