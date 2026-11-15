import {
  App, Editor, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile,
} from "obsidian";
import {
  Annotation, Extension, Range, StateEffect, Transaction,
} from "@codemirror/state";
import {
  Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType,
} from "@codemirror/view";

interface TextVersion {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface VersionGroup {
  id: string;
  notePath: string;
  activeId: string;
  versions: TextVersion[];
  // Last saved location only. Live positions belong to individual editor views.
  from: number;
  to: number;
  anchor: { prefix: string; suffix: string };
  unlocated?: boolean;
}

interface PluginSettings {
  underlineColor: string;
  successNoticeColor: string;
  cancelNoticeColor: string;
}
interface PluginData {
  schemaVersion: 1;
  groups: VersionGroup[];
  settings?: PluginSettings;
}
interface EditorRange { from: number; to: number; }
interface DraftSession {
  notePath: string;
  groupId: string;
  versionId: string;
  isNewGroup: boolean;
}
type WriteKind = "draft" | "cancel" | "preview" | "restore" | "exit";
interface WriteInfo { kind: WriteKind; groupId: string; }

const versionWrite = Annotation.define<WriteInfo>();
const refreshVersions = StateEffect.define<null>();
const uid = () => crypto.randomUUID();
const DEFAULT_SETTINGS: PluginSettings = {
  underlineColor: "",
  successNoticeColor: "",
  cancelNoticeColor: "",
};

export default class TextVersioningPlugin extends Plugin {
  data: PluginData = { schemaVersion: 1, groups: [] };
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  activePath = "";
  draft: DraftSession | null = null;
  bridges = new Set<VersionBridge>();
  popover: PreviewPopover | null = null;
  private saveTimer: number | null = null;
  private openTimer: number | null = null;
  private closeTimer: number | null = null;

