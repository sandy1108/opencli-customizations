# 检查、定向安装与恢复

## 开发仓库与正式安装分离

本文下方`node scripts/manage.mjs`命令用于开发仓库或经用户许可临时获取的源码检出，不要求正式机常驻仓库。正式机只保留插件安装快照和正式Skill；不得让任务依赖开发目录或持久`OPENCLI_CUSTOMIZATIONS_ROOT`。

### Skill独立入口

`runtime_client.py`是客户端唯一源码；同步完整副本为各消费者的`plugin_client.py`：BTC、Audio、AI简报和字幕均在各自Skill的`scripts/`。维护时同步四份并校验字节相同，不手工分叉；插件源码与安装事务仍只在中央维护。无需另装常驻管理服务。

- 默认`check`离线核对本机收据/哈希/manifest版本/宿主，`remoteChecked=false`；无需源码、网络、Git或Node命令执行。
- `matching`只表示本机自洽；不能证明远端最新、来源可信、命令来源或业务成功。最低版本不足为`version-too-old`，宿主变化为`host-relink`，未知修改/原生lock为`conflict`。
- 下载前Agent必须说明目标插件、用途、固定来源和安装位置，并等待用户明确同意。普通业务请求、阶段审批、缺插件本身均不等于许可。
- 用户同意后，`install --plugin ID --allow-download`才临时下载`https://github.com/sandy1108/opencli-customizations.git`的master，确认本次提交并报告。按子插件版本而非根版本判断，中央工具先预检再复制快照，不执行npm或生命周期脚本。
- 已有插件更新/重链接须另获同意，增加`--update`；`--repo`仅用于已明确授权的本地开发/隔离安装，不读取旧ROOT环境变量。没有下载许可时不能以“检查远端更新”为由clone。
- 成功、普通失败或超时后清理本次下载目录；不删除外置备份。强杀/断电不保证清理，残留需核实后处理。安装器回滚失败时，保留运行暂存/锁/备份证据；临时Git源码仍可清理。
- 安装后复查命令发现/定义，成功才重试原操作一次。文件完整但命令缺失时先查加载冲突；运行错误、无字幕、登录态问题不是自动重装理由。无人交互的定时任务不能自行确认，停止相应分支并按任务规则报告。

客户端不颁发业务认证，不代替Agent核实用户授权；显式下载参数是操作门槛，不能用参数本身声称已经获准。独立测试：`npm run test:runtime`，仅临时目录和下载响应桩，不访问远端。

## 安装前

先确认设备变更授权及目标集合。仓库默认检查四组，但安装必须逐个显式指定；不会因为Skill保存附件就自动补装。先运行只读检查和预览：

```bash
node scripts/manage.mjs check --plugin twitter-kol
node scripts/manage.mjs install --plugin twitter-kol
```

可选参数：

| 参数 | 默认值 | 含义 |
|---|---|---|
| `--plugin ID` | check为全部；install必须提供 | 可重复，未知/重复身份报错 |
| `--runtime DIR` | `~/.opencli` | 运行根目录，插件放在其plugins子目录 |
| `--host-package DIR` | 从PATH中的opencli真实文件定位包根 | 指向package.json所在目录，不执行CLI |
| `--backup-root DIR` | `~/.local/share/opencli-customizations/backups` | 必须独立于运行目录和仓库 |
| `--apply` | 无 | 仅install允许，显式写入 |
| `--list-json FILE` | 无 | 仅check，解析用户提供的list快照，不执行CLI |

所有写入路径禁止软链接祖先；macOS的`/var`一般是软链接，测试请使用`realpath`得到的临时目录。宿主包路径允许正常解析工具链软链接。

## 状态解释

- `missing`：目标plugin目录缺失，不代表旧clis没有扩展。
- `matching`：文件哈希与本仓库一致，依赖链接匹配所选宿主。不是业务验收结论。
- `update-available`：旧目录仍与它自己的安装收据一致，但与新源码不同，可以经授权升级。
- `host-relink`：已知安装需要切换宿主链接/版本，亦需预览及授权执行。
- `conflict`：未知/编辑内容、原生lock同名、原生软链接安装、额外文件/目录、未知依赖或坏收据，拒绝覆盖。

