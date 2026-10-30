# twitter-kol

只读命令：`opencli twitter kol-tweets USERNAME --limit 20 -f json`，limit为1–100。

需要已登录X的浏览器连接。使用独立临时session，返回推文、时间、互动计数、媒体链接等；不点赞、不发帖、不内置KOL名单或调度。`btc-kol-tracker`的后续点赞流程属于Skill消费者，S2/S3另行处理。

定向检查/预览：`node scripts/manage.mjs check --plugin twitter-kol`，`node scripts/manage.mjs install --plugin twitter-kol`。在仓库根运行；增加`--apply`须已有设备变更授权。来源、依赖与限制见根README及docs。
