# 把 Validator / Delegation 索引并进 0g-scan-backend：计划

状态：一期已实现，并在测试网上端到端跑通（2026-11-05，见文末"一期实现说明"）。二期 A（validator 事件接口）已实现并在测试网验证（2026-11-05）。二期 B（逐块的奖励、佣金、社区税、基金会奖励与罚没）只有设计，未实现。

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
| 当前版本 `initilize` → `_selfDelegate` → `_delegate` **不发 `Delegate` 事件**；operator 的初始份额只体现在 Staking 的 `ValidatorInitialized(pubkey, validator, operator, amount)` 里。此时池子为空，`convertToShares` 按 1:1 返回 | `ValidatorContract.sol:100-108, 330-338` | 处理 `ValidatorInitialized` 时给 operator 记 `shares = amount`。Xangle 提到旧版初始化会发一条非 indexed 的 `Delegate`：如果同一笔交易里同一个 validator 已经有 `Delegate`，就不再重复记（第 0 步已确认：块 9,960,343 及以前的 35 笔初始化交易都带这条 Delegate） |
| 委托人的代币价值 = `shares × (tokens + rewards) / delegatorShares` | `getDelegatedTokens`，`ValidatorContract.sol:348-354` | 奖励每块累积，价值不能从事件推出来。在查询时用 validator 行上定期刷新的 `tokens` / `rewards` / `delegatorShares` 计算。Xangle 只用了 `tokens`，**漏算了 `rewards`** |
| 系统地址 `0xff…fE` 每块调用 Staking 的 fallback，转到出块 validator 的 fallback，触发 `DistributeRewards` 和提现队列处理（`PopWithdrawEntry`、失败时的 `PushWithdrawEntry(isFailed=true)`）；罚没 `slashValidator` 也只允许系统地址调用 | `StakingContract.sol:313-320, 393-400`，`ValidatorContract.sol:961-980` | **已确认：系统调用产生的日志 `eth_getLogs` 取不到**。所以奖励、队列出队、罚没都没有事件可收，只能从 view 调用的状态变化里看（见"事件清单"） |
| `ValidatorInitialized` / `ValidatorExited` 由 Staking 合约在普通交易里发出（`initializeValidator` / `exitValidator`），日志取得到。罚没导致的退出（`slash(amount, exited=true)`）走系统调用，不发 `ValidatorExited` | `StakingContract.sol:291-310, 342-363`，`ValidatorContract.sol:532-577` | validator 的创建、退出高度和交易哈希都取自这两个事件。罚没导致的退出不在展示范围内，这类 validator 的退出信息为空 |
| `withdrawCommission` 把 `commission` 清零后**放进提现队列**，`withdrawTipFee` 直接转账；`tipFee()` = 合约余额 − (commission + rewards + 已承诺的提现 + 失败提现 + 待存入) | `ValidatorContract.sol:455-487, 225-235` | 两种手续费都是"当前未提 + 历史已提"。当前值只能读 view，历史已提来自事件 |
| Validator 是 `OwnableUpgradeable`，`transferOwnership` 会换 owner | `ValidatorContract.sol:599-607` | 监听 `OwnershipTransferred`。"自质押"= owner 的委托，查询时比对 owner 算出来，不再存一个容易过期的 `SELF/USER` 状态 |
| 有新旧两版事件签名 | Xangle 的 4 个 topic | V1：`Delegate(address,uint256,uint256)` / `Undelegate(address,uint256,uint256)`，delegator 可能是 indexed，也可能在 data 里。V2：`Delegate(address indexed payer, address indexed delegator, uint256, uint256)` / `Undelegate(address indexed delegator, address indexed withdrawal, uint256 shares, uint256 amount)` |
| 创世 validator 由 genesis deposit 注册，没有 `ValidatorCreated` / `ValidatorInitialized` | Xangle `GenesisValidatorLoader`，exex `seed_genesis_validators` | 需要一次性导入 validator **和 operator 的初始份额**。exex 给出的主网数据：4 个 validator，operator 都是 `0x711b…2522`，各 500 0G。Xangle 只导入了 validator、没导入份额，这就是它 KNOWN_ISSUES §3.1 里"创世 validator 自质押显示为 0"的来源 |

## 第 0 步：上链验证（已完成，2026-11-04）

用 `https://evmrpc.0g.ai`（开发机能连；`evmrpc-mainnet.0g.ai` 仍连不上）验证，第 3、5、6 项由人工确认。

| # | 问题 | 结论 | 对实现的影响 |
|---|---|---|---|
| 1 | 系统调用的日志能否用 `eth_getLogs` 取到 | **取不到**（`DistributeRewards`、`PopWithdrawEntry` 等） | 奖励、罚没改从区块数据和 view 调用获取 |
| 2 | `eth_getLogs` 的限制 | 块范围上限 **100,000**（超出返回 `query exceeds max block range 100000`）；`address` 数组传 1,000 个也正常；单次返回 13,115 条没有触发条数上限 | `logRange` 默认值已从 2000 改为 100,000，`ADDRESS_CHUNK` 从 50 改为 500。全历史 493 个窗口、6 路并发扫完约 47 秒 |
| 3 | 是否需要 `finalized` | **不需要**（人工确认）：CometBFT 出一块即终局。RPC 支持 `finalized` 标签，但比 `latest` 落后约 10 块 | 直接用 `latest`，`confirmations` 默认为 0（已实现，同步不再查 `finalized`） |
| 4 | 事件签名、分界块、回灌起点 | 见下文"事件历史" | 回灌必须**从块 1 开始**，不能从第一个 `ValidatorCreated` 开始；旧版初始化的去重规则是必需的，而且是对的 |
| 5 | 创世 operator 的份额是否为 500e18 | **是**（人工确认） | `GENESIS_VALIDATORS` 里写死的 500 0G 正确 |
| 6 | `slashed` 字段的格式 | 与 `withdrawals` 元素相同（人工确认，0g-geth 的 `SlashedValidatorEntry` 复用 `engineprimitives.Withdrawal`）：`Index` = 证据高度（CometBFT 违规高度 / slashingInfo slot），`Validator` = 被罚 validator 的共识层编号，`Address` = 该 validator 的执行层提现地址，`Amount` = 罚金（gwei） | `Address` 就是 validator 合约地址：beacon 上 67 个 validator 的提现凭证都是 `0x01` + 一个已知的 validator 合约地址，与合约 `_selfDelegate` 的写法一致。**罚没直接按 `address` 归属**，不需要 beacon 的 `index → pubkey` 映射 |