  async onload() {
    const loaded = (await this.loadData()) as Partial<PluginData> | null;
    // Load only records using the current storage schema.
    this.settings = { ...DEFAULT_SETTINGS, ...loaded?.settings };
    this.data = loaded?.schemaVersion === 1 && Array.isArray(loaded.groups)
      ? { schemaVersion: 1, groups: loaded.groups, settings: this.settings }
      : { schemaVersion: 1, groups: [], settings: this.settings };
    this.activePath = this.app.workspace.getActiveFile()?.path ?? "";
    this.addStatusBarItem().setText(`TV ${this.manifest.version}`);
    this.applyAppearance();
    this.addSettingTab(new TextVersioningSettingTab(this.app, this));
    this.registerEditorExtension(versionEditorExtension(this));

    this.addCommand({
      id: "create-version",
      name: "Create version from selection or current passage",
      editorCallback: (editor) => this.createDraft(editor),
    });
    this.addCommand({
      id: "save-version-draft",
      name: "Save new version draft",
      editorCallback: () => this.saveDraft(),
    });
    this.addCommand({
      id: "cancel-version-draft",
      name: "Cancel new version draft",
      editorCallback: () => this.cancelDraft(),
    });
    this.addCommand({
      id: "show-current-versions",
      name: "Show versions for current passage",
      editorCallback: (editor) => this.showCurrentVersions(editor),
    });

    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key !== "Escape" || !this.draft) return;
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view?.file?.path === this.draft.notePath) {
        event.preventDefault();
        this.cancelDraft();
      }
    });

    const changeActiveFile = () => {
      this.closePreview(true);
      this.activePath = this.app.workspace.getActiveFile()?.path ?? "";
      this.refresh();
    };
    this.registerEvent(this.app.workspace.on("active-leaf-change", changeActiveFile));
    this.registerEvent(this.app.workspace.on("file-open", changeActiveFile));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      for (const group of this.data.groups) {
        if (group.notePath === oldPath) group.notePath = file.path;
      }
      this.saveSoon();
    }));
  }

  onunload() {
    this.closePreview(true);
    for (const property of appearanceProperties()) {
      document.documentElement.style.removeProperty(property);
    }
    void this.flushSave();
  }

  applyAppearance() {
    const style = document.documentElement.style;
    setOrRemoveColor(style, "--tv-underline-color", this.settings.underlineColor);
    setOrRemoveColor(style, "--tv-success-color", this.settings.successNoticeColor);
    setOrRemoveColor(style, "--tv-cancel-color", this.settings.cancelNoticeColor);
  }

  setAppearanceColor(key: keyof PluginSettings, value: string) {
    this.settings[key] = value;
    this.applyAppearance();
    this.saveSoon();
  }

  groupsFor(path: string) {
    return this.data.groups.filter((group) => group.notePath === path);
  }

  group(id: string) {
    return this.data.groups.find((group) => group.id === id);
  }

  active(group: VersionGroup) {
    const version = group.versions.find((candidate) => candidate.id === group.activeId);
    if (!version) throw new Error(`Missing active version for ${group.id}`);
    return version;
  }

  pathForView(view: EditorView) {
    let path = "";
    this.app.workspace.iterateAllLeaves((leaf) => {
      const markdownView = leaf.view;
      if (markdownView instanceof MarkdownView
          && markdownView.file
          && markdownView.contentEl.contains(view.dom)) {
        path = markdownView.file.path;
      }
    });
    return path;
  }

  bridgeForNote(path: string) {
    const candidates = [...this.bridges].filter((bridge) => bridge.path === path);
    return candidates.find((bridge) => bridge.view.hasFocus) ?? candidates[0];
  }

  showCurrentVersions(editor: Editor) {
    const path = this.app.workspace.getActiveFile()?.path;
    if (!path) return;
    const bridge = this.bridgeForNote(path);
    if (!bridge) {
      new Notice("The active editor is not ready yet.");
      return;
    }
    const cursor = editor.posToOffset(editor.getCursor("head"));
    const group = bridge.groupAt(cursor);
    if (!group) {
      new Notice("Click inside a versioned passage first.");
      return;
    }
    this.openPreviewNow(bridge, group);
  }

  openPreviewNow(bridge: VersionBridge, group: VersionGroup) {
    this.closePreview(true);
    if (this.draft?.notePath === bridge.path || group.unlocated) return;
    if (!bridge.rangeFor(group.id)) return;
    this.popover = new PreviewPopover(this, bridge, group);
  }

  createDraft(editor: Editor) {
    if (this.draft) {
      new Notice("Save or cancel the current version draft first.");
      return;
    }
    const path = this.app.workspace.getActiveFile()?.path;
    if (!path) return;
    const bridge = this.bridgeForNote(path);
    if (!bridge) {
      new Notice("The active editor is not ready yet.");
      return;
    }
    this.closePreview(true);

    const doc = bridge.view.state.doc.toString();
    let from = editor.posToOffset(editor.getCursor("from"));
    let to = editor.posToOffset(editor.getCursor("to"));
    const groups = this.groupsFor(path).filter((group) => !group.unlocated);
    let group = groups.find((candidate) => {
      const range = bridge.rangeFor(candidate.id);
      return range && from >= range.from && to <= range.to;
    });

    const overlaps = groups.find((candidate) => {
      const range = bridge.rangeFor(candidate.id);
      return range && (Math.max(from, range.from) < Math.min(to, range.to)
        || (from === to && from > range.from && from < range.to));
    });
    if (!group && overlaps) {
      new Notice("Version regions cannot partially overlap.");
      return;
    }
    if (!group && from === to) {
      new Notice("Select text first, or click within an existing passage.");
      return;
    }

    let isNewGroup = false;
    if (!group) {
      const originalVersion: TextVersion = {
        id: uid(), text: doc.slice(from, to),
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      group = {
        id: uid(), notePath: path, activeId: originalVersion.id,
        versions: [originalVersion], from, to,
        anchor: {
          prefix: doc.slice(Math.max(0, from - 80), from),
          suffix: doc.slice(to, to + 80),
        },
      };
      this.data.groups.push(group);
      bridge.ranges.set(group.id, { from, to });
      isNewGroup = true;
    } else {
      const range = bridge.rangeFor(group.id);
      if (!range) return;
      from = range.from;
      to = range.to;
    }

    this.draft = {
      notePath: path, groupId: group.id, versionId: uid(), isNewGroup,
    };
    bridge.replace(group, "", "draft");
    bridge.view.dispatch({ selection: { anchor: from } });
    this.saveSoon();
    this.refresh();
    new Notice("Type the new version, then run “save new version draft”.");
  }

  saveDraft() {
    const draft = this.draft;
    if (!draft) return;
    if (this.activePath !== draft.notePath) {
      new Notice("Return to the note containing the draft before saving.");
      return;
    }
    const bridge = this.bridgeForNote(draft.notePath);
    const group = this.group(draft.groupId);
    const range = bridge?.rangeFor(draft.groupId);
    if (!bridge || !group || !range) return;

    const doc = bridge.view.state.doc.toString();
    const now = Date.now();
    const version: TextVersion = {
      id: draft.versionId, text: doc.slice(range.from, range.to),
      createdAt: now, updatedAt: now,
    };
    group.versions.push(version);
    group.activeId = version.id;
    this.draft = null;
    this.ensureDocumentExit(bridge, group);
    const finalRange = bridge.rangeFor(group.id);
    if (finalRange) {
      this.updateSnapshot(group, finalRange, bridge.view.state.doc.toString());
    }
    void this.flushSave();
    this.refresh();
    const notice = new Notice("New version draft saved successfully.");
    notice.containerEl.addClass("tv-notice-success");
  }

  cancelDraft() {
    const draft = this.draft;
    if (!draft) return;
    if (this.activePath !== draft.notePath) {
      new Notice("Return to the note containing the draft before cancelling.");
      return;
    }
    const bridge = this.bridgeForNote(draft.notePath);
    const group = this.group(draft.groupId);
    if (!bridge || !group) {
      this.draft = null;
      return;
    }

    bridge.replace(group, this.active(group).text, "cancel");
    if (draft.isNewGroup) {
      this.data.groups = this.data.groups.filter((candidate) => candidate.id !== group.id);
      bridge.ranges.delete(group.id);
    } else {
      const range = bridge.rangeFor(group.id);
      if (range) this.updateSnapshot(group, range, bridge.view.state.doc.toString());
    }
    this.draft = null;
    void this.flushSave();
    this.refresh();
    const notice = new Notice("Creation of new version draft canceled.");
    notice.containerEl.addClass("tv-notice-cancel");
  }

  ensureDocumentExit(bridge: VersionBridge, group: VersionGroup) {
    const range = bridge.rangeFor(group.id);
    if (!range) return;
    const docLength = bridge.view.state.doc.length;
    if (range.to !== docLength) return;

    // Insert one final newline, then explicitly keep it outside the group.
    // Otherwise an insertion at the document end has nowhere outside the
    // version for the caret to land.
    bridge.view.dispatch({
      changes: { from: docLength, to: docLength, insert: "\n" },
      annotations: [
        versionWrite.of({ kind: "exit", groupId: group.id }),
        Transaction.addToHistory.of(false),
      ],
    });
    bridge.ranges.set(group.id, { from: range.from, to: docLength });
  }

  updateFromEditor(bridge: VersionBridge, update: ViewUpdate) {
    const info = update.transactions
      .map((transaction) => transaction.annotation(versionWrite))
      .find((value) => value !== undefined);
    const previewGroupId = this.popover?.bridge === bridge
      ? this.popover.groupId : null;
    const doc = update.state.doc.toString();
    let changed = false;

    // Each view maps its own ranges exactly once. Shared persistent groups
    // never supply live offsets to another view.
    const nextRanges = new Map<string, EditorRange>();
    for (const [groupId, range] of bridge.ranges) {
      const group = this.group(groupId);
      if (!group || group.notePath !== bridge.path) continue;

      const from = clamp(update.changes.mapPos(range.from, -1), 0, doc.length);
      const to = clamp(update.changes.mapPos(range.to, 1), from, doc.length);
      const next = { from, to };
      nextRanges.set(groupId, next);

      const generated = info?.groupId === groupId;
      const drafting = this.draft?.groupId === groupId;
      if (generated || drafting || previewGroupId === groupId) continue;

      const current = this.active(group);
      const text = doc.slice(from, to);
      if (text !== current.text) {
        current.text = text;
        current.updatedAt = Date.now();
        changed = true;
      }
      this.updateSnapshot(group, next, doc);
    }
    bridge.ranges = nextRanges;

    if (changed) this.saveSoon();
    if (!info && previewGroupId) {
      const popover = this.popover;
      queueMicrotask(() => {
        if (this.popover === popover) this.closePreview(true);
      });
    }
  }

  updateSnapshot(group: VersionGroup, range: EditorRange, doc: string) {
    group.from = range.from;
    group.to = range.to;
    group.anchor = {
      prefix: doc.slice(Math.max(0, range.from - 80), range.from),
      suffix: doc.slice(range.to, range.to + 80),
    };
  }

  locateRanges(path: string, doc: string) {
    const ranges = new Map<string, EditorRange>();
    for (const group of this.groupsFor(path)) {
      const text = this.active(group).text;
      let range: EditorRange | undefined;

      if (group.from >= 0 && group.to <= doc.length
          && doc.slice(group.from, group.to) === text) {
        range = { from: group.from, to: group.to };
      } else {
        const matches = text ? allOccurrences(doc, text) : [];
        let found = matches.length === 1 ? matches[0] : undefined;
        if (found === undefined && matches.length > 1) {
          const contextual = matches.filter((at) =>
            doc.slice(Math.max(0, at - group.anchor.prefix.length), at)
              === group.anchor.prefix
            && doc.slice(at + text.length,
              at + text.length + group.anchor.suffix.length) === group.anchor.suffix);
          if (contextual.length === 1) found = contextual[0];
        }
        if (found !== undefined) {
          range = { from: found, to: found + text.length };
        }
      }

      if (range) {
        ranges.set(group.id, range);
        group.unlocated = false;
        this.updateSnapshot(group, range, doc);
      } else {
        group.unlocated = true;
      }
    }
    return ranges;
  }

  saveSoon() {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => void this.flushSave(), 400);
  }

  async flushSave() {
    if (this.saveTimer !== null) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.data.settings = { ...this.settings };
    await this.saveData(this.data);
  }

  refresh() {
    for (const bridge of this.bridges) {
      bridge.view.dispatch({ effects: refreshVersions.of(null) });
    }
  }

  schedulePreview(bridge: VersionBridge, groupId: string) {
    this.cancelPreviewClose();
    if (this.draft?.notePath === bridge.path || this.popover?.groupId === groupId) return;
    if (this.openTimer !== null) window.clearTimeout(this.openTimer);
    this.openTimer = window.setTimeout(() => {
      const group = this.group(groupId);
      if (group) this.openPreviewNow(bridge, group);
    }, 300);
  }

  schedulePreviewClose(bridge: VersionBridge) {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    if (!this.popover || this.popover.bridge !== bridge) return;
    this.cancelPreviewClose();
    this.closeTimer = window.setTimeout(() => this.closePreview(true), 300);
  }

  cancelPreviewClose() {
    if (this.closeTimer !== null) {
      window.clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  closePreview(restore: boolean) {
    if (this.openTimer !== null) {
      window.clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this.cancelPreviewClose();
    const popover = this.popover;
    this.popover = null;
    popover?.close(restore);
  }
}

class EmptyRegionWidget extends WidgetType {
  toDOM() {
    const element = createSpan();
    element.className = "pv-empty";
    element.textContent = "New version";
    return element;
  }
}

function buildDecorations(bridge: VersionBridge) {
  const decorations: Range<Decoration>[] = [];
  const docLength = bridge.view.state.doc.length;
  const cursor = bridge.view.state.selection.main.head;

  for (const [groupId, range] of bridge.ranges) {
    const group = bridge.plugin.group(groupId);
    if (!group || group.unlocated) continue;
    if (!validRange(range, docLength)) {
      console.warn("Text Versioning skipped an invalid range", { groupId, range, docLength });
      continue;
    }

    if (range.from === range.to) {
      decorations.push(Decoration.widget({
        widget: new EmptyRegionWidget(), side: 1,
      }).range(range.from));
    } else {
      const containsCursor = cursor >= range.from && cursor <= range.to;
      const className = containsCursor
        ? "pv-region pv-region-current"
        : "pv-region";
      decorations.push(Decoration.mark({ class: className })
        .range(range.from, range.to));
    }
  }
  return Decoration.set(decorations, true);
}

class VersionBridge {
  decorations: DecorationSet;
  path: string;
  ranges = new Map<string, EditorRange>();
  private mouseMoveHandler = (event: MouseEvent) => this.onMouseMove(event);
  private pointerDownHandler = () => {
    if (this.plugin.popover) this.plugin.closePreview(true);
  };

  constructor(public view: EditorView, public plugin: TextVersioningPlugin) {
    this.path = plugin.pathForView(view) || plugin.activePath;
    this.ranges = plugin.locateRanges(this.path, view.state.doc.toString());
    this.decorations = buildDecorations(this);
    plugin.bridges.add(this);
    view.dom.addEventListener("mousemove", this.mouseMoveHandler);
    view.dom.addEventListener("pointerdown", this.pointerDownHandler);
  }

  rangeFor(groupId: string) {
    return this.ranges.get(groupId);
  }

  groupAt(pos: number) {
    for (const [groupId, range] of this.ranges) {
      if (pos >= range.from && pos <= range.to) {
        return this.plugin.group(groupId);
      }
    }
    return undefined;
  }

  update(update: ViewUpdate) {
    let reset = false;
    const actualPath = this.plugin.pathForView(this.view) || this.path;
    if (this.path !== actualPath) {
      this.path = actualPath;
      this.ranges = this.plugin.locateRanges(this.path, update.state.doc.toString());
      reset = true;
    }

    if (update.docChanged) this.plugin.updateFromEditor(this, update);
    const refreshRequested = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshVersions)));
    if (reset || update.docChanged || update.selectionSet || refreshRequested) {
      this.decorations = buildDecorations(this);
    }
  }

  onMouseMove(event: MouseEvent) {
    const pos = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    const group = pos === null ? undefined : this.groupAt(pos);
    if (group && !group.unlocated) this.plugin.schedulePreview(this, group.id);
    else this.plugin.schedulePreviewClose(this);
  }

  replace(group: VersionGroup, text: string, kind: WriteKind) {
    const range = this.rangeFor(group.id);
    const docLength = this.view.state.doc.length;
    if (!range || !validRange(range, docLength)) {
      console.error("Text Versioning blocked a write with an invalid range", {
        groupId: group.id, range, docLength, kind,
      });
      new Notice("The version location is invalid. No text was changed.");
      return;
    }

    this.view.dispatch({
      changes: { from: range.from, to: range.to, insert: text },
      annotations: [
        versionWrite.of({ kind, groupId: group.id }),
        Transaction.addToHistory.of(false),
      ],
    });
  }

  destroy() {
    this.view.dom.removeEventListener("mousemove", this.mouseMoveHandler);
    this.view.dom.removeEventListener("pointerdown", this.pointerDownHandler);
    this.plugin.bridges.delete(this);
  }
}

