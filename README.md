# Text Versioning

Text Versioning is an Obsidian 1.8.7+ plugin primarily created for writers to be able to write and compare alternate versions of selected passages without needing to create duplicate notes/Markdown files. The active version remains in the Markdown file/Obsidian note, while all alternate versions of selected text are stored in the plugin's `data.json` file.

## Features

- Create alternate text versions/version groups of only the text you want without needing to navigate outside of the note
- Create multiple alternate versions of the same text
- Make edits to existing text versions
- Automatically save ordinary edits to the active version
- Identify versioned passages of text with dotted underlines
- Highlight text version passages while cursor is inside of it
- Hover to live preview text versions, or open them with a command
- Commit a version to the Obsidian note by double-clicking the live preview
- Restore the committed version when previewing ends without commitment
- Cycle through live previews of all of the text versions using the arrow buttons
- Cancel creating new versions and revert back to previous text without needing to re-type it
- Receive confirmation notices when new versions are created or version creations are canceled 
- Customize color of saved version notice box, version creation cancelled box, dotted underline color, and text highlighting from the plugin settings
- Preserve version records when notes are renamed

## Install manually

1. Back up your vault and test the plugin in a separate vault first.
2. Extract the archive. You should have a folder named `text-versioning`.
3. Copy it to `<your-vault>/.obsidian/plugins/text-versioning`.
4. Confirm that `main.js`, `manifest.json`, and `styles.css` are directly inside that folder.
5. Restart Obsidian and enable **Text Versioning** under **Settings → Community plugins**.
6. Assign shortcuts under **Settings → Hotkeys** to:
   - **Create version from selection or current passage**
   - **Save new version draft**
   - **Cancel new version draft**
   - **Show versions for current passage**

The status bar displays `TV 1.0.0` when this build is loaded.

## Use

1. Select a passage and run **Create version from selection or current passage**.
2. Type the replacement directly in the note.
3. Run **Save new version draft**. Press **Escape** instead to cancel an active draft.
4. Hover over the underlined passage, or place the cursor inside it and run **Show versions for current passage**.
5. Use the arrow buttons or arrow keys to preview versions in the note.
6. Double-click the preview text to commit the displayed version. Moving away or pressing Escape restores the committed version.
7. To add another version, place the cursor inside the existing passage and run the create command again.

NOTE: When a version is saved or committed at the end of a note, the plugin adds one trailing newline outside the version. This is to avoid being unable to type outside of a version in the event that a new text version is created at the end of a document. Click that final blank line to continue writing ordinary note text.

## Build from source

Requires Node.js and npm.

```bash
npm install
npm run build
```

For development with automatic rebuilding:

```bash
npm run dev
```

The entry point is `src/main.ts`. The production build creates `main.js` at the plugin root.

## Data and safety

Version records are normally stored at:

```text
.obsidian/plugins/text-versioning/data.json
```

The active version is also present in the note itself. Inactive versions exist only in `data.json`, so include that file in your backups.

This plugin uses separate runtime ranges for each editor view and validates ranges before document writes. If a passage cannot be located reliably, the plugin preserves its stored data rather than guessing.

## Appearance settings

Open **Settings → Text Versioning → Appearance** to choose colors for the version underline, successful-save alert, and cancellation alert. Changes apply immediately and are stored in `data.json`. Use the reset button beside a color picker to return to the theme default.
