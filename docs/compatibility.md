# 兼容性与升级验收

## 2026-10-30模块测试

| 宿主 | 六命令发现/注册 | 插件覆盖用户命令 | registry/errors与相对依赖 | PUBLIC响应桩及字幕辅助函数 | 真实业务/完整CLI启动 |
|---|---|---|---|---|---|
| 1.8.4 | 通过 | 通过 | 通过 | 通过 | 未执行 |
| 1.8.6 | 通过 | 通过 | 通过 | 通过 | 未执行 |
| 2.0.2 | 通过 | 通过 | 通过 | 通过 | 未执行 |

测试在当前Mac的Node 24.18.0进行。待测宿主使用公开npm包的dist模块，依赖只读复用当前1.8.6安装中的node_modules；不是每个版本的完整独立依赖安装，也不是老Mac系统验收。官方层用哨兵模拟，用户层与插件层调用真实discovery。没有启动main/daemon，没有访问X/YouTube/GitHub/Audio真实站点。

manifest声明`>=1.8.4 <2.1.0`为当前预期接口范围，工具拒绝范围外、未知及预发布版本；范围内未列版本仍未实测。`moduleTested`只表示本矩阵已有模块证据；`businessVerified`固定为false，本工具不颁发正式业务认证。

## 2.0破坏性变更

| 变化 | 消费者处理 |
|---|---|
| 普通JSON成功`{ok:true,data:...}`，失败`{ok:false,error:...}`且非零退出 | 检查退出码、解包，再处理业务数据，不能把错误当空数组 |
| list改`data.commands/total/nextOffset`；默认25，上限100 | 处理新字段及分页；内置命令也可能为单段或三段以上 |
| browser session从位置参数变为`--session` | 修改调用方与Skill说明 |
| validate/verify/init等收敛 | 采用`adapter init/test/check`，按目标版本核对help |
| Electron/external Hub移除 | 本仓库六命令不依赖它们，外部Skill仍需单独核查 |

`scripts/contracts.mjs`有旧/新JSON与list纯解析器；不在此阶段改写任何Skill消费者。旧BTC/Audio检查器及下载版OpenCLI Skill仍有旧约定，由S2处理。

## 已知升级风险

2.0.2的`fetch-adapters.js`会按官方站点哈希变化整目录清理`~/.opencli/clis/<site>`。前期两机分析命中twitter、youtube、_shared；这是源码预测，不是本次执行升级的结果。本仓库放在plugins范围，可避开该版本的清理路径，不保证将来宿主永远不改。

宿主升级可能改变registry/errors、浏览器Page API、依赖链接、站点鉴权、输出结构。1.8.x需要安装工具重链接到新宿主；2.0.2发现代码也会重绑定插件依赖。本仓库不复制旧宿主。

## S3/S4正式验收门槛（尚未执行）

1. 固定版本、设备和目标插件集合；备份运行覆盖、配置及相关恢复依赖，记录哈希。
2. 旧宿主上安装选定plugin，确认同名覆盖、注册、宿主链接与旧Skill可用。
3. 固定版升级后重复检查；PUBLIC分类/搜索/详情、GitHub releases有限真实读取。
4. BTC有限只读推文抓取；不触发点赞或定时工作流。已有官方twitter like是消费者依赖，不算本仓库额外命令。
5. 字幕覆盖中文/英文/无字幕/DOM路径、reload及错误路径。历史低信任文档触发的reload分支尚未完整真实验收，本次迁移不消除这个限制。
6. 用匹配版本Skill核对输出和检查器，成功后再按授权发布；老Mac独立验证，不沿用当前Mac结论。

失败时停止下一阶段，保留外置备份和差异；按已获批恢复方案处理，不自动删除旧附件。

## 重现命令

```bash
npm test
node scripts/host-smoke.mjs /path/to/version-package /path/to/existing/node_modules
# 多版本npm测试：值为待测包目录的JSON数组，不触发下载
OPENCLI_TEST_HOSTS='["/path/to/1.8.4/package","/path/to/1.8.6/package","/path/to/2.0.2/package"]' npm test
```
