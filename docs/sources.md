# 来源、差异与许可

权威机器可读清单是根目录`sources.json`，保存每个文件原始及当前SHA-256，维护修改时应保留原始身份。这里不复制哈希形成第二份手工清单。

| 插件 | 初始来源 | 来源提交 |
|---|---|---|
| twitter-kol | user-skills/btc-kol-tracker/assets/opencli-patch/twitter/kol-tweets.js | `9fef4f065db4bf6431c0a36caf12170ff2a0f8c8` |
| github-releases | user-skills/ai-tech-brief/assets/opencli/clis/github/releases.js | 同上 |
| audiolibrary | user-skills/audio-library-search/assets/opencli/audiolibrary/的3命令及core.mjs | 同上 |
| youtube-transcript | private-skills/web-clipping/patches/youtube-adapter/transcript.js | `b8c61a405300f5abf143fdc84cee4f559ebc6556` |
| 字幕辅助 | jackwener/opencli 1.8.6的clis/youtube/utils.js、transcript-group.js | npm 1.8.6包 |
| Audio测试 | user-skills/audio-library-search/tests/adapter.test.mjs | user-skills同上提交 |

迁移结果：4组、6命令，7个自定义源文件加2个必要官方辅助模块。旧备份和官方依赖不额外计为补丁。

业务差异只有GitHub参数校验：旧正则允许单独`.`或`..`路径段，fetch时会归一化；已加前置拒绝，回归测试验证请求为零。字幕保留原业务逻辑，只更改helper import为`.mjs`、补来源及更正plugin恢复说明；utils仅截取字幕使用的3个函数，group算法保留。其余初始代码字节保持一致。

Audio原测试迁入`tests/audio.test.mjs`，仅调整仓库路径及宿主定位，测试使用手写HTML，不保存真实网页或下载参数。其他工具和测试为本仓库新增。

## 许可边界

来源两个Skill仓库根目录未发现统一LICENSE，不能据此替用户选择MIT或Apache等整仓库许可。本仓库自有及许可未声明的部分暂为UNLICENSED，不额外授予公开使用权；这是发布前待决事项，不妨碍用户已授权的本地集中管理。

字幕实现注明基于OpenCLI 1.8.6；相应第三方部分及辅助模块遵循上游Apache-2.0，完整文本在`LICENSES/OpenCLI-Apache-2.0.txt`，保留上游版权与现有来源注释。transcript-group原注释提及由Defuddle移植与简化，保留该来源，不声称本仓库原创。详见`THIRD_PARTY_NOTICES.md`。

2026-10-30读取Defuddle官方仓库LICENSE核实为MIT，附完整许可`LICENSES/Defuddle-MIT.txt`以保留分组算法来源链；未新增其运行依赖。

BTC源码内的X公共Web应用Bearer常量属于原有站点协议实现，非用户个人登录凭据；用户Cookie/CSRF仅从当前浏览器运行时获取，不持久化、不放入仓库。不要把实际抓取数据、网络日志或个人配置当作源码补入。
