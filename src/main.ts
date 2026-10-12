import { MarkdownView, Notice, Plugin, TFile } from 'obsidian'
import { resolvePairedMarkdown, upsertFrontmatterPdf } from './pairing'
import { PdfSuggestModal } from './pdf-suggest-modal'
import { CollationSettingTab } from './settings'
import { type CollationSettings, DEFAULT_SETTINGS } from './types'
import { CollationView, VIEW_TYPE_COLLATION } from './view'

export default class PdfCollationPlugin extends Plugin {
  settings: CollationSettings = { ...DEFAULT_SETTINGS }

  async onload(): Promise<void> {
    await this.loadSettings()

    this.registerView(VIEW_TYPE_COLLATION, (leaf) => new CollationView(leaf, this))

    this.addRibbonIcon('columns', '打开 PDF 双轨校勘视图', () => {
      void this.openCollationForActiveFile()
    })

    this.addCommand({
      id: 'open-collation',
      name: '打开当前笔记的双轨校勘视图',
      callback: () => {
        void this.openCollationForActiveFile()
      },
    })

    this.addCommand({
      id: 'bind-pdf-to-note',
      name: '为当前笔记绑定配对 PDF 原件 (Bind PDF to Note)',
      callback: () => {
        const activeCollation = this.app.workspace.getActiveViewOfType(CollationView)
        if (activeCollation && activeCollation.getMarkdownFile()) {
          activeCollation.promptBindPdf()
          return
        }

        const file = this.app.workspace.getActiveFile()
        if (!file || file.extension.toLowerCase() !== 'md') {
          new Notice('请先打开一篇 Markdown 笔记')
          return
        }
        new PdfSuggestModal(this.app, async (chosenPdf) => {
          const key = this.settings.frontmatterKeys[0] || 'pdf'
          let updatedRaw = ''
          await this.app.vault.process(file, (raw) => {
            updatedRaw = upsertFrontmatterPdf(raw, chosenPdf.path, key)
            return updatedRaw
          })
          new Notice(`已绑定 ${chosenPdf.name} 到 ${file.name}`)
          for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_COLLATION)) {
            if (leaf.view instanceof CollationView) {
              const viewMd = leaf.view.getMarkdownFile()
              if (!viewMd || viewMd.path === file.path) {
                await leaf.view.loadMarkdownFile(file, true, chosenPdf, updatedRaw)
              }
            }
          }
        }).open()
      },
    })

    this.addCommand({
      id: 'insert-sop-pagemark',
      name: '插入双页标 [p. X / pdf. Y]',
      editorCallback: (editor) => {
        const cursor = editor.getCursor()
        const snippet = '[p. 1 / pdf. 1]'
        editor.replaceSelection(snippet)
        editor.setCursor({ line: cursor.line, ch: cursor.ch + 4 })
      },
    })

    this.addCommand({
      id: 'auto-paginate-from-pdf',
      name: '根据配对 PDF 自动插入页标 (Auto-paginate Markdown from PDF)',
      callback: () => {
        const activeCollation = this.app.workspace.getActiveViewOfType(CollationView)
        if (activeCollation) {
          void activeCollation.autoPaginateFromPdf()
          return
        }
        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COLLATION)
        if (leaves.length > 0 && leaves[0].view instanceof CollationView) {
          void this.app.workspace.revealLeaf(leaves[0])
          void leaves[0].view.autoPaginateFromPdf()
          return
        }
        new Notice('请先在双轨校勘视图中打开一篇配对好 PDF 的笔记')
      },
    })

    // 文件树右键菜单与编辑器右上角菜单直接打开双轨校勘
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile)) return
        const ext = file.extension.toLowerCase()
        if (ext === 'md') {
          menu.addItem((item) => {
            item
              .setTitle('在双轨校勘视图中打开')
              .setIcon('columns')
              .onClick(() => {
                void this.openCollationForFile(file)
              })
          })
        } else if (ext === 'pdf') {
          const pairedMd = resolvePairedMarkdown(this.app, file, this.settings)
          menu.addItem((item) => {
            item
              .setTitle(
                pairedMd
                  ? `在双轨校勘视图中打开 (${pairedMd.basename})`
                  : '在双轨校勘视图中打开 (从 PDF 生成校勘底稿)'
              )
              .setIcon('columns')
              .onClick(() => {
                void this.openCollationForFile(pairedMd ?? file)
              })
          })
        }
      })
    )

    this.addSettingTab(new CollationSettingTab(this.app, this))
  }

  onunload(): void {
    // Obsidian 自动管理已注册视图的卸载
  }

  async openCollationForActiveFile(): Promise<void> {
    const activeCollation = this.app.workspace.getActiveViewOfType(CollationView)
    const mdView = this.app.workspace.getActiveViewOfType(MarkdownView)
    const activeFile = mdView?.file ?? this.app.workspace.getActiveFile()

    if (activeCollation) {
      if (activeFile) {
        const ext = activeFile.extension.toLowerCase()
        if (ext === 'md' && activeCollation.getMarkdownFile()?.path !== activeFile.path) {
          await activeCollation.loadMarkdownFile(activeFile, true)
        } else if (ext === 'pdf') {
          const pairedMd = resolvePairedMarkdown(this.app, activeFile, this.settings)
          if (pairedMd) {
            if (activeCollation.getMarkdownFile()?.path !== pairedMd.path) {
              await activeCollation.loadMarkdownFile(pairedMd, true)
            }
          } else {
            await activeCollation.loadPdfFileOrGenerateMarkdown(activeFile)
          }
        }
      }
      return
    }

    if (!activeFile) {
      new Notice('请先选中或打开一篇 Markdown 笔记或 PDF 文献')
      return
    }

    const ext = activeFile.extension.toLowerCase()
    if (ext === 'md') {
      await this.openCollationForFile(activeFile)
      return
    }

    if (ext === 'pdf') {
      const pairedMd = resolvePairedMarkdown(this.app, activeFile, this.settings)
      await this.openCollationForFile(pairedMd ?? activeFile)
      return
    }

    new Notice('请先选中或打开一篇 Markdown 笔记或 PDF 文献')
  }

  async openCollationForFile(file: TFile): Promise<void> {
    const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_COLLATION)
    if (existingLeaves.length > 0) {
      const leaf = existingLeaves[0]
      await leaf.setViewState({
        type: VIEW_TYPE_COLLATION,
        active: true,
        state: { file: file.path },
      })
      if (leaf.view instanceof CollationView) {
        if (file.extension.toLowerCase() === 'pdf') {
          await leaf.view.loadPdfFileOrGenerateMarkdown(file)
        } else {
          await leaf.view.loadMarkdownFile(file, true)
        }
      }
      await this.app.workspace.revealLeaf(leaf)
      return
    }

    const leaf = this.app.workspace.getLeaf('tab')
    await leaf.setViewState({
      type: VIEW_TYPE_COLLATION,
      active: true,
      state: { file: file.path },
    })
    await this.app.workspace.revealLeaf(leaf)
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<CollationSettings> | null
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
