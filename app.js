import { DB } from './db.js';
import { TTS, DEFAULT_RATE } from './tts.js';
import { SpeechInput, compareWords } from './asr.js';
import { validatePack, expandedToPack, parseImport, readFileText, downloadJSON } from './import.js';
import { Planner, dateKey } from './planner.js';

const $ = id => document.getElementById(id);
const speech = new SpeechInput();
const mediaTheme = window.matchMedia('(prefers-color-scheme: dark)');
const planner = new Planner({ db: DB });
const VIEW_NAMES = ['today', 'learn', 'practice', 'scenario', 'vocabulary', 'data'];
const state = {
  packs: [], packId: '', progress: new Map(), weakWords: [], demo: null,
  moduleId: 'all', filter: 'all', index: 0, filtered: [], reveal: false,
  view: 'today', practice: null, practiceBusy: false, scenarioBusy: false,
  generation: 0, listeningFor: null, scene: null, sceneMode: 'voice',
  rate: DEFAULT_RATE, voiceURI: '', theme: 'system', importCandidate: null,
  importGeneration: 0, importing: false, weakLimit: 40,
  offlineReady: false, waitingWorker: null, updateRequested: false,
  expanded: new Map(), dictionary: new Map(), vocabulary: new Map(), vocabLimit: 40,
  lookup: null, expandedError: '',
  plan: null, plannerReady: false, planSession: null, plannedWord: null, plannedPractice: null, plannedScenario: null,
};
// Serialize attempt increments for the same learning item across both views.
const attemptWrites = new Map();
let cancelLookupPress = () => {};

const sceneInfo = {
  exhibition: { title: '展会接待', description: '了解客户需求，介绍产品，再约定下一步。' },
  negotiation: { title: '价格谈判', description: '练习数量、配置与报价条件，让讨论有重点。' },
  complaint: { title: '客诉处理', description: '先核对事实和证据，再把处理步骤说清楚。' },
};

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = String(text);
  return result;
}
function key(packId, itemId) { return `${packId}\u0000${itemId}`; }
function currentPack() { return state.packs.find(pack => pack.id === state.packId); }
function flatten(pack) {
  return pack ? pack.modules.flatMap(module => module.items.map(item => ({
    ...item, packId: pack.id, moduleId: module.id, moduleName: module.module,
  }))) : [];
}
function progressFor(item) {
  return state.progress.get(key(item.packId, item.id)) || { status: 'new', favorite: false, attempts: 0, lastScore: null };
}
function currentItem() { return state.filtered[state.index] || null; }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}
function report(error) { toast(errorMessage(error)); }
function bind(id, event, callback) {
  $(id).addEventListener(event, e => {
    try {
      const result = callback(e);
      if (result && typeof result.catch === 'function') result.catch(report);
    } catch (error) { report(error); }
  });
}

