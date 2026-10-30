# youtube-transcript

```bash
opencli youtube transcript VIDEO_URL --lang zh-Hans,zh-CN,zh --mode grouped -f json
opencli youtube transcript VIDEO_URL --lang en --mode raw --source dom -f json
```

需要已连接Chrome。保留旧补丁的语言别名、避免误选自动翻译轨、播放器/页面数据/DOM转写面板兜底，以及低信任文档reload重试。`source`支持auto/api/dom，`mode`支持grouped/raw。上游字幕分组及3个必要utils函数随插件携带，不依赖旧clis/youtube目录。

历史低信任文档触发reload分支尚未完整真实验收。模块加载通过不能证明每段视频有字幕，也不能证明浏览器恢复分支已触发。没有字幕时报告失败，不虚构转写。

在仓库根执行`node scripts/manage.mjs check --plugin youtube-transcript`，预览用`install --plugin youtube-transcript`；实际写入加`--apply`须已有设备变更授权。`adapter reset youtube`不会卸载本插件，恢复见根docs/installation.md。源码基于OpenCLI，许可见根第三方声明。
