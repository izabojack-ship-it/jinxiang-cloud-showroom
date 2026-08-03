/**
 * 金享車業雲端展間 · 360° 環景導覽
 * 動線導覽：明確上一站／下一站、進度與熱點標籤
 * 虛擬導覽員：場景語音介紹＋機台單點（試作：一樓品保實驗室）
 */
import { Viewer, EquirectangularAdapter } from '@photo-sphere-viewer/core';
import { MarkersPlugin } from '@photo-sphere-viewer/markers-plugin';
import { AutorotatePlugin } from '@photo-sphere-viewer/autorotate-plugin';
/** 虛擬導覽員模組僅存在於本機開發環境；線上版沒有此檔案時自動停用相關功能 */
let guideApi = null;
try {
  guideApi = await import('./guide.js');
} catch {
  guideApi = null;
}

const MEDIA_VERSION = '63';
const STATIONS_URL = `./media/stations.json?v=${MEDIA_VERSION}`;
const DEFAULT_ZOOM = 42;
const THUMBS_COLLAPSE_KEY = 'f360-thumbs-collapsed';
const PANELS_COLLAPSE_KEY = 'f360-panels-collapsed';
/** 閒置多久後開始自動旋轉（毫秒） */
const AUTOROTATE_IDLE_MS = 2800;
/** 慢速順時針（負值 = 順時針） */
const AUTOROTATE_SPEED = '-0.32rpm';

const loaderEl = document.getElementById('f360-loader');
const loaderSubEl = loaderEl?.querySelector('.f360-loader__sub');
const fadeEl = document.getElementById('f360-fade');
const uiEl = document.querySelector('.f360-ui');
const sceneNameEl = document.getElementById('f360-scene-name');
const floorEl = document.getElementById('f360-floor');
const progressBarEl = document.getElementById('f360-progress-bar');
const progressTextEl = document.getElementById('f360-progress-text');
const nextCardEl = document.getElementById('f360-next-card');
const nextNameEl = document.getElementById('f360-next-name');
const gotoNextBtn = document.getElementById('f360-goto-next');
const prevBtn = document.getElementById('f360-prev');
const nextBtn = document.getElementById('f360-next');
const prevNameEl = document.getElementById('f360-prev-name');
const nextBtnNameEl = document.getElementById('f360-next-btn-name');
const radarBeamEl = document.getElementById('f360-radar-beam');
const thumbsEl = document.getElementById('f360-thumbs');
const thumbsToggleBtn = document.getElementById('f360-thumbs-toggle');
const thumbsToggleMetaEl = document.getElementById('f360-thumbs-toggle-meta');
const panelsToggleBtn = document.getElementById('f360-panels-toggle');
const panelsToggleLabelEl = document.getElementById('f360-panels-toggle-label');
const resetBtn = document.getElementById('f360-reset');
const guideRootEl = document.getElementById('f360-guide');
const placeToastEl = document.getElementById('f360-place-toast');
const placePanelEl = document.getElementById('f360-place-panel');
const placeListEl = document.getElementById('f360-place-list');
const placeFormEl = document.getElementById('f360-place-form');
const placeTitleEl = document.getElementById('f360-place-title');
const placeBodyEl = document.getElementById('f360-place-body');
const placeCoordsEl = document.getElementById('f360-place-coords');
const placeEditorLinkEl = document.getElementById('f360-place-editor-link');

/** 橫式時是否已由系統自動收合過（避免覆寫使用者手動展開） */
let landscapeAutoCollapsed = false;

let viewer = null;
let markersPlugin = null;
let autorotatePlugin = null;
let scenes = [];
let scenesBase = [];
let currentSceneId = null;
let isTransitioning = false;
let guide = null;
let placeMode = false;
let activePlacePointId = null;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mediaUrl(folder, file) {
  return `./media/${folder}/${encodeURIComponent(file)}?v=${MEDIA_VERSION}`;
}

function makePanoData(width, height, hfovDeg = 360, fullHeight = null, croppedY = 0) {
  const hfov = hfovDeg || 360;
  const fullWidth = Math.round(width * 360 / hfov);
  const fh = fullHeight || Math.round(fullWidth / 2);
  return {
    fullWidth: Math.max(fullWidth, 1),
    fullHeight: Math.max(fh, height),
    croppedWidth: width,
    croppedHeight: height,
    croppedX: 0,
    croppedY: croppedY || 0,
  };
}

