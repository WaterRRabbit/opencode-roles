# opencode-roles

[English](./README.md) | **简体中文**

`opencode-roles` 是一个给 OpenCode 使用的角色插件。

它给 OpenCode 增加了一个新的能力：让模型在开始回答之前，先从一组你定义好的 `role` 里选择最合适的专家角色，再按需加载该角色对应的技能。

## 重要说明

这个插件支持通过 role 对 skill 做渐进式披露。

这点很重要，因为传统的纯 skill 方案，往往会把所有可用 skill 一次性暴露给模型。随着 skill 数量变多，大量与当前任务无关的 skill 也会同时进入模型的决策范围。

这通常会带来三个问题：

- 浪费上下文
- 任务路由变弱
- 相似 skill 之间更容易混淆

`opencode-roles` 的做法是先只暴露轻量的 role 元数据。只有当模型选中了某个 role，并且调用了 `role_load` 之后，这个 role 的完整说明和 role 专属 skill 才会继续披露出来。

实际效果就是：prompt 更干净、噪音更少，模型也更容易在正确的任务上使用正确的 skill。

这适合下面这类场景：

- 你希望前端问题总是优先按“前端架构师”的方式思考
- 你希望代码审查类任务总是按固定审查标准输出
- 你希望不同领域的问题使用不同的提示词和技能集合
- 你不想把所有领域指令都塞进全局 system prompt
- 你不希望大量 skill 一次性进入上下文造成混乱

## Role 是什么

在这个插件里，`role` 可以理解成一组面向某个领域或任务的“专家身份定义”。

一个 role 通常包含两部分：

- 角色说明：告诉模型“你是谁、你该关注什么、你该如何思考”
- 角色技能列表：告诉模型“这个角色可以使用哪些专属 skill”

例如：

- `frontend-architect`
- `backend-reviewer`
- `code-reviewer`

这和直接写一个普通 skill 的区别在于：

- skill 更像一个可调用的单独能力
- role 更像一个完整的工作视角或专业身份

role 先决定“用什么身份来处理问题”，skill 再决定“调用什么具体能力来辅助处理”。

## 这个插件做了什么

安装后，插件会做三件事：

1. 扫描你定义的 role，并把 role 的 `name` 和 `description` 注入到系统提示中
2. 提供一个 `role_load` 工具，用来加载某个 role 的完整说明
3. 提供一个 `role_skill({ name })` 工具来加载 role 专属 skill，并且不会覆盖 OpenCode 内置的 `skill` 工具

这样做的好处是：

- 模型能先看见有哪些可选 role
- 真正详细的 role 内容只在需要时加载，不会让 system prompt 过大
- 不同 role 可以拥有各自的 skill 集合
- 普通 skill 仍然可以照常使用

## 安装

在你的项目根目录创建或修改 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-roles"]
}
```

然后重新启动 OpenCode。

OpenCode 会按官方插件机制自动安装 npm 包。

## 最小目录结构

默认目录结构如下：

```text
.opencode/
  roles/
    frontend-architect/
      ROLE.md
    backend-reviewer/
      ROLE.md
    skills/
      react-performance/
        SKILL.md
      api-contracts/
        SKILL.md
```

约定很简单：

- 每个 role 一个目录
- 每个 role 目录下必须有一个 `ROLE.md`
- 所有 role skill 放在 `.opencode/roles/skills/<skill-name>/SKILL.md`

## ROLE.md 格式

每个 role 都必须有 frontmatter，并至少提供：

- `name`
- `description`

示例：

```md
---
name: frontend-architect
description: Design frontend architecture, component boundaries, and UI implementation strategy
---

You are the frontend architect role.

Focus on:
- component boundaries
- state placement
- rendering behavior
- maintainable UI structure

## Available role skills

- `react-performance`: Optimize React rendering, state boundaries, and unnecessary rerenders
```

要求：

- `name` 必须是小写连字符风格，例如 `frontend-architect`
- `description` 会暴露给模型作为 role 简介
- `## Available role skills` 这一节是可选的
- 如果写了这一节，那么其中列出的每个 skill 名称都必须能在 `.opencode/roles/skills/` 下找到对应目录

