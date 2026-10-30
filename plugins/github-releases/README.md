# github-releases

只读命令：`opencli github releases OWNER/REPO --limit 3 -f json`，limit为1–100，默认10。

直接读取公开GitHub API，返回tag、标题、日期、链接、发布说明；不需要浏览器。仓库不存在、限流、无release分别抛出宿主错误，不自动登录或重试。本次补充拒绝单独点号路径段，避免参数归一化。

在仓库根执行`node scripts/manage.mjs check --plugin github-releases`，预览用`install --plugin github-releases`；只有已有设备变更授权才增加`--apply`。本阶段没有为当前Mac补装该命令。
