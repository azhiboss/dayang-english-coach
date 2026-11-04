import { LIMITS, validatePack, validateBackup, validateProgressRecord, validateWeakContext, validateWeakWordRecord, validateSettingRecord, normalizeWeakWord, normalizeVocabularyWord, validateVocabularyInput, validateVocabularyRecord, validatePlannerState } from './import.js';

const DATABASE_NAME = 'dayang-english-coach';
const DATABASE_VERSION = 3;
const STORE_NAMES = ['packs', 'progress', 'weakWords', 'settings', 'vocabulary', 'planner'];
const SETTING_KEYS = new Set(['rate', 'voiceURI', 'theme', 'preferredPack']);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
let connection = null;
let opening = null;

function assertId(value, label = 'ID') {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`${label}格式不正确`);
}

function assertSettingKey(key) {
  if (!SETTING_KEYS.has(key)) throw new Error('设置仅支持rate、voiceURI、theme和preferredPack');
}

function storageError(error, operation = 'IndexedDB操作') {
  const name = error?.name || 'UnknownError';
  if (name === 'QuotaExceededError') return new Error(`${operation}失败：浏览器存储空间不足，请导出备份后释放空间`);
  if (name === 'SecurityError' || name === 'NotAllowedError') return new Error(`${operation}失败：浏览器阻止了本地数据库访问，请检查隐私模式或站点存储权限`);
  return new Error(`${operation}失败：${name}${error?.message ? `，${error.message}` : ''}`);
}

async function init() {
  if (connection) return connection;
  if (opening) return opening;
  if (typeof indexedDB === 'undefined') throw new Error('当前浏览器不支持IndexedDB，无法安全保存学习数据；请使用支持本地数据库的浏览器');
  opening = new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try { request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION); } catch (error) { rejectOnce(storageError(error, '打开学习数据库')); return; }
    request.onupgradeneeded = () => {
      if (settled) { request.transaction.abort(); return; }
      try {
        const database = request.result;
        if (!database.objectStoreNames.contains('packs')) database.createObjectStore('packs', { keyPath: 'id' });
        if (!database.objectStoreNames.contains('progress')) {
          const store = database.createObjectStore('progress', { keyPath: ['packId', 'itemId'] });
          store.createIndex('packId', 'packId', { unique: false });
        }
        if (!database.objectStoreNames.contains('weakWords')) database.createObjectStore('weakWords', { keyPath: 'word' });
        if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath: 'key' });
        if (!database.objectStoreNames.contains('vocabulary')) database.createObjectStore('vocabulary', { keyPath: 'word' });
        if (!database.objectStoreNames.contains('planner')) database.createObjectStore('planner', { keyPath: 'id' });
      } catch (error) {
        request.transaction.abort();
        rejectOnce(storageError(error, '初始化学习数据库'));
      }
    };
    request.onblocked = () => rejectOnce(new Error('学习数据库被其他页面占用，请关闭旧版页面后重试；已有数据未被清除'));
    request.onerror = () => rejectOnce(storageError(request.error, '打开学习数据库'));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) { database.close(); return; }
      if (!STORE_NAMES.every(name => database.objectStoreNames.contains(name)) || !database.transaction('progress', 'readonly').objectStore('progress').indexNames.contains('packId')) {
        database.close();
        rejectOnce(new Error('学习数据库结构不完整，已停止写入以保护已有数据'));
        return;
      }
      connection = database;
      database.onversionchange = () => { database.close(); if (connection === database) connection = null; opening = null; };
      database.onclose = () => { if (connection === database) connection = null; opening = null; };
      settled = true;
      resolve(database);
    };
  });
  try { return await opening; } catch (error) { opening = null; throw error; }
}

