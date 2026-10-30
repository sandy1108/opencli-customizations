import { cli, Strategy } from '@jackwener/opencli/registry';
import { searchTracks, TRACK_COLUMNS } from './core.mjs';

cli({
  site: 'audiolibrary', name: 'search', access: 'read',
  description: '按情绪/风格读取有限分类页，在曲名、作者和标签中匹配关键词（非全站全文搜索）',
  domain: 'www.audiolibrary.com.co', strategy: Strategy.PUBLIC, browser: false,
  args: [
    { name: 'query', type: 'string', default: '', help: '本地匹配的英文关键词或曲名，可省略' },
    { name: 'mood', type: 'string', default: '', help: '情绪 slug，例如 calm、happy' },
    { name: 'genre', type: 'string', default: '', help: '风格 slug，例如 ambient、hip-hop-rap' },
    { name: 'page', type: 'int', default: 1, help: '起始页，1–1000' },
    { name: 'pages', type: 'int', default: 2, help: '最多读取页数，1–3；串行且间隔 750ms' },
    { name: 'limit', type: 'int', default: 10, help: '最多返回 1–30 首，达到数量提前结束' },
  ],
  columns: ['rank', ...TRACK_COLUMNS, 'sourcePage', 'scannedPages'],
  func: async (args) => searchTracks(args),
});