function applyTheme() {
  const dark = state.theme === 'dark' || (state.theme === 'system' && mediaTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('theme-color').content = dark ? '#0d1823' : '#0C6DB2';
  $('theme-select').value = state.theme;
}

function abortAudio() {
  state.generation += 1;
  state.listeningFor = null;
  speech.abort();
  TTS.cancel();
  updateRecordingUI();
}
function speakText(text) {
  // No await before this call: iOS requires synthesis in the user's click chain.
  state.listeningFor = null;
  speech.abort();
  updateRecordingUI();
  return TTS.speak(text, {
    rate: state.rate, voiceURI: state.voiceURI,
    onError: message => toast(message),
  });
}
function updateVoices(voices = TTS.listVoices()) {
  const select = $('voice-select');
  const options = [];
  if (!voices.length) {
    const option = node('option', '', TTS.supported ? '尚未找到本地英语语音' : '当前浏览器不支持系统朗读');
    option.value = '';
    options.push(option);
    $('voice-status').textContent = '只使用设备本地英语语音。可先安装系统英语声音，返回后再次点击发音。';
  } else {
    for (const voice of voices) {
      const option = node('option', '', `${voice.name} · ${voice.lang} · 本地`);
      option.value = voice.voiceURI;
      options.push(option);
    }
    $('voice-status').textContent = '优先使用本地美式英语声音；语音质量取决于设备已安装的声音。';
  }
  select.replaceChildren(...options);
  const selected = voices.find(voice => voice.voiceURI === state.voiceURI) || voices[0];
  select.value = selected ? selected.voiceURI : '';
  select.disabled = !voices.length;
}
function updateRecordingUI() {
  const active = speech.active;
  $('start-practice').disabled = !speech.supported || active || state.practiceBusy || !state.practice;
  $('stop-practice').disabled = !(active && state.listeningFor === 'practice');
  $('start-scenario-voice').disabled = !speech.supported || active || state.scenarioBusy || !state.scene;
  $('stop-scenario-voice').disabled = !(active && state.listeningFor === 'scenario');
  $('compare-practice').disabled = state.practiceBusy || active || !state.practice;
  $('check-scenario').disabled = state.scenarioBusy || active || !state.scene;
  $('next-scenario').disabled = state.scenarioBusy || active || !state.scene?.checked;
  $('start-practice').parentElement.classList.toggle('is-recording', active && state.listeningFor === 'practice');
  $('scenario-voice-tools').classList.toggle('is-recording', active && state.listeningFor === 'scenario');
}

function renderPackControls() {
  const selected = state.packId;
  $('pack-select').replaceChildren(...state.packs.map(pack => {
    const option = node('option', '', pack.pack_name);
    option.value = pack.id;
    return option;
  }));
  $('pack-select').value = selected;
  const pack = currentPack();
  $('pack-description').textContent = pack ? `${pack.modules.length} 个模块 · ${flatten(pack).length} 条内容 · ${pack.version}` : '';
  const all = node('option', '', '全部模块'); all.value = 'all';
  $('module-filter').replaceChildren(all, ...(pack?.modules || []).map(module => {
    const option = node('option', '', module.module);
    option.value = module.id;
    return option;
  }));
  if (!pack?.modules.some(module => module.id === state.moduleId)) state.moduleId = 'all';
  $('module-filter').value = state.moduleId;
  $('status-filter').value = state.filter;
}
function renderSummary() {
  const items = flatten(currentPack());
  const records = items.map(progressFor);
  $('mastered-count').textContent = records.filter(p => p.status === 'mastered').length;
  $('review-count').textContent = records.filter(p => p.status === 'review').length;
  $('favorite-count').textContent = records.filter(p => p.favorite).length;
  const today = new Date().toDateString();
  const practiced = [...state.progress.values()].filter(p => p.lastPracticedAt && new Date(p.lastPracticedAt).toDateString() === today).length;
  $('today-count').textContent = practiced ? `今天练了 ${practiced} 句` : '今天从一句开始';
}
function renderLearn(preferredId) {
  cancelLookupPress();
  closeLookup();
  const query = $('course-search').value.trim().toLowerCase();
  state.filtered = flatten(currentPack()).filter(item => {
    if (query && !`${item.en} ${item.zh} ${examplesFor(item).map(example => `${example.en} ${example.zh}`).join(' ')}`.toLowerCase().includes(query)) return false;
    if (state.moduleId !== 'all' && item.moduleId !== state.moduleId) return false;
    const p = progressFor(item);
    if (state.filter === 'favorite') return p.favorite;
    if (state.filter === 'new') return p.status !== 'mastered';
    if (state.filter !== 'all') return p.status === state.filter;
    return true;
  });
  const preferredIndex = preferredId ? state.filtered.findIndex(item => item.id === preferredId) : -1;
  state.index = preferredIndex >= 0 ? preferredIndex : Math.min(Math.max(state.index, 0), Math.max(0, state.filtered.length - 1));
  const item = currentItem();
  if (state.plannedWord && (!item || `${item.packId}/${item.id}` !== state.plannedWord.key)) {
    state.plannedWord = null;$('planner-word-link').hidden = true;
  }
  const empty = !item;
  $('learning-card').hidden = empty;
  $('learning-empty').hidden = !empty;
  $('mark-actions').hidden = empty;
  $('card-navigation').hidden = empty;
  if (!item) return;
  const p = progressFor(item);
  $('item-module').textContent = item.moduleName;
  $('item-position').textContent = `${state.index + 1} / ${state.filtered.length}`;
  $('item-en').textContent = item.en;
  $('item-en').classList.toggle('is-long', item.en.length > 160);
  $('item-role').hidden = !item.role;
  $('item-role').textContent = item.role ? `角色：${item.role}` : '';
  $('item-phonetic').hidden = !item.phonetic;
  $('item-phonetic').textContent = item.phonetic || '';
  $('item-zh').textContent = item.zh;
  $('item-meaning').hidden = !state.reveal;
  $('toggle-meaning').textContent = state.reveal ? '收起释义' : '显示释义';
  $('toggle-meaning').setAttribute('aria-expanded', String(state.reveal));
  $('example-block').hidden = !examplesFor(item).length;
  $('item-example').textContent = item.example || '';
  $('item-example-zh').textContent = item.example_zh || '';
  renderExamples(item);
  $('mark-mastered').setAttribute('aria-pressed', String(p.status === 'mastered'));
  $('mark-review').setAttribute('aria-pressed', String(p.status === 'review'));
  $('mark-favorite').setAttribute('aria-pressed', String(p.favorite));
  $('previous-item').disabled = state.index === 0;
  $('next-item').disabled = state.index >= state.filtered.length - 1;
  $('random-item').disabled = state.filtered.length < 2;
}

function switchView(view, focus = true) {
  if (!VIEW_NAMES.includes(view)) return;
  sampleStudyTime();
  cancelLookupPress();
  closeLookup();
  abortAudio();
  state.view = view;
  document.querySelector('.course-bar').hidden = view === 'today';
  for (const name of VIEW_NAMES) {
    $(`panel-${name}`).hidden = name !== view;
    $(`tab-${name}`).setAttribute('aria-selected', String(name === view));
    $(`tab-${name}`).tabIndex = name === view ? 0 : -1;
  }
  if (view === 'practice' && !state.practice) setPracticeTarget(currentItem());
  if (view === 'data') renderData();
  if (view === 'vocabulary') renderVocabulary();
  if (view === 'today' && state.plannerReady) refreshPlan().catch(report);
  if (focus) {
    $('main-content').focus({ preventScroll: true });
    $('main-content').scrollIntoView({ behavior: 'auto', block: 'start' });
  }
}
async function markItem(action) {
  const item = currentItem();
  if (!item) return;
  const previous = progressFor(item);
  const patch = action === 'favorite'
    ? { favorite: !previous.favorite }
    : { status: previous.status === action ? 'new' : action };
  const controls = ['mark-mastered', 'mark-review', 'mark-favorite'].map($);
  controls.forEach(button => { button.disabled = true; });
  try {
    const saved = await DB.saveProgress(item.packId, item.id, patch);
    state.progress.set(key(item.packId, item.id), saved);
    renderSummary(); renderLearn(currentItem()?.id);
    toast(action === 'favorite' ? (saved.favorite ? '已加入收藏' : '已取消收藏') : saved.status === 'new' ? '已还原为未标记' : saved.status === 'mastered' ? '已标记掌握' : '已加入复习队列');
  } finally { controls.forEach(button => { button.disabled = false; }); }
}
function moveItem(direction) {
  abortAudio();
  state.reveal = false;
  if (direction === 'random' && state.filtered.length > 1) {
    const offset = 1 + Math.floor(Math.random() * (state.filtered.length - 1));
    state.index = (state.index + offset) % state.filtered.length;
  } else state.index += Number(direction);
  renderLearn();
}

function setPracticeTarget(item) {
  abortAudio();
  state.plannedPractice = null;
  $('planner-practice-link').hidden = true;
  state.practice = item ? { ...item } : null;
  $('practice-module').textContent = item?.moduleName || '弱项单词练习';
  $('practice-target').textContent = item?.en || '先到学习页选择一句话';
  $('practice-translation').textContent = item?.zh || '';
  $('practice-input').value = '';
  $('practice-result').hidden = true;
  $('practice-status').textContent = '也可以直接输入英文练习';
  updateRecordingUI();
}
function showAlignment(result) {
  const labels = { correct: '匹配', substitution: '待练', missing: '漏读', extra: '多读' };
  $('word-alignment').replaceChildren(...result.alignment.map(token => {
    const span = node('span', `word-token is-${token.kind}`);
    span.append(node('span', '', token.expected || token.actual));
    const detail = token.kind === 'substitution' ? `${labels[token.kind]} · 识别为 ${token.actual}` : labels[token.kind];
    span.append(node('small', '', detail));
    span.setAttribute('aria-label', `${token.expected || token.actual}，${detail}`);
    return span;
  }));
}
async function saveAttempt(target, spoken, score, extra = {}) {
  if (!target?.packId || !target?.id || !state.packs.some(pack => pack.id === target.packId)) return;
  const recordKey = key(target.packId, target.id);
  const attemptedAt = new Date().toISOString();
  const pending = (attemptWrites.get(recordKey) || Promise.resolve()).catch(() => {}).then(async () => {
    if (!state.packs.some(pack => pack.id === target.packId)) return;
    const previous = await DB.getProgress(target.packId, target.id);
    const record = await DB.saveProgress(target.packId, target.id, {
      attempts: (previous?.attempts || 0) + 1,
      lastScore: score, lastTarget: target.en, lastSpoken: spoken,
      lastPracticedAt: attemptedAt, ...extra,
    });
    if (state.packs.some(pack => pack.id === target.packId)) {
      state.progress.set(recordKey, record);
      renderSummary();
    }
  });
  attemptWrites.set(recordKey, pending);
  try { await pending; }
  finally { if (attemptWrites.get(recordKey) === pending) attemptWrites.delete(recordKey); }
}
async function evaluatePractice() {
  if (state.practiceBusy) return;
  const target = state.practice;
  const spoken = $('practice-input').value.trim();
  if (!target) return toast('先到学习页选择目标句。');
  if (!spoken) return toast('先说出或输入一句英文，再进行对比。');
  if (spoken.length > 4000) return toast('输入超过4000字符，请缩短后再对比。');
  const result = compareWords(target.en, spoken);
  if (!result.total) return toast('这个目标没有可比较的英文单词，请选择另一条。');
  const generation = state.generation;
  state.practiceBusy = true;
  updateRecordingUI();
  $('practice-result').hidden = false;
  $('practice-score').textContent = `${result.score}%`;
  $('practice-result-summary').textContent = `匹配 ${result.correct}/${result.total} 词 · 替换 ${result.substitutions} · 漏读 ${result.deletions} · 多读 ${result.insertions}`;
  showAlignment(result);
  $('weak-save-status').textContent = '正在保存本次练习…';
  try {
    await saveAttempt(target, spoken, result.score);
    const context = { target: target.en, spoken };
    if (target.packId && target.id && state.packs.some(pack => pack.id === target.packId)) {
      context.packId = target.packId; context.itemId = target.id;
    }
    const validWords = result.weakWords.filter(word => word.length <= 100 && /^[a-z0-9]+(?:['’\-][a-z0-9]+)*$/.test(word));
    for (let offset = 0; offset < validWords.length; offset += 200) await DB.addWeakWords(validWords.slice(offset, offset + 200), context);
    state.weakWords = await DB.listWeakWords();
    if (generation === state.generation && state.plannedPractice) {
      $('planner-practice-note').textContent = '本次跟读已保存。确认练习完成后，可点下方按钮计入今日任务。';
    }
    if (generation === state.generation) {
      $('weak-save-status').textContent = validWords.length
        ? `本次 ${validWords.length} 个待练目标词已记入弱项词库。${validWords.length < result.weakWords.length ? '过长词项未写入，请分段练习。' : ''}`
        : '本次练习已保存，没有新增弱项词。';
    }
  } catch (error) {
    if (generation === state.generation) $('weak-save-status').textContent = `对比已完成，但本次数据未能全部保存：${errorMessage(error)}`;
    throw error;
  } finally {
    state.practiceBusy = false;
    updateRecordingUI();
  }
}

function beginRecognition(purpose) {
  TTS.cancel();
  if (!speech.supported) {
    const message = '此设备或当前地址不支持语音识别，请在文本框输入英文。HTTPS和支持的系统服务可提高可用性。';
    $(purpose === 'practice' ? 'practice-status' : 'scenario-status').textContent = message;
    toast(message); return;
  }
  if (speech.active) return;
  if (purpose === 'practice' && !state.practice) return toast('先到学习页选择目标句。');
  if (purpose === 'scenario' && !state.scene) return toast('请先开始一个情景。');
  if ((purpose === 'practice' && state.practiceBusy) || (purpose === 'scenario' && state.scenarioBusy)) {
    return toast('正在保存本次回答，请稍后再开始下一次语音输入。');
  }
  const generation = ++state.generation;
  const targetId = state.practice?.id;
  const sceneTurn = state.scene?.index;
  const sceneInstance = state.scene;
  state.listeningFor = purpose;
  const input = $(purpose === 'practice' ? 'practice-input' : 'scenario-input');
  const status = $(purpose === 'practice' ? 'practice-status' : 'scenario-status');
  // Preserve existing typing if permission is denied or no new result arrives.
  if (purpose === 'practice') $('practice-result').hidden = true;
  let receivedFinal = false;
  let receivedResult = false;
  let receivedError = false;
  const valid = () => generation === state.generation && state.listeningFor === purpose && (purpose !== 'practice' || state.practice?.id === targetId) && (purpose !== 'scenario' || (state.scene === sceneInstance && state.scene?.index === sceneTurn));
  const started = speech.start({
    onStatus: message => { if (valid()) status.textContent = message; },
    onResult: (text, { isFinal }) => {
      if (!valid()) return;
      receivedResult = true;
      receivedFinal = isFinal;
      input.value = text;
      if (purpose === 'scenario') {
        sceneInstance.checked = false;
        $('scenario-feedback').hidden = true;
        updateRecordingUI();
      }
      if (isFinal) status.textContent = '已识别，结束本次识别后将自动对比并保存。';
    },
    onError: message => { if (valid()) { receivedError = true;status.textContent = message;toast(message); } },
    onEnd: () => {
      if (!valid()) return;
      state.listeningFor = null;
      if (!receivedError && receivedFinal) {
        status.textContent = '已识别，可编辑文字后再次比较。';
        const evaluated = purpose === 'practice' ? evaluatePractice() : evaluateScenario();
        evaluated.catch(report);
      } else if (!receivedError) status.textContent = receivedResult
          ? '识别已结束，可编辑后点击提交。'
          : '未获得新的识别文字，原有输入已保留。';
      updateRecordingUI();
    },
  });
  updateRecordingUI();
  started.catch(report).finally(updateRecordingUI);
}

function sceneModule(pack, scene) {
  return pack?.modules.find(module => module.scene === scene || (scene === 'exhibition' && /展会/.test(module.module)) || (scene === 'negotiation' && /谈判|谈价/.test(module.module)) || (scene === 'complaint' && /客诉/.test(module.module)));
}
function prepareScenario() {
  const sceneName = $('scenario-select').value;
  let pack = currentPack();
  let module = sceneModule(pack, sceneName);
  if (state.plannedScenario?.scene === sceneName) {
    const scheduledPack = state.packs.find(candidate => candidate.id === state.plannedScenario.packId);
    const scheduledModule = scheduledPack?.modules.find(candidate => candidate.id === state.plannedScenario.moduleId);
    if (scheduledModule) { pack = scheduledPack;module = scheduledModule; }
  }
  if (!module) {
    pack = state.packs.find(candidate => sceneModule(candidate, sceneName));
    module = sceneModule(pack, sceneName);
  }
  if (!module) { pack = state.demo; module = sceneModule(pack, sceneName); }
  if (!module || !pack) throw new Error('暂时没有这个情景。请导入含对应scene字段及Client/You角色的课程。');
  const turns = [];
  for (let index = 0; index < module.items.length; index += 1) {
    const prompt = module.items[index];
    if (String(prompt.role).toLowerCase() !== 'client') continue;
    let response;
    for (let next = index + 1; next < module.items.length; next += 1) {
      if (String(module.items[next].role).toLowerCase() === 'client') break;
      if (['you', 'supplier'].includes(String(module.items[next].role).toLowerCase())) { response = module.items[next]; break; }
    }
    const reference = prompt.reference || response?.en || '';
    const keywords = prompt.keywords?.length ? prompt.keywords : deriveKeywords(reference);
    turns.push({ prompt: { ...prompt, packId: pack.id, moduleId: module.id, moduleName: module.module }, reference, referenceZh: response?.zh || '', keywords });
  }
  if (!turns.length) throw new Error('这个情景模块没有Client角色的问题，请检查课程格式。');
  return { name: sceneName, pack, module, turns, index: 0, responses: [], checked: false };
}
function deriveKeywords(text) {
  const ignored = new Set(['the','a','an','and','or','to','of','in','on','for','with','is','are','be','we','you','your','our','can','will','please','that','this','it','would','could','have','as','from']);
  return [...new Set(normalizeWords(text).split(' ').filter(word => word.length > 3 && !ignored.has(word)))].slice(0, 6);
}
function normalizeWords(value) {
  return (String(value).normalize('NFKC').toLowerCase().replace(/[\u2018\u2019\u02bc\uff07]/g, "'").match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || []).join(' ');
}
function renderScenarioIntro() {
  const info = sceneInfo[$('scenario-select').value];
  $('scenario-title').textContent = info.title;
  $('scenario-description').textContent = info.description;
}
function renderSceneTurn() {
  const scene = state.scene;
  const turn = scene.turns[scene.index];
  scene.checked = false;
  $('scenario-intro').hidden = true;
  $('scenario-session').hidden = false;
  $('scenario-complete').hidden = true;
  $('scenario-source').textContent = scene.pack.id === state.packId ? '当前课程中的情景' : '内置 / 其他课程情景';
  $('scenario-step').textContent = `第 ${scene.index + 1} / ${scene.turns.length} 轮`;
  $('client-question').textContent = turn.prompt.en;
  $('client-translation').textContent = turn.prompt.zh;
  $('client-translation').parentElement.open = false;
  $('scenario-input').value = '';
  $('scenario-feedback').hidden = true;
  $('scenario-reference').hidden = true;
  $('reference-en').textContent = turn.reference || '此课程未提供参考回答，可自行补充You角色内容。';
  $('reference-zh').textContent = turn.referenceZh;
  $('next-scenario').disabled = true;
  $('next-scenario').textContent = scene.index === scene.turns.length - 1 ? '完成本次对练' : '下一轮';
  $('scenario-status').textContent = state.sceneMode === 'text' ? '文本模式：直接输入你的英文回答。' : speech.supported ? '准备好后，点击语音回答。' : '此浏览器不支持识别，请直接输入英文。';
  $('scenario-voice-tools').hidden = state.sceneMode === 'text';
  updateRecordingUI();
}
function startScenario() {
  abortAudio();
  state.scene = prepareScenario();
  if (state.plannedScenario && state.plannedScenario.key !== `${state.scene.pack.id}/${state.scene.module.id}`) {
    state.plannedScenario = null;$('planner-scenario-link').hidden = true;
  }
  renderSceneTurn();
  if (state.sceneMode === 'voice') speakText(state.scene.turns[0].prompt.en);
}
function revealReference() {
  if (!state.scene) return;
  $('scenario-reference').hidden = false;
}
async function evaluateScenario() {
  if (state.scenarioBusy || !state.scene) return;
  const scene = state.scene;
  const turn = scene.turns[scene.index];
  const spoken = $('scenario-input').value.trim();
  if (!spoken) return toast('先说出或输入你的英文回答。');
  if (spoken.length > 4000) return toast('回答超过4000字符，请精简后再提交。');
  const normalized = ` ${normalizeWords(spoken)} `;
  const matched = turn.keywords.filter(keyword => {
    const normalizedKeyword = normalizeWords(keyword);
    return normalizedKeyword && normalized.includes(` ${normalizedKeyword} `);
  });
  const coverage = turn.keywords.length ? Math.round(matched.length / turn.keywords.length * 100) : 0;
  const feedback = $('scenario-feedback');
  const positive = matched.length > 0;
  feedback.replaceChildren(
    node('strong', '', positive ? '回答有重点，继续把信息说完整。' : '再试着补充客户关心的要点。'),
    node('p', '', positive ? `已命中要点：${matched.join('、')}。可对照参考表达完善细节。` : turn.keywords.length ? `可以尝试涉及：${turn.keywords.join('、')}。下面有参考表达。` : '此条没有预设关键词，可对照参考表达自行复盘。'),
    node('p', 'supporting-text', '这里仅做简单关键词匹配，不判断语法、事实或商务条件是否正确。'),
  );
  feedback.classList.toggle('is-positive', positive);
  feedback.hidden = false;
  if (!positive) revealReference();
  scene.responses[scene.index] = { spoken, matched: matched.length, total: turn.keywords.length };
  scene.checked = true;
  state.scenarioBusy = true;
  updateRecordingUI();
  try { await saveAttempt(turn.prompt, spoken, coverage); }
  finally { state.scenarioBusy = false;updateRecordingUI(); }
}
function nextScenario() {
  if (!state.scene?.checked || state.scenarioBusy || speech.active) return;
  abortAudio();
  const scene = state.scene;
  if (scene.index >= scene.turns.length - 1) {
    $('scenario-session').hidden = true;
    $('scenario-complete').hidden = false;
    const covered = scene.responses.filter(response => response?.matched > 0).length;
    $('scenario-complete-summary').textContent = `完成 ${scene.turns.length} 轮回答，其中 ${covered} 轮命中预设要点。换个表达再练一次，会更熟悉。`;
    if (state.plannedScenario) {
      const scheduled = state.plannedScenario;
      completePlannedTask('scenario', scheduled.key, scheduled.date).then(() => {
        if (state.scene === scene) $('scenario-complete-summary').textContent += ' 已计入今日任务。';
      }).catch(report);
    }
  } else {
    scene.index += 1;
    renderSceneTurn();
    if (state.sceneMode === 'voice') speakText(scene.turns[scene.index].prompt.en);
  }
}
function resetScenario() {
  abortAudio(); state.scene = null;
  state.plannedScenario = null;
  $('planner-scenario-link').hidden = true;
  $('scenario-intro').hidden = false;
  $('scenario-session').hidden = true;
  $('scenario-complete').hidden = true;
  renderScenarioIntro();
  updateRecordingUI();
}

function renderPacks() {
  $('pack-list').replaceChildren(...state.packs.map(pack => {
    const article = node('article', 'pack-row');
    const info = node('div');
    info.append(node('h4', '', pack.pack_name), node('p', '', `${pack.version} · ${pack.modules.length} 模块 · ${flatten(pack).length} 条${pack.id === state.packId ? ' · 当前课程' : ''}`));
    const button = node('button', 'button button-quiet', '移除课程');
    button.type = 'button'; button.dataset.removePack = pack.id;
    button.disabled = state.packs.length <= 1;
    button.setAttribute('aria-label', `移除课程：${pack.pack_name}`);
    if (button.disabled) button.title = '保留至少一个课程包；可先导入其他课程。';
    article.append(info, button); return article;
  }));
}
function renderWeakWords() {
  const query = $('weak-search').value.trim().toLowerCase();
  const matches = state.weakWords.filter(record => record.word.includes(query));
  $('weak-count').textContent = state.weakWords.length;
  $('more-weak').hidden = matches.length <= state.weakLimit;
  if (!matches.length) {
    const empty = node('div', 'empty-state');
    empty.append(node('h4', '', query ? '没有找到这个词' : '先完成一次跟读练习'), node('p', '', query ? '换个关键词试试。' : '错读或漏读的目标词会自动记入，方便带回原句复习。'));
    $('weak-list').replaceChildren(empty); return;
  }
  $('weak-list').replaceChildren(...matches.slice(0, state.weakLimit).map(record => {
    const row = node('article', 'weak-row'); const info = node('div');
    info.append(node('h4', '', record.word), node('p', '', `在练习中出现 ${record.count} 次`));
    const tools = node('div', 'weak-tools');
    for (const [action, label] of [['speak','发音'],['practice',record.contexts.some(context => context.target) ? '回句跟读' : '练这个词'],['remove','已巩固']]) {
      const button = node('button', 'button button-secondary', label);
      button.type = 'button';button.dataset.weakAction = action;button.dataset.word = record.word;
      button.setAttribute('aria-label', `${label}：${record.word}`);tools.append(button);
    }
    row.append(info, tools); return row;
  }));
}
function renderData() { renderPacks(); renderWeakWords(); }

function importFailure(error) {
  state.importCandidate = null;
  $('import-preview').hidden = true;
  $('import-error').textContent = errorMessage(error);
  $('import-error').hidden = false;
}
function previewImport(text) {
  try {
    const parsed = parseImport(text);
    state.importCandidate = parsed;
    $('import-error').hidden = true;
    $('import-preview').hidden = false;
    if (parsed.kind === 'course') {
      const { pack } = parsed;
      $('import-preview-title').textContent = pack.pack_name;
      $('import-preview-description').textContent = `课程包 · ${pack.version} · ${pack.modules.length} 个模块 · ${flatten(pack).length} 条内容`;
      $('import-preview-policy').textContent = state.packs.some(existing => existing.id === pack.id)
        ? '将更新相同标识的课程，保留仍匹配的学习项进度，移除不再对应的进度。'
        : '确认后把课程保存在本机。导入内容仅按文字显示，不执行其中的代码。';
    } else {
      const { backup } = parsed;
      $('import-preview-title').textContent = '学习备份';
      $('import-preview-description').textContent = `${backup.packs.length} 个课程包 · ${backup.progress.length} 条进度 · ${backup.weakWords.length} 个弱项词 · ${backup.vocabulary.length} 个生词`;
      $('import-preview-policy').textContent = '课程按备份更新，进度保留较新记录，弱项次数取较大值，设置也会恢复。' + (Object.hasOwn(backup, 'planner') ? backup.planner ? '每日计划、打卡与计划用时将替换为这份备份中的快照。' : '备份中的每日计划为空，恢复将清除本机计划并重新排课。' : '旧版备份不含每日计划，本机计划将保留。');
    }
  } catch (error) { importFailure(error); }
}
async function importFile(file) {
  const generation = ++state.importGeneration;
  if (!file) return;
  try {
    const text = await readFileText(file);
    if (generation === state.importGeneration) previewImport(text);
  } catch (error) { if (generation === state.importGeneration) importFailure(error); }
}
async function confirmImport() {
  if (!state.importCandidate || state.importing) return;
  const candidate = state.importCandidate;
  sampleStudyTime();state.importing = true;
  $('confirm-import').disabled = true;
  $('cancel-import').disabled = true;
  abortAudio();
  try {
    await flushStudyTime({ force: true });
    await queuePlannerWrite(() => candidate.kind === 'course' ? DB.putPack(candidate.pack) : DB.restoreBackup(candidate.backup));
    state.planSession = null;state.plannedWord = null;state.plannedPractice = null;state.plannedScenario = null;
    await reloadData(candidate.kind === 'course' ? candidate.pack.id : undefined);
    state.importCandidate = null;
    $('import-preview').hidden = true;
    $('import-file').value = '';
    $('import-text').value = '';
    $('import-error').hidden = true;
    toast(candidate.kind === 'course' ? '课程已保存到本机。' : '学习备份已合并到本机。');
  } catch (error) { importFailure(error); }
  finally { state.importing = false; $('confirm-import').disabled = false; $('cancel-import').disabled = false; }
}

async function reloadData(preferredId) {
  const [packs, progress, words, rate, voiceURI, theme, savedPack, vocabulary] = await Promise.all([
    DB.listPacks(), DB.listProgress(), DB.listWeakWords(), DB.getSetting('rate', DEFAULT_RATE),
    DB.getSetting('voiceURI', ''), DB.getSetting('theme', 'system'), DB.getSetting('preferredPack', ''),
    DB.listVocabulary(),
  ]);
  state.packs = packs;
  state.progress = new Map(progress.map(record => [key(record.packId, record.itemId), record]));
  state.weakWords = words;
  state.vocabulary = new Map(vocabulary.map(record => [record.word, record]));
  state.packId = [preferredId, savedPack, state.packId, packs.find(pack => pack.id === 'dayang-expanded-v1')?.id, packs[0]?.id].find(id => packs.some(pack => pack.id === id)) || '';
  state.rate = Number.isFinite(rate) ? Math.max(0.6, Math.min(1, rate)) : DEFAULT_RATE;
  state.voiceURI = typeof voiceURI === 'string' ? voiceURI : '';
  state.theme = ['system','light','dark'].includes(theme) ? theme : 'system';
  state.moduleId = 'all';state.index = 0;state.reveal = false;
  $('speech-rate').value = state.rate;
  $('rate-value').textContent = `${state.rate.toFixed(2)}×`;
  applyTheme();updateVoices();renderPackControls();renderSummary();renderLearn();renderData();renderVocabulary();resetScenario();
  setPracticeTarget(currentItem());
  if (state.packId) await DB.setSetting('preferredPack', state.packId);
  try { await refreshPlan({ force: true }); } catch (error) { showPlannerError(error); }
}

function updateOfflineStatus() {
  const ready = state.offlineReady;
  $('offline-status').classList.toggle('is-ready', ready);
  $('offline-status').textContent = ready
    ? navigator.onLine ? '离线资源已就绪' : '正在离线学习'
    : !window.isSecureContext ? '离线安装需要 HTTPS'
      : typeof navigator.serviceWorker?.register !== 'function' ? '当前浏览器不支持离线缓存'
        : navigator.onLine ? '离线资源正在准备' : '尚未确认离线缓存';
  $('planner-offline-status').textContent = $('offline-status').textContent;
  $('planner-offline-status').classList.toggle('is-ready', ready);
}
async function setupServiceWorker() {
  if (typeof navigator.serviceWorker?.register !== 'function' || !window.isSecureContext) { updateOfflineStatus();return; }
  try {
    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const waiting = () => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        state.waitingWorker = registration.waiting;
        $('update-banner').hidden = false;
      }
    };
    waiting();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed') waiting(); });
    });
    navigator.serviceWorker.ready.then(() => { state.offlineReady = true; updateOfflineStatus(); }).catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (state.updateRequested) window.location.reload();
      else { state.offlineReady = true; updateOfflineStatus(); }
    });
  } catch (error) {
    $('offline-status').textContent = '离线缓存未就绪，可继续在线学习';
    console.warn('离线缓存注册失败：', error);
  }
}

