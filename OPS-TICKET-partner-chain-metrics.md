# 【变更申请】0gscan 后端新增 Partner 链上指标模块

| 项 | 内容 |
|---|---|
| 申请人 | zhu@0g.ai |
| 目标环境 | 0G mainnet (`zg-aristotle-scan-*`) |
| 代码基线 | `b3dc1d8` |
| 影响服务 | `stat_task`（重启）、`open_api`（重启） |
| 是否影响既有功能 | **否** —— 新建 6 张表，另给既有 `rate_key` 表增加一个可空列（详见 3.5） |
| 预计停机 | 无（两个服务滚动重启即可） |
| 回滚难度 | 低（删 6 张新表 + 回滚代码） |

---

## 1. 背景

为 Solutions Hub（solutions.0g.ai/insights）的「0G Chain」模块提供 partner 级链上指标 API。对应需求文档：*Chain Metrics PRD*（Partner Consumption Dashboard 的扩展模块）。

partner 身份沿用 Router/PC 模块的 `source_id`（即 `X-0G-Source-Id` 请求头），保证同一 partner 在四个模块中身份一致。

---

## 2. 升级内容

### 2.1 代码变更

新增 7 个文件（约 1350 行）：

| 文件 | 作用 |
|---|---|
| `stat/model/PartnerChain.ts` | 5 张新表的模型定义 |
| `stat/service/partner/PartnerChainStat.ts` | 日聚合核心 SQL |
| `stat/service/partner/PartnerTvl.ts` | TVL 快照计算与落盘 |
| `stat/service/partner/PartnerBackfill.ts` | 历史回填 CLI |
| `stat/service/timerstat/StatDailyPartner.ts` | 日任务（挂在 stat_task） |
| `open-api/service/OpenPartnerChainService.ts` | API handler |
| `open-api/router/partnerAuth.ts` | 接口鉴权中间件（scope 校验） |

修改 6 个文件，均为新增，无删除、无既有逻辑改动：

| 文件 | 改动 |
|---|---|
| `stat/service/DBProvider.ts` | 注册 6 个新模型；给 `rate_key` 增加 `scope` 列 |
| `stat/router/RateLimiter.ts` | `rate_key` 模型增加 `scope` 字段 + 导出查询函数 |
| `stat/StatTask.ts` | 挂载日任务 |
| `stat/monitor/DataTimeTables.ts` | 新表纳入/排除断更监控 |
| `open-api/router/ApiRouter.ts` | 注册路由 |
| `open-api/router/ESpaceApiRouter.ts` | 注册路由（EVM 链走这个分支） |

### 2.2 新增后台任务

`StatDailyPartner`，挂在 `stat_task` 进程内，10 分钟轮询一次，每次处理一个完整 UTC 日。断点续跑水位线存在 `kv` 表的 `KEY_PARTNER_STAT_DAY`。

### 2.3 新增 API 端点（`open_api`，前缀 `/open`）

| 方法 | 路径 | 所需 scope |
|---|---|---|
| GET | `/open/partner/chain-metrics` | `partner:read` |
| GET | `/open/partner/chain-metrics/summary` | `partner:read` |
| GET | `/open/partner/tvl` | `partner:read` |
| GET | `/open/partner/tvl/history` | `partner:read` |
| GET | `/open/partner/contracts` | `partner:read` |
| POST | `/open/partner/contracts` | `partner:write` |

全部端点**要求携带凭证**：

```
Authorization: Bearer <key>
```

**这套 Bearer 鉴权是本次新增的，0gscan 原先没有。** 需要 ops 了解的三点：

1. **凭证存储复用既有 `rate_key` 表**（新增 `scope` 列）。该表原本只用于限流分级，目前 **0 行**。由限流模块每 10 秒刷新进内存，鉴权本身不产生额外查询。
2. **既有的 web3pay 计费密钥体系（`checkApiKey`）与本模块无关**。该体系依赖 `billingApp` 配置，而 0G 环境未配置此项，`initBilling` 启动时会打印 `billing app not set` 并跳过 —— 本次变更不改变这一现状。
3. **没有任何自助签发流程**。仓库中不存在密钥生成接口或脚本（`RateKey` 只有读取代码，从不写入），因此凭证的签发、轮换、吊销**全部是 ops 手工执行 SQL**，详见 4.4。

错误语义：凭证缺失/未知/过期 → `401 invalid_auth`；凭证有效但缺 scope → `403 insufficient_scope`；参数错误 → `400 <具体 code>`。统一响应体：

```json
{"object": "error", "code": "insufficient_scope", "message": "..."}
```

> **注意**：`rate_key` 中原有的限流密钥 `scope` 默认为空字符串，**不会获得任何 partner 权限**，不影响既有用途。

---

## 3. 对数据库的影响

### 3.1 DDL —— 新建 6 张表，另给 `rate_key` 增加一列

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

