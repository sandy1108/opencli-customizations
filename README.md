# OpenCLI 自定义扩展

把分散在 Skill 附件里的 OpenCLI 扩展集中管理，运行目录可以从本仓库重建。当前版本 `0.1.0`，第一阶段代码已完成；发布记录见Git历史。尚未安装到正式环境或升级宿主。

| 插件 | 命令 | 用途 | 浏览器 |
|---|---|---|---|
| [twitter-kol](plugins/twitter-kol/README.md) | `twitter kol-tweets` | KOL 最近推文，只读 | X 登录态 |
| [github-releases](plugins/github-releases/README.md) | `github releases` | Releases 及发布说明 | 不需要 |
| [audiolibrary](plugins/audiolibrary/README.md) | `audiolibrary search/categories/track` | BGM 分类、搜索、详情 | 不需要 |
| [youtube-transcript](plugins/youtube-transcript/README.md) | `youtube transcript` | 字幕、语言优先级及兜底 | Chrome/YouTube |

它们是 OpenCLI 原生插件，多插件清单在 [opencli-plugin.json](opencli-plugin.json)。不维护 OpenCLI fork，不捆绑旧宿主，不包含 Skill 的任务调度或 BTC 点赞工作流。

## 插件怎样被识别

安装命令可以由人或Agent执行；真正加载插件的是OpenCLI。仓库放在开发目录不会自动生效，需要先安装到OpenCLI的plugins发现目录。

以Audio为例，相关文件分工如下：

| 文件 | 作用 |
|---|---|
| 根`opencli-plugin.json` | 多插件清单：列出插件身份、目录、版本和宿主范围 |
| `plugins/audiolibrary/opencli-plugin.json` | 单插件元数据，供原生插件管理识别 |
| `plugins/audiolibrary/package.json` | 声明ESM、Node范围及包身份 |
| `plugins/audiolibrary/categories.js`等 | 调用宿主导出的`cli({ site, name, args, func, ... })`注册命令，这是代码接口 |

安装后的链路是：`仓库插件目录 → ~/.opencli/plugins/<插件名>/ → OpenCLI扫描并导入命令JS → cli()注册 → opencli <site> <command>`。无需常驻一个负责解释JS的Agent，也不要求编译成二进制或压缩成插件包。安装器会处理宿主包依赖链接；只复制单个JS并不构成完整安装。

OpenCLI自带`plugin install`，支持GitHub子插件和本地单插件目录。本项目优先使用下方的安全安装工具，以获得预览、冲突保护和外置备份；它仍使用OpenCLI原生加载机制。两种安装方式的命令及边界见[安装说明](docs/installation.md#与原生管理的关系)，不要交叉管理同一插件。

## 从这里开始

需要 Node.js 20+，已有 OpenCLI。当前开发环境 Node 24；不需要 `npm install`，运行时依赖通过软链接引用当前宿主的 registry/errors。

```bash
# 默认只读检查所有插件及旧clis覆盖，不执行opencli、不访问网站
node scripts/manage.mjs

# 只检查目标插件
node scripts/manage.mjs check --plugin audiolibrary

# 预览，不写入；实际安装应先获得设备变更授权
node scripts/manage.mjs install --plugin audiolibrary

# 授权后才执行；重复--plugin可以指定多组，不隐式全量安装
node scripts/manage.mjs install --plugin audiolibrary --apply
```

`check`/预览退出码：`0`全部匹配，`2`有缺失、待更新、冲突或兼容性待处理，`1`参数/格式/操作异常。成功的 `--apply` 返回 `0`，JSON 中 `pluginsAfter`为安装后状态，`plugins`保留安装前预检；无需变更时返回`changed: []`。安装失败返回`1`。

源码、版本范围、文件匹配、list 中存在命令、真实业务可用是不同证据。工具不会因为“文件存在”就宣称浏览器工作流通过。[安装与恢复说明](docs/installation.md)列出路径、备份、冲突及原生安装差异。

## 验证与维护

```bash
npm test
# 对当前宿主做模块级隔离测试，不运行CLI main/daemon
npm run test:host
# 对已经取得的其他版本包测试；不会下载、安装或升级
node scripts/host-smoke.mjs /path/to/opencli-package /path/to/existing/node_modules
```

- [兼容性矩阵](docs/compatibility.md)：1.8.4、1.8.6、2.0.2真实模块隔离验证；正式站点未验收。
- [来源与许可](docs/sources.md)、[sources.json](sources.json)：来源提交、迁移前后SHA-256及改动。
- [第一阶段报告](docs/S1-report.md)：实际交付、测试及限制。
- [Agent规则](AGENTS.md)、[S1技术计划](docs/plans/S1.md)：后续Agent入口。

本仓库未选择统一开源许可，`private: true`防止误发npm。自有及来源未声明许可的内容暂不额外授权；第三方部分遵循各自许可，见[第三方声明](THIRD_PARTY_NOTICES.md)。公开发布前另行确认。
