import { createModuleSettings } from "../../shared/module-settings";
import { BUILTIN_CATEGORIES, type CategoryKind } from "./content";

// 词库类目：内置类目固定内容、可启停、可追加补充条目；自定义类目可增删改。
// 持久化只保存自定义类目、被停用的内置 id 和内置补充条目，展示时再与代码里的内置类目合并。
export interface TypingCategory {
  id: string;
  name: string;
  kind: CategoryKind;
  // 参与出题的完整条目：内置类目为「内置 + 用户补充」去重合并，自定义类目即自身条目。
  entries: readonly string[];
  // 内置类目的用户补充条目（自定义类目恒为空）。
  extras: readonly string[];
  builtin: boolean;
  enabled: boolean;
}

interface CustomCategory {
  id: string;
  name: string;
  kind: CategoryKind;
  entries: string[];
  enabled: boolean;
}

interface TypingLibraryData {
  custom: CustomCategory[];
  disabledBuiltins: string[];
  // 内置类目的用户补充条目：类目 id → 追加的条目列表。
  builtinExtras: Record<string, string[]>;
}

const HAS_SPACE = /\s/;

// 出题时排除无法输入的条目：单词含空白字符（练习中空格用于推进下一词），
// 句子内部空白收敛为单空格。只在使用时过滤，不改写持久化数据——
// 含空白的历史条目仍保留在词库中，编辑保存时由校验提示修正。
export function usableEntries(category: TypingCategory): string[] {
  if (category.kind === "word") return category.entries.filter((text) => !HAS_SPACE.test(text));
  return category.entries.map((text) => text.replace(/\s+/g, " "));
}

function parseEntries(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (text) seen.add(text);
  }
  return [...seen];
}

function parseCustom(raw: unknown): CustomCategory[] {
  if (!Array.isArray(raw)) return [];
  const categories: CustomCategory[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || entry.id === "") continue;
    const name = typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : "未命名类目";
    categories.push({
      id: entry.id,
      name,
      kind: entry.kind === "sentence" ? "sentence" : "word",
      entries: parseEntries(entry.entries),
      enabled: entry.enabled !== false,
    });
  }
  return categories;
}

const BUILTIN_IDS = new Set(BUILTIN_CATEGORIES.map((category) => category.id));

function parseExtras(raw: unknown): Record<string, string[]> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const extras: Record<string, string[]> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!BUILTIN_IDS.has(id)) continue;
    const entries = parseEntries(value);
    if (entries.length > 0) extras[id] = entries;
  }
  return extras;
}

export const typingLibrary = createModuleSettings<TypingLibraryData>({
  key: "typing-library",
  defaults: { custom: [], disabledBuiltins: [], builtinExtras: {} },
  parse(raw) {
    return {
      custom: parseCustom(raw.custom),
      disabledBuiltins: Array.isArray(raw.disabledBuiltins)
        ? raw.disabledBuiltins.filter((id): id is string => typeof id === "string")
        : [],
      builtinExtras: parseExtras(raw.builtinExtras),
    };
  },
});

export function mergeCategories(data: TypingLibraryData): TypingCategory[] {
  const builtins: TypingCategory[] = BUILTIN_CATEGORIES.map((category) => {
    const extras = data.builtinExtras[category.id] ?? [];
    return {
      ...category,
      entries: extras.length > 0 ? [...new Set([...category.entries, ...extras])] : category.entries,
      extras,
      builtin: true,
      enabled: !data.disabledBuiltins.includes(category.id),
    };
  });
  const custom: TypingCategory[] = data.custom.map((category) => ({ ...category, extras: [], builtin: false }));
  return [...builtins, ...custom];
}

export function useCategories(): TypingCategory[] {
  return mergeCategories(typingLibrary.use());
}

export function setCategoryEnabled(category: TypingCategory, enabled: boolean) {
  const data = typingLibrary.get();
  if (category.builtin) {
    const disabled = data.disabledBuiltins.filter((id) => id !== category.id);
    typingLibrary.update({ disabledBuiltins: enabled ? disabled : [...disabled, category.id] });
  } else {
    typingLibrary.update({
      custom: data.custom.map((item) => (item.id === category.id ? { ...item, enabled } : item)),
    });
  }
}

function newId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// 新建或更新自定义类目，返回类目 id；条目去空白、去重。
export function saveCategory(input: { id?: string; name: string; kind: CategoryKind; entries: string[] }): string {
  const data = typingLibrary.get();
  const name = input.name.trim();
  const entries = [...new Set(input.entries.map((text) => text.trim()).filter(Boolean))];
  if (input.id) {
    typingLibrary.update({
      custom: data.custom.map((item) =>
        item.id === input.id ? { ...item, name, kind: input.kind, entries } : item,
      ),
    });
    return input.id;
  }
  const id = newId();
  typingLibrary.update({ custom: [...data.custom, { id, name, kind: input.kind, entries, enabled: true }] });
  return id;
}

export function removeCategory(id: string) {
  typingLibrary.update({ custom: typingLibrary.get().custom.filter((item) => item.id !== id) });
}

// 保存内置类目的补充条目；清空即移除整份补充。
export function saveBuiltinExtras(categoryId: string, entries: string[]) {
  const clean = [...new Set(entries.map((text) => text.trim()).filter(Boolean))];
  const builtinExtras = { ...typingLibrary.get().builtinExtras };
  if (clean.length === 0) delete builtinExtras[categoryId];
  else builtinExtras[categoryId] = clean;
  typingLibrary.update({ builtinExtras });
}
