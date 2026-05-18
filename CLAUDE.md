# Development Workflow

本项目使用 **OpenSpec + Superpowers** 协同开发。

## 分工

| 工具 | 职责 |
|------|------|
| **OpenSpec** | 需求范围、proposal/design/tasks/spec 生成、验收标准、verify、archive |
| **Superpowers** | brainstorming、git worktree、writing-plans、执行开发、code review、TDD/debugging |

## 强制流程

任何非简单修改必须按此流程执行，**不得跳步**：

1. Superpowers **brainstorming** 澄清需求
2. OpenSpec 创建 change（生成 proposal / design / tasks / spec）
3. 人工确认上述文档后，Superpowers 创建 **git worktree**
4. 按 tasks.md 拆解执行计划，Superpowers 执行开发
5. 每完成一个任务即运行测试
6. Superpowers **code review**
7. OpenSpec **verify** → **archive**

## 禁止事项

- 无 OpenSpec change 不得开发中大型功能
- 不得一次性生成大量代码或自行扩大需求范围
- 不得跳过测试或 code review
- 不得在主分支直接开发复杂功能或混入未完成代码
