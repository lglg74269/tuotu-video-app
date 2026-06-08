<script setup>
import { computed } from 'vue';

// 通用递归渲染：任意 JSON -> 文档/表格。结构变化也能渲染（未知字段用原始键名）
defineOptions({ name: 'AutoRender' });

const props = defineProps({
  value: { default: null },
  labels: { type: Object, default: () => ({}) },
  level: { type: Number, default: 0 },
});

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isPrimitive(v) {
  return v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v);
}
function label(key) {
  return props.labels[key] || key;
}

const kind = computed(() => {
  const v = props.value;
  if (isPrimitive(v)) return 'primitive';
  if (Array.isArray(v)) {
    if (v.length === 0) return 'empty';
    return v.every((x) => isPlainObject(x)) ? 'table' : 'list';
  }
  if (isPlainObject(v)) return 'object';
  return 'primitive';
});

// 表格列：所有元素键的并集（保持首次出现顺序）
const columns = computed(() => {
  if (kind.value !== 'table') return [];
  const cols = [];
  for (const row of props.value) {
    for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
  }
  return cols;
});

const objectEntries = computed(() => (isPlainObject(props.value) ? Object.entries(props.value) : []));

function displayPrimitive(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}
</script>

<template>
  <!-- 基本类型 -->
  <span v-if="kind === 'primitive'" class="ar-text">{{ displayPrimitive(value) }}</span>

  <span v-else-if="kind === 'empty'" class="muted">（空）</span>

  <!-- 对象数组 -> 表格 -->
  <div v-else-if="kind === 'table'" class="ar-table-wrap">
    <table class="ar-table">
      <thead>
        <tr><th class="ar-idx">#</th><th v-for="c in columns" :key="c">{{ label(c) }}</th></tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in value" :key="i">
          <td class="ar-idx">{{ i + 1 }}</td>
          <td v-for="c in columns" :key="c">
            <AutoRender :value="row[c]" :labels="labels" :level="level + 1" />
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <!-- 混合数组 -> 列表 -->
  <ul v-else-if="kind === 'list'" class="ar-list">
    <li v-for="(item, i) in value" :key="i">
      <AutoRender :value="item" :labels="labels" :level="level + 1" />
    </li>
  </ul>

  <!-- 对象 -> 键值定义列表 -->
  <div v-else-if="kind === 'object'" class="ar-obj">
    <div v-for="[k, v] in objectEntries" :key="k" class="ar-kv">
      <div class="ar-key">{{ label(k) }}</div>
      <div class="ar-val"><AutoRender :value="v" :labels="labels" :level="level + 1" /></div>
    </div>
  </div>
</template>

<style scoped>
.ar-text { white-space: pre-wrap; word-break: break-word; }
.ar-table-wrap { overflow-x: auto; }
.ar-table { border-collapse: collapse; width: 100%; font-size: 12px; }
.ar-table th, .ar-table td {
  border: 1px solid var(--border); padding: 5px 8px; text-align: left;
  vertical-align: top; white-space: pre-wrap; word-break: break-word;
}
.ar-table th { background: var(--bg-3); color: var(--text-2); position: sticky; top: 0; }
.ar-idx { width: 36px; color: var(--text-2); text-align: center; }
.ar-list { margin: 0; padding-left: 18px; }
.ar-list > li { margin: 3px 0; }
.ar-obj { display: flex; flex-direction: column; gap: 4px; }
.ar-kv { display: flex; gap: 8px; align-items: flex-start; }
.ar-key { min-width: 92px; color: var(--text-2); font-size: 12px; flex-shrink: 0; }
.ar-val { flex: 1; min-width: 0; }
</style>