async function transaction(names, mode, work) {
  const database = await init();
  return new Promise((resolve, reject) => {
    let tx;
    let result;
    let failure;
    let finished = false;
    try { tx = database.transaction(names, mode); } catch (error) { reject(storageError(error)); return; }
    const abort = error => {
      failure = error instanceof Error ? error : new Error(String(error));
      try { tx.abort(); } catch { if (!finished) { finished = true; reject(failure); } }
    };
    tx.oncomplete = () => { if (!finished) { finished = true; resolve(result); } };
    tx.onabort = () => { if (!finished) { finished = true; reject(failure || storageError(tx.error, '数据库事务')); } };
    tx.onerror = event => { if (!failure) failure = storageError(event.target?.error || tx.error, '数据库事务'); };
    const watch = (request, success) => {
      request.onsuccess = () => {
        try { success(request.result); } catch (error) { abort(error); }
      };
      return request;
    };
    try { work(tx, value => { result = value; }, watch, abort); } catch (error) { abort(error); }
  });
}

function itemIds(pack) {
  return new Set(pack.modules.flatMap(module => module.items.map(item => item.id)));
}

function requireItem(pack, packId, itemId) {
  if (!pack) throw new Error(`课程包不存在：${packId}`);
  if (itemId && !itemIds(pack).has(itemId)) throw new Error(`学习项不属于课程包：${itemId}`);
}

function cleanContexts(contexts, packId, validItems) {
  return contexts.filter(context => context.packId !== packId || (validItems && (!context.itemId || validItems.has(context.itemId))));
}

function mergeContexts(first, second) {
  const seen = new Set();
  return [...first, ...second].filter(context => {
    const key = JSON.stringify(context);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 5);
}

async function listPacks() {
  const records = await transaction('packs', 'readonly', (tx, done, watch) => watch(tx.objectStore('packs').getAll(), done));
  return records.sort((a, b) => a.pack_name.localeCompare(b.pack_name, 'zh-CN'));
}

async function getPack(packId) {
  assertId(packId, '课程包ID');
  return transaction('packs', 'readonly', (tx, done, watch) => watch(tx.objectStore('packs').get(packId), done));
}

async function putPack(raw) {
  const pack = validatePack(raw);
  const validItems = itemIds(pack);
  return transaction(['packs', 'progress', 'weakWords'], 'readwrite', (tx, done, watch) => {
    tx.objectStore('packs').put(pack);
    const progress = tx.objectStore('progress');
    watch(progress.index('packId').openCursor(IDBKeyRange.only(pack.id)), cursor => {
      if (!cursor) return;
      if (!validItems.has(cursor.value.itemId)) cursor.delete();
      cursor.continue();
    });
    watch(tx.objectStore('weakWords').openCursor(), cursor => {
      if (!cursor) return;
      const record = cursor.value;
      const contexts = cleanContexts(record.contexts, pack.id, validItems);
      if (contexts.length !== record.contexts.length) cursor.update({ ...record, contexts });
      cursor.continue();
    });
    done(pack);
  });
}

async function deletePack(packId) {
  assertId(packId, '课程包ID');
  return transaction(STORE_NAMES, 'readwrite', (tx, done, watch) => {
    tx.objectStore('packs').delete(packId);
    watch(tx.objectStore('progress').index('packId').openCursor(IDBKeyRange.only(packId)), cursor => {
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    });
    watch(tx.objectStore('weakWords').openCursor(), cursor => {
      if (!cursor) return;
      const record = cursor.value;
      const contexts = cleanContexts(record.contexts, packId, null);
      if (contexts.length !== record.contexts.length) cursor.update({ ...record, contexts });
      cursor.continue();
    });
    const settings = tx.objectStore('settings');
    watch(settings.get('preferredPack'), record => { if (record?.value === packId) settings.put({ key: 'preferredPack', value: '' }); });
    done(true);
  });
}

async function listProgress(packId) {
  if (packId !== undefined) assertId(packId, '课程包ID');
  return transaction('progress', 'readonly', (tx, done, watch) => {
    const store = tx.objectStore('progress');
    watch(packId === undefined ? store.getAll() : store.index('packId').getAll(packId), done);
  });
}

async function getProgress(packId, itemId) {
  assertId(packId, '课程包ID');
  assertId(itemId, '学习项ID');
  return transaction('progress', 'readonly', (tx, done, watch) => watch(tx.objectStore('progress').get([packId, itemId]), done));
}

function checkPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || ![Object.prototype, null].includes(Object.getPrototypeOf(patch))) throw new Error('进度更新必须是普通对象');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(patch))) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || descriptor.get || descriptor.set) throw new Error(`进度更新包含不安全字段：${key}`);
  }
}