function versionEditorExtension(plugin: TextVersioningPlugin): Extension {
  return ViewPlugin.fromClass(class extends VersionBridge {
    constructor(view: EditorView) { super(view, plugin); }
  }, {
    decorations: (value) => value.decorations,
  });
}

class PreviewPopover {
  el: HTMLElement;
  header: HTMLElement;
  preview: HTMLElement;
  committedId: string;
  displayedId: string;
  groupId: string;

  constructor(public plugin: TextVersioningPlugin,
              public bridge: VersionBridge, public group: VersionGroup) {
    this.groupId = group.id;
    this.committedId = group.activeId;
    this.displayedId = group.activeId;
    this.el = createDiv();
    this.el.className = "pv-popover";
    this.el.tabIndex = 0;
    this.header = createDiv();
    this.header.className = "pv-header";
    this.preview = createDiv();
    this.preview.className = "pv-preview";
    const hint = createDiv();
    hint.className = "pv-hint";
    hint.textContent = "Double-click the preview to use this version";
    const controls = createDiv();
    controls.className = "pv-controls";
    const previous = createEl("button");
    previous.textContent = "←";
    previous.ariaLabel = "Previous version";
    const next = createEl("button");
    next.textContent = "→";
    next.ariaLabel = "Next version";
    controls.append(previous, next);
    this.el.append(this.header, this.preview, hint, controls);
    document.body.appendChild(this.el);

    previous.addEventListener("click", () => this.cycle(-1));
    next.addEventListener("click", () => this.cycle(1));
    this.preview.addEventListener("dblclick", () => this.commit());
    this.el.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") { event.preventDefault(); this.cycle(-1); }
      if (event.key === "ArrowRight") { event.preventDefault(); this.cycle(1); }
      if (event.key === "Escape") {
        event.preventDefault();
        this.plugin.closePreview(true);
      }
    });
    this.el.addEventListener("mouseenter", () => plugin.cancelPreviewClose());
    this.el.addEventListener("mouseleave", () => plugin.schedulePreviewClose(this.bridge));
    this.render();
    this.position();
  }

  render() {
    const index = this.group.versions.findIndex((version) => version.id === this.displayedId);
    const version = this.group.versions[index]!;
    const current = this.displayedId === this.committedId ? "Current" : "Preview";
    this.header.textContent = `Version ${index + 1} of ${this.group.versions.length} · ${current}`;
    this.preview.textContent = version.text || "(empty version)";
  }

  cycle(direction: number) {
    const index = this.group.versions.findIndex((version) => version.id === this.displayedId);
    const next = (index + direction + this.group.versions.length) % this.group.versions.length;
    const version = this.group.versions[next]!;
    this.bridge.replace(this.group, version.text, "preview");
    this.displayedId = version.id;
    this.render();
  }

  commit() {
    const range = this.bridge.rangeFor(this.group.id);
    if (!range) return;
    this.group.activeId = this.displayedId;
    this.plugin.ensureDocumentExit(this.bridge, this.group);
    const finalRange = this.bridge.rangeFor(this.group.id);
    if (finalRange) {
      this.plugin.updateSnapshot(this.group, finalRange, this.bridge.view.state.doc.toString());
    }
    void this.plugin.flushSave();
    this.plugin.closePreview(false);
    this.plugin.refresh();
  }

  position() {
    const range = this.bridge.rangeFor(this.group.id);
    if (!range) return;
    const coords = this.bridge.view.coordsAtPos(range.from);
    if (!coords) return;
    this.el.style.left = `${Math.max(8, coords.left)}px`;
    this.el.style.top = `${coords.bottom + 8}px`;
    window.requestAnimationFrame(() => {
      const rect = this.el.getBoundingClientRect();
      if (rect.right > window.innerWidth - 8) {
        this.el.style.left = `${window.innerWidth - rect.width - 8}px`;
      }
      if (rect.bottom > window.innerHeight - 8) {
        this.el.style.top = `${Math.max(8, coords.top - rect.height - 8)}px`;
      }
    });
  }

  close(restore: boolean) {
    if (restore && this.displayedId !== this.committedId) {
      const committed = this.group.versions.find((version) => version.id === this.committedId);
      if (committed) this.bridge.replace(this.group, committed.text, "restore");
    }
    this.el.remove();
  }
}