**事件历史**（主网全量扫描，截至块 49,270,785，共 10,311 条）：

| 事件 | 条数 | 区块范围 | 发出方 |
|---|---|---|---|
| `ValidatorCreated` | 76 | 1,064,767 – 48,609,538 | Staking |
| `ValidatorInitialized` | 74 | 1,064,767 – 41,956,200 | Staking（有 2 个 validator 只创建、未初始化） |
| `ValidatorExited` | 20 | 12,034,802 – 48,556,929 | Staking |
| `Delegate` V1（`topics` 长度 2，delegator indexed） | 1,570 | **117,516** – 10,080,413 | 39 个 validator |
| `Undelegate` V1（同上） | 131 | 118,003 – 10,104,717 | 16 个 validator |
| `Delegate` V2 | 6,505 | 10,110,247 – 49,269,741 | 63 个 validator |
| `Undelegate` V2 | 1,935 | 10,156,816 – 49,085,661 | 57 个 validator |

- **V1 → V2 的分界**：最后一条 V1 在块 10,104,717，第一条 V2 在块 10,110,247。
- **V1 没有非 indexed 变体**：主网上 V1 全部是 delegator indexed（`topics` 长度 2）。解码器里非 indexed 的分支保留，不会被走到。
- **回灌起点**：第一条 `Delegate`（块 117,516）早于第一个 `ValidatorCreated`（块 1,064,767），这些委托都发给了创世 validator。所以回灌必须从块 1 开始，现在的默认 `startBlock = 1` 是对的。
- **旧版初始化**：74 笔初始化交易中，块 9,960,343 及以前的 35 笔，在 `ValidatorInitialized` 之前都有一条同一 validator 发出的 V1 `Delegate`，委托人就是 operator，金额等于初始自质押，35 笔全部吻合。块 10,237,103 及以后的 39 笔没有 Delegate。按"同一交易里已有该 operator 的 Delegate 就不重复记"去重是必需的；如果不去重，这 35 个 validator 的初始份额都会算两遍。
- **validator 总数**：80 个（76 个创建 + 4 个创世），其中 20 个已退出。
- **没有冒充事件**：主网上没有非 validator 合约发出同名的 Delegate / Undelegate。按 validator 地址集合过滤仍然保留，作为防御。

## 数据模型（MySQL，新增 3 张表 + KV 游标）

地址存成小写 hex `STRING(42)`，跟 `EIP7702model.ts` 一样。原因是这些表不需要跟 `full_tx` 关联，而且 validator 数量很少。金额用 `DECIMAL(65,0)`，单位 wei，接口返回整数字符串。所有模型注册在 `DBProvider.initPartialModel()`，因为 open-api 进程也要读。