async function saveProgress(packId, itemId, patch) {
  assertId(packId, '课程包ID');
  assertId(itemId, '学习项ID');
  checkPatch(patch);
  if (Object.prototype.hasOwnProperty.call(patch, 'packId') && patch.packId !== packId) throw new Error('进度更新不能更改课程包ID');
  if (Object.prototype.hasOwnProperty.call(patch, 'itemId') && patch.itemId !== itemId) throw new Error('进度更新不能更改学习项ID');
  return transaction(['packs', 'progress'], 'readwrite', (tx, done, watch) => {
    watch(tx.objectStore('packs').get(packId), pack => {
      requireItem(pack, packId, itemId);
      const store = tx.objectStore('progress');
      watch(store.get([packId, itemId]), current => {
        const record = validateProgressRecord({ packId, itemId, status: 'new', favorite: false, attempts: 0, lastScore: null, ...current, ...patch, updatedAt: new Date().toISOString() });
        store.put(record);
        done(record);
      });
    });
  });
}

async function listWeakWords() {
  const records = await transaction('weakWords', 'readonly', (tx, done, watch) => watch(tx.objectStore('weakWords').getAll(), done));
  return records.sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen) || a.word.localeCompare(b.word));
}

async function addWeakWords(words, rawContext = {}) {
  if (!Array.isArray(words) || words.length > 200) throw new Error('每次添加的弱项词须为不超过200项的数组');
  const counts = new Map();
  for (const word of words) {
    const normalized = normalizeWeakWord(word);
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }
  const context = validateWeakContext(rawContext);
  if (!counts.size) return [];
  return transaction(['packs', 'weakWords'], 'readwrite', (tx, done, watch) => {
    const write = () => {
      const store = tx.objectStore('weakWords');
      const results = [];
      for (const [word, count] of counts) watch(store.get(word), current => {
        const contexts = Object.keys(context).length ? mergeContexts([context], current?.contexts || []) : current?.contexts || [];
        const record = validateWeakWordRecord({ word, count: (current?.count || 0) + count, lastSeen: new Date().toISOString(), contexts });
        store.put(record);
        results.push(record);
        if (results.length === counts.size) done(results);
      });
    };
    if (context.packId) watch(tx.objectStore('packs').get(context.packId), pack => { requireItem(pack, context.packId, context.itemId); write(); });
    else write();
  });
}

async function deleteWeakWord(word) {
  const normalized = normalizeWeakWord(word);
  return transaction('weakWords', 'readwrite', (tx, done) => { tx.objectStore('weakWords').delete(normalized); done(true); });
}

async function listVocabulary() {
  const records = await transaction('vocabulary', 'readonly', (tx, done, watch) => watch(tx.objectStore('vocabulary').getAll(), done));
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.word.localeCompare(b.word));
}

async function saveVocabulary(raw) {
  const input = validateVocabularyInput(raw);
  return transaction('vocabulary', 'readwrite', (tx, done, watch) => {
    const store = tx.objectStore('vocabulary');
    watch(store.get(input.word), current => {
      const write = () => {
        const now = new Date().toISOString();
        const record = validateVocabularyRecord({
          word: input.word, zh: '', phonetic: '', context: '', mastered: false,
          ...current, ...input, createdAt: current?.createdAt || now, updatedAt: now,
        });
        store.put(record);
        done(record);
      };
      if (current) write();
      else watch(store.count(), count => {
        if (count >= LIMITS.vocabulary) throw new Error(`生词本最多保存${LIMITS.vocabulary}词，请先导出备份并整理生词本`);
        write();
      });
    });
  });
}