function floorOf(title) {
  if (title.startsWith('二樓')) return '二樓';
  if (title.startsWith('工廠')) return '戶外入口';
  return '一樓';
}

function getScene(id) {
  return scenes.find((s) => s.id === id);
}

function currentIndex() {
  return scenes.findIndex((s) => s.id === currentSceneId);
}

function cleanLabel(label = '') {
  return label.replace(/^[←→\s]+|[←→\s]+$/g, '').trim();
}

function linkDirection(scene, link) {
  const from = scenes.findIndex((s) => s.id === scene.id);
  const to = scenes.findIndex((s) => s.id === link.target);
  if (from < 0 || to < 0) return 'next';
  return to < from ? 'prev' : 'next';
}

function buildPortalMarkerHtml(link, direction) {
  const name = cleanLabel(link.label);
  const dirText = direction === 'prev' ? '返回上一站' : '前往下一站';
  return `
    <div class="portal-marker portal-marker--${direction}" aria-hidden="true">
      <div class="portal-marker__pulse">
        <span class="portal-marker__ripple"></span>
        <span class="portal-marker__ripple portal-marker__ripple--2"></span>
        <span class="portal-marker__core"></span>
      </div>
      <div class="portal-marker__chip">
        <span class="portal-marker__dir">${dirText}</span>
        <span class="portal-marker__name">${name}</span>
      </div>
    </div>`;
}

function buildPortalMarkers(scene) {
  return (scene.links || []).map((link) => {
    const direction = linkDirection(scene, link);
    return {
      id: link.id,
      html: buildPortalMarkerHtml(link, direction),
      position: link.position,
      size: { width: 148, height: 88 },
      anchor: 'center bottom',
      className: 'portal-marker-wrap',
      tooltip: {
        content: `${direction === 'prev' ? '返回' : '前往'}：${cleanLabel(link.label)}`,
        className: 'f360-tooltip',
        position: 'top center',
        trigger: 'hover',
      },
      data: {
        kind: 'portal',
        targetSceneId: link.target,
        label: link.label,
        direction,
      },
    };
  });
}

function buildMarkersForScene(scene) {
  return [
    ...buildPortalMarkers(scene),
    ...(guideApi ? guideApi.buildPointMarkers(scene) : []),
  ];
}

function syncRadar(yawRad) {
  if (!radarBeamEl) return;
  radarBeamEl.style.transform = `rotate(${(yawRad * 180) / Math.PI}deg)`;
}

function updateRouteChrome() {
  const idx = currentIndex();
  const scene = getScene(currentSceneId);
  if (!scene || idx < 0) return;

  const prev = scenes[idx - 1] || null;
  const next = scenes[idx + 1] || null;
  const total = scenes.length;
  const pct = ((idx + 1) / total) * 100;

  if (sceneNameEl) sceneNameEl.textContent = scene.title;
  if (floorEl) floorEl.textContent = floorOf(scene.title);
  if (progressBarEl) progressBarEl.style.width = `${pct}%`;
  if (progressTextEl) {
    progressTextEl.textContent = `導覽進度 ${idx + 1} / ${total}`;
  }

  if (prevNameEl) prevNameEl.textContent = prev ? prev.title : '已是起點';
  if (nextNameEl) nextNameEl.textContent = next ? next.title : '已完成全程';
  if (nextBtnNameEl) nextBtnNameEl.textContent = next ? next.title : '終點';

  if (prevBtn) prevBtn.disabled = !prev;
  if (nextBtn) nextBtn.disabled = !next;
  if (gotoNextBtn) gotoNextBtn.disabled = !next;

  if (nextCardEl) {
    nextCardEl.classList.toggle('is-done', !next);
    const hint = nextCardEl.querySelector('.f360-next-card__hint');
    if (hint) {
      const hasPoints = (scene.points || []).length > 0;
      hint.textContent = next
        ? (hasPoints
          ? '點擊藍色熱點聽機台介紹，金色熱點可前往下一站'
          : '旋轉畫面，點擊金色熱點或下方按鈕前往')
        : '您已走完整條建議動線，可從底部站點再探訪';
    }
  }

  updatePanelsToggleLabel(!!uiEl?.classList.contains('is-panels-collapsed'));
}

