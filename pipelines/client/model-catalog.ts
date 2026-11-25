/** The parts of a host provider snapshot entry the model picker reads. */
export interface CatalogEntry {
  readonly provider: string;
  readonly enabled?: boolean;
  readonly label?: string;
  readonly models?: readonly {
    readonly id: string;
    readonly label: string;
    readonly description?: string;
    readonly isSelectable?: boolean;
    readonly thinkingOptions?: readonly { readonly id: string; readonly label: string }[];
  }[];
}

export interface CatalogModel {
  /** The DSL value, `<provider>/<model>`. */
  readonly value: string;
  readonly label: string;
  readonly description: string | null;
  /** The model's reasoning options; null when the catalog lists none. */
  readonly thinking: readonly { readonly id: string; readonly label: string }[] | null;
}

export interface CatalogGroup {
  readonly provider: string;
  readonly label: string;
  readonly models: readonly CatalogModel[];
}

/** Reasoning levels the workflow DSL accepts. */
export const DSL_REASONING = ["low", "medium", "high"] as const;
export type DslReasoning = (typeof DSL_REASONING)[number];

/** Enabled providers with selectable models, in snapshot order. */
export function catalogGroups(entries: readonly CatalogEntry[]): CatalogGroup[] {
  return entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      provider: entry.provider,
      label: entry.label ?? entry.provider,
      models: (entry.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          value: `${entry.provider}/${model.id}`,
          label: model.label,
          description: model.description ?? null,
          thinking: model.thinkingOptions && model.thinkingOptions.length > 0 ? model.thinkingOptions : null,
        })),
    }))
    .filter((group) => group.models.length > 0);
}

export function findModel(groups: readonly CatalogGroup[], value: string): CatalogModel | null {
  for (const group of groups) {
    const found = group.models.find((model) => model.value === value);
    if (found) return found;
  }
  return null;
}

/** Groups whose provider, model ID or label contains every word of `query`. */
export function searchCatalog(groups: readonly CatalogGroup[], query: string): CatalogGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...groups];
  return groups
    .map((group) => ({
      ...group,
      models: group.models.filter((model) => {
        const haystack = `${group.label} ${model.value} ${model.label}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      }),
    }))
    .filter((group) => group.models.length > 0);
}

export interface ReasoningChoices {
  readonly options: readonly { readonly value: DslReasoning; readonly label: string }[];
  /** Why the list is not narrowed to the model, or why the current value stays listed. */
  readonly note: string | null;
}

/**
 * DSL levels for `model`: the ones its catalog entry offers, or all of them when the model is
 * unknown here, such as an inherited profile. The `current` value always stays selectable.
 */
export function reasoningChoices(
  groups: readonly CatalogGroup[] | null,
  model: string | null,
  current: DslReasoning | null,
): ReasoningChoices {
  const all = DSL_REASONING.map((value) => ({ value, label: value }));
  if (model === null) return { options: all, note: "The model comes from a profile or default, so every DSL level is offered." };
  if (groups === null) return { options: all, note: "The provider catalog is unavailable, so every DSL level is offered." };
  const found = findModel(groups, model);
  if (!found) return { options: all, note: "This model is not in the provider catalog, so every DSL level is offered." };
  if (!found.thinking) return { options: all, note: "The catalog lists no reasoning options for this model." };
  const offered = DSL_REASONING.flatMap((value) => {
    const option = found.thinking?.find((t) => t.id === value);
    return option ? [{ value, label: option.label }] : [];
  });
  if (current !== null && !offered.some((o) => o.value === current)) {
    return {
      options: [...offered, { value: current, label: `${current} (current, not offered by this model)` }],
      note: `This model does not offer \`${current}\`.`,
    };
  }
  return { options: offered, note: offered.length === 0 ? "This model offers none of the DSL levels." : null };
}
