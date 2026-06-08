<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { Pipeline, Projects, VoiceLib } from './api/client.js';
import { saveLocalSession, loadLocalSession, hasSessionContent, AUTOSAVE_PROJECT } from './utils/sessionStore.js';
import { segmentTextByChars, tempUnitId } from './utils/textSegment.js';
import SettingsModal from './components/SettingsModal.vue';
import PromptManager from './components/PromptManager.vue';
import VoiceLibraryModal from './components/VoiceLibraryModal.vue';
import ModelConfigModal from './components/ModelConfigModal.vue';
import ResultPreview from './components/ResultPreview.vue';
import PromptViewer from './components/PromptViewer.vue';

const tab = ref('workflow');
const showSettings = ref(false);
const showVoice = ref(false);
const showModels = ref(false);
const toast = reactive({ show: false, type: '', msg: '' });
function showToast(type, msg) {
  toast.type = type; toast.msg = msg; toast.show = true;
  setTimeout(() => (toast.show = false), 3200);
}
function onToast(t) { showToast(t.type, t.msg); }

// ---------------- 输入 ----------------
const input = reactive({
  mode: 'narration',
  currentText: '',
  voiceLibrary: '',
  globalStyle: '',
});
const textType = computed(() => (input.mode === 'script' ? '剧本' : '解说文案'));