function updateThumbnails() {
  const idx = currentIndex();
  thumbsEl?.querySelectorAll('.f360-thumb').forEach((btn) => {
    const i = Number(btn.dataset.index);
    btn.classList.toggle('is-active', btn.dataset.sceneId === currentSceneId);
    btn.classList.toggle('is-done', Number.isFinite(i) && i < idx);
  });

  const active = thumbsEl?.querySelector('.f360-thumb.is-active');
  active?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
}

function buildThumbnailMenu() {
  if (!thumbsEl) return;
  thumbsEl.innerHTML = scenes.map((scene, index) => `
    <button
      type="button"
      class="f360-thumb"
      data-scene-id="${scene.id}"
      data-index="${index}"
      aria-label="第 ${index + 1} 站 ${scene.title}"
    >
      <span class="f360-thumb__badge">${index + 1}</span>
      <img class="f360-thumb__img" src="${scene.thumbnail}" alt="" loading="lazy">
      <span class="f360-thumb__name">${scene.title}</span>
      <span class="f360-thumb__floor">${floorOf(scene.title)}</span>
    </button>`).join('');

  thumbsEl.addEventListener('click', (event) => {
    const btn = event.target.closest('.f360-thumb');
    if (!btn) return;
    switchScene(btn.dataset.sceneId);
  });
}

function applySceneMarkers(sceneId) {
  const scene = getScene(sceneId);
  if (!scene || !markersPlugin) return;
  markersPlugin.setMarkers(buildMarkersForScene(scene));
}

/** 只更新單一機台點位置，避免整批重建造成閃爍／震動 */
function updatePointMarker(point) {
  if (!markersPlugin || !point?.id || !point.position) return false;
  try {
    if (!markersPlugin.getMarker(point.id)) return false;
    markersPlugin.updateMarker({
      id: point.id,
      position: point.position,
    });
    return true;
  } catch {
    return false;
  }
}

function findLinkTo(targetId) {
  const scene = getScene(currentSceneId);
  return (scene?.links || []).find((l) => l.target === targetId) || null;
}

function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

function formatDeg(value) {
  return `${Math.round(value * 10) / 10}deg`;
}

function showPlaceToast(message) {
  if (!placeToastEl) {
    console.info('[定位]', message);
    return;
  }
  placeToastEl.textContent = message;
  placeToastEl.classList.add('is-visible');
  window.clearTimeout(showPlaceToast._timer);
  showPlaceToast._timer = window.setTimeout(() => {
    placeToastEl.classList.remove('is-visible');
  }, 4200);
}

function getActivePlacePoint() {
  const scene = getScene(currentSceneId);
  return (scene?.points || []).find((p) => p.id === activePlacePointId) || null;
}

function formatPointCoords(point) {
  if (!point?.position) return '尚未定位';
  return `yaw ${point.position.yaw} · pitch ${point.position.pitch}`;
}

function persistCurrentSceneGuide() {
  const scene = getScene(currentSceneId);
  const base = scenesBase.find((r) => r.id === currentSceneId) || null;
  if (!scene || !guideApi) return;
  guideApi.writeSceneGuideOverride(currentSceneId, {
    guide: scene.guide || base?.guide || null,
    points: scene.points || [],
  }, base);
}

function selectPlacePoint(pointId, { focus = false } = {}) {
  activePlacePointId = pointId || null;
  renderPlacePanel();
  const point = getActivePlacePoint();
  if (focus && point) focusPoint(point);
}

function renderPlacePanel() {
  if (!placeMode || !placePanelEl) return;
  const scene = getScene(currentSceneId);
  const points = scene?.points || [];

  if (placeEditorLinkEl) {
    placeEditorLinkEl.href = `./editor.html?scene=${encodeURIComponent(currentSceneId || '')}`;
  }

  if (!points.length) {
    if (placeListEl) {
      placeListEl.innerHTML = '<p class="f360-place-panel__hint" style="margin:0">尚無機台點，請先按「新增機台點」。</p>';
    }
    if (placeFormEl) placeFormEl.hidden = true;
    return;
  }

  if (!activePlacePointId || !points.some((p) => p.id === activePlacePointId)) {
    activePlacePointId = points[0].id;
  }

  if (placeListEl) {
    placeListEl.innerHTML = points.map((point, index) => `
      <button
        type="button"
        class="f360-place-item${point.id === activePlacePointId ? ' is-active' : ''}"
        data-place-point="${point.id}"
      >
        <span class="f360-place-item__num">${index + 1}</span>
        <span class="f360-place-item__name">${escapeHtml(point.title || `機台 ${index + 1}`)}</span>
        <span class="f360-place-item__pos">${escapeHtml(point.position?.yaw || '—')}</span>
      </button>`).join('');
  }

  const point = getActivePlacePoint();
  if (placeFormEl) placeFormEl.hidden = !point;
  if (point) {
    if (placeTitleEl && document.activeElement !== placeTitleEl) {
      placeTitleEl.value = point.title || '';
    }
    if (placeBodyEl && document.activeElement !== placeBodyEl) {
      placeBodyEl.value = point.body || '';
    }
    if (placeCoordsEl) placeCoordsEl.textContent = formatPointCoords(point);
  }
}

