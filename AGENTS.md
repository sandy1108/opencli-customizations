# Agent 工作入口

先读README、docs/compatibility.md、docs/installation.md、sources.json；明确操作的设备、宿主版本、目标插件和审批范围。OpenCLI与OpenClaw是不同项目，本仓库只管理OpenCLI。

## 仓库职责

- `plugins/<id>/`：平铺ESM命令JS；非命令辅助模块使用`.mjs`，避免被宿主当命令扫描。
- `opencli-plugin.json`：原生monorepo清单；每组有自己的manifest与package.json。
- `sources.json`：来源提交、原始/当前哈希及迁移差异。代码改动后审查再更新当前哈希；不能为绕过冲突随意改收据。
- `scripts/manage.mjs`：默认只读，显式定向安装，复制快照、外置备份、失败恢复。不操作npm，不升级宿主，不改原生lock。
- `scripts/runtime_client.py`：随Skill分发的独立客户端唯一源码；检查不需要仓库，下载前先征得用户同意，获准后临时获取源码并清理。修改后同步BTC/Audio/AI简报/字幕四份plugin_client.py并核对哈希；运行`npm run test:runtime`。正式机不保留开发检出或ROOT依赖。
- `scripts/contracts.mjs`：1.x/2.x JSON及list解析；调用方负责分页。
- `scripts/host-smoke.mjs`、`tests/host-worker.mjs`：临时目录中的真实模块测试，禁止改正式HOME；不启动main/daemon、不访问网站。

## 当前阶段与边界

本仓库维护插件源码、测试、安装工具和通用兼容文档。运行时部署、宿主升级及Skill发布属于独立操作，执行前必须核实目标环境并取得对应授权；安装状态不作为仓库默认事实，也不写入公开文档。

知识库项目笔记负责需求与阶段审批，运维台账负责设备部署快照；本仓库只保留非敏感实现及测试说明。不把某台机器历史安装集合当作所有机器的默认安装集合。

## 开发及验证

1. 开始前检查`git status --short`与分支，保留无关改动。新仓库默认`master`。
2. 开发工作遵循`adaptive-superpowers`与`karpathy-guidelines`；阶段批准只覆盖已明确的范围，不能自动扩展到其他阶段。
3. 改动尽量小；核心方法与坑点使用中文注释。修改实现时核对来源、命令契约、manifest和sources.json。
4. 运行`npm test`。涉及宿主适配时，对固定候选包运行模块烟测；不得悄悄安装候选版本。详细命令见兼容文档。
5. 检查未知文件/软链接保护、默认只读、备份校验及失败回滚。不得提供跳过保护的force选项。
6. 最终审查diff、敏感信息、来源/许可、验证与未验证范围。只在获得提交推送授权后，按明确路径暂存，中文type前缀commit；核对实际push URL/分支后再发布。

不要执行登录、点赞、发帖、真实业务任务来替代隔离测试；需要真实验收时先进入对应已获批部署方案。不要删除旧Skill附件、clis覆盖、外置备份或锁。不要把Token、Cookie、浏览器profile、抓包或机器私有配置写入本仓库。
