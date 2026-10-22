# 会话账单 · dsh-billing-capsule

**装完输入框底栏会多一个「账单」胶囊：实时显示当前会话按 DeepSeek 官方价目表（高峰 / 空闲双档）折算的人民币花费；点开可看四类 token 分桶与逐轮明细——不用再去平台后台对账。**

它在 DSH Web GUI 输入框底栏（`conversation.composer.dock`）的「会话统计 / token 用量 / 上下文」旁新增第 4 个项目，**不改动任何内置插件**。

> 能力分类：**界面与体验** ｜ 许可：**MIT** ｜ 价格：**免费**

## 截图

![会话账单：底栏胶囊与逐轮明细弹层](https://raw.githubusercontent.com/CKLYZZQ/DSH-plugin-Billing-Capsule/main/docs/screenshot.png)

底栏右侧的 `≈¥5.53 · 账单` 就是本插件；展开后可见四类 token 分桶（含该时段单价与小计）、计价模型、单价来源，以及逐轮明细。`≈` 表示该会话历史未全部加载，因此按整会话总量与当前模型估算。

## 安装

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-billing-capsule
```

Desktop 端：

```bash
dsh plugin --profile desktop add dsh-billing-capsule
```

### 从源码安装（不经过 npm）

```bash
dsh plugin --profile web add github:CKLYZZQ/DSH-plugin-Billing-Capsule
```

### 在界面里安装

侧栏 **Plugins（插件）** 页 → 安装 → 填 `dsh-billing-capsule`；或让 agent 用 `plugin_manager` 的 `install_bundle`，`target` 传包名、仓库地址或 tarball 绝对路径。

装完刷新页面，胶囊出现在「会话统计 / token 用量 / 上下文」右侧。卸载：Plugins 页取消选择，或 `plugin_manager` 的 `remove_bundle`。

## 它显示什么

- **胶囊**：会话累计花费，人民币两位小数；不足 1 分显示 `<¥0.01`；`≈` 前缀表示估算；价目表里没有的模型显示 `--`（绝不编造数字）。
- **弹层**：
  - 未缓存输入 / 缓存读取 / 缓存写入 / 输出 四桶的 token 数、该时段单价、小计；
  - 计价模型、单价来源与数据时间、高峰/空闲判定说明；
  - 逐轮明细（轮次、token、计价模型、时段、该轮花费），最新一轮在最上面。

## 计价规则

按 DeepSeek 官方价目表：**元 / 百万 tokens**，分**高峰**与**空闲**（空闲为高峰半价）。
高峰时段为北京时间（Asia/Shanghai）**周一至周五 9:00–12:00 与 14:00–18:00**，其余时段及周末按空闲。
官方表未列**缓存写入**单价，该桶按 0 计价（弹层中有说明）。

中国法定节假日未内置；如需精确，把日期加进 `cordis.patch.yml` 的 `holidays` 列表（`YYYY-MM-DD`），这些日期会按空闲计价。

> 金额为**估算参考**，用于随时判断花费量级，不是计费凭证。

## 精确性

| 情况 | 行为 |
|---|---|
| 已加载轮次带唯一模型路由，且其 token 合计等于整会话投影 | **精确**，逐轮分别计价 |
| 会话历史未全部加载（分页/压缩）或轮次缺少路由 | `≈`，按**整会话总量**与最近使用的模型估算（不会因分页而少算） |
| 切到非对话视图导致取不到逐轮数据 | `≈`，只按整会话总量估算 |
| 模型不在价目表内 | 该轮/该会话不计金额，弹层提示「单价未知」并列出 token |

会话总量始终取自 Harness 的整会话 `tokenUsage` 投影，逐轮数据只用于分摊，因此**不会因为历史未加载而少算总额**。

## 单价从哪来

1. 客户端的**内置基线**（来自官方价格页，当前为 2026-10-11 抓取）；
2. Host 半在插件激活时、以及每 `refreshHours` 小时，抓取官方价格页并解析，经同源路由 `GET /dsh-billing/prices.json` 提供给客户端；客户端每 6 小时拉取一次，拿到就覆盖基线；
3. `cordis.patch.yml` 里 `config.models` 的**手动覆盖**优先级最高。

抓取或解析失败不会影响使用：弹层会显示当前用的是哪一来源。官方改版导致解析失败时，按下面的「更新价格」处理。

## 权限与外部服务

- **唯一的对外网络请求**：Host 半抓取 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing/`（官方价格页），默认每 12 小时一次，可用 `refreshHours` 调整或关闭。除此之外不发起任何外部请求。
- **提供的本地接口**：`GET /dsh-billing/prices.json`（价格表）与 `POST /dsh-billing/refresh`（立即重抓），注册在 Harness 自身的 Web 服务上；默认 `loopbackOnly: true`，只回应 `127.0.0.1` / `::1`，只读价格数据，不返回会话内容。
- **不读取凭据**：不访问 API key、账号 token、cookie 或任何凭据存储。
- **无遥测、不上传**：没有任何回传代码；会话数据只在本机浏览器内读取与计算。
- **客户端只读**：只读 Harness 已有的 `tokenUsage`、`modelSelection` 投影与当前对话的逐轮用量，不写入任何会话事件。

## 配置（`cordis.patch.yml` 的 `config`）

| 键 | 默认 | 含义 |
|---|---|---|
| `priceSourceUrl` | 官方中文价格页 | Host 半抓取并解析的地址（解析器适配该页的中文表格结构） |
| `refreshHours` | `12` | 重新抓取间隔；`0` 表示不定时抓取（仍会在激活时抓一次） |
| `requestTimeoutMs` | `8000` | 单次抓取超时 |
| `loopbackOnly` | `true` | 只回应回环来源的 `prices.json` 请求 |
| `holidays` | `[]` | 按空闲计价的日期（`YYYY-MM-DD`，北京时间） |
| `models` | `{}` | 手动单价覆盖：`{"<model id>": {"cacheHitInput":{"peak":4,"idle":2},"cacheMissInput":{"peak":20,"idle":10},"output":{"peak":30,"idle":15}}}` |

例：给某个价目表外的模型定价

```yaml
        models:
          deepseek-chat:
            cacheHitInput: { peak: 0.2, idle: 0.2 }
            cacheMissInput: { peak: 2, idle: 2 }
            output: { peak: 3, idle: 3 }
```

## 真实输出

### 单元测试

```text
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

### 官方价目表解析结果（`GET /dsh-billing/prices.json` 节选）

```json
{
  "ok": true,
  "currency": "CNY",
  "unit": 1000000,
  "models": {
    "deepseek-flash": {
      "cacheHitInput": { "peak": 0.04, "idle": 0.02 },
      "cacheMissInput": { "peak": 2, "idle": 1 },
      "output": { "peak": 8, "idle": 4 }
    },
    "deepseek-v4-pro": {
      "cacheHitInput": { "peak": 0.3, "idle": 0.15 },
      "cacheMissInput": { "peak": 9, "idle": 4.5 },
      "output": { "peak": 27, "idle": 13.5 }
    }
  }
}
```

### 座位注册（Harness Inspect 实测）

```json
"occupants": [
  { "id": "activity", "order": 0, "active": true },
  { "id": "usage",    "order": 1, "active": true },
  { "id": "billing",  "order": 2, "active": true }
]
```

## 依赖与兼容

- 零 `dependencies`、零 `peerDependencies`、零 install script：不 import 任何 `@deepseek-ai/*`，因此不会触发 peer 版本拒绝，也不会产生待批准的构建脚本。
- `dsh.client.inject` 只声明激活顺序：目标 profile 需组合 `ui-conversation`（座位与底栏）与 `ui-chat`（逐轮数据）。缺 `ui-chat` 时降级为整会话总量估算；缺 `dsh-token-meter` 时不显示（拿不到会话总量）。
- Host 半的 `webServer` 是可选依赖；没有它时只用内置基线。
- 已在 DSH `0.2.0-rc.2` 与 `0.2.1-rc.2` / profile `desktop`（Desktop 端运行的 Web 表面）上验证座位注册与价格路由。

## 更新价格

官方改价后：

1. **等自动刷新**：Host 半会在 `refreshHours` 内重新抓取（也可 `POST /dsh-billing/refresh` 立即触发）。
2. **更新内置基线**（官网改版导致解析失败时才需要）：改 `client.js` 的 `BASELINE`，并跑 `node tests/fetch-fixture.cjs` 刷新 `tests/fixture-pricing.html`，按新页面改 `tests/pricing.test.js` 里的期望值。
3. **改别名**：官方改了模型名时，在 `client.js` 的 `ALIASES` 里加旧名到新名的映射，或在 `config.models` 里直接给该 id 定价。

## 开发与验证

```bash
node --check index.js; node --check pricing.js; node --check client.js
node --test tests/pricing.test.js tests/client.test.js
```

- `tests/pricing.test.js`：用 `tests/fixture-pricing.html`（官方页面的逐字节副本）验证解析器，含失败关闭用例。
- `tests/client.test.js`：桩化 `window.__ModuleLoader__` 与 `require`，直接测 `client.js` 暴露的纯函数（时段判定、分桶计价、别名、载荷校验、逐轮读取、精确/估算判定、金额格式化），不渲染 React。
- `tests/debug-dump.mjs`：排查官网改版时打印投影后的表格结构。

## 仓库

| 项 | 值 |
|---|---|
| 地址 | https://github.com/CKLYZZQ/DSH-plugin-Billing-Capsule |
| 可见性 | **公开** |
| 许可 | MIT（见 [LICENSE](LICENSE)） |
| 默认分支 | `main` |
| npm | https://www.npmjs.com/package/dsh-billing-capsule |
| git spec | `git+https://github.com/CKLYZZQ/DSH-plugin-Billing-Capsule.git` |

**仓库根即包根**：`package.json`、`cordis.patch.yml`、`index.js`、`client.js`、`pricing.js` 都在根目录，所以这个仓库本身可以直接当 git spec 安装。

> 仓库公开，任何机器都能直接克隆安装，**不需要 GitHub 凭据**。公开是**单向门**：即使之后改回私有，已产生的 fork、GitHub 缓存与搜索引擎索引也不会消失。

## 许可

本项目以 **MIT** 许可发布，见 [LICENSE](LICENSE)。

测试夹具 `tests/fixture-pricing.html` 是 [DeepSeek API 文档 · 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 页面的逐字副本，其版权归 DeepSeek, Inc. 所有，仅用于解析器回归测试，**不适用本项目 MIT 许可**。该文件仅存在于源码仓库，不包含在安装包中（`package.json` 的 `files` 未列入 `tests/`）。