function saveActivePlaceText() {
  const scene = getScene(currentSceneId);
  const point = getActivePlacePoint();
  if (!scene || !point) return;
  point.title = placeTitleEl?.value.trim() || point.title;
  point.body = placeBodyEl?.value.trim() || '';
  persistCurrentSceneGuide();
  applySceneMarkers(currentSceneId);
  renderPlacePanel();
  showPlaceToast(`已儲存文案：${point.title}`);
}

function placePointAt(yaw, pitch) {
  const scene = getScene(currentSceneId);
  if (!scene) return;

  if (!activePlacePointId) {
    const n = (scene.points || []).length + 1;
    const created = {
      id: `poi-${currentSceneId}-${Date.now().toString(36)}`,
      title: `新機台 ${n}`,
      body: '',
      position: { yaw, pitch },
    };
    scene.points = [...(scene.points || []), created];
    activePlacePointId = created.id;
  } else {
    const point = getActivePlacePoint();
    if (!point) return;
    point.position = { yaw, pitch };
  }

  persistCurrentSceneGuide();

  const point = getActivePlacePoint();
  if (!point || !updatePointMarker(point)) {
    applySceneMarkers(currentSceneId);
  }
  renderPlacePanel();

  showPlaceToast(`已定位「${point?.title || '機台'}」→ ${yaw}, ${pitch}`);
  try {
    navigator.clipboard?.writeText(`"position": { "yaw": "${yaw}", "pitch": "${pitch}" }`);
  } catch { /* ignore */ }
}

function addPlacePoint() {
  const scene = getScene(currentSceneId);
  if (!scene) return;
  const n = (scene.points || []).length + 1;
  const created = {
    id: `poi-${currentSceneId}-${Date.now().toString(36)}`,
    title: `新機台 ${n}`,
    body: '',
    position: { yaw: '0deg', pitch: '-10deg' },
  };
  scene.points = [...(scene.points || []), created];
  activePlacePointId = created.id;
  persistCurrentSceneGuide();
  applySceneMarkers(currentSceneId);
  renderPlacePanel();
  showPlaceToast(`已新增「${created.title}」，請點環景放置位置`);
}

function setPlaceMode(on, { pointId = null, toast = true } = {}) {
  placeMode = !!on;
  document.body.classList.toggle('is-place-mode', placeMode);

  if (placePanelEl) placePanelEl.hidden = !placeMode;

  if (placeMode) {
    autorotatePlugin?.stop();
    if (pointId) activePlacePointId = pointId;
    renderPlacePanel();
    if (toast) {
      showPlaceToast(activePlacePointId
        ? '定位模式：點擊環景即可更新目前選取的機台位置'
        : '定位模式：先選機台，再點環景放置');
    }
  } else if (toast) {
    showPlaceToast('已結束定位模式');
  }
}

function bindPlacePanel() {
  placeListEl?.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-place-point]');
    if (!btn) return;
    selectPlacePoint(btn.dataset.placePoint, { focus: true });
  });

  document.getElementById('f360-place-save-text')?.addEventListener('click', () => {
    saveActivePlaceText();
  });

  document.getElementById('f360-place-focus')?.addEventListener('click', () => {
    const point = getActivePlacePoint();
    if (point) focusPoint(point);
  });

  document.getElementById('f360-place-add')?.addEventListener('click', () => {
    addPlacePoint();
  });

  document.getElementById('f360-place-exit')?.addEventListener('click', () => {
    setPlaceMode(false);
    const url = new URL(window.location.href);
    url.searchParams.delete('place');
    url.searchParams.delete('point');
    window.history.replaceState({}, '', url);
  });
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function focusPoint(point) {
  if (!viewer || !point?.position) return;
  autorotatePlugin?.stop();
  try {
    if (markersPlugin) {
      await markersPlugin.gotoMarker(point.id, '6rpm');
    } else {
      await viewer.animate({
        yaw: point.position.yaw,
        pitch: point.position.pitch,
        speed: '6rpm',
      });
    }
  } catch (err) {
    console.warn('[雲端展間] 對準機台失敗', err);
  }
}

