import { PatchDiff } from '@pierre/diffs/react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import type { CSSProperties } from 'react'
import { useMemo, useState } from 'react'

const fileFromDiffHeader = (line: string) => {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
  if (!match) return null
  return match[2] === '/dev/null' ? match[1] : match[2]
}

const filesFromPatch = (patch: string) =>
  patch
    .split('\n')
    .map(fileFromDiffHeader)
    .filter((file): file is string => file !== null)

const patchForFile = (patch: string, file: string | null) => {
  if (file === null) return patch
  const lines = patch.split('\n')
  const start = lines.findIndex((line) => fileFromDiffHeader(line) === file)
  if (start === -1) return patch
  const next = lines.findIndex((line, index) => index > start && line.startsWith('diff --git '))
  return lines.slice(start, next === -1 ? undefined : next).join('\n')
}

const treeStyleFallback = {
  height: '100%',
  colorScheme: 'dark',
  backgroundColor: '#141418',
  color: '#d6d6d3',
  '--trees-bg-override': '#141418',
  '--trees-bg-muted-override': '#202027',
  '--trees-border-color-override': '#26262c',
  '--trees-fg-override': '#d6d6d3',
  '--trees-fg-muted-override': '#82828a',
  '--trees-selected-bg-override': '#2a2a33',
  '--trees-selected-fg-override': '#f5f5f2',
  '--trees-selected-focused-border-color-override': '#c98429',
  '--trees-focus-ring-color-override': '#c98429',
  '--trees-font-family-override': 'ui-monospace, SFMono-Regular, Menlo, monospace',
  '--trees-font-size-override': '12px',
} as CSSProperties

export function DiffViewer({ patch }: { patch: string }) {
  const files = useMemo(() => filesFromPatch(patch), [patch])
  const [selected, setSelected] = useState<string | null>(files[0] ?? null)
  const selectedPatch = useMemo(() => patchForFile(patch, selected), [patch, selected])
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    initialExpansion: 'open',
    initialSelectedPaths: selected === null ? [] : [selected],
    onSelectionChange: (paths) => setSelected(paths[0] ?? null),
    paths: files,
    search: true,
  })

  if (files.length === 0) {
    return <div className="empty-diff">clean working tree</div>
  }

  return (
    <div className="diff-viewer">
      <aside className="diff-tree">
        <div className="diff-tree-head">{files.length} changed</div>
        <FileTree model={model} style={treeStyleFallback} />
      </aside>
      <section className="diff-code">
        <PatchDiff
          patch={selectedPatch}
          options={{
            diffIndicators: 'classic',
            diffStyle: 'unified',
            hunkSeparators: 'line-info-basic',
            overflow: 'wrap',
            stickyHeader: true,
            theme: 'github-dark',
          }}
        />
      </section>
    </div>
  )
}
