/**
 * 虛擬導覽員：語音（Web Speech）＋場景介紹＋機台單點 POI
 * 文案來源：stations.json 的 guide / points，可被 localStorage 覆寫
 */

export const GUIDE_OVERRIDE_KEY = 'f360-guide-overrides';
const GUIDE_MUTE_KEY = 'f360-guide-muted';
const GUIDE_MODE_KEY = 'f360-guide-mode'; // avatar=動畫立牌 window=影片視窗 cutout=去背真人
const GUIDE_SEEN_INTRO_KEY = 'f360-guide-seen-intro';
const GUIDE_CHANNEL = 'f360-guide-overrides';

function broadcastGuideOverrides(overrides) {
  try {
    const ch = new BroadcastChannel(GUIDE_CHANNEL);
    ch.postMessage({ type: 'guide-overrides', overrides });
    ch.close();
  } catch { /* ignore */ }
}

export function loadGuideOverrides() {
  try {
    const raw = localStorage.getItem(GUIDE_OVERRIDE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveGuideOverrides(overrides) {
  localStorage.setItem(GUIDE_OVERRIDE_KEY, JSON.stringify(overrides));
  broadcastGuideOverrides(overrides);
}

export function clearGuideOverrides() {
  localStorage.removeItem(GUIDE_OVERRIDE_KEY);
  broadcastGuideOverrides(null);
}

/** 訂閱本機覆寫變更（跨分頁 storage + 同瀏覽器 BroadcastChannel） */
export function onGuideOverridesChange(handler) {
  const onStorage = (event) => {
    if (event.key !== GUIDE_OVERRIDE_KEY) return;
    handler(loadGuideOverrides());
  };
  window.addEventListener('storage', onStorage);

  let ch = null;
  try {
    ch = new BroadcastChannel(GUIDE_CHANNEL);
    ch.onmessage = (event) => {
      if (event?.data?.type !== 'guide-overrides') return;
      handler(event.data.overrides ?? loadGuideOverrides());
    };
  } catch { /* ignore */ }

  return () => {
    window.removeEventListener('storage', onStorage);
    try { ch?.close(); } catch { /* ignore */ }
  };
}

/**
 * 寫入單一展站的 guide / points 覆寫（缺省則沿用既有覆寫或 base）
 */
export function writeSceneGuideOverride(sceneId, { guide, points }, baseRecord = null) {
  const overrides = loadGuideOverrides() || {};
  const prev = overrides[sceneId] || {};
  overrides[sceneId] = {
    guide: guide !== undefined
      ? guide
      : (prev.guide ?? structuredClone(baseRecord?.guide || null)),
    points: points !== undefined
      ? points
      : structuredClone(prev.points ?? baseRecord?.points ?? []),
  };
  saveGuideOverrides(overrides);
  return overrides[sceneId];
}

/** 將覆寫合併進原始 stations 陣列（僅 guide / points） */
export function applyGuideOverrides(records, overrides) {
  if (!overrides || typeof overrides !== 'object') return records;
  return records.map((record) => {
    const patch = overrides[record.id];
    if (!patch) return record;
    return {
      ...record,
      guide: patch.guide !== undefined ? patch.guide : record.guide,
      points: patch.points !== undefined ? patch.points : record.points,
    };
  });
}

export function createGuideController({
  rootEl,
  getScene,
  getViewer,
  getMarkersPlugin,
  onFocusPoint,
}) {
  const els = {
    root: rootEl,
    avatar: rootEl?.querySelector('[data-guide-avatar]'),
    name: rootEl?.querySelector('[data-guide-name]'),
    role: rootEl?.querySelector('[data-guide-role]'),
    status: rootEl?.querySelector('[data-guide-status]'),
    title: rootEl?.querySelector('[data-guide-title]'),
    text: rootEl?.querySelector('[data-guide-text]'),
    playBtn: rootEl?.querySelector('[data-guide-play]'),
    stopBtn: rootEl?.querySelector('[data-guide-stop]'),
    muteBtn: rootEl?.querySelector('[data-guide-mute]'),
    closeBtn: rootEl?.querySelector('[data-guide-close]'),
    openBtn: document.getElementById('f360-guide-open'),
    poiList: rootEl?.querySelector('[data-guide-poi-list]'),
  };

  let muted = false;
  try {
    muted = localStorage.getItem(GUIDE_MUTE_KEY) === '1';
  } catch { /* ignore */ }

  let speaking = false;
  let currentUtterance = null;
  let activePointId = null;
  let collapsed = false;
  let unlockedAudio = false;

  /** 說話動態（嘴型／點頭）與逐字進度 */
  let talkTimer = null;
  let tickResetTimer = null;
  let lastBoundaryAt = 0;
  let speakStartAt = 0;
  let currentUtterLen = 0;
  let speakableChars = [];
  // 中文語速估計（無 boundary 事件時的逐字進度後備）
  const EST_CHARS_PER_SEC = 5.0;

  /** 預生成語音（edge-tts 神經語音）：比瀏覽器 TTS 自然，缺檔時自動退回 TTS */
  const AUDIO_BASE = './media/guide/audio/';
  let audioEl = null;
  let audioCtx = null;
  let analyser = null;
  let ampRaf = 0;
  let ampValue = 0;
  let ampTarget = 0;
  let usingAudio = false;

  /** 真人影片導覽員（本機素材，缺檔自動退回立牌＋語音） */
  const VIDEO_BASE = './media/guide/video/';
  const GUIDE_MODES = ['avatar', 'cutout'];
  let mode = 'avatar';
  try {
    const saved = localStorage.getItem(GUIDE_MODE_KEY);
    if (GUIDE_MODES.includes(saved)) mode = saved;
    else if (saved === 'window') mode = 'cutout'; // 舊設定：視窗模式已移除，併入真人
  } catch { /* ignore */ }
  let videoBox = null;
  let videoEl = null;
  let videoPlate = null;
  let usingVideo = false;
  let videoToken = 0;
  let modeButtons = [];
  let currentSpeakKey = null;
  let currentSpeakText = '';

  /** 影片播放看門狗：卡住超過 3 秒即改用語音接續，避免整段當掉 */
  let videoWatchdog = 0;
  let lastVideoTime = -1;
  let lastVideoTickAt = 0;

  function stopVideoWatchdog() {
    window.clearInterval(videoWatchdog);
    videoWatchdog = 0;
  }

  function startVideoWatchdog() {
    stopVideoWatchdog();
    lastVideoTime = -1;
    lastVideoTickAt = Date.now();
    videoWatchdog = window.setInterval(() => {
      if (!usingVideo || !videoEl || videoEl.ended) {
        stopVideoWatchdog();
        return;
      }
      if (videoEl.paused) return;
      if (videoEl.currentTime !== lastVideoTime) {
        lastVideoTime = videoEl.currentTime;
        lastVideoTickAt = Date.now();
        return;
      }
      if (Date.now() - lastVideoTickAt > 3000) recoverFromVideoStall();
    }, 800);
  }

  function recoverFromVideoStall() {
    stopVideoWatchdog();
    const at = videoEl?.currentTime || 0;
    const key = currentSpeakKey;
    const text = currentSpeakText;
    freezeOrHideVideo();
    if (key) {
      playRecorded(key, at).catch(() => {
        usingAudio = false;
        if (text) speakTts(text);
      });
    } else if (text) {
      speakTts(text);
    }
  }

  function injectVideoStyles() {
    if (document.getElementById('f360-guide-video-style')) return;
    const style = document.createElement('style');
    style.id = 'f360-guide-video-style';
    style.textContent = `
      .f360-gmode {
        position: absolute;
        right: max(10px, env(safe-area-inset-right));
        bottom: calc(var(--f360-thumbs-h) + var(--f360-safe) + min(52vh, 500px) + 10px);
        display: flex; flex-direction: column-reverse; align-items: flex-end; gap: 6px;
        pointer-events: auto; z-index: 7;
      }
      @media (max-width: 720px) {
        .f360-gmode {
          bottom: calc(var(--f360-thumbs-h) + var(--f360-safe) + min(34vh, 300px) + 8px);
        }
      }
      .f360-gmode__toggle {
        padding: 8px 10px; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(255,255,255,0.22); background: rgba(10,14,20,0.72);
        backdrop-filter: blur(12px); color: rgba(255,255,255,0.85);
        font-size: 0.72rem; letter-spacing: 0.04em; white-space: nowrap;
        box-shadow: 0 8px 22px rgba(0,0,0,0.35);
      }
      .f360-gmode__opts {
        display: flex; flex-direction: column; align-items: stretch; gap: 5px;
      }
      .f360-gmode.is-collapsed .f360-gmode__opts { display: none; }
      .f360-gmode__opts button {
        padding: 6px 12px; border-radius: 999px; cursor: pointer; text-align: center;
        border: 1px solid rgba(255,255,255,0.18); background: rgba(10,14,20,0.72);
        backdrop-filter: blur(12px);
        color: rgba(255,255,255,0.78); font-size: 0.72rem; white-space: nowrap;
      }
      .f360-gmode__opts button.is-active {
        background: rgba(212,160,23,0.3); border-color: rgba(212,160,23,0.65); color: #ffd869;
      }
      .f360-gv {
        position: absolute;
        right: max(6px, env(safe-area-inset-right));
        bottom: calc(var(--f360-thumbs-h) + var(--f360-safe) - 4px);
        z-index: 5; pointer-events: none;
        animation: f360-presenter-in 0.55s ease-out backwards;
      }
      .f360-gv[hidden] { display: none !important; }
      .f360-gv video { display: block; }
      .f360-guide.is-fmt-window .f360-gv video {
        height: min(46vh, 430px); aspect-ratio: 3 / 4; width: auto;
        object-fit: cover; object-position: 50% 18%;
        border-radius: 16px; border: 1px solid rgba(212,160,23,0.45);
        box-shadow: 0 18px 44px rgba(0,0,0,0.5); background: #0b0f14;
      }
      .f360-guide.is-fmt-cutout .f360-gv video {
        height: min(50vh, 470px); width: auto; background: transparent;
        filter: drop-shadow(0 16px 26px rgba(0,0,0,0.5));
      }
      .f360-gv__plate {
        position: absolute; left: 8px; bottom: 8%;
        padding: 5px 10px; border-radius: 10px;
        background: rgba(10,14,20,0.72); border: 1px solid rgba(212,160,23,0.4);
        backdrop-filter: blur(12px); color: #fff;
        font-size: 0.78rem; font-weight: 700; white-space: nowrap;
      }
      .f360-guide.is-video-live .f360-presenter { display: none !important; }
      @media (max-width: 720px) {
        .f360-guide[data-guide-mode="window"] .f360-gv video { height: min(34vh, 300px); }
        .f360-guide[data-guide-mode="cutout"] .f360-gv video { height: min(36vh, 320px); }
        .f360-gv__plate { display: none; }
      }
    `;
    document.head.appendChild(style);
  }

  function ensureVideoEl() {
    if (videoEl) return;
    injectVideoStyles();
    videoBox = document.createElement('div');
    videoBox.className = 'f360-gv';
    videoBox.hidden = true;
    videoEl = document.createElement('video');
    videoEl.playsInline = true;
    videoEl.preload = 'auto';
    videoPlate = document.createElement('div');
    videoPlate.className = 'f360-gv__plate';
    videoPlate.textContent = els.name?.textContent || '金享導覽員';
    videoBox.append(videoEl, videoPlate);
    els.root?.appendChild(videoBox);

    videoEl.addEventListener('play', () => {
      usingVideo = true;
      setSpeaking(true);
      startVideoWatchdog();
    });
    videoEl.addEventListener('timeupdate', () => {
      if (usingVideo && videoEl.duration > 0) {
        setSpeechProgress(videoEl.currentTime / videoEl.duration);
      }
    });
    videoEl.addEventListener('ended', () => {
      stopVideoWatchdog();
      usingVideo = false;
      setSpeaking(false);
      setSpeechProgress(1);
    });
    videoEl.addEventListener('error', () => {
      if (usingVideo) recoverFromVideoStall();
    });
  }

  /** 已知缺檔的影片網址，避免重複探測造成延遲 */
  const missingVideos = new Set();

  function probeVideo(url) {
    return new Promise((resolve, reject) => {
      const probe = document.createElement('video');
      probe.preload = 'metadata';
      const timer = window.setTimeout(() => {
        probe.onloadedmetadata = null;
        probe.onerror = null;
        reject(new Error('guide-video-timeout'));
      }, 5000);
      probe.onloadedmetadata = () => {
        window.clearTimeout(timer);
        probe.removeAttribute('src');
        resolve();
      };
      probe.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('guide-video-missing'));
      };
      probe.src = url;
    });
  }

  async function playVideoClip(key) {
    ensureVideoEl();
    const token = ++videoToken;
    // 去背模式優先用 webm，缺檔時退而用視窗版 mp4（仍是真人，不落回立牌）
    const candidates = mode === 'cutout'
      ? [['webm', 'cutout'], ['mp4', 'window']]
      : [['mp4', 'window']];
    let url = null;
    let fmt = null;
    for (const [ext, kind] of candidates) {
      const candidate = `${VIDEO_BASE}${encodeURIComponent(key)}.${ext}`;
      if (missingVideos.has(candidate)) continue;
      try {
        // 先用探測元素確認影片存在，避免把顯示中的畫面清掉
        await probeVideo(candidate);
        url = candidate;
        fmt = kind;
        break;
      } catch (err) {
        // 逾時不列入缺檔名單（可能只是還在產生中），下次仍會再試
        if (err?.message === 'guide-video-missing') missingVideos.add(candidate);
      }
    }
    if (!url) throw new Error('guide-video-missing');
    if (token !== videoToken) throw new Error('guide-video-stale');
    // 互斥保險：播影片前，錄音與合成語音一律停止
    stopRecorded();
    if (speechSupported) window.speechSynthesis.cancel();
    els.root?.classList.toggle('is-fmt-cutout', fmt === 'cutout');
    els.root?.classList.toggle('is-fmt-window', fmt === 'window');
    videoBox.hidden = false;
    els.root?.classList.add('is-video-live');
    videoEl.src = url;
    await videoEl.play();
  }

  /** 缺影片時的穩定處理：真人畫面定格續留，不跳回立牌 */
  function freezeOrHideVideo() {
    if (videoEl && videoEl.readyState >= 2 && videoBox && !videoBox.hidden) {
      videoToken += 1;
      stopVideoWatchdog();
      try { videoEl.pause(); } catch { /* ignore */ }
      usingVideo = false;
    } else {
      stopVideo({ hide: true });
    }
  }

  function stopVideo({ hide = false } = {}) {
    if (!videoEl) return;
    videoToken += 1;
    stopVideoWatchdog();
    try { videoEl.pause(); } catch { /* ignore */ }
    usingVideo = false;
    if (hide) {
      videoEl.removeAttribute('src');
      try { videoEl.load(); } catch { /* ignore */ }
      if (videoBox) videoBox.hidden = true;
      els.root?.classList.remove('is-video-live', 'is-fmt-cutout', 'is-fmt-window');
    }
  }

  function updateModeButtons() {
    modeButtons.forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.gmode === mode);
    });
  }

  function applyMode(next) {
    if (!GUIDE_MODES.includes(next)) next = 'avatar';
    mode = next;
    try { localStorage.setItem(GUIDE_MODE_KEY, next); } catch { /* ignore */ }
    els.root?.setAttribute('data-guide-mode', next);
    stopVideo({ hide: true });
    updateModeButtons();
  }

  function ensureAudioEl() {
    if (audioEl) return;
    audioEl = new Audio();
    audioEl.preload = 'auto';
    audioEl.addEventListener('play', () => {
      usingAudio = true;
      setSpeaking(true);
      startAmpLoop();
    });
    audioEl.addEventListener('timeupdate', () => {
      if (usingAudio && audioEl.duration > 0) {
        setSpeechProgress(audioEl.currentTime / audioEl.duration);
      }
    });
    audioEl.addEventListener('ended', () => {
      usingAudio = false;
      setSpeaking(false);
      setSpeechProgress(1);
    });
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = new Ctx();
      const srcNode = audioCtx.createMediaElementSource(audioEl);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      srcNode.connect(analyser);
      analyser.connect(audioCtx.destination);
    } catch { analyser = null; }
  }

  function startAmpLoop() {
    cancelAnimationFrame(ampRaf);
    const data = analyser ? new Uint8Array(analyser.fftSize) : null;
    const step = () => {
      if (!speaking) {
        ampValue = 0;
        els.avatar?.style.setProperty('--amp', '0');
        return;
      }
      if (usingAudio && analyser) {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i] - 128) / 128;
          sum += v * v;
        }
        ampTarget = Math.min(1, Math.sqrt(sum / data.length) * 4.2);
      }
      ampValue += (ampTarget - ampValue) * 0.35;
      els.avatar?.style.setProperty('--amp', ampValue.toFixed(3));
      ampRaf = requestAnimationFrame(step);
    };
    ampRaf = requestAnimationFrame(step);
  }

  async function playRecorded(key, offset = 0) {
    // 互斥保險：確保影片與合成語音都已靜止，避免聲音重疊
    stopVideo();
    if (speechSupported) window.speechSynthesis.cancel();
    ensureAudioEl();
    audioEl.src = `${AUDIO_BASE}${encodeURIComponent(key)}.mp3`;
    try { await audioCtx?.resume(); } catch { /* ignore */ }
    await audioEl.play();
    if (offset > 0) {
      try { audioEl.currentTime = offset; } catch { /* ignore */ }
    }
  }

  function stopRecorded() {
    if (!audioEl) return;
    audioEl.pause();
    audioEl.removeAttribute('src');
    usingAudio = false;
  }

  function talkTick() {
    const a = els.avatar;
    if (!a) return;
    a.style.setProperty('--jaw', (0.45 + Math.random() * 0.9).toFixed(2));
    // TTS 後備模式：模擬音量起伏驅動嘴型
    if (!usingAudio) {
      ampTarget = 0.35 + Math.random() * 0.65;
      window.setTimeout(() => { if (!usingAudio) ampTarget = 0.05; }, 90);
    }
    a.classList.add('is-tick');
    window.clearTimeout(tickResetTimer);
    tickResetTimer = window.setTimeout(() => a.classList.remove('is-tick'), 110);
  }

  function startTalkRhythm() {
    stopTalkRhythm();
    const step = () => {
      if (!speaking) return;
      // boundary 事件有在動就交給它；否則用節奏器模擬說話動態
      if (Date.now() - lastBoundaryAt > 380) {
        talkTick();
        if (currentUtterLen > 0) {
          const est = ((Date.now() - speakStartAt) / 1000) * EST_CHARS_PER_SEC;
          setSpeechProgress(Math.min(1, est / currentUtterLen));
        }
      }
      talkTimer = window.setTimeout(step, 130 + Math.random() * 170);
    };
    talkTimer = window.setTimeout(step, 120);
  }

  function stopTalkRhythm() {
    window.clearTimeout(talkTimer);
    talkTimer = null;
    els.avatar?.classList.remove('is-tick');
  }

  function renderSpeakableText(text) {
    if (!els.text) return;
    els.text.textContent = '';
    speakableChars = [];
    const frag = document.createDocumentFragment();
    for (const ch of String(text || '')) {
      const span = document.createElement('span');
      span.className = 'f360-guide__ch';
      span.textContent = ch;
      frag.appendChild(span);
      speakableChars.push(span);
    }
    els.text.appendChild(frag);
  }

  function setSpeechProgress(ratio) {
    const n = speakableChars.length;
    if (!n) return;
    const upto = Math.floor(Math.max(0, Math.min(1, ratio)) * n);
    for (let i = 0; i < n; i += 1) {
      speakableChars[i].classList.toggle('is-said', i < upto);
    }
  }

  const speechSupported = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && 'SpeechSynthesisUtterance' in window;

  function setCollapsed(next) {
    collapsed = next;
    els.root?.classList.toggle('is-collapsed', next);
    els.openBtn?.classList.toggle('is-visible', next);
    if (els.openBtn) {
      els.openBtn.setAttribute('aria-hidden', next ? 'false' : 'true');
    }
  }

  function setSpeaking(next) {
    speaking = next;
    els.root?.classList.toggle('is-speaking', next);
    els.avatar?.classList.toggle('is-speaking', next);
    if (els.status) {
      els.status.textContent = next ? '解說中' : (muted ? '已靜音' : '待命');
    }
    if (els.playBtn) {
      els.playBtn.textContent = next ? '重播' : '播放語音';
    }
    if (next) {
      startTalkRhythm();
      startAmpLoop();
    } else {
      stopTalkRhythm();
      ampTarget = 0;
      els.avatar?.style.setProperty('--amp', '0');
    }
  }

  function setMuted(next) {
    muted = next;
    try {
      localStorage.setItem(GUIDE_MUTE_KEY, next ? '1' : '0');
    } catch { /* ignore */ }
    els.root?.classList.toggle('is-muted', next);
    if (els.muteBtn) {
      els.muteBtn.textContent = next ? '取消靜音' : '靜音';
      els.muteBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    }
    if (next) stopSpeech();
    else if (!speaking && els.status) els.status.textContent = '待命';
  }

  function pickVoice() {
    if (!speechSupported) return null;
    const voices = window.speechSynthesis.getVoices();
    const prefer = voices.find((v) => /zh(-|_)?TW/i.test(v.lang))
      || voices.find((v) => /zh(-|_)?HK/i.test(v.lang))
      || voices.find((v) => /zh/i.test(v.lang));
    return prefer || null;
  }

  function stopSpeech() {
    stopVideo();
    stopRecorded();
    if (speechSupported) window.speechSynthesis.cancel();
    currentUtterance = null;
    setSpeaking(false);
    setSpeechProgress(0);
  }

  function speak(text, { force = false, key = null } = {}) {
    if (!text?.trim()) return;
    if (muted && !force) return;

    unlockedAudio = true;
    stopSpeech();
    currentSpeakKey = key;
    currentSpeakText = text;

    // 真人影片模式：有對應影片就播影片；缺檔時真人定格＋語音，維持畫面穩定
    if (mode !== 'avatar' && key) {
      playVideoClip(key).catch((err) => {
        if (err?.message === 'guide-video-stale') return;
        freezeOrHideVideo();
        playRecorded(key).catch(() => {
          usingAudio = false;
          speakTts(text);
        });
      });
      return;
    }
    if (mode !== 'avatar') freezeOrHideVideo();

    if (key) {
      playRecorded(key).catch(() => {
        usingAudio = false;
        speakTts(text);
      });
      return;
    }
    speakTts(text);
  }

  function speakTts(text) {
    if (!speechSupported) {
      if (els.status) els.status.textContent = '此瀏覽器不支援語音';
      return;
    }
    // 互斥保險：合成語音開講前，影片與錄音一律停止
    stopVideo();
    stopRecorded();
    const utter = new SpeechSynthesisUtterance(text.trim());
    utter.lang = 'zh-TW';
    utter.rate = 1.02;
    utter.pitch = 1;
    const voice = pickVoice();
    if (voice) utter.voice = voice;

    currentUtterLen = utter.text.length;
    utter.onstart = () => {
      speakStartAt = Date.now();
      lastBoundaryAt = 0;
      setSpeechProgress(0);
      setSpeaking(true);
    };
    utter.onboundary = (event) => {
      lastBoundaryAt = Date.now();
      talkTick();
      if (currentUtterLen > 0) {
        const idx = (event.charIndex || 0) + (event.charLength || 1);
        setSpeechProgress(idx / currentUtterLen);
      }
    };
    utter.onend = () => {
      currentUtterance = null;
      setSpeaking(false);
      setSpeechProgress(1);
    };
    utter.onerror = () => {
      currentUtterance = null;
      setSpeaking(false);
    };

    currentUtterance = utter;
    // Chrome 有時 voices 尚未載入，延遲一幀再講
    window.setTimeout(() => {
      if (currentUtterance !== utter) return;
      window.speechSynthesis.speak(utter);
    }, 40);
  }

  function showPanel() {
    if (!els.root) return;
    els.root.hidden = false;
    setCollapsed(false);
  }

  function hidePanel() {
    if (!els.root) return;
    els.root.hidden = true;
    stopSpeech();
    activePointId = null;
  }

  function renderPoiList(scene) {
    if (!els.poiList) return;
    const points = scene?.points || [];
    if (!points.length) {
      els.poiList.innerHTML = '';
      els.poiList.hidden = true;
      return;
    }
    els.poiList.hidden = false;
    els.poiList.innerHTML = `
      <p class="f360-guide__poi-label">機台單點介紹</p>
      <div class="f360-guide__poi-chips">
        ${points.map((p) => `
          <button type="button" class="f360-guide__poi-chip${p.id === activePointId ? ' is-active' : ''}" data-poi-id="${p.id}">
            ${escapeHtml(p.title)}
          </button>`).join('')}
      </div>`;
  }

  function setScript({ title, text, pointId = null }) {
    activePointId = pointId;
    if (els.title) els.title.textContent = title || '';
    renderSpeakableText(text || '');
    const scene = getScene?.();
    renderPoiList(scene);
  }

  function presentSceneIntro(scene, { autoPlay = false } = {}) {
    const guide = scene?.guide;
    if (!guide?.enabled) {
      hidePanel();
      return;
    }

    showPanel();
    if (els.name) els.name.textContent = guide.name || '虛擬導覽員';
    if (els.role) els.role.textContent = guide.role || '虛擬導覽';
    if (videoPlate) videoPlate.textContent = guide.name || '虛擬導覽員';

    setScript({
      title: `${scene.title} · 場景介紹`,
      text: guide.intro || '',
      pointId: null,
    });

    const shouldAuto = autoPlay && guide.autoPlayIntro !== false && !muted;
    if (shouldAuto && guide.intro) {
      // 需使用者手勢後才自動播；若尚未解鎖則只顯示文案
      if (unlockedAudio) speak(guide.intro, { key: `${scene.id}__intro` });
    }
  }

  function presentPoint(point, scene) {
    if (!point) return;
    showPanel();
    setScript({
      title: point.title,
      text: point.body || '',
      pointId: point.id,
    });
    const sceneId = scene?.id || getScene?.()?.id;
    if (point.body) speak(`${point.title}。${point.body}`, { key: sceneId ? `${sceneId}__${point.id}` : null });
    onFocusPoint?.(point, scene);
  }

  function replayCurrent() {
    const title = els.title?.textContent || '';
    const text = els.text?.textContent || '';
    if (!text) return;
    const sceneId = getScene?.()?.id || null;
    const key = sceneId ? `${sceneId}__${activePointId || 'intro'}` : null;
    // 機台介紹已含標題；場景介紹直接播正文
    if (activePointId) speak(`${title}。${text}`, { force: true, key });
    else speak(text, { force: true, key });
  }

  function bindUi() {
    els.playBtn?.addEventListener('click', () => {
      unlockedAudio = true;
      replayCurrent();
    });
    els.stopBtn?.addEventListener('click', () => stopSpeech());
    els.muteBtn?.addEventListener('click', () => setMuted(!muted));
    els.closeBtn?.addEventListener('click', () => setCollapsed(true));
    els.openBtn?.addEventListener('click', () => {
      showPanel();
      setCollapsed(false);
    });

    els.poiList?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-poi-id]');
      if (!btn) return;
      const scene = getScene?.();
      const point = (scene?.points || []).find((p) => p.id === btn.dataset.poiId);
      if (!point) return;
      presentPoint(point, scene);
    });

    // 導覽員樣式切換器：右側浮動小按鈕，預設收合，點開展開選項
    injectVideoStyles();
    if (els.root) {
      const wrap = document.createElement('div');
      wrap.className = 'f360-gmode is-collapsed';
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', '導覽員樣式');
      wrap.innerHTML = `
        <button type="button" class="f360-gmode__toggle" data-gmode-toggle>導覽員樣式</button>
        <div class="f360-gmode__opts">
          <button type="button" data-gmode="avatar">虛擬人</button>
          <button type="button" data-gmode="cutout">真人</button>
        </div>`;
      els.root.appendChild(wrap);
      wrap.addEventListener('click', (event) => {
        if (event.target.closest('[data-gmode-toggle]')) {
          wrap.classList.toggle('is-collapsed');
          return;
        }
        const btn = event.target.closest('[data-gmode]');
        if (!btn) return;
        wrap.classList.add('is-collapsed');
        stopSpeech();
        applyMode(btn.dataset.gmode);
        // 切換後立刻用新模式重播當前解說，避免「站著不動」的空窗
        unlockedAudio = true;
        replayCurrent();
      });
      modeButtons = [...wrap.querySelectorAll('[data-gmode]')];
    }
    applyMode(mode);

    // 預熱 voices
    if (speechSupported) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        pickVoice();
      });
    }

    setMuted(muted);
  }

  bindUi();

  return {
    presentSceneIntro,
    presentPoint,
    stopSpeech,
    hidePanel,
    showPanel,
    setCollapsed,
    unlockAudio() { unlockedAudio = true; },
    isMuted: () => muted,
    markIntroSeen(sceneId) {
      try {
        const map = JSON.parse(localStorage.getItem(GUIDE_SEEN_INTRO_KEY) || '{}');
        map[sceneId] = true;
        localStorage.setItem(GUIDE_SEEN_INTRO_KEY, JSON.stringify(map));
      } catch { /* ignore */ }
    },
    hasSeenIntro(sceneId) {
      try {
        const map = JSON.parse(localStorage.getItem(GUIDE_SEEN_INTRO_KEY) || '{}');
        return !!map[sceneId];
      } catch {
        return false;
      }
    },
  };
}

export function buildInfoMarkerHtml(point) {
  return `
    <div class="info-marker" aria-hidden="true">
      <div class="info-marker__pulse">
        <span class="info-marker__ripple"></span>
        <span class="info-marker__ripple info-marker__ripple--2"></span>
        <span class="info-marker__core">i</span>
      </div>
      <div class="info-marker__chip">
        <span class="info-marker__tag">機台介紹</span>
        <span class="info-marker__name">${escapeHtml(point.title)}</span>
      </div>
    </div>`;
}

export function buildPointMarkers(scene) {
  return (scene.points || []).map((point) => ({
    id: point.id,
    html: buildInfoMarkerHtml(point),
    position: point.position,
    size: { width: 148, height: 88 },
    anchor: 'center bottom',
    className: 'info-marker-wrap',
    // 關閉 hover 縮放，避免與環景定位疊加造成震動
    hoverScale: false,
    tooltip: {
      content: `介紹：${point.title}`,
      className: 'f360-tooltip f360-tooltip--info',
      position: 'top center',
      trigger: 'hover',
    },
    data: {
      kind: 'info',
      pointId: point.id,
    },
  }));
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