## SKILL.md 格式

role skill 和普通 skill 一样，使用 `SKILL.md`。

示例：

```md
---
description: Improve React rendering performance and state boundaries
---

# React Performance

Use this skill when reviewing React code for:
- unnecessary rerenders
- state placed too high in the tree
- unstable props or closures
- over-coupled components
```

## 如何使用

通常不需要你手动指定底层实现细节。插件启用后，模型会先看到有哪些可选 role，再决定是否加载某个 role。

一个完整流程通常是：

1. 模型先根据任务选择最合适的 role
2. 调用 `role_load({ name })`
3. role 被激活后，再调用该 role 对应的 `role_skill({ name })`
4. 最后按该 role 的工作方式输出结果

例如，你可以这样提问：

- “帮我设计一个 React 页面状态管理方案”
- “请用代码审查视角 review 这段改动”
- “帮我检查这个 API 设计是否存在兼容性问题”

插件会让模型更容易走到下面这种路径：

- React 架构问题 -> `frontend-architect`
- API 合同问题 -> `backend-reviewer`
- 代码审查问题 -> `code-reviewer`

## 推荐的 role 设计方式

一个好的 role，应该聚焦于一个明确职责，而不是把很多不相关能力塞在一起。

推荐这样设计：

- 一个 role 只负责一个领域或一类任务
- 在 role 里定义“关注点”和“输出风格”
- 把具体方法论拆到 role skill 里

例如：

- `frontend-architect` 负责前端架构判断
- `react-performance` 负责 React 性能分析

这样 role 和 skill 的职责边界会更清晰。

## 可选的额外 role 根目录

如果你不想把所有 role 都放在 `.opencode/roles` 下，可以在 `.opencode/roles/config.json` 中增加额外路径：

```json
{
  "paths": [
    ".shared/opencode-roles",
    "~/company/opencode-roles"
  ]
}
```

说明：

- 相对路径相对于当前工作区根目录解析
- `~/` 会解析到用户 home 目录
- 插件会合并这些目录中的 role

## 运行规则

这个插件的行为规则如下：

- system prompt 中只注入 role 的 `name` 和 `description`
- role 的完整正文不会提前全部注入，而是在 `role_load` 时按需加载
- role skill 必须先激活对应 role 才能使用，并通过 `role_skill` 加载
- OpenCode 内置的 `skill` 工具保持不变，仍用于普通 skill
- 如果某个 role skill 尚未激活，插件会提示先调用 `role_load`
- 多个 role 可以声明同名 role skill，因为 role skill 会被视为共享 skill 库

## 排错

如果插件看起来没有生效，优先检查这几项：

1. `opencode.json` 里是否已经配置了 `"plugin": ["opencode-roles"]`
2. OpenCode 是否已经重启
3. `ROLE.md` 是否包含合法 frontmatter
4. 如果写了 `## Available role skills`，其中列出的 skill 是否真的存在于 `.opencode/roles/skills/<skill-name>/SKILL.md`

常见错误：

- role 名称不是小写连字符格式
- 漏写 `description`
- `## Available role skills` 这一节格式写错
- role 引用了不存在的 skill
- 共享 role skill 明明存在，但在调用前没有先加载相关 role

## 最小示例

```text
.opencode/
  roles/
    code-reviewer/
      ROLE.md
    skills/
      review-checklist/
        SKILL.md
```

`ROLE.md`

```md
---
name: code-reviewer
description: Perform practical code review with emphasis on bugs, regressions, and missing tests
---

You are the code reviewer role.

Focus on:
- correctness
- regressions
- missing tests

## Available role skills

- `review-checklist`: Review code using a checklist for bugs, regressions, and missing tests
```

`SKILL.md`

```md
---
description: Review code using a checklist for bugs, regressions, and missing tests
---

# Review Checklist

When reviewing code, check:
- correctness under edge cases
- behavioral regressions
- missing tests for changed paths
```

## 安装后给用户的最终配置

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-roles"]
}
```
