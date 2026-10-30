import { cli, Strategy } from '@jackwener/opencli/registry';
import { getTrack, TRACK_COLUMNS } from './core.mjs';

cli({
  site: 'audiolibrary', name: 'track', access: 'read', description: '读取单曲详情、试听链接、作者下载入口及许可原文',
  domain: 'www.audiolibrary.com.co', strategy: Strategy.PUBLIC, browser: false,
  args: [{ name: 'url', type: 'string', positional: true, required: true, help: '本站曲目 URL 或 artist/song 路径' }],
  columns: TRACK_COLUMNS, func: async (args) => getTrack(args),
});
