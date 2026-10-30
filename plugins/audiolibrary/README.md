# audiolibrary

公开HTML读取，不需要浏览器：

```bash
opencli audiolibrary categories --kind moods -f json
opencli audiolibrary search --mood calm --genre ambient --query rain --pages 2 --limit 10 -f json
opencli audiolibrary track https://www.audiolibrary.com.co/artist/track-slug -f json
```

搜索在有限分类页面内匹配，不是全站全文搜索；`track`示例URL是格式示例，应使用搜索返回的真实trackUrl。返回试听、原视频、作者链接及逐曲授权信息，不下载音乐、不绕过下载门槛，不凭未试听的数据判断音色相似。

在仓库根执行`node scripts/manage.mjs check --plugin audiolibrary`，预览用`install --plugin audiolibrary`；实际写入加`--apply`须已有设备变更授权。原来的Skill内安装器尚未切换，S2处理；不要两套安装器交叉覆盖。
