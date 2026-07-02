<script lang="ts">
  import MarkdownSection from './MarkdownSection.svelte';

  interface AttachmentSection {
    key: string;
    label: string;
    fieldName: string;
    content: string;
    contentHtml: string;
    emptyLabel: string;
    onUpdate: (value: string) => void;
  }
  interface Props {
    taskId: string;
    sections: AttachmentSection[];
    references: string[];
    documentation: string[];
    isReadOnly?: boolean;
    onOpenFile: () => void;
    onOpenWorkspaceFile: (relativePath: string, fragment: string | null) => void;
  }
  let {
    taskId,
    sections,
    references,
    documentation,
    isReadOnly = false,
    onOpenFile,
    onOpenWorkspaceFile,
  }: Props = $props();

  let expanded = $state<string | null>(null);

  // Dedupe: a URL present in both `documentation` and `references` would otherwise throw
  // Svelte 5's each_key_duplicate (keyed by href) and break the whole detail render.
  const specItems = $derived([...new Set([...documentation, ...references])]);
  const specFilled = $derived(specItems.length > 0);

  // Collapse everything when switching tasks.
  let prevTaskId = '';
  $effect(() => {
    if (taskId !== prevTaskId) {
      prevTaskId = taskId;
      expanded = null;
    }
  });

  function toggle(key: string) {
    expanded = expanded === key ? null : key;
  }
  function isFilled(s: AttachmentSection): boolean {
    return s.content.trim().length > 0;
  }
  function onSpecLinkClick(e: MouseEvent, href: string) {
    // Relative links open in the editor (same as MarkdownSection); URL schemes use the
    // anchor's default navigation (VS Code opens them externally).
    if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      e.preventDefault();
      const [relativePath, fragment] = href.split('#');
      onOpenWorkspaceFile(relativePath, fragment ?? null);
    }
  }
</script>

<div class="attach" data-testid="attachments">
  <div class="attach-chips">
    {#each sections as s (s.key)}
      <button
        class="attach-chip"
        class:filled={isFilled(s)}
        class:open={expanded === s.key}
        data-testid="attach-chip-{s.key}"
        onclick={() => toggle(s.key)}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>
        <span class="attach-chip-label">{s.label}</span>
        {#if !isFilled(s) && !isReadOnly}<span class="attach-add" data-testid="attach-add-{s.key}">+ Add</span>{/if}
      </button>
    {/each}
    <button
      class="attach-chip"
      class:filled={specFilled}
      class:open={expanded === 'spec'}
      data-testid="attach-chip-spec"
      onclick={() => toggle('spec')}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
      <span class="attach-chip-label">Spec</span>
      {#if !specFilled && !isReadOnly}<span class="attach-add" data-testid="attach-add-spec">+ Add</span>{/if}
    </button>
  </div>

  {#each sections as s (s.key)}
    {#if expanded === s.key}
      <div class="attach-panel" data-testid="attach-panel-{s.key}">
        <div class="attach-panel-head">
          <button class="attach-open" data-testid="attach-open-{s.key}" onclick={onOpenFile}>
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>
            Open in editor
          </button>
        </div>
        <MarkdownSection
          {taskId}
          title={s.label}
          fieldName={s.fieldName}
          content={s.content}
          contentHtml={s.contentHtml}
          emptyLabel={s.emptyLabel}
          onUpdate={s.onUpdate}
          {isReadOnly}
        />
      </div>
    {/if}
  {/each}

  {#if expanded === 'spec'}
    <div class="attach-panel" data-testid="attach-panel-spec">
      {#if specItems.length === 0}
        <div class="attach-empty">
          <span>No spec links yet.</span>
          {#if !isReadOnly}
            <button class="attach-open" data-testid="attach-add-spec-open" onclick={onOpenFile}>
              + Add in editor
            </button>
          {/if}
        </div>
      {:else}
        <ul class="attach-spec-list">
          {#each specItems as href (href)}
            <li>
              <a
                class="attach-spec-link"
                data-testid="attach-spec-link"
                {href}
                onclick={(e) => onSpecLinkClick(e, href)}>{href}</a>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .attach {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .attach-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .attach-chip {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 12px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    background: var(--vscode-editor-background);
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    font-size: 12px;
  }
  .attach-chip.filled {
    color: var(--vscode-foreground);
    background: var(--vscode-badge-background, #4d4d4d);
  }
  .attach-chip.open {
    border-color: var(--vscode-focusBorder);
  }
  .attach-chip:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .attach-add {
    font-size: 11px;
    opacity: 0.7;
  }
  .attach-panel {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px;
    border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, #444));
    border-radius: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .attach-panel-head {
    display: flex;
    justify-content: flex-end;
  }
  .attach-open {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    color: var(--vscode-textLink-foreground, #3794ff);
  }
  .attach-open:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .attach-empty {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground));
  }
  .attach-spec-list {
    margin: 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .attach-spec-link {
    color: var(--vscode-textLink-foreground, #3794ff);
    cursor: pointer;
    word-break: break-all;
  }
  .attach-spec-link:hover {
    text-decoration: underline;
  }
</style>
