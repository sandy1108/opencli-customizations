# 兼容性与升级验收

## 2026-10-30模块测试

| 宿主 | 六命令发现/注册 | 插件覆盖用户命令 | registry/errors与相对依赖 | PUBLIC响应桩及字幕辅助函数 | 真实业务/完整CLI启动 |
|---|---|---|---|---|---|
| 1.8.4 | 通过 | 通过 | 通过 | 通过 | 未执行 |
| 1.8.6 | 通过 | 通过 | 通过 | 通过 | 未执行 |
| 2.0.2 | 通过 | 通过 | 通过 | 通过 | 未执行 |

测试使用公开npm包的`dist`模块和真实plugin discovery；宿主导出层用哨兵隔离，插件层调用真实注册函数。依赖目录为测试进程只读复用，因此不是每个宿主版本的独立依赖安装，也不代表真实站点或特定操作系统验收。

manifest声明`>=1.8.4 <2.1.0`为当前预期接口范围，工具拒绝范围外、未知及预发布版本；范围内未列版本仍未实测。`moduleTested`只表示本矩阵已有模块证据；`businessVerified`固定为false，本工具不颁发正式业务认证。

## 2.0破坏性变更

| 变化 | 消费者处理 |
|---|---|
| 普通JSON成功`{ok:true,data:...}`，失败`{ok:false,error:...}`且非零退出 | 检查退出码、解包，再处理业务数据，不能把错误当空数组 |
| list改`data.commands/total/nextOffset`；默认25，上限100 | 处理新字段及分页；内置命令也可能为单段或三段以上 |
| browser session从位置参数变为`--session` | 修改调用方与Skill说明 |
| validate/verify/init等收敛 | 采用`adapter init/test/check`，按目标版本核对help |
| Electron/external Hub移除 | 本仓库六命令不依赖它们，外部Skill仍需单独核查 |

`scripts/contracts.mjs`提供旧/新JSON与list纯解析器。Skill消费者和机器安装状态独立维护；本仓库的兼容声明不自动代表任一消费者工作流已完成适配。

## 已知升级风险

2.0.2的`fetch-adapters.js`在特定官方站点更新条件下可能清理`~/.opencli/clis/<site>`用户覆盖。这是安装脚本行为，实际受目标版本及站点哈希影响。本仓库使用`plugins`目录，避开已知的`clis`清理路径；不保证后续宿主版本永远保持此行为。

宿主升级可能改变registry/errors、浏览器Page API、依赖链接、站点鉴权、输出结构。1.8.x需要安装工具重链接到新宿主；2.0.2发现代码也会重绑定插件依赖。本仓库不复制旧宿主。

## YouTube DOM与播放器字幕网络回退

YouTube转写文稿面板可能因页面或会话状态返回`FAILED_PRECONDITION`，而播放器字幕轨仍可用。该站点响应本身不能单独证明OpenCLI接口发生breaking change；插件的网络兜底用于处理面板没有渲染字幕段、播放器仍有当前语言字幕轨的情况。

`youtube-transcript` 0.1.3中，默认`auto`先尝试能报告语言的播放器/页面路径，拿不到可用段落时再走DOM面板；`api`只走播放器/页面路径。`--source=dom`直接以转写面板优先，面板无段落时再请求当前视频播放器的timedtext轨并从网络捕获结果兜底。网络过滤器要求视频ID精确匹配、字幕语言符合偏好、排除带`tlang`的自动翻译轨；输出中的`source=dom`或`source=network`表示实际返回路径。

YouTube转写面板不提供可依赖的语言元数据。DOM读到非空段落时，即使调用者显式传入`--lang`，插件仍保留这些段落，避免仅因语言不可验证而返回空结果；stderr同时输出`source=dom language=unverified`，并在有请求语言时标注`requested=<lang>`。这属于best-effort：结果可能是面板当前显示的其他语言，不能把它报告为已匹配`--lang`。若没有非空DOM结果，仍按原逻辑尝试网络回退；捕获不可用或没有匹配网络字幕时保留原面板错误，不把其他视频/语言的数据当作结果。

这一行为修正针对DOM面板为空的路径；播放器低信任空响应后的reload条件、超时边界、无字幕结果和其他站点业务需分别按下方测试范围核验，不由该修复自动证明。

### OpenCLI 2.0.2窗口模式说明

OpenCLI 2.0.2的adapter默认窗口模式为`background`，除非命令覆盖；当前字幕命令没有声明`defaultWindowMode`。DOM读取依赖YouTube描述区和转写面板渲染，后台页面的计时器或懒加载可能延迟这段流程。在2.0.2上使用DOM路径时，可显式传`--window foreground`。插件不强制改变宿主窗口默认模式，以免未告知调用方就前置浏览器窗口。

模块回归覆盖播放器网络兜底的选择和过滤逻辑，并验证`auto`在显式语言请求下仍保留非空但语言未验证的DOM结果且输出提示。模块测试不等于任意视频的站点级保证；字幕面板、播放器轨道及浏览器窗口状态仍会影响真实结果。

## 复现命令

```bash
npm test
node scripts/host-smoke.mjs /path/to/version-package /path/to/existing/node_modules
# 多版本npm测试：值为待测包目录的JSON数组，不触发下载
OPENCLI_TEST_HOSTS='["/path/to/1.8.4/package","/path/to/1.8.6/package","/path/to/2.0.2/package"]' npm test
```

真实站点回归必须单独记录宿主版本、输入语言、实际来源和段数；不要把宿主安装目录、机器名、备份路径、浏览器资料或凭据放入此仓库。设备安装快照属于外部运维记录。