function activateGuideForScene(scene, { isEnter = false } = {}) {
  if (!guide) return;
  if (!scene?.guide?.enabled) {
    guide.hidePanel();
    return;
  }

  const firstVisit = isEnter && !guide.hasSeenIntro(scene.id);
  guide.presentSceneIntro(scene, {
    autoPlay: firstVisit || (isEnter && scene.guide.autoPlayIntro !== false),
  });
  if (isEnter) guide.markIntroSeen(scene.id);
}

async function switchScene(targetId, options = {}) {
  if (isTransitioning || targetId === currentSceneId) return;

  const target = getScene(targetId);
  if (!target) return;

  isTransitioning = true;
  autorotatePlugin?.stop();
  guide?.stopSpeech();

  try {
    if (options.viaMarkerId && markersPlugin) {
      await markersPlugin.gotoMarker(options.viaMarkerId, '5rpm');
    }

    fadeEl?.classList.add('is-out');
    await wait(420);

    await viewer.setPanorama(target.panorama, {
      caption: target.title,
      panoData: target.panoData,
      position: {
        yaw: target.defaultYaw,
        pitch: target.defaultPitch,
      },
      zoom: target.defaultZoom ?? DEFAULT_ZOOM,
      transition: false,
      showLoader: true,
    });

    currentSceneId = targetId;
    applySceneMarkers(targetId);
    updateThumbnails();
    updateRouteChrome();
    autorotatePlugin?.setOption('autorotatePitch', target.defaultPitch);
    activateGuideForScene(target, { isEnter: true });
    if (placeMode) {
      activePlacePointId = null;
      renderPlacePanel();
      autorotatePlugin?.stop();
    }

    fadeEl?.classList.remove('is-out');
    fadeEl?.classList.add('is-in');
    await wait(420);
    fadeEl?.classList.remove('is-in');
  } catch (err) {
    console.error('[雲端展間] 場景切換失敗', err);
    fadeEl?.classList.remove('is-out', 'is-in');
  } finally {
    isTransitioning = false;
  }
}

function goAdjacent(delta) {
  const idx = currentIndex();
  if (idx < 0) return;
  const target = scenes[idx + delta];
  if (!target) return;
  const link = findLinkTo(target.id);
  switchScene(target.id, { viaMarkerId: link?.id });
}

function initGuide() {
  if (!guideApi) return;
  guide = guideApi.createGuideController({
    rootEl: guideRootEl,
    getScene: () => getScene(currentSceneId),
    getViewer: () => viewer,
    getMarkersPlugin: () => markersPlugin,
    onFocusPoint: (point) => {
      focusPoint(point);
    },
  });
}

