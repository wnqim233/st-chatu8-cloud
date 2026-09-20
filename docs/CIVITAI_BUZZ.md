# Buzz 选择与 NSFW 换币

cloud.11 起，所有新提交的报价和生成请求都显式传入 `"tips": {"creators": 0, "civitai": 0}`，关闭 Creator Tip 和 Civitai Tip。无需更改参数 JSON。若平台报价返回非零或格式无效的小费，插件停止付费提交；若平台没有返回小费明细，界面会明确显示未返回，不将其说成已确认零小费。

官方 [OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json) 的 `WorkflowTips` 将这两个字段定义为 0 到 2 的小费比例，允许设为 0；响应 `WorkflowCostTips` 才是实际小费 Buzz 数额。接口没有注明“小费默认固定为 9”。基础生成费 `cost.base` 和资源授权费 `cost.fees` 不属于可选小费，仍需支付；关闭小费不代表整张图片免费。修改不能退回历史小费，已提交的工作流不受影响。

cloud.10 新任务默认只使用黄 Buzz，提前声明允许成熟内容；所有币种选择都显式使用 `upgradeMode: manual`。这能避免客户端让平台自动从蓝／绿升级为黄币，但不能保证某个模型始终只收 9 Buzz，也不能证明或退回历史重复扣款。

在「云端生图 → Civitai → 使用哪种 Buzz？」选择并保存：

| 选择 | currencies | allowMatureContent | 行为 |
| --- | --- | --- | --- |
| 仅黄 Buzz（默认） | `["yellow"]` | `true` | 从一开始用黄币结算，允许成熟内容 |
| 仅蓝 Buzz | `["blue"]` | `false` | 仅 SFW；不自动改扣黄币 |
| 仅绿 Buzz | `["green"]` | `false` | 仅 SFW；不自动改扣黄币 |
| 蓝＋绿 Buzz | `["blue","green"]` | `false` | 仅 SFW；余额可由这两种币支付，不使用黄币 |

所选币种余额不足时不会退回其他币种。蓝／绿支付后输出被判成熟，平台可能扣留图片；插件显示平台提供的扣留原因，不发送升级请求，也不自动重新生成。原任务的扣款与退款以平台账单为准。

报价与生成走同一个 `POST /v2/consumer/workflows` 请求构造器，免费报价额外带 `whatif=true`。币种随任务入队保存，之后修改设置不改变已有任务的币种。升级前已经提交的平台任务仍保留原支付规则；升级前尚未提交、没有币种记录的旧队列任务，在开始提交时使用当前保存的币种。

## 原建议哪些可信

2026-09-20 读取的 [官方 Payments 文档](https://developer.civitai.com/orchestration/guide/submitting-work.md) 确认：默认扣款顺序是蓝、绿、黄；只有黄币支持 NSFW；`allowMatureContent: true` 强制黄币；`manual` 要求显式更新后才换币；升级会退蓝／绿并扣黄。

因此，提前声明成熟内容、限制只用黄币并关闭自动升级的方向正确。但是「蓝扣 9 → 蓝退 9 → 黄扣 9」的合计净支出仍为 9，不能算成净扣 18。官方文档没有承诺 NSFW 固定翻倍，也没有承诺黄币报价一定等于原来的蓝币报价。此前代码没有传 `upgradeMode`，不能据此认定某晚一定触发了 automatic，更无法确认是两笔黄币实扣。

若需要确认历史双扣，按同一个 workflow ID 核对交易明细中的 `accountType`、`type`（`debit` 扣款、`credit` 退款）和 `amount`，分别计算每个币种的扣款减退款；再检查是否实际提交了两个工作流。插件现在保存并显示平台返回的交易和费用，历史账户账单仍需到平台核对。

按 [官方 OpenAPI](https://orchestration.civitai.com/openapi/v2-consumers.json)：

- `cost.factors` 是费用因子，`cost.fixed` 是固定附加项，`cost.fees` 是资源授权费，`cost.variable: true` 表示预扣上限可能在实际结算后退差额。展示原始明细，不自行把各字段再次相加计费。
- `transactions.insufficientBuzz: true` 时，插件在免费预估后停止提交。未返回该字段不等于已确认余额充足，最终提交仍可能被平台拒绝。
- recipe 的 imageGen 接口支持 `allowMatureContent` 查询参数，没有 `currencies`／`upgradeMode` 参数；本插件使用 workflow 接口。
- `ephemeral: true` 的结果只通过回调或同步等待获取，任务完成后 GET 返回 404。因此没有按原建议开启它，否则会破坏当前的轮询、恢复与账单核对。

## 验证边界

本次修改使用模拟接口验证支付请求、余额不足拦截、队列币种快照和被扣留图片的处理，不使用真实 Key 或提交付费生成。没有检查用户账户中的历史交易，不能把本次修改当作历史扣费原因的确认。