function wireEvents() {
  wireDictionary();
  wirePlanner();
  document.querySelectorAll('.bottom-nav [data-view]').forEach(button => {
    button.addEventListener('click', () => switchView(button.dataset.view));
    button.addEventListener('keydown', e => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault();
      const names = VIEW_NAMES;
      const index = names.indexOf(state.view);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? names.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length;
      switchView(names[next], false);$(`tab-${names[next]}`).focus();
    });
  });
  bind('pack-select','change',async e => {
    abortAudio();
    state.packId = e.target.value;state.moduleId = 'all';state.filter = 'all';state.index = 0;state.reveal = false;
    renderPackControls();renderSummary();renderLearn();setPracticeTarget(currentItem());resetScenario();
    await DB.setSetting('preferredPack', state.packId);
  });
  bind('module-filter','change',e => { abortAudio();state.moduleId = e.target.value;state.index = 0;state.reveal = false;renderLearn(); });
  bind('course-search','input',() => { state.index = 0;state.reveal = false;renderLearn(); });
  bind('status-filter','change',e => { abortAudio();state.filter = e.target.value;state.index = 0;state.reveal = false;renderLearn(); });
  bind('toggle-meaning','click',() => { state.reveal = !state.reveal;renderLearn(currentItem()?.id); });
  bind('speak-item','click',() => speakText(currentItem()?.en || ''));
  bind('speak-example','click',() => speakText(currentItem()?.example || ''));
  bind('stop-speech','click',() => TTS.cancel());
  bind('previous-item','click',() => moveItem(-1));bind('next-item','click',() => moveItem(1));bind('random-item','click',() => moveItem('random'));
  bind('mark-mastered','click',() => markItem('mastered'));bind('mark-review','click',() => markItem('review'));bind('mark-favorite','click',() => markItem('favorite'));
  const applyFilter = filter => { state.filter = filter;state.index = 0;state.reveal = false;$('status-filter').value = filter;renderLearn();switchView('learn'); };
  bind('summary-mastered','click',() => applyFilter('mastered'));bind('summary-review','click',() => applyFilter('review'));bind('summary-favorite','click',() => applyFilter('favorite'));
  bind('reset-filters','click',() => { state.moduleId = 'all';$('course-search').value = '';$('module-filter').value = 'all';applyFilter('all'); });
  bind('speech-rate','input',e => { state.rate = Number(e.target.value);$('rate-value').textContent = `${state.rate.toFixed(2)}×`; });
  bind('speech-rate','change',() => DB.setSetting('rate', state.rate));
  bind('voice-select','change',e => { state.voiceURI = e.target.value;return DB.setSetting('voiceURI', state.voiceURI); });
  bind('theme-select','change',e => { state.theme = e.target.value;applyTheme();return DB.setSetting('theme', state.theme); });
  mediaTheme.addEventListener?.('change', () => { if (state.theme === 'system') applyTheme(); });
  bind('practice-current','click',() => { setPracticeTarget(currentItem());switchView('practice'); });
  bind('use-learning-target','click',() => setPracticeTarget(currentItem()));
  bind('speak-target','click',() => speakText(state.practice?.en || ''));
  bind('start-practice','click',() => beginRecognition('practice'));
  bind('stop-practice','click',() => speech.stop());
  bind('compare-practice','click',evaluatePractice);
  bind('practice-input','input',() => {
    if (state.listeningFor === 'practice') abortAudio();
    $('practice-result').hidden = true;
    $('practice-status').textContent = '输入完成后，点击对比并保存练习。';
  });
  bind('clear-practice','click',() => { abortAudio();$('practice-input').value = '';$('practice-result').hidden = true;$('practice-status').textContent = '也可以直接输入英文练习'; });
  bind('go-weak-words','click',() => { switchView('data');$('weak-section').scrollIntoView({ block: 'start' }); });
  bind('scenario-select','change',resetScenario);
  document.querySelectorAll('input[name=scenario-mode]').forEach(input => input.addEventListener('change', e => {
    abortAudio();state.sceneMode = e.target.value;
    $('scenario-voice-tools').hidden = state.sceneMode === 'text';
    $('scenario-status').textContent = state.sceneMode === 'text' ? '文本模式：直接输入你的英文回答。' : '准备好后，点击语音回答。';
  }));
  bind('start-scenario','click',startScenario);bind('restart-scenario','click',startScenario);bind('repeat-scenario','click',startScenario);
  bind('change-scenario','click',resetScenario);
  bind('speak-client','click',() => speakText(state.scene?.turns[state.scene.index].prompt.en || ''));
  bind('start-scenario-voice','click',() => beginRecognition('scenario'));bind('stop-scenario-voice','click',() => speech.stop());
  bind('check-scenario','click',evaluateScenario);bind('show-scenario-reference','click',revealReference);bind('next-scenario','click',nextScenario);
  bind('scenario-input','input',() => {
    if (state.listeningFor === 'scenario') abortAudio();
    if (state.scene) state.scene.checked = false;
    $('scenario-feedback').hidden = true;
    $('scenario-status').textContent = '输入完成后，点击提交回答。';
    updateRecordingUI();
  });
  bind('speak-reference','click',() => speakText(state.scene?.turns[state.scene.index].reference || ''));
  bind('weak-search','input',() => { state.weakLimit = 40;renderWeakWords(); });
  bind('more-weak','click',() => { state.weakLimit += 40;renderWeakWords(); });
  bind('weak-list','click',async e => {
    const button = e.target.closest('button[data-weak-action]');if (!button) return;
    const record = state.weakWords.find(word => word.word === button.dataset.word);if (!record) return;
    if (button.dataset.weakAction === 'speak') { speakText(record.word);return; }
    if (button.dataset.weakAction === 'remove') {
      button.disabled = true;
      try { await DB.deleteWeakWord(record.word);state.weakWords = await DB.listWeakWords();renderWeakWords();toast('已从当前弱项词库移除，今后练习出错时仍会再记入。'); }
      finally { button.disabled = false; }
      return;
    }
    const context = record.contexts.find(item => item.target);
    let target = context?.packId ? flatten(state.packs.find(pack => pack.id === context.packId)).find(item => item.id === context.itemId) : null;
    if (!target) target = { en: context?.target || record.word, zh: '回到这个词所在的句子，再说一遍。', moduleName: '弱项回句练习' };
    setPracticeTarget(target);switchView('practice');
  });
  bind('export-backup','click',async () => {
    await flushStudyTime();
    const backup = await queuePlannerWrite(() => DB.exportBackup());downloadJSON(backup, `dayang-backup-${dateKey()}.json`);toast('已发起备份下载；iPhone可将文件存到“文件”App。');
  });
  bind('export-course','click',() => { if (currentPack()) downloadJSON(currentPack(), `${currentPack().pack_name}.json`); });
  bind('import-file','change',e => importFile(e.target.files[0]));
  bind('preview-pasted','click',() => { state.importGeneration += 1;previewImport($('import-text').value); });
  bind('cancel-import','click',() => { state.importGeneration += 1;state.importCandidate = null;$('import-preview').hidden = true;$('import-error').hidden = true;$('import-file').value = ''; });
  bind('confirm-import','click',confirmImport);
  bind('pack-list','click',async e => {
    const button = e.target.closest('button[data-remove-pack]');if (!button || state.packs.length <= 1) return;
    const pack = state.packs.find(p => p.id === button.dataset.removePack);if (!pack) return;
    if (!window.confirm(`移除“${pack.pack_name}”及它的进度、收藏？其他课程不受影响。建议先导出备份。`)) return;
    button.disabled = true;abortAudio();
    await DB.deletePack(pack.id);await reloadData();toast('课程及对应进度已移除。');
  });
  bind('install-help','click',() => { const d = $('help-dialog');if (typeof d.showModal === 'function') d.showModal();else d.setAttribute('open',''); });
  bind('close-help','click',() => { const d = $('help-dialog');if (typeof d.close === 'function') d.close();else d.removeAttribute('open'); });
  bind('update-app','click',() => {
    if (!state.waitingWorker) return;
    abortAudio();state.updateRequested = true;$('update-app').disabled = true;
    state.waitingWorker.postMessage({ type: 'SKIP_WAITING' });
  });
  window.addEventListener('online',updateOfflineStatus);window.addEventListener('offline',updateOfflineStatus);
  document.addEventListener('visibilitychange',() => { if (document.hidden) abortAudio(); });
  window.addEventListener('pagehide',abortAudio);
  bind('retry-boot','click',() => window.location.reload());
}

