# @pickle-pee/genesis-cli

## 安装

```bash
npm install -g @pickle-pee/genesis-cli
genesis --version
genesis
```

## 发布目标

- npm 包名：`@pickle-pee/genesis-cli`
- 全局命令：`genesis`

## 职责

CLI 入口与模式分发。负责参数解析、确定运行模式（Interactive / Print / JSON / RPC），并将请求路由到对应的 runtime 和 UI 通道。

## 导出

- `main()` — CLI 启动入口
- `parseArgs()` — 命令行参数解析
- CLI 模式类型定义

## 依赖方向

- 依赖: `app-runtime`, `app-config`, `app-ui`
- 被依赖: 无（终端入口）

## 禁止事项

- 不实现具体工具逻辑
- 不管理复杂会话状态
- 不直接渲染 UI

## 验证

- `npx tsc --noEmit` 类型检查通过