### `staking_validator`，每个 validator 一行
- 标识：`address` PK、`pubkey`、`createdBlock`、`createdAt`、`initializedBlock`、`exitedBlock`、`isGenesis`
- 链上状态，由 refresher 覆盖：`owner`、`operator`、`moniker`、`identity`、`website`、`securityContact`、`details`、`commissionRate`（原始值，1e6 = 100%）、`withdrawalFeeInGwei`、`tokens`、`rewards`、`delegatorShares`、`commission`、`tipFee`（新增，见"validator 事件接口"）、`stakes`、`apy`（原始值）、`bondStatus`、`minSelfDelegationInGwei`
- 创建 / 退出（新增列，由同步从事件写入）：`initializedTxHash`、`initializedAt`、`exitedTxHash`、`exitedAt`，配合已有的 `initializedBlock`、`exitedBlock`
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
| `ValidatorInitialized(bytes indexed pubkey, address indexed validator, address operator, uint amount)` | Staking | validator 的**创建**高度和交易哈希；给 operator 记初始份额 = amount |
| `ValidatorExited(bytes indexed pubkey, address indexed validator)` | Staking | validator 的**退出**高度和交易哈希 |
| `Delegate` V1 `(address,uint256,uint256)` / V2 `(address indexed payer, address indexed delegator, uint, uint)` | validator | shares 加；委托流水；汇总接口里的 `delegated` |
| `Undelegate` V1 `(address,uint256,uint256)` / V2 `(address indexed delegator, address indexed withdrawal, uint shares, uint amount)` | validator | shares 减；解押流水；汇总接口里的 `undelegated` |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` | validator | owner 变更，影响"自质押"判定 |
| `CommissionRateChanged(uint32, uint32)` | validator | 佣金率变更历史；触发 refresher 刷新 |
| `WithdrawalFeeInGweiChanged(uint96, uint96)` | validator | 同上 |
| `WithdrawCommission(address indexed owner, address indexed withdrawal, uint amount)` | validator | 佣金提取流水 |
| `WithdrawTipFee(address indexed owner, address indexed withdrawal, uint amount)` | validator | tip fee 提取流水 |

**不收集的**

| 事件 | 原因 | 替代办法 |
|---|---|---|
| `DistributeRewards` | 系统调用触发，日志取不到 | 每块奖励改从区块的 `withdrawals` 前三条采集（见"区块奖励、佣金、社区税、基金会奖励与罚没"），第 0 条就是分给出块 validator 的奖励，社区税和佣金按合约规则从它算出 |
| `Exited` / `Slashed`（validator 合约） | 按需求不记录。退出改用 Staking 合约的 `ValidatorExited`；`Slashed` 走系统调用，本来也取不到 | 罚没对份额的影响仍由 refresher 校正（`SlashDetected`，见 Refresher），只用于保证份额正确，不对外提供罚没接口 |
| `PopWithdrawEntry` | 主要在系统调用里出队，日志不完整 | 待解押队列一律用 `withdrawCount()` / `getWithdraw(i)` 读当前状态（二期） |
| `PushWithdrawEntry` | 正常入队（`isFailed=false`）能取到，但失败重入队（`isFailed=true`）发生在系统调用里；只收一半反而误导 | 同上。解押记录本身已有 `Undelegate` 事件，完成高度 = 解押块号 + `minWithdrawabilityDelay()` |
| `DepositEvent` / `OperatorChangeQueued` / `OperatorChangeCancelled` / `OperatorUpdated`（Deposit 合约） | 共识层 deposit 与 operator 变更，跟委托统计无关 | `operatorAddress()` 由 refresher 读 |

## 同步：`StakingSync`

`stat/service/staking/StakingSync.ts` 是个库模块，由 `TokenMiscSync.main()` 启动，跑在 `token_x` 容器里，不新增容器。这个文件同时带一个 `require.main` 入口，方便单独执行 `backfill` / `refresh-once` / `diff` 命令。

骨架照抄 `eip7702.ts`：`setTimeout` 循环 + `safeAddErrorLog`，写库用 `bulkCreate(ignoreDuplicates)`，放在事务里。RPC 用 `initEthSdk(ConfigInstance.ether?.url)`。

**每轮处理一个窗口 `[from, to]`**
- `to = min(safeHead, from + range - 1)`。`safeHead` = `latest - confirmations`，`confirmations` 默认 0：CometBFT 出一块即终局（第 0 步第 3 项）。
1. `getLogs({address: STAKING, topics: [[ValidatorCreated, ValidatorInitialized, ValidatorExited]]})`：新 validator 写进 `staking_validator`，同时加入内存里的地址集合。`ValidatorCreated` 只用来发现地址，不对外展示；创建高度以 `ValidatorInitialized` 为准。
   - 必须先做这一步：validator 创建后同一块里就可能收到委托，先有地址才收得到。`ValidatorInitialized` 在这里就给 operator 记初始份额。
2. `getLogs({address: [所有 validator], topics: [[Delegate V1/V2, Undelegate V1/V2, OwnershipTransferred, CommissionRateChanged, WithdrawalFeeInGweiChanged, WithdrawCommission, WithdrawTipFee]]})`。
   - 地址按 500 个一组分批查（`ADDRESS_CHUNK`）。
3. 在同一个事务里：
   - 写 `staking_event`，已存在的忽略；
   - 按事件把 shares 增量更新到 `staking_delegation`：ValidatorInitialized 给 operator 加 amount，Delegate 加，Undelegate 减（罚没没有事件，由 refresher 校正）；
   - 推进游标。
   - 增量**只对新插入的事件**生效：先插事件，拿到实际插入的行，再只对这些行做增量。这样同一窗口重跑是幂等的。

**其他处理**
- 回灌：从块 1 开始跑（第一条 Delegate 在块 117,516，早于第一个 `ValidatorCreated`，见第 0 步），逻辑同上。主网 Xangle 的 seed 只有约 9k 条 delegate_trx，量很小。
- getLogs 出错时减半窗口重试，参考 `LogFetcher` 的做法。窗口大小从配置读。
- 回滚：如果有终局就不处理 reorg。如果只能靠确认数，就在每个窗口末尾记下 blockHash，下一轮先比对，不一致就删掉 `≥ from` 的事件，按事件反向扣回 shares，再回退游标。第 0 步确认终局之后再定做不做。
- 失败的交易：Xangle 会把失败的 delegate / undelegate 交易也记下来，出现在交易列表里。我们库里已经有全量交易（`full_tx` 带 status），**一期不单独存**。接口需要时，用"to ∈ validator 集合 + selector ∈ {`0x5c19a95c`, `0x4d99dd16`} + status = 失败"从现有交易表查。见待决问题 3。

### Refresher（周期任务，默认 60s）
- 放在同一个进程里，只读链上 view 函数。
- 对每个 validator 批量 `eth_call`：`owner`、`operatorAddress`、`description`、`commissionRate`、`withdrawalFeeInGwei`、`tokens`、`rewards`、`delegatorShares`、`commission`、`tipFee`、`stakes`、`annualPercentageYield`、`bondStatus`、`minSelfDelegationInGwei`。
  - 用 ethers 批量调用，或者上 Multicall3（先确认链上有没有部署）。
- 共识层状态：`validatorRpc` 指向 `/eth/v1/beacon/states/head/validators`，按 pubkey 匹配，复用 `ZGSupply.sumValidatorBalance` 的 fetch 逻辑。
  - **这一步失败不能影响 EVM 部分的刷新**。Xangle 一旦 beacon 调用失败，整轮都会中止。
- 罚没校正（每轮）：罚没只扣 operator 的份额，而且没有事件。所以每轮顺带调一次 `getDelegation(operator)`（每个 validator 一次调用），并检查 `Σ staking_delegation.shares == delegatorShares()`。
  - operator 份额跟库里不一致时，以链上值为准更新，同时写一条 `eventType = SlashDetected` 的合成记录（`blockNumber` = 刷新时的块号，`amount` 留空，`shares` = 差值），并告警。这条记录只为保证份额正确，不对外展示。
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
  confirmations?: number,     // 默认 0
  logRange?: number,          // 默认 100,000，即 RPC 的块范围上限
  refreshIntervalMs?: number,
  enabled?: boolean,          // 默认 false
}
```

- `run.sh` 生成的 `Prod.js` 连 `ether` 都没有（`_RPC` 在 EVM 模式下是 cfx-bridge，不是 EVM RPC），所以 `staking`、`ether`、`validatorRpc` 都要在部署的 `Prod` 里手工加，没有改 `run.sh`。

## 查询与 API

`stat/service/staking/StakingQuery.ts` 负责查询和计算，`open-api/service/OpenStakingService.ts` 负责参数校验和格式化。路由只注册在 `ESpaceApiRouter`（0G 只跑 EVM 模式）。