`legacyOverrides`只读列出旧`clis/<site>/<command>.js`的已知来源/不同/缺失，**不会删除或替换旧覆盖**。Audio的共享core文件完整性属于来源/迁移盘点；此列表按命令列举，不代表检查旧站点的全部依赖。

## 执行与备份

获准后给预览命令增加`--apply`。工具只复制所选插件，无第三方依赖安装或生命周期脚本。

1. 完整预检源码、版本范围、目标状态、原生lock及备份位置；安装锁使用排他创建。
2. 在`<runtime>/.customizations-staging/<事务ID>/`暂存，位于plugins平铺扫描范围外；每个插件只链接所选宿主。
3. 写入外置`<backup-root>/<事务ID>/transaction.json`；旧插件整目录复制、哈希核对。首次安装没有旧内容，仍留事务清单。
4. 对每个目标重命名旧目录并发布新目录；多目标批次任一异常则恢复已变更目标。
5. 安装后重新检查全部目标；成功写`completed.json`。备份不会自动删除。

收据为插件目录内`.customization-state.json`，记录版本、文件哈希、宿主和事务ID。未知修改应先比较、保存并通过源码管理，不手工伪造收据，不自动stash/reset。

安装锁只能协调本工具进程，不能阻止OpenCLI原生更新或其他程序写目录；实际变更窗口应停止并发维护。本工具提供同步错误的失败恢复；断电、kill或磁盘故障不保证自动恢复。发现残留锁时停止，检查事务、暂存、正式目录与备份，由下一份经批准恢复方案处理。

## 故障及回退

普通安装错误会撤回本次发布并恢复旧目录，外置备份保留。若恢复本身失败，错误明确包含“回滚失败”及路径，锁和暂存不会清理。不要重试覆盖或自动删锁。

成功部署后的主动降级、卸载或恢复不是本阶段自动操作。先确定事务及受影响插件，比较备份哈希/收据、当前文件及宿主，提交精确恢复方案，再按授权恢复；首次安装的回退是移走新增插件，旧安装可由对应事务快照恢复。备份中宿主链接可能指向旧NVM目录，必须同时核实宿主版本。

`opencli adapter reset youtube`只处理clis，不会卸载本仓库的字幕plugin。目录改名放在plugins里面也可能继续被扫描；隔离/停用时必须在获批后移出plugins，而不是仅改名。

## 与原生管理的关系

1.8.6及2.0.2源码支持的原生命令：

```bash
# 发布且获准后可用；GitHub第三段为子插件键，不是目录路径
opencli plugin install github:sandy1108/opencli-customizations/audiolibrary
# 本地路径按单插件处理，不能把整个monorepo当作本地单插件安装
opencli plugin install file:///absolute/path/opencli-customizations/plugins/audiolibrary
```

这是机制说明，本阶段未执行上述命令，也未验证真实安装命令的端到端行为。原生远端安装从Git取代码，本地安装会软链接源码且创建源码node_modules；原生安装不具备本工具的预览/外置备份/未知内容保护。推荐设备迁移使用本仓库安全工具。

两套管理方式选一套。本工具不会写`plugins.lock.json`，同名原生lock即使目标缺失也拒绝接管。对本工具安装的插件，不使用原生`plugin update/uninstall`或无差别`update --all`；这些操作可能绕过备份或失败。切换管理方式需单独审批，不能靠uninstall后重装来跳过保护。

## 发现快照

需要检验CLI发现时，由已获授权的部署步骤运行`opencli list ... -f json`并提供快照。工具本身不执行它，因为宿主main可能初始化/更新运行文件。2.0分页必须逐页取回；`--list-json`检查一页时如有`nextOffset`，标记不完整并返回2。完整结果中的命令缺失也返回2。

list只能证明名字可见，不能证明加载自哪个文件；同名覆盖必须通过隔离模块测试及真实部署验收共同确认。1.x校验入口是`validate`，2.x是`adapter check`，不要照搬旧Skill命令。
