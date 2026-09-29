# 把 Validator / Delegation 索引并进 0g-scan-backend：计划

状态：一期代码已实现，尚未在真实库和链上跑过（2026-09-29），见文末"一期实现说明"

## 背景

- Xangle 交接的 `x-back-0g-indexer`（Java + Mongo）负责索引 0G 的 validator 和 delegation 数据，服务交接的 `0g-explorer` 前端。我们不打算再维护一套 Java/Mongo 栈，改为在 scan-backend 里实现同样的能力。
- 合约源码在 `common/contracts/gravity/`。
- 另一个参考实现：`0glabs/0g-reth-exex-template`（Rust reth ExEx + SQLite），其事件解码、创世 validator 数据、backfill 工具可对照，结论见附录 D。
- 参考实现的细节整理自 Xangle 交接包，下文称"Xangle"。
  - 注意：交接源码里**没有应用** `0g_self_delegation_fix(26.07.13).patch`。

## 目标 / 非目标

**目标**
- 覆盖 Xangle validator 部分的全部 8 个查询接口：summary、list、detail、某 validator 的委托人列表、委托交易列表、某委托人委托的 validator 列表，以及两张图表。
- 数据在 scan-backend 自己的 MySQL 里，由现有 sync 进程维护。
- 修掉 Xangle 实现里已知的正确性问题（见附录 B）。

**非目标（本期）**
- Storage 部分（submission / miner / reward）。
- 历史快照：比如某天某 validator 的 tokens。一期只存当前状态和事件流水，每日快照放二期。
- 链上写操作。钱包的 delegate / undelegate 由前端直接发交易，后端不参与。

## 合约要点（决定方案的几条）

| 事实 | 出处 | 对方案的影响 |
|---|---|---|
| Staking 合约 `0xea224dBB52F57752044c0C86aD50930091F561B9`，写死在 validator 合约里 | `ValidatorContract.sol:17` | 默认值写进 `Template.ts`，允许用配置覆盖 |
| 每个 validator 是 Staking 用 CREATE2 部署的 BeaconProxy，地址由 pubkey 决定 | `StakingContract.sol:322-339` | `Delegate` 等事件从各 validator 地址发出。**必须先有 validator 地址集合，再按集合过滤日志**，否则任何合约都能伪造同名事件（Xangle 就没做这层校验） |
| `createValidator` 发 `ValidatorCreated`，`initializeValidator` 发 `ValidatorInitialized`，退出发 `ValidatorExited` | `StakingContract.sol` | 用事件发现 validator，不再像 Xangle 那样解析 tx input（Xangle 的 `0xf9673cc0` selector 不在 ABI 里，一旦命中游标会卡死） |
| 委托人的份额只在 `Delegate` / `Undelegate` / `Slashed`（只扣 operator 的份额）时变化，**外加初始化时的自质押** | `ValidatorContract.sol:392-451, 532-577, 608-650` | Delegate / Undelegate / 初始化都能从日志拿到，shares **按事件增量维护**；`Slashed` 走系统调用、日志取不到（见下一行），operator 的份额靠 refresher 用链上值校正 |
| 当前版本 `initilize` → `_selfDelegate` → `_delegate` **不发 `Delegate` 事件**；operator 的初始份额只体现在 Staking 的 `ValidatorInitialized(pubkey, validator, operator, amount)` 里。此时池子为空，`convertToShares` 按 1:1 返回 | `ValidatorContract.sol:100-108, 330-338` | 处理 `ValidatorInitialized` 时给 operator 记 `shares = amount`。Xangle 提到旧版初始化会发一条非 indexed 的 `Delegate`：如果同一笔交易里同一个 validator 已经有 `Delegate`，就不再重复记（第 0 步确认） |
| 委托人的代币价值 = `shares × (tokens + rewards) / delegatorShares` | `getDelegatedTokens`，`ValidatorContract.sol:348-354` | 奖励每块累积，价值不能从事件推出来。在查询时用 validator 行上定期刷新的 `tokens` / `rewards` / `delegatorShares` 计算。Xangle 只用了 `tokens`，**漏算了 `rewards`** |
| 系统地址 `0xff…fE` 每块调用 Staking 的 fallback，转到出块 validator 的 fallback，触发 `DistributeRewards` 和提现队列处理（`PopWithdrawEntry`、失败时的 `PushWithdrawEntry(isFailed=true)`）；罚没 `slashValidator` 也只允许系统地址调用 | `StakingContract.sol:313-320, 393-400`，`ValidatorContract.sol:961-980` | **已确认：系统调用产生的日志 `eth_getLogs` 取不到**。所以奖励、队列出队、罚没都没有事件可收，只能从 view 调用的状态变化里看（见"事件清单"） |
| Validator 是 `OwnableUpgradeable`，`transferOwnership` 会换 owner | `ValidatorContract.sol:599-607` | 监听 `OwnershipTransferred`。"自质押"= owner 的委托，查询时比对 owner 算出来，不再存一个容易过期的 `SELF/USER` 状态 |
| 有新旧两版事件签名 | Xangle 的 4 个 topic | V1：`Delegate(address,uint256,uint256)` / `Undelegate(address,uint256,uint256)`，delegator 可能是 indexed，也可能在 data 里。V2：`Delegate(address indexed payer, address indexed delegator, uint256, uint256)` / `Undelegate(address indexed delegator, address indexed withdrawal, uint256 shares, uint256 amount)` |
| 创世 validator 由 genesis deposit 注册，没有 `ValidatorCreated` / `ValidatorInitialized` | Xangle `GenesisValidatorLoader`，exex `seed_genesis_validators` | 需要一次性导入 validator **和 operator 的初始份额**。exex 给出的主网数据：4 个 validator，operator 都是 `0x711b…2522`，各 500 0G。Xangle 只导入了 validator、没导入份额，这就是它 KNOWN_ISSUES §3.1 里"创世 validator 自质押显示为 0"的来源 |