**计算口径**
- 统一在查询层算：`value(shares) = shares × (tokens + rewards) / delegatorShares`。
- "自质押"：`delegator == validator.owner`。
- 委托 / 解押汇总（两个 sum 接口和活跃度图表）：`delegated` = Σ `Delegate.amount`，`undelegated` = Σ `Undelegate.amount`，分开给出，`net` = 两者之差；从不把两者相加。罚没不计入；`ValidatorInitialized` 的初始自质押和创世份额也不计入（它们在 `staking_event` 里是另外的 eventType，需要时可以加开关）。V2 事件按 `delegator` 归属，不按 `payer`。`Undelegate.amount` 是解押时 shares 折算出的代币数，包含之前累积的奖励，所以 `net` 是资金流向，不是本金变化。

| 接口（暂定 `/open/staking/…`） | 对应 Xangle | 说明 |
|---|---|---|
| `GET /summary` | #1 | 总委托 = Σ tokens；委托人数 = **去重后**的地址数（shares > 0）；validator 总数 / 活跃数 |
| `GET /validators?status=&term=&sort=&order=` | #2 | 占比和累计占比在查询层算；validator 不超过 200 个，不分页 |
| `GET /validator?address=` | #3 | 包含 selfDelegated、selfDelegatedPercent、APY（字段就叫 APY，不写成 APR） |
| `GET /validator/delegators?address=&skip=&limit=` | #4 | 按 shares 倒序；delegationCount 用一条 GROUP BY 查出来，避免 Xangle 的 N+1 查询 |
| `GET /events?validator=&delegator=&type=&start=&end=&skip=&limit=` | #5 | 全部事件的原始流水，来自 `staking_event`；`type=delegate,undelegate` 即委托流水，额外返回 shares 和 blockHash |
| `GET /delegator/validators?address=&sort=` | #6 | 委托人视角 |
| `GET /charts/breakdown` | #7 | 自质押和他人委托各占多少 |
| `GET /validator/delegations/sum?address=&start=&end=&interval=` | 新增 | 某 validator 在 `[start, end)` 内的 Delegate 和 Undelegate 金额合计及笔数，分开给出，另附 `net` = 委托 − 解押。`interval` 为空时返回一个总数；传 `day` / `hour` 时按时间分桶返回序列。时间用秒级时间戳，范围上限先定 366 天 |
| `GET /delegator/delegations/sum?address=&start=&end=` | 新增 | 某 delegator 在所有 validator 上的 Delegate 和 Undelegate 累计金额及笔数，分开给出，另附 `net`；按 validator 拆分的明细按总活跃量（委托 + 解押）排序。`start`/`end` 可选，不传就是全部历史 |
| `GET /charts/activity?days=5` | #8 | Delegate 和 Undelegate 分开统计（`delegated` / `undelegated` / `net`），不剔除 owner 自己的委托；按天 × validator 取总活跃量（委托 + 解押）前 10，其余归到 others |

- 响应外层沿用 EVM 模式的 `{status, message, result}`。
- 接口加进 `document/evm-open-api.yaml`。
- 前端兼容见待决问题 1。

## validator 事件接口（二期 A，设计）

目标：下面 8 个事件落库，并按业务含义对外提供接口。

| 合约 | 事件 |
|---|---|
| `IValidatorContract`（各 validator 地址） | `Delegate`、`Undelegate`、`CommissionRateChanged`、`WithdrawalFeeInGweiChanged`、`WithdrawCommission`、`WithdrawTipFee` |
| `IStakingContract`（Staking 合约） | `ValidatorInitialized`、`ValidatorExited` |

validator 合约的 `Exited`、`Slashed` 不记录：退出改由 Staking 合约的 `ValidatorExited` 表示；`Slashed` 走系统调用，本来也取不到。

### 现状与缺口

| 事件 | 落库 | 对外 | 缺口 |
|---|---|---|---|
| `Delegate` / `Undelegate` | ✅ | `/events`、委托人列表、两个 sum 接口、活跃度图表 | 无（sum 和图表已同时统计 Undelegate） |
| `CommissionRateChanged` / `WithdrawalFeeInGweiChanged` | ✅ | `/validator/param-changes` | 无（已实现） |
| `WithdrawCommission` / `WithdrawTipFee` | ✅ | `/fees`、`/validator/fee-withdrawals` | 无（已实现，refresher 读 `tipFee()`） |
| `ValidatorInitialized` / `ValidatorExited` | ✅ | `/validators`、`/validator` 的 `created` / `exited` | 无（已实现） |
| `Exited`（validator 合约） | 已停止收集（2026-11-04） | `/events?type=exited` 只返回停收前的历史行 | 已完成：从 topic 过滤和解码里删除，已落库的行保留不动 |

### 设计原则
- **通用流水保留，业务接口另开**：`/staking/events` 继续作为全部事件的原始流水（排查用）；每类事件再给一个字段明确、不带 `extra` 的业务接口，前端只用业务接口。
- **一张事件表**：不为每类事件建表，现有索引 `(validator, eventType, createdAt)` 足够支撑下面所有按 validator 的查询。
- **创建 / 退出直接查事件表**：每个 validator 最多一条 `ValidatorInitialized`、一条 `ValidatorExited`，列表查询时一条 SQL 按 eventType 取出全部，不在 `staking_validator` 上冗余存储，也就不用回填。原计划是冗余存 4 列，实现时改成了这样。
- 沿用现有约定：金额是 wei 整数字符串，比例同时给原始值和百分比字符串，时间是 unix 秒，分页 `skip` / `limit`，外层 `{status, message, result}`。

### 接口

所有路径在 `/open/staking` 下。

**1. 委托流水** —— 不新开接口

用一期的 `GET /events?type=delegate,undelegate&validator=&delegator=&start=&end=&skip=&limit=`，它替代 Xangle 的 `delegate/trx/list`。对这两类事件：`account` 是委托人；`counterparty` 在 Delegate V2 里是 payer，在 Undelegate V2 里是收款地址，V1 为 null。曾设计过字段改名的 `GET /delegations`，因为和 `/events` 数据、参数都重复，已删掉（2026-11-04）。

`GET /validator/delegations/sum` 和 `GET /delegator/delegations/sum` 已经同时返回 Delegate 和 Undelegate 的合计（2026-11-04 实现）。

