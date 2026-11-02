/**
 * Local English speech synthesis only. Call speak() directly from a click/tap
 * handler: do not await anything before calling it on iOS.
 *
 * https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesisVoice/localService
 * https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis/voiceschanged_event
 * https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/speech/SpeechSynthesis.cpp
 */

const voiceSubscribers = new Set();
let observedSynthesis = null;
let voiceChangeListener = null;
let currentUtterance = null;

function callSafely(callback, ...args) {
  if (typeof callback !== 'function') return;
  try {
    callback(...args);
  } catch {
    // A UI callback must not interrupt native speech cleanup.
  }
}

function synthesis() {
  try {
    return globalThis.speechSynthesis || null;
  } catch {
    return null;
  }
}

function isSupported() {
  const synth = synthesis();
  return Boolean(
    synth &&
      typeof synth.speak === 'function' &&
      typeof synth.getVoices === 'function' &&
      typeof globalThis.SpeechSynthesisUtterance === 'function',
  );
}

function voicePriority(voice) {
  const language = String(voice.lang || '').replaceAll('_', '-').toLowerCase();
  const name = String(voice.name || '');
  // American English takes priority over higher-quality voices of other locales.
  let priority = /^en-us(?:-|$)/.test(language) ? 1000 : 0;
  if (/premium/i.test(name)) priority += 80;
  if (/enhanced/i.test(name)) priority += 70;
  if (/neural/i.test(name)) priority += 60;
  if (/natural/i.test(name)) priority += 50;
  if (voice.default === true) priority += 1;
  return priority;
}

function localEnglishVoices() {
  if (!isSupported()) return [];
  try {
    return Array.from(synthesis().getVoices())
      .filter(
        (voice) =>
          voice.localService === true &&
          /^en(?:[-_]|$)/i.test(String(voice.lang || '')),
      )
      .sort(
        (a, b) =>
          voicePriority(b) - voicePriority(a) ||
          String(a.name).localeCompare(String(b.name), 'en'),
      );
  } catch {
    return [];
  }
}

function observeVoiceChanges() {
  const synth = synthesis();
  if (!synth || synth === observedSynthesis) return;
  if (observedSynthesis && voiceChangeListener) {
    observedSynthesis.removeEventListener?.('voiceschanged', voiceChangeListener);
  }
  observedSynthesis = synth;
  voiceChangeListener = () => {
    const voices = localEnglishVoices();
    for (const subscriber of voiceSubscribers) callSafely(subscriber, voices);
    // Loading a voice never starts playback. The user must click speak again.
  };
  synth.addEventListener?.('voiceschanged', voiceChangeListener);
}

function speechErrorMessage(code) {
  const messages = {
    'not-allowed': '浏览器尚未允许朗读，请直接点击朗读按钮后重试。',
    'audio-busy': '音频设备正在使用中，请结束录音或其他音频后再次点击朗读。',
    'audio-hardware': '暂时无法使用音频输出，请检查设备音量和音频设备。',
    'voice-unavailable': '所选本地语音暂不可用，请安装系统英语语音后再次点击朗读。',
    'language-unavailable': '系统英语语音暂不可用，请在系统语音设置中安装英语语音。',
    'synthesis-unavailable': '系统朗读服务暂不可用，请稍后再次点击朗读。',
    'synthesis-failed': '系统未能完成朗读，请再次点击或换一个本地英语语音。',
    network: '系统语音未能播放；本应用不会切换到云端语音，请检查已安装的本地英语语音。',
    'text-too-long': '这段内容过长，请分成较短的句子朗读。',
    'invalid-argument': '这段内容暂时无法朗读，请选择另一句后重试。',
    canceled: '本次朗读已取消。',
    interrupted: '本次朗读已中断，请再次点击朗读。',
  };
  return messages[code] || '系统朗读暂不可用，请再次点击或换一个本地英语语音。';
}

function cancel() {
  const utterance = currentUtterance;
  currentUtterance = null;
  if (utterance) {
    utterance.onend = null;
    utterance.onerror = null;
  }
  try {
    synthesis()?.cancel();
  } catch {
    // Some embedded browsers expose the API but cannot operate the service.
  }
}

export const TTS = {
  get supported() {
    return isSupported();
  },

  /** Returns native voice objects, sorted by locale and preferred voice quality. */
  listVoices() {
    observeVoiceChanges();
    return localEnglishVoices();
  },

  /**
   * Synchronous boolean: true means queued with the native service, not that
   * audible playback has been verified. Native failures arrive through onError.
   * No network TTS, automatic retries, or default/remote voice fallback is used.
   */
  speak(text, { rate = 0.85, voiceURI, onEnd, onError } = {}) {
    if (!isSupported()) {
      callSafely(onError, '当前浏览器不支持系统朗读，请使用支持语音朗读的浏览器。', 'unsupported');
      return false;
    }
    const content = typeof text === 'string' ? text.trim() : '';
    if (!content) {
      callSafely(onError, '请先选择需要朗读的英文内容。', 'empty-text');
      return false;
    }

    observeVoiceChanges();
    const voices = localEnglishVoices();
    if (!voices.length) {
      callSafely(
        onError,
        '未找到本地英语语音。请在系统“辅助功能 → 朗读与语音/朗读内容 → 声音”安装英语语音，返回后再次点击朗读；语音列表若正在加载，请稍后再点。本应用不会使用云端语音。',
        'no-local-voice',
      );
      return false;
    }
    const voice = voices.find((item) => item.voiceURI === voiceURI) || voices[0];
    const numericRate = Number(rate);
    const synth = synthesis();

    try {
      if (currentUtterance || synth.speaking || synth.pending) cancel();
      const utterance = new globalThis.SpeechSynthesisUtterance(content);
      utterance.voice = voice;
      utterance.lang = voice.lang || 'en-US';
      utterance.rate = Number.isFinite(numericRate)
        ? Math.min(1, Math.max(0.6, numericRate))
        : 0.85;
      let completed = false;
      const finish = (failed, code) => {
        if (completed || currentUtterance !== utterance) return;
        completed = true;
        currentUtterance = null;
        utterance.onend = null;
        utterance.onerror = null;
        if (failed) callSafely(onError, speechErrorMessage(code), code);
        else callSafely(onEnd);
      };
      utterance.onend = () => finish(false);
      utterance.onerror = (event) => finish(true, event.error || 'synthesis-failed');
      // Keep a strong reference until completion: WebKit can otherwise lose it.
      currentUtterance = utterance;
      if (synth.paused) synth.resume();
      // This call must remain synchronous in the user's click/tap call chain.
      synth.speak(utterance);
      return true;
    } catch {
      cancel();
      callSafely(onError, '系统未能开始朗读，请直接点击朗读按钮后重试。', 'synthesis-failed');
      return false;
    }
  },

  cancel,

  /** Immediately supplies the current list, then updates on voiceschanged. */
  subscribeVoices(callback) {
    if (typeof callback !== 'function') return () => {};
    voiceSubscribers.add(callback);
    observeVoiceChanges();
    callSafely(callback, localEnglishVoices());
    return () => voiceSubscribers.delete(callback);
  },
};