## 第 0 步：上链验证（开工前，约半天）

以下几点决定后续设计，需要连主网 RPC 验证。开发环境的沙箱连不上 `evmrpc-mainnet.0g.ai`，要在本地或服务器上跑，探测脚本见附录 C。

1. ~~系统调用产生的 `DistributeRewards` / `PopWithdrawEntry` 能否用 `eth_getLogs` 取到？~~ **已确认取不到**（2026-09-29）。
2. RPC 对 `eth_getLogs` 的块范围上限和结果条数上限是多少？`address` 传数组（约 100 个地址）行不行？
3. 是否支持 `eth_getBlockByNumber("finalized")`？0G 用 CometBFT，理论上是即时终局，需要确认。
4. 主网实际出现过哪些事件签名：V1 和 V2 的分界块，有没有 V1 的非 indexed 变体（exex 假定 V1 的 delegator 总是 indexed，Xangle 两种都处理），旧版初始化交易里是否带 `Delegate`。还要找到第一个 `ValidatorCreated` 的块号，作为回灌起点。
5. 4 个创世 validator 在第 1 块时 operator `getDelegation` 的份额（用 archive 节点按块号查），确认是否就是 500e18。

## 数据模型（MySQL，新增 3 张表 + KV 游标）

地址存成小写 hex `STRING(42)`，跟 `EIP7702model.ts` 一样。原因是这些表不需要跟 `full_tx` 关联，而且 validator 数量很少。金额用 `DECIMAL(65,0)`，单位 wei，接口返回整数字符串。所有模型注册在 `DBProvider.initPartialModel()`，因为 open-api 进程也要读。

### `staking_validator`，每个 validator 一行
- 标识：`address` PK、`pubkey`、`createdBlock`、`createdAt`、`initializedBlock`、`exitedBlock`、`isGenesis`
- 链上状态，由 refresher 覆盖：`owner`、`operator`、`moniker`、`identity`、`website`、`securityContact`、`details`、`commissionRate`（原始值，1e6 = 100%）、`withdrawalFeeInGwei`、`tokens`、`rewards`、`delegatorShares`、`commission`、`stakes`、`apy`（原始值）、`bondStatus`、`minSelfDelegationInGwei`
- 共识层：`beaconStatus`（原始字符串，比如 `active_ongoing`）、`beaconEffectiveBalance`
- 刷新信息：`refreshedAt`、`refreshedBlock`