**2. 参数变更历史** —— `GET /validator/param-changes?address=&type=&skip=&limit=`

`type` 为 `commission_rate` / `withdrawal_fee`，缺省两种都要。

返回 `{total, list: [{type, oldValue, newValue, oldPercent, newPercent, blockNumber, txHash, timestamp}]}`：
- `commission_rate`：`oldValue` / `newValue` 是原始值（1e6 = 100%），`oldPercent` / `newPercent` 是 `"5.00"` 这样的百分比；
- `withdrawal_fee`：`oldValue` / `newValue` 是 gwei，百分比字段为 null。

**3. 手续费** —— `GET /fees?address=` 和 `GET /validator/fee-withdrawals`

口径：
- **commission 总额** = 当前 `commission()` + Σ `WithdrawCommission.amount`
- **tipFee 总额** = 当前 `tipFee()` + Σ `WithdrawTipFee.amount`

当前值来自 refresher 刷新的 `staking_validator.commission` / `tipFee`（最多滞后一个刷新周期），已提金额从事件表汇总。

`GET /fees?address=`：`address` 可选，不给就返回全部 validator，按 `commission.total + tipFee.total` 倒序。

```json
{
  "list": [{
    "validator": "0x…", "moniker": "…",
    "commission": {"current": "…", "withdrawn": "…", "total": "…", "withdrawCount": 3},
    "tipFee":     {"current": "…", "withdrawn": "…", "total": "…", "withdrawCount": 1},
    "total": "…",
    "refreshedBlock": 46140217
  }]
}
```

对应的 SQL（已提部分）：

```sql
select validator,
       sum(case when eventType = 23 then amount else 0 end) as commission_withdrawn,
       sum(case when eventType = 23 then 1 else 0 end)      as commission_withdraw_count,
       sum(case when eventType = 24 then amount else 0 end) as tip_fee_withdrawn,
       sum(case when eventType = 24 then 1 else 0 end)      as tip_fee_withdraw_count
from staking_event
where eventType in (23, 24)            -- WithdrawCommission, WithdrawTipFee
  [and validator = ?]
group by validator;
```

再和 `staking_validator` 的 `commission` / `tipFee` 相加。

`GET /validator/fee-withdrawals?address=&type=commission|tip_fee&start=&end=&skip=&limit=`：提取明细，返回 `{total, list: [{type, owner, withdrawalAddress, amount, blockNumber, txHash, timestamp}]}`。

注意：`withdrawCommission` 只是把佣金放进提现队列，到账要等 `minWithdrawabilityDelay`；接口里的 `withdrawn` 指"已从佣金余额提出"，不代表已到账。

**4. 创建与退出** —— 合进 `GET /validators` 和 `GET /validator`

每个 validator 增加两个字段：

```json
"created": {"blockNumber": 1234567, "txHash": "0x…", "timestamp": 1761782400, "operator": "0x…", "initialStake": "500000000000000000000"},
"exited":  {"blockNumber": 2345678, "txHash": "0x…", "timestamp": 1776561910}
```

- `created` 取自 `ValidatorInitialized`：块号、交易哈希、时间，以及事件里的 `operator` 和 `amount`（初始自质押）。
- `exited` 取自 `ValidatorExited`，没退出就是 null。
- 创世 validator 没有 `ValidatorInitialized`：`created` 为 null，靠已有的 `isGenesis: true` 区分。
- 只创建未初始化的 validator（有 `ValidatorCreated`、没有 `ValidatorInitialized`）：`created` 为 null，`isGenesis` 为 false。这种 validator 不能出块，列表里可按需过滤。
- 罚没导致的退出没有 `ValidatorExited`，`exited` 为 null。接受这个缺口；需要时可以看 `bondStatus`（1 = Unbonded）。

需要按时间列出创建或退出记录时，用 `/events?type=validator_initialized` 或 `validator_exited`，不单独开接口。

**5. 通用流水** —— `GET /events`：不再返回合成的 `slash_detected` 记录，`type` 也不再接受它；`exited` 保留为可选类型，只能查到停收前的历史行（2026-11-04 已实现）。

### 实现与验证（2026-11-05）

| 位置 | 改动 |
|---|---|
| `stat/model/Staking.ts` | `staking_validator` 加 `tipFee` 列；已存在的表由 `DBProvider.migDB()` 用 `addColumnIfNotExistsV2` 补列 |
| `StakingAbi.ts` | `VALIDATOR_ABI` 加 `tipFee()`；`Exited` 已不再收集 |
| `StakingRefresher.ts` | 每轮读 `tipFee()`（每个 validator 最多 16 个调用，3 个一批，仍低于单批 50 的限流线） |
| `StakingQuery.ts` | `listParamChanges`、`getFees`、`listFeeWithdrawals`；`lifecycles()` 从事件表取 `created` / `exited`，用于 `/validators` 和 `/validator` |
| `OpenStakingService.ts` / `ESpaceApiRouter` | `GET /validator/param-changes`、`GET /fees`、`GET /validator/fee-withdrawals` |
| `document/evm-open-api.yaml` | 3 个新接口，以及 `created` / `exited` 字段说明 |

在测试网（本地 MySQL 容器）上验证：
- `migDB` 给已存在的 `staking_validator` 补上了 `tipFee` 列；
- 14 个 validator 的 `commission` / `tipFee` 当前值，与链上在 `refreshedBlock` 读到的值全部一致；
- `/fees` 里的 `withdrawn` / `withdrawCount`，与翻页取完 `/validator/fee-withdrawals` 后的金额之和、条数完全一致（某 validator：佣金 143 条、tip fee 39 条）；
- `/validator/param-changes` 正确返回某 validator 佣金率 10% → 9% → 10% 的两次变更；
- `created` / `exited`：创世 validator 的 `created` 为 null，有 `ValidatorExited` 的显示退出块和交易；罚没退出的 `0x4b99…` 的 `exited` 为 null、`bondStatus` 为 1，符合设计里说明的缺口；
- 参数错误按预期拒绝。

