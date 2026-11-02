// Course and backup validation is deliberately independent of storage and the UI.
export const LIMITS = Object.freeze({ fileBytes: 5 * 1024 * 1024, backupBytes: 50 * 1024 * 1024, modules: 100, itemsPerModule: 1000, itemsPerPack: 10000, packs: 100, progress: 100000, weakWords: 10000 });
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SCENES = new Set(['exhibition', 'negotiation', 'complaint']);
const STATUSES = new Set(['new', 'mastered', 'review']);
const SETTINGS = new Set(['rate', 'voiceURI', 'theme', 'preferredPack']);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (path, message) => { throw new Error(`${path}：${message}`); };

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(path, '必须是普通对象');
  return value;
}

function keys(value, allowed, path) {
  object(value, path);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, '不支持此字段');
}

function safeTree(value, path = '数据', depth = 0, seen = new Set()) {
  if (depth > 20) fail(path, '嵌套层级超过20层');
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) fail(path, '不能包含循环引用');
  seen.add(value);
  if (Object.getOwnPropertySymbols(value).length) fail(path, '不能包含Symbol字段');
  if (!Array.isArray(value)) object(value, path);
  else {
    if (value.length > LIMITS.progress) fail(path, `数组不能超过${LIMITS.progress}项`);
    const indices = Object.keys(value);
    if (indices.length !== value.length || indices.some((key, index) => key !== String(index))) fail(path, '数组不能包含空位或额外字段');
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail(`${path}.${key}`, '禁止使用原型相关字段');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor.get || descriptor.set) fail(`${path}.${key}`, '不能包含访问器字段');
    safeTree(descriptor.value, `${path}.${key}`, depth + 1, seen);
  }
  seen.delete(value);
}

function text(value, path, max, { empty = false, multiline = true } = {}) {
  if (typeof value !== 'string') fail(path, '必须是字符串');
  const result = value.trim();
  if (!empty && !result) fail(path, '不能为空');
  if (value.length > max) fail(path, `最多${max}个字符`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(result) || (!multiline && /[\r\n\t]/.test(result))) fail(path, '包含不支持的控制字符');
  return result;
}

function id(value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || FORBIDDEN_KEYS.has(value)) fail(path, 'ID须为1—128位安全字符，以字母或数字开头，可包含字母、数字、点、下划线、冒号和连字符');
  return value;
}

function array(value, path, max, min = 0) {
  if (!Array.isArray(value)) fail(path, '必须是数组');
  if (value.length < min || value.length > max) fail(path, `数量须为${min}—${max}`);
  return value;
}

function integer(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(path, `必须是${min}—${max}之间的整数`);
  return value;
}

function timestamp(value, path) {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) fail(path, '必须是有效UTC ISO时间，如2026-11-02T08:30:00.000Z');
  const canonical = new Date(value).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) fail(path, '日期或时间不存在');
  return canonical;
}

function stableHash(value) {
  // Two independent 32-bit accumulators; used for stable identifiers, not security.
  let first = 2166136261;
  let second = 3335557771;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ code, 2246822519);
  }
  return (first >>> 0).toString(16).padStart(8, '0') + (second >>> 0).toString(16).padStart(8, '0');
}

function allocateId(prefix, content, reserved, allocated) {
  const base = `${prefix}-${stableHash(content)}`;
  let result = base;
  let occurrence = 1;
  while (reserved.has(result) || allocated.has(result)) result = `${base}-${++occurrence}`;
  allocated.add(result);
  return result;
}

