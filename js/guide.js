/**
 * 虛擬導覽員：語音（Web Speech）＋場景介紹＋機台單點 POI
 * 文案來源：stations.json 的 guide / points，可被 localStorage 覆寫
 */

export const GUIDE_OVERRIDE_KEY = 'f360-guide-overrides';
const GUIDE_MUTE_KEY = 'f360-guide-muted';
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
      els.status.textContent = next ? '語音播報中' : (muted ? '已靜音' : '待命');
    }
    if (els.playBtn) {
      els.playBtn.textContent = next ? '重播' : '播放語音';
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
    if (!speechSupported) return;
    window.speechSynthesis.cancel();
    currentUtterance = null;
    setSpeaking(false);
  }

  function speak(text, { force = false } = {}) {
    if (!text?.trim()) return;
    if (!speechSupported) {
      if (els.status) els.status.textContent = '此瀏覽器不支援語音';
      return;
    }
    if (muted && !force) return;

    unlockedAudio = true;
    stopSpeech();

    const utter = new SpeechSynthesisUtterance(text.trim());
    utter.lang = 'zh-TW';
    utter.rate = 1.02;
    utter.pitch = 1;
    const voice = pickVoice();
    if (voice) utter.voice = voice;

    utter.onstart = () => setSpeaking(true);
    utter.onend = () => {
      currentUtterance = null;
      setSpeaking(false);
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
    if (els.text) els.text.textContent = text || '';
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

    setScript({
      title: `${scene.title} · 場景介紹`,
      text: guide.intro || '',
      pointId: null,
    });

    const shouldAuto = autoPlay && guide.autoPlayIntro !== false && !muted;
    if (shouldAuto && guide.intro) {
      // 需使用者手勢後才自動播；若尚未解鎖則只顯示文案
      if (unlockedAudio) speak(guide.intro);
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
    if (point.body) speak(`${point.title}。${point.body}`);
    onFocusPoint?.(point, scene);
  }

  function replayCurrent() {
    const title = els.title?.textContent || '';
    const text = els.text?.textContent || '';
    if (!text) return;
    // 機台介紹已含標題；場景介紹直接播正文
    if (activePointId) speak(`${title}。${text}`, { force: true });
    else speak(text, { force: true });
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
