// 纯解析：调用方负责运行CLI及分页，避免检查工具意外触发宿主初始化。
export function unwrapResult(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'ok' in value) {
    if (value.ok !== true) throw new Error(`OpenCLI失败：${JSON.stringify(value.error)}`);
    return value.data;
  }
  return value;
}

export function parseCommandPage(value) {
  const data = unwrapResult(value);
  const rows = Array.isArray(data) ? data : data?.commands;
  if (!Array.isArray(rows)) throw new Error('无法识别OpenCLI list输出');
  const commands = rows.map(row => {
    if (typeof row.site === 'string' && typeof row.name === 'string') return `${row.site}/${row.name}`;
    // list还包含单段内置命令及三段以上子命令，不能假定只有site/name。
    if (typeof row.command === 'string' && row.command.trim()) return row.command.trim().replace(/\s+/g, '/');
    throw new Error('无法识别命令字段');
  });
  const nextOffset = Array.isArray(data) ? undefined : data.nextOffset;
  if (nextOffset !== undefined && (!Number.isInteger(nextOffset) || nextOffset < 0)) throw new Error('无效nextOffset');
  return { commands, complete: nextOffset === undefined, nextOffset };
}

export function hostCompatibility(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  const supported = Boolean(match && ((+match[1] === 1 && (+match[2] > 8 || (+match[2] === 8 && +match[3] >= 4))) || (+match[1] === 2 && +match[2] === 0)));
  return { supported, moduleTested: ['1.8.4', '1.8.6', '2.0.2'].includes(version), businessVerified: false };
}