export function validatePack(raw) {
  safeTree(raw, '课程');
  keys(raw, ['id', 'pack_name', 'version', 'modules'], '课程');
  const name = text(raw.pack_name, '课程.pack_name', 120, { multiline: false });
  const version = text(raw.version, '课程.version', 40, { multiline: false });
  const rawModules = array(raw.modules, '课程.modules', LIMITS.modules, 1);
  const reservedModules = new Set();
  const reservedItems = new Set();
  let totalItems = 0;
  rawModules.forEach((entry, mi) => {
    const path = `课程.modules[${mi}]`;
    keys(entry, ['id', 'module', 'scene', 'items'], path);
    if (own(entry, 'id')) {
      const value = id(entry.id, `${path}.id`);
      if (reservedModules.has(value)) fail(`${path}.id`, '模块ID重复');
      reservedModules.add(value);
    }
    const items = array(entry.items, `${path}.items`, LIMITS.itemsPerModule, 1);
    totalItems += items.length;
    if (totalItems > LIMITS.itemsPerPack) fail('课程.modules', `全包最多${LIMITS.itemsPerPack}条学习内容`);
    items.forEach((item, ii) => {
      const itemPath = `${path}.items[${ii}]`;
      keys(item, ['id', 'en', 'zh', 'phonetic', 'example', 'example_zh', 'role', 'keywords', 'reference'], itemPath);
      if (own(item, 'id')) {
        const value = id(item.id, `${itemPath}.id`);
        if (reservedItems.has(value)) fail(`${itemPath}.id`, '同一课程包内的学习项ID重复');
        reservedItems.add(value);
      }
    });
  });
  const allocatedModules = new Set();
  const allocatedItems = new Set();
  const modules = rawModules.map((entry, mi) => {
    const path = `课程.modules[${mi}]`;
    const moduleName = text(entry.module, `${path}.module`, 120, { multiline: false });
    let scene;
    if (own(entry, 'scene')) {
      scene = text(entry.scene, `${path}.scene`, 30, { multiline: false });
      if (!SCENES.has(scene)) fail(`${path}.scene`, '仅支持exhibition、negotiation或complaint');
    }
    const moduleId = own(entry, 'id') ? entry.id : allocateId('module', JSON.stringify([moduleName, scene || '']), reservedModules, allocatedModules);
    allocatedModules.add(moduleId);
    const items = entry.items.map((item, ii) => {
      const itemPath = `${path}.items[${ii}]`;
      const result = { en: text(item.en, `${itemPath}.en`, 4000), zh: text(item.zh, `${itemPath}.zh`, 4000) };
      for (const [key, max] of [['phonetic', 500], ['example', 4000], ['example_zh', 4000], ['role', 40], ['reference', 2000]]) {
        if (own(item, key)) result[key] = text(item[key], `${itemPath}.${key}`, max, { multiline: key !== 'role' });
      }
      if (own(item, 'keywords')) {
        result.keywords = array(item.keywords, `${itemPath}.keywords`, 30).map((word, wi) => text(word, `${itemPath}.keywords[${wi}]`, 80, { multiline: false }));
        if (new Set(result.keywords).size !== result.keywords.length) fail(`${itemPath}.keywords`, '关键词不能重复');
      }
      const itemId = own(item, 'id') ? item.id : allocateId('item', JSON.stringify(result), reservedItems, allocatedItems);
      allocatedItems.add(itemId);
      return { id: itemId, ...result };
    });
    return { id: moduleId, module: moduleName, ...(scene ? { scene } : {}), items };
  });
  // A nameless-ID pack keeps its identity across version updates with the same name.
  const packId = own(raw, 'id') ? id(raw.id, '课程.id') : `pack-${stableHash(name.normalize('NFKC'))}`;
  const result = { id: packId, pack_name: name, version, modules };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > LIMITS.fileBytes) fail('课程', '补齐稳定ID后的课程包不能超过5 MiB');
  return result;
}

// These record validators are shared by IndexedDB writes and backup validation.
export function validateProgressRecord(raw, path = '学习进度') {
  safeTree(raw, path);
  keys(raw, ['packId', 'itemId', 'status', 'favorite', 'attempts', 'lastScore', 'updatedAt', 'lastSpoken', 'lastTarget', 'lastPracticedAt'], path);
  const status = text(raw.status, `${path}.status`, 20);
  if (!STATUSES.has(status)) fail(`${path}.status`, '仅支持new、mastered或review');
  if (typeof raw.favorite !== 'boolean') fail(`${path}.favorite`, '必须是布尔值');
  if (raw.lastScore !== null && (typeof raw.lastScore !== 'number' || !Number.isFinite(raw.lastScore) || raw.lastScore < 0 || raw.lastScore > 100)) fail(`${path}.lastScore`, '须为null或0—100之间的有限数值');
  const result = { packId: id(raw.packId, `${path}.packId`), itemId: id(raw.itemId, `${path}.itemId`), status, favorite: raw.favorite, attempts: integer(raw.attempts, `${path}.attempts`, 0, 1000000000), lastScore: raw.lastScore, updatedAt: timestamp(raw.updatedAt, `${path}.updatedAt`) };
  for (const key of ['lastSpoken', 'lastTarget']) if (own(raw, key)) result[key] = text(raw[key], `${path}.${key}`, 4000, { empty: true });
  if (own(raw, 'lastPracticedAt')) result.lastPracticedAt = raw.lastPracticedAt === null ? null : timestamp(raw.lastPracticedAt, `${path}.lastPracticedAt`);
  return result;
}