CREATE TABLE IF NOT EXISTS `partner_audit` (`id` BIGINT NOT NULL auto_increment , `action` VARCHAR(32) NOT NULL, `sourceId` VARCHAR(64) NOT NULL, `actor` VARCHAR(128) NOT NULL DEFAULT '', `rateKeyId` BIGINT NOT NULL DEFAULT 0, `detail` VARCHAR(1024) NOT NULL DEFAULT '', `ip` VARCHAR(64) NOT NULL DEFAULT '', `createdAt` DATETIME NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
ALTER TABLE `partner_audit` ADD INDEX `idx_sourceId_createdAt` (`sourceId`, `createdAt` DESC);
ALTER TABLE `partner_audit` ADD INDEX `idx_createdAt` (`createdAt` DESC);
```

**对既有表的唯一改动** —— 给 `rate_key` 增加 `scope` 列存放接口权限。由 `migDB()` 自动执行（`sequelize.sync()` 不会给已存在的表加列，所以走的是这条路）：

```sql
ALTER TABLE `rate_key` ADD COLUMN `scope` VARCHAR(255) NOT NULL DEFAULT '';
```

该列**可空且有默认值**，既有行取空字符串，不获得任何 partner 权限，对现有限流逻辑无影响。

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
| `partner_audit` | = 写接口调用次数 | 极小；只在注册合约时写入 |
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
| 7 | 签发接口凭证并写入 `rate_key` | 是 | — | 见 4.4 |
| 8 | 确认端点暴露范围（内网/白名单/公网） | 建议 | — | 见第 7 节 |

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
GRANT SELECT, INSERT                    ON `<db>`.`partner_audit`          TO '<user>'@'%';
GRANT SELECT, ALTER                     ON `<db>`.`rate_key`               TO '<user>'@'%';
GRANT SELECT ON `<db>`.`full_tx`       TO '<user>'@'%';
GRANT SELECT ON `<db>`.`hex40`         TO '<user>'@'%';
GRANT SELECT ON `<db>`.`token`         TO '<user>'@'%';
GRANT SELECT ON `<db>`.`token_balance` TO '<user>'@'%';
GRANT SELECT ON `<db>`.`cfx_balance`   TO '<user>'@'%';
GRANT SELECT, INSERT, UPDATE ON `<db>`.`kv` TO '<user>'@'%';
```

注意：单独账号还需 `ALTER` 权限才能通过 `migDB()`（见 3.5），所以复用现有账号更省事。

---

### 4.4 关于第 7 项：签发接口凭证

所有 partner 端点都要求 `Authorization: Bearer <key>`。凭证放在既有的 `rate_key` 表，通过新增的 `scope` 列授权。

**建议只签发服务级凭证给 Solutions Hub 后端**，由它在自己这边判断"当前登录用户属于哪个 partner"。0gscan 侧不理解 partner 与用户的对应关系，也不做用户级授权 —— 这一点已在给业务方的接口说明中写明。

不要按 partner 逐个签发：本模块没有密钥管理系统，每签发一个都需要 ops 手工操作，无法规模化运营。

生成随机密钥：

```bash
python3 -c "import secrets; print('rw:', secrets.token_hex(24)); print('ro:', secrets.token_hex(24))"
```

```sql
-- 读 + 写（给 Solutions Hub 后端）
INSERT INTO rate_key (apiKey, level, qps, effectiveAt, expireAt, remark, scope, createdAt, updatedAt)
VALUES ('<随机 32+ 位字符串>', 'enterprise', 100,
        '2026-01-01 00:00:00', '2027-12-31 23:59:59',
        'solutions-hub-backend', 'partner:read partner:write', now(), now());

-- 只读（给 dashboard 前端 / 同步 agent，按需）
INSERT INTO rate_key (apiKey, level, qps, effectiveAt, expireAt, remark, scope, createdAt, updatedAt)
VALUES ('<另一个随机字符串>', 'enterprise', 100,
        '2026-01-01 00:00:00', '2027-12-31 23:59:59',
        'solutions-hub-readonly', 'partner:read', now(), now());
```

要点：

- `apiKey` 最长 64 字符，请用密码学随机串，不要用可猜测的值
- `scope` 用空格分隔；**留空 = 没有任何 partner 权限**
- `effectiveAt` / `expireAt` 会被校验，过期凭证返回 `401`
- 凭证由限流模块每 10 秒刷新进内存，**改完最多 10 秒生效，不需要重启服务**
- 轮换凭证：插入新行 → 通知调用方切换 → 删除旧行（两条并存期间都有效）
- 吊销凭证：`DELETE FROM rate_key WHERE apiKey = '<key>'`，最多 10 秒生效
- `remark` 是排查时唯一的调用方标识，且会被写入 `partner_audit.actor`，请填有意义的名字

## 5. 验证方法

**① 表已创建**

```sql
SHOW TABLES LIKE '%partner%';
-- 期望 6 张：partner / partner_contract / partner_audit
--            daily_partner_stat / daily_partner_addr / daily_partner_tvl

SHOW COLUMNS FROM rate_key LIKE 'scope';
-- 期望存在，类型 varchar(255)，默认 ''
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

**④ 鉴权生效**

无凭证应被拒绝：

```bash
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:9527/open/partner/chain-metrics/summary'
# 期望 401
```

只读凭证不能写：

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://127.0.0.1:9527/open/partner/contracts' \
  -H 'Authorization: Bearer <只读 key>' -H 'Content-Type: application/json' \
  -d '{"source_id":"probe","addresses":["0x0000000000000000000000000000000000000000"]}'
# 期望 403
```

参数错误应返回 400 而非 200：

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:9527/open/partner/chain-metrics?start_date=2026-08-01' \
  -H 'Authorization: Bearer <读 key>'
# 期望 400（只给了 start_date，缺 end_date → incomplete_date_range）
```

**⑤ API 可正常返回**

```bash
curl -s 'http://127.0.0.1:9527/open/partner/chain-metrics/summary?period=30d' \
  -H 'Authorization: Bearer <读 key>' | jq .
```

**⑥ 写操作被审计**

```sql
SELECT createdAt, action, sourceId, actor, ip, detail FROM partner_audit ORDER BY id DESC LIMIT 10;
```

---

## 6. 回滚方案

无数据风险，两步：

1. 回滚代码到 `b3dc1d8`，重启 `stat_task` 与 `open_api`
2.（可选）删除新表：

```sql
DROP TABLE IF EXISTS daily_partner_tvl, daily_partner_addr, daily_partner_stat,
                     partner_audit, partner_contract, partner;
DELETE FROM kv WHERE `key` = 'KEY_PARTNER_STAT_DAY';
DELETE FROM rate_key WHERE scope <> '';
-- rate_key.scope 列可以保留（旧代码忽略它），也可以一并删除：
-- ALTER TABLE rate_key DROP COLUMN scope;
```

`rate_key.scope` 是唯一一处对既有表的改动，旧版本代码不读这一列，**保留它不会造成任何影响**，回滚时可以不动。

---

## 7. ⚠️ 风险提示

### 7.1 端点暴露范围

所有 partner 端点均已要求 `Authorization: Bearer <key>` 并按 scope 区分读写，写操作全部记入 `partner_audit`。

仍建议**先只在内网或白名单暴露**，理由是纵深防御而非缺少鉴权：

- `POST /open/partner/contracts` 能改变 partner ↔ 合约归属，进而改变对外报出的所有数字
- 该模块尚未经过真实流量验证

凭证泄露的处置：从 `rate_key` 删除对应行即可，**最多 10 秒生效，无需重启服务**。

### 7.1.1 排查用错误码对照

| HTTP | code | 含义 |
|---|---|---|
| 401 | `invalid_auth` | 未带凭证 / 凭证不在 `rate_key` / 已过期或未生效 |
| 403 | `insufficient_scope` | 凭证有效但 `scope` 列缺少所需权限 |
| 400 | `incomplete_date_range` | 只提供了 `start_date` 或 `end_date` 之一 |
| 400 | `missing_source_id` | TVL 相关端点未提供 `source_id` |
| 400 | `invalid_period` | `period` 不在 `7d/30d/90d/all` 内 |
| 400 | `unknown_address:0x..` | 该地址索引器从未见过 |
| 400 | `address_owned_by_other_partner:0x..` | 合约归属冲突 |
| 429 | — | 触发全局限流（既有中间件，响应体为 `{code:429,...}`） |

调用方报 401/403 时，先查 `SELECT apiKey, remark, scope, effectiveAt, expireAt FROM rate_key;` 核对 scope 与有效期。

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
| 合约下线接口（设置 `effectiveTo`） | 当前只能新增映射，下线需直接改库。后续迭代 |
| 注册后自动触发历史回填 | 当前需 ops 手工执行回填命令。后续迭代 |
| partner 级凭证 / 用户级授权 | 本模块只做服务级凭证鉴权。"哪个用户能看哪个 partner"由 Solutions Hub 后端负责，0gscan 不参与 |
| 密钥自助签发与管理后台 | 无。签发/轮换/吊销均为 ops 手工 SQL |
| 合约级下钻、Top10 gas 榜、sparkline | 后续迭代 |

---

## 附：代码质量说明

- 全项目 TypeScript 编译 **0 错误**
- 核心聚合 SQL 已在**生产库只读验证**通过（三方交叉比对完全一致，见第 5 节 ③）
- 写入侧（INSERT / 累计列 / 幂等性）**尚未在真实环境验证**，建议先在预发或小范围日期区间试跑
- 鉴权与审计**尚未在真实环境验证**，请按第 5 节 ④ 的两条 curl 确认 401 / 403 行为符合预期后再开放调用