// Offline word lookup and personal vocabulary, independent of automatic weak words.
function normalizedWord(value) {
  return String(value).normalize('NFKC').replaceAll('’', "'").trim().toLowerCase();
}
function aliasesFor(value) {
  const parts = [value, ...String(value).split(/\s*\/\s*|;\s*/)];
  for (const part of [...parts]) {
    parts.push(part.replace(/\s*\([^)]*\)/g, '').trim());
    for (const match of part.matchAll(/\(([^)]+)\)/g)) parts.push(match[1]);
  }
  return [...new Set(parts.map(normalizedWord).filter(Boolean))];
}
function examplesFor(item) {
  if (!item) return [];
  if (item.examples?.length) return item.examples;
  for (const alias of aliasesFor(item.en)) {
    const record = state.expanded.get(alias);
    if (record) return record.examples;
  }
  return item.example ? [{ en: item.example, zh: item.example_zh || '' }] : [];
}
function lookupSentence(element, text) {
  const pattern = /[A-Za-z][A-Za-z0-9]*(?:['’\-][A-Za-z0-9]+)*/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    element.append(document.createTextNode(text.slice(position, match.index)));
    const button = node('button', 'lookup-word', match[0]);
    button.type = 'button';
    button.dataset.lookupWord = normalizedWord(match[0]);
    button.setAttribute('aria-label', `查词：${match[0]}`);
    button.setAttribute('aria-haspopup', 'dialog');
    element.append(button);
    position = match.index + match[0].length;
  }
  element.append(document.createTextNode(text.slice(position)));
}
function renderExamples(item) {
  $('examples-list').replaceChildren(...examplesFor(item).map((example, index) => {
    const article = node('article', 'expanded-example');
    article.append(node('p', 'example-level', `例句 ${index + 1} · ${index < 2 ? '基础' : index < 4 ? '进阶' : '商务长句'}`));
    const english = node('p', 'lookup-sentence');
    english.lang = 'en-US';lookupSentence(english, example.en);
    article.append(english, node('p', 'example-translation', example.zh));
    const tools = node('div', 'action-line');
    for (const [action, label] of [['speak', '🔊 朗读例句'], ['practice', '跟读这句']]) {
      const button = node('button', 'button button-secondary', label);
      button.type = 'button';button.dataset.exampleAction = action;button.dataset.exampleIndex = index;
      tools.append(button);
    }
    article.append(tools);return article;
  }));
}
function dictionaryEntry(word) {
  const key = normalizedWord(word);
  const exact = state.dictionary.get(key);
  if (exact) return { word: key, ...exact };
  // An imported course may contain words beyond the shipped offline dictionary.
  return { word: key, zh: '本地词典暂未收录，可先收藏并结合例句复习。', phonetic: '' };
}
function closeLookup(returnFocus = false) {
  const anchor = state.lookup?.anchor;
  state.lookup = null;
  $('lookup-popover').hidden = true;
  if (returnFocus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}
function positionLookup() {
  if (!state.lookup) return;
  const popover = $('lookup-popover');
  const bounds = state.lookup.anchor.getBoundingClientRect();
  const left = Math.max(12, Math.min(bounds.left, document.documentElement.clientWidth - popover.offsetWidth - 12));
  let top = bounds.bottom + 8;
  if (top + popover.offsetHeight > window.innerHeight - 12) top = bounds.top - popover.offsetHeight - 8;
  top = Math.max(12, Math.min(top, window.innerHeight - popover.offsetHeight - 12));
  popover.style.left = `${left}px`;popover.style.top = `${top}px`;
}
function openLookup(anchor) {
  const entry = dictionaryEntry(anchor.dataset.lookupWord);
  const context = anchor.closest('.lookup-sentence')?.textContent || '';
  state.lookup = { entry, context, anchor };
  $('lookup-title').textContent = entry.word;
  $('lookup-phonetic').textContent = entry.phonetic || '音标暂未收录';
  $('lookup-definition').textContent = entry.zh;
  $('lookup-base').textContent = entry.lemma ? `原形：${entry.lemma}（释义与音标按原形显示）` : '';
  const saved = state.vocabulary.has(entry.word);
  $('lookup-save').textContent = saved ? '⭐ 已收藏' : '⭐ 收藏到生词本';
  $('lookup-save').disabled = saved;
  $('lookup-popover').hidden = false;positionLookup();
  $('lookup-close').focus({ preventScroll: true });
}
async function collectWord(entry, context, haptic = false) {
  const meaning = entry.lemma ? `原形：${entry.lemma}（释义与音标按原形显示）。${entry.zh}` : entry.zh;
  const record = await DB.saveVocabulary({ word: entry.word, zh: meaning, phonetic: entry.phonetic || '', context: context.slice(0, 4000) });
  state.vocabulary.set(record.word, record);
  if (haptic) {
    try { navigator.vibrate?.(25); } catch { /* Unsupported haptics still show a saved confirmation. */ }
  }
  if (state.lookup?.entry.word === record.word) {
    $('lookup-save').textContent = '⭐ 已收藏';$('lookup-save').disabled = true;
  }
  if (state.view === 'vocabulary') renderVocabulary();
  toast(`“${record.word}”已收藏到生词本。`);
}
function renderVocabulary() {
  const query = normalizedWord($('vocab-search').value);
  const filter = $('vocab-filter').value;
  const all = [...state.vocabulary.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('vocab-count').textContent = `${all.length} 个生词 · ${all.filter(record => record.mastered).length} 个已熟悉`;
  const matches = all.filter(record => (!query || `${record.word} ${record.zh}`.toLowerCase().includes(query)) && (filter === 'all' || record.mastered === (filter === 'mastered')));
  $('vocab-more').hidden = matches.length <= state.vocabLimit;
  if (!matches.length) {
    $('vocab-list').replaceChildren(node('p', 'empty-state', query || filter !== 'all' ? '当前范围没有生词，试试其他筛选。' : '点击例句中的英文单词，再点收藏；长按500毫秒也可以直接加入。'));
    return;
  }
  $('vocab-list').replaceChildren(...matches.slice(0, state.vocabLimit).map(record => {
    const card = node('article', 'vocab-card');
    card.append(node('h3', '', record.word), node('p', 'phonetic', record.phonetic || '音标暂未收录'));
    const meaning = node('details', 'vocab-meaning');
    meaning.append(node('summary', '', '展开释义与原句'), node('p', '', record.zh));
    if (record.context) {
      const context = node('p', 'lookup-sentence');context.lang = 'en-US';lookupSentence(context, record.context);meaning.append(context);
    }
    card.append(meaning);
    const tools = node('div', 'action-line');
    for (const [action, label] of [['speak', '🔊 发音'], ['practice', '跟读复习'], ['mastered', record.mastered ? '改为待复习' : '✅ 已熟悉'], ['remove', '移出生词本']]) {
      const button = node('button', 'button button-secondary', label);
      button.type = 'button';button.dataset.vocabAction = action;button.dataset.vocabWord = record.word;
      if (action === 'mastered') button.setAttribute('aria-pressed', String(record.mastered));
      tools.append(button);
    }
    card.append(tools);return card;
  }));
}
function wireDictionary() {
  let press = null;
  let suppressed = null;
  const cancelPress = () => { if (press) clearTimeout(press.timer);press = null; };
  cancelLookupPress = cancelPress;
  document.addEventListener('pointerdown', event => {
    cancelPress();
    suppressed = null;
    if (!event.target.closest('#lookup-popover') && !event.target.closest('.lookup-word')) closeLookup();
    const anchor = event.target.closest('.lookup-word');
    if (!anchor || event.button !== 0 || !event.isPrimary) return;
    const current = { anchor, id: event.pointerId, x: event.clientX, y: event.clientY };
    current.timer = setTimeout(() => {
      if (press !== current || !anchor.isConnected) return;
      // Consume the release click even when a finger stays down for several seconds.
      suppressed = { anchor };
      closeLookup();
      collectWord(dictionaryEntry(anchor.dataset.lookupWord), anchor.closest('.lookup-sentence')?.textContent || '', true).catch(report);
    }, 500);
    press = current;
  });
  document.addEventListener('pointermove', event => {
    if (press && event.pointerId === press.id && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
  });
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  document.addEventListener('contextmenu', event => { if (event.target.closest('.lookup-word')) event.preventDefault(); });
  document.addEventListener('click', event => {
    const anchor = event.target.closest('.lookup-word');
    if (anchor) {
      if (suppressed?.anchor === anchor) { suppressed = null;return; }
      openLookup(anchor);
    } else if (!event.target.closest('#lookup-popover')) closeLookup();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { cancelPress();closeLookup(true); } });
  window.addEventListener('resize', () => { cancelPress();closeLookup(); });
  window.addEventListener('scroll', event => {
    if (!$('lookup-popover').contains(event.target)) { cancelPress();closeLookup(); }
  }, true);
  document.addEventListener('visibilitychange', () => { if (document.hidden) { cancelPress();closeLookup(); } });
  bind('lookup-close', 'click', () => closeLookup(true));
  bind('lookup-speak', 'click', () => { if (state.lookup) speakText(state.lookup.entry.word); });
  bind('lookup-save', 'click', async () => {
    if (!state.lookup) return;
    const { entry, context } = state.lookup;
    $('lookup-save').disabled = true;
    try { await collectWord(entry, context); }
    finally { if (state.lookup?.entry.word === entry.word) $('lookup-save').disabled = state.vocabulary.has(entry.word); }
  });
  bind('examples-list', 'click', event => {
    const button = event.target.closest('button[data-example-action]');if (!button) return;
    const item = currentItem(), example = examplesFor(item)[Number(button.dataset.exampleIndex)];if (!example) return;
    if (button.dataset.exampleAction === 'speak') speakText(example.en);
    else { setPracticeTarget({ ...item, en: example.en, zh: example.zh });switchView('practice'); }
  });
  bind('vocab-search', 'input', () => { state.vocabLimit = 40;renderVocabulary(); });
  bind('vocab-filter', 'change', () => { state.vocabLimit = 40;renderVocabulary(); });
  bind('vocab-more', 'click', () => { state.vocabLimit += 40;renderVocabulary(); });
  bind('vocab-list', 'click', async event => {
    const button = event.target.closest('button[data-vocab-action]');if (!button) return;
    const record = state.vocabulary.get(button.dataset.vocabWord);if (!record) return;
    if (button.dataset.vocabAction === 'speak') return speakText(record.word);
    if (button.dataset.vocabAction === 'practice') {
      setPracticeTarget({ en: record.word, zh: record.zh, moduleName: '生词本复习' });switchView('practice');return;
    }
    button.disabled = true;
    try {
      if (button.dataset.vocabAction === 'mastered') {
        const saved = await DB.patchVocabulary(record.word, { mastered: !record.mastered });state.vocabulary.set(saved.word, saved);
      } else { await DB.deleteVocabulary(record.word);state.vocabulary.delete(record.word); }
      closeLookup();renderVocabulary();
    } finally { button.disabled = false; }
  });
}

async function loadExpandedContent() {
  const results = await Promise.allSettled([
    fetch('./courses_expanded.json').then(async response => { if (!response.ok) throw new Error('扩充课程未能加载');return response.json(); }),
    fetch('./lexicon.json').then(async response => { if (!response.ok) throw new Error('离线词典未能加载');return response.json(); }),
  ]);
  if (results[0].status === 'fulfilled') {
    try {
      const expanded = expandedToPack(results[0].value);
      for (const record of results[0].value) for (const alias of aliasesFor(record.word)) if (!state.expanded.has(alias)) state.expanded.set(alias, record);
      const existing = await DB.getPack(expanded.id);
      if (!existing || existing.version !== expanded.version) await DB.putPack(expanded);
      state.expandedAdded = !existing;
    } catch (error) { state.expandedError = errorMessage(error); }
  } else state.expandedError = '扩充例句未加载，请联网刷新后重试。';
  if (results[1].status === 'fulfilled') {
    const entries = results[1].value?.entries;
    if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const [word, record] of Object.entries(entries)) {
        if (/^[a-z0-9]+(?:['\-][a-z0-9]+)*$/.test(word) && typeof record.zh === 'string' && typeof record.phonetic === 'string') state.dictionary.set(word, record);
      }
    }
  }
}

// Daily planning uses one atomic IndexedDB snapshot. UI actions are serialized so
// a late timer write cannot redraw an older task state over a completed one.
let plannerWrites = Promise.resolve();
let lastCelebration = '';
const PLAN_LISTS = { new: 'newWords', review: 'reviews', sentence: 'sentences' };
const PLAN_LABELS = { new: '新词学习', review: '间隔复习', sentence: '短句跟读', scenario: '情景模拟' };

function showPlannerError(error) {
  $('planner-error').hidden = false;
  $('planner-error').textContent = `今日计划暂未更新：${errorMessage(error)}。可点击“刷新计划”重试，自由学习仍可使用。`;
  if (!state.plan) $('start-today').disabled = true;
}
function queuePlannerWrite(action) {
  const pending = plannerWrites.catch(() => {}).then(action);
  plannerWrites = pending;
  return pending;
}
function queuePlanner(action, { statsOnly = false } = {}) {
  const pending = queuePlannerWrite(async () => {
    const previousDate = state.plan?.date;
    const view = await action();
    state.plan = view;state.plannerReady = true;
    $('planner-error').hidden = !view.notice;
    if (view.notice) $('planner-error').textContent = view.notice;
    if (statsOnly && previousDate === view.date) renderPlannerStats();
    else renderPlanner();
    if (view.completion.shouldCelebrate && !view.clockBack && lastCelebration !== view.date) {
      lastCelebration = view.date;
      const panel = $('planner-celebration');
      panel.classList.add('is-celebrating');
      queuePlanner(() => planner.acknowledgeCelebration(view.date), { statsOnly: true }).catch(showPlannerError);
    }
    return view;
  });
  return pending.catch(error => { showPlannerError(error);throw error; });
}
function refreshPlan({ force = false } = {}) {
  if (state.importing && !force) return Promise.resolve(state.plan);
  return queuePlanner(() => planner.refresh(state.packs, [...state.progress.values()]));
}
function allPlanTasks() {
  if (!state.plan) return [];
  const tasks = state.plan.tasks;
  return [
    ...tasks.reviews.map(task => ({ ...task, kind: 'review' })),
    ...tasks.newWords.map(task => ({ ...task, kind: 'new' })),
    ...tasks.sentences.map(task => ({ ...task, kind: 'sentence' })),
    ...(tasks.scenario ? [{ ...tasks.scenario, kind: 'scenario' }] : []),
  ];
}
function planTask(kind, taskKey) { return allPlanTasks().find(task => task.kind === kind && task.key === taskKey); }
function readableDate(value, weekday = false) {
  if (!value) return '暂无日期';
  return new Date(`${value}T12:00:00`).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', ...(weekday ? { weekday: 'long' } : {}) });
}
function durationText(seconds) {
  if (!seconds) return '0 分钟';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分`;
}
function renderPlannerStats() {
  const plan = state.plan;if (!plan) return;
  $('planner-streak').textContent = `连续 ${plan.stats.streak} 天`;
  $('planner-study-days').textContent = `${plan.stats.studyDays} 天`;
  $('planner-mastered').textContent = `${plan.stats.mastered} 个`;
  $('planner-week-time').textContent = durationText(plan.stats.weekSeconds);
  $('planner-learned').textContent = `${plan.stats.learned} / ${plan.stats.totalVocabulary} 个`;
  $('planner-finish-date').textContent = plan.stats.estimatedFinishDate ? readableDate(plan.stats.estimatedFinishDate) : plan.stats.totalVocabulary ? '当前规模下暂无法估算' : '先导入含词汇的课程';
  $('planner-estimate-note').textContent = plan.stats.estimatedNewDate
    ? `按每天${plan.dailyNew}个新词、如期完成复习估算；新词预计${readableDate(plan.stats.estimatedNewDate)}学完。短句和情景可持续训练，计划会随进度调整。`
    : '计划会自动汇总本机已装入的课程；新词去重，例句用作跟读。';
}
function renderAgenda(kind, tasks) {
  const list = $(`agenda-${kind}-list`);
  $(`agenda-${kind}-count`).textContent = `${tasks.filter(task => task.done).length} / ${tasks.length}`;
  if (!tasks.length) {
    list.replaceChildren(node('p', 'agenda-empty', kind === 'review' ? '今天没有到期复习。新学的词会从次日开始安排。' : kind === 'scenario' ? '今天先把词汇和短句练好。' : kind === 'new' ? '当前课程的新词已安排完，可继续复习或导入课程。' : '当前没有可安排的短句，可先学习词汇。'));
    return;
  }
  list.replaceChildren(...tasks.map(task => {
    const row = node('article', `agenda-row${task.done ? ' is-done' : ''}`);
    row.dataset.planKey = task.key;
    const title = node('h4', '', `${task.done ? '✓ ' : ''}${kind === 'scenario' ? task.title : task.en}`);
    if (kind !== 'scenario') title.lang = 'en-US';
    const source = state.packs.find(pack => pack.id === task.packId);
    row.append(title, node('p', 'supporting-text', kind === 'scenario' ? `完成一次${sceneInfo[task.scene]?.title || '客户沟通'} · ${task.rounds}轮` : `${source?.pack_name || ''} · ${task.moduleName || ''}${kind === 'review' ? ` · 第${task.repetition}次复习` : ''}`));
    const tools = node('div', 'action-line');
    const actions = kind === 'scenario' ? [['open', task.done ? '再练一次' : '开始对练']] : [['speak', '🔊 发音'], ['open', kind === 'sentence' ? '去跟读' : '展开学习']];
    actions.push(['complete', task.done ? '✓ 已完成' : '✅ 完成']);
    for (const [action, label] of actions) {
      const button = node('button', 'button button-secondary', label);
      button.type = 'button';button.dataset.planAction = action;button.dataset.planKind = kind;button.dataset.planKey = task.key;button.dataset.planDate = state.plan.date;
      button.setAttribute('aria-label', `${label}：${kind === 'scenario' ? task.title : task.en}`);
      if (action === 'complete') button.disabled = task.done || state.plan.clockBack;
      tools.append(button);
    }
    row.append(tools);return row;
  }));
}
function renderPlanner() {
  const plan = state.plan;if (!plan) return;
  $('planner-date').textContent = readableDate(plan.date, true);
  $('planner-percent').textContent = `${plan.completion.percent}%`;
  $('planner-progress').value = plan.completion.percent;
  $('planner-progress').textContent = `${plan.completion.percent}%`;
  $('planner-progress-text').textContent = `已完成 ${plan.completion.done} / ${plan.completion.total} 项${plan.weekend ? ' · 周末轻松日' : ''}`;
  $('planner-new-count').textContent = plan.tasks.newWords.length;
  $('planner-review-count').textContent = plan.tasks.reviews.length;
  $('planner-sentence-count').textContent = plan.tasks.sentences.length;
  $('planner-scene-count').textContent = plan.tasks.scenario ? '1 场' : '休息日';
  $('planner-new-detail').textContent = `还剩${plan.remaining.newWords}个 · 每日目标${plan.dailyNew}个`;
  $('planner-review-detail').textContent = `还剩${plan.remaining.reviews}个 · 今日最多${plan.review.limit}个`;
  $('planner-scene-detail').textContent = plan.tasks.scenario ? sceneInfo[plan.tasks.scenario.scene]?.title || '客户情景练习' : plan.nextScenarioDate ? `下次：${readableDate(plan.nextScenarioDate)}` : '可导入含情景的课程';
  const start = $('start-today');start.disabled = plan.clockBack || !plan.completion.total;
  start.replaceChildren(document.createTextNode(plan.completion.allDone ? '今日已完成 · 自由学习' : plan.completion.done ? '继续今日学习' : '开始今日学习'), node('span', '', '→'));
  $('planner-carry-note').textContent = plan.review.deferred ? `另有${plan.review.deferred}个到期词顺延，明天会优先安排。未完成任务会自动接续。` : '复习先行，再学新词；没完成的任务，下次打开会接着安排。';
  $('agenda-review-note').textContent = `新学后第1、2、4、7、15、30天复习；今天上限${plan.review.limit}个${plan.weekend ? '，周末减半取整' : ''}。`;
  $('agenda-scenario-note').textContent = plan.tasks.scenario ? `本次安排：${sceneInfo[plan.tasks.scenario.scene]?.title || '客户沟通'}。周二、周四、周六安排，漏练时优先接续一场。` : plan.nextScenarioDate ? `下一次安排在${readableDate(plan.nextScenarioDate, true)}。` : '导入含展会、谈判或客诉情景的课程后，会自动安排。';
  renderAgenda('review', plan.tasks.reviews);renderAgenda('new', plan.tasks.newWords);renderAgenda('sentence', plan.tasks.sentences);renderAgenda('scenario', plan.tasks.scenario ? [plan.tasks.scenario] : []);
  $('planner-daily-new').value = String(plan.dailyNew);
  $('planner-celebration').hidden = !plan.completion.allDone;
  if (!plan.completion.allDone) $('planner-celebration').classList.remove('is-celebrating');
  $('planner-encouragement').textContent = ['今天的积累，会让下一次客户沟通更从容。', '认真练完一小步，表达就更熟练一点。', '练习已经留下记录，明天继续把句子说顺。'][plan.stats.studyDays % 3];
  renderPlannerStats();renderPlanSession();
}
function renderPlanSession() {
  const context = state.planSession;
  const task = context && context.date === state.plan?.date ? planTask(context.kind, context.key) : null;
  $('today-session').hidden = !task;
  if (!task) { state.planSession = null;return; }
  $('today-session-type').textContent = PLAN_LABELS[context.kind];
  $('today-session-title').textContent = context.kind === 'scenario' ? task.title : task.en;
  $('today-session-source').textContent = context.kind === 'scenario' ? `${task.rounds}轮 · 可语音回答或用文本模式` : `${task.moduleName || ''}${context.kind === 'review' ? ` · 第${task.repetition}次复习` : ''}`;
  $('today-session-zh').textContent = context.kind === 'scenario' ? '进入对练页，完成整段客户问答；也可以在实际练习后自行标记完成。' : task.zh;
  $('today-session-speak').hidden = context.kind === 'scenario';
  $('today-session-open').textContent = context.kind === 'scenario' ? '开始对练' : context.kind === 'sentence' ? '去跟读' : '展开学习';
  $('today-session-complete').disabled = task.done || state.plan.clockBack;
}
function startTodaySession() {
  if (state.plan?.completion.allDone) { switchView('learn');return; }
  const task = allPlanTasks().find(task => !task.done);
  if (!task) return toast('今天暂无待做任务，可先导入课程或自由学习。');
  state.planSession = { kind: task.kind, key: task.key, date: state.plan.date };
  $('today-session-meaning').open = false;
  renderPlanSession();$('today-session').scrollIntoView({ block: 'start', behavior: 'auto' });$('today-session-open').focus({ preventScroll: true });
}
async function completePlannedTask(kind, taskKey, scheduledDate = state.plan?.date) {
  if (state.importing) throw new Error('正在导入资料，请等待完成后再记录任务');
  if (scheduledDate !== dateKey()) { await refreshPlan();throw new Error('日期已变化，已刷新今天的任务，请重新选择'); }
  const task = planTask(kind, taskKey);
  if (!task) { await refreshPlan();throw new Error('任务或课程已变化，请重新选择'); }
  const result = await queuePlanner(() => planner.complete(kind, taskKey, scheduledDate));
  if ((kind === 'new' || kind === 'review') && task.packId && task.itemId) {
    try {
      const existing = await DB.getProgress(task.packId, task.itemId);
      const learned = planner.snapshot?.learned[taskKey];
      const record = await DB.saveProgress(task.packId, task.itemId, { status: existing?.status === 'mastered' || learned?.mastered ? 'mastered' : 'review' });
      state.progress.set(key(task.packId, task.itemId), record);renderSummary();renderLearn(currentItem()?.id);
    } catch (error) { toast(`计划完成情况已保存，学习卡标记未同步：${errorMessage(error)}`); }
  }
  return result;
}
async function openPlannedTask(kind, taskKey) {
  if (state.importing) throw new Error('正在导入资料，请等待完成后再进入任务');
  const task = planTask(kind, taskKey);if (!task) throw new Error('任务已变化，请刷新今日任务');
  const context = { ...task, kind, date: state.plan.date };
  if (kind === 'scenario') {
    state.packId = task.packId;renderPackControls();renderSummary();
    $('scenario-select').value = task.scene;resetScenario();state.plannedScenario = context;
    $('planner-scenario-link').hidden = false;switchView('scenario');startScenario();
  } else if (kind === 'sentence') {
    const pack = state.packs.find(candidate => candidate.id === task.packId);
    const original = flatten(pack).find(item => item.id === task.itemId);
    setPracticeTarget({ ...original, en: task.en, zh: task.zh, id: task.itemId, packId: task.packId, moduleName: task.moduleName });
    state.plannedPractice = context;$('planner-practice-link').hidden = false;
    $('planner-practice-note').textContent = '这是今日安排的短句。听读并练习后，点击完成即可计入今日任务。';switchView('practice');
  } else {
    state.packId = task.packId;state.moduleId = 'all';state.filter = 'all';state.index = 0;state.reveal = true;
    $('course-search').value = '';renderPackControls();renderSummary();renderLearn(task.itemId);
    state.plannedWord = context;$('planner-word-link').hidden = false;
    $('planner-word-note').textContent = `${PLAN_LABELS[kind]}：${task.en}。完成后返回今日任务，${kind === 'new' ? '系统会自动安排后续复习。' : '记录本次复习。'}`;
    switchView('learn');await DB.setSetting('preferredPack', state.packId);
  }
}
async function completeAndReturn(context) {
  if (!context) return;
  await completePlannedTask(context.kind, context.key, context.date);
  state.plannedPractice = null;state.plannedWord = null;$('planner-practice-link').hidden = true;$('planner-word-link').hidden = true;
  switchView('today');
  if (!state.plan?.completion.allDone) startTodaySession();
}

// Time accrues only in a visible study view after user activity. Sleeping tabs
// cannot turn a throttled timer into hours of study; date splits use local midnight.
const studyClock = { ready: false, visible: !document.hidden, lastSample: Date.now(), lastActivity: 0, pending: new Map() };
const STUDY_VIEWS = new Set(['today', 'learn', 'practice', 'scenario', 'vocabulary']);
function sampleStudyTime(now = Date.now()) {
  const start = studyClock.lastSample;studyClock.lastSample = now;
  if (now < start) { studyClock.lastActivity = 0;return; }
  if (!studyClock.ready || !studyClock.visible || !STUDY_VIEWS.has(state.view) || state.importing || !state.plannerReady || state.plan?.clockBack || now - start > 20000) return;
  let cursor = start, end = Math.min(now, studyClock.lastActivity + 90000);
  while (cursor < end) {
    const date = new Date(cursor), next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
    const limit = Math.min(end, next), day = dateKey(date);
    studyClock.pending.set(day, (studyClock.pending.get(day) || 0) + (limit - cursor) / 1000);cursor = limit;
  }
}
async function flushStudyTime({ force = false } = {}) {
  if (state.importing && !force) return;
  sampleStudyTime();
  const records = [];
  for (const [date, amount] of studyClock.pending) {
    const seconds = Math.floor(amount);
    if (!seconds) continue;
    studyClock.pending.set(date, amount - seconds);
    for (let remaining = seconds; remaining > 0; remaining -= 300) records.push({ date, seconds: Math.min(300, remaining) });
  }
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    try { await queuePlanner(() => planner.recordTime(record.seconds, record.date), { statsOnly: true }); }
    catch (error) {
      for (const pending of records.slice(index)) studyClock.pending.set(pending.date, (studyClock.pending.get(pending.date) || 0) + pending.seconds);
      throw error;
    }
  }
}
function wirePlanner() {
  bind('start-today', 'click', startTodaySession);
  bind('refresh-today', 'click', refreshPlan);
  bind('close-today-session', 'click', () => { state.planSession = null;renderPlanSession(); });
  bind('today-session-speak', 'click', () => { const c = state.planSession, t = c && planTask(c.kind, c.key);if (t) speakText(t.en); });
  bind('today-session-open', 'click', () => { const c = state.planSession;return c && openPlannedTask(c.kind, c.key); });
  bind('today-session-complete', 'click', async () => {
    const context = state.planSession;if (!context) return;
    $('today-session-complete').disabled = true;
    try {
      await completePlannedTask(context.kind, context.key, context.date);
      if (state.plan?.completion.allDone) { state.planSession = null;$('planner-celebration').scrollIntoView({ block: 'center' }); }
      else startTodaySession();
    }
    finally { renderPlanSession(); }
  });
  bind('panel-today', 'click', event => {
    const button = event.target.closest('button[data-plan-action]');if (!button) return;
    const { planAction: action, planKind: kind, planKey: taskKey, planDate: scheduledDate } = button.dataset;
    const task = planTask(kind, taskKey);if (!task) return;
    if (action === 'speak') return speakText(task.en);
    if (action === 'open') return openPlannedTask(kind, taskKey);
    button.disabled = true;
    return completePlannedTask(kind, taskKey, scheduledDate).finally(() => { if (button.isConnected) button.disabled = Boolean(planTask(kind, taskKey)?.done); });
  });
  bind('complete-planned-word', 'click', () => completeAndReturn(state.plannedWord));
  bind('complete-planned-sentence', 'click', () => completeAndReturn(state.plannedPractice));
  bind('back-to-today', 'click', () => switchView('today'));
  bind('planner-free-study', 'click', () => switchView('learn'));
  bind('planner-daily-new', 'change', async event => {
    if (state.importing) { event.target.value = String(state.plan.dailyNew);throw new Error('导入完成后可调整学习计划'); }
    const amount = Number(event.target.value);event.target.disabled = true;
    try { await queuePlanner(() => planner.setDailyNew(amount));toast(`每天安排${amount}个新词，已完成的任务保留。`); }
    finally { event.target.disabled = false; }
  });
  bind('reset-planner', 'click', async () => {
    if (state.importing) throw new Error('导入完成后可重置学习计划');
    if (!window.confirm('从今天重新开始每日计划？计划、打卡与计划用时会重置。原有课程、掌握标记、收藏和生词本保留。建议先导出备份。')) return;
    $('reset-planner').disabled = true;
    try {
      await flushStudyTime();state.planSession = null;state.plannedWord = null;state.plannedPractice = null;state.plannedScenario = null;lastCelebration = '';
      $('planner-word-link').hidden = true;$('planner-practice-link').hidden = true;$('planner-scenario-link').hidden = true;
      await queuePlanner(() => planner.reset());studyClock.pending.clear();studyClock.lastActivity = 0;studyClock.lastSample = Date.now();toast('计划已从今天重新开始，原有课程和词本保留。');
    } finally { $('reset-planner').disabled = false; }
  });
  const activity = () => { sampleStudyTime();if (studyClock.ready && STUDY_VIEWS.has(state.view)) studyClock.lastActivity = Date.now(); };
  document.addEventListener('pointerdown', activity, { passive: true });document.addEventListener('keydown', activity);document.addEventListener('input', activity, { passive: true });
  window.addEventListener('scroll', activity, { passive: true });
  document.addEventListener('visibilitychange', () => {
    sampleStudyTime();studyClock.visible = !document.hidden;
    if (document.hidden) { studyClock.lastActivity = 0;flushStudyTime().catch(showPlannerError); }
    else if (state.plannerReady && !state.importing) refreshPlan().catch(showPlannerError);
  });
  window.addEventListener('pagehide', () => { sampleStudyTime();studyClock.lastActivity = 0;flushStudyTime().catch(() => {}); });
  window.addEventListener('focus', () => { if (state.plannerReady && !state.importing) refreshPlan().catch(showPlannerError); });
  setInterval(() => {
    sampleStudyTime();
    if (studyClock.ready && state.plan && state.plan.date !== dateKey() && !document.hidden && !state.importing) refreshPlan().catch(showPlannerError);
  }, 5000);
  setInterval(() => { if (state.plannerReady) flushStudyTime().catch(showPlannerError); }, 15000);
}

async function boot() {
  wireEvents();
  TTS.subscribeVoices(updateVoices);
  $('recognition-support').textContent = speech.supported
    ? '英语识别由浏览器或系统提供，可能需要联网。只有点击开始时才申请麦克风。'
    : '此浏览器或当前地址暂不支持语音识别。直接输入英文，仍可对比并保存练习。';
  try {
    await DB.init();
    let packs = await DB.listPacks();
    try {
      const response = await fetch('./demo.json');
      if (!response.ok) throw new Error(`课程文件HTTP ${response.status}`);
      state.demo = validatePack(await response.json());
    } catch (error) {
      if (!packs.length) throw new Error(`内置课程尚未加载，请联网完整打开一次。${errorMessage(error)}`);
    }
    if (!packs.length && state.demo) { await DB.putPack(state.demo);packs = [state.demo]; }
    await loadExpandedContent();
    await reloadData(state.expandedAdded && packs.length === 1 && packs[0].id === state.demo?.id ? 'dayang-expanded-v1' : undefined);
    $('boot-screen').hidden = true;
    $('app-content').hidden = false;
    switchView('today', false);
    studyClock.ready = true;
    studyClock.lastSample = Date.now();
    updateRecordingUI();
    updateOfflineStatus();
    setupServiceWorker();
    if (state.expandedError) toast(state.expandedError);
  } catch (error) {
    $('boot-screen').hidden = true;$('fatal-screen').hidden = false;
    $('fatal-message').textContent = errorMessage(error);
  }
}

boot();