function initViewer(startScene) {
  const first = startScene || scenes[0];
  if (!first) return;

  if (loaderSubEl) loaderSubEl.textContent = `正在載入 ${first.title}…`;

  viewer = new Viewer({
    container: 'viewer',
    adapter: [EquirectangularAdapter, { blur: false }],
    panorama: first.panorama,
    panoData: first.panoData,
    caption: first.title,
    loadingTxt: '載入雲端展間環景中…',
    navbar: false,
    defaultYaw: first.defaultYaw,
    defaultPitch: first.defaultPitch,
    defaultZoomLvl: first.defaultZoom ?? DEFAULT_ZOOM,
    mousewheel: true,
    mousemove: true,
    moveInertia: true,
    moveSpeed: 0.85,
    zoomSpeed: 0.85,
    minFov: 18,
    maxFov: 86,
    canvasBackground: '#151c26',
    rendererParameters: {
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    },
    plugins: [
      MarkersPlugin.withConfig({
        gotoMarkerSpeed: '5rpm',
        clickEventOnMarker: false,
        defaultHoverScale: { amount: 1.08, duration: 120, easing: 'ease-out' },
        markers: buildMarkersForScene(first),
      }),
      AutorotatePlugin.withConfig({
        autostartDelay: AUTOROTATE_IDLE_MS,
        autostartOnIdle: true,
        autorotateSpeed: AUTOROTATE_SPEED,
        autorotatePitch: first.defaultPitch,
      }),
    ],
  });

  markersPlugin = viewer.getPlugin(MarkersPlugin);
  autorotatePlugin = viewer.getPlugin(AutorotatePlugin);
  currentSceneId = first.id;
  window.__psv = viewer;
  window.__f360 = {
    getScene: () => getScene(currentSceneId),
    switchScene,
    setPlaceMode: (on, opts) => setPlaceMode(on, opts),
  };

  viewer.addEventListener('position-updated', ({ position }) => {
    syncRadar(position.yaw);
  });

  markersPlugin.addEventListener('select-marker', ({ marker }) => {
    const kind = marker?.data?.kind;
    if (kind === 'info') {
      const scene = getScene(currentSceneId);
      const point = (scene?.points || []).find((p) => p.id === marker.data.pointId);
      if (!point) return;
      if (placeMode) {
        selectPlacePoint(point.id, { focus: true });
        showPlaceToast(`已選取「${point.title}」，點環景可更新位置`);
        return;
      }
      guide?.unlockAudio();
      guide?.presentPoint(point, scene);
      return;
    }
    if (placeMode) return;
    const targetId = marker?.data?.targetSceneId;
    if (!targetId) return;
    switchScene(targetId, { viaMarkerId: marker.id });
  });

  viewer.addEventListener('click', ({ data }) => {
    if (!placeMode || !data) return;
    const yaw = formatDeg(radToDeg(data.yaw));
    const pitch = formatDeg(radToDeg(data.pitch));
    placePointAt(yaw, pitch);
    window.__f360.lastPlace = { yaw, pitch, pointId: activePlacePointId };
  });

  viewer.addEventListener('ready', () => {
    loaderEl?.classList.add('is-hidden');
    syncRadar(viewer.getPosition().yaw);
    updateRouteChrome();
    updateThumbnails();
    activateGuideForScene(first, { isEnter: true });
    autorotatePlugin?.start();
  }, { once: true });

  // 預載下一站即可，避免一次塞 15 張
  const idx = scenes.findIndex((s) => s.id === first.id);
  const preload = scenes[idx + 1] || scenes[1];
  if (preload && preload.id !== first.id) {
    const img = new Image();
    img.src = preload.panorama;
  }
}

function mapStationRecord(record) {
  return {
    id: record.id,
    title: record.title,
    panorama: mediaUrl('panoramas', record.file),
    thumbnail: mediaUrl('thumbs', record.file),
    panoData: makePanoData(
      record.width,
      record.height,
      record.hfov_deg,
      record.full_height,
      record.cropped_y,
    ),
    defaultYaw: record.default_yaw || '0deg',
    defaultPitch: record.default_pitch || '-5deg',
    defaultZoom: Number.isFinite(record.default_zoom) ? record.default_zoom : DEFAULT_ZOOM,
    links: record.links || [],
    guide: record.guide || null,
    points: Array.isArray(record.points) ? record.points : [],
  };
}

function isCompactLandscape() {
  return window.matchMedia('(max-height: 480px), (max-width: 960px) and (orientation: landscape)').matches;
}