### `staking_delegation`，每个 (validator, delegator) 对一行
- `validator`、`delegator`，建唯一索引 `uk_validator_delegator`
- `shares`：由事件增量维护
- `firstBlock`、`lastBlock`、`firstAt`、`lastAt`
- 索引：`(delegator)`、`(validator, shares)`

### `staking_event`，事件流水
- `blockNumber`、`blockHash`、`createdAt`、`txHash`、`txIndex`、`logIndex`，唯一索引 `uk_block_log (blockNumber, logIndex)`
- `validator`：发出事件的地址，或 Staking 事件里带的 validator
- `eventType TINYINT`：取值见下文"事件清单"里收集的 11 种
- `account`（delegator 或 owner）、`counterparty`（payer 或 withdrawalAddress）、`amount`、`shares`、`extra JSON`（其余字段）
- 索引：`(validator, eventType, createdAt)`、`(account, eventType, createdAt)`、`(eventType, createdAt)`。前两个服务于"某 validator 某时段的委托"和"某 delegator 的累计委托"两类汇总，见下文 API

### 游标
- 存在 `KV` 里，键名 `STAKING_SYNC_BLOCK`，跟事件写入放在同一个 DB 事务里更新。

### 二期
- `staking_daily_validator`：每日快照 tokens / rewards / commission / delegator 数。奖励没有事件，每日奖励只能用快照差值估算（要扣掉当天的委托和解押流水），精度只到天
- `staking_withdraw_entry`：待解押队列

## 事件清单

**收集的（都由普通交易触发，`eth_getLogs` 能取到）**