// ---------------- 状态 ----------------
const episodes = ref([]);
// 分集生命周期状态：'pending'=已分集未处理 / 'processing'=当前正在处理批次 / 'completed'=已完成所有流程
const episodeStatus = reactive({}); // { 0: 'completed', 1: 'processing', 2: 'pending', ... }
const assets = ref({ characters: [], scenes: [], items: [] });
const episodeAppearance = ref([]); // 每集出场清单 [{characters,scenes,items}]
const episodeAssets = ref([]); // 每集资产快照（截至该集累积），供该集分镜按需取用
const episodeStoryboard = ref([]); // 每集分镜结果（按集索引，便于增量显示）
const groupedStoryboardPerEpisode = ref([]); // 每集归并后的单元（解说模式）
// 每集步骤状态：s2=资产 / sb=分镜总 / sbSplit=拆分 / sbShots=镜头 / s4x=归并 / s4a=分类 / s4c=视频提示词
const epState = reactive({ s2: [], ready: [], sb: [], sbSplit: [], sbShots: [], s4x: [], s4a: [], s4c: [] });
const pipe = reactive({ s2Running: false });
const s2bConcurrency = ref(20);
const s2bRetries = ref(2);
const s2bRetryDelayMs = ref(2000);
const s2FailedTasks = ref([]); // [{ entityType, entityName, error, episodeIndices }]
const s2bUpdateCheckResult = ref(null); // 2a_b 更新检查结果
const sbConcurrency = ref(4);
const s4cConcurrency = ref(5);
const scriptMergeMaxSec = ref(10);
const narrationMergeMaxSec = ref(15);
const extractSelected = ref([]); // 待提取集数索引，空=自动选未提取集
const s4xSelected = ref([]); // 单元归并选中的集，空=自动模式
const s4aSelected = ref([]); // 镜头分类选中的集，空=自动模式
const s4cSelected = ref([]); // 视频提示词选中的集，空=自动模式
const sbSelected = ref([]); // 分镜选中的集，空=自动模式
const splitSettings = reactive({ maxUnitChars: 500, concurrency: 4, maxRetries: 2 });
const shotSettings = reactive({ batchSize: 5, concurrency: 4 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const analysis = ref(null);
const storyboard = ref({ storys: [] });
const groupedStoryboard = ref({ storys: [] }); // 解说模式归并后的单元
const classifications = ref([]);
const videoPrompts = ref([]);
const vpValidation = ref(null);
const sbValidation = ref(null);

const creativeOverrideSplit = ref(''); // 原文拆分创作模版
const creativeOverrideShots = ref(''); // 镜头创作模版
const creativeOverrides = reactive({}); // step4c 各类型覆盖（key->content）

// 进度
const busy = reactive({});
const progress = reactive({});
function setProg(k, cur, total) { progress[k] = { cur, total }; }

// 各节点最终发送给模型的提示词（循环步骤为多条）
const payloads = reactive({});
// 各步骤执行档案：{ ranAt, model, prompts:[{key,label,versionName}], runs }
const stepMeta = reactive({});
function recordMeta(step, meta, runs, elapsedMs) {
  stepMeta[step] = {
    ranAt: new Date().toISOString(),
    model: meta?.model || '',
    prompts: meta?.prompts || [],
    runs: runs ?? 1,
    elapsedMs: elapsedMs ?? 0,
  };
}
function recordProgramStep(step, note, elapsedMs) {
  stepMeta[step] = { ranAt: new Date().toISOString(), model: '（程序计算，无模型）', prompts: [], note, elapsedMs: elapsedMs ?? 0 };
}

// 折叠
const open = reactive({ s1: true, s2: true, s3a: true, s3b: true, s3c: true, s4: true });

// 停止标志：每个步骤独立标志，点击停止按钮时设为 true
const stopFlags = reactive({
  s1: false, s2: false, s3a: false, s3b: false, s3c: false, s3d: false,
  s4x: false, s4a: false, s4c: false, s4d: false,
});
// AbortController 注册表：每个步骤一个，用于取消正在进行的 HTTP 请求
const abortControllers = reactive({
  s1: null, s2: null, s3a: null, s3b: null, s3c: null, s3d: null,
  s4x: null, s4a: null, s4c: null, s4d: null,
});
function stopStep(k) {
  stopFlags[k] = true;
  const ac = abortControllers[k];
  if (ac) { ac.abort(); abortControllers[k] = null; }
  // 重置 running 状态为 idle，使按钮停止后不再显示运行中
  resetRunningStates(k);
}
function resetRunningStates(k) {
  const stateMap = {
    s4x: ['s4x'], s4a: ['s4a'], s4c: ['s4c'],
    s3b: ['sb', 'sbSplit', 'sbShots', 's4x'],
    s2: ['s2'],
  };
  const keys = stateMap[k] || [];
  for (const stateKey of keys) {
    if (epState[stateKey]) {
      for (let i = 0; i < epState[stateKey].length; i++) {
        if (epState[stateKey][i] === 'running') epState[stateKey][i] = 'idle';
      }
    }
  }
}
function resetStopFlag(k) { stopFlags[k] = false; }
function shouldStop(k) { return !!stopFlags[k]; }
/** 获取或创建当前步骤的 AbortController */
function getController(k) {
  if (!abortControllers[k]) abortControllers[k] = new AbortController();
  return abortControllers[k];
}
function clearController(k) { abortControllers[k] = null; }

// ---------------- 工具 ----------------
function pretty(obj) { return JSON.stringify(obj, null, 2); }
async function withBusy(k, fn) {
  busy[k] = true;
  resetStopFlag(k);
  try { await fn(); } catch (e) {
    if (shouldStop(k)) showToast('warning', '已停止运行');
    else showToast('error', e.message);
  } finally { busy[k] = false; clearController(k); }
}

// ---------------- 分集生命周期状态管理 ----------------
/** 获取当前正在处理的批次索引（processing 状态） */
function getProcessingIndices() {
  return Object.entries(episodeStatus)
    .filter(([, v]) => v === 'processing')
    .map(([k]) => Number(k));
}

/** 获取 pending 状态的集数索引 */
function getPendingIndices() {
  return Object.entries(episodeStatus)
    .filter(([, v]) => v === 'pending')
    .map(([k]) => Number(k));
}

/** 获取 completed 状态的集数索引 */
function getCompletedIndices() {
  return Object.entries(episodeStatus)
    .filter(([, v]) => v === 'completed')
    .map(([k]) => Number(k));
}

/** 检查是否有 processing 状态的集 */
function hasProcessingEpisodes() {
  return Object.values(episodeStatus).some((v) => v === 'processing');
}

/** 检查是否有未完成的集（pending 或 processing） */
function hasIncompleteEpisodes() {
  return Object.values(episodeStatus).some((v) => v === 'pending' || v === 'processing');
}

/** 将指定集标记为 processing */
function markEpisodesProcessing(indices) {
  for (const i of indices) episodeStatus[i] = 'processing';
}

/** 将指定集标记为 completed */
function markEpisodesCompleted(indices) {
  for (const i of indices) episodeStatus[i] = 'completed';
}

/** 将指定集标记为 pending */
function markEpisodesPending(indices) {
  for (const i of indices) episodeStatus[i] = 'pending';
}

/** 初始化新分集的状态（追加模式） */
function initEpisodeStatus(startIndex, count) {
  for (let i = startIndex; i < startIndex + count; i++) {
    if (!episodeStatus.hasOwnProperty(i)) episodeStatus[i] = 'pending';
  }
}

/** 重置所有 episodeStatus */
function resetEpisodeStatus() {
  Object.keys(episodeStatus).forEach((k) => delete episodeStatus[k]);
}

// ---------------- Step1 分集 ----------------
// 分集设置（按模式区分）
const segNarration = reactive({ useModel: true, maxChars: 0 });
const segScript = reactive({ useModel: true, maxChars: 0 });
// 拆分设置（按模式区分）
const splitNarration = reactive({ maxUnitChars: 500, concurrency: 10, maxRetries: 2 });
const splitScript = reactive({ maxUnitChars: 1000, concurrency: 10, maxRetries: 2 });
// 镜头设置（按模式区分）
const shotNarration = reactive({ batchSize: 10, concurrency: 10 });
const shotScript = reactive({ batchSize: 5, concurrency: 10 });
// 按集并发（按模式区分）
const sbConcurrencyNarration = ref(2);
const sbConcurrencyScript = ref(2);
// 便捷访问：当前模式的设置
function getSeg() { return input.mode === 'narration' ? segNarration : segScript; }
function getSplit() { return input.mode === 'narration' ? splitNarration : splitScript; }
function getShot() { return input.mode === 'narration' ? shotNarration : shotScript; }
function getSbC() { return input.mode === 'narration' ? sbConcurrencyNarration.value : sbConcurrencyScript.value; }

// 全局参数持久化（跨项目共享）
const GLOBAL_SETTINGS_KEY = 'video_prompt_studio_pipeline_settings';
function saveGlobalSettings() {
  try {
    localStorage.setItem(GLOBAL_SETTINGS_KEY, JSON.stringify({
      segNarration: { ...segNarration },
      segScript: { ...segScript },
      splitNarration: { ...splitNarration },
      splitScript: { ...splitScript },
      shotNarration: { ...shotNarration },
      shotScript: { ...shotScript },
      sbConcurrencyNarration: sbConcurrencyNarration.value,
      sbConcurrencyScript: sbConcurrencyScript.value,
    }));
  } catch { /* ignore */ }
}
function loadGlobalSettings() {
  try {
    const raw = localStorage.getItem(GLOBAL_SETTINGS_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (s.segNarration) Object.assign(segNarration, s.segNarration);
    if (s.segScript) Object.assign(segScript, s.segScript);
    if (s.splitNarration) Object.assign(splitNarration, s.splitNarration);
    if (s.splitScript) Object.assign(splitScript, s.splitScript);
    if (s.shotNarration) Object.assign(shotNarration, s.shotNarration);
    if (s.shotScript) Object.assign(shotScript, s.shotScript);
    if (s.sbConcurrencyNarration != null) sbConcurrencyNarration.value = s.sbConcurrencyNarration;
    if (s.sbConcurrencyScript != null) sbConcurrencyScript.value = s.sbConcurrencyScript;
    return true;
  } catch { return false; }
}
function runSegment() {
  return withBusy('s1', async () => {
    ensureProjectReady();
    if (!input.currentText.trim()) throw new Error('请先填写原文');

    // 检查是否有未完成的批次
    if (hasIncompleteEpisodes()) {
      const incomplete = Object.entries(episodeStatus)
        .filter(([, v]) => v === 'pending' || v === 'processing')
        .map(([k]) => `第${Number(k) + 1}集`);
      const confirmReplace = confirm(
        `当前有未完成的集数：${incomplete.join('、')}。\n\n分集将替换这些未完成的集数，是否继续？`
      );
      if (!confirmReplace) return;
      // 替换模式：清除未完成集的状态和数据
      for (const [k, v] of Object.entries(episodeStatus)) {
        if (v === 'pending' || v === 'processing') {
          const i = Number(k);
          delete episodeStatus[i];
          delete epState.s2[i];
          delete epState.ready[i];
          delete epState.sb[i];
          delete epState.sbSplit[i];
          delete epState.sbShots[i];
          delete epState.s4x[i];
          delete epState.s4a[i];
          delete epState.s4c[i];
          delete episodeAssets.value[i];
          delete episodeStoryboard.value[i];
          delete groupedStoryboardPerEpisode.value[i];
          if (episodeAppearance.value[i]) episodeAppearance.value[i] = null;
        }
      }
      // 清除 s2 失败任务中属于这些集的
      s2FailedTasks.value = [];
    }

    const start = Date.now();
    const ctrl = getController('s1');
    const r = await Pipeline.segment({
      text: input.currentText,
      useModel: getSeg().useModel,
      maxChars: Number(getSeg().maxChars) || 0,
    }, ctrl.signal);
    const elapsed = Date.now() - start;

    // 追加模式：新分集追加到现有 episodes 数组末尾
    const existingCount = episodes.value.length;
    episodes.value = [...episodes.value, ...r.episodes];
    // 初始化新分集的生命周期状态
    initEpisodeStatus(existingCount, r.episodes.length);

    console.log(`⏱️ 分集完成: 新增${r.episodes.length}集，累计${episodes.value.length}集 | ${elapsed}ms`);
    if (r.samplePrompt) payloads.s1 = [{ label: '批次提示词样例', text: r.samplePrompt }];
    recordMeta('step1', r.meta, r.batchCount, elapsed);
    const extra = r.batchCount ? `（${r.batchCount} 批次 / 锚点 ${r.markers ? r.markers.length : 0}）` : '';
    await autoSaveOnStepComplete('step1');
    showToast('success', `已分集：新增${r.episodes.length}集，累计${episodes.value.length}集 ${extra}`);
  });
}

// ---------------- Step2 资产提取（2a 名称 + 2b 详情并发） ----------------
/** 2b 结果串行合并队列（单条 merge 失败不拖垮后续） */
let assetMergeChain = Promise.resolve();
function enqueueAssetMerge(fn) {
  const run = assetMergeChain.then(() => fn());
  assetMergeChain = run.catch((e) => {
    console.warn('asset merge error', e);
  });
  return run;
}

function entityTaskKey(task) {
  return `${task.entityType}:${task.entityName}`;
}

/** 实体详情是否已提取完成（跳过重复 2b） */
function isEntityDetailComplete(entityType, entity) {
  if (!entity || entity._pending) return false;
  if (entityType === 'character') {
    return !!(entity.looks?.length && entity.looks.some((l) => l.ln && String(l.ld || '').trim()));
  }
  if (entityType === 'scene') {
    return !!(entity.states?.length && entity.states.some((s) => s.sn && String(s.sd || '').trim()));
  }
  if (entityType === 'item') {
    return !!(entity.variants?.length && entity.variants.some((v) => v.vn && String(v.vd || '').trim()));
  }
  return false;
}

function findEntityInAssets(entityType, name, acc = assets.value) {
  if (entityType === 'character') return acc.characters?.find((c) => c.n === name) || null;
  if (entityType === 'scene') return acc.scenes?.find((s) => s.s === name) || null;
  return acc.items?.find((i) => i.n === name) || null;
}

function dedupeTasks(tasks) {
  const map = new Map();
  for (const t of tasks) map.set(entityTaskKey(t), t);
  return [...map.values()];
}

/** 过滤已完成实体，保留待提取/失败项 */
function filterIncompleteTasks(tasks) {
  return tasks.filter((task) => {
    const ent = findEntityInAssets(task.entityType, task.entityName);
    if (isEntityDetailComplete(task.entityType, ent)) return false;
    task.existingEntity = ent || task.existingEntity || null;
    return true;
  });
}

/** 从资产库扫描未完成的 pending 实体 */
function collectPendingFromAssets(episodeIndices) {
  const tasks = [];
  const add = (entityType, entityName, existingEntity) => {
    tasks.push({ entityType, entityName, existingEntity, episodeIndices });
  };
  for (const c of assets.value.characters || []) {
    if (!isEntityDetailComplete('character', c)) add('character', c.n, c);
  }
  for (const s of assets.value.scenes || []) {
    if (!isEntityDetailComplete('scene', s)) add('scene', s.s, s);
  }
  for (const it of assets.value.items || []) {
    if (!isEntityDetailComplete('item', it)) add('item', it.n, it);
  }
  return tasks;
}

function markTaskFailed(task, error) {
  const key = entityTaskKey(task);
  const msg = error?.message || String(error);
  s2FailedTasks.value = [
    ...s2FailedTasks.value.filter((t) => entityTaskKey(t) !== key),
    { entityType: task.entityType, entityName: task.entityName, error: msg, episodeIndices: task.episodeIndices },
  ];
}

function markTaskDone(task) {
  const key = entityTaskKey(task);
  s2FailedTasks.value = s2FailedTasks.value.filter((t) => entityTaskKey(t) !== key);
}

async function callWithRetry(fn, maxRetries, delayMs, stopKey = null) {
  let lastErr;
  const max = Math.max(0, Number(maxRetries) ?? 2);
  const delay = Math.max(500, Number(delayMs) || 2000);
  for (let i = 0; i <= max; i++) {
    if (stopKey && shouldStop(stopKey)) throw new Error('用户已停止');
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (stopKey && shouldStop(stopKey)) throw new Error('用户已停止');
      const isRetryable = /500|502|503|429|timeout|aborted|API 错误/i.test(e.message || '');
      if (i < max && isRetryable) {
        await sleep(delay * (i + 1));
        continue;
      }
      if (i < max) await sleep(delay);
    }
  }
  throw lastErr;
}

async function runOne2bTask(task, indices, onMeta) {
  const start = Date.now();
  // 只传入当前正在处理的批次（processing 状态）的集数
  const processingIndices = getProcessingIndices();
  const episodesForPrompt = processingIndices.length
    ? processingIndices.map((i) => ({ title: episodes.value[i].title, text: episodes.value[i].text, episode_index: i }))
    : episodes.value.map((e, i) => ({ title: e.title, text: e.text, episode_index: i }));
  const r = await callWithRetry(
    () =>
      Pipeline.extractDetail({
        entityType: task.entityType,
        entityName: task.entityName,
        existingEntity: task.existingEntity || findEntityInAssets(task.entityType, task.entityName),
        allEpisodes: episodesForPrompt,
        newEpisodeIndices: task.episodeIndices || indices,
        voiceLibrary: input.voiceLibrary,
        textType: textType.value,
        metaInfo: assets.value.meta_info,
        existingAssets: assets.value,
      }, getController('s2').signal),
    s2bRetries.value,
    s2bRetryDelayMs.value,
    's2'
  );
  const elapsed = Date.now() - start;
  console.log(`⏱️ 2b完成: ${task.entityType}·${task.entityName} | ${elapsed}ms`);
  if (!payloads.s2) payloads.s2 = [];
  if (r.payload) payloads.s2.push({ label: `2b·${task.entityType}·${task.entityName}`, text: r.payload });
  if (r.meta) onMeta(r.meta);
  if (!r.parsed) throw new Error('模型未返回有效 JSON');
  await enqueueAssetMerge(async () => {
    const m = await Pipeline.mergeDetail({
      existingAssets: assets.value,
      entityType: task.entityType,
      entityName: task.entityName,
      parsed: r.parsed,
      episodeIndices: task.episodeIndices || indices,
    }, getController('s2').signal);
    assets.value = m.merged;
    // 按集合并 appearance（优先 per_episode_appearance，兼容旧 appearance）
    // 模型返回 1 起索引，需转为 0 起数组索引
    if (r.parsed.per_episode_appearance?.length) {
      for (const epa of r.parsed.per_episode_appearance) {
        const epIdx = (epa.episode_index ?? epa.episodeIndex ?? 0) - 1;
        if (epIdx >= 0) {
          episodeAppearance.value = mergeEpisodeAppearanceLocal(episodeAppearance.value, epIdx, {
            characters: epa.characters,
            scenes: epa.scenes,
            items: epa.items,
          });
        }
      }
    } else {
      for (const epIdx of (r.parsed.appear_episodes || task.episodeIndices || []).map(i => i - 1)) {
        if (epIdx >= 0) {
          episodeAppearance.value = mergeEpisodeAppearanceLocal(episodeAppearance.value, epIdx, r.parsed.appearance);
        }
      }
    }
    scheduleAutoSave();
  });
  markTaskDone(task);
}

async function run2bTaskPool(tasks, indices, onMeta) {
  let doneTasks = 0;
  let successCount = 0;
  const poolStart = Date.now();
  assetMergeChain = Promise.resolve();
  await runPool(tasks, Number(s2bConcurrency.value) || 20, async (task) => {
    if (shouldStop('s2')) return;
    try {
      await runOne2bTask(task, indices, onMeta);
      successCount++;
    } catch (e) {
      markTaskFailed(task, e);
    }
    doneTasks++;
    setProg('s2', doneTasks, tasks.length);
  });
  await assetMergeChain;
  const poolElapsed = Date.now() - poolStart;
  console.log(`⏱️ 2b全部完成: ${successCount}/${tasks.length}成功 | 总耗时${poolElapsed}ms | 平均${Math.round(poolElapsed / tasks.length)}ms/实体`);
  return { success: successCount, failed: s2FailedTasks.value.length, total: tasks.length };
}

function getExtractIndices() {
  if (extractSelected.value.length) return [...extractSelected.value].sort((a, b) => a - b);
  // 优先处理 processing 状态的集，其次处理 pending 状态的集
  const processing = getProcessingIndices();
  if (processing.length) return processing;
  const pending = getPendingIndices();
  if (pending.length) return pending;
  // 兼容旧逻辑：无 episodeStatus 时按 epState 判断
  return episodes.value.map((_, i) => i).filter((i) => epState.s2[i] !== 'done');
}

function collectDetailTasks(parsed, acc, episodeIndices) {
  const tasks = [];
  const seen = new Set();
  const add = (entityType, entityName) => {
    const key = `${entityType}:${entityName}`;
    if (seen.has(key)) return;
    seen.add(key);
    let existingEntity = null;
    if (entityType === 'character') existingEntity = acc.characters?.find((c) => c.n === entityName) || null;
    else if (entityType === 'scene') existingEntity = acc.scenes?.find((s) => s.s === entityName) || null;
    else existingEntity = acc.items?.find((it) => it.n === entityName) || null;
    tasks.push({ entityType, entityName, existingEntity, episodeIndices });
  };
  for (const n of parsed?.new_character_names || []) add('character', n);
  for (const n of parsed?.existing_character_updates || []) add('character', n);
  for (const n of parsed?.new_scene_names || []) add('scene', n);
  for (const n of parsed?.existing_scene_updates || []) add('scene', n);
  for (const n of parsed?.new_item_names || []) add('item', n);
  for (const n of parsed?.existing_item_updates || []) add('item', n);
  return tasks;
}

function mergeEpisodeAppearanceLocal(list, episodeIndex, appearance) {
  const arr = [...(list || [])];
  while (arr.length <= episodeIndex) arr.push(null);
  const mergeList = (a = [], b = [], variantKey) => {
    const map = new Map();
    for (const it of a || []) {
      if (typeof it === 'string') map.set(it, new Set());
      else if (it?.n) map.set(it.n, new Set(it[variantKey] || []));
    }
    for (const it of b || []) {
      if (typeof it === 'string') { if (!map.has(it)) map.set(it, new Set()); }
      else if (it?.n) {
        const set = map.get(it.n) || new Set();
        for (const v of it[variantKey] || []) set.add(v);
        map.set(it.n, set);
      }
    }
    return [...map.entries()].map(([n, set]) => ({ n, [variantKey]: set.size ? [...set] : [] }));
  };
  const prev = arr[episodeIndex] || { characters: [], scenes: [], items: [] };
  arr[episodeIndex] = {
    characters: mergeList(prev.characters, appearance?.characters, 'looks'),
    scenes: mergeList(prev.scenes, appearance?.scenes, 'states'),
    items: mergeList(prev.items, appearance?.items, 'variants'),
  };
  return arr;
}

function getEpisodeScenes(scopedAssets, appearance) {
  if (!appearance?.scenes?.length) return scopedAssets?.scenes || [];
  const names = new Set(appearance.scenes.map((s) => s.n || s.s));
  return (scopedAssets?.scenes || []).filter((s) => names.has(s.s));
}

/** ③-c/d 对照原文：优先各集正文拼接（与分镜 ct 来源一致，不含分集小标题） */
function getStoryboardBaselineText() {
  if (episodes.value?.length) {
    return episodes.value.map((e) => e.text || '').join('');
  }
  return input.currentText || '';
}

// 单集资产提取（用于全流程逐集流水线）
async function produceAssetsForEpisode(i) {
  const s2Start = Date.now();
  const ep = episodes.value[i];
  if (!ep) throw new Error(`第${i + 1}集不存在`);

  const fullText = `${ep.title || ''}\n${ep.text || ''}`;
  if (!fullText.trim()) throw new Error(`第${i + 1}集内容为空`);

  // 初始化状态数组和 payloads（不设置 busy.s2，由外层管理）
  if (epState.s2.length !== episodes.value.length) epState.s2 = Array(episodes.value.length).fill('');
  if (!payloads.s2) payloads.s2 = [];

  const hasExistingAssets = (assets.value?.characters?.length || 0) +
                            (assets.value?.scenes?.length || 0) +
                            (assets.value?.items?.length || 0) > 0;

  // 2a: 名称提取
  const namesR = await callWithRetry(
    () => Pipeline.extractNames({
      currentText: fullText,
      textType: textType.value,
      existingAssets: assets.value,
    }, getController('s2')?.signal),
    s2bRetries.value,
    s2bRetryDelayMs.value,
    's2'
  );

  // 合并资产
  assets.value = namesR.merged || assets.value;

  // 收集并执行 2b 实体提取任务
  let tasks = collectDetailTasks(namesR.parsed, assets.value, [i], null);
  tasks = filterIncompleteTasks(dedupeTasks(tasks));

  if (tasks.length) {
    await run2bTaskPool(tasks, [i], () => {});
  }

  // 标记该集资产就绪
  epState.ready[i] = true;
  epState.s2[i] = 'done';
  episodeAssets.value[i] = JSON.parse(JSON.stringify(assets.value));

  // 记录步骤元数据，使结果预览显示已执行
  recordMeta('step2', namesR.meta, tasks.length || 1, Date.now() - s2Start);
}

async function produceAssets(options = {}) {
  const s2Start = Date.now();
  const { resumeOnly = false } = options;
  const N = episodes.value.length;
  if (!N) throw new Error('请先完成分集');
  const indices = options.forceIndices ?? getExtractIndices();
  if (!indices.length && !resumeOnly) throw new Error('没有待提取的集数（可勾选集数或清除已完成标记）');

  // 标记当前处理的集为 processing
  if (!resumeOnly) markEpisodesProcessing(indices);

  pipe.s2Running = true;
  if (epState.s2.length !== N) epState.s2 = Array(N).fill('');
  if (epState.ready.length !== N) epState.ready = Array(N).fill(false);
  if (!resumeOnly) payloads.s2 = [];
  let lastMeta;

  for (const i of indices) {
    if (epState.s2[i] !== 'done') epState.s2[i] = 'running';
  }

  try {
    let tasks = [];

    if (resumeOnly) {
      tasks = dedupeTasks([
        ...s2FailedTasks.value.map((t) => ({
          entityType: t.entityType,
          entityName: t.entityName,
          existingEntity: findEntityInAssets(t.entityType, t.entityName),
          episodeIndices: t.episodeIndices || indices,
        })),
        ...collectPendingFromAssets(indices),
      ]);
    } else {
      // 只传入当前处理批次的集数原文（processing 状态）
      const processingIndices = getProcessingIndices();
      const targetIndices = processingIndices.length ? processingIndices : indices;
      const fullText = targetIndices
        .map((i) => `${episodes.value[i].title || ''}\n${episodes.value[i].text || ''}`)
        .join('\n\n');
      if (!fullText.trim()) throw new Error('请先填写原文或完成分集');

      setProg('s2', 0, 1);
      try {
        const s2aStart = Date.now();
        // 并发执行 2a 名称提取 + 2a_b 更新检查（资产非空时）
        const hasExistingAssets = (assets.value?.characters?.length || 0) +
                                  (assets.value?.scenes?.length || 0) +
                                  (assets.value?.items?.length || 0) > 0;
        const promises = [
          callWithRetry(
            () => Pipeline.extractNames({
              currentText: fullText,
              textType: textType.value,
              existingAssets: assets.value,
            }, getController('s2').signal),
            s2bRetries.value,
            s2bRetryDelayMs.value,
            's2'
          ),
        ];
        if (hasExistingAssets) {
          promises.push(
            callWithRetry(
              () => Pipeline.checkUpdates({
                currentText: fullText,
                textType: textType.value,
                existingAssets: assets.value,
              }, getController('s2').signal),
              s2bRetries.value,
              s2bRetryDelayMs.value,
              's2'
            ).catch((e) => {
              console.warn('⚠️ 2a_b 更新检查失败:', e.message);
              return { parsed: { existing_character_updates: [], existing_scene_updates: [], existing_item_updates: [] } };
            })
          );
        }

        const results = await Promise.all(promises);
        const namesR = results[0];
        const updateCheckR = results[1] || null;
        const s2aElapsed = Date.now() - s2aStart;
        console.log(`⏱️ 2a名称提取完成: ${s2aElapsed}ms`);
        if (updateCheckR) {
          s2bUpdateCheckResult.value = updateCheckR.parsed;
          console.log(`⏱️ 2a_b更新检查完成: 角色${updateCheckR.parsed?.existing_character_updates?.length || 0}个, 场景${updateCheckR.parsed?.existing_scene_updates?.length || 0}个, 物品${updateCheckR.parsed?.existing_item_updates?.length || 0}个`);
        } else {
          s2bUpdateCheckResult.value = null;
        }
        if (namesR.payload) payloads.s2.push({ label: `2a·名称提取（第${targetIndices.map((i) => i + 1).join('、')}集）`, text: namesR.payload });
        if (updateCheckR?.payload) payloads.s2.push({ label: `2a_b·更新检查（第${targetIndices.map((i) => i + 1).join('、')}集）`, text: updateCheckR.payload });
        lastMeta = namesR.meta;
        assets.value = namesR.merged || assets.value;
        tasks = collectDetailTasks(namesR.parsed, assets.value, indices, updateCheckR);
      } catch (e) {
        showToast('warning', `2a 失败（${e.message}），将跳过并仅继续未完成的实体`);
        tasks = collectPendingFromAssets(indices);
      }
    }

    tasks = filterIncompleteTasks(dedupeTasks(tasks));
    if (!tasks.length) {
      for (const i of indices) {
        if (s2FailedTasks.value.length === 0) {
          epState.ready[i] = true;
          epState.s2[i] = 'done';
          episodeAssets.value[i] = JSON.parse(JSON.stringify(assets.value));
        }
      }
      if (!resumeOnly) markEpisodesCompleted(indices);
      return { ok: true, failed: 0, skipped: true };
    }

    setProg('s2', 0, tasks.length);
    const { failed, total, success } = await run2bTaskPool(tasks, indices, (m) => (lastMeta = m));

    for (const i of indices) {
      if (failed === 0) {
        epState.ready[i] = true;
        epState.s2[i] = 'done';
      } else {
        epState.s2[i] = 'partial';
        epState.ready[i] = false;
      }
      episodeAssets.value[i] = JSON.parse(JSON.stringify(assets.value));
    }
    // 标记完成状态
    if (failed === 0) markEpisodesCompleted(indices);
    if (lastMeta) {
      const s2Elapsed = Date.now() - s2Start;
      recordMeta('step2', lastMeta, tasks.length, s2Elapsed);
    }
    scheduleAutoSave();
    return { ok: failed === 0, failed, total, success };
  } catch (e) {
    for (const i of indices) {
      if (epState.s2[i] === 'running') epState.s2[i] = 'error';
    }
    throw e;
  } finally {
    pipe.s2Running = false;
  }
}

function runExtract() {
  return withBusy('s2', async () => {
    const r = await produceAssets({ resumeOnly: false });
    await autoSaveOnStepComplete('step2');
    if (r.skipped) {
      showToast('success', '所有实体均已提取完成，无需重复运行');
    } else if (r.failed) {
      showToast('warning', `部分完成：${r.success}/${r.total} 个实体成功，${r.failed} 个失败，可点「继续未完成」`);
    } else {
      showToast('success', `资产提取完成：角色${assets.value.characters.length}/场景${assets.value.scenes.length}/物品${assets.value.items.length}`);
    }
  });
}

function runExtractContinue() {
  withBusy('s2', async () => {
    if (!s2FailedTasks.value.length && !collectPendingFromAssets(getExtractIndices()).length) {
      showToast('error', '没有未完成的实体');
      return;
    }
    const r = await produceAssets({ resumeOnly: true, forceIndices: episodes.value.map((_, i) => i) });
    await autoSaveOnStepComplete('step2');
    if (r.failed) {
      showToast('warning', `仍有 ${r.failed} 个实体失败，可稍后再次继续`);
    } else {
      showToast('success', `未完成实体已全部补全：角${assets.value.characters.length}/景${assets.value.scenes.length}/物${assets.value.items.length}`);
    }
  });
}

function localMergeStoryboards(parts) {
  const storys = [];
  let id = 1;
  for (let pi = 0; pi < parts.length; pi++) {
    const p = parts[pi];
    for (const u of p?.storys || []) storys.push({ ...u, id: id++, episodeIndex: pi });
  }
  return { storys };
}
function rebuildStoryboard() {
  const parts = episodeStoryboard.value.filter(Boolean);
  storyboard.value = localMergeStoryboards(parts);
}

/** 本集资产是否可跑分镜（不依赖内存里 ready 数组是否曾写入） */
function isEpisodeAssetReady(i) {
  return !!(epState.ready[i] || episodeAssets.value[i] || epState.s2[i] === 'done');
}

/** 根据已有数据同步「可运行」标记（刷新页面/读项目/旧版提取后点分镜） */
function syncEpisodeReady() {
  const N = episodes.value.length;
  if (!N) return;
  if (epState.ready.length !== N) epState.ready = Array(N).fill(false);
  const step2Done = !!stepMeta.step2?.ranAt;
  for (let i = 0; i < N; i++) {
    if (episodeAssets.value[i] || episodeAppearance.value[i] || epState.s2[i] === 'done') {
      epState.ready[i] = true;
    } else if (step2Done && assets.value?.characters?.length) {
      // 兼容：本会话已提取资产但未写入 per-episode 快照
      epState.ready[i] = true;
      if (!episodeAssets.value[i]) episodeAssets.value[i] = assets.value;
    }
  }
}

/** 有限并发执行（真正并行发起多个 HTTP 请求） */
async function runPool(items, limit, fn, stopKey = null) {
  const queue = [...items];
  const n = Math.max(1, Math.min(limit, queue.length));
  const workers = Array.from({ length: n }, async () => {
    while (queue.length) {
      if (stopKey && shouldStop(stopKey)) { queue.length = 0; break; }
      const item = queue.shift();
      if (item === undefined) break;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// ---------------- Step3b 分镜创作（消费者：按集并发，资产就绪即跑，完成即显示） ----------------
async function consumeStoryboards() {
  const sbStart = Date.now();
  const N = episodes.value.length;
  const selected = sbSelected.value;
  const hasSelection = selected.length > 0;
  syncEpisodeReady();

  // 初始化未初始化的状态
  if (epState.sb.length !== N) {
    epState.sb = Array(N).fill('');
    epState.sbSplit = Array(N).fill('');
    epState.sbShots = Array(N).fill('');
  }

  // 勾选模式：清除勾选集的旧数据
  if (hasSelection) {
    for (const i of selected) {
      episodeStoryboard.value[i] = null;
      groupedStoryboardPerEpisode.value[i] = null;
      epState.sb[i] = '';
      epState.sbSplit[i] = '';
      epState.sbShots[i] = '';
    }
    rebuildStoryboard();
  }

  // 清空 payloads（只记录本次运行的）
  payloads.s3b = [];
  let lastMeta;

  // 查找可运行的集
  const findReady = () => {
    const ready = [];
    for (let i = 0; i < N; i++) {
      if (hasSelection && !selected.includes(i)) continue;
      // 自动模式：跳过已完成的集
      if (!hasSelection && epState.sb[i] === 'done') continue;
      if (!isEpisodeAssetReady(i)) continue;
      if (epState.sb[i] === 'running') continue;
      ready.push(i);
    }
    return ready;
  };

  let readyIndices = findReady();
  if (!readyIndices.length) {
    // 检查是否有资产未就绪的
    const hasBlocked = episodes.value.some((_, i) => {
      if (hasSelection && !selected.includes(i)) return false;
      return !isEpisodeAssetReady(i) && epState.sb[i] !== 'done';
    });
    if (hasBlocked && !pipe.s2Running) {
      showToast('warning', hasSelection ? '勾选的集资产尚未就绪' : '没有可生成分镜的新剧集（资产尚未提取或已全部完成）');
    }
    return;
  }

  const limit = Math.max(1, Math.min(Number(getSbC()) || 4, N));

  // 资产还在提取中：轮询就绪集合并发跑（流水线）
  if (pipe.s2Running) {
    while (readyIndices.length || pipe.s2Running) {
      if (readyIndices.length) {
        await runPool(readyIndices, limit, (i) => runOneStoryboard(i, (m) => (lastMeta = m)), 's3b');
      }
      if (shouldStop('s3b')) break;
      if (hasSelection) break;
      syncEpisodeReady();
      readyIndices = findReady();
      if (!readyIndices.length && !pipe.s2Running) break;
      if (!readyIndices.length) await sleep(300);
    }
  } else {
    // 资产提取已完成，但可能还有集未就绪（如 2b 合并队列还在跑），需要轮询直到所有集都处理完
    while (readyIndices.length) {
      await runPool(readyIndices, limit, (i) => runOneStoryboard(i, (m) => (lastMeta = m)), 's3b');
      if (shouldStop('s3b')) break;
      if (hasSelection) break;
      syncEpisodeReady();
      readyIndices = findReady();
      if (!readyIndices.length) break;
      await sleep(300);
    }
  }

  recordMeta('step3b', lastMeta, N, Date.now() - sbStart);
}

async function runOneStoryboard(i, onMeta) {
  const sbStart = Date.now();
  epState.sb[i] = 'running';
  epState.sbSplit[i] = 'running';
  epState.sbShots[i] = '';
  epState.s4x[i] = '';
  if (!payloads.s3b) payloads.s3b = [];
  try {
    const scopedAssets = episodeAssets.value[i] || assets.value;
    const appearance = episodeAppearance.value[i] || null;
    const epTitle = episodes.value[i].title || `第${i + 1}集`;
    const episodeText = episodes.value[i].text;
    const maxUnitChars = Number(getSplit().maxUnitChars) || 500;
    const chunks = segmentTextByChars(episodeText, maxUnitChars);
    const chunkUnitsStore = new Array(chunks.length);
    const shotMap = new Map();
    let shotsChain = Promise.resolve();
    let anySplitForced = false;

    const rebuildPartial = () => {
      const storys = [];
      let globalId = 1;
      for (let ci = 0; ci < chunkUnitsStore.length; ci++) {
        if (!chunkUnitsStore[ci]) continue;
        for (const u of chunkUnitsStore[ci]) {
          const groupedUnits = shotMap.get(u.id);
          if (groupedUnits && groupedUnits.length > 0) {
            for (const gu of groupedUnits) {
              storys.push({
                id: globalId++,
                loc: gu.loc || u.loc || { n: '', v: '' },
                ct: gu.ct || u.ct,
                shots: gu.shots || [],
                totalTime: gu.totalTime
              });
            }
          } else {
            storys.push({
              id: globalId++,
              loc: u.loc || { n: '', v: '' },
              ct: u.ct,
              shots: []
            });
          }
        }
      }
      episodeStoryboard.value[i] = { storys };
      rebuildStoryboard();
    };

    const runShotsForUnits = async (units) => {
      if (!units.length) return;
      epState.sbShots[i] = 'running';
      const batchSize = input.mode === 'script' ? 1 : Math.max(1, Number(getShot().batchSize) || 5);
      const batches = [];
      for (let j = 0; j < units.length; j += batchSize) batches.push(units.slice(j, j + batchSize));

      await runPool(batches, Number(getShot().concurrency) || 4, async (batch) => {
        if (shouldStop('s3b')) return;
        const r = await Pipeline.createShots({
          mode: input.mode,
          units: batch,
          assets: scopedAssets,
          appearance,
          analysis: analysis.value,
          creativeOverride: creativeOverrideShots.value,
          episodeText: episodeText || '',
          scriptMergeMaxSec: scriptMergeMaxSec.value,
          narrationMergeMaxSec: narrationMergeMaxSec.value,
        }, getController('s3b').signal);
        if (r.payload) {
          payloads.s3b.push({
            label: input.mode === 'script' ? `${epTitle}·场次${batch[0]?.id}镜头` : `${epTitle}·镜头·${batch[0]?.id}-${batch[batch.length - 1]?.id}`,
            text: r.payload,
          });
        }
        if (r.meta) onMeta?.(r.meta);
        for (const s of r.storys || []) {
          const sid = (input.mode === 'script' && s.originalSceneId) ? s.originalSceneId : s.id;
          if (!shotMap.has(sid)) shotMap.set(sid, []);
          shotMap.get(sid).push(s);
        }
        rebuildPartial();
      });
    };

    if (input.mode === 'script') {
      epState.sbSplit[i] = 'running';
      const splitR = await Pipeline.splitStoryboard({
        mode: 'script',
        episodeText,
        scenes: getEpisodeScenes(scopedAssets, appearance),
        analysis: analysis.value,
        creativeOverride: creativeOverrideSplit.value,
      }, getController('s3b').signal);

      for (const p of splitR.payloads || []) {
        payloads.s3b.push({ label: `${epTitle}·拆分`, text: p.text || p });
      }
      if (splitR.meta) onMeta?.(splitR.meta);
      epState.sbSplit[i] = 'done';

      const units = (splitR.units || []).map((u) => ({
        id: u.id,
        ct: u.ct,
      }));
      chunkUnitsStore.length = 1;
      chunkUnitsStore[0] = units;

      await runShotsForUnits(units);
    } else {
      // Narration mode
      await runPool(
        chunks.map((text, ci) => ({ text, ci })),
        Number(getSplit().concurrency) || 4,
        async ({ text, ci }) => {
          if (shouldStop('s3b')) return;
          const splitR = await Pipeline.splitChunk({
            mode: input.mode,
            chunkText: text,
            chunkIndex: ci,
            scenes: getEpisodeScenes(scopedAssets, appearance),
            maxUnitChars,
            maxRetries: Number(getSplit().maxRetries) ?? 2,
            analysis: analysis.value,
            creativeOverride: creativeOverrideSplit.value,
          }, getController('s3b').signal);
          for (const p of splitR.payloads || []) {
            payloads.s3b.push({ label: `${epTitle}·拆分·段${ci + 1}`, text: p.text || p });
          }
          if (splitR.meta) onMeta?.(splitR.meta);
          if (splitR.forced) anySplitForced = true;

          const units = (splitR.units || []).map((u) => ({
            id: tempUnitId(ci, u.id),
            loc: u.loc,
            ct: u.ct,
          }));
          chunkUnitsStore[ci] = units;

          shotsChain = shotsChain.then(() => runShotsForUnits(units));
        }
      );

      await shotsChain;
    }

    const sbElapsed = Date.now() - sbStart;
    console.log(`⏱️ 分镜完成: 第${i + 1}集 | ${sbElapsed}ms`);
    
    // 我们不再在这里执行归并，而是留给 Step 4x 去执行，以免覆盖原始分镜数据
    if (input.mode !== 'script') {
      epState.sbSplit[i] = anySplitForced ? 'partial' : 'done';
    }
    epState.sbShots[i] = 'done';
    epState.sb[i] = 'done';
    scheduleAutoSave();

    if (input.mode !== 'script' && anySplitForced) {
      showToast('warning', `第${i + 1}集部分段落拆分校验未通过，已强制继续镜头创作`);
    }
  } catch (e) {
    epState.sb[i] = 'error';
    if (epState.sbSplit[i] !== 'done' && epState.sbSplit[i] !== 'partial') epState.sbSplit[i] = 'error';
    if (epState.sbShots[i] !== 'done') epState.sbShots[i] = 'error';
    if (epState.s4x[i] === 'running') epState.s4x[i] = 'error';
    showToast('error', `第${i + 1}集分镜失败：${e.message}`);
    throw e;
  }
}

// 智能运行：资产未全就绪且未在跑则自动启动生产者，与分镜消费者并发流水线
function runStoryboard() {
  return withBusy('s3b', async () => {
    const N = episodes.value.length;
    if (!N) throw new Error('请先完成分集');
    syncEpisodeReady();
    const allReady = epState.ready.length === N && epState.ready.every(Boolean);
    const producerP = !allReady && !pipe.s2Running ? produceAssets() : null;
    const consumerP = consumeStoryboards();
    await Promise.all([producerP, consumerP].filter(Boolean));
    await autoSaveOnStepComplete('step3b');
    showToast('success', `分镜完成：${storyboard.value.storys.length} 个单元`);
  });
}

// ---------------- 一键全流程自动化运行（逐集流水线） ----------------
const fullPipelineRunning = ref(false);
const fullPipelineStop = ref(false);

// 逐集 Step3b：只负责生成本集分镜
async function runEpisodeStep3b(i) {
  const ep = episodes.value[i];
  if (!ep) return;

  // Step3a: 类型分析由 runFullPipeline 外层统一处理，此处仅作兜底（防止并发重复调用）
  if (!analysis.value && !busy.s3a) {
    await runAnalyze();
  } else if (!analysis.value && busy.s3a) {
    // 等待正在运行的类型分析完成
    while (busy.s3a) await sleep(200);
  }

  if (epState.sb[i] !== 'done') {
    const sbStart = Date.now();
    let sbMeta = null;
    await runOneStoryboard(i, (m) => { if (m) sbMeta = m; });
    rebuildStoryboard();
    recordMeta('step3b', sbMeta, episodeStoryboard.value[i]?.storys?.length || 1, Date.now() - sbStart);
  }
}

// 逐集 Step4：本集 Step3b 完成后即可进入下游，不占用 Step3b 按集并发名额
async function runEpisodeStep4(i) {
  const ep = episodes.value[i];
  if (!ep) return;

  // Step4x: 单元归并
  if (epState.s4x[i] !== 'done') {
    epState.s4x[i] = 'running';
    try {
      const epSb = episodeStoryboard.value[i];
      const r = await Pipeline.groupUnits({
        storyboard: epSb,
        episodeCount: 1,
        mode: input.mode,
        maxSec: input.mode === 'script' ? scriptMergeMaxSec.value : 15
      }, getController('s4x')?.signal);
      
      groupedStoryboardPerEpisode.value[i] = r.grouped;
      epState.s4x[i] = 'done';
      
      const allStorys = [];
      for (const ep of groupedStoryboardPerEpisode.value) {
        if (ep && ep.storys) allStorys.push(...ep.storys);
      }
      groupedStoryboard.value = { storys: allStorys };
    } catch (e) {
      epState.s4x[i] = 'error';
      throw e;
    }
  }

  // Step4a: 镜头分类
  if (epState.s4a[i] !== 'done') {
    epState.s4a[i] = 'running';
    const s4aStart = Date.now();
    try {
      const sb = groupedStoryboardPerEpisode.value[i];
      const r = await Pipeline.classify({ storyboard: sb, mode: input.mode }, getController('s4a')?.signal);
      for (const c of r.parsed) classifications.value.push(c);
      if (!payloads.s4a) payloads.s4a = [];
      if (r.payload) payloads.s4a.push({ label: `第${i + 1}集·镜头分类`, text: r.payload });
      recordMeta('step4a', r.meta, r.parsed?.length || 1, Date.now() - s4aStart);
      epState.s4a[i] = 'done';
    } catch (e) {
      epState.s4a[i] = 'error';
      throw e;
    }
  }

  // Step4c: 生成视频提示词
  if (epState.s4c[i] !== 'done') {
    epState.s4c[i] = 'running';
    const s4cStart = Date.now();
    try {
      const sb = groupedStoryboardPerEpisode.value[i];
      if (!sb) throw new Error(`第${i + 1}集分镜数据不存在，无法生成视频提示词`);
      const scopedAssets = episodeAssets.value[i] || assets.value;
      const units = sb.storys || [];

      // 确保分类已就绪
      const typeMap = new Map(classifications.value.map((c) => [c.unit_id, c.type]));
      const missingUnits = units.filter((u) => !typeMap.has(u.id));
      if (missingUnits.length) {
        const r = await Pipeline.classify({ storyboard: { storys: missingUnits }, mode: input.mode }, getController('s4a')?.signal);
        for (const c of r.parsed) {
          classifications.value.push(c);
          typeMap.set(c.unit_id, c.type);
        }
      }

      // 并发生成视频提示词
      const out = new Array(units.length);
      const payloadsOut = new Array(units.length);
      let lastMeta = null;
      let doneCount = 0;
      await runPool(
        units.map((u, j) => ({ u, j })),
        Number(s4cConcurrency.value) || 5,
        async ({ u, j }) => {
          if (fullPipelineStop.value) return;
          const unitText = Array.isArray(u.ct) ? u.ct.join('\n') : (u.ct || '');
          const r = await Pipeline.video({
            mode: input.mode,
            unit: u,
            type: typeMap.get(u.id) || '基础文戏',
            frozen: null,
            assets: scopedAssets,
            n: j + 1,
            creativeOverrides,
            episodeText: episodes.value[i]?.text || '',
            unitEpisodeIndex: i + 1,
            unitText,
          }, getController('s4c')?.signal);
          out[j] = r.parsed;
          if (r.meta) lastMeta = r.meta;
          if (r.payload) {
            payloadsOut[j] = { label: `第${i + 1}集·单元${j + 1}（${typeMap.get(u.id) || '基础文戏'}）`, text: r.payload };
          }
          doneCount++;
        },
        's4c'
      );
      // 按原始顺序追加结果
      for (let j = 0; j < units.length; j++) {
        if (out[j]) videoPrompts.value.push({ ...out[j], episodeIndex: i });
        if (payloadsOut[j]) {
          if (!payloads.s4c) payloads.s4c = [];
          payloads.s4c.push(payloadsOut[j]);
        }
      }
      epState.s4c[i] = 'done';
      recordMeta('step4c', lastMeta, units.length, Date.now() - s4cStart);
    } catch (e) {
      epState.s4c[i] = 'error';
      throw e;
    }
  }
}

async function runFullPipeline() {
  if (fullPipelineRunning.value) return;
  if (!input.currentText.trim()) {
    showToast('error', '请先填写原文');
    return;
  }

  fullPipelineRunning.value = true;
  fullPipelineStop.value = false;
  try {
    // Step1: 分集（如果已有分集则跳过）
    if (!episodes.value.length) {
      console.log('[全流程] Step1: 分集');
      await runSegment();
    } else {
      console.log('[全流程] Step1: 已有分集，跳过');
    }
    if (fullPipelineStop.value) { showToast('warning', '全流程已停止'); return; }

    // 分集后重新获取集数
    const N = episodes.value.length;
    if (!N) { showToast('error', '分集失败，没有获得分集数据'); return; }

    // Step2: 资产提取（全局统一执行，2a 拼接所有集文本跑一次）
    console.log('[全流程] Step2: 资产提取');
    try {
      // 强制对所有集进行资产提取
      await produceAssets({ forceIndices: episodes.value.map((_, i) => i) });
    } catch (e) {
      showToast('error', `资产提取失败: ${e.message}`);
      return;
    }
    if (fullPipelineStop.value) { showToast('warning', '全流程已停止'); return; }

    // Step3a: 类型分析（全局只需一次，提前运行）
    if (!analysis.value) {
      console.log('[全流程] Step3a: 类型分析');
      await runAnalyze();
    } else {
      console.log('[全流程] Step3a: 已分析，跳过');
    }
    if (fullPipelineStop.value) { showToast('warning', '全流程已停止'); return; }

    // Step3b 独立按集并发；任一集 Step3b 完成后，立即触发该集 Step4 下游
    const concurrency = Math.max(1, Math.min(Number(getSbC()) || 2, N));
    console.log(`[全流程] Step3b 按集并发启动，并发数: ${concurrency}`);

    // 初始化 AbortController
    getController('s4x');
    getController('s4a');
    getController('s4c');

    // 初始化 payloads
    if (!payloads.s3b) payloads.s3b = [];
    if (!payloads.s4c) payloads.s4c = [];

    const s3Running = new Set();
    const s3Completed = new Set();
    const s3Failed = new Set();
    const s4Running = new Set();
    const s4Completed = new Set();
    const s4Failed = new Set();

    const runS4 = async (i) => {
      if (fullPipelineStop.value) return;
      s4Running.add(i);
      try {
        console.log(`[全流程] 第${i + 1}集 Step4 开始`);
        await runEpisodeStep4(i);
        s4Completed.add(i);
        console.log(`[全流程] 第${i + 1}集 Step4 完成`);
      } catch (e) {
        s4Failed.add(i);
        console.error(`[全流程] 第${i + 1}集 Step4 失败:`, e.message, e.stack);
      } finally {
        s4Running.delete(i);
      }
    };

    const runS3 = async (i) => {
      if (fullPipelineStop.value) return;
      try {
        console.log(`[全流程] 第${i + 1}集 Step3b 开始`);
        await runEpisodeStep3b(i);
        s3Completed.add(i);
        console.log(`[全流程] 第${i + 1}集 Step3b 完成，触发 Step4`);
        runS4(i); // 不 await，Step4 与后续 Step3b 并行
      } catch (e) {
        s3Failed.add(i);
        console.error(`[全流程] 第${i + 1}集 Step3b 失败:`, e.message, e.stack);
      } finally {
        s3Running.delete(i);
      }
    };

    // Step3b 队列：只用 concurrency 控制正在跑的 Step3b 集数；完成一个立即补下一集
    while (s3Completed.size + s3Failed.size < N) {
      if (fullPipelineStop.value) break;

      for (let i = 0; i < N; i++) {
        if (s3Running.has(i) || s3Completed.has(i) || s3Failed.has(i)) continue;
        if (s3Running.size >= concurrency) break;

        s3Running.add(i);
        runS3(i); // 不 await，立即返回，保持 Step3b 按集并发补位
      }

      await sleep(300);
    }

    // Step3b 队列结束后，等待已触发的 Step4 全部收尾
    while (s4Running.size > 0) {
      if (fullPipelineStop.value) break;
      await sleep(300);
    }
    console.log(`[全流程] Step3b完成=${s3Completed.size}, Step3b失败=${s3Failed.size}, Step4完成=${s4Completed.size}, Step4失败=${s4Failed.size}, N=${N}`);

    if (fullPipelineStop.value) {
      showToast('warning', `全流程已停止，Step3b 完成 ${s3Completed.size}/${N} 集，Step4 完成 ${s4Completed.size}/${N} 集`);
    } else if (s3Failed.size > 0 || s4Failed.size > 0) {
      showToast('warning', `全流程完成，Step3b 成功 ${s3Completed.size} 集、失败 ${s3Failed.size} 集；Step4 成功 ${s4Completed.size} 集、失败 ${s4Failed.size} 集`);
    } else {
      showToast('success', `全流程自动化运行完成！${N} 集全部完成`);
    }
  } catch (e) {
    showToast('error', `全流程运行出错：${e.message}`);
  } finally {
    fullPipelineRunning.value = false;
    fullPipelineStop.value = false;
  }
}
function stopFullPipeline() {
  fullPipelineStop.value = true;
  // 同时停止当前正在运行的子步骤
  if (busy.s1) stopStep('s1');
  if (busy.s2) stopStep('s2');
  if (busy.s3a) stopStep('s3a');
  if (busy.s3b) stopStep('s3b');
  if (busy.s4x) stopStep('s4x');
  if (busy.s4a) stopStep('s4a');
  if (busy.s4c) stopStep('s4c');
}

// ---------------- Step3a 类型分析 ----------------
function runAnalyze() {
  return withBusy('s3a', async () => {
    if (shouldStop('s3a')) return;
    const start = Date.now();
    const r = await Pipeline.analyze({ fullText: input.currentText, metaInfo: assets.value.meta_info }, getController('s3a').signal);
    analysis.value = r.parsed;
    if (r.payload) payloads.s3a = [{ label: '类型分析', text: r.payload }];
    recordMeta('step3a', r.meta, 1, Date.now() - start);
    await autoSaveOnStepComplete('step3a');
    showToast('success', `推荐策略：${r.parsed.recommended_strategy}`);
  });
}

// ---------------- Step4x 解说模式单元归并 ----------------
function runGroupUnits() {
  return withBusy('s4x', async () => {
    const start = Date.now();
    const N = episodes.value.length;
    const selected = s4xSelected.value;
    const hasSelection = selected.length > 0;

    // 查找可运行的集
    const findReady = () => {
      const ready = [];
      for (let i = 0; i < N; i++) {
        // 勾选模式：只处理勾选的集（覆盖模式，不管是否 done）
        if (hasSelection && !selected.includes(i)) continue;
        // 自动模式：跳过已完成的集
        if (!hasSelection && epState.s4x[i] === 'done') continue;
        const epSb = episodeStoryboard.value[i];
        if (epSb && epSb.storys && epSb.storys.length > 0) ready.push(i);
      }
      return ready;
    };

    let readyIndices = findReady();
    if (!readyIndices.length) {
      showToast('warning', hasSelection ? '勾选的集没有可归并的分镜数据' : '没有可归并的新剧集（上游分镜尚未完成或已全部归并）');
      return;
    }

    // 轮询处理（支持运行中上游新增）
    while (readyIndices.length) {
      for (const i of readyIndices) {
        if (shouldStop('s4x')) break;
        epState.s4x[i] = 'running';
        const epSb = episodeStoryboard.value[i];
        const r = await Pipeline.groupUnits({
          storyboard: epSb,
          episodeCount: 1,
          mode: input.mode,
          maxSec: input.mode === 'script' ? scriptMergeMaxSec.value : 15
        }, getController('s4x').signal);
        groupedStoryboardPerEpisode.value[i] = r.grouped;
        epState.s4x[i] = 'done';

        // 立即合并全局结果
        const allStorys = [];
        for (const ep of groupedStoryboardPerEpisode.value) {
          if (ep && ep.storys) allStorys.push(...ep.storys);
        }
        groupedStoryboard.value = { storys: allStorys };
      }

      if (shouldStop('s4x')) break;
      await sleep(1000);
      readyIndices = findReady();
    }

    recordProgramStep('step4x', `归并完成`, Date.now() - start);
    await autoSaveOnStepComplete('step4x');
    showToast('success', '单元归并完成');
  });
}

function runClassify() {
  return withBusy('s4a', async () => {
    const start = Date.now();
    const N = episodes.value.length;
    const selected = s4aSelected.value;
    const hasSelection = selected.length > 0;

    const findReady = () => {
      const ready = [];
      for (let i = 0; i < N; i++) {
        if (hasSelection && !selected.includes(i)) continue;
        if (!hasSelection && epState.s4a[i] === 'done') continue;
        const sb = (input.mode === 'narration' || input.mode === 'script') ? groupedStoryboardPerEpisode.value[i] : episodeStoryboard.value[i];
        if (sb && sb.storys && sb.storys.length > 0) ready.push(i);
      }
      return ready;
    };

    let readyIndices = findReady();
    if (!readyIndices.length) {
      showToast('warning', hasSelection ? '勾选的集没有可分类的数据' : '没有可分类的新剧集（上游尚未完成或已全部分类）');
      return;
    }

    // 自动模式：先清除待运行集的旧分类数据，避免重复
    if (!hasSelection) {
      const unitIdsToRemove = new Set();
      for (const i of readyIndices) {
        const sb = (input.mode === 'narration' || input.mode === 'script') ? groupedStoryboardPerEpisode.value[i] : episodeStoryboard.value[i];
        if (sb && sb.storys) {
          for (const u of sb.storys) unitIdsToRemove.add(u.id);
        }
      }
      if (unitIdsToRemove.size) {
        classifications.value = classifications.value.filter((c) => !unitIdsToRemove.has(c.unit_id));
      }
    } else {
      // 勾选模式：先清除勾选集的旧分类数据
      const unitIdsToRemove = new Set();
      for (const i of selected) {
        const sb = (input.mode === 'narration' || input.mode === 'script') ? groupedStoryboardPerEpisode.value[i] : episodeStoryboard.value[i];
        if (sb && sb.storys) {
          for (const u of sb.storys) unitIdsToRemove.add(u.id);
        }
      }
      classifications.value = classifications.value.filter((c) => !unitIdsToRemove.has(c.unit_id));
    }

    while (readyIndices.length) {
      for (const i of readyIndices) {
        if (shouldStop('s4a')) break;
        epState.s4a[i] = 'running';
        const sb = (input.mode === 'narration' || input.mode === 'script') ? groupedStoryboardPerEpisode.value[i] : episodeStoryboard.value[i];
        const r = await Pipeline.classify({ storyboard: sb, mode: input.mode }, getController('s4a').signal);
        for (const c of r.parsed) classifications.value.push(c);
        epState.s4a[i] = 'done';
      }

      if (shouldStop('s4a')) break;
      if (hasSelection) break;
      await sleep(1000);
      readyIndices = findReady();
    }

    if (classifications.value.length) payloads.s4a = [{ label: '镜头分类', text: JSON.stringify(classifications.value, null, 2) }];
    recordMeta('step4a', { model: classifications.value[0]?.model }, classifications.value.length, Date.now() - start);
    await autoSaveOnStepComplete('step4a');
    showToast('success', `镜头分类完成：${classifications.value.length} 条`);
  });
}

// ---------------- Step4c 视频提示词（按集循环） ----------------
function runVideo() {
  return withBusy('s4c', async () => {
    const start = Date.now();
    const N = episodes.value.length;
    const selected = s4cSelected.value;
    const hasSelection = selected.length > 0;
    payloads.s4c = [];
    let lastMeta;

    const findReady = () => {
      const ready = [];
      for (let i = 0; i < N; i++) {
        if (hasSelection && !selected.includes(i)) continue;
        if (!hasSelection && epState.s4c[i] === 'done') continue;
        const sb = (input.mode === 'narration' || input.mode === 'script') ? groupedStoryboardPerEpisode.value[i] : episodeStoryboard.value[i];
        if (sb && sb.storys && sb.storys.length > 0) ready.push(i);
      }
      return ready;
    };

    let readyIndices = findReady();
    if (!readyIndices.length) {
      showToast('warning', hasSelection ? '勾选的集没有可生成视频提示词的数据' : '没有可生成视频提示词的新剧集（上游尚未完成或已全部生成）');
      return;
    }

    // 勾选模式：先清除勾选集的旧提示词数据
    if (hasSelection) {
      videoPrompts.value = videoPrompts.value.filter((vp) => !selected.includes(vp.episodeIndex));
    }

    while (readyIndices.length) {
      for (const i of readyIndices) {
        if (shouldStop('s4c')) break;
        epState.s4c[i] = 'running';
        const sb = (input.mode === 'narration' || input.mode === 'script') ? groupedStoryboardPerEpisode.value[i] : episodeStoryboard.value[i];
        if (!sb || !sb.storys || !sb.storys.length) { epState.s4c[i] = 'done'; continue; }

        // 确保分类已就绪
        const typeMap = new Map(classifications.value.map((c) => [c.unit_id, c.type]));
        const units = sb.storys;
        const missingUnits = units.filter((u) => !typeMap.has(u.id));
        if (missingUnits.length) {
          const r = await Pipeline.classify({ storyboard: { storys: missingUnits }, mode: input.mode }, getController('s4c').signal);
          for (const c of r.parsed) {
            classifications.value.push(c);
            typeMap.set(c.unit_id, c.type);
          }
        }

        const out = new Array(units.length);
        let doneCount = 0;

        // 使用对应集数的资产
        const scopedAssets = episodeAssets.value[i] || assets.value;

        await runPool(
          units.map((u, j) => ({ u, j })),
          Number(s4cConcurrency.value) || 5,
          async ({ u, j }) => {
            if (shouldStop('s4c')) return;
            setProg('s4c', doneCount, units.length);
            const unitText = Array.isArray(u.ct) ? u.ct.join('\n') : (u.ct || '');
            const r = await Pipeline.video({
              mode: input.mode,
              unit: u,
              type: typeMap.get(u.id) || '基础文戏',
              frozen: null,
              assets: scopedAssets,
              n: j + 1,
              creativeOverrides,
              episodeText: episodes.value[i]?.text || '',
              unitEpisodeIndex: i + 1,
              unitText,
            }, getController('s4c').signal);
            if (r.payload) payloads.s4c.push({ label: `第${i + 1}集·单元 ${j + 1}（${typeMap.get(u.id) || '基础文戏'}）`, text: r.payload });
            lastMeta = r.meta;
            out[j] = { ...r.parsed, episodeIndex: i };
            doneCount++;
            setProg('s4c', doneCount, units.length);
          },
          's4c'
        );

        // 每集完成后立即追加到全局结果并显示
        const epOut = out.filter(Boolean);
        videoPrompts.value = [...videoPrompts.value, ...epOut];
        epState.s4c[i] = 'done';
      }

      if (shouldStop('s4c')) break;
      if (hasSelection) break;
      await sleep(1000);
      readyIndices = findReady();
    }

    recordMeta('step4c', lastMeta, videoPrompts.value.length, Date.now() - start);
    await autoSaveOnStepComplete('step4c');
    showToast('success', `视频提示词完成：${videoPrompts.value.length} 条`);
    await runValidateVp();
  });
}

function runValidateVp() {
  return withBusy('s4d', async () => {
    const r = await Pipeline.validateVp({
      videoPrompts: videoPrompts.value,
      storyboard: storyboard.value,
      assets: assets.value,
    }, getController('s4d').signal);
    vpValidation.value = r;
    recordProgramStep('step4d', `${r.pass ? '通过' : r.issues.length + ' 项提示'}`);
    await autoSaveOnStepComplete('step4d');
  });
}

// ---------------- 项目保存/读取 ----------------
const NEW_PROJECT = '__new__';
const projectList = ref([]);
const selectedProject = ref('');
const lastAutoSavedAt = ref('');
const showNewProjectModal = ref(false);
const newProjectNameInput = ref('');

// ---------------- 自动存档 ----------------
let autoSaveTimer = null;
let autoSavePending = false;

function collectSession() {
  const M = (k) => stepMeta[k] || null;
  return {
    schemaVersion: 3,
    name: selectedProject.value || '',
    savedAt: new Date().toISOString(),
    input: { ...input },
    creativeOverrideSplit: creativeOverrideSplit.value,
    creativeOverrideShots: creativeOverrideShots.value,
    pipelineSettings: {
      s2bConcurrency: s2bConcurrency.value,
      s2bRetries: s2bRetries.value,
      s2bRetryDelayMs: s2bRetryDelayMs.value,
      sbConcurrency: sbConcurrency.value,
      s4cConcurrency: s4cConcurrency.value,
      splitSettings: { ...splitSettings },
      shotSettings: { ...shotSettings },
      scriptMergeMaxSec: scriptMergeMaxSec.value,
      narrationMergeMaxSec: narrationMergeMaxSec.value,
    },
    creativeOverrides: { ...creativeOverrides },
    steps: {
      step1: { label: '① 分集', ...(M('step1') || {}), payloads: payloads.s1 || [], result: { episodes: episodes.value } },
      step2: { label: '② 资产提取', ...(M('step2') || {}), payloads: payloads.s2 || [], result: { assets: assets.value, episodeAppearance: episodeAppearance.value } },
      step3a: { label: '③-a 类型分析', ...(M('step3a') || {}), payloads: payloads.s3a || [], result: { analysis: analysis.value } },
      step3b: { label: '③-b 分镜创作', ...(M('step3b') || {}), payloads: payloads.s3b || [], result: { storyboard: storyboard.value } },
      step4a: { label: '④-a 镜头分类', ...(M('step4a') || {}), payloads: payloads.s4a || [], result: { classifications: classifications.value } },
      step4x: { label: '④-x 单元归并', ...(M('step4x') || {}), result: { groupedStoryboard: groupedStoryboard.value, groupedStoryboardPerEpisode: groupedStoryboardPerEpisode.value } },
      step4c: { label: '④-c 视频提示词', ...(M('step4c') || {}), payloads: payloads.s4c || [], result: { videoPrompts: videoPrompts.value } },
      step4d: { label: '④-d 视频校验', ...(M('step4d') || {}), result: { validation: vpValidation.value } },
    },
    session: {
      episodeAssets: episodeAssets.value,
      episodeStoryboard: episodeStoryboard.value,
      groupedStoryboardPerEpisode: groupedStoryboardPerEpisode.value,
      episodeStatus: { ...episodeStatus },
      epState: {
        s2: [...epState.s2],
        ready: [...epState.ready],
        sb: [...epState.sb],
        sbSplit: [...epState.sbSplit],
        sbShots: [...epState.sbShots],
        s4x: [...epState.s4x],
        s4a: [...epState.s4a],
        s4c: [...epState.s4c],
      },
      extractSelected: [...extractSelected.value],
      segNarration: { ...segNarration },
      segScript: { ...segScript },
      splitNarration: { ...splitNarration },
      splitScript: { ...splitScript },
      shotNarration: { ...shotNarration },
      shotScript: { ...shotScript },
      sbConcurrencyNarration: sbConcurrencyNarration.value,
      sbConcurrencyScript: sbConcurrencyScript.value,
      tab: tab.value,
      open: { ...open },
      selectedProject: selectedProject.value,
      s2FailedTasks: s2FailedTasks.value,
      activeTasks: { ...busy },
      progress: JSON.parse(JSON.stringify(progress)),
    },
  };
}

function scheduleAutoSave() {
  autoSavePending = true;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(async () => {
    if (!autoSavePending) return;
    autoSavePending = false;
    await persistSession();
  }, 1500);
}

/** 当前生效的项目名 */
function getActiveProjectName() {
  const name = (selectedProject.value || '').trim();
  return name && name !== NEW_PROJECT ? name : '';
}

/** 分集前校验：必须已选择或新建并命名项目 */
function ensureProjectReady() {
  const name = getActiveProjectName();
  if (!name) {
    throw new Error('请在下拉框选择已有项目，或选择「新建项目」并完成命名');
  }
  return name;
}

/** 写入本地 + 命名项目（若有）+ 自动存档槽 */
async function persistSession() {
  const data = collectSession();
  if (!hasSessionContent(data)) return;
  const name = getActiveProjectName();
  if (name) data.name = name;
  saveLocalSession(data);
  lastAutoSavedAt.value = data.savedAt;
  if (name) {
    try {
      await Projects.save(name, data);
      selectedProject.value = name;
      await refreshProjects();
    } catch { /* 后端未启动时仅本地 */ }
  }
  try {
    await Projects.save(AUTOSAVE_PROJECT, data);
  } catch { /* ignore */ }
}

/** 某步骤完成后立即存档 */
async function autoSaveOnStepComplete(_stepKey) {
  autoSavePending = false;
  if (autoSaveTimer) {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }
  await persistSession();
}

async function flushAutoSave() {
  autoSavePending = false;
  await persistSession();
}

function applySession(sess) {
  if (!sess) return;
  if (sess.episodeAssets?.length) episodeAssets.value = sess.episodeAssets;
  if (sess.episodeStoryboard?.length) episodeStoryboard.value = sess.episodeStoryboard;
  if (sess.groupedStoryboardPerEpisode?.length) groupedStoryboardPerEpisode.value = sess.groupedStoryboardPerEpisode;
  if (sess.episodeStatus) Object.assign(episodeStatus, sess.episodeStatus);
  if (sess.epState) {
    epState.s2 = sess.epState.s2 || [];
    epState.ready = sess.epState.ready || [];
    epState.sb = sess.epState.sb || [];
    epState.sbSplit = sess.epState.sbSplit || [];
    epState.sbShots = sess.epState.sbShots || [];
    epState.s4x = sess.epState.s4x || [];
    epState.s4a = sess.epState.s4a || [];
    epState.s4c = sess.epState.s4c || [];
  }
  if (sess.extractSelected) extractSelected.value = sess.extractSelected;
  // 兼容旧档案：旧版 seg 同时写入两种模式
  if (sess.seg) {
    Object.assign(segNarration, sess.seg);
    Object.assign(segScript, sess.seg);
  }
  if (sess.segNarration) Object.assign(segNarration, sess.segNarration);
  if (sess.segScript) Object.assign(segScript, sess.segScript);
  if (sess.splitNarration) Object.assign(splitNarration, sess.splitNarration);
  if (sess.splitScript) Object.assign(splitScript, sess.splitScript);
  if (sess.shotNarration) Object.assign(shotNarration, sess.shotNarration);
  if (sess.shotScript) Object.assign(shotScript, sess.shotScript);
  if (sess.sbConcurrencyNarration != null) sbConcurrencyNarration.value = sess.sbConcurrencyNarration;
  if (sess.sbConcurrencyScript != null) sbConcurrencyScript.value = sess.sbConcurrencyScript;
  if (sess.tab) tab.value = sess.tab;
  if (sess.open) Object.assign(open, sess.open);
  if (sess.selectedProject) selectedProject.value = sess.selectedProject;
  if (sess.s2FailedTasks?.length) s2FailedTasks.value = sess.s2FailedTasks;
}

function normalizeInterruptedSession(sess) {
  if (!sess) return false;
  let interrupted = false;
  for (const k of Object.keys(sess.activeTasks || {})) {
    if (sess.activeTasks[k]) { interrupted = true; busy[k] = false; }
  }
  for (let i = 0; i < epState.s2.length; i++) {
    if (epState.s2[i] === 'running') { epState.s2[i] = 'error'; interrupted = true; }
  }
  for (let i = 0; i < epState.sb.length; i++) {
    if (epState.sb[i] === 'running' || epState.sb[i] === 'waiting') {
      epState.sb[i] = '';
      epState.sbSplit[i] = epState.sbSplit[i] === 'done' || epState.sbSplit[i] === 'partial' ? epState.sbSplit[i] : '';
      epState.sbShots[i] = epState.sbShots[i] === 'done' ? epState.sbShots[i] : '';
      interrupted = true;
    }
  }
  for (let i = 0; i < epState.sbSplit.length; i++) {
    if (epState.sbSplit[i] === 'running') { epState.sbSplit[i] = ''; interrupted = true; }
  }
  for (let i = 0; i < epState.sbShots.length; i++) {
    if (epState.sbShots[i] === 'running') { epState.sbShots[i] = ''; interrupted = true; }
  }
  // 中断的 Step4 状态重置
  for (let i = 0; i < epState.s4x.length; i++) {
    if (epState.s4x[i] === 'running') { epState.s4x[i] = ''; interrupted = true; }
  }
  for (let i = 0; i < epState.s4a.length; i++) {
    if (epState.s4a[i] === 'running') { epState.s4a[i] = ''; interrupted = true; }
  }
  for (let i = 0; i < epState.s4c.length; i++) {
    if (epState.s4c[i] === 'running') { epState.s4c[i] = ''; interrupted = true; }
  }
  pipe.s2Running = false;
  return interrupted;
}

async function restoreSession() {
  const local = loadLocalSession();
  let remote = null;
  try { remote = await Projects.get(AUTOSAVE_PROJECT); } catch { /* ignore */ }

  let data = local;
  if (remote && hasSessionContent(remote)) {
    if (!local || !hasSessionContent(local)) data = remote;
    else if (new Date(remote.savedAt || 0) > new Date(local.savedAt || 0)) data = remote;
  }

  if (!hasSessionContent(data)) return;

  applyProject(data);
  applySession(data.session);
  if (data.name) selectedProject.value = data.name;
  if (data.savedAt) lastAutoSavedAt.value = data.savedAt;

  const interrupted = normalizeInterruptedSession(data.session);
  rebuildStoryboard();
  syncEpisodeReady();

  showToast(
    interrupted ? 'warning' : 'success',
    interrupted
      ? '已恢复上次进度（刷新前进行中的任务已中断，可继续点击运行）'
      : `已恢复上次工作进度${data.savedAt ? '（' + new Date(data.savedAt).toLocaleString('zh-CN') + '）' : ''}`
  );
}

function onBeforeUnloadSave() {
  if (!hasSessionContent(collectSession())) return;
  const data = collectSession();
  saveLocalSession(data);
}

onMounted(async () => {
  loadGlobalSettings(); // 先加载全局参数
  await refreshProjects();
  await restoreSession();
  await loadVoiceLibrary();
  window.addEventListener('beforeunload', onBeforeUnloadSave);
});

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnloadSave);
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  flushAutoSave();
});

// 关键状态变化时 debounce 自动存档
watch(
  () => [
    input.currentText,
    input.mode,
    episodes.value,
    episodeStatus,
    assets.value,
    storyboard.value,
    analysis.value,
    episodeAppearance.value,
    episodeAssets.value,
    episodeStoryboard.value,
    epState.s2.slice(),
    epState.sb.slice(),
    epState.sbSplit.slice(),
    epState.sbShots.slice(),
    selectedProject.value,
  ],
  () => scheduleAutoSave(),
  { deep: true }
);

// 全局参数变化时自动保存到 localStorage
let globalSaveTimer = null;
function scheduleGlobalSave() {
  if (globalSaveTimer) clearTimeout(globalSaveTimer);
  globalSaveTimer = setTimeout(() => saveGlobalSettings(), 500);
}
watch(
  () => [
    segNarration.useModel, segNarration.maxChars,
    segScript.useModel, segScript.maxChars,
    splitNarration.maxUnitChars, splitNarration.concurrency, splitNarration.maxRetries,
    splitScript.maxUnitChars, splitScript.concurrency, splitScript.maxRetries,
    shotNarration.batchSize, shotNarration.concurrency,
    shotScript.batchSize, shotScript.concurrency,
    sbConcurrencyNarration.value, sbConcurrencyScript.value,
  ],
  () => scheduleGlobalSave(),
  { deep: true }
);
async function refreshProjects() {
  try {
    projectList.value = (await Projects.list()).filter((n) => n !== AUTOSAVE_PROJECT);
  } catch (e) { /* 后端未起时忽略 */ }
}

// 全局音色库：载入到 input.voiceLibrary，供 Step2 使用
const voiceCount = ref(0);
async function loadVoiceLibrary() {
  try {
    const r = await VoiceLib.get();
    input.voiceLibrary = r.content || '';
    voiceCount.value = (r.content || '')
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('>') && !l.includes('名称丨')).length;
  } catch (e) { /* 忽略 */ }
}
function onVoiceSaved(content) {
  input.voiceLibrary = content;
  voiceCount.value = content
    .split('\n')
    .filter((l) => l.trim() && !l.trim().startsWith('>') && !l.includes('名称丨')).length;
}

// 完整项目数据模型（schemaVersion=3）
function collectProject() {
  return collectSession();
}

function applyProject(p) {
  if (!p) return;
  if (p.input) Object.assign(input, p.input);
  creativeOverrideSplit.value = p.creativeOverrideSplit || '';
  creativeOverrideShots.value = p.creativeOverrideShots || p.creativeOverride || '';
  if (p.pipelineSettings) {
    if (p.pipelineSettings.s2bConcurrency != null) s2bConcurrency.value = p.pipelineSettings.s2bConcurrency;
    if (p.pipelineSettings.s2bRetries != null) s2bRetries.value = p.pipelineSettings.s2bRetries;
    if (p.pipelineSettings.s2bRetryDelayMs != null) s2bRetryDelayMs.value = p.pipelineSettings.s2bRetryDelayMs;
    if (p.pipelineSettings.sbConcurrencyNarration != null) sbConcurrencyNarration.value = p.pipelineSettings.sbConcurrencyNarration;
    if (p.pipelineSettings.sbConcurrencyScript != null) sbConcurrencyScript.value = p.pipelineSettings.sbConcurrencyScript;
    if (p.pipelineSettings.s4cConcurrency != null) s4cConcurrency.value = p.pipelineSettings.s4cConcurrency;
    if (p.pipelineSettings.scriptMergeMaxSec != null) scriptMergeMaxSec.value = p.pipelineSettings.scriptMergeMaxSec;
    if (p.pipelineSettings.narrationMergeMaxSec != null) narrationMergeMaxSec.value = p.pipelineSettings.narrationMergeMaxSec;
    if (p.pipelineSettings.segNarration) Object.assign(segNarration, p.pipelineSettings.segNarration);
    if (p.pipelineSettings.segScript) Object.assign(segScript, p.pipelineSettings.segScript);
    if (p.pipelineSettings.splitNarration) Object.assign(splitNarration, p.pipelineSettings.splitNarration);
    if (p.pipelineSettings.splitScript) Object.assign(splitScript, p.pipelineSettings.splitScript);
    if (p.pipelineSettings.shotNarration) Object.assign(shotNarration, p.pipelineSettings.shotNarration);
    if (p.pipelineSettings.shotScript) Object.assign(shotScript, p.pipelineSettings.shotScript);
  }
  Object.keys(creativeOverrides).forEach((k) => delete creativeOverrides[k]);
  Object.assign(creativeOverrides, p.creativeOverrides || {});
  // 清空旧档案
  Object.keys(stepMeta).forEach((k) => delete stepMeta[k]);
  Object.keys(payloads).forEach((k) => delete payloads[k]);

  if (p.schemaVersion >= 2 && p.steps) {
    const s = p.steps;
    episodes.value = s.step1?.result?.episodes || [];
    assets.value = s.step2?.result?.assets || { characters: [], scenes: [], items: [] };
    episodeAppearance.value = s.step2?.result?.episodeAppearance || [];
    analysis.value = s.step3a?.result?.analysis || null;
    storyboard.value = s.step3b?.result?.storyboard || { storys: [] };
    sbValidation.value = s.step3c?.result?.validation || null;
    classifications.value = s.step4a?.result?.classifications || [];
    groupedStoryboard.value = s.step4x?.result?.groupedStoryboard || { storys: [] };
    groupedStoryboardPerEpisode.value = s.step4x?.result?.groupedStoryboardPerEpisode || [];
    videoPrompts.value = s.step4c?.result?.videoPrompts || [];
    vpValidation.value = s.step4d?.result?.validation || null;
    // 还原档案与提示词
    const pmap = { step1: 's1', step2: 's2', step3a: 's3a', step3b: 's3b', step4x: 's4x', step4a: 's4a', step4c: 's4c' };
    for (const [stepKey, st] of Object.entries(s)) {
      if (st && (st.ranAt || st.model)) {
        stepMeta[stepKey] = { ranAt: st.ranAt, model: st.model, prompts: st.prompts || [], runs: st.runs, note: st.note, elapsedMs: st.elapsedMs || 0 };
      }
      if (st?.payloads?.length && pmap[stepKey]) payloads[pmap[stepKey]] = st.payloads;
    }
    if (p.schemaVersion >= 3 && p.session) applySession(p.session);
  } else {
    // 兼容旧版扁平结构
    episodes.value = p.episodes || [];
    assets.value = p.assets || { characters: [], scenes: [], items: [] };
    episodeAppearance.value = p.episodeAppearance || [];
    analysis.value = p.analysis || null;
    storyboard.value = p.storyboard || { storys: [] };
    groupedStoryboard.value = p.groupedStoryboard || { storys: [] };
    sbValidation.value = p.sbValidation || null;
    classifications.value = p.classifications || [];
    videoPrompts.value = p.videoPrompts || [];
    vpValidation.value = p.vpValidation || null;
  }
  syncEpisodeReady();
}

function resetWorkspace() {
  input.currentText = '';
  episodes.value = [];
  resetEpisodeStatus();
  assets.value = { characters: [], scenes: [], items: [] };
  episodeAppearance.value = [];
  episodeAssets.value = [];
  episodeStoryboard.value = [];
  groupedStoryboardPerEpisode.value = [];
  epState.s2 = [];
  epState.ready = [];
  epState.sb = [];
  epState.sbSplit = [];
  epState.sbShots = [];
  epState.s4x = [];
  epState.s4a = [];
  epState.s4c = [];
  extractSelected.value = [];
  s4xSelected.value = [];
  s4aSelected.value = [];
  s4cSelected.value = [];
  sbSelected.value = [];
  analysis.value = null;
  storyboard.value = { storys: [] };
  groupedStoryboard.value = { storys: [] };
  classifications.value = [];
  videoPrompts.value = [];
  vpValidation.value = null;
  creativeOverrideSplit.value = '';
  creativeOverrideShots.value = '';
  scriptMergeMaxSec.value = 10;
  narrationMergeMaxSec.value = 15;
  Object.keys(creativeOverrides).forEach((k) => delete creativeOverrides[k]);
  Object.keys(stepMeta).forEach((k) => delete stepMeta[k]);
  Object.keys(payloads).forEach((k) => delete payloads[k]);
  Object.keys(progress).forEach((k) => delete progress[k]);
  s2FailedTasks.value = [];
  s2bUpdateCheckResult.value = null;
  pipe.s2Running = false;
}

function onProjectSelect(e) {
  const val = e.target.value;
  if (val === NEW_PROJECT) {
    newProjectNameInput.value = '';
    showNewProjectModal.value = true;
    return;
  }
  selectedProject.value = val;
}

function cancelNewProject() {
  showNewProjectModal.value = false;
  newProjectNameInput.value = '';
}

async function confirmNewProject() {
  const name = newProjectNameInput.value.trim();
  if (!name) {
    showToast('error', '请输入项目名称');
    return;
  }
  if (projectList.value.includes(name)) {
    showToast('error', `项目「${name}」已存在，请换一个名称`);
    return;
  }
  resetWorkspace();
  selectedProject.value = name;
  showNewProjectModal.value = false;
  newProjectNameInput.value = '';
  const data = collectSession();
  data.name = name;
  try {
    await Projects.save(name, data);
    saveLocalSession(data);
    lastAutoSavedAt.value = data.savedAt;
    await refreshProjects();
  } catch (e) {
    showToast('error', '创建失败：' + e.message);
    selectedProject.value = '';
    return;
  }
  showToast('success', `已新建项目：${name}`);
}

function saveProject() {
  withBusy('proj', async () => {
    const name = ensureProjectReady();
    await persistSession();
    await refreshProjects();
    showToast('success', `已保存项目：${name}`);
  });
}

function loadProject() {
  withBusy('proj', async () => {
    const name = getActiveProjectName();
    if (!name) throw new Error('请先选择要读取的项目');
    const p = await Projects.get(name);
    applyProject(p);
    scheduleAutoSave();
    showToast('success', `已读取项目：${name}`);
  });
}

function deleteProject() {
  withBusy('proj', async () => {
    const name = getActiveProjectName();
    if (!name) throw new Error('请先选择要删除的项目');
    if (!confirm(`确定删除项目「${name}」？`)) return;
    await Projects.del(name);
    selectedProject.value = '';
    resetWorkspace();
    await refreshProjects();
    showToast('success', '已删除');
  });
}

function progText(k) {
  const p = progress[k];
  return p ? `${p.cur}/${p.total}` : '';
}

// 每集状态文案/颜色
function stStyle(s) {
  switch (s) {
    case 'done': return { t: '完成', c: 'var(--green)' };
    case 'running': return { t: '运行中', c: 'var(--primary)' };
    case 'waiting': return { t: '等待', c: 'var(--yellow)' };
    case 'blocked': return { t: '未就绪', c: 'var(--text-2)' };
    case 'partial': return { t: '部分完成', c: 'var(--yellow)' };
    case 'error': return { t: '失败', c: 'var(--red)' };
    default: return { t: '待运行', c: 'var(--text-2)' };
  }
}
function sbDotColor(i) {
  if (epState.sb[i] === 'done') return 'var(--green)';
  if (epState.sb[i] === 'running') return 'var(--primary)';
  if (epState.sb[i] === 'error') return 'var(--red)';
  if (epState.ready[i]) return 'var(--yellow)'; // 资产就绪，可运行
  return 'var(--border)';
}
function s4DotColor(i) {
  const s4cDone = epState.s4c[i] === 'done';
  const s4xDone = (input.mode === 'narration' || input.mode === 'script') ? epState.s4x[i] === 'done' : true;
  const s4aDone = epState.s4a[i] === 'done';
  const sbDone = epState.sb[i] === 'done';
  if (s4cDone) return 'var(--green)';
  if (epState.s4c[i] === 'running') return 'var(--primary)';
  if (epState.s4c[i] === 'error') return 'var(--red)';
  if (sbDone && s4xDone && s4aDone) return 'var(--yellow)'; // 前置完成，可执行
  return 'var(--border)';
}
function typeOf(id) {
  const c = classifications.value.find((x) => x.unit_id === id);
  return c ? c.type : '';
}
</script>

<template>
  <div class="app-shell">
    <div class="topbar">
      <h1>🎬 视频流程测试工具</h1>
      <div class="tabs">
        <div class="tab" :class="{ active: tab === 'workflow' }" @click="tab = 'workflow'">工作流</div>
        <div class="tab" :class="{ active: tab === 'preview' }" @click="tab = 'preview'">结果预览</div>
        <div class="tab" :class="{ active: tab === 'prompts' }" @click="tab = 'prompts'">提示词版本管理</div>
      </div>
      <div class="spacer"></div>
      <div class="row" v-show="tab === 'workflow'" style="gap:6px">
        <select :value="selectedProject" @change="onProjectSelect" style="width:160px" title="选择项目或新建">
          <option value="">选择项目…</option>
          <option :value="NEW_PROJECT">＋ 新建项目…</option>
          <option v-for="n in projectList" :key="n" :value="n">{{ n }}</option>
        </select>
        <button class="btn sm" @click="saveProject" :disabled="busy.proj || !getActiveProjectName()">
          <span v-if="busy.proj" class="spinner"></span> 保存
        </button>
        <button class="btn sm" @click="loadProject" :disabled="busy.proj || !getActiveProjectName()">读取</button>
        <button class="btn sm danger" @click="deleteProject" :disabled="busy.proj || !getActiveProjectName()">删除</button>
        <span v-if="lastAutoSavedAt" class="muted" style="font-size:11px" :title="'项目：' + (getActiveProjectName() || '未命名')">
          {{ getActiveProjectName() ? getActiveProjectName() + ' · ' : '' }}存档 {{ new Date(lastAutoSavedAt).toLocaleTimeString('zh-CN') }}
        </span>
      </div>
      <button class="btn primary" @click="runFullPipeline" :disabled="fullPipelineRunning" style="font-weight:700">
        <span v-if="fullPipelineRunning" class="spinner"></span> ▶ 一键全流程
      </button>
      <button v-if="fullPipelineRunning" class="btn danger" @click="stopFullPipeline">⏹ 停止全流程</button>
      <button class="btn" @click="showVoice = true">🎵 音色库</button>
      <button class="btn" @click="showModels = true">🧠 模型配置</button>
      <button class="btn" @click="showSettings = true">⚙ 火山接口设置</button>
    </div>

    <PromptManager v-if="tab === 'prompts'" @toast="onToast" />

    <div v-if="tab === 'preview'" class="layout">
      <ResultPreview
        :episodes="episodes"
        :episode-appearance="episodeAppearance"
        :assets="assets"
        :analysis="analysis"
        :storyboard="input.mode === 'narration' ? groupedStoryboard : storyboard"
        :classifications="classifications"
        :video-prompts="videoPrompts"
        :step-meta="stepMeta"
        :payloads="payloads"
        :sb-validation="sbValidation"
        :vp-validation="vpValidation"
      />
    </div>

    <div v-show="tab === 'workflow'" class="layout">
      <!-- 输入侧栏 -->
      <div class="sidebar">
        <label class="field">
          <span class="lab">工作流类型</span>
          <select v-model="input.mode">
            <option value="narration">解说</option>
            <option value="script">剧本</option>
          </select>
        </label>
        <label class="field">
          <span class="lab">原文 / 分集结果（支持「第N集」标记或 === 分隔）</span>
          <textarea v-model="input.currentText" style="min-height:160px" placeholder="粘贴长篇原文或已分集文本…"></textarea>
        </label>
        <label class="field">
          <span class="lab">配音音色库（全局保存，所有项目共用）</span>
          <div class="ep-item" style="margin:0">
            <div class="row">
              <span class="badge blue">{{ voiceCount }} 个音色</span>
              <div class="spacer" style="flex:1"></div>
              <button class="btn sm" @click="showVoice = true">管理音色库</button>
            </div>
          </div>
        </label>
        <label class="field">
          <span class="lab">全局风格（可选）</span>
          <textarea v-model="input.globalStyle"></textarea>
        </label>
      </div>

      <!-- 主流程 -->
      <div class="main">
        <!-- Step1 -->
        <div class="card">
          <div class="card-head" @click="open.s1 = !open.s1">
            <h3>① 分集（沿用稳定流程）</h3>
            <span class="badge" :class="episodes.length ? 'green' : 'gray'">{{ episodes.length ? episodes.length + ' 集' : '未运行' }}</span>
          </div>
          <div class="card-body" v-show="open.s1">
            <div class="row mb8">
              <span class="muted" style="font-weight:600">解说模式：</span>
              <label class="row" style="gap:5px"><input type="checkbox" v-model="segNarration.useModel" style="width:auto" /> 模型分集</label>
              <span class="muted">每集最大字数</span>
              <input v-model.number="segNarration.maxChars" type="number" style="width:110px" placeholder="0" />
              <span class="muted" style="font-weight:600;margin-left:12px">剧本模式：</span>
              <label class="row" style="gap:5px"><input type="checkbox" v-model="segScript.useModel" style="width:auto" /> 模型分集</label>
              <span class="muted">每集最大字数</span>
              <input v-model.number="segScript.maxChars" type="number" style="width:110px" placeholder="0" />
            </div>
            <div class="row" style="gap:8px">
              <button class="btn primary" @click="runSegment" :disabled="busy.s1">
                <span v-if="busy.s1" class="spinner"></span> {{ getSeg().useModel ? '发送模型分集' : '直接解析分集' }}
              </button>
              <button v-if="busy.s1" class="btn danger" @click="stopStep('s1')">⏹ 停止</button>
            </div>
            <PromptViewer :items="payloads.s1 || []" />
            <div class="mt12" v-if="episodes.length">
              <div v-for="e in episodes" :key="e.id" class="ep-item">
                <div class="row"><span class="pill">{{ e.title }}</span><span class="muted">{{ e.text.length }} 字</span></div>
                <div class="muted mt8" style="font-size:12px;max-height:60px;overflow:hidden">{{ e.text.slice(0, 120) }}…</div>
              </div>
              <div class="muted mt8">完整原文与表格化结果见顶部「结果预览」标签页。</div>
            </div>
          </div>
        </div>

        <!-- Step2 -->
        <div class="card">
          <div class="card-head" @click="open.s2 = !open.s2">
            <h3>② 资产提取（2a 全文名称 + 2b 详情并发）</h3>
            <span class="badge" :class="assets.characters.length ? 'green' : 'gray'">
              {{ assets.characters.length ? `角${assets.characters.length}/景${assets.scenes.length}/物${assets.items.length}` : '未运行' }}
            </span>
          </div>
          <div class="card-body" v-show="open.s2">
            <div class="row mb8" style="flex-wrap:wrap;gap:8px">
              <span class="muted">2b 并发</span>
              <input v-model.number="s2bConcurrency" type="number" min="1" max="50" style="width:60px" />
              <span class="muted">失败重试</span>
              <input v-model.number="s2bRetries" type="number" min="0" max="5" style="width:50px" title="含500等可重试错误" />
              <span class="muted">重试间隔ms</span>
              <input v-model.number="s2bRetryDelayMs" type="number" min="500" step="500" style="width:80px" />
              <span class="muted">待提取集（不勾选=自动选未完成）</span>
            </div>
            <div v-if="episodes.length" class="row mb8" style="gap:6px;flex-wrap:wrap">
              <label v-for="(e, i) in episodes" :key="e.id" class="pill" style="cursor:pointer">
                <input type="checkbox" :value="i" v-model="extractSelected" style="width:auto;margin-right:4px" />
                第{{ i + 1 }}集
                <span class="muted" style="font-size:11px">({{ epState.s2[i] === 'done' ? '已提取' : epState.s2[i] === 'partial' ? '部分' : '待提取' }})</span>
              </label>
            </div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <button class="btn primary" @click="runExtract" :disabled="busy.s2">
                <span v-if="busy.s2" class="spinner"></span> 提取资产 {{ busy.s2 ? progText('s2') : '' }}
              </button>
              <button v-if="busy.s2" class="btn danger" @click="stopStep('s2')">⏹ 停止</button>
              <button
                v-if="s2FailedTasks.length"
                class="btn"
                @click="runExtractContinue"
                :disabled="busy.s2"
              >
                继续未完成 ({{ s2FailedTasks.length }})
              </button>
            </div>
            <div v-if="s2FailedTasks.length && !busy.s2" class="mt8">
              <div class="muted mb8" style="font-size:12px">失败实体（再次点「继续未完成」仅重跑这些，已完成不会重复）：</div>
              <div v-for="(t, i) in s2FailedTasks" :key="i" class="issue warning" style="font-size:12px">
                {{ t.entityType }} · {{ t.entityName }} — {{ t.error }}
              </div>
            </div>
            <div class="progress-bar mt8" v-if="busy.s2 && progress.s2"><i :style="{ width: (progress.s2.cur / progress.s2.total * 100) + '%' }"></i></div>
            <div v-if="s2bUpdateCheckResult" class="mt8" style="font-size:12px">
              <div class="muted mb4">2a_b 更新检查结果：</div>
              <div class="row" style="gap:12px;flex-wrap:wrap">
                <span v-if="s2bUpdateCheckResult.existing_character_updates?.length" class="issue warning">角色需更新: {{ s2bUpdateCheckResult.existing_character_updates.join('、') }}</span>
                <span v-if="s2bUpdateCheckResult.existing_scene_updates?.length" class="issue warning">场景需更新: {{ s2bUpdateCheckResult.existing_scene_updates.join('、') }}</span>
                <span v-if="s2bUpdateCheckResult.existing_item_updates?.length" class="issue warning">物品需更新: {{ s2bUpdateCheckResult.existing_item_updates.join('、') }}</span>
                <span v-if="!s2bUpdateCheckResult.existing_character_updates?.length && !s2bUpdateCheckResult.existing_scene_updates?.length && !s2bUpdateCheckResult.existing_item_updates?.length" class="muted">无已有资产需要更新</span>
              </div>
            </div>
            <PromptViewer :items="payloads.s2 || []" />
            <div class="output mt12" v-if="assets.characters.length">{{ pretty(assets) }}</div>
          </div>
        </div>

        <!-- Step3a -->
        <div class="card">
          <div class="card-head" @click="open.s3a = !open.s3a">
            <h3>③-a 剧本类型分析（自动选择创作策略）</h3>
            <span class="badge" :class="analysis ? 'green' : 'gray'">{{ analysis ? analysis.recommended_strategy : '未运行' }}</span>
          </div>
          <div class="card-body" v-show="open.s3a">
            <div class="row" style="gap:8px">
              <button class="btn primary" @click="runAnalyze" :disabled="busy.s3a">
                <span v-if="busy.s3a" class="spinner"></span> 运行分析
              </button>
              <button v-if="busy.s3a" class="btn danger" @click="stopStep('s3a')">⏹ 停止</button>
            </div>
            <PromptViewer :items="payloads.s3a || []" />
            <div class="output mt12" v-if="analysis">{{ pretty(analysis) }}</div>
          </div>
        </div>

        <!-- Step3b -->
        <div class="card">
          <div class="card-head" @click="open.s3b = !open.s3b">
            <h3>③-b 分镜创作（拆分原文 + 镜头创作 · 两步并发）</h3>
            <span class="badge" :class="storyboard.storys.length ? 'green' : 'gray'">{{ storyboard.storys.length ? storyboard.storys.length + ' 单元' : '未运行' }}</span>
          </div>
          <div class="card-body" v-show="open.s3b">
            <label v-if="input.mode === 'narration'" class="field">
              <span class="lab">原文拆分·创作模版（留空用后端 step3b-split 激活版本）</span>
              <textarea v-model="creativeOverrideSplit" class="code" placeholder="拆分步骤创作思路…"></textarea>
            </label>
            <label class="field">
              <span class="lab">镜头创作·创作模版（留空用 step3b-shots 或下方通用覆盖）</span>
              <textarea v-model="creativeOverrideShots" class="code" placeholder="镜头创作思路…"></textarea>
            </label>
            <div v-if="input.mode === 'narration'" class="row mb8" style="flex-wrap:wrap;gap:10px">
              <span class="muted" style="font-weight:600;width:100%">解说模式设置：</span>
              <span class="muted">切段字数</span>
              <input v-model.number="splitNarration.maxUnitChars" type="number" min="100" style="width:80px" />
              <span class="muted">拆分并发</span>
              <input v-model.number="splitNarration.concurrency" type="number" min="1" max="20" style="width:60px" />
              <span class="muted">重试</span>
              <input v-model.number="splitNarration.maxRetries" type="number" min="0" max="5" style="width:60px" />
              <span class="muted">镜头批次</span>
              <input v-model.number="shotNarration.batchSize" type="number" min="1" max="20" style="width:60px" />
              <span class="muted">镜头并发</span>
              <input v-model.number="shotNarration.concurrency" type="number" min="1" max="20" style="width:60px" />
              <span class="muted">按集并发</span>
              <input v-model.number="sbConcurrencyNarration" type="number" min="1" max="20" style="width:60px" />
              <span class="muted">单元归并上限(s)</span>
              <input v-model.number="narrationMergeMaxSec" type="number" min="10" max="15" style="width:50px" />
            </div>
            <div v-if="input.mode === 'script'" class="row mb8" style="flex-wrap:wrap;gap:10px">
              <span class="muted" style="font-weight:600;width:100%">剧本模式设置：</span>
              <span class="muted">场次并发</span>
              <input v-model.number="shotScript.concurrency" type="number" min="1" max="20" style="width:60px" />
              <span class="muted">按集并发</span>
              <input v-model.number="sbConcurrencyScript" type="number" min="1" max="20" style="width:60px" />
              <span class="muted">单单元归并上限(s)</span>
              <input v-model.number="scriptMergeMaxSec" type="number" min="10" max="15" style="width:50px" />
            </div>
            <div v-if="input.mode === 'narration'" class="muted mb8" style="font-size:12px">技术切段字数只控制每次请求的原文块大小，不限制模型拆出的片段长度；每段拆分完成后立即进入镜头创作（流水线）。</div>
            <div class="row mb8" style="gap:8px">
              <button class="btn primary" @click="runStoryboard" :disabled="busy.s3b">
                <span v-if="busy.s3b" class="spinner"></span> 生成分镜（拆分→镜头 · 按集并发）
              </button>
              <button v-if="busy.s3b" class="btn danger" @click="stopStep('s3b')">⏹ 停止</button>
            </div>

            <!-- 每集「可运行检测」：资产状态 + 分镜状态 -->
            <div v-if="episodes.length" class="mb8">
              <div class="muted mb8" style="font-size:12px">每集运行检测（勾选后点击按钮只运行勾选的集，数据覆盖）：</div>
              <div class="row" style="gap:6px;flex-wrap:wrap">
                <div v-for="(e, i) in episodes" :key="e.id" class="pill" :title="e.title"
                     :style="{ borderLeft: '3px solid ' + sbDotColor(i) }"
                     style="display:flex;gap:6px;align-items:center;padding:3px 8px">
                  <span>第{{ i + 1 }}集</span>
                  <span :style="{ color: stStyle(epState.s2[i]).c }">资:{{ stStyle(epState.s2[i]).t }}</span>
                  <span :style="{ color: stStyle(epState.sbSplit[i]).c }">拆:{{ stStyle(epState.sbSplit[i]).t }}</span>
                  <span :style="{ color: stStyle(epState.sbShots[i]).c }">镜:{{ stStyle(epState.sbShots[i]).t }}</span>
                  <span :style="{ color: stStyle(epState.s4x[i]).c }">并:{{ stStyle(epState.s4x[i]).t }}</span>
                  <span :style="{ color: stStyle(epState.sb[i]).c }">总:{{ stStyle(epState.sb[i]).t }}</span>
                  <label style="display:flex;align-items:center;gap:2px;margin-left:4px;font-size:11px;cursor:pointer" title="勾选后重新生成本集分镜">
                    <input type="checkbox" :value="i" v-model="sbSelected" style="width:auto;margin:0" />镜
                  </label>
                </div>
              </div>
            </div>

            <PromptViewer :items="payloads.s3b || []" />
            <div class="muted mt8" v-if="storyboard.storys.length">结构化表格见「结果预览 → 分镜」。下方为原始 JSON：</div>
            <div class="output mt8" v-if="storyboard.storys.length">{{ pretty(storyboard) }}</div>
          </div>
        </div>

        <!-- Step4 -->
        <div class="card">
          <div class="card-head" @click="open.s4 = !open.s4">
            <h3>④ 视频提示词（分类 → 按类型创作 → 校验）</h3>
            <span class="badge" :class="videoPrompts.length ? 'green' : 'gray'">{{ videoPrompts.length ? videoPrompts.length + ' 条' : '未运行' }}</span>
          </div>
          <div class="card-body" v-show="open.s4">
            <div class="row mb8" style="gap:8px;flex-wrap:wrap">

              <button class="btn" @click="runClassify" :disabled="busy.s4a"><span v-if="busy.s4a" class="spinner"></span> a.镜头分类</button>
              <button v-if="busy.s4a" class="btn danger" @click="stopStep('s4a')">⏹ 停止</button>
              <button class="btn primary" @click="runVideo" :disabled="busy.s4c">
                <span v-if="busy.s4c" class="spinner"></span> c.生成视频提示词 {{ busy.s4c ? progText('s4c') : '' }}
              </button>
              <button v-if="busy.s4c" class="btn danger" @click="stopStep('s4c')">⏹ 停止</button>
              <label class="small-label">并发：<input v-model.number="s4cConcurrency" type="number" min="1" max="50" style="width:50px" /></label>
              <span class="badge" :class="vpValidation ? (vpValidation.pass ? 'green' : 'yellow') : 'gray'" v-if="vpValidation">
                d.校验 {{ vpValidation.pass ? '通过' : vpValidation.issues.length + ' 提示' }}
              </span>
            </div>

            <!-- 每集 Step4 运行检测 -->
            <div v-if="episodes.length" class="mb8">
              <div class="muted mb8" style="font-size:12px">每集 Step4 运行检测（勾选后点击按钮只运行勾选的集，数据覆盖）：</div>
              <div class="row" style="gap:6px;flex-wrap:wrap">
                <div v-for="(e, i) in episodes" :key="e.id" class="pill" :title="e.title"
                     :style="{ borderLeft: '3px solid ' + s4DotColor(i) }"
                     style="display:flex;gap:6px;align-items:center;padding:3px 8px">
                  <span>第{{ i + 1 }}集</span>

                  <span :style="{ color: stStyle(epState.s4a[i]).c }">类:{{ stStyle(epState.s4a[i]).t }}</span>
                  <span :style="{ color: stStyle(epState.s4c[i]).c }">视:{{ stStyle(epState.s4c[i]).t }}</span>

                  <label style="display:flex;align-items:center;gap:2px;margin-left:4px;font-size:11px;cursor:pointer" title="勾选后重新分类此集">
                    <input type="checkbox" :value="i" v-model="s4aSelected" style="width:auto;margin:0" />类
                  </label>
                  <label style="display:flex;align-items:center;gap:2px;margin-left:4px;font-size:11px;cursor:pointer" title="勾选后重新生成此集视频提示词">
                    <input type="checkbox" :value="i" v-model="s4cSelected" style="width:auto;margin:0" />视
                  </label>
                </div>
              </div>
            </div>
            <div class="progress-bar mb8" v-if="busy.s4c && progress.s4c"><i :style="{ width: (progress.s4c.cur / progress.s4c.total * 100) + '%' }"></i></div>

            <PromptViewer :items="payloads.s4a || []" />
            <PromptViewer :items="payloads.s4c || []" />
            <div v-if="classifications.length" class="row mb8 mt8" style="gap:6px">
              <span v-for="c in classifications" :key="c.unit_id" class="pill">#{{ c.unit_id }} {{ c.type }}</span>
            </div>

            <div v-for="vp in videoPrompts" :key="vp.n" class="ep-item">
              <div class="row mb8">
                <span class="pill">单元 {{ vp.n }}</span>
                <span class="pill">{{ typeOf(vp.n) }}</span>
                <span class="muted">对白角色：{{ (vp.dlgs || []).join('、') || '无' }}</span>
              </div>
              <div class="output" style="max-height:240px">{{ vp.p }}</div>
            </div>

            <div class="mt12" v-if="vpValidation && vpValidation.issues.length">
              <div v-for="(it, i) in vpValidation.issues" :key="i" class="issue" :class="it.level">{{ it.code }} — {{ it.message }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <VoiceLibraryModal v-if="showVoice" @close="showVoice = false" @toast="onToast" @saved="onVoiceSaved" />
    <ModelConfigModal v-if="showModels" @close="showModels = false" @toast="onToast" />
    <SettingsModal v-if="showSettings" @close="showSettings = false" @toast="onToast" />

    <!-- 新建项目命名 -->
    <div v-if="showNewProjectModal" class="modal-mask" @click.self="cancelNewProject">
      <div class="modal" style="width:400px">
        <h2 style="margin-top:0">新建项目</h2>
        <p class="muted" style="margin-top:0">请输入项目名称（必填，不可与已有项目重名）</p>
        <label class="field">
          <span class="lab">项目名称</span>
          <input
            v-model="newProjectNameInput"
            placeholder="例如：测试剧本-01"
            autofocus
            @keyup.enter="confirmNewProject"
          />
        </label>
        <div class="row mt12">
          <div class="spacer" style="flex:1"></div>
          <button class="btn" @click="cancelNewProject">取消</button>
          <button class="btn primary" @click="confirmNewProject">创建</button>
        </div>
      </div>
    </div>

    <transition><div v-if="toast.show" class="toast" :class="toast.type">{{ toast.msg }}</div></transition>
  </div>
</template>
