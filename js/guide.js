/**
 * 虛擬導覽員：語音（Web Speech）＋場景介紹＋機台單點 POI
 * 文案來源：stations.json 的 guide / points，可被 localStorage 覆寫
 */

export const GUIDE_OVERRIDE_KEY = 'f360-guide-overrides';
const GUIDE_MUTE_KEY = 'f360-guide-muted';
const GUIDE_MODE_KEY = 'f360-guide-mode'; // avatar=動畫立牌 window=影片視窗 cutout=去背真人
const GUIDE_LANG_KEY = 'f360-guide-lang'; // zh | en
const GUIDE_SEEN_INTRO_KEY = 'f360-guide-seen-intro';
const GUIDE_CHANNEL = 'f360-guide-overrides';

/** 公司介紹（點進網址的開場旁白），中英文對照 */
export const COMPANY_INTRO = {
  zh: {
    title: '金享車業 Kalloy · 公司介紹',
    text: '台灣金享 Kalloy 創立於 1980 年，位列全球前三大自行車輕量化零配件專業製造商。'
      + '公司專注研發製作車把、豎管、座管、座管束等自行車核心配件，產品覆蓋全車型，'
      + '適配各類騎行場景，遠銷歐美、澳洲等全球主流市場。'
      + '企業掌握鋁合金鍛造、碳纖維複合成型兩大核心工藝，採 OEM、ODM、OBM 三位一體營運模式，'
      + '旗下自有國際品牌 UNO。透過台灣、中國、越南三地全球化產能布局，可彈性調配產能，穩定供應全球訂單。'
      + '完整產線涵蓋模具開發製造、CNC 精密切削、噴砂表面處理、LOGO 刻印成型一貫化作業，'
      + '一站式完成零配件加工與品牌標識定製。金享堅持 ESG 永續經營理念，嚴控產品品質並提供完善配套服務，'
      + '長年為國際一線車企提供高規格、定製化自行車零配件整體解決方案。',
  },
  en: {
    title: 'Kalloy · Company Introduction',
    text: 'Founded in 1980, Kalloy Taiwan is among the world\'s top three professional manufacturers '
      + 'of lightweight bicycle components. We specialize in the R&D and production of core parts '
      + 'including handlebars, stems, seat posts and seat clamps, with products compatible with all '
      + 'bike types and diverse riding scenarios, sold to major global markets across Europe, America, '
      + 'Australia and beyond. '
      + 'We master core technologies of aluminum alloy forging and carbon fiber composite molding, '
      + 'and operate an integrated business model covering OEM, ODM and OBM, owning our international '
      + 'proprietary brand UNO. With global production bases deployed in Taiwan, mainland China and '
      + 'Vietnam, we deliver highly flexible and stable worldwide supply. '
      + 'Our full production line integrates mold manufacturing, CNC precision machining, sandblasting '
      + 'surface finishing and logo marking, realizing one-stop processing and customized brand marking '
      + 'for components. Adhering to ESG sustainable development principles and professional quality '
      + 'services, we have long provided high-end, customized bicycle component solutions for '
      + 'international brands.',
  },
};

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
    soloBtn: rootEl?.querySelector('[data-guide-solo]'),
    closeBtn: rootEl?.querySelector('[data-guide-close]'),
    openBtn: document.getElementById('f360-guide-open'),
    poiList: rootEl?.querySelector('[data-guide-poi-list]'),
  };

  let solo = false;
  let soloExitBtn = null;
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
  let speakWeights = [];
  let speakWeightTotal = 0;
  let mediaCaptionRaf = 0;
  // 無 boundary 事件時的後備字速（權重／秒；中文一字約 1）
  const EST_WEIGHT_PER_SEC_ZH = 4.6;
  const EST_WEIGHT_PER_SEC_EN = 11.5;

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

  /** 語言（公司介紹中英切換） */
  let lang = 'zh';
  try {
    if (localStorage.getItem(GUIDE_LANG_KEY) === 'en') lang = 'en';
  } catch { /* ignore */ }
  let langBtn = null;
  let companyMode = false; // 目前字幕內容是否為公司介紹
  let companyIntroPending = false; // 等待首次手勢後自動開講
  let currentSpeakKey = null;
  let currentSpeakText = '';
  let currentSpeakLang = 'zh';

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
    const spokenLang = currentSpeakLang;
    freezeOrHideVideo();
    if (key) {
      playRecorded(key, at).catch(() => {
        usingAudio = false;
        if (text) speakTts(text, spokenLang);
      });
    } else if (text) {
      speakTts(text, spokenLang);
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
      .f360-gmode__row { display: flex; gap: 6px; justify-content: flex-end; }
      .f360-gmode__toggle {
        padding: 8px 10px; border-radius: 999px; cursor: pointer;
        border: 1px solid rgba(255,255,255,0.22); background: rgba(10,14,20,0.72);
        backdrop-filter: blur(12px); color: rgba(255,255,255,0.85);
        font-size: 0.72rem; letter-spacing: 0.04em; white-space: nowrap;
        box-shadow: 0 8px 22px rgba(0,0,0,0.35);
      }
      [data-glang-switch] { font-weight: 700; color: #ffd869; border-color: rgba(212,160,23,0.5); }
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
      .f360-gv video.is-pack-src {
        /* iPhone 對 opacity:0／極小尺寸的 video 不會解碼畫面，必須離屏但仍有實體尺寸 */
        position: absolute !important;
        left: -12000px !important;
        top: 0 !important;
        width: 360px !important;
        height: 240px !important;
        max-width: none !important;
        opacity: 1 !important;
        pointer-events: none !important;
        filter: none !important;
        border: 0 !important;
        box-shadow: none !important;
        background: transparent !important;
      }
      .f360-gv__pack {
        position: relative;
        z-index: 2;
        display: block; width: auto; background: transparent;
        filter: drop-shadow(0 16px 26px rgba(0,0,0,0.5));
      }
      .f360-gv__pack[hidden] { display: none !important; }
      .f360-guide.is-fmt-window .f360-gv video {
        height: min(46vh, 430px); aspect-ratio: 3 / 4; width: auto;
        object-fit: cover; object-position: 50% 18%;
        border-radius: 16px; border: 1px solid rgba(212,160,23,0.45);
        box-shadow: 0 18px 44px rgba(0,0,0,0.5); background: #0b0f14;
      }
      .f360-guide.is-fmt-cutout .f360-gv video,
      .f360-guide.is-fmt-cutout .f360-gv__pack {
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
        .f360-guide[data-guide-mode="cutout"] .f360-gv video,
        .f360-guide[data-guide-mode="cutout"] .f360-gv__pack { height: min(36vh, 320px); }
        .f360-gv__plate { display: none; }
      }
      /* 手機橫向：導覽員縮小貼右下角，避免遮住環景 */
      @media (max-height: 540px), (max-width: 960px) and (orientation: landscape) {
        .f360-gmode {
          bottom: calc(var(--f360-thumbs-h) + var(--f360-safe) + min(38vh, 150px) + 8px);
        }
        .f360-gmode__toggle { padding: 6px 9px; font-size: 0.66rem; }
        .f360-guide.is-fmt-window .f360-gv video,
        .f360-guide[data-guide-mode="window"] .f360-gv video { height: min(36vh, 140px); }
        .f360-guide.is-fmt-cutout .f360-gv video,
        .f360-guide.is-fmt-cutout .f360-gv__pack,
        .f360-guide[data-guide-mode="cutout"] .f360-gv video,
        .f360-guide[data-guide-mode="cutout"] .f360-gv__pack {
          height: min(40vh, 155px);
          filter: drop-shadow(0 8px 14px rgba(0,0,0,0.45));
        }
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
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
    videoEl.preload = 'auto';
    videoEl.muted = false;
    videoPlate = document.createElement('div');
    videoPlate.className = 'f360-gv__plate';
    videoPlate.textContent = els.name?.textContent || '金享導覽員';
    videoBox.append(videoEl, videoPlate);
    els.root?.appendChild(videoBox);

    videoEl.addEventListener('play', () => {
      usingVideo = true;
      companyIntroPending = false;
      setSpeaking(true);
      startVideoWatchdog();
      startMediaCaptionSync(() => videoEl);
    });
    videoEl.addEventListener('timeupdate', () => {
      if (usingVideo && videoEl.duration > 0) {
        lastBoundaryAt = Date.now();
        setSpeechProgress(mediaSpeakRatio(videoEl));
      }
    });
    videoEl.addEventListener('ended', () => {
      stopVideoWatchdog();
      stopMediaCaptionSync();
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
  let packCanvas = null;
  let packOff = null;
  let packRaf = 0;

  function supportsWebmAlpha() {
    try {
      const probe = document.createElement('video');
      return Boolean(probe.canPlayType('video/webm; codecs="vp9"'));
    } catch {
      return false;
    }
  }

  /** iPhone／iPad／Safari：WebM 即使能播也沒有透明通道，必須走 H.264 遮罩合成 */
  function needsPackedCutout() {
    const ua = navigator.userAgent || '';
    const iOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
      || /CriOS|FxiOS|EdgiOS/.test(ua);
    const safari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox|CriOS|FxiOS/.test(ua);
    return iOS || safari || !supportsWebmAlpha();
  }

  function stopPackedComposite() {
    window.cancelAnimationFrame(packRaf);
    packRaf = 0;
    videoEl?.classList.remove('is-pack-src');
    if (packCanvas) packCanvas.hidden = true;
  }

  function startPackedComposite() {
    if (!videoEl || !videoBox) return;
    if (!packCanvas) {
      packCanvas = document.createElement('canvas');
      packCanvas.className = 'f360-gv__pack';
      packOff = document.createElement('canvas');
      videoBox.appendChild(packCanvas);
    }
    packCanvas.hidden = false;
    videoEl.classList.add('is-pack-src');
    window.cancelAnimationFrame(packRaf);
    const tick = () => {
      packRaf = window.requestAnimationFrame(tick);
      if (!videoEl || videoEl.readyState < 2) return;
      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;
      if (vw < 4 || vh < 2) return;
      const w = Math.floor(vw / 2);
      if (packCanvas.width !== w || packCanvas.height !== vh) {
        packCanvas.width = w;
        packCanvas.height = vh;
        packOff.width = w;
        packOff.height = vh;
      }
      try {
        const ctx = packCanvas.getContext('2d', { willReadFrequently: true });
        const octx = packOff.getContext('2d', { willReadFrequently: true });
        if (!ctx || !octx) return;
        ctx.drawImage(videoEl, 0, 0, w, vh, 0, 0, w, vh);
        octx.drawImage(videoEl, w, 0, w, vh, 0, 0, w, vh);
        const color = ctx.getImageData(0, 0, w, vh);
        const mask = octx.getImageData(0, 0, w, vh);
        const cd = color.data;
        const md = mask.data;
        for (let i = 0; i < cd.length; i += 4) cd[i + 3] = md[i];
        ctx.putImageData(color, 0, 0);
      } catch {
        /* iOS 偶發畫布讀取失敗時略過該幀，下一幀再試 */
      }
    };
    packRaf = window.requestAnimationFrame(tick);
  }

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
    // iPhone／Safari 不支援 WebM 透明通道，改用左右拼接的 H.264（左彩圖、右遮罩）在 canvas 合成去背
    const cutoutFirst = needsPackedCutout()
      ? [['ios.mp4', 'cutout-pack'], ['mp4', 'window']]
      : [['webm', 'cutout'], ['ios.mp4', 'cutout-pack'], ['mp4', 'window']];
    const candidates = mode === 'cutout' ? cutoutFirst : [['mp4', 'window']];
    let url = null;
    let fmt = null;
    for (const [ext, kind] of candidates) {
      const candidate = `${VIDEO_BASE}${encodeURIComponent(key)}.${ext}`;
      if (missingVideos.has(candidate)) continue;
      if (kind === 'cutout-pack') {
        url = candidate;
        fmt = kind;
        break;
      }
      try {
        await probeVideo(candidate);
        url = candidate;
        fmt = kind;
        break;
      } catch (err) {
        if (err?.message === 'guide-video-missing') missingVideos.add(candidate);
      }
    }
    if (!url) throw new Error('guide-video-missing');
    if (token !== videoToken) throw new Error('guide-video-stale');
    // 互斥保險：播影片前，錄音與合成語音一律停止
    stopRecorded();
    if (speechSupported) window.speechSynthesis.cancel();
    els.root?.classList.toggle('is-fmt-cutout', fmt === 'cutout' || fmt === 'cutout-pack');
    els.root?.classList.toggle('is-fmt-window', fmt === 'window');
    videoBox.hidden = false;
    els.root?.classList.add('is-video-live');
    if (fmt === 'cutout-pack') startPackedComposite();
    else stopPackedComposite();
    videoEl.src = url;
    try {
      await videoEl.play();
    } catch (err) {
      if (fmt === 'cutout-pack') {
        missingVideos.add(url);
        stopPackedComposite();
        const fallback = `${VIDEO_BASE}${encodeURIComponent(key)}.mp4`;
        els.root?.classList.remove('is-fmt-cutout');
        els.root?.classList.add('is-fmt-window');
        videoEl.src = fallback;
        await videoEl.play();
        return;
      }
      throw err;
    }
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
    stopMediaCaptionSync();
    stopPackedComposite();
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

  function bindAudioEl(el) {
    if (!el) return;
    audioEl = el;
    audioEl.preload = 'auto';
    audioEl.playsInline = true;
    audioEl.setAttribute('playsinline', '');
    audioEl.setAttribute('webkit-playsinline', '');
    if (audioEl._f360Bound) return;
    audioEl._f360Bound = true;
    audioEl.addEventListener('play', () => {
      usingAudio = true;
      companyIntroPending = false;
      setSpeaking(true);
      startAmpLoop();
      startMediaCaptionSync(() => audioEl);
    });
    audioEl.addEventListener('timeupdate', () => {
      if (usingAudio && audioEl.duration > 0) {
        lastBoundaryAt = Date.now();
        setSpeechProgress(mediaSpeakRatio(audioEl));
      }
    });
    audioEl.addEventListener('ended', () => {
      stopMediaCaptionSync();
      usingAudio = false;
      setSpeaking(false);
      setSpeechProgress(1);
    });
  }

  function ensureAudioEl() {
    if (audioEl) return;
    bindAudioEl(window.__f360BootAudio instanceof HTMLAudioElement
      ? window.__f360BootAudio
      : new Audio());
  }

  function attachPlayingAudio() {
    usingAudio = true;
    companyIntroPending = false;
    setSpeaking(true);
    startAmpLoop();
    startMediaCaptionSync(() => audioEl);
  }

  function isBootPlaying(key) {
    const boot = window.__f360BootAudio;
    if (!boot || window.__f360BootKey !== key) return false;
    return !boot.paused && !boot.ended;
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
      } else if (usingAudio) {
        ampTarget = 0.28 + Math.abs(Math.sin(performance.now() / 85)) * 0.55;
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
    const boot = window.__f360BootAudio;
    const isBoot = boot && audioEl === boot && window.__f360BootKey === key;
    // 開場音訊已在 HTML 啟動：絕不要重設 src，否則會把自動播放殺掉
    if (isBoot && !audioEl.ended) {
      bindAudioEl(boot);
      if (!audioEl.paused) {
        attachPlayingAudio();
        return;
      }
      await audioEl.play();
      attachPlayingAudio();
      return;
    }
    const url = `${AUDIO_BASE}${encodeURIComponent(key)}.mp3`;
    const same = audioEl.src && audioEl.src.includes(encodeURIComponent(key));
    if (same && !audioEl.paused && !audioEl.ended) {
      attachPlayingAudio();
      return;
    }
    audioEl.src = url;
    await audioEl.play();
    if (offset > 0) {
      try { audioEl.currentTime = offset; } catch { /* ignore */ }
    }
  }

  function stopRecorded() {
    if (!audioEl) return;
    stopMediaCaptionSync();
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
      if (Date.now() - lastBoundaryAt > 380) {
        talkTick();
        // 錄音／影片已用實際時間對字幕，不要再用固定字速蓋掉
        if (!usingAudio && !usingVideo && speakWeightTotal > 0) {
          const rate = currentSpeakLang === 'en' ? EST_WEIGHT_PER_SEC_EN : EST_WEIGHT_PER_SEC_ZH;
          const est = ((Date.now() - speakStartAt) / 1000) * rate;
          setSpeechProgress(Math.min(1, est / speakWeightTotal));
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

  function charSpeakWeight(ch) {
    if (/\s/.test(ch)) return 0.06;
    if ('，、,;；'.includes(ch)) return 0.55;
    if ('。！？!?'.includes(ch)) return 1.15;
    if ('：:'.includes(ch)) return 0.4;
    if ('—–-…'.includes(ch)) return 0.35;
    if (/[A-Za-z]/.test(ch)) return 0.32;
    if (/[0-9]/.test(ch)) return 0.38;
    return 1;
  }

  function mediaSpeakRatio(el) {
    const dur = el?.duration || 0;
    if (dur <= 0) return 0;
    const lead = Math.min(0.34, dur * 0.05);
    const tail = Math.min(0.5, dur * 0.07);
    return (el.currentTime - lead) / Math.max(0.05, dur - lead - tail);
  }

  function startMediaCaptionSync(getEl) {
    stopMediaCaptionSync();
    const step = () => {
      const el = getEl?.();
      if (!el || (!usingAudio && !usingVideo)) return;
      if (el.duration > 0) {
        lastBoundaryAt = Date.now();
        setSpeechProgress(mediaSpeakRatio(el));
      }
      mediaCaptionRaf = window.requestAnimationFrame(step);
    };
    mediaCaptionRaf = window.requestAnimationFrame(step);
  }

  function stopMediaCaptionSync() {
    window.cancelAnimationFrame(mediaCaptionRaf);
    mediaCaptionRaf = 0;
  }

  function renderSpeakableText(text) {
    if (!els.text) return;
    els.text.textContent = '';
    speakableChars = [];
    speakWeights = [];
    speakWeightTotal = 0;
    const frag = document.createDocumentFragment();
    for (const ch of String(text || '')) {
      const span = document.createElement('span');
      span.className = 'f360-guide__ch';
      span.textContent = ch;
      frag.appendChild(span);
      speakableChars.push(span);
      const w = charSpeakWeight(ch);
      speakWeights.push(w);
      speakWeightTotal += w;
    }
    els.text.appendChild(frag);
  }

  function setSpeechProgress(ratio) {
    const n = speakableChars.length;
    if (!n) return;
    const r = Math.max(0, Math.min(1, ratio));
    const target = r * (speakWeightTotal || n);
    let acc = 0;
    let upto = 0;
    for (let i = 0; i < n; i += 1) {
      acc += speakWeights[i] ?? 1;
      if (acc <= target + 1e-6) upto = i + 1;
      else break;
    }
    for (let i = 0; i < n; i += 1) {
      speakableChars[i].classList.toggle('is-said', i < upto);
    }
  }

  const speechSupported = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && 'SpeechSynthesisUtterance' in window;

  function setCollapsed(next) {
    collapsed = next;
    if (next) setSolo(false);
    els.root?.classList.toggle('is-collapsed', next);
    els.openBtn?.classList.toggle('is-visible', next);
    if (els.openBtn) {
      els.openBtn.setAttribute('aria-hidden', next ? 'false' : 'true');
    }
  }

  /** 專注導覽：隱藏所有介面與熱點，只留導覽員人物 */
  function setSolo(next) {
    solo = next;
    document.body.classList.toggle('is-guide-solo', next);
    if (soloExitBtn) soloExitBtn.hidden = !next;
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

  function pickVoice(prefLang = 'zh') {
    if (!speechSupported) return null;
    const voices = window.speechSynthesis.getVoices();
    if (prefLang === 'en') {
      return voices.find((v) => /en(-|_)?US/i.test(v.lang))
        || voices.find((v) => /^en/i.test(v.lang))
        || null;
    }
    const prefer = voices.find((v) => /zh(-|_)?TW/i.test(v.lang))
      || voices.find((v) => /zh(-|_)?HK/i.test(v.lang))
      || voices.find((v) => /zh/i.test(v.lang));
    return prefer || null;
  }

  function stopSpeech() {
    stopVideo();
    stopRecorded();
    stopMediaCaptionSync();
    if (speechSupported) window.speechSynthesis.cancel();
    currentUtterance = null;
    setSpeaking(false);
    setSpeechProgress(0);
  }

  function isAutoplayBlocked(err) {
    const name = err?.name || '';
    const msg = String(err?.message || '');
    return name === 'NotAllowedError' || /not allowed|interact|gesture|play\(\) request was interrupted/i.test(msg);
  }

  function onSpeakBlocked() {
    if (companyMode) companyIntroPending = true;
  }

  function speak(text, { force = false, key = null, lang: speakLang = 'zh' } = {}) {
    if (!text?.trim()) return;
    if (muted && !force) return;

    unlockedAudio = true;
    currentSpeakKey = key;
    currentSpeakText = text;
    currentSpeakLang = speakLang;

    const fallbackToTts = (err) => {
      if (isAutoplayBlocked(err)) {
        onSpeakBlocked();
        return;
      }
      usingAudio = false;
      speakTts(text, speakLang);
    };

    const startRecorded = () => {
      playRecorded(key).catch(fallbackToTts);
    };

    // 進站時 HTML 已開始播公司介紹：沿用同一段，不要 stop 後重設 src
    if (key && window.__f360BootKey === key && window.__f360BootAudio && mode === 'avatar') {
      stopVideo();
      if (speechSupported) window.speechSynthesis.cancel();
      bindAudioEl(window.__f360BootAudio);
      const boot = window.__f360BootAudio;
      const takeOver = () => {
        if (boot.ended) {
          startRecorded();
          return;
        }
        if (!boot.paused) {
          attachPlayingAudio();
          return;
        }
        Promise.resolve(window.__f360BootPlay)
          .then(() => attachPlayingAudio())
          .catch(() => onSpeakBlocked());
      };
      Promise.resolve(window.__f360BootPlay).then(takeOver).catch(() => onSpeakBlocked());
      return;
    }

    stopSpeech();

    // 真人影片模式：有對應影片就播影片；缺檔時真人定格＋語音，維持畫面穩定
    if (mode !== 'avatar' && key) {
      playVideoClip(key).catch((err) => {
        if (err?.message === 'guide-video-stale') return;
        if (isAutoplayBlocked(err)) {
          onSpeakBlocked();
          return;
        }
        freezeOrHideVideo();
        playRecorded(key).catch(fallbackToTts);
      });
      return;
    }
    if (mode !== 'avatar') freezeOrHideVideo();

    if (key) {
      startRecorded();
      return;
    }
    speakTts(text, speakLang);
  }

  function speakTts(text, ttsLang = 'zh') {
    if (!speechSupported) {
      if (els.status) els.status.textContent = '此瀏覽器不支援語音';
      return;
    }
    // 互斥保險：合成語音開講前，影片與錄音一律停止
    stopVideo();
    stopRecorded();
    const utter = new SpeechSynthesisUtterance(text.trim());
    utter.lang = ttsLang === 'en' ? 'en-US' : 'zh-TW';
    utter.rate = 1.02;
    utter.pitch = 1;
    const voice = pickVoice(ttsLang);
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
      if (speakWeightTotal > 0) {
        const idx = (event.charIndex || 0) + (event.charLength || 1);
        let w = 0;
        const n = Math.min(idx, speakWeights.length);
        for (let i = 0; i < n; i += 1) w += speakWeights[i];
        setSpeechProgress(w / speakWeightTotal);
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
    setSolo(false);
    stopSpeech();
    activePointId = null;
    // 無導覽的展間連「開啟導覽員」鈕也不顯示
    els.openBtn?.classList.remove('is-visible');
    els.openBtn?.setAttribute('aria-hidden', 'true');
  }

  function pointTitle(point) {
    return (lang === 'en' && point?.titleEn) ? point.titleEn : (point?.title || '');
  }

  function pointBody(point) {
    return (lang === 'en' && point?.bodyEn) ? point.bodyEn : (point?.body || '');
  }

  function sceneIntroMediaKey(scene, useEn) {
    if (scene?.guide?.mediaKey) {
      return `${scene.guide.mediaKey}_${useEn ? 'en' : 'zh'}`;
    }
    return useEn ? `${scene.id}__intro_en` : `${scene.id}__intro`;
  }

  function pointSpeakKey(sceneId, point) {
    if (!sceneId || !point?.id) return null;
    return lang === 'en' && point.bodyEn
      ? `${sceneId}__${point.id}_en`
      : `${sceneId}__${point.id}`;
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
      <p class="f360-guide__poi-label">${lang === 'en' ? 'Equipment highlights' : '機台單點介紹'}</p>
      <div class="f360-guide__poi-chips">
        ${points.map((p) => `
          <button type="button" class="f360-guide__poi-chip${p.id === activePointId ? ' is-active' : ''}" data-poi-id="${p.id}">
            ${escapeHtml(pointTitle(p))}
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

  function tryStartCompanyIntro() {
    if (!companyIntroPending || !companyMode || muted) return;
    if (speaking || usingAudio || usingVideo) {
      companyIntroPending = false;
      return;
    }
    if (tryStartCompanyIntro.lock) return;
    tryStartCompanyIntro.lock = true;
    window.setTimeout(() => { tryStartCompanyIntro.lock = false; }, 500);
    const c = COMPANY_INTRO[lang] || COMPANY_INTRO.zh;
    speak(c.text, { key: `company__intro_${lang}`, lang });
  }

  /** 公司介紹：一進網址就開講，支援中英切換 */
  function presentCompanyIntro({ autoPlay = true } = {}) {
    showPanel();
    companyMode = true;
    activePointId = null;
    const c = COMPANY_INTRO[lang] || COMPANY_INTRO.zh;
    if (els.title) els.title.textContent = c.title;
    renderSpeakableText(c.text);
    renderPoiList(getScene?.());
    if (!autoPlay) return;
    // 開場一定要出聲：不沿用上次靜音，也不再等使用者按播放鍵
    if (muted) setMuted(false);
    companyIntroPending = true;
    tryStartCompanyIntro();
  }

  function setLang(next) {
    const val = next === 'en' ? 'en' : 'zh';
    if (val === lang) return;
    lang = val;
    try { localStorage.setItem(GUIDE_LANG_KEY, lang); } catch { /* ignore */ }
    updateLangBtn();
    if (companyMode) {
      const resume = speaking || usingVideo || companyIntroPending;
      companyIntroPending = false;
      stopSpeech();
      presentCompanyIntro({ autoPlay: resume });
      return;
    }
    const scene = getScene?.();
    if (!scene || !els.root || els.root.hidden) return;
    const resume = speaking || usingVideo;
    stopSpeech();
    if (activePointId) {
      const point = (scene.points || []).find((p) => p.id === activePointId);
      if (point) presentPoint(point, scene);
      return;
    }
    if (scene.guide?.enabled && (scene.guide.intro || scene.guide.introEn)) {
      presentSceneIntro(scene, { autoPlay: resume });
    }
  }

  function updateLangBtn() {
    if (!langBtn) return;
    langBtn.textContent = lang === 'zh' ? 'EN' : '中文';
    langBtn.title = lang === 'zh' ? 'Switch to English' : '切換為中文';
  }

  function presentSceneIntro(scene, { autoPlay = false } = {}) {
    const guide = scene?.guide;
    if (!guide?.enabled) {
      hidePanel();
      return;
    }
    companyMode = false;
    companyIntroPending = false;

    showPanel();
    if (els.name) els.name.textContent = guide.name || '虛擬導覽員';
    if (els.role) els.role.textContent = guide.role || '虛擬導覽';
    if (videoPlate) videoPlate.textContent = guide.name || '虛擬導覽員';

    // 有英文文案時依目前語言切換；沒有則一律用中文
    const useEn = lang === 'en' && guide.introEn;
    const introText = (useEn ? guide.introEn : guide.intro) || '';
    const sceneTitle = (useEn && scene.titleEn) ? scene.titleEn : scene.title;
    const heading = useEn
      ? (guide.introTitleEn || `${sceneTitle} · Introduction`)
      : (guide.introTitle || `${sceneTitle} · 場景介紹`);
    setScript({
      title: heading,
      text: introText,
      pointId: null,
    });

    const shouldAuto = autoPlay && guide.autoPlayIntro !== false && !muted;
    if (shouldAuto && introText) {
      const key = sceneIntroMediaKey(scene, useEn);
      if (unlockedAudio) speak(introText, { key, lang: useEn ? 'en' : 'zh' });
    }
  }

  function presentPoint(point, scene) {
    if (!point) return;
    companyMode = false;
    companyIntroPending = false;
    showPanel();
    const title = pointTitle(point);
    const body = pointBody(point);
    setScript({
      title,
      text: body,
      pointId: point.id,
    });
    const sceneId = scene?.id || getScene?.()?.id;
    if (body) {
      const spoken = lang === 'en' ? `${title}. ${body}` : `${title}。${body}`;
      speak(spoken, { key: pointSpeakKey(sceneId, point), lang });
    }
    onFocusPoint?.(point, scene);
  }

  function replayCurrent() {
    if (companyMode) {
      const c = COMPANY_INTRO[lang] || COMPANY_INTRO.zh;
      speak(c.text, { force: true, key: `company__intro_${lang}`, lang });
      return;
    }
    const scene = getScene?.();
    if (activePointId) {
      const point = (scene?.points || []).find((p) => p.id === activePointId);
      if (!point) return;
      const title = pointTitle(point);
      const body = pointBody(point);
      if (!body) return;
      const spoken = lang === 'en' ? `${title}. ${body}` : `${title}。${body}`;
      speak(spoken, { force: true, key: pointSpeakKey(scene?.id, point), lang });
      return;
    }
    const text = els.text?.textContent || '';
    if (!text) return;
    const useEn = lang === 'en' && scene?.guide?.introEn;
    const key = scene ? sceneIntroMediaKey(scene, useEn) : null;
    speak(text, { force: true, key, lang: useEn ? 'en' : 'zh' });
  }

  function bindUi() {
    els.playBtn?.addEventListener('click', () => {
      unlockedAudio = true;
      replayCurrent();
    });
    els.stopBtn?.addEventListener('click', () => stopSpeech());
    els.muteBtn?.addEventListener('click', () => setMuted(!muted));
    els.soloBtn?.addEventListener('click', () => setSolo(true));
    els.closeBtn?.addEventListener('click', () => setCollapsed(true));

    // 專注模式的退出鈕：掛在 body 上，不受介面隱藏規則影響
    soloExitBtn = document.createElement('button');
    soloExitBtn.type = 'button';
    soloExitBtn.className = 'f360-solo-exit';
    soloExitBtn.textContent = '結束專注導覽';
    soloExitBtn.hidden = true;
    soloExitBtn.addEventListener('click', () => setSolo(false));
    document.body.appendChild(soloExitBtn);
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
        <div class="f360-gmode__row">
          <button type="button" class="f360-gmode__toggle" data-glang-switch>EN</button>
          <button type="button" class="f360-gmode__toggle" data-gmode-toggle>導覽員樣式</button>
        </div>
        <div class="f360-gmode__opts">
          <button type="button" data-gmode="avatar">虛擬人</button>
          <button type="button" data-gmode="cutout">真人</button>
        </div>`;
      els.root.appendChild(wrap);
      wrap.addEventListener('click', (event) => {
        if (event.target.closest('[data-glang-switch]')) {
          unlockedAudio = true;
          setLang(lang === 'zh' ? 'en' : 'zh');
          return;
        }
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
      langBtn = wrap.querySelector('[data-glang-switch]');
      updateLangBtn();
    }

    window.__f360OnEntered = () => {
      unlockedAudio = true;
      tryStartCompanyIntro();
    };
    applyMode(mode);

    // 預熱 voices
    if (speechSupported) {
      window.speechSynthesis.getVoices();
      window.speechSynthesis.addEventListener('voiceschanged', () => {
        pickVoice();
      });
    }

    const boot = window.__f360BootAudio;
    if (muted && boot && !boot.paused) muted = false;
    setMuted(muted);
  }

  bindUi();

  return {
    presentSceneIntro,
    presentCompanyIntro,
    /** 換站時同步機台點選清單（不自動講解） */
    syncScene(scene) {
      if (els.root?.hidden) return;
      renderPoiList(scene);
    },
    presentPoint,
    stopSpeech,
    hidePanel,
    showPanel,
    setCollapsed,
    unlockAudio() {
      unlockedAudio = true;
      try { audioCtx?.resume(); } catch { /* ignore */ }
      tryStartCompanyIntro();
    },
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
