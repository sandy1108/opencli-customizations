# youtube-transcript

```bash
opencli youtube transcript VIDEO_URL --lang zh-Hans,zh-CN,zh --mode grouped -f json
opencli youtube transcript VIDEO_URL --lang en --mode raw --source dom --window foreground -f json
```

需要已连接Chrome。支持语言别名、避免误选自动翻译轨；`auto`/`api`使用播放器与页面数据，`dom`先读转写文稿面板，面板无段落时触发当前视频和目标语言的播放器字幕请求并从网络响应兜底。输出会标记实际来源。`mode`支持grouped/raw。上游字幕分组及3个必要utils函数随插件携带，不依赖旧clis/youtube目录。

OpenCLI 2.0.2默认以后台窗口运行adapter。YouTube转写面板依赖页面渲染，使用`--source=dom`时建议加`--window foreground`；插件目前不强制切换窗口模式。验证边界见根目录[兼容性说明](../../docs/compatibility.md)。

低信任文档触发reload分支仍需按具体场景验证。模块加载通过不能证明每段视频有字幕，也不能证明浏览器恢复分支已触发。没有字幕时报告失败，不虚构转写。

在仓库根执行`node scripts/manage.mjs check --plugin youtube-transcript`，预览用`install --plugin youtube-transcript`；实际写入加`--apply`须已有设备变更授权。`adapter reset youtube`不会卸载本插件，恢复见根docs/installation.md。源码基于OpenCLI，许可见根第三方声明。