## 区块奖励、佣金、社区税、基金会奖励与罚没（逐块采集，二期 B）

### 口径

每个区块（`eth_getBlockByNumber`）的 `withdrawals` 前三条（`index` 和 `validatorIndex` 都是哨兵值 `0xffffffffffffffff`，`amount` 单位 gwei）以及 `slashed` 数组，加上 validator 合约的分配规则，得出下面这些量：

| 量 | 定义 | 去向 |
|---|---|---|
| **validator 奖励** `reward` | `withdrawals[0].amount` | 本块出块 validator 的合约地址 |
| **社区税** `communityTax` | `reward × communityTaxRate / 1,000,000`，目前固定 10%（`communityTaxRate = 100000`） | validator 合约当场转给 Staking 合约的 `communityPoolAddress()` = `0x51e0…04c7` |
| **佣金** `commission` | 满足自质押门槛时为 `reward × commissionRate / 1,000,000`，否则为 0（见下） | 留在 validator 合约里，owner 以后用 `withdrawCommission` 提取 |
| **委托人奖励** `delegatorReward` | `reward − communityTax − commission` | 计入池子，按 shares 分给所有委托人（含 owner） |
| restaking 奖励 | `withdrawals[1].amount` | 地址不固定，多数块为 0；采集保存，本期不出接口 |
| **基金会奖励** `foundationReward` | `withdrawals[2].amount` | 固定为 `0x711b…2522`（EOA） |
| **罚没** `slashedAmount` | `slashed[i].amount` | 按 `slashed[i].address` 归属：它就是被罚 validator 的合约地址（第 0 步第 6 项） |

`reward` 到社区税、佣金、委托人奖励的拆分就是合约 `_distributeRewards(amount)` 的逻辑（`ValidatorContract.sol:655-679`）：先扣税，再算佣金，剩下的进 `rewards`。

**已核实**（2026-11-04，主网，`https://evmrpc.0g.ai`，支持按历史块号读状态）：
- 三条之和逐块等于 CL 接口 `/eth/v1/beacon/blocks/{n}/total_withdrawals` 的 `rewards` 增量。在块 10,877,919、30,914,561 和 head 附近两块上验证过，完全相等。
- `withdrawals[0]` 的地址都是 Staking 合约登记过的 validator；`withdrawals[2]` 的地址 40 块全是 `0x711b…2522`。
- `communityTaxRate` 在当前块和块 11,000,000 上都是 100000。
- 抽查 5 个 validator：`0xcb8f…`、`0x8156…`（创世 validator）的 owner 自质押是 0，低于门槛 500 0G，**它们现在每块的佣金都是 0**；另外 3 个满足门槛，`commissionRate` 分别是 10000 / 50000 / 100000。

### 佣金的计算

合约里佣金有前提：`_checkSelfDelegation()`，即 `getDelegatedTokens(owner) ≥ minSelfDelegationInGwei × 1e9`（`operatorAddress()` 就是 `owner()`）。所以每块的佣金要知道两样东西：

1. **当时的 `commissionRate`**：按 validator 维护费率时间线。初始费率用历史状态读取初始化块的 `commissionRate()`，之后按 `CommissionRateChanged` 事件逐次更新（一期已采集）。
2. **当时是否满足门槛**：维护"达标"时间线。它只会在以下时刻跳变：
   - owner 自己的 Delegate / Undelegate；
   - `OwnershipTransferred`（换了 owner）；
   - 罚没（只扣 owner 的 shares）。

   在这些块上，用历史状态读 `getDelegatedTokens(owner)` 和 `minSelfDelegationInGwei()`，得到新的达标状态。两次跳变之间，owner 的代币价值只会随奖励上涨，所以只可能从不达标变成达标；这种情况由下面的逐日对账发现，再二分定位到具体块。

**逐日对账（佣金）**：每个 UTC 日结束时，用历史状态读每个 validator 的 `commission()`，计算

```
当日实际计提 = commission(日末) − commission(上日末) + 当日 Σ WithdrawCommission.amount
```

并与当日逐块计算的佣金之和比较，必须相等。不相等就告警，并在当天二分找出差异开始的块（通常是达标状态变化），修正时间线后重算当天。

**社区税率**：`setCommunityTaxRate` 不发事件。按配置的 10% 计算，逐日对账时顺带用历史状态读日末的 `communityTaxRate()`；如果变了，就二分找出变化的块，记入税率时间线并重算。

### 数据来源的保障

与已下线的同步的区别：`ZGSupply` 原来那个逐块同步（`block_withdraws`）在 `1504491` 退役了，退役原因是它没挂在任何容器里，停了 157 天才被发现。新的采集吸取这个教训：
- 跑在 `token_x` 里，和 `StakingSync` 一起启动，不再靠手工执行；
- 每轮和 CL 的累计 `rewards` 对账，对不上或游标落后就告警，不会悄悄停住；
- 不参与供应量计算，供应量仍然读 CL 的累计接口。

### 采集方式

- 新的循环 `StakingBlockSync`，游标存在 KV 里（`STAKING_BLOCK_REWARD_BLOCK`），从 withdrawal 激活块 **10,877,918** 开始。
- **游标不能超过 `StakingSync` 的事件游标**：佣金要用到 `CommissionRateChanged`、owner 的委托事件和 `OwnershipTransferred`，这些事件必须先落库。
- 每次用 JSON-RPC batch 请求 100 个块（`eth_getBlockByNumber(n, false)`），只取 `withdrawals` 和 `slashed`，一批写一个事务。上限到 `latest - confirmations`。
- 回灌量：截至 2026-11-04 约 3,840 万块（10,877,918 → 49,258,809）。按每秒 10 个 batch（1,000 块/秒）估算约 11 小时，实际速度取决于 RPC 限流。逐日对账回灌约 380 天 × 100 个 validator × 每天 2 次 `eth_call`，量很小。
- 解析规则（不符合就告警，不猜位置）：
  - 前三条必须都带哨兵 `validatorIndex`；
  - `withdrawals[0]` 的地址应在 validator 集合里，不在也照样记录；
  - `withdrawals[2]` 的地址应为配置的基金会地址（默认 `0x711b…2522`），不是也照样记录。