async function patchVocabulary(word, patch) {
  const normalized = normalizeVocabularyWord(word);
  checkPatch(patch);
  if (Object.keys(patch).length !== 1 || typeof patch.mastered !== 'boolean') throw new Error('生词更新只支持mastered布尔字段');
  return transaction('vocabulary', 'readwrite', (tx, done, watch) => {
    const store = tx.objectStore('vocabulary');
    watch(store.get(normalized), current => {
      if (!current) throw new Error('这个词已不在生词本中，请刷新后重试');
      const record = validateVocabularyRecord({ ...current, mastered: patch.mastered, updatedAt: new Date().toISOString() });
      store.put(record);
      done(record);
    });
  });
}

async function deleteVocabulary(word) {
  const normalized = normalizeVocabularyWord(word);
  return transaction('vocabulary', 'readwrite', (tx, done) => {
    tx.objectStore('vocabulary').delete(normalized);
    done(true);
  });
}

async function loadPlanner() {
  return transaction('planner', 'readonly', (tx, done, watch) => {
    watch(tx.objectStore('planner').get('current'), record => done(record ? validatePlannerState(record.data) : null));
  });
}

async function updatePlanner(updater) {
  if (typeof updater !== 'function') throw new Error('学习计划更新必须提供同步函数');
  return transaction('planner', 'readwrite', (tx, done, watch) => {
    const store = tx.objectStore('planner');
    watch(store.get('current'), record => {
      const current = record ? validatePlannerState(record.data) : null;
      const next = updater(current);
      if (next && typeof next.then === 'function') throw new Error('学习计划更新函数不能是异步函数');
      const state = validatePlannerState(next);
      store.put({ id: 'current', data: state });
      done(state);
    });
  });
}

async function replacePlanner(raw) {
  const state = raw === null ? null : validatePlannerState(raw);
  return transaction('planner', 'readwrite', (tx, done) => {
    const store = tx.objectStore('planner');
    if (state === null) store.delete('current');
    else store.put({ id: 'current', data: state });
    done(state);
  });
}

async function getSetting(key, fallback) {
  assertSettingKey(key);
  return transaction('settings', 'readonly', (tx, done, watch) => watch(tx.objectStore('settings').get(key), record => done(record ? record.value : fallback)));
}

async function setSetting(key, value) {
  const record = validateSettingRecord({ key, value });
  return transaction(['packs', 'settings'], 'readwrite', (tx, done, watch) => {
    const write = () => { tx.objectStore('settings').put(record); done(record.value); };
    if (key === 'preferredPack' && record.value) watch(tx.objectStore('packs').get(record.value), pack => { requireItem(pack, record.value); write(); });
    else write();
  });
}

async function exportBackup() {
  const backup = await transaction(STORE_NAMES, 'readonly', (tx, done, watch) => {
    const result = { format: 'dayang-english-coach-backup', format_version: 3, exported_at: new Date().toISOString() };
    let remaining = STORE_NAMES.length;
    for (const name of STORE_NAMES) watch(tx.objectStore(name).getAll(), records => {
      result[name] = name === 'planner' ? (records.find(record => record.id === 'current')?.data ?? null) : records;
      if (--remaining === 0) done(result);
    });
  });
  const result = validateBackup(backup);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > LIMITS.backupBytes) throw new Error('完整备份超过50 MiB可恢复上限，已停止导出，避免生成无法还原的单文件备份');
  return result;
}