function setThumbsCollapsed(collapsed) {
  uiEl?.classList.toggle('is-thumbs-collapsed', collapsed);
  if (thumbsToggleBtn) {
    thumbsToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    thumbsToggleBtn.title = collapsed ? '展開展區動線' : '收合展區動線';
  }
  try {
    localStorage.setItem(THUMBS_COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch (_) { /* ignore */ }
}

function updatePanelsToggleLabel(collapsed) {
  if (!panelsToggleLabelEl) return;
  const scene = getScene(currentSceneId);
  if (collapsed) {
    panelsToggleLabelEl.textContent = scene?.title
      ? `顯示資訊 · ${scene.title}`
      : '顯示資訊';
  } else {
    panelsToggleLabelEl.textContent = '收合資訊';
  }
}

function setPanelsCollapsed(collapsed, { persist = true } = {}) {
  uiEl?.classList.toggle('is-panels-collapsed', collapsed);
  if (panelsToggleBtn) {
    panelsToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    panelsToggleBtn.title = collapsed ? '顯示資訊面板' : '收合資訊面板';
  }
  updatePanelsToggleLabel(collapsed);
  if (persist) {
    try {
      localStorage.setItem(PANELS_COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch (_) { /* ignore */ }
  }
}

function syncLandscapePanels() {
  if (isCompactLandscape()) {
    if (!landscapeAutoCollapsed && !uiEl?.classList.contains('is-panels-collapsed')) {
      setPanelsCollapsed(true, { persist: false });
      setThumbsCollapsed(true);
      landscapeAutoCollapsed = true;
    }
  } else {
    landscapeAutoCollapsed = false;
  }
  updatePanelsToggleLabel(!!uiEl?.classList.contains('is-panels-collapsed'));
}

function bindThumbsToggle() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(THUMBS_COLLAPSE_KEY) === '1';
  } catch (_) { /* ignore */ }
  setThumbsCollapsed(collapsed);

  thumbsToggleBtn?.addEventListener('click', () => {
    const next = !uiEl?.classList.contains('is-thumbs-collapsed');
    setThumbsCollapsed(next);
  });
}

function bindPanelsToggle() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(PANELS_COLLAPSE_KEY) === '1';
  } catch (_) { /* ignore */ }

  if (isCompactLandscape()) {
    collapsed = true;
    landscapeAutoCollapsed = true;
    setThumbsCollapsed(true);
  }
  setPanelsCollapsed(collapsed, { persist: !isCompactLandscape() });

  panelsToggleBtn?.addEventListener('click', () => {
    const next = !uiEl?.classList.contains('is-panels-collapsed');
    setPanelsCollapsed(next);
    if (isCompactLandscape() && next) {
      setThumbsCollapsed(true);
    }
  });

  window.addEventListener('orientationchange', () => {
    window.setTimeout(syncLandscapePanels, 120);
  });
  window.addEventListener('resize', () => {
    window.setTimeout(syncLandscapePanels, 120);
  });
}

function bindControls() {
  prevBtn?.addEventListener('click', () => {
    guide?.unlockAudio();
    goAdjacent(-1);
  });
  nextBtn?.addEventListener('click', () => {
    guide?.unlockAudio();
    goAdjacent(1);
  });
  gotoNextBtn?.addEventListener('click', () => {
    guide?.unlockAudio();
    goAdjacent(1);
  });
  bindThumbsToggle();
  bindPanelsToggle();

  resetBtn?.addEventListener('click', () => {
    const scene = getScene(currentSceneId);
    if (!scene || !viewer) return;
    autorotatePlugin?.stop();
    viewer.animate({
      yaw: scene.defaultYaw,
      pitch: scene.defaultPitch,
      zoom: scene.defaultZoom ?? DEFAULT_ZOOM,
      speed: '4rpm',
    });
  });

  // 首次互動後解鎖自動語音（瀏覽器自動播放政策）
  const unlockOnce = () => guide?.unlockAudio();
  document.addEventListener('pointerdown', unlockOnce, { once: true, passive: true });
}

function resolveStartScene() {
  const params = new URLSearchParams(window.location.search);
  const sceneId = params.get('scene');
  if (sceneId && getScene(sceneId)) return getScene(sceneId);
  return scenes[0];
}

async function bootstrap() {
  try {
    const res = await fetch(STATIONS_URL);
    if (!res.ok) throw new Error(`無法載入站點設定 (${res.status})`);
    const records = await res.json();
    if (!records.length) throw new Error('尚無站點資料');

    scenesBase = records.map((r) => structuredClone(r));
    let merged = records;
    const overrides = guideApi ? guideApi.loadGuideOverrides() : null;
    if (overrides) {
      merged = guideApi.applyGuideOverrides(records, overrides);
      console.info('[雲端展間] 已套用本機文案／點位覆寫（localStorage）');
    }

    scenes = merged.map(mapStationRecord);
    if (thumbsToggleMetaEl) {
      thumbsToggleMetaEl.textContent = `${scenes.length} 站`;
    }

    const params = new URLSearchParams(window.location.search);
    const startPlace = params.get('place') === '1';
    const startPoint = params.get('point');

    initGuide();
    bindPlacePanel();
    buildThumbnailMenu();
    bindControls();
    initViewer(resolveStartScene());

    if (startPlace) {
      setPlaceMode(true, { pointId: startPoint, toast: true });
    }
  } catch (err) {
    console.error('[雲端展間]', err);
    if (loaderSubEl) loaderSubEl.textContent = err.message || '載入失敗';
  }
}

bootstrap();