### 数据模型

**`staking_block_reward`**，每块一行，约 3,840 万行，按块号分区（参照 `full_block`）：

| 列 | 说明 |
|---|---|
| `blockNumber` PK | |
| `createdAt` | 区块时间；建索引 `(createdAt)` 和 `(validator, createdAt)`，供时间段两端的零头查询用 |
| `validator` | `withdrawals[0].address`，出块 validator |
| `reward` | `withdrawals[0].amount`，wei |
| `communityTax` / `commission` | 按上面的规则在写入时算好 |
| `restakingAddress` / `restakingReward` | `withdrawals[1]` |
| `foundationAddress` / `foundationReward` | `withdrawals[2]` |

委托人奖励不存，查询时用 `reward − communityTax − commission` 算出。

**`staking_block_slash`**，罚没原样保存：`blockNumber`、`createdAt`、`position`、`slashIndex`、`validatorIndex`、`address`、`amount`（wei）、`validator`（= `address`，即被罚 validator 的合约地址；`slashIndex` 存证据高度，`validatorIndex` 存共识层编号）。唯一键 `(blockNumber, position)`。

**`staking_reward_daily`**，按 (UTC 日, validator) 汇总，和逐块数据在同一个事务里累加：`day`、`validator`、`blockCount`、`reward`、`communityTax`、`commission`、`restakingReward`、`foundationReward`、`slashCount`、`slashedAmount`。唯一键 `(day, validator)`，一年约 4 万行。社区税和基金会奖励都按出块 validator 记，全网合计 = 所有行之和。

**`staking_rate_timeline`**，佣金计算用的时间线：`validator`（社区税率用空字符串）、`fromBlock`、`kind`（`commission_rate` / `self_delegation_ok` / `community_tax_rate`）、`value`，以及 `source`（`event` / `state_read` / `bisect`）。

### 累计与时间段的算法

- **累计**：对 `staking_reward_daily` 求和，截止到采集游标所在的块。响应带 `asOfBlock` / `asOfTime`。
- **时间段 `[start, end)`**（unix 秒）：中间完整的 UTC 日查日汇总表，两端不满一天的部分查逐块表（按 `createdAt`，最多约两天的块），罚没直接查罚没表。`end` 超过 `asOfTime` 时按 `asOfTime` 截断，并在响应里注明。时间段上限 366 天。
- **`interval=day`**：额外返回逐日序列。暂不支持按小时分组。

### 对账与告警

- **每轮**：累计 `reward + restakingReward + foundationReward` 必须等于 CL `total_withdrawals` 在游标块的 `rewards`。CL 返回的是 gwei，比较前要换算。
- **每日**：佣金按上面的公式对账；同时检查 `communityTaxRate` 有没有变。
- **新鲜度**：游标落后 `latest` 超过阈值（比如 10 分钟的块数）就告警。

### 接口

所有路径在 `/open/staking` 下，金额是 wei 整数字符串，时间是 unix 秒。三个接口都返回 `cumulative`（累计）；给了 `start` 时再返回 `range`（时间段），`interval=day` 时 `range` 里带逐日的 `list`。

**（1）validator 的奖励、佣金、罚没** —— `GET /validator/rewards?address=&start=&end=&interval=`

```json
{
  "validator": "0x…", "moniker": "…",
  "asOfBlock": 49260867, "asOfTime": 1793500000,
  "cumulative": {
    "blockCount": 812345,
    "reward": "…", "communityTax": "…", "commission": "…", "delegatorReward": "…",
    "slashCount": 0, "slashedAmount": "0"
  },
  "range": {"start": 1790000000, "end": 1793500000, "blockCount": 2310, "reward": "…", "communityTax": "…", "commission": "…", "delegatorReward": "…", "slashCount": 0, "slashedAmount": "0",
            "list": [{"date": "2026-10-01", "blockCount": 77, "reward": "…", "...": "..."}]}
}
```

- `address` 可选：不给就返回全网合计，外加 `validators` 数组，每个 validator 一行，可用 `sort=reward|commission|blockCount|slashedAmount` 排序。
- `commission` 是计提的佣金，跟一期 `/fees` 接口里"当前未提 + 已提"对应：在佣金对账通过的前提下，累计计提 = 当前 `commission()` + Σ `WithdrawCommission`。
- `/validator` 和 `/validators` 也带上 `cumulative` 这组字段。

**（2）社区税** —— `GET /community/tax?start=&end=&interval=&validator=`

```json
{
  "communityPool": "0x51e0232fa953fea9bb9218b369472b06117c04c7",
  "communityTaxRate": 100000,
  "asOfBlock": 49260867, "asOfTime": 1793500000,
  "cumulative": {"tax": "…", "blockCount": 38382891},
  "range": {"start": 1790000000, "end": 1793500000, "tax": "…", "blockCount": 3500000, "list": [{"date": "2026-10-01", "tax": "…"}]},
  "byValidator": [{"validator": "0x…", "moniker": "…", "tax": "…", "blockCount": 2310}]
}
```

`communityTaxRate` 是当前费率。`validator` 可选，给了就只统计该 validator 缴的税。`byValidator` 的统计范围和 `range` 相同，没给时间段就是累计。

**（3）基金会奖励** —— `GET /foundation/rewards?start=&end=&interval=`

```json
{
  "foundationAddress": "0x711b0ecb072c27de0e50c9944d7195a51b202522",
  "asOfBlock": 49260867, "asOfTime": 1793500000,
  "cumulative": {"amount": "…", "blockCount": 38382891},
  "range": {"start": 1790000000, "end": 1793500000, "amount": "…", "blockCount": 3500000, "list": [{"date": "2026-10-01", "amount": "…"}]}
}
```

如果 `withdrawals[2]` 出现过别的地址，响应里另加 `byAddress` 拆分。正常情况下只有一个地址。

**明细接口**（保留）：
- `GET /slashes?validator=&start=&end=&skip=&limit=`：罚没明细；
- `GET /validator/blocks?address=&start=&end=&skip=&limit=`：某 validator 出的块，以及每块的 `reward` / `communityTax` / `commission`。