export function normalizeWeakWord(value, path = '弱项词') {
  const result = text(value, path, 100, { multiline: false }).normalize('NFKC').toLowerCase();
  if (result.length > 100 || !/^[a-z0-9]+(?:['’\-][a-z0-9]+)*$/.test(result)) fail(path, '须为不超过100字符的英文单词或字母数字词，可包含词内撇号和连字符');
  return result;
}

export function validateWeakContext(raw, path = '弱项词上下文') {
  safeTree(raw, path);
  keys(raw, ['packId', 'itemId', 'target', 'spoken'], path);
  const result = {};
  if (own(raw, 'packId')) result.packId = id(raw.packId, `${path}.packId`);
  if (own(raw, 'itemId')) {
    if (!own(raw, 'packId')) fail(`${path}.itemId`, '提供itemId时必须同时提供packId');
    result.itemId = id(raw.itemId, `${path}.itemId`);
  }
  for (const key of ['target', 'spoken']) if (own(raw, key)) result[key] = text(raw[key], `${path}.${key}`, 4000, { empty: true });
  return result;
}

export function validateWeakWordRecord(raw, path = '弱项词记录') {
  safeTree(raw, path);
  keys(raw, ['word', 'count', 'lastSeen', 'contexts'], path);
  return { word: normalizeWeakWord(raw.word, `${path}.word`), count: integer(raw.count, `${path}.count`, 1, 1000000000), lastSeen: timestamp(raw.lastSeen, `${path}.lastSeen`), contexts: array(raw.contexts, `${path}.contexts`, 5).map((entry, index) => validateWeakContext(entry, `${path}.contexts[${index}]`)) };
}

export function validateSettingRecord(raw, path = '设置') {
  safeTree(raw, path);
  keys(raw, ['key', 'value'], path);
  if (typeof raw.key !== 'string' || !SETTINGS.has(raw.key)) fail(`${path}.key`, '只支持rate、voiceURI、theme、preferredPack设置');
  let value = raw.value;
  if (raw.key === 'rate' && (typeof value !== 'number' || !Number.isFinite(value) || value < 0.6 || value > 1)) fail(`${path}.value`, '语速须为0.6—1.0之间的有限数值');
  if (raw.key === 'voiceURI') value = text(value, `${path}.value`, 1000, { empty: true, multiline: false });
  if (raw.key === 'theme' && !['system', 'light', 'dark'].includes(value)) fail(`${path}.value`, '主题仅支持system、light或dark');
  if (raw.key === 'preferredPack') value = value === '' || value === null ? value : id(value, `${path}.value`);
  return { key: raw.key, value };
}

export function validateBackup(raw) {
  safeTree(raw, '备份');
  keys(raw, ['format', 'format_version', 'exported_at', 'packs', 'progress', 'weakWords', 'settings'], '备份');
  if (raw.format !== 'dayang-english-coach-backup' || raw.format_version !== 1) fail('备份', '不支持此备份格式或版本');
  const exportedAt = timestamp(raw.exported_at, '备份.exported_at');
  const packs = array(raw.packs, '备份.packs', LIMITS.packs).map((entry, index) => {
    try { return validatePack(entry); } catch (error) { fail(`备份.packs[${index}]`, error.message); }
  });
  const packMap = new Map();
  for (const pack of packs) {
    if (packMap.has(pack.id)) fail('备份.packs', `课程包ID重复：${pack.id}`);
    packMap.set(pack.id, new Set(pack.modules.flatMap(module => module.items.map(item => item.id))));
  }
  function checkReference(record, path) {
    if (!own(record, 'packId')) return;
    if (!packMap.has(record.packId)) fail(`${path}.packId`, '引用的课程包不在备份中');
    if (own(record, 'itemId') && !packMap.get(record.packId).has(record.itemId)) fail(`${path}.itemId`, '引用的学习项不属于该课程包');
  }
  const progressKeys = new Set();
  const progress = array(raw.progress, '备份.progress', LIMITS.progress).map((entry, index) => {
    const path = `备份.progress[${index}]`;
    const record = validateProgressRecord(entry, path);
    checkReference(record, path);
    const key = JSON.stringify([record.packId, record.itemId]);
    if (progressKeys.has(key)) fail(path, '同一学习项的进度重复');
    progressKeys.add(key);
    return record;
  });
  const wordKeys = new Set();
  const weakWords = array(raw.weakWords, '备份.weakWords', LIMITS.weakWords).map((entry, index) => {
    const path = `备份.weakWords[${index}]`;
    const record = validateWeakWordRecord(entry, path);
    if (wordKeys.has(record.word)) fail(path, '弱项词重复');
    wordKeys.add(record.word);
    record.contexts.forEach((context, ci) => checkReference(context, `${path}.contexts[${ci}]`));
    return record;
  });
  const settingKeys = new Set();
  const settings = array(raw.settings, '备份.settings', 4).map((entry, index) => {
    const path = `备份.settings[${index}]`;
    const record = validateSettingRecord(entry, path);
    if (settingKeys.has(record.key)) fail(path, '设置项重复');
    settingKeys.add(record.key);
    if (record.key === 'preferredPack' && record.value && !packMap.has(record.value)) fail(`${path}.value`, '首选课程包不在备份中');
    return record;
  });
  const result = { format: 'dayang-english-coach-backup', format_version: 1, exported_at: exportedAt, packs, progress, weakWords, settings };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > LIMITS.backupBytes) fail('备份', '规范化后的完整备份不能超过50 MiB');
  return result;
}

export function parseImport(value) {
  if (typeof value !== 'string') fail('导入文件', '内容必须是文本');
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes > LIMITS.backupBytes) fail('导入文件', '完整备份不能超过50 MiB；课程包不能超过5 MiB');
  let raw;
  try { raw = JSON.parse(value.replace(/^\uFEFF/, '')); } catch (error) { fail('导入文件', `JSON格式错误：${String(error.message).slice(0, 180)}`); }
  if (raw && typeof raw === 'object' && own(raw, 'format')) return { kind: 'backup', backup: validateBackup(raw) };
  if (bytes > LIMITS.fileBytes) fail('导入文件', '课程包不能超过5 MiB；只有指定格式的完整备份可使用50 MiB上限');
  return { kind: 'course', pack: validatePack(raw) };
}

export async function readFileText(file) {
  if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size) || typeof file.text !== 'function') fail('导入文件', '请选择有效文件');
  if (file.size <= 0) fail('导入文件', '文件为空');
  if (file.size > LIMITS.backupBytes) fail('导入文件', '完整备份不能超过50 MiB；课程包不能超过5 MiB');
  let result;
  try { result = await file.text(); } catch { fail('导入文件', '无法读取文件，请重新选择'); }
  if (typeof result !== 'string' || new TextEncoder().encode(result).byteLength > LIMITS.backupBytes) fail('导入文件', '文本无效或超过50 MiB');
  return result;
}

export function downloadJSON(data, filename = 'dayang-english-backup.json') {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') fail('下载', '当前环境不支持浏览器文件下载');
  const safeName = text(filename, '下载文件名', 120, { multiline: false }).replace(/[\\/:*?"<>|]/g, '_');
  const serialized = JSON.stringify(data);
  const backup = data?.format === 'dayang-english-coach-backup';
  if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).byteLength > (backup ? LIMITS.backupBytes : LIMITS.fileBytes)) fail('下载', backup ? '完整备份超过50 MiB可恢复上限，已停止生成文件' : '课程包超过5 MiB可导入上限，已停止生成文件');
  const blob = new Blob([serialized], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = safeName.endsWith('.json') ? safeName : `${safeName}.json`;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  // Give Safari's download hand-off enough time before releasing the blob.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
