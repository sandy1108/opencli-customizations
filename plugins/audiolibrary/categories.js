import { cli, Strategy } from '@jackwener/opencli/registry';
import { getCategories } from './core.mjs';

cli({
  site: 'audiolibrary', name: 'categories', access: 'read', description: '读取 Audio Library 当前情绪或风格分类',
  domain: 'www.audiolibrary.com.co', strategy: Strategy.PUBLIC, browser: false,
  args: [{ name: 'kind', type: 'string', default: 'moods', choices: ['moods', 'genres'], help: '分类类型' }],
  columns: ['kind', 'slug', 'name', 'url'], func: async (args) => getCategories(args),
});