### 改动清单

| 位置 | 改动 |
|---|---|
| `stat/model/Staking.ts` | 四张新表：`staking_block_reward`（分区）、`staking_block_slash`、`staking_reward_daily`、`staking_rate_timeline` |
| `stat/service/staking/StakingBlockSync.ts`（新） | 逐块 batch 采集；按时间线计算社区税和佣金；写逐块表和日汇总；推进游标（不超过事件游标）；与 CL `rewards` 对账 |
| `stat/service/staking/StakingRateTimeline.ts`（新） | 维护费率和达标时间线：事件驱动更新 + 历史状态读取 + 二分定位；逐日佣金对账 |
| `StakingRefresher.ts` | 无需改动：罚没按 `address` 直接归属，不再需要 beacon 的 `index → pubkey` 映射 |
| `StakingMain.ts` | `startStaking()` 一起启动；命令行增加 `blocks`（回灌）、`check-rewards <block>`（单块对账）、`check-commission <validator> <day>`（单日佣金对账） |
| `StakingQuery.ts` / `OpenStakingService.ts` / `ESpaceApiRouter` / swagger | 3 个统计接口、2 个明细接口，以及 `/validator`、`/validators` 的新字段 |
| `StatConfig.staking` | `blockBatchSize`（默认 100）、`blockConcurrency`、`rewardStartBlock`（默认 10,877,918）、`foundationAddress`（默认 `0x711b…2522`）、`communityTaxRate`（默认 100000）、`clTotalWithdrawalsUrl`（缺省复用 `validatorRpc`） |

估时约 3.5 天，其中佣金的时间线和对账约 1 天；另加回灌约 11 小时。

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
| 0 | 上链验证（上文第 0 步） | ✅ 已完成 |
| 1 | 模型、配置、StakingSync（发现 validator、写事件、维护 shares）、回灌、创世导入 | 2d |
| 2 | Refresher（view 调用、beacon 状态、对账） | 1d |
| 3 | StakingQuery 和 8 个接口、swagger | 2d |
| 4 | 跟 Xangle 数据对比，测试网验证，上线（`staking.enabled = true`） | 1d |
| 二期 A | validator 事件接口：参数变更历史、手续费、创建与退出（见上文） | ✅ 已完成（2026-11-05） |
| 二期 B | 区块奖励、佣金、社区税、基金会奖励与罚没：逐块采集、费率与达标时间线、日汇总、对账、3 个统计接口和 2 个明细接口（见上文） | 3.5d + 回灌约 11h |
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
- 它的注释提到 0G 靠 CometBFT 快速终局，所以只处理 committed chain、不处理 revert。这跟第 0 步第 3 项的结论一致。

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

**测试网端到端测试（2026-11-05，本地 MySQL 8.0 容器 + `https://evmrpc-testnet.0g.ai`）**

- `sync`：从块 1 追到 63,947,045，639 个窗口用时 22 分 40 秒（每窗约 2 秒，串行 RPC）。入库 569 条 Staking / Delegate / Undelegate 事件，与第 0 步的独立扫描逐条数量一致；validator 共 14 个，与 Xangle 测试网 seed 一致。
- `refresh`：14 个 validator 全部刷新成功；对账修正了 2 条负份额（测试网状态早于事件历史，见 `GENESIS_VALIDATORS.testnet`）。检测到 1 次罚没：validator `0x4b99…` 已是 Unbonded，却没有 `ValidatorExited`，owner 从未解押但份额从 500 变成 0，只能是 `slash(exited=true)`。测试网 RPC 不保留那段历史状态，没法二分到具体块。
- 10 个接口逐个调用：数值与链上直接读取一致（如 Xangle 那个 validator 的 staked 544.85、APY 178.31%），各视角互相对得上，参数错误都按预期返回。接口用 scratchpad 里的最小 Koa 服务测试，因为完整的 open-api 需要 `node-cint64` 原生模块，本机没编译。

测试中发现并修复的问题：
1. **ethers v5 的 `provider.getLogs()` 不接受 address 数组**（报 "invalid address or ENS name"）。改为直接发 `eth_getLogs`。第 0 步用的是裸 JSON-RPC，所以没发现。
2. **`staking_validator` 少了 7 列**：模型里 8 个金额字段共用了同一个属性定义对象，Sequelize 把它们都映射到了 `withdrawalFeeInGwei` 一列。`tokens`、`apy` 等读出来都是提现手续费，写入则悄悄丢失。改为每个字段各自生成定义。**已建过表的环境要手工补列**；生产环境还没建过这张表，不受影响。
3. **refresher 被 RPC 限流**：0G 的 RPC 单批超过 50 个调用就返回 `-32005 request rate exceeded`，ethers 把它报成 `CALL_EXCEPTION`。改为分块控制每批调用数（状态刷新 3 个 validator 一批，份额校验 10 个，对账 40 个），限流时指数退避重试。
4. **游标落后时 refresher 悄悄跳过对账**：现在会打日志；命令行的 `refresh` 先把同步追到链头再刷新。

**已知问题（2026-11-04 发现）**
- `1504491` 之后，`validatorRpc` 配置的是 CL 的 `.../blocks/head/total_withdrawals`，不再是 validators 接口。一期 refresher 的 `refreshBeaconStatus()` 仍然直接拿 `validatorRpc` 当 `/states/head/validators` 用，结果会是"empty beacon response"告警，`beaconStatus` 全部为空，`active` 全部为 false。已修复：改用 `ZGSupply.validatorRpcUrl()`，从 `validatorRpc` 推导出 validators 接口；用主网 beacon 验证过推导地址可用（67 个 validator，pubkey 格式与库里一致）。

**未验证**（需要 MySQL 和能访问 0G RPC 的环境）
- 同步、refresher 和查询的 SQL 都没在真实 MySQL 上跑过。
- 主网回灌，以及 `diff` 跟 Xangle 数据的比对。
- （第 0 步已于 2026-11-04 全部完成，见该节。）