async function restoreBackup(raw) {
  // Complete validation and reference checks happen before opening a write transaction.
  const backup = validateBackup(raw);
  const replacements = new Map(backup.packs.map(pack => [pack.id, itemIds(pack)]));
  return transaction(STORE_NAMES, 'readwrite', (tx, done, watch) => {
    let currentProgress;
    let currentWords;
    let currentVocabulary;
    let remaining = 3;
    const merge = () => {
      if (--remaining !== 0) return;
      const packStore = tx.objectStore('packs');
      const progressStore = tx.objectStore('progress');
      const wordStore = tx.objectStore('weakWords');
      const settingStore = tx.objectStore('settings');
      const vocabularyStore = tx.objectStore('vocabulary');
      for (const pack of backup.packs) packStore.put(pack);
      const existingProgress = new Map();
      for (const record of currentProgress) {
        const validItems = replacements.get(record.packId);
        if (validItems && !validItems.has(record.itemId)) progressStore.delete([record.packId, record.itemId]);
        else existingProgress.set(JSON.stringify([record.packId, record.itemId]), record);
      }
      for (const record of backup.progress) {
        const current = existingProgress.get(JSON.stringify([record.packId, record.itemId]));
        if (!current || record.updatedAt >= current.updatedAt) progressStore.put(record);
      }
      const existingWords = new Map();
      for (const record of currentWords) {
        let contexts = record.contexts;
        for (const [packId, validItems] of replacements) contexts = cleanContexts(contexts, packId, validItems);
        const cleaned = { ...record, contexts };
        existingWords.set(record.word, cleaned);
        if (contexts.length !== record.contexts.length) wordStore.put(cleaned);
      }
      for (const record of backup.weakWords) {
        const current = existingWords.get(record.word);
        if (!current) { wordStore.put(record); continue; }
        const incomingNewer = record.lastSeen >= current.lastSeen;
        wordStore.put({ word: record.word, count: Math.max(record.count, current.count), lastSeen: incomingNewer ? record.lastSeen : current.lastSeen, contexts: incomingNewer ? mergeContexts(record.contexts, current.contexts) : mergeContexts(current.contexts, record.contexts) });
      }
      const existingVocabulary = new Map(currentVocabulary.map(record => [record.word, record]));
      const vocabularyCount = new Set([...existingVocabulary.keys(), ...backup.vocabulary.map(record => record.word)]).size;
      if (vocabularyCount > LIMITS.vocabulary) throw new Error(`合并后的生词本超过${LIMITS.vocabulary}词上限`);
      for (const record of backup.vocabulary) {
        const current = existingVocabulary.get(record.word);
        if (!current || record.updatedAt >= current.updatedAt) vocabularyStore.put(record);
      }
      for (const record of backup.settings) settingStore.put(record);
      if (Object.prototype.hasOwnProperty.call(backup, 'planner')) {
        const plannerStore = tx.objectStore('planner');
        if (backup.planner === null) plannerStore.delete('current');
        else plannerStore.put({ id: 'current', data: backup.planner });
      }
      done({ packs: backup.packs.length, progress: backup.progress.length, weakWords: backup.weakWords.length, settings: backup.settings.length, vocabulary: backup.vocabulary.length, planner: Object.prototype.hasOwnProperty.call(backup, 'planner') });
    };
    watch(tx.objectStore('progress').getAll(), records => { currentProgress = records; merge(); });
    watch(tx.objectStore('weakWords').getAll(), records => { currentWords = records; merge(); });
    watch(tx.objectStore('vocabulary').getAll(), records => { currentVocabulary = records; merge(); });
  });
}

export const DB = Object.freeze({ init, listPacks, getPack, putPack, deletePack, listProgress, getProgress, saveProgress, listWeakWords, addWeakWords, deleteWeakWord, listVocabulary, saveVocabulary, patchVocabulary, deleteVocabulary, loadPlanner, updatePlanner, replacePlanner, getSetting, setSetting, exportBackup, restoreBackup });
