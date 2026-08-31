# 【变更申请】0gscan 后端新增 Partner 链上指标模块

| 项 | 内容 |
|---|---|
| 申请人 | zhu@0g.ai |
| 目标环境 | 0G mainnet (`zg-aristotle-scan-*`) |
| 代码基线 | `b3dc1d8` |
| 影响服务 | `stat_task`（重启）、`open_api`（重启） |
| 是否影响既有功能 | **否** —— 纯增量，不修改任何既有表、任何既有逻辑 |
| 预计停机 | 无（两个服务滚动重启即可） |
| 回滚难度 | 低（删 5 张新表 + 回滚代码） |

---

## 1. 背景

为 Solutions Hub（solutions.0g.ai/insights）的「0G Chain」模块提供 partner 级链上指标 API。对应需求文档：*Chain Metrics PRD*（Partner Consumption Dashboard 的扩展模块）。

partner 身份沿用 Router/PC 模块的 `source_id`（即 `X-0G-Source-Id` 请求头），保证同一 partner 在四个模块中身份一致。

---

## 2. 升级内容

### 2.1 代码变更

新增 6 个文件（约 1250 行）：

| 文件 | 作用 |
|---|---|
| `stat/model/PartnerChain.ts` | 5 张新表的模型定义 |
| `stat/service/partner/PartnerChainStat.ts` | 日聚合核心 SQL |
| `stat/service/partner/PartnerTvl.ts` | TVL 快照计算与落盘 |
| `stat/service/partner/PartnerBackfill.ts` | 历史回填 CLI |
| `stat/service/timerstat/StatDailyPartner.ts` | 日任务（挂在 stat_task） |
| `open-api/service/OpenPartnerChainService.ts` | API handler |

修改 5 个文件，共 **+53 行，纯新增**，无删除、无既有逻辑改动：

| 文件 | 改动 |
|---|---|
| `stat/service/DBProvider.ts` | 注册 5 个新模型 |
| `stat/StatTask.ts` | 挂载日任务 |
| `stat/monitor/DataTimeTables.ts` | 新表纳入/排除断更监控 |
| `open-api/router/ApiRouter.ts` | 注册路由 |
| `open-api/router/ESpaceApiRouter.ts` | 注册路由（EVM 链走这个分支） |

### 2.2 新增后台任务

`StatDailyPartner`，挂在 `stat_task` 进程内，10 分钟轮询一次，每次处理一个完整 UTC 日。断点续跑水位线存在 `kv` 表的 `KEY_PARTNER_STAT_DAY`。

### 2.3 新增 API 端点（`open_api`，前缀 `/open`）

| 方法 | 路径 |
|---|---|
| GET | `/open/partner/chain-metrics` |
| GET | `/open/partner/chain-metrics/summary` |
| GET | `/open/partner/tvl` |
| GET | `/open/partner/tvl/history` |
| GET | `/open/partner/contracts` |
| POST | `/open/partner/contracts` |

> ⚠️ **这 6 个端点当前没有任何鉴权**，详见第 7 节风险提示。

---

## 3. 对数据库的影响

### 3.1 DDL —— 只新建 5 张表，不修改任何既有表

服务启动时由 `sequelize.sync()` 自动执行（全部是 `CREATE TABLE IF NOT EXISTS`）。也可由 ops 提前手工执行，两者等价：

```sql
CREATE TABLE IF NOT EXISTS `partner` (`id` BIGINT NOT NULL auto_increment , `sourceId` VARCHAR(64) NOT NULL, `name` VARCHAR(128) NOT NULL DEFAULT '', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `partner` ADD UNIQUE INDEX `uk_sourceId` (`sourceId`);

CREATE TABLE IF NOT EXISTS `partner_contract` (`id` BIGINT NOT NULL auto_increment , `sourceId` VARCHAR(64) NOT NULL, `hex40id` BIGINT UNSIGNED NOT NULL, `effectiveFrom` DATETIME NOT NULL DEFAULT '1970-01-01 00:00:00', `effectiveTo` DATETIME, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `partner_contract` ADD UNIQUE INDEX `uk_source_contract` (`sourceId`, `hex40id`, `effectiveFrom`);
ALTER TABLE `partner_contract` ADD INDEX `idx_hex40id` (`hex40id`);

CREATE TABLE IF NOT EXISTS `daily_partner_stat` (`id` BIGINT NOT NULL auto_increment , `sourceId` VARCHAR(64) NOT NULL, `statTime` DATETIME NOT NULL, `txSuccess` BIGINT UNSIGNED NOT NULL DEFAULT 0, `txFailed` BIGINT UNSIGNED NOT NULL DEFAULT 0, `gasFeeSum` DECIMAL(65) NOT NULL DEFAULT 0, `gasFeeFailed` DECIMAL(65) NOT NULL DEFAULT 0, `activeAddr` BIGINT UNSIGNED NOT NULL DEFAULT 0, `nativeValue` DECIMAL(65) NOT NULL DEFAULT 0, `txSuccessCum` BIGINT UNSIGNED NOT NULL DEFAULT 0, `gasFeeSumCum` DECIMAL(65) NOT NULL DEFAULT 0, `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `daily_partner_stat` ADD UNIQUE INDEX `uk_source_statTime` (`sourceId`, `statTime`);
ALTER TABLE `daily_partner_stat` ADD INDEX `idx_statTime` (`statTime`);