function validRange(range: EditorRange, docLength: number) {
  return Number.isInteger(range.from) && Number.isInteger(range.to)
    && range.from >= 0 && range.from <= range.to && range.to <= docLength;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function allOccurrences(haystack: string, needle: string) {
  const result: number[] = [];
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    result.push(at);
    at = haystack.indexOf(needle, at + needle.length);
  }
  return result;
}

class TextVersioningSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TextVersioningPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName("Appearance").setHeading();

    this.addColorSetting({
      name: "Version underline",
      description: "Choose the underline color, or reset it to the theme accent color.",
      key: "underlineColor",
      fallback: "#7c6df2",
    });
    this.addColorSetting({
      name: "Successful save alert",
      description: "Choose the save-notification background, or reset it to the theme green.",
      key: "successNoticeColor",
      fallback: "#2da44e",
    });
    this.addColorSetting({
      name: "Cancellation alert",
      description: "Choose the cancellation-notification background, or reset it to the theme red.",
      key: "cancelNoticeColor",
      fallback: "#d4353f",
    });
  }

  private addColorSetting(options: {
    name: string;
    description: string;
    key: keyof PluginSettings;
    fallback: string;
  }) {
    new Setting(this.containerEl)
      .setName(options.name)
      .setDesc(options.description)
      .addColorPicker((colorPicker) => {
        colorPicker.setValue(this.plugin.settings[options.key] || options.fallback);
        colorPicker.onChange((value) => {
          this.plugin.setAppearanceColor(options.key, value);
        });
      })
      .addExtraButton((button) => {
        button.setIcon("rotate-ccw");
        button.setTooltip("Use theme default");
        button.onClick(() => {
          this.plugin.setAppearanceColor(options.key, "");
          this.display();
        });
      });
  }
}

function appearanceProperties() {
  return ["--tv-underline-color", "--tv-success-color", "--tv-cancel-color"];
}

function setOrRemoveColor(style: CSSStyleDeclaration, property: string, value: string) {
  if (value) style.setProperty(property, value);
  else style.removeProperty(property);
}