| 事件 | 发出方 | 用途 |
|---|---|---|
| `ValidatorCreated(bytes indexed pubkey, address indexed validator)` | Staking | 发现 validator，加入地址集合 |
| `ValidatorInitialized(bytes indexed pubkey, address indexed validator, address operator, uint amount)` | Staking | 记初始化块号；给 operator 记初始份额 = amount |
| `ValidatorExited(bytes indexed pubkey, address indexed validator)` | Staking | 记退出块号 |
| `Delegate` V1 `(address,uint256,uint256)` / V2 `(address indexed payer, address indexed delegator, uint, uint)` | validator | shares 加；委托流水；"委托累计"只统计它 |
| `Undelegate` V1 `(address,uint256,uint256)` / V2 `(address indexed delegator, address indexed withdrawal, uint shares, uint amount)` | validator | shares 减；解押流水 |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` | validator | owner 变更，影响"自质押"判定 |
| `CommissionRateChanged(uint32, uint32)` | validator | 佣金率变更历史；触发 refresher 刷新 |
| `WithdrawalFeeInGweiChanged(uint96, uint96)` | validator | 同上 |
| `WithdrawCommission(address indexed owner, address indexed withdrawal, uint amount)` | validator | 佣金提取流水 |
| `WithdrawTipFee(address indexed owner, address indexed withdrawal, uint amount)` | validator | tip fee 提取流水 |
| `Exited(address indexed owner)` | validator | 跟 `ValidatorExited` 互相印证 |

**不收集的**

| 事件 | 原因 | 替代办法 |
|---|---|---|
| `DistributeRewards` | 系统调用触发，日志取不到 | refresher 读 `rewards()` / `commission()` / `tokens()`；二期用每日快照的差值估算每日奖励 |
| `Slashed` | 只能经由系统调用的 `slashValidator` 触发，日志取不到 | refresher 每轮校正 operator 份额，并比对 `delegatorShares()` 跟库里份额之和（见 Refresher） |
| `PopWithdrawEntry` | 主要在系统调用里出队，日志不完整 | 待解押队列一律用 `withdrawCount()` / `getWithdraw(i)` 读当前状态（二期） |
| `PushWithdrawEntry` | 正常入队（`isFailed=false`）能取到，但失败重入队（`isFailed=true`）发生在系统调用里；只收一半反而误导 | 同上。解押记录本身已有 `Undelegate` 事件，完成高度 = 解押块号 + `minWithdrawabilityDelay()` |
| `DepositEvent` / `OperatorChangeQueued` / `OperatorChangeCancelled` / `OperatorUpdated`（Deposit 合约） | 共识层 deposit 与 operator 变更，跟委托统计无关 | `operatorAddress()` 由 refresher 读 |

## 同步：`StakingSync`

`stat/service/staking/StakingSync.ts` 是个库模块，由 `TokenMiscSync.main()` 启动，跑在 `token_x` 容器里，不新增容器。这个文件同时带一个 `require.main` 入口，方便单独执行 `backfill` / `refresh-once` / `diff` 命令。

骨架照抄 `eip7702.ts`：`setTimeout` 循环 + `safeAddErrorLog`，写库用 `bulkCreate(ignoreDuplicates)`，放在事务里。RPC 用 `initEthSdk(ConfigInstance.ether?.url)`。

**每轮处理一个窗口 `[from, to]`**
- `to = min(safeHead, from + range - 1)`。`safeHead` 取 `finalized`，不支持的话取 `latest - confirmations`。
1. `getLogs({address: STAKING, topics: [[Created, Initialized, Exited]]})`：新 validator 写进 `staking_validator`，同时加入内存里的地址集合。
   - 必须先做这一步：validator 创建后同一块里就可能收到委托，先有地址才收得到。`ValidatorInitialized` 在这里就给 operator 记初始份额。
2. `getLogs({address: [所有 validator], topics: [[Delegate V1/V2, Undelegate V1/V2, OwnershipTransferred, CommissionRateChanged, WithdrawalFeeInGweiChanged, WithdrawCommission, WithdrawTipFee, Exited]]})`。
   - 地址超过 RPC 上限就分组查。
3. 在同一个事务里：
   - 写 `staking_event`，已存在的忽略；
   - 按事件把 shares 增量更新到 `staking_delegation`：ValidatorInitialized 给 operator 加 amount，Delegate 加，Undelegate 减（罚没没有事件，由 refresher 校正）；
   - 推进游标。
   - 增量**只对新插入的事件**生效：先插事件，拿到实际插入的行，再只对这些行做增量。这样同一窗口重跑是幂等的。

**其他处理**
- 回灌：从第一个 `ValidatorCreated` 的块开始跑，逻辑同上。主网 Xangle 的 seed 只有约 9k 条 delegate_trx，量很小。
- getLogs 出错时减半窗口重试，参考 `LogFetcher` 的做法。窗口大小从配置读。
- 回滚：如果有终局就不处理 reorg。如果只能靠确认数，就在每个窗口末尾记下 blockHash，下一轮先比对，不一致就删掉 `≥ from` 的事件，按事件反向扣回 shares，再回退游标。第 0 步确认终局之后再定做不做。
- 失败的交易：Xangle 会把失败的 delegate / undelegate 交易也记下来，出现在交易列表里。我们库里已经有全量交易（`full_tx` 带 status），**一期不单独存**。接口需要时，用"to ∈ validator 集合 + selector ∈ {`0x5c19a95c`, `0x4d99dd16`} + status = 失败"从现有交易表查。见待决问题 3。

### Refresher（周期任务，默认 60s）
- 放在同一个进程里，只读链上 view 函数。
- 对每个 validator 批量 `eth_call`：`owner`、`operatorAddress`、`description`、`commissionRate`、`withdrawalFeeInGwei`、`tokens`、`rewards`、`delegatorShares`、`commission`、`stakes`、`annualPercentageYield`、`bondStatus`、`minSelfDelegationInGwei`。
  - 用 ethers 批量调用，或者上 Multicall3（先确认链上有没有部署）。
- 共识层状态：`validatorRpc` 指向 `/eth/v1/beacon/states/head/validators`，按 pubkey 匹配，复用 `ZGSupply.sumValidatorBalance` 的 fetch 逻辑。
  - **这一步失败不能影响 EVM 部分的刷新**。Xangle 一旦 beacon 调用失败，整轮都会中止。
- 罚没校正（每轮）：罚没只扣 operator 的份额，而且没有事件。所以每轮顺带调一次 `getDelegation(operator)`（每个 validator 一次调用），并检查 `Σ staking_delegation.shares == delegatorShares()`。
  - operator 份额跟库里不一致时，以链上值为准更新，同时写一条 `eventType = SlashDetected` 的合成记录（`blockNumber` = 刷新时的块号，`amount` 留空，`shares` = 差值），并告警。
  - 份额之和对不上、但 operator 份额对得上，说明事件漏收或解码有问题，只告警，交给每小时对账处理。
  - 这种合成记录不参与"委托累计"。
- 对账（每小时一次）：对 `shares > 0` 的委托对抽样，或者全量调 `getDelegation(delegator)`，跟事件增量的结果比对。对不上就调用 `safeAddErrorLog` 告警，并以链上值为准修正。

### 创世 validator
- 主网只有 4 个，直接把 exex `src/exex.rs:60-110` 里的数据（validator 地址、operator、初始金额）写成代码常量，按网络区分，在回灌起点之前执行一次：写 `isGenesis = 1` 的 validator，并给 operator 记初始份额。其余字段由 refresher 补齐。
- 测试网或其他网络可以用 `seed-genesis <genesis.json>` 命令，读 `app_state.beacon.deposits[]`，地址取 `credentials` 的后 40 个 hex 字符。genesis 里的金额单位要确认。
- 初始份额必须经过对账核实（第 0 步第 5 点）：exex 的做法是写死 500 0G，没有验证。

### 配置
在 `StatConfig` 里新增：

```ts
staking?: {
  contract?: string,          // 默认 0xea22…61B9
  startBlock?: number,
  confirmations?: number,     // 无 finalized 时使用
  logRange?: number,
  refreshIntervalMs?: number,
  enabled?: boolean,          // 默认 false
}
```

- `run.sh` 生成的 `Prod.js` 连 `ether` 都没有（`_RPC` 在 EVM 模式下是 cfx-bridge，不是 EVM RPC），所以 `staking`、`ether`、`validatorRpc` 都要在部署的 `Prod` 里手工加，没有改 `run.sh`。

## 查询与 API

`stat/service/staking/StakingQuery.ts` 负责查询和计算，`open-api/service/OpenStakingService.ts` 负责参数校验和格式化。路由在 `ESpaceApiRouter` 和 `ApiRouter` 里各注册一遍。

**计算口径**
- 统一在查询层算：`value(shares) = shares × (tokens + rewards) / delegatorShares`。
- "自质押"：`delegator == validator.owner`。
- "委托累计"：**只统计 `Delegate` 事件的 `amount`**。不减 Undelegate / Slashed，不包含 `ValidatorInitialized` 的初始自质押和创世份额（它们在 `staking_event` 里是另外的 eventType，需要时可以加开关）。V2 事件按 `delegator` 归属，不按 `payer`。

| 接口（暂定 `/open/staking/…`） | 对应 Xangle | 说明 |
|---|---|---|
| `GET /summary` | #1 | 总委托 = Σ tokens；委托人数 = **去重后**的地址数（shares > 0）；validator 总数 / 活跃数 |
| `GET /validators?status=&term=&sort=&order=` | #2 | 占比和累计占比在查询层算；validator 不超过 200 个，不分页 |
| `GET /validator?address=` | #3 | 包含 selfDelegated、selfDelegatedPercent、APY（字段就叫 APY，不写成 APR） |
| `GET /validator/delegators?address=&skip=&limit=` | #4 | 按 shares 倒序；delegationCount 用一条 GROUP BY 查出来，避免 Xangle 的 N+1 查询 |
| `GET /delegations/events?validator=&delegator=&type=&skip=&limit=` | #5 | 来自 `staking_event`，额外返回 shares 和 blockHash |
| `GET /delegator/validators?address=&sort=` | #6 | 委托人视角 |
| `GET /charts/breakdown` | #7 | 自质押和他人委托各占多少 |
| `GET /validator/delegations/sum?address=&start=&end=&interval=` | 新增 | 某 validator 在 `[start, end)` 内的 Delegate 金额合计和笔数。`interval` 为空时返回一个总数；传 `day` / `hour` 时按时间分桶返回序列。时间用秒级时间戳，范围上限先定 366 天 |
| `GET /delegator/delegations/sum?address=&start=&end=` | 新增 | 某 delegator 在所有 validator 上的 Delegate 累计金额合计，另附按 validator 拆分的明细。`start`/`end` 可选，不传就是全部历史 |
| `GET /charts/activity?days=5` | #8 | 只统计 Delegate，或者分成 Delegate 和 Undelegate 两个序列；按天 × validator 取 top10，其余归到 Others |

- 响应外层沿用 EVM 模式的 `{status, message, result}`。
- 接口加进 `document/evm-open-api.yaml`。
- 前端兼容见待决问题 1。

## 验证（仓库没有测试套件）

1. `StakingSync.js backfill` 跑完主网，执行 `StakingSync.js diff <xangle-dir>`。其中 delegator 累计委托接口的结果直接对比 `delegator_tokens.csv` 的 `TOTAL_DELEGATION` 列；如果有差异，先查是不是 Xangle 把旧版初始化交易里的 Delegate 或失败交易的金额也算进去了，跟 Xangle 导出的数据比对：
   - `delegator.json` 的每对 shares；
   - `delegate_trx.json` 的条数和金额，要去掉 Xangle 记下的失败交易行；
   - `delegator_tokens.csv`（即 `/Users/zhuyusong/Projects/Xangle`）。
   - 预期的差异只来自附录 B 里那些 Xangle bug，其余必须对得上。
2. 对账任务第一次跑全量 `getDelegation`，要求 0 差异。
3. 接口逐个跟 Xangle 线上接口比对（如果还在跑），只允许有预期内的口径差异。
4. `npx tsc -p . --noEmit` 通过；在测试网上完整跑一轮，包括重启进程，确认幂等。

## 分期

| 阶段 | 内容 | 估时 |
|---|---|---|
| 0 | 上链验证（上文第 0 步） | 0.5d |
| 1 | 模型、配置、StakingSync（发现 validator、写事件、维护 shares）、回灌、创世导入 | 2d |
| 2 | Refresher（view 调用、beacon 状态、对账） | 1d |
| 3 | StakingQuery 和 8 个接口、swagger | 2d |
| 4 | 跟 Xangle 数据对比，测试网验证，上线（`staking.enabled = true`） | 1d |
| 二期 | 每日快照与奖励估算、待解押队列（view 调用）、失败交易展示 | 待定 |

## 待决问题

1. **前端兼容**：交接的 `0g-explorer` 调的是 Xangle 的路径和响应结构（`/api/validator/*`，`{statusCode, result}`，`ListInfo`，金额已经除过 1e18）。两个选择：
   - (a) 前端改成调新接口，推荐；
   - (b) 后端另加一层 Xangle 兼容格式。
   需要前端负责人拍板。
2. **API 挂在哪**：open-api（对外公开，需要限流 key）还是 scan-api v1（浏览器前端现在用的）？如果浏览器页面直接调用，scan-api 可能更合适。
3. **失败交易**：交易列表里要不要展示失败的 delegate / undelegate？
4. **USD 价值**：Xangle 的 `*Value` 字段一直是 0。要不要接现有的代币价格（`TokenQuoteTrack`）？
5. 过渡期 Xangle 的服务是否继续运行、什么时候下线。

## 附录 A：事件 topic

| 事件 | topic0 |
|---|---|
| Delegate V1 `(address,uint256,uint256)` | `0x22fa5fbc94b06ceb9756514704b1812bbfce879977525eb7413d82bb507e611b` |
| Undelegate V1 `(address,uint256,uint256)` | `0x0fb944dfb6f905f4df9591c2ec2e59e3e68658aae7ec51aa5015409406457e80` |
| Delegate V2 `(address,address,uint256,uint256)` | `0x500599802164a08023e87ffc3eed0ba3ae60697b3083ba81d046683679d81c6b` |
| Undelegate V2 `(address,address,uint256,uint256)` | `0x54feacf7d18f42300ff65ba8829f17724df4915a8b1984c5fee2cc42d4027f07` |
| 其余 | 由 `ethers.utils.id(signature)` 在代码里计算，不手写 |

## 附录 B：Xangle 实现中不照搬的问题

- 不校验事件发出地址：任何合约都能伪造 Delegate 事件。
- 靠 tx input 识别 validator 创建：`0xf9673cc0` 不在 ABI 里，命中后游标永久卡死。
- 委托人价值漏算了 `rewards`。
- 采集时 `getDelegation` 只取了返回值的 16 字节；而且回灌时写入的是最新值，不是事件发生时的值。
- 用 `SELF/USER` 状态列表示自质押，容易过期，所以才有了那个 patch。
- summary 里的"委托人数"数的是委托对，不是去重后的地址，还把 share 为 0 的也算进去了。
- 活跃度图表：`log_index != "0"` 的过滤实际上不起作用；Undelegate 的金额被当成正数加进去；失败交易的 `tx.value` 也被计入。
- 不处理 reorg，确认数默认是 0；`delegate_trx` 的去重索引不是唯一索引。
- beacon 调用失败会中止整轮刷新。
- 接口字段叫 `stakingApr`，实际存的是 APY。

## 附录 C：第 0 步探测脚本

`node probe.js`，在仓库根目录运行，用仓库自带的 ethers v5：

```js
const {ethers} = require('./node_modules/ethers');
const p = new ethers.providers.JsonRpcProvider('https://evmrpc-mainnet.0g.ai');
const id = ethers.utils.id;
(async () => {
  const head = await p.getBlockNumber();
  for (const sig of ['Delegate(address,address,uint256,uint256)', 'Delegate(address,uint256,uint256)',
                     'ValidatorCreated(bytes,address)', 'ValidatorInitialized(bytes,address,address,uint256)']) {
    const logs = await p.getLogs({fromBlock: head - 900, toBlock: head, topics: [id(sig)]});
    console.log(sig, logs.length, 'emitters', new Set(logs.map(l => l.address)).size);
    if (logs[0]) console.log('  first block', logs[0].blockNumber);
  }
  console.log('finalized', (await p.send('eth_getBlockByNumber', ['finalized', false]))?.number);
})();
```

## 附录 D：`0g-reth-exex-template` 对照

它是个 reth ExEx，直接挂在 0g-reth 节点里逐块读 receipt，写 SQLite；另有一个 `backfill` 二进制，用 `eth_getLogs` 补历史。

**可以借鉴的**
- 创世 validator 的具体数据（`src/exex.rs:60-110`），见上文。
- 事件解码按"只信 topic 数量和 data 长度"的方式做防御式校验，不符合就跳过并告警，不让整块失败（Xangle 这种情况会抛异常卡住游标）。
- 在线路径（`process_logs`）只接受 Staking 合约或已知 validator 发出的日志，跟本计划一致。
- 除了委托事件，还收 `WithdrawCommission` / `WithdrawTipFee`，单独汇总到 `validator_operator`，不算进解押。本计划补收 `WithdrawTipFee`。
- backfill 的做法：按 topic0 过滤、默认每次 2000 块、指数退避重试（500ms 起、最多 5 次）、每个窗口一个事务、窗口末尾更新游标。可以作为 `getLogs` 窗口的初始默认值。
- 它的注释提到 0G 靠 CometBFT 快速终局，所以只处理 committed chain、不处理 revert。这跟第 0 步第 3 点的判断方向一致，但仍需验证 RPC 的 `finalized` 标签。

**不照搬的**
- backfill 路径**不校验发出地址**，只按 topic 过滤，跟在线路径不一致。
- 不存 shares 的当前值，只累计 `total_delegated` / `total_undelegated` 的金额，而且用 `i128` 解析、失败时当成 0。金额累计既不等于当前质押，也没法算奖励。
- `delegators` 按地址汇总，不区分 validator。
- 用 `ValidatorInitialized` 登记 validator，不收 `ValidatorCreated`；validator 表里的 `pubkey` 其实是 indexed topic，也就是 pubkey 的 keccak 哈希，不是原始公钥。原始公钥要从 `getValidatorPubkey(address)` 或者 `consensusPubkey()` 读。
- 没有 refresher，没有 view 调用，没有 beacon 状态。
- 仓库里的 `web-server/staking_indexer.db` 只是本地开发网的数据（5 个 validator、8 条事件），不能拿来对比。

## 一期实现说明

**文件**
- 模型：`stat/model/Staking.ts`（三张表 + `StakingEventType`），在 `DBProvider.initPartialModel()` 注册
- 解码 / 常量：`stat/service/staking/StakingAbi.ts`（topic、防御式解码、创世 validator 列表）
- 同步：`stat/service/staking/StakingSync.ts`；refresher：`StakingRefresher.ts`
- 入口：`StakingMain.ts`。`startStaking()` 由 `TokenMiscSync.main()` 调用；命令行 `node stat/service/staking/StakingMain.js sync|refresh|reconcile|diff <xangleDir>`
- 查询：`StakingQuery.ts`；接口：`open-api/service/OpenStakingService.ts`，路由只注册在 `ESpaceApiRouter`（0G 只跑 EVM 模式）；文档加在 `document/evm-open-api.yaml` 的 `Staking` 标签下

**部署配置**（`Prod`）

```js
ether: {url: 'https://evmrpc-mainnet.0g.ai'},   // 或自己的节点
validatorRpc: '<beacon>/eth/v1/beacon/states/head/validators',  // 可选，缺省则没有 active 状态
staking: {enabled: true, genesis: 'mainnet'},   // 测试网用 genesis: 'none'
```

改完 `Prod` 要 `npm run compile`，再重启 `token_x`。首次启动会从 `startBlock`（默认 1）开始回灌；也可以先手工跑 `StakingMain.js sync` 追到最新再启用。

**跟计划不同的地方**
- 去掉了 dirty 标记：refresher 每 60 秒全量刷一遍，validator 只有一两百个，用不着。
- 创世 validator 只支持内置列表（`mainnet` / `none`），没做读 genesis.json。未配置 `genesis` 时同步拒绝启动，不影响 `token_x` 的其他任务。
- 事件表唯一键是 `(blockNumber, logIndex, validator)`，这样合成的 `SlashDetected` 记录（`logIndex = -1`）可以和同一个观测块共存。
- refresher 的份额校验和全量对账都在游标所在的块上读链上状态，并且和同步窗口共用一把锁，避免把写了一半的窗口当成差异。游标落后最新块超过 64 个时跳过这两项，因为非 archive 节点读不到那么旧的状态。
- operator 份额链上比库里少，记为 `SlashDetected`；链上比库里多，说明漏了事件，只修正并告警。两种情况都以链上值为准。
- Xangle 的 `delegator_tokens.csv` 里，`TOTAL_DELEGATION` 包含了失败 delegate 交易的 `tx.value`：只算成功交易时 1345 个地址里 1306 个对得上，加上失败交易后全部对上。`diff` 命令会把这类差异单独归类。

**已验证**
- `npx tsc -p . --noEmit` 通过。
- 解码器：用 ethers `Interface.encodeEventLog` 生成 V2 事件，加上手工构造的 V1 两种变体和畸形日志跑了一遍，全部符合预期。
- swagger YAML 能被 `yamljs` 解析。

**未验证**（需要 MySQL 和能访问 0G RPC 的环境）
- 同步、refresher 和查询的 SQL 都没在真实 MySQL 上跑过。
- 主网回灌，以及 `diff` 跟 Xangle 数据的比对。
- 第 0 步的第 2 到 5 点：getLogs 上限、`finalized` 标签、V1/V2 分界、创世份额。