CREATE TABLE IF NOT EXISTS `daily_partner_addr` (`id` BIGINT NOT NULL auto_increment , `sourceId` VARCHAR(64) NOT NULL, `statTime` DATETIME NOT NULL, `addr` BIGINT UNSIGNED NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `daily_partner_addr` ADD UNIQUE INDEX `uk_source_statTime_addr` (`sourceId`, `statTime`, `addr`);
ALTER TABLE `daily_partner_addr` ADD INDEX `idx_statTime` (`statTime`);

CREATE TABLE IF NOT EXISTS `daily_partner_tvl` (`id` BIGINT NOT NULL auto_increment , `sourceId` VARCHAR(64) NOT NULL, `statTime` DATETIME NOT NULL, `asOf` DATETIME NOT NULL, `tokenId` BIGINT UNSIGNED NOT NULL, `amount` VARCHAR(78) NOT NULL DEFAULT '0', `decimals` INTEGER, `symbol` VARCHAR(64), `priceUsd` DECIMAL(36,18), `valueUsdMicro` DECIMAL(65), `priceSource` VARCHAR(32) NOT NULL DEFAULT '', `createdAt` DATETIME NOT NULL, `updatedAt` DATETIME NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `daily_partner_tvl` ADD UNIQUE INDEX `uk_source_statTime_token` (`sourceId`, `statTime`, `tokenId`);
ALTER TABLE `daily_partner_tvl` ADD INDEX `idx_statTime` (`statTime`);
```

### 3.2 日常读负载（新增）

| 来源 | 频率 | 实测/估算 |
|---|---|---|
| 日聚合任务读 `full_tx` | 每天 2 次，各扫 1 个自然日区间 | 单次 **0.81 秒**（已在生产库实测，约 7.1 万行/天） |
| TVL 快照读 `cfx_balance` / `token_balance` | 每天 1 次 | 按 `addressId` 走索引，见下方注意事项 |
| API 查询 | 按前端调用量 | 只读新表（很小），`/partner/tvl` 除外（实时读余额表） |

> **注意**：`token_balance` 是 `partition by hash(contractId) 97 分区`，而本模块按 `addressId` 查询，二级索引是分区本地的 → 每个地址需要探测 97 个分区。注册合约数量较多时（>50）建议观察一下该查询耗时。

### 3.3 写负载与存储

| 表 | 每日新增行数 | 说明 |
|---|---|---|
| `daily_partner_stat` | = partner 数量 | 极小，可忽略 |
| `daily_partner_tvl` | = Σ(partner × 其持有的 token 种类) | 小 |
| **`daily_partner_addr`** | **= Σ(各 partner 当日去重调用地址数)** | **主要存储开销，见下** |

`daily_partner_addr` 用于计算「30 天去重活跃地址」（按日计数无法跨日相加）。实测生产库上最活跃的单个合约一天有 **31,871 个去重调用地址**。

代码内置 **120 天滚动窗口**（`ADDR_ROSTER_KEEP_DAYS`），日任务末尾自动分批清理（每批 5 万行）。所以该表体积**有上界不会无限增长**：

- 单个此量级 partner ≈ 380 万行 ≈ **600–700 MB**
- 总量 = 各 partner 规模之和，取决于最终注册多少 partner
- **建议**：上线后观察一周实际增长，如需压缩可后续把 `sourceId` 由 `varchar(64)` 改为整型外键

### 3.4 一次性历史回填

需要执行一次，从 `full_tx` 最早记录（**2025-08-23**）回填至今，共约 **370 天**。

- 纯查询耗时：370 × 0.81s ≈ **5 分钟**
- 默认每天间隔 sleep 200ms：+74 秒
- **合计约 7 分钟**
- 会完整扫过 `full_tx`（26,289,297 行 / 5.4 GB），**对 buffer pool 有冲刷**

建议在**业务低峰期**执行，sleep 参数可调大以进一步降压。

### 3.5 ⚠️ `stat_task` 重启的既有副作用

`stat_task` 启动时会调用 `initModel()`，其中的 `migDB()` 会对 **既有表**（`token`、`verified_contracts`、`contract_impl`、`kv` 等）执行 `ALTER TABLE` / `CREATE INDEX`。

- **这是既有行为，不是本次变更引入的**
- 对已迁移过的生产库均为幂等 no-op
- 但需确认执行账号具备 `ALTER` / `INDEX` 权限，否则启动会报错

如果希望完全规避，可选方案：由 ops 先手工执行 3.1 的 DDL，再重启服务。

---

## 4. 需要 ops 配合的事项

| # | 事项 | 是否阻塞 | 预计耗时 | 备注 |
|---|---|---|---|---|
| 1 | 部署代码到 `zg-aristotle-scan-sync` 和 `zg-aristotle-scan-api1/2` | 是 | — | 基线 `b3dc1d8` + 本次变更 |
| 2 | 重启 `stat_task`（sync 机） | 是 | 分钟级 | 会自动建表；注意 3.5 |
| 3 | 重启 `open_api`（api1/api2） | 是 | 分钟级 | 路由生效 |
| 4 | 导入 partner ↔ 合约映射到 `partner_contract` | 是 | — | **数据由业务侧提供**，见下 |
| 5 | 执行一次历史回填 | 是 | ~7 分钟 | 命令见下，建议低峰期 |
| 6 | 确认执行账号权限 | 是 | — | 见下 |
| 7 | 确认端点暴露范围（内网/白名单/公网） | **是** | — | **见第 7 节安全提示** |

### 4.1 关于第 4 项：注册数据来源

`partner_contract` 需要「`source_id` ↔ 链上合约地址」的映射。这份数据 **0gscan 侧没有**，需要由 Solutions Hub / 业务侧提供清单。Router 的 admin usage API 只按请求头 `X-0G-Source-Id` 打标，不记录合约地址。

导入方式二选一：

```sql
-- 方式 A：直接写库
INSERT INTO partner (sourceId, name, createdAt, updatedAt)
VALUES ('<source_id>', '<partner 名称>', now(), now());

INSERT INTO partner_contract (sourceId, hex40id, effectiveFrom, createdAt, updatedAt)
SELECT '<source_id>', h.id, '1970-01-01 00:00:00', now(), now()
FROM hex40 h WHERE h.hex = LOWER('<不带 0x 的 40 位地址>');
```

方式 B：调用 `POST /open/partner/contracts`（但见第 7 节，该接口目前无鉴权）。

> **约束**：同一个合约地址在同一时间窗内只能归属一个 partner，否则日聚合会重复计数。`uk_source_contract` 唯一索引 + 接口层冲突检查已做防护。

### 4.2 关于第 5 项：回填命令

```bash
node stat/service/partner/PartnerBackfill.js 2025-08-23 2026-08-29 200
```

参数：起始日 / 结束日（不含）/ 每日间隔毫秒。可重复执行（幂等，`ON DUPLICATE KEY UPDATE`）。

> ⚠️ 回填**必须覆盖 partner 首个合约有交易的那一天之后的全部区间**，因为累计列（`txSuccessCum` / `gasFeeSumCum`）是逐日前推计算的，从中途开始会导致累计值偏低。

### 4.3 关于第 6 项：所需权限

推荐直接复用 `stat_task` 现有账号（权限已足够）。如需单独账号，最小权限集：

```sql
GRANT CREATE ON `<db>`.* TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, INDEX ON `<db>`.`partner`            TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, INDEX ON `<db>`.`partner_contract`   TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, INDEX ON `<db>`.`daily_partner_stat` TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, INDEX ON `<db>`.`daily_partner_addr` TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE, INDEX ON `<db>`.`daily_partner_tvl`  TO '<user>'@'%';
GRANT SELECT ON `<db>`.`full_tx`       TO '<user>'@'%';
GRANT SELECT ON `<db>`.`hex40`         TO '<user>'@'%';
GRANT SELECT ON `<db>`.`token`         TO '<user>'@'%';
GRANT SELECT ON `<db>`.`token_balance` TO '<user>'@'%';
GRANT SELECT ON `<db>`.`cfx_balance`   TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE ON `<db>`.`kv` TO '<user>'@'%';
```

注意：单独账号还需 `ALTER` 权限才能通过 `migDB()`（见 3.5），所以复用现有账号更省事。

---

## 5. 验证方法

**① 表已创建**

```sql
SHOW TABLES LIKE '%partner%';
-- 期望 5 张：partner / partner_contract / daily_partner_stat / daily_partner_addr / daily_partner_tvl
```

**② 日任务在跑**

```sql
SELECT `key`, updatedAt FROM heart_beat WHERE `key` LIKE 'HB_stat_task%';
SELECT `key`, value FROM kv WHERE `key` = 'KEY_PARTNER_STAT_DAY';
-- 水位线应逐日推进
```

**③ 回填结果正确性**（已在生产库预先验证过基准值）

```sql
SELECT sourceId, statTime, txSuccess, txFailed, gasFeeSum, activeAddr, txSuccessCum
FROM daily_partner_stat ORDER BY statTime DESC LIMIT 10;
```

如果注册了合约 `0x61bb71442749d13a4bb7257dfbfff0452ae937f9`（`hex40id = 211840`），则 **2026-08-20** 当日应为：

| 字段 | 期望值 |
|---|---|
| `txSuccess` | `115496` |
| `txFailed` | `12541` |
| `gasFeeSum` | `92027689956383148142` |

> 该基准值由以下只读 SQL 独立核对过，两者必须完全一致：
> ```sql
> SELECT SUM(status=0), SUM(status=1), SUM(gas) FROM full_tx
> WHERE toId = 211840 AND createdAt >= '2026-08-20 00:00:00' AND createdAt < '2026-08-21 00:00:00';
> ```

**④ API 可访问**

```bash
curl -s 'http://127.0.0.1:9527/open/partner/chain-metrics/summary?period=30d' | jq .
```

---

## 6. 回滚方案

无数据风险，两步：

1. 回滚代码到 `b3dc1d8`，重启 `stat_task` 与 `open_api`
2.（可选）删除新表：

```sql
DROP TABLE IF EXISTS daily_partner_tvl, daily_partner_addr, daily_partner_stat, partner_contract, partner;
DELETE FROM kv WHERE `key` = 'KEY_PARTNER_STAT_DAY';
```

**本次变更不修改任何既有表的结构或数据**，回滚后系统状态与变更前完全一致。

---

## 7. ⚠️ 风险提示

### 7.1 端点当前无鉴权（上线前必须处理）

新增的 6 个端点目前**没有任何身份校验**，仅经过全局限流中间件。其中：

- `POST /open/partner/contracts` 是**写接口**，可修改 partner ↔ 合约归属关系，进而影响所有指标口径

**因此上线时二选一：**

- **方案 A（推荐）**：先只在内网 / 白名单暴露，不开放公网。等鉴权补齐后再开放
- **方案 B**：在 nginx 层临时屏蔽 `POST /open/partner/contracts`，GET 接口可先放开

鉴权方案（`rate_key` 静态 key 或 Router 的 `mk-` Bearer）尚在确认中，会作为后续独立变更提交。

### 7.2 回填期间的数据库压力

见 3.4。建议低峰期执行，并在执行时观察主库负载，必要时中断（可重复执行，不会产生脏数据）。

### 7.3 TVL 快照的时间敏感性

TVL 由实时读取余额表得到，代码内置保护：**采样时刻距日界超过 2 小时则跳过不写**。因此 `stat_task` 长时间停机会在 TVL 序列中留下永久空洞（余额表只有当前态，无法事后补）。

这是正确行为，不是缺陷 —— `daily_partner_tvl` 已在断更监控中设为 `ignore`，不会误报。但请尽量避免 `stat_task` 长时间停机。

---

## 8. 本次不交付的内容（供预期管理）

| 项 | 原因 |
|---|---|
| TVL 的 USD 折算 | 0gscan 尚未配置任何代币价格源（`token` 表 871 行中，`bnId` / `cmcId` 填写数均为 **0**，`price` 有值的为 **0** 行）。数量口径不受影响，价源配好后无需改代码即可自动生效 |
| TVL 历史回溯 | 余额表与价格表均为当前态覆盖写，历史不可重建。数量历史从本次上线之日起向前累积 |
| internal / proxy 调用归因 | 本链 `traceNotAvailable=true`，`trace` 表不存在，无数据源。当前仅统计直接调用 |
| API 鉴权 | 见 7.1，后续独立提交 |
| 合约级下钻、Top10 gas 榜、sparkline | 后续迭代 |

---

## 附：代码质量说明

- 全项目 TypeScript 编译 **0 错误**
- 核心聚合 SQL 已在**生产库只读验证**通过（三方交叉比对完全一致，见第 5 节 ③）
- 写入侧（INSERT / 累计列 / 幂等性）**尚未在真实环境验证**，建议先在预发或小范围日期区间试跑
