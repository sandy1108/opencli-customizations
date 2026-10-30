# 第三方声明

OpenCLI: https://github.com/jackwener/opencli ，本次参考版本1.8.6。

Copyright 2025 jackwener

Licensed under the Apache License, Version 2.0. 完整许可见`LICENSES/OpenCLI-Apache-2.0.txt`。

相关文件：`plugins/youtube-transcript/transcript.js`（用户维护的官方实现衍生版）、`utils.mjs`（官方utils.js的必要函数子集）、`transcript-group.mjs`（官方transcript-group.js，原注释提及Defuddle移植）。迁移改动已在文件头及sources.json注明；不改变原有第三方版权和许可。

Defuddle: https://github.com/kepano/defuddle ，MIT License，Copyright (c) 2025 Steph Ango (@kepano)。为保留字幕分组算法的来源链，附`LICENSES/Defuddle-MIT.txt`。未把Defuddle作为npm依赖，也未额外复制其源码。

其他旧Skill源码及新增代码的许可尚未统一选定。本文件不把整仓库声明为Apache-2.0。公开发布或选择统一许可需要用户另行确认。
